import { describe, expect, test } from "vitest";
import { createAliyunSession } from "./session.js";
import { streamToBytes, bytesToStream } from "./public-session.js";
import { FakeProvider, type FakeShell } from "./testing/fake-provider.js";

async function open(shell: FakeShell = () => ({}), overrides = {}) {
  const provider = new FakeProvider(shell);
  const sandbox = await provider.create({ template: "t", timeoutMs: 1000 });
  let now = 0;
  const session = createAliyunSession({
    sandbox,
    env: () => ({ BASE: "1", SHARED: "base" }),
    timeoutMs: 600_000,
    now: () => now,
    ...overrides,
  });
  return { provider, sandbox, session, advance: (ms: number) => (now += ms) };
}

describe("createAliyunSession", () => {
  test("spawn runs the command verbatim in /workspace with merged env", async () => {
    const { sandbox, session } = await open();

    const proc = await session.spawn({ command: "echo $SHARED", env: { SHARED: "call" } });
    await proc.wait();

    expect(sandbox.commands).toEqual([
      { command: "echo $SHARED", cwd: "/workspace", envs: { BASE: "1", SHARED: "call" } },
    ]);
  });

  test("spawn anchors a relative working directory to /workspace", async () => {
    const { sandbox, session } = await open();

    await (await session.spawn({ command: "pwd", workingDirectory: "repo" })).wait();

    expect(sandbox.commands[0]?.cwd).toBe("/workspace/repo");
  });

  test("spawn surfaces output and the exit code", async () => {
    const { session } = await open(() => ({ stdout: "hi", exitCode: 4 }));

    const proc = await session.spawn({ command: "x" });

    expect(new TextDecoder().decode(await streamToBytes(proc.stdout))).toBe("hi");
    expect(await proc.wait()).toEqual({ exitCode: 4 });
  });

  test("readFile returns null for a missing file", async () => {
    const { session } = await open();
    expect(await session.readFile({ path: "/workspace/missing" })).toBeNull();
  });

  test("writeFile drains the stream into the sandbox file", async () => {
    const { sandbox, session } = await open();

    await session.writeFile({
      path: "/workspace/a.txt",
      content: bytesToStream(new TextEncoder().encode("data")),
    });

    expect(sandbox.text("/workspace/a.txt")).toBe("data");
  });

  test("removePath removes with rm, shell-quoting the path", async () => {
    const { sandbox, session } = await open();

    await session.removePath({ path: "/workspace/it's here", force: true, recursive: true });

    expect(sandbox.commands[0]?.command).toBe(`rm -f -r -- '/workspace/it'\\''s here'`);
  });

  test("removePath without force or recursive passes neither flag", async () => {
    const { sandbox, session } = await open();

    await session.removePath({ path: "/workspace/f" });

    expect(sandbox.commands[0]?.command).toBe(`rm -- '/workspace/f'`);
  });

  test("removePath rejects with rm's message when removal fails", async () => {
    const { session } = await open(() => ({
      stderr: "rm: cannot remove '/workspace/f': No such file or directory\n",
      exitCode: 1,
    }));

    await expect(session.removePath({ path: "/workspace/f" })).rejects.toThrow(
      "No such file or directory",
    );
  });

  test("killAll kills every live process and closes the session to new commands", async () => {
    const { sandbox, session } = await open(() => ({ hang: true }));
    const first = await session.spawn({ command: "sleep 1" });
    await session.spawn({ command: "sleep 2" });

    await session.killAll();

    expect(sandbox.liveCommands).toBe(0);
    expect(await first.wait()).toEqual({ exitCode: 137 });
    await expect(session.spawn({ command: "echo late" })).rejects.toThrow("stopped");
  });

  test("activity extends the sandbox timeout, at most once per keep-alive interval", async () => {
    const { sandbox, session, advance } = await open(undefined, { keepAliveIntervalMs: 60_000 });

    await (await session.spawn({ command: "a" })).wait();
    await (await session.spawn({ command: "b" })).wait();
    expect(sandbox.timeouts).toEqual([600_000]);

    advance(60_001);
    await session.readFile({ path: "/workspace/x" });
    expect(sandbox.timeouts).toEqual([600_000, 600_000]);
  });

  test("a failing keep-alive never fails the operation", async () => {
    const { sandbox, session } = await open();
    sandbox.setTimeout = async () => {
      throw new Error("FC rejected session lifetime update");
    };

    await expect((await session.spawn({ command: "a" })).wait()).resolves.toEqual({ exitCode: 0 });
  });
});
