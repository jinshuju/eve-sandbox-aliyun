import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MutableNetworkSandboxSession, SandboxSession } from "eve/sandbox";
import type {
  SandboxPreparedArtifact,
  SandboxProviderHandle,
  SandboxProviderImplementation,
  SandboxProviderResources,
} from "eve/sandbox/provider";
import {
  ARCHIVE_PATH,
  buildBaseSetupScript,
  buildCaptureScript,
  buildRestoreScript,
  PROBE_USER_SCRIPT,
} from "./archive.js";
import type { AliyunSandboxCreateOptions, AliyunSandboxOpenOptions } from "./options.js";
import {
  resolveAliyunSandboxOptions,
  resolveCacheRoot,
  resolveSessionCheckpointPath,
  resolveTemplateArchiveName,
  resolveTemplateArchivePath,
} from "./options.js";
import { translateNetworkPolicy } from "./network-policy.js";
import { resolveSeedPath } from "./paths.js";
import type { Provider, ProviderNetworkConfig, ProviderSandbox } from "./provider.js";
import { buildPublicSession, streamToBytes } from "./public-session.js";
import { createAliyunSession } from "./session.js";

/**
 * Stable provider name. eve records it next to every prepared artifact and
 * every session's state, and refuses to hand either to another name — never
 * change it.
 */
export const ALIYUN_PROVIDER_NAME = "aliyun";

/** Sandbox metadata keys. `pnpm sweep` treats `eveTemplateKey` as disposable. */
const SESSION_KEY_METADATA = "eveSessionKey";
const SESSION_ID_METADATA = "eveSessionId";
const TEMPLATE_KEY_METADATA = "eveTemplateKey";
const ROOT = "root";

/**
 * What `eve build` records for a session to start from: the template archive's
 * file name under `<cacheDir>/templates`, or `null` when there was nothing to
 * seed or prepare. The archive itself stays on disk; only its name travels.
 */
export type AliyunSandboxPreparedArtifact = {
  readonly archive: string | null;
};

/**
 * eve persists this once, when the session's sandbox starts, and hands it back
 * unchanged to every later `resume()`. The sandbox id is only where to look
 * first: a replacement sandbox gets a new id and is found by `sessionKey`.
 */
export interface AliyunSandboxSessionState {
  readonly version: 1;
  readonly sessionKey: string;
  readonly sandboxId: string;
  /** What `open({ env })` added, kept apart from the environment's `env`. */
  readonly env: Readonly<Record<string, string>>;
  /** What `open({ networkPolicy })` asked for, translated; `null` defers to the environment. */
  readonly network: ProviderNetworkConfig | null;
}

export type AliyunSandboxImplementation = SandboxProviderImplementation<
  AliyunSandboxOpenOptions,
  AliyunSandboxPreparedArtifact,
  AliyunSandboxSessionState,
  MutableNetworkSandboxSession
>;

export interface CreateAliyunSandboxImplementationInput {
  readonly createOptions?: AliyunSandboxCreateOptions;
  /**
   * Injectable control plane so provider logic is testable without cloud
   * resources. A factory is called once, on first use.
   */
  readonly provider: Provider | (() => Provider);
}

interface SandboxUser {
  readonly home: string | null;
  readonly name: string;
}

interface SeedFile {
  readonly content: string | Uint8Array;
  readonly path: string;
}

/**
 * Same shape eve reports for "no template for this build" (its own error class
 * is internal), so eve's duck-typed check and the troubleshooting docs agree.
 */
class SandboxTemplateNotProvisionedError extends Error {
  readonly providerName = ALIYUN_PROVIDER_NAME;
  readonly templateKey: string;

