import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SandboxTemplateNotProvisionedError } from "eve/sandbox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ALIYUN_BACKEND_NAME, createAliyunSandboxBackend } from "./backend.js";
import { createFakeLinuxShell, FakeProvider } from "./testing/fake-provider.js";

let cacheDir: string;
const runtimeContext = { appRoot: "/srv/app" };

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), "eve-aliyun-"));
});
afterEach(async () => {
  await rm(cacheDir, { force: true, recursive: true });
});

function setup(shell = createFakeLinuxShell(), createOptions = {}) {
  const provider = new FakeProvider(shell);
  const backend = createAliyunSandboxBackend({
    provider,
    createOptions: { cacheDir, ...createOptions },
  });
  return { provider, backend };
}

describe("prewarm", () => {
  test("captures a template from seed files and bootstrap, then destroys the build sandbox", async () => {
    const { provider, backend } = setup();

    const result = await backend.prewarm({
      templateKey: "tpl-1",
      runtimeContext,
      seedFiles: [
        { path: "schema.sql", content: "create table t;" },
        { path: "$HOME/.agents/skills/pdf/SKILL.md", content: Buffer.from("skill") },
      ],
      async bootstrap({ use }) {
        const sandbox = await use();
        expect(await sandbox.readTextFile({ path: "schema.sql" })).toBe("create table t;");
        await sandbox.writeTextFile({ path: "built.txt", content: "bootstrapped" });
      },
    });

    expect(result).toEqual({ reused: false });
    expect(provider.created).toHaveLength(1);
    expect(provider.created[0]?.killed).toBe(true);
    expect(provider.created[0]?.text("/home/user/.agents/skills/pdf/SKILL.md")).toBe("skill");
    expect(await readdir(path.join(cacheDir, "templates"))).toHaveLength(1);
  });

  test("reuses an already captured template without creating a sandbox", async () => {
    const { provider, backend } = setup();
    await backend.prewarm({ templateKey: "tpl-1", runtimeContext, seedFiles: [] });

    const result = await backend.prewarm({ templateKey: "tpl-1", runtimeContext, seedFiles: [] });

    expect(result).toEqual({ reused: true });
    expect(provider.created).toHaveLength(1);
  });

  test("a failing bootstrap caches nothing and still destroys the build sandbox", async () => {
    const { provider, backend } = setup();

    await expect(
      backend.prewarm({
        templateKey: "tpl-1",
        runtimeContext,
        seedFiles: [],
        bootstrap() {
          throw new Error("apt exploded");
        },
      }),
    ).rejects.toThrow("apt exploded");

    expect(provider.created[0]?.killed).toBe(true);
    expect(existsSync(path.join(cacheDir, "templates"))).toBe(false);
  });

  test("fails with the provider's output when base setup cannot prepare /workspace", async () => {
    const shell = createFakeLinuxShell({
      onCommand: (command) =>
        command.user === "root" && command.command.includes("mkdir -p /workspace")
          ? { exitCode: 1, stderr: "mkdir: read-only file system\n" }
          : undefined,
    });
    const { provider, backend } = setup(shell);

    await expect(
      backend.prewarm({ templateKey: "tpl-1", runtimeContext, seedFiles: [] }),
    ).rejects.toThrow("read-only file system");
    expect(provider.created[0]?.killed).toBe(true);
  });

  test("builds the template on the configured base template with the configured lifetime", async () => {
    const { provider, backend } = setup(undefined, { template: "my-image", timeoutMs: 1234 });

    await backend.prewarm({ templateKey: "tpl-1", runtimeContext, seedFiles: [] });

    expect(provider.created[0]?.createOptions).toMatchObject({
      template: "my-image",
      timeoutMs: 1234,
    });
  });
});

