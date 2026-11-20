/**
 * Contract test against the REAL Aliyun FC Agent Sandbox service.
 *
 *   pnpm smoke        (reads E2B_API_KEY / E2B_API_URL / E2B_DOMAIN from .env.local)
 *
 * It creates billable sandboxes. Every sandbox it creates carries the run id in
 * its metadata and is destroyed in `finally`, and the run ends by listing what
 * is left so a leak is visible rather than silent.
 *
 * It drives the provider implementation the way eve 1.x does — prepare at build
 * time with `populate()`, start once per session (and again after a sandbox is
 * gone), resume on later access, stop, idle and session end — without an eve
 * runtime around it. Commands go through the connection, as eve's session does.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Sandbox } from "e2b";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import { SandboxSessionGoneError, type SandboxSessionContext } from "eve/sandbox/provider";
import { createAliyunEnvironment } from "../environment.js";
import type {
  AliyunSandboxImplementation,
  AliyunSandboxPreparedArtifact,
} from "../implementation.js";
import { createE2bProvider, resolveAliyunConnection } from "../index.js";
import { translateNetworkPolicy } from "../network-policy.js";
import type { AliyunSandboxOpenOptions } from "../options.js";
import {
  prepareContext,
  sessionContext,
  sessionOver,
  type TestSession,
} from "../testing/eve-context.js";

const runId = `smoke-${randomUUID().slice(0, 8)}`;
const connection = resolveAliyunConnection({});
const provider = createE2bProvider({ connection });
const cacheDir = await mkdtemp(path.join(tmpdir(), "eve-aliyun-smoke-"));
const implementation = createAliyunEnvironment({
  cacheDir,
  timeoutMs: 10 * 60_000,
  env: { SMOKE_ENV: "from-environment" },
  metadata: { smokeRun: runId },
});
const closedEnvironment = createAliyunEnvironment({
  cacheDir,
  timeoutMs: 5 * 60_000,
  metadata: { smokeRun: runId },
  allowPublicTraffic: false,
});
const context = sessionContext(`${runId}-session`);
const openOptions: AliyunSandboxOpenOptions = { env: { SMOKE_TOKEN: "per session" } };
const seedFiles = [
  { path: "/workspace/seed/schema.sql", content: "create table t;\n" },
  { path: "$HOME/.agents/skills/demo/SKILL.md", content: Buffer.from("# demo skill\n") },
];
async function prepare(sandbox: TestSession): Promise<void> {
  const setup = await sandbox.run({
    command: [
      "set -e",
      "sudo apt-get update -qq",
      "sudo apt-get install -y -qq jq >/dev/null",
      `printf '#!/bin/sh\\necho eve-tool-ok\\n' | sudo tee /usr/local/bin/eve-tool >/dev/null`,
      "sudo chmod +x /usr/local/bin/eve-tool",
    ].join("\n"),
  });
  assert.equal(setup.exitCode, 0, setup.stderr || setup.stdout);
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  await fn();
  console.log(`  ok  ${name} (${Date.now() - startedAt} ms)`);
}

const sandboxesOf = (sessionId: string) => provider.findByMetadata({ eveSessionId: sessionId });

/**
 * What eve does on access: resume the recorded sandbox, and when resume says it
 * is gone, run the selector again, which starts the session's next sandbox.
 */
async function access(
  environment: AliyunSandboxImplementation,
  ctx: SandboxSessionContext,
  artifact: AliyunSandboxPreparedArtifact,
  state: Parameters<AliyunSandboxImplementation["resume"]>[2],
): Promise<{
  how: "reconnected" | "started";
  connection: Awaited<ReturnType<typeof environment.resume>>;
  state: typeof state;
}> {
  try {
    return {
      how: "reconnected",
      connection: await environment.resume(ctx, artifact, state),
      state,
    };
  } catch (error) {
    if (!SandboxSessionGoneError.is(error)) throw error;
    const started = await environment.start(ctx, openOptions, artifact);
    return { how: "started", connection: started.connection, state: started.state };
  }
}

/**
 * The sandbox's network block is `policy` with public traffic closed, and its
 * port 8080 answers with the traffic token (so the server is up and the gateway
 * routes) but refuses without it.
 */