  constructor(archive: string, archivePath: string) {
    super(
      `aliyun sandbox: template archive ${archivePath} is missing. \`eve build\` writes it under ` +
        "cacheDir on the machine that builds; re-run the build here, or ship cacheDir with the " +
        "build (or point build and runtime at shared storage).",
    );
    this.name = "SandboxTemplateNotProvisionedError";
    this.templateKey = archive;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isNetworkConfig(value: unknown): value is ProviderNetworkConfig {
  return (
    isRecord(value) &&
    isStringArray(value.allowOut) &&
    isStringArray(value.denyOut) &&
    isRecord(value.rules) &&
    Object.values(value.rules).every(
      (rules) =>
        Array.isArray(rules) &&
        rules.every(
          (rule) =>
            isRecord(rule) && isRecord(rule.transform) && isStringRecord(rule.transform.headers),
        ),
    )
  );
}

function requireArtifact(value: SandboxPreparedArtifact): AliyunSandboxPreparedArtifact {
  if (!isRecord(value) || !(value.archive === null || typeof value.archive === "string")) {
    throw new Error("aliyun sandbox: invalid prepared artifact; rebuild with this provider");
  }
  return { archive: value.archive };
}

function requireState(value: unknown): AliyunSandboxSessionState {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.sessionKey !== "string" ||
    typeof value.sandboxId !== "string" ||
    !isStringRecord(value.env) ||
    !(value.network === null || isNetworkConfig(value.network))
  ) {
    throw new Error("aliyun sandbox: invalid session state; it was not written by this provider");
  }
  return {
    version: 1,
    sessionKey: value.sessionKey,
    sandboxId: value.sandboxId,
    env: value.env,
    network: value.network,
  };
}

/** Where each seeded file lands, `$HOME` still symbolic. */
function seedFilesOf(resources: SandboxProviderResources): SeedFile[] {
  return [resources.workspace, resources.skills].flatMap((tree) =>
    tree === undefined
      ? []
      : tree.files.map((file) => ({
          content: file.content,
          path: `${tree.targetPath}/${file.relativePath}`,
        })),
  );
}

export function createAliyunSandboxImplementation(
  input: CreateAliyunSandboxImplementationInput,
): AliyunSandboxImplementation {
  const options = resolveAliyunSandboxOptions(input.createOptions);
  let resolvedProvider: Provider | undefined;
  const provider: Provider = {
    create: async (createOptions) => await getProvider().create(createOptions),
    connect: async (sandboxId) => await getProvider().connect(sandboxId),
    findByMetadata: async (metadata) => await getProvider().findByMetadata(metadata),
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

  async function prepareBaseRuntime(sandbox: ProviderSandbox): Promise<SandboxUser> {
    const [home = "", name = ""] = (
      await runScript(
        sandbox,
        PROBE_USER_SCRIPT,
        "aliyun sandbox: failed to probe the sandbox user",
      )
    ).split("\n");
    const user = { home: home.startsWith("/") ? home : null, name: name || "user" };
    await runScript(
      sandbox,
      buildBaseSetupScript(user.name),
      "aliyun sandbox: failed to initialize the sandbox base runtime",
      ROOT,
    );
    return user;
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

  function openSession(sandbox: ProviderSandbox, sessionEnv: Readonly<Record<string, string>>) {
    // The environment's env is read on every command, not frozen into the
    // session, so a redeploy with a different env still takes effect.
    const internal = createAliyunSession({
      sandbox,
      env: () => ({ ...options.env, ...sessionEnv }),
      timeoutMs: options.timeoutMs,
    });
    const session = buildPublicSession(internal, async (policy) => {
      await sandbox.updateNetwork(translateNetworkPolicy(policy));
    });
    return { internal, session };
  }

  function createSandbox(
    metadata: Record<string, string>,
    network: ProviderNetworkConfig | null,
  ): Promise<ProviderSandbox> {
    return provider.create({
      template: options.template,
      timeoutMs: options.timeoutMs,
      envs: options.env,
      metadata: { ...options.metadata, ...metadata },
      network: network ?? initialNetwork,
    });
  }

  async function writeSeedFiles(
    session: SandboxSession,
    seedFiles: ReadonlyArray<SeedFile>,
    user: SandboxUser,
  ): Promise<void> {
    for (const seed of seedFiles) {
      const seedPath = resolveSeedPath(seed.path, user.home);
      if (typeof seed.content === "string") {
        await session.writeTextFile({ path: seedPath, content: seed.content });
      } else {
        await session.writeBinaryFile({ path: seedPath, content: seed.content });
      }
    }
  }

  /** The template archive a fresh session sandbox restores, checked before anything is created. */
  function templateArchivePath(
    cacheRoot: string,
    artifact: AliyunSandboxPreparedArtifact,
  ): string | null {
    if (artifact.archive === null) return null;
    const archivePath = resolveTemplateArchivePath(cacheRoot, artifact.archive);
    if (!existsSync(archivePath)) {
      throw new SandboxTemplateNotProvisionedError(artifact.archive, archivePath);
    }
    return archivePath;
  }

  async function createSessionSandbox(
    state: Pick<AliyunSandboxSessionState, "network" | "sessionKey">,
    sessionId: string,
    archivePath: string | null,
  ): Promise<ProviderSandbox> {
    const sandbox = await createSandbox(
      { [SESSION_ID_METADATA]: sessionId, [SESSION_KEY_METADATA]: state.sessionKey },
      state.network,
    );
    try {
      await prepareBaseRuntime(sandbox);
      if (archivePath !== null) await restoreArchive(sandbox, archivePath);
    } catch (error) {
      await sandbox.kill().catch(() => {});
      throw error;
    }
    return sandbox;
  }

  async function reattach(state: AliyunSandboxSessionState): Promise<ProviderSandbox | null> {
    const candidates = [
      state.sandboxId,
      ...(await provider.findByMetadata({ [SESSION_KEY_METADATA]: state.sessionKey })),
    ];
    for (const sandboxId of new Set(candidates)) {
      const sandbox = await provider.connect(sandboxId);
      if (sandbox !== null) return sandbox;
    }
    return null;
  }

  function createHandle(
    live: ProviderSandbox,
    state: AliyunSandboxSessionState,
    checkpointPath: string,
  ): SandboxProviderHandle<MutableNetworkSandboxSession> {
    const { internal, session } = openSession(live, state.env);
    let released: Promise<void> | undefined;
    const releaseCompute = () =>
      (released ??= (async () => {
        await internal.killAll();
        try {
          await live.pause();
          return;
        } catch {
          // Pause is an allow-listed account feature; fall through to a checkpoint.
        }
        await captureArchive(live, checkpointPath);
        await live.kill();
      })().catch((error: unknown) => {
        released = undefined;
        throw error;
      }));
    return {
      sandbox: session,
      // Stop the compute, keep the session. Accounts with the provider's pause
      // feature keep everything (memory included) provider-side and resume on
      // reconnect. Without it the provider can only destroy a sandbox, so the
      // session's filesystem delta is checkpointed locally first and the next
      // resume() restores it into a fresh sandbox.
      async onSessionStop() {
        await releaseCompute();
      },
      // Server teardown: eve collects failures itself and must not be blocked.
      async onRuntimeShutdown() {
        await releaseCompute().catch(() => {});
      },
      async onSessionDelete(deleteOptions) {
        deleteOptions?.abortSignal?.throwIfAborted();
        await internal.killAll();
        await live.kill();
        await rm(checkpointPath, { force: true });
      },
    };
  }

  return {
    async prepare(context) {
      const seedFiles = seedFilesOf(context.resources);
      if (seedFiles.length === 0 && options.prepare === null) return { archive: null };

      const cacheRoot = resolveCacheRoot(context.storagePath, options.cacheDir);
      const archive = resolveTemplateArchiveName(
        {
          sourceRevision: context.sourceRevision,
          resources: {
            skills: context.resources.skills?.key ?? null,
            workspace: context.resources.workspace?.key ?? null,
          },
        },
        options,
      );
      const archivePath = resolveTemplateArchivePath(cacheRoot, archive);
      if (existsSync(archivePath)) {
        context.log?.(`reusing template archive ${archive}`);
        return { archive };
      }

      context.log?.(`building template on ${options.template}`);
      const sandbox = await createSandbox({ [TEMPLATE_KEY_METADATA]: archive }, null);
      try {
        const user = await prepareBaseRuntime(sandbox);
        const { session } = openSession(sandbox, {});
        await writeSeedFiles(session, seedFiles, user);
        if (options.prepare !== null) {
          context.log?.("running sandbox preparation");
          await options.prepare(session);
        }
        context.log?.("capturing template archive");
        await captureArchive(sandbox, archivePath);
      } finally {
        await sandbox.kill().catch(() => {});
      }
      return { archive };
    },

    async start(context, openOptions, artifactValue) {
      const artifact = requireArtifact(artifactValue);
      const network =
        openOptions?.networkPolicy === undefined
          ? null
          : translateNetworkPolicy(openOptions.networkPolicy);
      const cacheRoot = resolveCacheRoot(context.storagePath, options.cacheDir);
      const archivePath = templateArchivePath(cacheRoot, artifact);
      // Unique per start, not per eve session: a start that crashed before eve
      // recorded its state leaves an orphan behind, and a later start or
      // resume must never mistake it for this session's sandbox.
      const sessionKey = `${context.session.id}.${randomUUID()}`;
      const sandbox = await createSessionSandbox(
        { network, sessionKey },
        context.session.id,
        archivePath,
      );
      const state: AliyunSandboxSessionState = {
        version: 1,
        sessionKey,
        sandboxId: sandbox.id,
        env: { ...openOptions?.env },
        network,
      };
      return {
        handle: createHandle(sandbox, state, resolveSessionCheckpointPath(cacheRoot, sessionKey)),
        state,
      };
    },

    // The recorded sandbox when it is still there; otherwise a fresh one
    // restored from the session's checkpoint, which already contains the
    // template it grew from, or failing that from the template. The last case
    // is the idle timeout on an account without pause: files written after the
    // session started are gone, but its env and network policy are not.
    async resume(context, artifactValue, stateValue) {
      const artifact = requireArtifact(artifactValue);
      const state = requireState(stateValue);
      const cacheRoot = resolveCacheRoot(context.storagePath, options.cacheDir);
      const checkpointPath = resolveSessionCheckpointPath(cacheRoot, state.sessionKey);
      let sandbox = await reattach(state);
      if (sandbox === null) {
        const archivePath = existsSync(checkpointPath)
          ? checkpointPath
          : templateArchivePath(cacheRoot, artifact);
        sandbox = await createSessionSandbox(state, context.session.id, archivePath);
      }
      return createHandle(sandbox, state, checkpointPath);
    },
  };
}