describe("create", () => {
  test("opens a fresh session with /workspace prepared when there is no template", async () => {
    const { provider, backend } = setup();

    const handle = await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });

    expect(handle.session.id).toBe("s-1");
    expect(provider.created).toHaveLength(1);
    expect(
      provider.created[0]?.commands.some(
        (c) => c.user === "root" && c.command.includes("mkdir -p /workspace"),
      ),
    ).toBe(true);
  });

  test("throws SandboxTemplateNotProvisionedError when the template was never prewarmed", async () => {
    const { provider, backend } = setup();

    const attempt = backend.create({ templateKey: "missing", sessionKey: "s-1", runtimeContext });

    await expect(attempt).rejects.toSatisfy(SandboxTemplateNotProvisionedError.is);
    expect(provider.created).toHaveLength(0);
  });

  test("a session created from a template sees the template's files", async () => {
    const { backend } = setup();
    await backend.prewarm({
      templateKey: "tpl-1",
      runtimeContext,
      seedFiles: [{ path: "seed.txt", content: "from template" }],
    });

    const handle = await backend.create({
      templateKey: "tpl-1",
      sessionKey: "s-1",
      runtimeContext,
    });

    expect(await handle.session.readTextFile({ path: "seed.txt" })).toBe("from template");
  });

  test("labels the sandbox with eve's tags and the session key", async () => {
    const { provider, backend } = setup();

    await backend.create({
      templateKey: null,
      sessionKey: "s-1",
      runtimeContext,
      tags: { agent: "support", sessionId: "abc" },
    });

    expect(provider.created[0]?.createOptions.metadata).toMatchObject({
      agent: "support",
      sessionId: "abc",
      eveSessionKey: "s-1",
    });
  });

  test("captureState records the sandbox id under this backend's name", async () => {
    const { provider, backend } = setup();
    const handle = await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });

    expect(await handle.captureState()).toEqual({
      backendName: ALIYUN_BACKEND_NAME,
      metadata: { sandboxId: provider.created[0]?.id },
      sessionKey: "s-1",
    });
  });

  test("reattaches to the persisted sandbox instead of creating a new one", async () => {
    const { provider, backend } = setup();
    const first = await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });
    await first.session.writeTextFile({ path: "kept.txt", content: "still here" });
    const state = await first.captureState();

    const second = await backend.create({
      templateKey: null,
      sessionKey: "s-1",
      runtimeContext,
      existingMetadata: state.metadata,
    });

    expect(provider.created).toHaveLength(1);
    expect(await second.session.readTextFile({ path: "kept.txt" })).toBe("still here");
  });

  test("finds the live sandbox by session key when no reconnect metadata survived", async () => {
    const { provider, backend } = setup();
    await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });

    await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });

    expect(provider.created).toHaveLength(1);
  });

  test("replaces a sandbox the provider has destroyed with a fresh one from the template", async () => {
    const { provider, backend } = setup();
    await backend.prewarm({
      templateKey: "tpl-1",
      runtimeContext,
      seedFiles: [{ path: "seed.txt", content: "from template" }],
    });
    const first = await backend.create({ templateKey: "tpl-1", sessionKey: "s-1", runtimeContext });
    const state = await first.captureState();
    await provider.sandboxes.get(state.metadata.sandboxId as string)?.kill();

    const second = await backend.create({
      templateKey: "tpl-1",
      sessionKey: "s-1",
      runtimeContext,
      existingMetadata: state.metadata,
    });

    expect((await second.captureState()).metadata.sandboxId).not.toBe(state.metadata.sandboxId);
    expect(await second.session.readTextFile({ path: "seed.txt" })).toBe("from template");
  });
});