async function assertPortsClosed(sandboxId: string, policy: SandboxNetworkPolicy): Promise<void> {
  const expected = translateNetworkPolicy(policy);
  const { network } = await Sandbox.getInfo(sandboxId, { ...connection });
  assert.equal(network?.allowPublicTraffic, false, "allowPublicTraffic is still false");
  assert.deepEqual(network?.allowOut ?? [], expected.allowOut, "the egress update landed");
  assert.deepEqual(network?.denyOut ?? [], expected.denyOut, "the egress update landed");
  assert.deepEqual(Object.keys(network?.rules ?? {}), Object.keys(expected.rules));
  const sdk = await Sandbox.connect(sandboxId, { ...connection });
  const url = `https://${sdk.getHost(8080)}/`;
  const status = async (headers: Record<string, string>) =>
    (await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })).status;
  const token = { "e2b-traffic-access-token": sdk.trafficAccessToken ?? "" };
  let open = 0;
  for (let attempt = 0; attempt < 10 && open !== 200; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
    open = await status(token);
  }
  assert.equal(open, 200, "the server answers with the traffic token");
  assert.equal(await status({}), 403, "and refuses without it");
}

try {
  const artifact = await implementation.prepare(
    prepareContext({ seedFiles, prepare, log: (message) => console.log(`      ${message}`) }),
  );

  await check("prepare captured a template, including root-level changes", async () => {
    assert.match(artifact.archive ?? "", /\.tgz$/);
  });

  await check("prepare reuses the captured template", async () => {
    const messages: string[] = [];
    const again = await implementation.prepare(
      prepareContext({ seedFiles, prepare, log: (message) => messages.push(message) }),
    );
    assert.deepEqual(again, artifact);
    assert.match(messages.at(-1) ?? "", /^reusing /);
  });

  const started = await implementation.start(context, openOptions, artifact);
  let { state } = started;
  let session = sessionOver(started.connection);
  let live = started.connection;

  await check(
    "commands run as the unprivileged user, in /workspace, through a login shell",
    async () => {
      const result = await session.run({
        command: `whoami; pwd; shopt -q login_shell && echo login; echo "$SMOKE_ENV"; echo "$AI_AGENT"; sudo -n true && echo sudo-ok`,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split("\n"), [
        "user",
        "/workspace",
        "login",
        "from-environment",
        "eve",
        "sudo-ok",
      ]);
    },
  );

  await check(
    "a session starts from the template: seeds, skills, and installed software",
    async () => {
      assert.equal(await session.readText("seed/schema.sql"), "create table t;\n");
      const result = await session.run({
        command: `cat "$HOME/.agents/skills/demo/SKILL.md"; eve-tool; echo '{"a":42}' | jq .a; stat -c %U /workspace/seed/schema.sql`,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split("\n"), [
        "# demo skill",
        "eve-tool-ok",
        "42",
        "user",
      ]);
    },
  );

  await check("run reports a nonzero exit, separate streams, per-call env and cwd", async () => {
    await session.run({ command: "mkdir -p sub" });
    const result = await session.run({
      command: `echo out; echo err >&2; echo "$CALL_ENV"; echo "$SMOKE_TOKEN"; pwd; exit 7`,
      env: { CALL_ENV: "per-call" },
      workingDirectory: "sub",
    });
    assert.deepEqual(result, {
      exitCode: 7,
      stdout: "out\nper-call\nper session\n/workspace/sub\n",
      stderr: "err\n",
    });
  });

  await check("files round-trip byte-exactly, and a missing file reads as null", async () => {
    const bytes = new Uint8Array([0, 255, 254, 10, 13, 128]);
    await session.writeBytes("data/blob.bin", bytes);
    assert.deepEqual(await session.readBytes("data/blob.bin"), bytes);
    assert.equal(await session.readText("data/absent.txt"), null);
    assert.equal(await session.readBytes("/nonexistent/x"), null);
  });

  await check("removePath follows rm semantics", async () => {
    await assert.rejects(session.removePath({ path: "data/absent.txt" }));
    await session.removePath({ path: "data/absent.txt", force: true });
    await assert.rejects(session.removePath({ path: "data" }));
    await session.removePath({ path: "data", recursive: true });
    assert.equal(await session.readText("data/blob.bin"), null);
  });

  // A consumer that closes its port URLs to requests without the traffic token.
  // eve's setNetworkPolicy() sends a whole new egress block that names no
  // allowPublicTraffic, and the SDK says omitted fields are cleared, so every
  // shape of update is checked to leave the ports closed.
  const closedArtifact = await closedEnvironment.prepare(prepareContext());
  const egressUpdates: Array<[string, SandboxNetworkPolicy]> = [
    ["an allow-list", { allow: ["www.baidu.com"] }],
    [
      "a header rule",
      { allow: { "httpbin.org": [{ transform: [{ headers: { "x-eve-smoke": runId } }] }] } },
    ],
    ["deny-all", "deny-all"],
    ["allow-all", "allow-all"],
  ];
  const closedCases: Array<[string, SandboxNetworkPolicy | undefined]> = [
    ["without egress rules", undefined],
    ["with allowOut/denyOut", { allow: ["www.baidu.com"], subnets: { deny: ["10.0.0.0/8"] } }],
  ];
  for (const [index, [label, networkPolicy]] of closedCases.entries()) {
    await check(
      `allowPublicTraffic: false keeps port URLs closed ${label}, across setNetworkPolicy`,
      async () => {
        const closedContext = sessionContext(`${runId}-closed-${index}`);
        const closed = await closedEnvironment.start(
          closedContext,
          networkPolicy === undefined ? undefined : { networkPolicy },
          closedArtifact,
        );
        try {
          const closedSession = sessionOver(closed.connection);
          const serve = await closedSession.run({
            command: "nohup python3 -m http.server 8080 >/dev/null 2>&1 &",
          });
          assert.equal(serve.exitCode, 0, serve.stderr);
          await assertPortsClosed(closed.state.sandboxId, networkPolicy ?? "allow-all");
          for (const [, policy] of egressUpdates) {
            await closedSession.setNetworkPolicy(policy);
            await assertPortsClosed(closed.state.sandboxId, policy);
          }
        } finally {
          await closedEnvironment.onSessionEnd(closedContext, closed.state, {
            reason: "deleted",
          });
        }
      },
    );
  }

  await check("an abort signal stops a running command", async () => {
    const abort = new AbortController();
    const running = session.run({ command: "sleep 600", signal: abort.signal });
    setTimeout(() => abort.abort(), 1500);
    assert.notEqual((await running).exitCode, 0);
  });

  await check(
    "setNetworkPolicy changes egress mid-session, including header injection",
    async () => {
      const probe = `curl -sS -m 8 -o /dev/null -w '%{http_code}' https://www.baidu.com || true`;
      assert.equal((await session.run({ command: probe })).stdout, "200");
      await session.setNetworkPolicy("deny-all");
      assert.notEqual((await session.run({ command: probe })).stdout, "200");
      await session.setNetworkPolicy({
        allow: { "httpbin.org": [{ transform: [{ headers: { "x-eve-smoke": runId } }] }] },
      });
      assert.notEqual((await session.run({ command: probe })).stdout, "200");
      const echoed = await session.run({ command: "curl -fsS -m 20 https://httpbin.org/headers" });
      if (echoed.exitCode === 0) assert.match(echoed.stdout, new RegExp(runId));
      else console.log("      (httpbin.org unreachable from this region; injection not asserted)");
      await session.setNetworkPolicy("allow-all");
      assert.equal((await session.run({ command: probe })).stdout, "200");
    },
  );

  await check(
    "a second start for the session returns its sandbox, with the env it was created with",
    async () => {
      const again = await implementation.start(
        context,
        { env: { SMOKE_TOKEN: "other" } },
        artifact,
      );
      assert.equal(again.state.sandboxId, state.sandboxId);
      const result = await sessionOver(again.connection).run({
        command: 'printf %s "$SMOKE_TOKEN"',
      });
      assert.equal(result.stdout, "per session");
      assert.deepEqual(await sandboxesOf(context.session.id), [state.sandboxId]);
    },
  );

  await check("resume reconnects to the live sandbox", async () => {
    await session.writeText("work.txt", "in progress\n");
    const again = sessionOver(await implementation.resume(context, artifact, state));
    assert.equal(await again.readText("work.txt"), "in progress\n");
    assert.equal((await again.run({ command: 'printf %s "$SMOKE_TOKEN"' })).stdout, "per session");
  });

  await check(
    "stop releases the compute, and the next access continues with its files",
    async () => {
      await live.stop();
      await assert.rejects(session.run({ command: "echo late" }), /stopped/);
      const next = await access(implementation, context, artifact, state);
      console.log(
        `      ${next.how === "reconnected" ? "resumed by pause" : "restored from checkpoint"}`,
      );
      ({ state, connection: live } = next);
      session = sessionOver(live);
      assert.equal(await session.readText("work.txt"), "in progress\n");
      const result = await session.run({
        command: `printf '%s\\n' "$SMOKE_TOKEN"; eve-tool; echo '{"a":7}' | jq .a`,
      });
      assert.equal(result.stdout, "per session\neve-tool-ok\n7\n");
    },
  );

  await check("a sandbox lost to the provider is reported gone and replaced by start", async () => {
    const lost = state.sandboxId;
    await provider.kill(lost);
    await assert.rejects(
      implementation.resume(context, artifact, state),
      SandboxSessionGoneError.is,
    );
    const next = await access(implementation, context, artifact, state);
    assert.equal(next.how, "started");
    assert.notEqual(next.state.sandboxId, lost);
    ({ state, connection: live } = next);
    session = sessionOver(live);
    const result = await session.run({ command: 'eve-tool; printf %s "$SMOKE_TOKEN"' });
    assert.equal(result.stdout, "eve-tool-ok\nper session");
  });

  await check("idle stops a running sandbox and never wakes a stopped one", async () => {
    await session.writeText("idle.txt", "kept\n");
    await implementation.onSessionIdle?.(context, state, {});
    const status = await provider.getState(state.sandboxId);
    assert.notEqual(status, "running", "the sandbox no longer runs");
    await implementation.onSessionIdle?.(context, state, {});
    assert.equal(await provider.getState(state.sandboxId), status, "a second idle changes nothing");
    const next = await access(implementation, context, artifact, state);
    ({ state, connection: live } = next);
    session = sessionOver(live);
    assert.equal(await session.readText("idle.txt"), "kept\n");
  });

  await check("session end destroys the session's sandboxes", async () => {
    await implementation.onSessionEnd(context, state, { reason: "deleted" });
    assert.deepEqual(await sandboxesOf(context.session.id), []);
  });

  await check("session end without state destroys a stopped session's sandbox", async () => {
    const endedContext = sessionContext(`${runId}-ended`);
    const ended = await implementation.start(endedContext, undefined, artifact);
    await ended.connection.stop();
    await implementation.onSessionEnd(endedContext, null, { reason: "completed" });
    assert.deepEqual(await sandboxesOf(endedContext.session.id), []);
  });

  // Last: known to fail on this account (the `sleep` child outlives the kill).
  await check("spawn streams output, and kill ends the process and its children", async () => {
    const killContext = sessionContext(`${runId}-kill`);
    const killed = await implementation.start(killContext, undefined, artifact);
    try {
      const killSession = sessionOver(killed.connection);
      const proc = await killSession.spawn({ command: "echo ready; sleep 600 & wait" });
      const reader = proc.stdout.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), "ready\n");
      reader.releaseLock();
      await proc.kill();
      await proc.kill();
      assert.notEqual((await proc.wait()).exitCode, 0);
      const left = await killSession.run({ command: `pgrep -af "sleep 600" || echo none` });
      assert.equal(left.stdout.trim(), "none");
    } finally {
      await implementation.onSessionEnd(killContext, killed.state, { reason: "deleted" });
    }
  });

  console.log("ALIYUN SMOKE OK");
} finally {
  const leaked = await provider.findByMetadata({ smokeRun: runId });
  for (const sandboxId of leaked) await provider.kill(sandboxId);
  await rm(cacheDir, { force: true, recursive: true });
  const remaining = await provider.findByMetadata({});
  console.log(
    `cleanup: destroyed ${leaked.length} leftover sandbox(es); ${remaining.length} remain in the account`,
  );
}
