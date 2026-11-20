import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SANDBOX_AGENT_ENV,
  SandboxSessionGoneError,
  SandboxTemplateNotProvisionedError,
  type SandboxJson,
  type SandboxProviderImplementation,
} from "eve/sandbox/provider";
import {
  ARCHIVE_PATH,
  buildBaseSetupScript,
  buildCaptureScript,
  buildRestoreScript,
  PROBE_USER_SCRIPT,
  STATE_DIR,
} from "./archive.js";
import { translateNetworkPolicy } from "./network-policy.js";
import type { AliyunSandboxCreateOptions, AliyunSandboxOpenOptions } from "./options.js";
import {
  resolveAliyunSandboxOptions,
  resolveCacheRoot,
  resolveSessionCheckpointPath,
  resolveTemplateArchiveName,
  resolveTemplateArchivePath,
} from "./options.js";
import type { Provider, ProviderNetworkConfig, ProviderSandbox } from "./provider.js";
import {
  type AliyunConnection,
  type AliyunSandboxExtensions,
  createAliyunConnection,
} from "./session.js";
import { streamToBytes } from "./streams.js";

/**
 * Stable provider name. eve records it next to every prepared artifact and
 * every session's state, and refuses to hand either to another name — never
 * change it.
 */
export const ALIYUN_PROVIDER_NAME = "aliyun";

/**
 * Sandbox metadata keys. A session's sandbox is found by `eveSessionId`;
 * `pnpm sweep` treats `eveTemplateKey` as disposable. `eveSessionKey` is what
 * 0.4 labelled sandboxes with, read only to clean those up.
 */
const SESSION_ID_METADATA = "eveSessionId";
const LEGACY_SESSION_KEY_METADATA = "eveSessionKey";
const TEMPLATE_KEY_METADATA = "eveTemplateKey";
const ROOT = "root";

/**
 * Written last when a session's sandbox is created, so it marks the sandbox as
 * ready, and holds what that creation applied: a start that finds the sandbox
 * adopts its env from here, not from its own `open()` options. Under
 * `STATE_DIR`, so no checkpoint carries it into another sandbox.
 */
const SESSION_FILE = `${STATE_DIR}/session.json`;

/** Bump when a template archive built by an older version can no longer be restored. */
const ARCHIVE_FORMAT = 1;

/**
 * What `eve build` records for a session to start from: the template archive's
 * file name under `<cacheDir>/templates`, or `null` when there was nothing to
 * seed or prepare. The archive itself stays on disk; only its name travels.
 */
export type AliyunSandboxPreparedArtifact = {
  readonly archive: string | null;
};

/**
 * eve persists this when the session's sandbox starts and hands it to every
 * later `resume()`. A type, not an interface, so it is assignable to eve's
 * JSON type.
 */
export type AliyunSandboxSessionState = {
  readonly version: 2;
  readonly sandboxId: string;
  /** The env the session's sandbox was created with (`open({ env })`). */
  readonly env: Readonly<Record<string, string>>;
};

/** What 0.4 recorded. Still accepted, so sessions in flight across the upgrade keep working. */
type LegacySessionState = {
  readonly version: 1;
  readonly sessionKey: string;
  readonly sandboxId: string;
  readonly env: Readonly<Record<string, string>>;
};

export type AliyunSandboxImplementation = SandboxProviderImplementation<
  AliyunSandboxOpenOptions,
  AliyunSandboxPreparedArtifact,
  AliyunSandboxSessionState,
  AliyunSandboxExtensions
>;