describe("handle lifecycle", () => {
  test("stop pauses the sandbox where the account supports it, and the session resumes intact", async () => {
    const { provider, backend } = setup();
    provider.pauseSupported = true;
    const first = await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });
    await first.session.writeTextFile({ path: "work.txt", content: "in progress" });

    await first.stop();

    const sandbox = provider.created[0];
    expect(sandbox?.paused).toBe(true);
    expect(sandbox?.killed).toBe(false);
    const second = await backend.create({
      templateKey: null,
      sessionKey: "s-1",
      runtimeContext,
      existingMetadata: (await first.captureState()).metadata,
    });
    expect(provider.created).toHaveLength(1);
    expect(await second.session.readTextFile({ path: "work.txt" })).toBe("in progress");
  });

  test("stop without pause support checkpoints the session and releases the compute", async () => {
    const { provider, backend } = setup();
    const first = await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });
    await first.session.writeTextFile({ path: "work.txt", content: "in progress" });

    await first.stop();

    expect(provider.created[0]?.killed).toBe(true);
    expect(provider.sandboxes.size).toBe(0);
    const second = await backend.create({
      templateKey: null,
      sessionKey: "s-1",
      runtimeContext,
      existingMetadata: (await first.captureState()).metadata,
    });
    expect(provider.created).toHaveLength(2);
    expect(await second.session.readTextFile({ path: "work.txt" })).toBe("in progress");
  });

  test("stop kills running processes before releasing the sandbox", async () => {
    const shell = createFakeLinuxShell({
      onCommand: (command) => (command.command === "serve" ? { hang: true } : undefined),
    });
    const { backend } = setup(shell);
    const handle = await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });
    const server = await handle.session.spawn({ command: "serve" });

    await handle.stop();

    expect(await server.wait()).toEqual({ exitCode: 137 });
  });

  test("stop rejects when the checkpoint cannot be captured, leaving the sandbox alive", async () => {
    let failCapture = false;
    const shell = createFakeLinuxShell({
      onCommand: (command) =>
        failCapture && command.command.includes("-czpf")
          ? { exitCode: 2, stderr: "tar: disk full\n" }
          : undefined,
    });
    const { provider, backend } = setup(shell);
    const handle = await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });
    failCapture = true;

    await expect(handle.stop()).rejects.toThrow("disk full");
    expect(provider.created[0]?.killed).toBe(false);
  });

  test("shutdown never throws, even when the provider fails", async () => {
    const { provider, backend } = setup();
    const handle = await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });
    const sandbox = provider.created[0];
    if (sandbox) sandbox.startCommand = async () => Promise.reject(new Error("provider down"));

    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  test("delete destroys the sandbox and its checkpoint, so the next session starts from the template", async () => {
    const { provider, backend } = setup();
    await backend.prewarm({
      templateKey: "tpl-1",
      runtimeContext,
      seedFiles: [{ path: "seed.txt", content: "from template" }],
    });
    const first = await backend.create({ templateKey: "tpl-1", sessionKey: "s-1", runtimeContext });
    await first.session.writeTextFile({ path: "work.txt", content: "in progress" });
    await first.stop();
    const resumed = await backend.create({
      templateKey: "tpl-1",
      sessionKey: "s-1",
      runtimeContext,
    });

    await resumed.delete();

    expect(provider.sandboxes.size).toBe(0);
    expect(await readdir(path.join(cacheDir, "sessions"))).toEqual([]);
    const fresh = await backend.create({ templateKey: "tpl-1", sessionKey: "s-1", runtimeContext });
    expect(await fresh.session.readTextFile({ path: "work.txt" })).toBeNull();
    expect(await fresh.session.readTextFile({ path: "seed.txt" })).toBe("from template");
  });

  test("delete honours an already aborted signal", async () => {
    const { provider, backend } = setup();
    const handle = await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));

    await expect(handle.delete({ abortSignal: abort.signal })).rejects.toThrow("cancelled");
    expect(provider.created[0]?.killed).toBe(false);
  });
});

