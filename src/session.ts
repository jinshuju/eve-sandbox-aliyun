import type { SandboxProcess } from "eve/sandbox";
import { resolveWorkspacePath, WORKSPACE_ROOT } from "./paths.js";
import { startSandboxProcess } from "./process.js";
import type { ProviderSandbox } from "./provider.js";
import type { InternalSession } from "./public-session.js";
import { streamToBytes } from "./public-session.js";

export const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 60_000;

export interface CreateAliyunSessionInput {
  readonly id: string;
  readonly sandbox: ProviderSandbox;
  /** Environment applied to every command; per-call `env` wins. */
  readonly env: Readonly<Record<string, string>>;
  /** Lifetime the sandbox is reset to on activity. */
  readonly timeoutMs: number;
  readonly keepAliveIntervalMs?: number;
  readonly now?: () => number;
}

/** Internal session plus the lifecycle hook the backend handle needs. */
export type AliyunSession = InternalSession & {
  /** Kills every live process and closes the session to new commands. Idempotent. */
  killAll(): Promise<void>;
};

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function createAliyunSession(input: CreateAliyunSessionInput): AliyunSession {
  const { sandbox } = input;
  const now = input.now ?? Date.now;
  const keepAliveIntervalMs = input.keepAliveIntervalMs ?? DEFAULT_KEEP_ALIVE_INTERVAL_MS;
  const live = new Set<SandboxProcess>();
  let stopped = false;
  let lastKeepAlive: number | undefined;

  /**
   * The provider destroys a sandbox when its lifetime runs out, so activity
   * pushes the deadline back. Best effort: a rejected extension must never
   * fail the operation that triggered it.
   */
  async function keepAlive(): Promise<void> {
    const at = now();
    if (lastKeepAlive !== undefined && at - lastKeepAlive < keepAliveIntervalMs) return;
    lastKeepAlive = at;
    await sandbox.setTimeout(input.timeoutMs).catch(() => {});
  }

  async function spawn(options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<SandboxProcess> {
    if (stopped) throw new Error("aliyun sandbox: session is stopped; refusing to spawn");
    await keepAlive();
    const proc: SandboxProcess = await startSandboxProcess({
      abortSignal: options.abortSignal,
      onExit: () => live.delete(proc),
      start: async (callbacks) =>
        await sandbox.startCommand(
          {
            command: options.command,
            cwd: resolveWorkspacePath(options.workingDirectory ?? WORKSPACE_ROOT),
            envs: { ...input.env, ...options.env },
          },
          callbacks,
        ),
    });
    live.add(proc);
    return proc;
  }

  return {
    id: input.id,
    resolvePath: resolveWorkspacePath,
    spawn,

    async readFile({ path }) {
      await keepAlive();
      return await sandbox.readFile(path);
    },

    async writeFile({ path, content }) {
      await keepAlive();
      await sandbox.writeFile(path, await streamToBytes(content));
    },

    async removePath({ path, force, recursive, abortSignal }) {
      const flags = [force === true ? "-f " : "", recursive === true ? "-r " : ""].join("");
      const proc = await spawn({ command: `rm ${flags}-- ${shellQuote(path)}`, abortSignal });
      const [stderr, { exitCode }] = await Promise.all([streamToBytes(proc.stderr), proc.wait()]);
      if (exitCode !== 0) {
        const detail = new TextDecoder().decode(stderr).trim();
        throw new Error(
          `aliyun sandbox: failed to remove ${path}: ${detail || `exit ${exitCode}`}`,
        );
      }
    },

    async killAll() {
      stopped = true;
      await Promise.all([...live].map(async (proc) => await proc.kill()));
    },
  };
}