export interface CreateAliyunSandboxImplementationInput {
  readonly createOptions?: AliyunSandboxCreateOptions;
  /**
   * Injectable control plane so provider logic is testable without cloud
   * resources. A factory is called once, on first use.
   */
  readonly provider: Provider | (() => Provider);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function requireArtifact(value: SandboxJson): AliyunSandboxPreparedArtifact {
  if (!isRecord(value) || !(value.archive === null || typeof value.archive === "string")) {
    throw new Error("aliyun sandbox: invalid prepared artifact; rebuild with this provider");
  }
  return { archive: value.archive };
}

function requireState(value: unknown): AliyunSandboxSessionState | LegacySessionState {
  if (isRecord(value) && typeof value.sandboxId === "string" && isStringRecord(value.env)) {
    if (value.version === 2) return { version: 2, sandboxId: value.sandboxId, env: value.env };
    if (value.version === 1 && typeof value.sessionKey === "string") {
      return {
        version: 1,
        sessionKey: value.sessionKey,
        sandboxId: value.sandboxId,
        env: value.env,
      };
    }
  }
  throw new Error("aliyun sandbox: invalid session state; it was not written by this provider");
}

export function createAliyunSandboxImplementation(
  input: CreateAliyunSandboxImplementationInput,
): AliyunSandboxImplementation {
  const options = resolveAliyunSandboxOptions(input.createOptions);
  let resolvedProvider: Provider | undefined;
  const provider: Provider = {
    create: async (createOptions) => await getProvider().create(createOptions),
    connect: async (sandboxId) => await getProvider().connect(sandboxId),
    getState: async (sandboxId) => await getProvider().getState(sandboxId),
    findByMetadata: async (metadata) => await getProvider().findByMetadata(metadata),
    kill: async (sandboxId) => await getProvider().kill(sandboxId),
  };
  function getProvider(): Provider {
    return (resolvedProvider ??=
      typeof input.provider === "function" ? input.provider() : input.provider);
  }

  async function runScript(
    sandbox: ProviderSandbox,
    script: string,
    failureMessage: string,
    user?: string,
  ): Promise<string> {
    let stdout = "";
    let stderr = "";
    const command = await sandbox.startCommand(
      { command: script, user },
      { onStdout: (chunk) => (stdout += chunk), onStderr: (chunk) => (stderr += chunk) },
    );
    const { exitCode } = await command.wait();
    if (exitCode !== 0) {
      const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      throw new Error(`${failureMessage} (exit ${exitCode})${detail ? `\n${detail}` : ""}`);
    }
    return stdout;
  }

  async function prepareBaseRuntime(sandbox: ProviderSandbox): Promise<void> {
    const [, name = ""] = (
      await runScript(
        sandbox,
        PROBE_USER_SCRIPT,
        "aliyun sandbox: failed to probe the sandbox user",
      )
    ).split("\n");
    await runScript(
      sandbox,
      buildBaseSetupScript(name || "user"),
      "aliyun sandbox: failed to initialize the sandbox base runtime",
      ROOT,
    );
  }

  async function captureArchive(sandbox: ProviderSandbox, targetPath: string): Promise<void> {
    await runScript(sandbox, buildCaptureScript(), "aliyun sandbox: failed to capture state", ROOT);
    const stream = await sandbox.readFile(ARCHIVE_PATH, ROOT);
    if (stream === null) throw new Error("aliyun sandbox: captured archive is missing");
    await mkdir(path.dirname(targetPath), { recursive: true });
    const stagingPath = `${targetPath}.staging-${randomUUID()}`;
    try {
      await writeFile(stagingPath, await streamToBytes(stream));
      await rename(stagingPath, targetPath);
    } finally {
      await rm(stagingPath, { force: true });
    }
  }

  async function restoreArchive(sandbox: ProviderSandbox, sourcePath: string): Promise<void> {
    await sandbox.writeFile(ARCHIVE_PATH, await readFile(sourcePath), ROOT);
    await runScript(sandbox, buildRestoreScript(), "aliyun sandbox: failed to restore state", ROOT);
  }

  // Validated up front so a policy the provider cannot express fails when the
  // sandbox module loads, not in the middle of a session.
  const initialNetwork = translateNetworkPolicy(options.networkPolicy);

  function createSandbox(
    metadata: Record<string, string>,
    network: ProviderNetworkConfig | null,
  ): Promise<ProviderSandbox> {
    return provider.create({
      template: options.template,
      timeoutMs: options.timeoutMs,
      envs: { ...SANDBOX_AGENT_ENV, ...options.env },
      metadata: { ...options.metadata, ...metadata },
      network: network ?? initialNetwork,
      ...(options.allowPublicTraffic === undefined
        ? {}
        : { allowPublicTraffic: options.allowPublicTraffic }),
    });
  }

  /**
   * Stop the compute, keep the files. Accounts with the provider's pause
   * feature keep everything (memory included) provider-side, and the next
   * `resume()` reconnects. Without it the provider can only destroy a sandbox,
   * so its filesystem delta is checkpointed locally first; `resume()` then
   * finds the sandbox gone, and the `start()` eve runs next restores the
   * checkpoint.
   */
  async function releaseCompute(live: ProviderSandbox, checkpointPath: string): Promise<void> {
    try {
      await live.pause();
      return;
    } catch {
      // Pause is an allow-listed account feature; fall through to a checkpoint.
    }
    await captureArchive(live, checkpointPath);
    await live.kill();
  }

  // A release still capturing in this process would publish its checkpoint
  // after session end removed it, so session end waits for it.
  const releases = new Map<string, Promise<void>>();
  function trackRelease(sessionId: string, release: () => Promise<void>): Promise<void> {
    const pending = release();
    releases.set(sessionId, pending);
    const forget = () => {
      if (releases.get(sessionId) === pending) releases.delete(sessionId);
    };
    pending.then(forget, forget);
    return pending;
  }

  function openConnection(
    live: ProviderSandbox,
    sessionEnv: Readonly<Record<string, string>>,
    release: () => Promise<void>,
  ): AliyunConnection {
    return createAliyunConnection({
      sandbox: live,
      // The environment's env is read on every command, not frozen into the
      // session, so a redeploy with a different env still takes effect.
      env: () => ({ ...options.env, ...sessionEnv }),
      timeoutMs: options.timeoutMs,
      setNetworkPolicy: async (policy) => {
        await live.updateNetwork(translateNetworkPolicy(policy));
      },
      release,
    });
  }

  function sessionConnection(
    live: ProviderSandbox,
    sessionId: string,
    sessionEnv: Readonly<Record<string, string>>,
    checkpointPath: string,
  ): AliyunConnection {
    return openConnection(live, sessionEnv, () =>
      trackRelease(sessionId, () => releaseCompute(live, checkpointPath)),
    );
  }

  /** The template archive a fresh session sandbox restores, checked before anything is created. */
  function templateArchivePath(
    cacheRoot: string,
    artifact: AliyunSandboxPreparedArtifact,
  ): string | null {
    if (artifact.archive === null) return null;
    const archivePath = resolveTemplateArchivePath(cacheRoot, artifact.archive);
    if (!existsSync(archivePath)) {
      throw new SandboxTemplateNotProvisionedError({
        providerName: ALIYUN_PROVIDER_NAME,
        reason:
          `template archive ${archivePath} is missing. \`eve build\` writes it under cacheDir on ` +
          "the machine that builds; re-run the build here, or ship cacheDir with the build (or " +
          "point build and runtime at shared storage).",
        templateKey: artifact.archive,
      });
    }
    return archivePath;
  }

  /** The env a ready sandbox was created with; `null` while it is not ready. */
  async function readSessionFile(
    live: ProviderSandbox,
  ): Promise<Readonly<Record<string, string>> | null> {
    const stream = await live.readFile(SESSION_FILE, ROOT).catch(() => null);
    if (stream === null) return null;
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(await streamToBytes(stream)));
      return isRecord(value) && isStringRecord(value.env) ? value.env : null;
    } catch {
      return null;
    }
  }

  /**
   * A ready sandbox of this session, if one exists. Ids are tried in order, so
   * callers that see the same sandboxes pick the same one. One still being
   * created (no session file yet) is never adopted: a start that crashed half
   * way must not hand out a half-restored sandbox. Session end destroys it.
   */
  async function adopt(
    sessionId: string,
  ): Promise<{ live: ProviderSandbox; env: Readonly<Record<string, string>> } | null> {
    const ids = await provider.findByMetadata({ [SESSION_ID_METADATA]: sessionId });
    for (const sandboxId of [...ids].sort()) {
      const live = await provider.connect(sandboxId);
      if (live === null) continue;
      const env = await readSessionFile(live);
      if (env !== null) return { live, env };
    }
    return null;
  }

  async function createSessionSandbox(
    sessionId: string,
    network: ProviderNetworkConfig | null,
    archivePath: string | null,
    env: Readonly<Record<string, string>>,
  ): Promise<ProviderSandbox> {
    const sandbox = await createSandbox({ [SESSION_ID_METADATA]: sessionId }, network);
    try {
      await prepareBaseRuntime(sandbox);
      if (archivePath !== null) await restoreArchive(sandbox, archivePath);
      await sandbox.writeFile(
        SESSION_FILE,
        new TextEncoder().encode(JSON.stringify({ env })),
        ROOT,
      );
    } catch (error) {
      await sandbox.kill().catch(() => {});
      throw error;
    }
    return sandbox;
  }

  /** Every sandbox the session may own: the recorded one and any labelled with it. */
  async function sessionSandboxIds(
    sessionId: string,
    state: AliyunSandboxSessionState | LegacySessionState | null,
    failures: unknown[],
  ): Promise<string[]> {
    const lookups: Array<Record<string, string>> = [{ [SESSION_ID_METADATA]: sessionId }];
    if (state?.version === 1) lookups.push({ [LEGACY_SESSION_KEY_METADATA]: state.sessionKey });
    const found = await Promise.all(
      lookups.map((metadata) =>
        provider.findByMetadata(metadata).catch((error: unknown) => {
          failures.push(error);
          return [];
        }),
      ),
    );
    return [...new Set([...(state === null ? [] : [state.sandboxId]), ...found.flat()])];
  }

  return {
    async prepare(context) {
      if (context.isEmpty) return { archive: null };

      const cacheRoot = resolveCacheRoot(context.storagePath, options.cacheDir);
      // eve's key covers the seeds, the authored prepare and the sandbox file.
      const archive = resolveTemplateArchiveName(
        context.templateKey({
          archiveFormat: ARCHIVE_FORMAT,
          env: options.env,
          template: options.template,
        }),
      );
      const archivePath = resolveTemplateArchivePath(cacheRoot, archive);
      if (existsSync(archivePath)) {
        context.log(`reusing template archive ${archive}`);
        return { archive };
      }

      context.log(`building template on ${options.template}`);
      const sandbox = await createSandbox({ [TEMPLATE_KEY_METADATA]: archive }, null);
      try {
        await prepareBaseRuntime(sandbox);
        context.log("seeding files and running sandbox preparation");
        await context.populate(openConnection(sandbox, {}, async () => {}));
        context.log("capturing template archive");
        await captureArchive(sandbox, archivePath);
      } finally {
        await sandbox.kill().catch(() => {});
      }
      return { archive };
    },

    // eve asks for the session's sandbox, creating it only when none exists:
    // a prewarm and the first turn may both call this, from different
    // processes. The sandbox is found by its session label, and the options
    // apply only when this call creates it. A sandbox lost to the idle timeout
    // or released by a checkpoint comes back here (resume() reports it gone),
    // and is restored from the session's checkpoint, else from the template.
    async start(context, openOptions, artifactValue) {
      const artifact = requireArtifact(artifactValue);
      const sessionId = context.session.id;
      const cacheRoot = resolveCacheRoot(context.storagePath, options.cacheDir);
      const checkpointPath = resolveSessionCheckpointPath(cacheRoot, sessionId);

      const adopted = await adopt(sessionId);
      if (adopted !== null) {
        return {
          connection: sessionConnection(adopted.live, sessionId, adopted.env, checkpointPath),
          state: { version: 2, sandboxId: adopted.live.id, env: adopted.env },
        };
      }

      const network =
        openOptions?.networkPolicy === undefined
          ? null
          : translateNetworkPolicy(openOptions.networkPolicy);
      const env = { ...openOptions?.env };
      const archivePath = existsSync(checkpointPath)
        ? checkpointPath
        : templateArchivePath(cacheRoot, artifact);
      const live = await createSessionSandbox(sessionId, network, archivePath, env);
      return {
        connection: sessionConnection(live, sessionId, env, checkpointPath),
        state: { version: 2, sandboxId: live.id, env },
      };
    },

    // Reconnects (resuming a paused sandbox) and never recreates: a sandbox
    // that is gone is reported so, and eve starts the session's next one.
    async resume(context, _artifact, stateValue) {
      const state = requireState(stateValue);
      const sessionId = context.session.id;
      const cacheRoot = resolveCacheRoot(context.storagePath, options.cacheDir);
      const checkpointPath = resolveSessionCheckpointPath(cacheRoot, sessionId);
      const candidates =
        state.version === 1
          ? [
              state.sandboxId,
              ...(await provider.findByMetadata({
                [LEGACY_SESSION_KEY_METADATA]: state.sessionKey,
              })),
            ]
          : [state.sandboxId];
      for (const sandboxId of new Set(candidates)) {
        const live = await provider.connect(sandboxId);
        if (live !== null) return sessionConnection(live, sessionId, state.env, checkpointPath);
      }
      if (state.version === 1) {
        // 0.4 kept the checkpoint under the start's session key; carry it over
        // so the start that follows restores it.
        const legacyPath = resolveSessionCheckpointPath(cacheRoot, state.sessionKey);
        if (existsSync(legacyPath) && !existsSync(checkpointPath)) {
          await rename(legacyPath, checkpointPath);
        }
      }
      throw new SandboxSessionGoneError(
        `aliyun sandbox: session ${sessionId}'s sandbox ${state.sandboxId} no longer exists`,
      );
    },

    // eve calls this once the session has been idle for `idleTimeoutMs`. Only
    // the session's own sandbox is released — the recorded one, else the first
    // running one by id, as start() would pick — since each release writes the
    // session's one checkpoint. Another sandbox a create race left is session
    // end's to destroy. A paused sandbox is left alone: connecting would resume it.
    async onSessionIdle(context, stateValue, idleOptions) {
      const sessionId = context.session.id;
      const state = stateValue === null ? null : requireState(stateValue);
      const cacheRoot = resolveCacheRoot(context.storagePath, options.cacheDir);
      let sandboxId = state?.sandboxId;
      if (sandboxId === undefined) {
        const ids = await provider.findByMetadata({ [SESSION_ID_METADATA]: sessionId });
        for (const id of [...ids].sort()) {
          if ((await provider.getState(id)) === "running") {
            sandboxId = id;
            break;
          }
        }
        if (sandboxId === undefined) return;
      }
      idleOptions.signal?.throwIfAborted();
      if ((await provider.getState(sandboxId)) !== "running") return;
      const live = await provider.connect(sandboxId);
      if (live === null) return;
      await trackRelease(sessionId, () =>
        releaseCompute(live, resolveSessionCheckpointPath(cacheRoot, sessionId)),
      );
    },

    // After the session's terminal outcome, and for `sandbox.delete()`. Kills
    // by id, so it never resumes a paused sandbox. eve retries the step, so
    // every sandbox is attempted and the checkpoint is kept until all of them
    // are gone.
    async onSessionEnd(context, stateValue, endOptions) {
      endOptions.signal?.throwIfAborted();
      const sessionId = context.session.id;
      const state = stateValue === null ? null : requireState(stateValue);
      const cacheRoot = resolveCacheRoot(context.storagePath, options.cacheDir);
      await releases.get(sessionId)?.catch(() => {});
      const failures: unknown[] = [];
      const ids = await sessionSandboxIds(sessionId, state, failures);
      const kills = await Promise.allSettled(ids.map((id) => provider.kill(id)));
      for (const kill of kills) if (kill.status === "rejected") failures.push(kill.reason);
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "aliyun sandbox: could not destroy the session's sandboxes",
        );
      }
      await rm(resolveSessionCheckpointPath(cacheRoot, sessionId), { force: true });
      if (state?.version === 1) {
        await rm(resolveSessionCheckpointPath(cacheRoot, state.sessionKey), { force: true });
      }
    },
  };
}
