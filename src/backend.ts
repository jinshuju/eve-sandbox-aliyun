import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SandboxBackend, SandboxSeedFile, SandboxSession } from "eve/sandbox";
import { SandboxTemplateNotProvisionedError } from "eve/sandbox";
import {
  ARCHIVE_PATH,
  buildBaseSetupScript,
  buildCaptureScript,
  buildRestoreScript,
  PROBE_USER_SCRIPT,
} from "./archive.js";
import type { AliyunSandboxCreateOptions, AliyunSandboxUseOptions } from "./options.js";
import {
  resolveAliyunSandboxOptions,
  resolveCacheRoot,
  resolveSessionCheckpointPath,
  resolveTemplateArchivePath,
} from "./options.js";
import { translateNetworkPolicy } from "./network-policy.js";
import { resolveSeedPath } from "./paths.js";
import type { Provider, ProviderSandbox } from "./provider.js";
import { buildPublicSession, streamToBytes } from "./public-session.js";
import { createAliyunSession } from "./session.js";

/**
 * Stable backend name. Participates in eve's cache-key derivation and the
 * persisted reconnect state — never change it.
 */
export const ALIYUN_BACKEND_NAME = "aliyun";

/** Sandbox metadata key used to find a session's sandbox without reconnect state. */
const SESSION_KEY_METADATA = "eveSessionKey";
const ROOT = "root";

export interface CreateAliyunSandboxBackendInput {
  readonly createOptions?: AliyunSandboxCreateOptions;
  /**
   * Injectable control plane so backend logic is testable without cloud
   * resources. A factory is called once, on first use.
   */
  readonly provider: Provider | (() => Provider);
}

interface SandboxUser {
  readonly home: string | null;
  readonly name: string;
}

export function createAliyunSandboxBackend(
  input: CreateAliyunSandboxBackendInput,
): SandboxBackend<AliyunSandboxUseOptions, AliyunSandboxUseOptions> {
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

  // Validated up front so a policy the provider cannot express fails at startup.
  const initialNetwork = translateNetworkPolicy(options.networkPolicy);

  function openSession(id: string, sandbox: ProviderSandbox) {
    const internal = createAliyunSession({
      id,
      sandbox,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    const session = buildPublicSession(internal, async (policy) => {
      await sandbox.updateNetwork(translateNetworkPolicy(policy));
    });
    return { internal, session };
  }

  async function useSession(
    session: SandboxSession,
    useOptions?: AliyunSandboxUseOptions,
  ): Promise<SandboxSession> {
    if (useOptions?.networkPolicy !== undefined) {
      await session.setNetworkPolicy(useOptions.networkPolicy);
    }
    return session;
  }

  function createSandbox(metadata: Record<string, string>): Promise<ProviderSandbox> {
    return provider.create({
      template: options.template,
      timeoutMs: options.timeoutMs,
      envs: options.env,
      metadata,
      network: initialNetwork,
    });
  }

  async function writeSeedFiles(
    session: SandboxSession,
    seedFiles: ReadonlyArray<SandboxSeedFile>,
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

  async function reattach(
    sessionKey: string,
    existingMetadata: Record<string, unknown> | undefined,
  ): Promise<ProviderSandbox | null> {
    const persisted = existingMetadata?.sandboxId;
    const candidates = [
      ...(typeof persisted === "string" ? [persisted] : []),
      ...(await provider.findByMetadata({ [SESSION_KEY_METADATA]: sessionKey })),
    ];
    for (const sandboxId of new Set(candidates)) {
      const sandbox = await provider.connect(sandboxId);
      if (sandbox !== null) return sandbox;
    }
    return null;
  }

  return {
    name: ALIYUN_BACKEND_NAME,

    async prewarm({ templateKey, bootstrap, seedFiles, log, runtimeContext }) {
      const cacheRoot = resolveCacheRoot(runtimeContext.appRoot, options.cacheDir);
      const archivePath = resolveTemplateArchivePath(cacheRoot, templateKey, options);
      if (existsSync(archivePath)) return { reused: true };

      log?.(`aliyun: building template ${templateKey} on ${options.template}`);
      const sandbox = await createSandbox({ eveTemplateKey: templateKey });
      try {
        const user = await prepareBaseRuntime(sandbox);
        const { session } = openSession(templateKey, sandbox);
        await writeSeedFiles(session, seedFiles, user);
        if (bootstrap) {
          log?.("aliyun: running sandbox bootstrap");
          await bootstrap({ use: async (useOptions) => await useSession(session, useOptions) });
        }
        log?.("aliyun: capturing template archive");
        await captureArchive(sandbox, archivePath);
      } finally {
        await sandbox.kill().catch(() => {});
      }
      return { reused: false };
    },

    async create({ templateKey, sessionKey, existingMetadata, tags, runtimeContext }) {
      const cacheRoot = resolveCacheRoot(runtimeContext.appRoot, options.cacheDir);
      const checkpointPath = resolveSessionCheckpointPath(cacheRoot, sessionKey);
      let sandbox = await reattach(sessionKey, existingMetadata);
      if (sandbox === null) {
        // A checkpoint already contains the template it grew from, so it wins.
        let archivePath: string | null = existsSync(checkpointPath) ? checkpointPath : null;
        if (archivePath === null && templateKey !== null) {
          archivePath = resolveTemplateArchivePath(cacheRoot, templateKey, options);
          if (!existsSync(archivePath)) {
            throw new SandboxTemplateNotProvisionedError({
              backendName: ALIYUN_BACKEND_NAME,
              templateKey,
            });
          }
        }
        sandbox = await createSandbox({ ...tags, [SESSION_KEY_METADATA]: sessionKey });
        try {
          await prepareBaseRuntime(sandbox);
          if (archivePath !== null) await restoreArchive(sandbox, archivePath);
        } catch (error) {
          await sandbox.kill().catch(() => {});
          throw error;
        }
      }

      const live = sandbox;
      const { internal, session } = openSession(sessionKey, live);
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
        session,
        useSessionFn: async (useOptions) => await useSession(session, useOptions),
        async captureState() {
          return {
            backendName: ALIYUN_BACKEND_NAME,
            metadata: { sandboxId: live.id },
            sessionKey,
          };
        },
        // Stop the compute, keep the session. Accounts with the provider's
        // pause feature keep everything (memory included) provider-side and
        // resume on reconnect. Without it the provider can only destroy a
        // sandbox, so the session's filesystem delta is checkpointed locally
        // first and the next create() restores it into a fresh sandbox.
        async stop() {
          await releaseCompute();
        },
        // Server teardown: eve collects failures itself and must not be blocked.
        async shutdown() {
          await releaseCompute().catch(() => {});
        },
        async delete(deleteOptions) {
          deleteOptions?.abortSignal?.throwIfAborted();
          await internal.killAll();
          await live.kill();
          await rm(checkpointPath, { force: true });
        },
      };
    },
  };
}
