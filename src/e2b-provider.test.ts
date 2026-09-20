import { CommandExitError, NotFoundError } from "e2b";
import { describe, expect, test } from "vitest";
import { createE2bProvider, type E2bSandboxStatic } from "./e2b-provider.js";

const connection = { apiKey: "k", apiUrl: "https://api.example", domain: "example" };

function exitError(exitCode: number) {
  return new CommandExitError({ exitCode, stdout: "", stderr: "", error: "" } as never);
}

/** Minimal stand-in for the SDK's `Sandbox` class: records calls, scripted results. */
function fakeSdk(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const instance = {
    sandboxId: "sbx-1",
    commands: {
      async run(command: string, options: Record<string, unknown>) {
        calls.push(["run", command, options]);
        return {
          pid: 9,
          wait: overrides.wait ?? (async () => ({ exitCode: 0 })),
          kill: async () => {
            calls.push(["kill-command"]);
            return true;
          },
        };
      },
    },
    files: {
      read:
        overrides.read ?? (async () => new ReadableStream<Uint8Array>({ start: (c) => c.close() })),
      async write(path: string, data: unknown, options: unknown) {
        calls.push(["write", path, data, options]);
      },
    },
    async setTimeout(ms: number) {
      calls.push(["setTimeout", ms]);
    },
    async pause() {
      calls.push(["pause"]);
      return true;
    },
    async kill() {
      calls.push(["kill"]);
      return true;
    },
  };
  const sdk = {
    async create(template: string, options: unknown) {
      calls.push(["create", template, options]);
      return instance;
    },
    connect:
      overrides.connect ??
      (async (id: string, options: unknown) => {
        calls.push(["connect", id, options]);
        return instance;
      }),
    list(options: unknown) {
      calls.push(["list", options]);
      let served = false;
      return {
        get hasNext() {
          return !served;
        },
        async nextItems() {
          served = true;
          return [{ sandboxId: "sbx-1" }, { sandboxId: "sbx-2" }];
        },
      };
    },
  } as unknown as E2bSandboxStatic;
  return { sdk, calls };
}

describe("createE2bProvider", () => {
  test("create forwards the template, connection, and create options", async () => {
    const { sdk, calls } = fakeSdk();
    const provider = createE2bProvider({ connection, sdk });

    const sandbox = await provider.create({
      template: "tpl",
      timeoutMs: 5000,
      envs: { A: "1" },
      metadata: { k: "v" },
      network: { allowOut: ["a.example.com"], denyOut: ["0.0.0.0/0"], rules: {} },
    });

    expect(sandbox.id).toBe("sbx-1");
    expect(calls[0]).toEqual([
      "create",
      "tpl",
      {
        ...connection,
        timeoutMs: 5000,
        envs: { A: "1" },
        metadata: { k: "v" },
        network: { allowOut: ["a.example.com"], denyOut: ["0.0.0.0/0"], rules: {} },
      },
    ]);
  });

  test("startCommand runs in the background with the provider's command timeout disabled", async () => {
    const { sdk, calls } = fakeSdk();
    const sandbox = await createE2bProvider({ connection, sdk }).create({
      template: "t",
      timeoutMs: 1,
    });

    await sandbox.startCommand(
      { command: "sleep 900", cwd: "/workspace", envs: { A: "1" }, user: "root" },
      { onStdout() {}, onStderr() {} },
    );

    const [, command, options] = calls.find(([name]) => name === "run") ?? [];
    expect(command).toBe("sleep 900");
    expect(options).toMatchObject({
      background: true,
      timeoutMs: 0,
      cwd: "/workspace",
      envs: { A: "1" },
      user: "root",
    });
  });

  test("a nonzero exit resolves with its exit code instead of throwing", async () => {
    const { sdk } = fakeSdk({
      wait: async () => {
        throw exitError(7);
      },
    });
    const sandbox = await createE2bProvider({ connection, sdk }).create({
      template: "t",
      timeoutMs: 1,
    });

    const command = await sandbox.startCommand({ command: "x" }, { onStdout() {}, onStderr() {} });

    expect(await command.wait()).toEqual({ exitCode: 7 });
  });

  test("a killed command (provider exit code -1) reports 137", async () => {
    const { sdk } = fakeSdk({
      wait: async () => {
        throw exitError(-1);
      },
    });
    const sandbox = await createE2bProvider({ connection, sdk }).create({
      template: "t",
      timeoutMs: 1,
    });

    const command = await sandbox.startCommand({ command: "x" }, { onStdout() {}, onStderr() {} });

    expect(await command.wait()).toEqual({ exitCode: 137 });
  });

  test("a transport failure while waiting still rejects", async () => {
    const { sdk } = fakeSdk({
      wait: async () => {
        throw new Error("socket hang up");
      },
    });
    const sandbox = await createE2bProvider({ connection, sdk }).create({
      template: "t",
      timeoutMs: 1,
    });

    const command = await sandbox.startCommand({ command: "x" }, { onStdout() {}, onStderr() {} });

    await expect(command.wait()).rejects.toThrow("socket hang up");
  });

  test("readFile returns null when the file does not exist", async () => {
    const { sdk } = fakeSdk({
      read: async () => {
        throw new NotFoundError("file not found");
      },
    });
    const sandbox = await createE2bProvider({ connection, sdk }).create({
      template: "t",
      timeoutMs: 1,
    });

    expect(await sandbox.readFile("/workspace/missing")).toBeNull();
  });

  test("writeFile hands the SDK an ArrayBuffer of exactly the given bytes", async () => {
    const { sdk, calls } = fakeSdk();
    const sandbox = await createE2bProvider({ connection, sdk }).create({
      template: "t",
      timeoutMs: 1,
    });
    const backing = new Uint8Array([9, 1, 2, 3, 9]);

    await sandbox.writeFile("/workspace/f", backing.subarray(1, 4), "root");

    const [, path, data, options] = calls.find(([name]) => name === "write") ?? [];
    expect(path).toBe("/workspace/f");
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(data as ArrayBuffer))).toEqual([1, 2, 3]);
    expect(options).toMatchObject({ user: "root" });
  });

  test("connect returns null for a sandbox that no longer exists", async () => {
    const { sdk } = fakeSdk({
      connect: async () => {
        throw new NotFoundError("Paused sandbox sbx-x not found");
      },
    });

    expect(await createE2bProvider({ connection, sdk }).connect("sbx-x")).toBeNull();
  });

  test("findByMetadata queries running and paused sandboxes and returns their ids", async () => {
    const { sdk, calls } = fakeSdk();

    const ids = await createE2bProvider({ connection, sdk }).findByMetadata({ eveSession: "h" });

    expect(ids).toEqual(["sbx-1", "sbx-2"]);
    expect(calls[0]).toEqual(["list", { ...connection, query: { metadata: { eveSession: "h" } } }]);
  });
});
