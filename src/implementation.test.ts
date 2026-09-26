import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type AliyunSandboxPreparedArtifact,
  type AliyunSandboxSessionState,
  createAliyunSandboxImplementation,
} from "./implementation.js";
import type { AliyunSandboxCreateOptions, AliyunSandboxOpenOptions } from "./options.js";
import { prepareContext, sessionContext } from "./testing/eve-context.js";
import { createFakeLinuxShell, FakeProvider } from "./testing/fake-provider.js";

const ALL_TRAFFIC = "0.0.0.0/0";
const NO_TEMPLATE: AliyunSandboxPreparedArtifact = { archive: null };

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), "eve-aliyun-"));
});
afterEach(async () => {
  await rm(cacheDir, { force: true, recursive: true });
});

function setup(shell = createFakeLinuxShell(), createOptions: AliyunSandboxCreateOptions = {}) {
  const provider = new FakeProvider(shell);
  const implementation = createAliyunSandboxImplementation({
    provider,
    createOptions: { cacheDir, ...createOptions },
  });
  async function start(
    artifact: AliyunSandboxPreparedArtifact = NO_TEMPLATE,
    options?: AliyunSandboxOpenOptions,
    sessionId?: string,
  ) {
    return await implementation.start(sessionContext(sessionId), options, artifact);
  }
  async function resume(
    state: AliyunSandboxSessionState,
    artifact: AliyunSandboxPreparedArtifact = NO_TEMPLATE,
  ) {
    return await implementation.resume(sessionContext(), artifact, state);
  }
  return { provider, implementation, start, resume };
}

async function templateWith(
  implementation: ReturnType<typeof setup>["implementation"],
  content = "from template",
) {
  return await implementation.prepare(
    prepareContext({ seedFiles: [{ path: "/workspace/seed.txt", content }] }),
  );
}

describe("prepare", () => {
  test("captures a template from seed files and prepare, then destroys the build sandbox", async () => {
    const { provider, implementation } = setup(undefined, {
      async prepare(sandbox) {
        expect(await sandbox.readTextFile({ path: "schema.sql" })).toBe("create table t;");
        await sandbox.writeTextFile({ path: "built.txt", content: "prepared" });
      },
    });

    const artifact = await implementation.prepare(
      prepareContext({
        seedFiles: [
          { path: "/workspace/schema.sql", content: "create table t;" },
          { path: "$HOME/.agents/skills/pdf/SKILL.md", content: Buffer.from("skill") },
        ],
      }),
    );

    expect(artifact.archive).toMatch(/^[0-9a-f]{32}\.tgz$/);
    expect(provider.created).toHaveLength(1);
    expect(provider.created[0]?.killed).toBe(true);
    expect(provider.created[0]?.text("/home/user/.agents/skills/pdf/SKILL.md")).toBe("skill");
    expect(await readdir(path.join(cacheDir, "templates"))).toEqual([artifact.archive]);
  });

  test("reuses an already captured template without creating a sandbox", async () => {
    const { provider, implementation } = setup();
    const first = await templateWith(implementation);

    const second = await templateWith(implementation);

    expect(second).toEqual(first);
    expect(provider.created).toHaveLength(1);
  });

  test("builds nothing when there is nothing to seed or prepare", async () => {
    const { provider, implementation } = setup();

    expect(await implementation.prepare(prepareContext())).toEqual({ archive: null });
    expect(provider.created).toHaveLength(0);
  });

  test("a changed source revision or seed set builds a new template", async () => {
    const { implementation } = setup();
    const seedFiles = [{ path: "/workspace/seed.txt", content: "a" }];
    const base = await implementation.prepare(prepareContext({ seedFiles }));

    const revised = await implementation.prepare(
      prepareContext({ seedFiles, sourceRevision: "rev-2" }),
    );
    const reseeded = await implementation.prepare(
      prepareContext({ seedFiles, resourcesKey: "other-resources" }),
    );

    expect(new Set([base.archive, revised.archive, reseeded.archive]).size).toBe(3);
  });

  test("a failing prepare caches nothing and still destroys the build sandbox", async () => {
    const { provider, implementation } = setup(undefined, {
      prepare() {
        throw new Error("apt exploded");
      },
    });

    await expect(implementation.prepare(prepareContext())).rejects.toThrow("apt exploded");

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
    const { provider, implementation } = setup(shell);

    await expect(templateWith(implementation)).rejects.toThrow("read-only file system");
    expect(provider.created[0]?.killed).toBe(true);
  });

  test("builds on the configured base template and lifetime, labelled as disposable", async () => {
    const { provider, implementation } = setup(undefined, {
      template: "my-image",
      timeoutMs: 1234,
      metadata: { agent: "support" },
    });

    const artifact = await templateWith(implementation);

    expect(provider.created[0]?.createOptions).toMatchObject({
      template: "my-image",
      timeoutMs: 1234,
      metadata: { agent: "support", eveTemplateKey: artifact.archive },
    });
  });

  test("reports progress through eve's log", async () => {
    const { implementation } = setup();
    const messages: string[] = [];
    const seedFiles = [{ path: "/workspace/seed.txt", content: "a" }];

    await implementation.prepare(prepareContext({ seedFiles, log: (m) => messages.push(m) }));
    await implementation.prepare(prepareContext({ seedFiles, log: (m) => messages.push(m) }));

    expect(messages.some((m) => m.startsWith("building template"))).toBe(true);
    expect(messages.at(-1)).toMatch(/^reusing /);
  });
});