describe("network policy", () => {
  const ALL_TRAFFIC = "0.0.0.0/0";

  test("sandboxes are created with the factory's policy already in force", async () => {
    const { provider, backend } = setup(undefined, { networkPolicy: "deny-all" });

    await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });

    expect(provider.created[0]?.createOptions.network).toEqual({
      allowOut: [],
      denyOut: [ALL_TRAFFIC],
      rules: {},
    });
  });

  test("allow-all is the default", async () => {
    const { provider, backend } = setup();

    await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });

    expect(provider.created[0]?.createOptions.network).toEqual({
      allowOut: [],
      denyOut: [],
      rules: {},
    });
  });

  test("the factory's policy governs bootstrap too", async () => {
    const { provider, backend } = setup(undefined, {
      networkPolicy: { allow: ["deb.debian.org"] },
    });

    await backend.prewarm({ templateKey: "tpl-1", runtimeContext, seedFiles: [] });

    expect(provider.created[0]?.createOptions.network?.allowOut).toEqual(["deb.debian.org"]);
  });

  test("setNetworkPolicy changes egress on the live sandbox", async () => {
    const { provider, backend } = setup();
    const handle = await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });

    await handle.session.setNetworkPolicy({
      allow: {
        "github.com": [{ transform: [{ headers: { authorization: "Basic abc" } }] }],
      },
    });

    expect(provider.created[0]?.network).toEqual({
      allowOut: ["github.com"],
      denyOut: [ALL_TRAFFIC],
      rules: { "github.com": [{ transform: { headers: { authorization: "Basic abc" } } }] },
    });
  });

  test("setNetworkPolicy rejects a policy the provider cannot express, leaving egress unchanged", async () => {
    const { provider, backend } = setup();
    const handle = await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });

    await expect(
      handle.session.setNetworkPolicy({
        allow: { "a.example.com": [{ forwardURL: "https://proxy.example.com" }] },
      }),
    ).rejects.toThrow(/forwardURL/);
    expect(provider.created[0]?.network.denyOut).toEqual([]);
  });

  test("onSession's use() applies a per-session policy and returns the session", async () => {
    const { provider, backend } = setup();
    const handle = await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });

    const session = await handle.useSessionFn({ networkPolicy: "deny-all" });

    expect(session).toBe(handle.session);
    expect(provider.created[0]?.network.denyOut).toEqual([ALL_TRAFFIC]);
    await expect(handle.useSessionFn()).resolves.toBe(handle.session);
  });

  test("bootstrap's use() can tighten the policy for the rest of the template build", async () => {
    const { provider, backend } = setup();

    await backend.prewarm({
      templateKey: "tpl-1",
      runtimeContext,
      seedFiles: [],
      async bootstrap({ use }) {
        await use({ networkPolicy: "deny-all" });
      },
    });

    expect(provider.created[0]?.network.denyOut).toEqual([ALL_TRAFFIC]);
  });
});

describe("session environment", () => {
  function lastEnvs(provider: FakeProvider) {
    return provider.created.at(-1)?.commands.at(-1)?.envs;
  }

  test("use({ env }) adds variables to every later command; per-call env still wins", async () => {
    const { provider, backend } = setup(undefined, { env: { BASE: "factory", TOKEN: "factory" } });
    const handle = await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });

    const session = await handle.useSessionFn({ env: { TOKEN: "session" } });
    await session.run({ command: "true" });
    expect(lastEnvs(provider)).toEqual({ BASE: "factory", TOKEN: "session" });

    await session.run({ command: "true", env: { TOKEN: "call" } });
    expect(lastEnvs(provider)).toEqual({ BASE: "factory", TOKEN: "call" });
  });

  test("the session environment survives into the next turn's handle", async () => {
    // eve opens a new handle every turn but runs onSession only once.
    const { provider, backend } = setup();
    const first = await backend.create({ templateKey: null, sessionKey: "s-1", runtimeContext });
    await first.useSessionFn({ env: { TOKEN: "session" } });
    const state = await first.captureState();
    expect(state.metadata).toEqual({
      sandboxId: provider.created[0]?.id,
      env: { TOKEN: "session" },
    });

    const second = await backend.create({
      templateKey: null,
      sessionKey: "s-1",
      runtimeContext,
      existingMetadata: state.metadata,
    });
    await second.session.run({ command: "true" });

    expect(lastEnvs(provider)).toEqual({ TOKEN: "session" });
    expect((await second.captureState()).metadata).toEqual(state.metadata);
  });

  test("ignores persisted environment that is not a string map", async () => {
    const { provider, backend } = setup();
    const handle = await backend.create({
      templateKey: null,
      sessionKey: "s-1",
      runtimeContext,
      existingMetadata: { env: { GOOD: "yes", BAD: 1 } },
    });
    await handle.session.run({ command: "true" });

    expect(lastEnvs(provider)).toEqual({ GOOD: "yes" });
  });

  test("bootstrap's use({ env }) applies to the rest of the template build", async () => {
    const { provider, backend } = setup();

    await backend.prewarm({
      templateKey: "tpl-1",
      runtimeContext,
      seedFiles: [],
      async bootstrap({ use }) {
        const sandbox = await use({ env: { DEBIAN_FRONTEND: "noninteractive" } });
        await sandbox.run({ command: "true" });
        expect(lastEnvs(provider)).toEqual({ DEBIAN_FRONTEND: "noninteractive" });
      },
    });
  });
});
