import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SandboxSessionGoneError, SandboxTemplateNotProvisionedError } from "eve/sandbox/provider";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type AliyunSandboxPreparedArtifact,
  type AliyunSandboxSessionState,
  createAliyunSandboxImplementation,
} from "./implementation.js";
import {
  type AliyunSandboxCreateOptions,
  type AliyunSandboxOpenOptions,
  resolveSessionCheckpointPath,
} from "./options.js";
import {
  prepareContext,
  sessionContext,
  sessionOver,
  type TestSession,
} from "./testing/eve-context.js";
import { createFakeLinuxShell, FakeProvider, type FakeShell } from "./testing/fake-provider.js";

const ALL_TRAFFIC = "0.0.0.0/0";
const NO_TEMPLATE: AliyunSandboxPreparedArtifact = { archive: null };
const SESSION_FILE = "/var/tmp/.eve-aliyun/session.json";

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), "eve-aliyun-"));
});
afterEach(async () => {
  await rm(cacheDir, { force: true, recursive: true });
});

function setup(
  shell: FakeShell = createFakeLinuxShell(),
  createOptions: AliyunSandboxCreateOptions = {},
) {
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
    const started = await implementation.start(sessionContext(sessionId), options, artifact);
    return { ...started, sandbox: sessionOver(started.connection) };
  }
  async function resume(state: unknown, artifact: AliyunSandboxPreparedArtifact = NO_TEMPLATE) {
    const connection = await implementation.resume(
      sessionContext(),
      artifact,
      state as AliyunSandboxSessionState,
    );
    return { connection, sandbox: sessionOver(connection) };
  }
  async function end(state: unknown, sessionId?: string) {
    await implementation.onSessionEnd(
      sessionContext(sessionId),
      state as AliyunSandboxSessionState | null,
      { reason: "completed" },
    );
  }
  async function idle(state: unknown) {
    await implementation.onSessionIdle?.(
      sessionContext(),
      state as AliyunSandboxSessionState | null,
      {},
    );
  }
  return { provider, implementation, start, resume, end, idle };
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
  test("seeds files and runs the authored prepare through eve's populate, then destroys the build sandbox", async () => {
    const { provider, implementation } = setup();

    const artifact = await implementation.prepare(
      prepareContext({
        seedFiles: [
          { path: "/workspace/schema.sql", content: "create table t;" },
          { path: "$HOME/.agents/skills/pdf/SKILL.md", content: Buffer.from("skill") },
        ],
        async prepare(sandbox: TestSession) {
          expect(await sandbox.readText("schema.sql")).toBe("create table t;");
          await sandbox.writeText("built.txt", "prepared");
        },
      }),
    );

    expect(artifact.archive).toMatch(/^[0-9a-f]{32}\.tgz$/);
    expect(provider.created).toHaveLength(1);
    expect(provider.created[0]?.killed).toBe(true);
    expect(provider.created[0]?.text("/home/user/.agents/skills/pdf/SKILL.md")).toBe("skill");
    expect(provider.created[0]?.text("/workspace/built.txt")).toBe("prepared");
    expect(await readdir(path.join(cacheDir, "templates"))).toEqual([artifact.archive]);
  });

  test("reuses an already captured template without creating a sandbox", async () => {
    const { provider, implementation } = setup();
    const first = await templateWith(implementation);

    const second = await templateWith(implementation);

    expect(second).toEqual(first);
    expect(provider.created).toHaveLength(1);
  });

  test("builds nothing when eve reports nothing to seed or prepare", async () => {
    const { provider, implementation } = setup();

    expect(await implementation.prepare(prepareContext())).toEqual({ archive: null });
    expect(provider.created).toHaveLength(0);
  });

  test("a changed template key or base template builds a new template", async () => {
    const seedFiles = [{ path: "/workspace/seed.txt", content: "a" }];
    const base = await setup().implementation.prepare(prepareContext({ seedFiles }));
    const revised = await setup().implementation.prepare(
      prepareContext({ seedFiles, sourceRevision: "rev-2" }),
    );
    const rebased = await setup(undefined, { template: "other" }).implementation.prepare(
      prepareContext({ seedFiles }),
    );

    expect(new Set([base.archive, revised.archive, rebased.archive]).size).toBe(3);
  });

  test("a failing prepare caches nothing and still destroys the build sandbox", async () => {
    const { provider, implementation } = setup();

    await expect(
      implementation.prepare(
        prepareContext({
          prepare() {
            throw new Error("apt exploded");
          },
        }),
      ),
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

  test("sets eve's agent env beneath the environment's env", async () => {
    const { provider, implementation } = setup(undefined, { env: { AI_AGENT: "mine", A: "1" } });

    await templateWith(implementation);

    expect(provider.created[0]?.createOptions.envs).toEqual({ AI_AGENT: "mine", A: "1" });
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
  test("creates the session's sandbox with /workspace prepared when there is no template", async () => {
    const { provider, start } = setup();

    await start();

    const sandbox = provider.created[0];
    const setupCommand = sandbox?.commands.find((c) => c.command.includes("mkdir -p /workspace"));
    expect(setupCommand?.user).toBe("root");
    expect(setupCommand?.command).toContain("chown 'user': /workspace");
  });

  test("a session started from a template sees the template's files", async () => {
    const { implementation, start } = setup();
    const artifact = await templateWith(implementation);

    const { sandbox } = await start(artifact);

    expect(await sandbox.readText("seed.txt")).toBe("from template");
  });

  test("fails with eve's template error when the archive is not on this machine", async () => {
    const { provider, start } = setup();

    const failure = start({ archive: "0123.tgz" });

    await expect(failure).rejects.toSatisfy(SandboxTemplateNotProvisionedError.is);
    await expect(failure).rejects.toThrow(/ship cacheDir/);
    expect(provider.created).toHaveLength(0);
  });

  test("records plain-JSON state naming the sandbox and the env it was created with", async () => {
    const { start } = setup();

    const { state } = await start(undefined, { env: { TOKEN: "t" } });

    expect(state).toEqual({ version: 2, sandboxId: "sbx-1", env: { TOKEN: "t" } });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  test("labels the sandbox with its session and the environment's metadata", async () => {
    const { provider, start } = setup(undefined, { metadata: { agent: "support" } });

    await start(undefined, undefined, "session-9");

    expect(provider.created[0]?.createOptions.metadata).toEqual({
      agent: "support",
      eveSessionId: "session-9",
    });
  });

  test("a second start for the session returns the same sandbox and the env it was created with", async () => {
    const { provider, start } = setup();
    const first = await start(undefined, { env: { TOKEN: "first" } });

    const second = await start(undefined, { env: { TOKEN: "second" }, networkPolicy: "deny-all" });

    expect(provider.created).toHaveLength(1);
    expect(second.state).toEqual(first.state);
    await second.sandbox.run({ command: "true" });
    expect(provider.created[0]?.commands.at(-1)?.envs).toEqual({ TOKEN: "first" });
  });

  test("other sessions get their own sandbox", async () => {
    const { provider, start } = setup();

    await start(undefined, undefined, "a");
    await start(undefined, undefined, "b");

    expect(provider.created).toHaveLength(2);
  });

  test("never adopts a sandbox whose creation did not finish", async () => {
    const { provider, start } = setup();
    const halfBuilt = await provider.create({
      template: "t",
      timeoutMs: 1,
      metadata: { eveSessionId: "session-1" },
    });

    const { state } = await start();

    expect(state.sandboxId).not.toBe(halfBuilt.id);
    expect(halfBuilt.killed).toBe(false);
  });

  test("a sandbox whose restore failed is destroyed, not left for a later start", async () => {
    const { provider, implementation, start } = setup(
      createFakeLinuxShell({
        onCommand: (command) =>
          command.command.includes("-xzpf") ? { exitCode: 2, stderr: "tar: corrupt\n" } : undefined,
      }),
    );
    const artifact = await templateWith(implementation);

    await expect(start(artifact)).rejects.toThrow("corrupt");
    expect(provider.created.at(-1)?.killed).toBe(true);
  });

  test("rejects an artifact this provider did not prepare", async () => {
    const { start } = setup();

    await expect(start({ snapshotId: "x" } as never)).rejects.toThrow("invalid prepared artifact");
  });
});

describe("resume", () => {
  test("reconnects to the recorded sandbox", async () => {
    const { provider, start, resume } = setup();
    const { sandbox, state } = await start();
    await sandbox.writeText("work.txt", "in progress");

    const resumed = await resume(state);

    expect(provider.created).toHaveLength(1);
    expect(await resumed.sandbox.readText("work.txt")).toBe("in progress");
  });

  test("reports a sandbox the provider destroyed as gone, and creates nothing", async () => {
    const { provider, start, resume } = setup();
    const { state } = await start();
    await provider.kill(state.sandboxId);

    await expect(resume(state)).rejects.toSatisfy(SandboxSessionGoneError.is);
    expect(provider.created).toHaveLength(1);
  });

  test("the session env from state reaches every command", async () => {
    const { provider, start, resume } = setup(undefined, { env: { BASE: "env" } });
    const { state } = await start(undefined, { env: { TOKEN: "session" } });

    const { sandbox } = await resume(state);
    await sandbox.run({ command: "true", env: { CALL: "1" } });

    expect(provider.created[0]?.commands.at(-1)?.envs).toEqual({
      BASE: "env",
      TOKEN: "session",
      CALL: "1",
    });
  });

  test("the environment's env is read at resume, so a redeploy's change takes effect", async () => {
    const provider = new FakeProvider(createFakeLinuxShell());
    const before = createAliyunSandboxImplementation({
      provider,
      createOptions: { cacheDir, env: { MODE: "old" } },
    });
    const after = createAliyunSandboxImplementation({
      provider,
      createOptions: { cacheDir, env: { MODE: "new" } },
    });
    const { state } = await before.start(sessionContext(), undefined, NO_TEMPLATE);

    await sessionOver(await after.resume(sessionContext(), NO_TEMPLATE, state)).run({
      command: "true",
    });

    expect(provider.created[0]?.commands.at(-1)?.envs).toEqual({ MODE: "new" });
  });

  test("rejects state this provider did not write", async () => {
    const { resume } = setup();

    await expect(resume({ version: 3, sandboxId: "x", env: {} })).rejects.toThrow(
      "invalid session state",
    );
  });
});

describe("stop and idle", () => {
  test("stop pauses where the account supports it, and resume reconnects intact", async () => {
    const { provider, start, resume } = setup();
    provider.pauseSupported = true;
    const { connection, sandbox, state } = await start();
    await sandbox.writeText("work.txt", "in progress");

    await connection.stop();

    expect(provider.created[0]?.paused).toBe(true);
    expect(provider.created[0]?.killed).toBe(false);
    expect(await (await resume(state)).sandbox.readText("work.txt")).toBe("in progress");
    expect(provider.created).toHaveLength(1);
  });

  test("stop without pause checkpoints; resume reports the sandbox gone and the next start restores it", async () => {
    const { provider, implementation, start, resume } = setup();
    const artifact = await templateWith(implementation);
    const first = await start(artifact);
    await first.sandbox.writeText("seed.txt", "edited");
    await first.sandbox.writeText("work.txt", "in progress");

    await first.connection.stop();

    expect(provider.created[1]?.killed).toBe(true);
    await expect(resume(first.state, artifact)).rejects.toSatisfy(SandboxSessionGoneError.is);
    const next = await start(artifact);
    expect(next.state.sandboxId).not.toBe(first.state.sandboxId);
    expect(await next.sandbox.readText("work.txt")).toBe("in progress");
    expect(await next.sandbox.readText("seed.txt")).toBe("edited");
  });

  test("stop kills running processes before releasing the sandbox", async () => {
    const shell = createFakeLinuxShell({
      onCommand: (command) => (command.command === "serve" ? { hang: true } : undefined),
    });
    const { start } = setup(shell);
    const { connection, sandbox } = await start();
    const server = await sandbox.spawn({ command: "serve" });

    await connection.stop();

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
    const { connection } = await start();
    failCapture = true;

    await expect(connection.stop()).rejects.toThrow("disk full");
    expect(provider.created[0]?.killed).toBe(false);
  });

  test("idle releases a running sandbox: pause where supported", async () => {
    const { provider, start, idle } = setup();
    provider.pauseSupported = true;
    const { state } = await start();

    await idle(state);

    expect(provider.created[0]?.paused).toBe(true);
  });

  test("idle without pause checkpoints and destroys, so the session continues from it", async () => {
    const { provider, start, idle } = setup();
    const { sandbox, state } = await start();
    await sandbox.writeText("work.txt", "in progress");

    await idle(state);

    expect(provider.created[0]?.killed).toBe(true);
    expect(await (await start()).sandbox.readText("work.txt")).toBe("in progress");
  });

  test("idle never resumes a paused sandbox", async () => {
    const { provider, start, idle } = setup();
    provider.pauseSupported = true;
    const { state } = await start();
    await idle(state);
    const connect = provider.connect.bind(provider);
    const connected: string[] = [];
    provider.connect = async (id) => {
      connected.push(id);
      return await connect(id);
    };

    await idle(state);

    expect(connected).toEqual([]);
    expect(provider.created[0]?.paused).toBe(true);
  });

  test("idle releases only the recorded sandbox, so another one cannot overwrite its checkpoint", async () => {
    const { provider, start, idle } = setup();
    const { sandbox, state } = await start();
    await sandbox.writeText("work.txt", "recorded");
    const other = await provider.create({
      template: "t",
      timeoutMs: 1,
      metadata: { eveSessionId: "session-1" },
    });
    other.files.set("/workspace/work.txt", new TextEncoder().encode("stale"));

    await idle(state);

    expect(provider.created[0]?.killed).toBe(true);
    expect(other.killed).toBe(false);
    expect(await (await start()).sandbox.readText("work.txt")).toBe("recorded");
  });

  test("idle finds the session's sandbox without state, and succeeds when there is none", async () => {
    const { provider, start, idle } = setup();
    provider.pauseSupported = true;
    await start();

    await idle(null);
    expect(provider.created[0]?.paused).toBe(true);

    await setup().idle(null);
  });
});

describe("session end", () => {
  test("destroys the sandbox and its checkpoint, so a new start begins from the template", async () => {
    const { provider, implementation, start, end } = setup();
    const artifact = await templateWith(implementation);
    const first = await start(artifact);
    await first.sandbox.writeText("work.txt", "in progress");
    await first.connection.stop();
    const second = await start(artifact);

    await end(second.state);

    expect(provider.sandboxes.size).toBe(0);
    expect(await readdir(path.join(cacheDir, "sessions"))).toEqual([]);
    const fresh = await start(artifact);
    expect(await fresh.sandbox.readText("work.txt")).toBeNull();
    expect(await fresh.sandbox.readText("seed.txt")).toBe("from template");
  });

  test("destroys a paused sandbox without resuming it first", async () => {
    const { provider, start, end } = setup();
    provider.pauseSupported = true;
    const { connection, state } = await start();
    await connection.stop();
    provider.connect = async () => Promise.reject(new Error("must not connect"));

    await end(state);

    expect(provider.created[0]?.killed).toBe(true);
  });

  test("without state, finds the session's sandboxes by label, half-built ones included", async () => {
    const { provider, start, end } = setup();
    await start();
    const halfBuilt = await provider.create({
      template: "t",
      timeoutMs: 1,
      metadata: { eveSessionId: "session-1" },
    });

    await end(null);

    expect(provider.created[0]?.killed).toBe(true);
    expect(halfBuilt.killed).toBe(true);
  });

  test("leaves other sessions' sandboxes alone", async () => {
    const { provider, start, end } = setup();
    const mine = await start(undefined, undefined, "session-1");
    await start(undefined, undefined, "session-2");

    await end(mine.state, "session-1");

    expect(provider.created.map((s) => s.killed)).toEqual([true, false]);
  });

  test("is idempotent, because eve retries the cleanup step", async () => {
    const { start, end } = setup();
    const { state } = await start();

    await end(state);
    await end(state);
    await setup().end(null);
  });

  test("a failed kill does not stop the others, and the retry finishes with the checkpoint", async () => {
    const { provider, start, end } = setup();
    const first = await start();
    await first.connection.stop();
    const { state } = await start();
    const orphan = await provider.create({
      template: "t",
      timeoutMs: 1,
      metadata: { eveSessionId: "session-1" },
    });
    const kill = provider.kill.bind(provider);
    let failOnce = true;
    provider.kill = async (sandboxId) => {
      if (sandboxId === state.sandboxId && failOnce) {
        failOnce = false;
        throw new Error("provider down");
      }
      await kill(sandboxId);
    };

    await expect(end(state)).rejects.toThrow("could not destroy");
    expect(orphan.killed).toBe(true);
    expect(await readdir(path.join(cacheDir, "sessions"))).toHaveLength(1);

    await end(state);
    expect(await readdir(path.join(cacheDir, "sessions"))).toEqual([]);
  });

  test("still destroys the recorded sandbox when the lookup by label fails", async () => {
    const { provider, start, end } = setup();
    const { state } = await start();
    provider.findByMetadata = async () => Promise.reject(new Error("list failed"));

    await expect(end(state)).rejects.toThrow("could not destroy");
    expect(provider.created[0]?.killed).toBe(true);
  });

  test("waits for a stop that is still checkpointing, so the checkpoint does not come back", async () => {
    let gated = false;
    let captureStarted!: () => void;
    let finishCapture!: () => void;
    const capturing = new Promise<void>((resolve) => (captureStarted = resolve));
    const gate = new Promise<void>((resolve) => (finishCapture = resolve));
    const linux = createFakeLinuxShell();
    const { start, end } = setup(async (command, sandbox) => {
      if (gated && command.command.includes("-czpf")) {
        captureStarted();
        await gate;
      }
      return await linux(command, sandbox);
    });
    const { connection, state } = await start();
    gated = true;

    const stopping = connection.stop();
    await capturing;
    const ending = end(state);
    finishCapture();
    await Promise.all([stopping, ending]);

    expect(await readdir(path.join(cacheDir, "sessions"))).toEqual([]);
  });

  test("honours an already aborted signal", async () => {
    const { provider, implementation, start } = setup();
    const { state } = await start();
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));

    await expect(
      implementation.onSessionEnd(sessionContext(), state, {
        reason: "deleted",
        signal: abort.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(provider.created[0]?.killed).toBe(false);
  });

  test("rejects state this provider did not write", async () => {
    const { end } = setup();

    await expect(end({ version: 2 })).rejects.toThrow("invalid session state");
  });
});

describe("state recorded by 0.4", () => {
  const legacy = (sandboxId: string) => ({
    version: 1,
    sessionKey: "session-1.key",
    sandboxId,
    env: { TOKEN: "legacy" },
    network: null,
  });

  test("resume reconnects to the sandbox it names, with its env", async () => {
    const { provider, resume } = setup();
    const old = await provider.create({ template: "t", timeoutMs: 1, metadata: {} });

    await (await resume(legacy(old.id))).sandbox.run({ command: "true" });

    expect(old.commands.at(-1)?.envs).toEqual({ TOKEN: "legacy" });
  });

  test("a gone sandbox's checkpoint carries over to the session's next start", async () => {
    const { resume, start } = setup();
    const legacyPath = resolveSessionCheckpointPath(cacheDir, "session-1.key");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    const snapshot = [["/workspace/work.txt", Buffer.from("kept").toString("base64")]];
    await writeFile(legacyPath, JSON.stringify(snapshot));

    await expect(resume(legacy("sbx-gone"))).rejects.toSatisfy(SandboxSessionGoneError.is);

    expect(existsSync(legacyPath)).toBe(false);
    expect(await (await start()).sandbox.readText("work.txt")).toBe("kept");
  });

  test("session end destroys sandboxes labelled with the 0.4 session key", async () => {
    const { provider, end } = setup();
    const old = await provider.create({
      template: "t",
      timeoutMs: 1,
      metadata: { eveSessionKey: "session-1.key" },
    });

    await end(legacy("sbx-gone"));

    expect(old.killed).toBe(true);
  });
});

describe("network policy and public traffic", () => {
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

  test("the environment's policy governs preparation, and prepare can tighten it", async () => {
    const { provider, implementation } = setup(undefined, {
      networkPolicy: { allow: ["deb.debian.org"] },
    });

    await implementation.prepare(
      prepareContext({
        async prepare(sandbox) {
          await sandbox.setNetworkPolicy("deny-all");
        },
      }),
    );

    expect(provider.created[0]?.createOptions.network?.allowOut).toEqual(["deb.debian.org"]);
    expect(provider.created[0]?.network.denyOut).toEqual([ALL_TRAFFIC]);
  });

  test("open({ networkPolicy }) is in force from the moment the session's sandbox starts", async () => {
    const { provider, start } = setup();

    await start(undefined, { networkPolicy: { allow: ["api.example.com"] } });

    expect(provider.created[0]?.createOptions.network).toEqual({
      allowOut: ["api.example.com"],
      denyOut: [ALL_TRAFFIC],
      rules: {},
    });
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
    const { sandbox } = await start();

    await sandbox.setNetworkPolicy({
      allow: { "github.com": [{ transform: [{ headers: { authorization: "Basic abc" } }] }] },
    });

    expect(provider.created[0]?.network).toEqual({
      allowOut: ["github.com"],
      denyOut: [ALL_TRAFFIC],
      rules: { "github.com": [{ transform: { headers: { authorization: "Basic abc" } } }] },
    });
  });

  test("setNetworkPolicy rejects a policy the provider cannot express, leaving egress unchanged", async () => {
    const { provider, start } = setup();
    const { sandbox } = await start();

    await expect(
      sandbox.setNetworkPolicy({
        allow: { "a.example.com": [{ forwardURL: "https://proxy.example.com" }] },
      }),
    ).rejects.toThrow(/forwardURL/);
    expect(provider.created[0]?.network.denyOut).toEqual([]);
  });

  test("every sandbox, the build one and a restored one included, gets the public traffic setting", async () => {
    const { provider, implementation, start } = setup(undefined, { allowPublicTraffic: false });
    const artifact = await templateWith(implementation);
    const first = await start(artifact);
    await first.connection.stop();

    await start(artifact);

    expect(provider.created).toHaveLength(3);
    for (const { createOptions } of provider.created) {
      expect(createOptions.allowPublicTraffic).toBe(false);
    }
  });

  test("leaves public traffic to the provider's default unless asked", async () => {
    const { provider, start } = setup();

    await start();

    expect(provider.created[0]?.createOptions).not.toHaveProperty("allowPublicTraffic");
  });
});

test("the session file, written last, marks a ready sandbox and holds its env", async () => {
  const { provider, start } = setup();

  await start(undefined, { env: { TOKEN: "t" } });

  expect(provider.created[0]?.text(SESSION_FILE)).toBe('{"env":{"TOKEN":"t"}}');
});