describe("start", () => {
  test("opens a fresh sandbox with /workspace prepared when there is no template", async () => {
    const { provider, start } = setup();

    await start();

    expect(provider.created).toHaveLength(1);
    expect(
      provider.created[0]?.commands.some(
        (c) => c.user === "root" && c.command.includes("mkdir -p /workspace"),
      ),
    ).toBe(true);
  });

  test("a session started from a template sees the template's files", async () => {
    const { implementation, start } = setup();
    const artifact = await templateWith(implementation);

    const { handle } = await start(artifact);

    expect(await handle.sandbox.readTextFile({ path: "seed.txt" })).toBe("from template");
  });

  test("fails with rebuild guidance when the template archive is not on this machine", async () => {
    const { provider, start } = setup();

    const attempt = start({ archive: "0123456789abcdef0123456789abcdef.tgz" });

    await expect(attempt).rejects.toMatchObject({
      name: "SandboxTemplateNotProvisionedError",
      providerName: "aliyun",
      message: expect.stringMatching(/cacheDir/),
    });
    expect(provider.created).toHaveLength(0);
  });

  test("records plain-JSON state naming the sandbox and a session key of its own", async () => {
    const { provider, start } = setup();

    const { state } = await start(undefined, undefined, "eve-session-7");

    expect(state).toEqual({
      version: 1,
      sessionKey: expect.stringMatching(/^eve-session-7\./),
      sandboxId: provider.created[0]?.id,
      env: {},
      network: null,
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  test("labels the sandbox with its session and the environment's metadata", async () => {
    const { provider, start } = setup(undefined, { metadata: { agent: "support" } });

    const { state } = await start(undefined, undefined, "eve-session-7");

    expect(provider.created[0]?.createOptions.metadata).toEqual({
      agent: "support",
      eveSessionId: "eve-session-7",
      eveSessionKey: state.sessionKey,
    });
  });

  test("each start owns a new sandbox, even within one eve session", async () => {
    // A start that crashed before eve recorded its state must not be adopted
    // later: its sandbox is an orphan, and only its idle timeout reclaims it.
    const { provider, start } = setup();

    const first = await start(undefined, undefined, "s");
    const second = await start(undefined, undefined, "s");

    expect(provider.created).toHaveLength(2);
    expect(second.state.sessionKey).not.toBe(first.state.sessionKey);
  });

  test("rejects an artifact this provider did not prepare", async () => {
    const { start } = setup();

    await expect(start({ snapshotId: "x" } as never)).rejects.toThrow(/artifact/);
  });
});

describe("resume", () => {
  test("reattaches to the recorded sandbox instead of creating a new one", async () => {
    const { provider, start, resume } = setup();
    const { handle, state } = await start();
    await handle.sandbox.writeTextFile({ path: "kept.txt", content: "still here" });

    const resumed = await resume(state);

    expect(provider.created).toHaveLength(1);
    expect(await resumed.sandbox.readTextFile({ path: "kept.txt" })).toBe("still here");
  });

  test("replaces a sandbox the provider destroyed with a fresh one from the template", async () => {
    const { provider, implementation, start, resume } = setup();
    const artifact = await templateWith(implementation);
    const { state } = await start(artifact);
    await provider.sandboxes.get(state.sandboxId)?.kill();

    const resumed = await resume(state, artifact);

    expect(provider.created.at(-1)?.id).not.toBe(state.sandboxId);
    expect(await resumed.sandbox.readTextFile({ path: "seed.txt" })).toBe("from template");
  });

  test("later resumes find the replacement by session key", async () => {
    const { provider, start, resume } = setup();
    const { state } = await start();
    await provider.sandboxes.get(state.sandboxId)?.kill();
    await resume(state);

    await resume(state);

    expect(provider.created).toHaveLength(2);
  });

  test("rejects state this provider did not write", async () => {
    const { provider, resume } = setup();

    await expect(resume({ sandboxName: "x", version: 3 } as never)).rejects.toThrow(/state/);
    await expect(
      resume({
        version: 1,
        sessionKey: "k",
        sandboxId: "s",
        env: { BAD: 1 },
        network: null,
      } as never),
    ).rejects.toThrow(/state/);
    expect(provider.created).toHaveLength(0);
  });
});

describe("handle lifecycle", () => {
  test("stop pauses the sandbox where the account supports it, and the session resumes intact", async () => {
    const { provider, start, resume } = setup();
    provider.pauseSupported = true;
    const { handle, state } = await start();
    await handle.sandbox.writeTextFile({ path: "work.txt", content: "in progress" });

    await handle.onSessionStop();

    expect(provider.created[0]?.paused).toBe(true);
    expect(provider.created[0]?.killed).toBe(false);
    const resumed = await resume(state);
    expect(provider.created).toHaveLength(1);
    expect(await resumed.sandbox.readTextFile({ path: "work.txt" })).toBe("in progress");
  });

  test("stop without pause support checkpoints the session and releases the compute", async () => {
    const { provider, start, resume } = setup();
    const { handle, state } = await start();
    await handle.sandbox.writeTextFile({ path: "work.txt", content: "in progress" });

    await handle.onSessionStop();

    expect(provider.created[0]?.killed).toBe(true);
    expect(provider.sandboxes.size).toBe(0);
    const resumed = await resume(state);
    expect(provider.created).toHaveLength(2);
    expect(await resumed.sandbox.readTextFile({ path: "work.txt" })).toBe("in progress");
  });

  test("a checkpoint wins over the template it grew from", async () => {
    const { implementation, start, resume } = setup();
    const artifact = await templateWith(implementation);
    const { handle, state } = await start(artifact);
    await handle.sandbox.writeTextFile({ path: "seed.txt", content: "edited" });
    await handle.onSessionStop();

    const resumed = await resume(state, artifact);

    expect(await resumed.sandbox.readTextFile({ path: "seed.txt" })).toBe("edited");
  });

  test("stop kills running processes before releasing the sandbox", async () => {
    const shell = createFakeLinuxShell({
      onCommand: (command) => (command.command === "serve" ? { hang: true } : undefined),
    });
    const { start } = setup(shell);
    const { handle } = await start();
    const server = await handle.sandbox.spawn({ command: "serve" });

    await handle.onSessionStop();

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
    const { provider, start } = setup(shell);
    const { handle } = await start();
    failCapture = true;

    await expect(handle.onSessionStop()).rejects.toThrow("disk full");
    expect(provider.created[0]?.killed).toBe(false);
  });

  test("runtime shutdown never throws, even when the provider fails", async () => {
    const { provider, start } = setup();
    const { handle } = await start();
    const sandbox = provider.created[0];
    if (sandbox) sandbox.startCommand = async () => Promise.reject(new Error("provider down"));

    await expect(handle.onRuntimeShutdown()).resolves.toBeUndefined();
  });

  test("delete destroys the sandbox and its checkpoint, so a new start begins from the template", async () => {
    const { provider, implementation, start, resume } = setup();
    const artifact = await templateWith(implementation);
    const first = await start(artifact);
    await first.handle.sandbox.writeTextFile({ path: "work.txt", content: "in progress" });
    await first.handle.onSessionStop();
    const resumed = await resume(first.state, artifact);

    await resumed.onSessionDelete();

    expect(provider.sandboxes.size).toBe(0);
    expect(await readdir(path.join(cacheDir, "sessions"))).toEqual([]);
    const fresh = await start(artifact);
    expect(await fresh.handle.sandbox.readTextFile({ path: "work.txt" })).toBeNull();
    expect(await fresh.handle.sandbox.readTextFile({ path: "seed.txt" })).toBe("from template");
  });

  test("delete honours an already aborted signal", async () => {
    const { provider, start } = setup();
    const { handle } = await start();
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));

    await expect(handle.onSessionDelete({ abortSignal: abort.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(provider.created[0]?.killed).toBe(false);
  });
});

describe("network policy", () => {
  test("sandboxes start with the environment's policy already in force", async () => {
    const { provider, start } = setup(undefined, { networkPolicy: "deny-all" });

    await start();

    expect(provider.created[0]?.createOptions.network).toEqual({
      allowOut: [],
      denyOut: [ALL_TRAFFIC],
      rules: {},
    });
  });

  test("allow-all is the default", async () => {
    const { provider, start } = setup();

    await start();

    expect(provider.created[0]?.createOptions.network).toEqual({
      allowOut: [],
      denyOut: [],
      rules: {},
    });
  });

  test("the environment's policy governs preparation too", async () => {
    const { provider, implementation } = setup(undefined, {
      networkPolicy: { allow: ["deb.debian.org"] },
    });

    await templateWith(implementation);

    expect(provider.created[0]?.createOptions.network?.allowOut).toEqual(["deb.debian.org"]);
  });

  test("prepare can tighten the policy for the rest of the template build", async () => {
    const { provider, implementation } = setup(undefined, {
      async prepare(sandbox) {
        await sandbox.setNetworkPolicy("deny-all");
      },
    });

    await implementation.prepare(prepareContext());

    expect(provider.created[0]?.network.denyOut).toEqual([ALL_TRAFFIC]);
  });

  test("open({ networkPolicy }) is in force from the moment the session's sandbox starts", async () => {
    const { provider, start } = setup();

    const { state } = await start(undefined, { networkPolicy: { allow: ["api.example.com"] } });

    const expected = { allowOut: ["api.example.com"], denyOut: [ALL_TRAFFIC], rules: {} };
    expect(provider.created[0]?.createOptions.network).toEqual(expected);
    expect(state.network).toEqual(expected);
  });

  test("a replacement sandbox gets the session's policy, not the environment's", async () => {
    const { provider, start, resume } = setup();
    const { state } = await start(undefined, { networkPolicy: "deny-all" });
    await provider.sandboxes.get(state.sandboxId)?.kill();

    await resume(state);

    expect(provider.created[1]?.createOptions.network?.denyOut).toEqual([ALL_TRAFFIC]);
  });

  test("open rejects a policy the provider cannot express, before creating anything", async () => {
    const { provider, start } = setup();

    await expect(
      start(undefined, {
        networkPolicy: { allow: { "a.example.com": [{ forwardURL: "https://proxy.example" }] } },
      }),
    ).rejects.toThrow(/forwardURL/);
    expect(provider.created).toHaveLength(0);
  });

  test("setNetworkPolicy changes egress on the live sandbox", async () => {
    const { provider, start } = setup();
    const { handle } = await start();

    await handle.sandbox.setNetworkPolicy({
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
    const { provider, start } = setup();
    const { handle } = await start();

    await expect(
      handle.sandbox.setNetworkPolicy({
        allow: { "a.example.com": [{ forwardURL: "https://proxy.example.com" }] },
      }),
    ).rejects.toThrow(/forwardURL/);
    expect(provider.created[0]?.network.denyOut).toEqual([]);
  });
});

describe("session environment", () => {
  function lastEnvs(provider: FakeProvider) {
    return provider.created.at(-1)?.commands.at(-1)?.envs;
  }

  test("open({ env }) adds variables to every command; per-call env still wins", async () => {
    const { provider, start } = setup(undefined, { env: { BASE: "factory", TOKEN: "factory" } });
    const { handle } = await start(undefined, { env: { TOKEN: "session" } });

    await handle.sandbox.run({ command: "true" });
    expect(lastEnvs(provider)).toEqual({ BASE: "factory", TOKEN: "session" });

    await handle.sandbox.run({ command: "true", env: { TOKEN: "call" } });
    expect(lastEnvs(provider)).toEqual({ BASE: "factory", TOKEN: "call" });
  });

  test("the session environment is recorded in state and reaches resumed and replacement sandboxes", async () => {
    const { provider, start, resume } = setup();
    const { state } = await start(undefined, { env: { TOKEN: "session" } });
    expect(state.env).toEqual({ TOKEN: "session" });

    await (await resume(state)).sandbox.run({ command: "true" });
    expect(lastEnvs(provider)).toEqual({ TOKEN: "session" });

    await provider.sandboxes.get(state.sandboxId)?.kill();
    await (await resume(state)).sandbox.run({ command: "true" });
    expect(provider.created).toHaveLength(2);
    expect(lastEnvs(provider)).toEqual({ TOKEN: "session" });
  });

  test("the environment's env is read at resume, so a redeploy's change takes effect", async () => {
    const before = setup(undefined, { env: { BASE: "old" } });
    const { state } = await before.start();
    const after = createAliyunSandboxImplementation({
      provider: before.provider,
      createOptions: { cacheDir, env: { BASE: "new" } },
    });

    const handle = await after.resume(sessionContext(), NO_TEMPLATE, state);
    await handle.sandbox.run({ command: "true" });

    expect(lastEnvs(before.provider)).toEqual({ BASE: "new" });
  });
});
