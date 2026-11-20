import { describe, expect, test } from "vitest";
import { type CreateAliyunConnectionInput, createAliyunConnection } from "./session.js";
import { streamToBytes } from "./streams.js";
import { FakeProvider, type FakeShell } from "./testing/fake-provider.js";

async function open(
  shell: FakeShell = () => ({}),
  overrides: Partial<CreateAliyunConnectionInput> = {},
) {
  const provider = new FakeProvider(shell);
  const sandbox = await provider.create({ template: "t", timeoutMs: 1000 });
  let now = 0;
  const released: string[] = [];
  const policies: unknown[] = [];
  const connection = createAliyunConnection({
    sandbox,
    env: () => ({ BASE: "1", SHARED: "base" }),
    timeoutMs: 600_000,
    now: () => now,
    setNetworkPolicy: async (policy) => void policies.push(policy),
    release: async () => void released.push(sandbox.id),
    ...overrides,
  });
  return {
    provider,
    sandbox,
    connection,
    released,
    policies,
    advance: (ms: number) => (now += ms),
  };
}

const spawnIn = (command: string, env: Record<string, string> = {}) => ({
  command,
  env,
  workingDirectory: "/workspace/sub",
});

describe("createAliyunConnection", () => {
  test("spawn runs the command verbatim in the given directory with merged env", async () => {
    const { sandbox, connection } = await open();

    const proc = await connection.spawn(spawnIn("echo $SHARED", { SHARED: "call" }));
    await proc.wait();

    expect(sandbox.commands).toEqual([
      { command: "echo $SHARED", cwd: "/workspace/sub", envs: { BASE: "1", SHARED: "call" } },
    ]);
  });

  test("spawn surfaces output and the exit code", async () => {
    const { connection } = await open(() => ({ stdout: "out", stderr: "err", exitCode: 3 }));

    const proc = await connection.spawn(spawnIn("x"));

    expect(new TextDecoder().decode(await streamToBytes(proc.stdout))).toBe("out");
    expect(new TextDecoder().decode(await streamToBytes(proc.stderr))).toBe("err");
    expect((await proc.wait()).exitCode).toBe(3);
  });

  test("spawn refuses stdin, which the SDK cannot provide", async () => {
    const { sandbox, connection } = await open();

    await expect(connection.spawn({ ...spawnIn("cat"), stdin: true })).rejects.toThrow(/stdin/);
    expect(sandbox.commands).toEqual([]);
  });

  test("an already aborted signal starts nothing", async () => {
    const { sandbox, connection } = await open();
    const abort = new AbortController();
    abort.abort();

    await expect(connection.spawn({ ...spawnIn("x"), signal: abort.signal })).rejects.toThrow();
    expect(sandbox.commands).toEqual([]);
  });

  test("readFile returns the file, or null when it is missing", async () => {
    const { sandbox, connection } = await open();
    sandbox.files.set("/workspace/a.txt", new TextEncoder().encode("hi"));

    const stream = await connection.readFile({ path: "/workspace/a.txt" });
    expect(stream).not.toBeNull();
    expect(
      new TextDecoder().decode(await streamToBytes(stream as ReadableStream<Uint8Array>)),
    ).toBe("hi");
    expect(await connection.readFile({ path: "/workspace/missing" })).toBeNull();
  });

  test("writeFiles writes every file", async () => {
    const { sandbox, connection } = await open();

    await connection.writeFiles({
      files: [
        { path: "/workspace/a.txt", content: new TextEncoder().encode("a") },
        { path: "/home/user/b.bin", content: new Uint8Array([0, 255]) },
      ],
    });

    expect(sandbox.text("/workspace/a.txt")).toBe("a");
    expect(sandbox.files.get("/home/user/b.bin")).toEqual(new Uint8Array([0, 255]));
  });

  test("removePath removes with rm, shell-quoting the path", async () => {
    const { sandbox, connection } = await open();

    await connection.removePath({ path: "/workspace/it's here", force: true, recursive: true });

    expect(sandbox.commands[0]?.command).toBe(`rm -f -r -- '/workspace/it'\\''s here'`);
  });

  test("removePath without force or recursive passes neither flag", async () => {
    const { sandbox, connection } = await open();

    await connection.removePath({ path: "/workspace/a" });

    expect(sandbox.commands[0]?.command).toBe(`rm -- '/workspace/a'`);
  });

  test("removePath rejects with rm's message when removal fails", async () => {
    const { connection } = await open(() => ({
      stderr: "rm: cannot remove 'a': No such file or directory\n",
      exitCode: 1,
    }));

    await expect(connection.removePath({ path: "/workspace/a" })).rejects.toThrow(
      /failed to remove \/workspace\/a: rm: cannot remove/,
    );
  });

  test("stop kills every live process, releases once, and closes the connection", async () => {
    const { sandbox, connection, released } = await open(() => ({ hang: true }));
    const proc = await connection.spawn(spawnIn("sleep 600"));

    await connection.stop();
    await connection.stop();

    expect((await proc.wait()).exitCode).toBe(137);
    expect(sandbox.liveCommands).toBe(0);
    expect(released).toEqual([sandbox.id]);
    await expect(connection.spawn(spawnIn("echo late"))).rejects.toThrow(/stopped/);
  });

  test("stop waits for a spawn still starting, and kills it before releasing", async () => {
    let started!: () => void;
    let proceed!: () => void;
    const starting = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (proceed = resolve));
    const liveAtRelease: number[] = [];
    const { sandbox, connection } = await open(
      async () => {
        started();
        await gate;
        return { hang: true };
      },
      { release: async () => void liveAtRelease.push(sandbox.liveCommands) },
    );

    const spawning = connection.spawn(spawnIn("serve"));
    await starting;
    const stopping = connection.stop();
    proceed();
    const proc = await spawning;
    await stopping;

    expect(liveAtRelease).toEqual([0]);
    expect(await proc.wait()).toEqual({ exitCode: 137 });
  });

  test("a failed release can be retried", async () => {
    let attempts = 0;
    const { connection } = await open(undefined, {
      release: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("capture failed");
      },
    });

    await expect(connection.stop()).rejects.toThrow(/capture failed/);
    await connection.stop();

    expect(attempts).toBe(2);
  });

  test("setNetworkPolicy is an extension eve merges onto the session", async () => {
    const { connection, policies } = await open();

    await connection.extensions?.setNetworkPolicy("deny-all");

    expect(policies).toEqual(["deny-all"]);
  });

  test("activity extends the sandbox timeout, at most once per keep-alive interval", async () => {
    const { sandbox, connection, advance } = await open();

    await (await connection.spawn(spawnIn("a"))).wait();
    await connection.readFile({ path: "/workspace/x" });
    advance(60_000);
    await connection.writeFiles({ files: [] });

    expect(sandbox.timeouts).toEqual([600_000, 600_000]);
  });

  test("a failing keep-alive never fails the operation", async () => {
    const { sandbox, connection } = await open();
    sandbox.setTimeout = async () => {
      throw new Error("provider down");
    };

    await expect((await connection.spawn(spawnIn("a"))).wait()).resolves.toEqual({ exitCode: 0 });
  });
});
