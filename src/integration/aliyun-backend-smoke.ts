/**
 * Contract test against the REAL Aliyun FC Agent Sandbox service.
 *
 *   pnpm smoke        (reads E2B_API_KEY / E2B_API_URL / E2B_DOMAIN from .env.local)
 *
 * It creates billable sandboxes. Every sandbox it creates carries the run id in
 * its metadata and is destroyed in `finally`, and the run ends by listing what
 * is left so a leak is visible rather than silent.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxBackendHandle } from "eve/sandbox";
import { aliyun, createE2bProvider, resolveAliyunConnection } from "../index.js";

const runId = `smoke-${randomUUID().slice(0, 8)}`;
const runtimeContext = { appRoot: process.cwd() };
const provider = createE2bProvider({ connection: resolveAliyunConnection({}) });
const cacheDir = await mkdtemp(path.join(tmpdir(), "eve-aliyun-smoke-"));
const backend = aliyun({ cacheDir, timeoutMs: 10 * 60_000, env: { SMOKE_ENV: "from-backend" } });
const templateKey = `${runId}-template`;
const sessionKey = `${runId}-session`;
const tags = { smokeRun: runId };

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  const startedAt = Date.now();
  await fn();
  console.log(`  ok  ${name} (${Date.now() - startedAt} ms)`);
}

const sandboxIdOf = async (handle: SandboxBackendHandle<never>) =>
  (await handle.captureState()).metadata.sandboxId as string;

try {
  await check("prewarm captures a template, including root-level changes", async () => {
    const result = await backend.prewarm({
      templateKey,
      runtimeContext,
      log: (message) => console.log(`      ${message}`),
      seedFiles: [
        { path: "seed/schema.sql", content: "create table t;\n" },
        { path: "$HOME/.agents/skills/demo/SKILL.md", content: Buffer.from("# demo skill\n") },
      ],
      async bootstrap({ use }) {
        const sandbox = await use();
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
      },
    });
    assert.deepEqual(result, { reused: false });
  });

  await check("prewarm reuses the captured template", async () => {
    assert.deepEqual(await backend.prewarm({ templateKey, runtimeContext, seedFiles: [] }), {
      reused: true,
    });
  });

  let handle = await backend.create({ templateKey, sessionKey, runtimeContext, tags });
  const firstSandboxId = await sandboxIdOf(handle as never);
  let { session } = handle;

  await check(
    "commands run as the unprivileged user, in /workspace, through a login shell",
    async () => {
      const result = await session.run({
        command: `whoami; pwd; shopt -q login_shell && echo login; echo "$SMOKE_ENV"; sudo -n true && echo sudo-ok`,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split("\n"), [
        "user",
        "/workspace",
        "login",
        "from-backend",
        "sudo-ok",
      ]);
    },
  );

  await check(
    "a session starts from the template: seeds, skills, and installed software",
    async () => {
      assert.equal(await session.readTextFile({ path: "seed/schema.sql" }), "create table t;\n");
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
      command: `echo out; echo err >&2; echo "$CALL_ENV"; pwd; exit 7`,
      env: { CALL_ENV: "per-call" },
      workingDirectory: "sub",
    });
    assert.deepEqual(result, {
      exitCode: 7,
      stdout: "out\nper-call\n/workspace/sub\n",
      stderr: "err\n",
    });
  });

  await check("files round-trip byte-exactly, with line ranges and null for missing", async () => {
    const bytes = new Uint8Array([0, 255, 254, 10, 13, 128]);
    await session.writeBinaryFile({ path: "data/blob.bin", content: bytes });
    assert.deepEqual(await session.readBinaryFile({ path: "data/blob.bin" }), bytes);
    await session.writeTextFile({ path: "data/lines.txt", content: "one\ntwo\nthree\n" });
    assert.equal(
      await session.readTextFile({ path: "data/lines.txt", startLine: 2, endLine: 2 }),
      "two\n",
    );
    assert.equal(await session.readTextFile({ path: "data/absent.txt" }), null);
    assert.equal(await session.readBinaryFile({ path: "/nonexistent/x" }), null);
  });

  await check("removePath follows rm semantics", async () => {
    await assert.rejects(session.removePath({ path: "data/absent.txt" }));
    await session.removePath({ path: "data/absent.txt", force: true });
    await assert.rejects(session.removePath({ path: "data" }));
    await session.removePath({ path: "data", recursive: true });
    assert.equal(await session.readTextFile({ path: "data/lines.txt" }), null);
  });

  await check("spawn streams output, and kill ends the process and its children", async () => {
    const proc = await session.spawn({ command: "echo ready; sleep 600 & wait" });
    const reader = proc.stdout.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "ready\n");
    reader.releaseLock();
    await proc.kill();
    await proc.kill();
    assert.notEqual((await proc.wait()).exitCode, 0);
    const left = await session.run({ command: `pgrep -af "sleep 600" || echo none` });
    assert.equal(left.stdout.trim(), "none");
  });

  await check("an abort signal stops a running command", async () => {
    const abort = new AbortController();
    const running = session.run({ command: "sleep 600", abortSignal: abort.signal });
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
      const echoed = await session.run({ command: "curl -sS -m 20 https://httpbin.org/headers" });
      if (echoed.exitCode === 0) assert.match(echoed.stdout, new RegExp(runId));
      else console.log("      (httpbin.org unreachable from this region; injection not asserted)");
      await session.setNetworkPolicy("allow-all");
      assert.equal((await session.run({ command: probe })).stdout, "200");
    },
  );

  await check("use({ env }) reaches later commands and the next turn's handle", async () => {
    await handle.useSessionFn({ env: { SMOKE_TOKEN: "per session" } });
    assert.equal(
      (await session.run({ command: 'printf %s "$SMOKE_TOKEN"' })).stdout,
      "per session",
    );
    const next = await backend.create({
      templateKey,
      sessionKey,
      runtimeContext,
      tags,
      existingMetadata: (await handle.captureState()).metadata,
    });
    const result = await next.session.run({ command: 'printf %s "$SMOKE_TOKEN"' });
    assert.equal(result.stdout, "per session");
  });

  await check("create reattaches to the live sandbox", async () => {
    await session.writeTextFile({ path: "work.txt", content: "in progress\n" });
    const again = await backend.create({
      templateKey,
      sessionKey,
      runtimeContext,
      tags,
      existingMetadata: (await handle.captureState()).metadata,
    });
    assert.equal(await sandboxIdOf(again as never), firstSandboxId);
    const byKeyOnly = await backend.create({ templateKey, sessionKey, runtimeContext, tags });
    assert.equal(await sandboxIdOf(byKeyOnly as never), firstSandboxId);
  });

  await check("stop releases the compute and the session resumes with its state", async () => {
    await handle.stop();
    const stale = session;
    await assert.rejects(async () => await stale.run({ command: "echo late" }), /stopped/);
    handle = await backend.create({
      templateKey,
      sessionKey,
      runtimeContext,
      tags,
      existingMetadata: (await handle.captureState()).metadata,
    });
    session = handle.session;
    const resumedId = await sandboxIdOf(handle as never);
    console.log(
      `      ${resumedId === firstSandboxId ? "resumed by pause" : "restored from checkpoint"}`,
    );
    assert.equal(await session.readTextFile({ path: "work.txt" }), "in progress\n");
    assert.equal(
      (await session.run({ command: 'printf %s "$SMOKE_TOKEN"' })).stdout,
      "per session",
    );
    const result = await session.run({ command: `eve-tool; echo '{"a":7}' | jq .a` });
    assert.equal(result.stdout, "eve-tool-ok\n7\n");
  });

  await check("delete destroys the sandbox for good", async () => {
    await handle.delete();
    assert.deepEqual(await provider.findByMetadata({ eveSessionKey: sessionKey }), []);
  });

  console.log("ALIYUN SMOKE OK");
} finally {
  const leaked = [
    ...(await provider.findByMetadata({ eveSessionKey: sessionKey })),
    ...(await provider.findByMetadata({ eveTemplateKey: templateKey })),
  ];
  for (const sandboxId of leaked) await (await provider.connect(sandboxId))?.kill();
  await rm(cacheDir, { force: true, recursive: true });
  const remaining = await provider.findByMetadata({});
  console.log(
    `cleanup: destroyed ${leaked.length} leftover sandbox(es); ${remaining.length} remain in the account`,
  );
}
