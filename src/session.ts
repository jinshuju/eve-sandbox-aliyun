import type { SandboxNetworkPolicy, SandboxProcess, SandboxSession } from "eve/sandbox";
import type { SandboxConnection } from "eve/sandbox/provider";
import { startSandboxProcess } from "./process.js";
import type { ProviderSandbox } from "./provider.js";
import { streamToBytes } from "./streams.js";

export const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 60_000;

/** What this provider adds to eve's sandbox session: its firewall is mutable. */
export type AliyunSandboxExtensions = {
  /** Applies a firewall policy to the live sandbox. */
  readonly setNetworkPolicy: (policy: SandboxNetworkPolicy) => Promise<void>;
};

/** The session eve builds over this provider's connection, as authored code receives it. */
export type AliyunSandboxSession = SandboxSession & AliyunSandboxExtensions;

export interface CreateAliyunConnectionInput {
  readonly sandbox: ProviderSandbox;
  /** Environment applied to every command, read at spawn time; per-call `env` wins. */
  readonly env: () => Readonly<Record<string, string>>;
  /** Lifetime the sandbox is reset to on activity. */
  readonly timeoutMs: number;
  readonly setNetworkPolicy: (policy: SandboxNetworkPolicy) => Promise<void>;
  /** Releases the compute; `stop()` runs it once the session's processes are killed. */
  readonly release: () => Promise<void>;
  readonly keepAliveIntervalMs?: number;
  readonly now?: () => number;
}

/** eve's connection, plus what the provider's lifecycle needs from it. */
export type AliyunConnection = SandboxConnection<AliyunSandboxExtensions> & {
  /** Kills every live process and closes the connection to new work. Idempotent. */
  killAll(): Promise<void>;
};

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function createAliyunConnection(input: CreateAliyunConnectionInput): AliyunConnection {
  const { sandbox } = input;
  const now = input.now ?? Date.now;
  const keepAliveIntervalMs = input.keepAliveIntervalMs ?? DEFAULT_KEEP_ALIVE_INTERVAL_MS;
  const live = new Set<SandboxProcess>();
  // Spawns still starting: a stop waits for them, so none starts after it.
  const starting = new Set<Promise<unknown>>();
  let closed = false;
  let lastKeepAlive: number | undefined;
  let stopping: Promise<void> | undefined;

  function admit(signal: AbortSignal | undefined): void {
    signal?.throwIfAborted();
    if (closed) throw new Error("aliyun sandbox: the sandbox is stopped; open it again");
  }

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
    readonly command: string;
    readonly workingDirectory: string;
    readonly env: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
    readonly stdin?: boolean;
  }): Promise<SandboxProcess> {
    admit(options.signal);
    // The SDK delivers output only; it has no stream for a process's stdin.
    if (options.stdin === true) throw new Error("aliyun sandbox: spawn does not support stdin");
    const started = startProcess(options);
    starting.add(started);
    try {
      return await started;
    } finally {
      starting.delete(started);
    }
  }

  async function startProcess(options: {
    readonly command: string;
    readonly workingDirectory: string;
    readonly env: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): Promise<SandboxProcess> {
    await keepAlive();
    const proc: SandboxProcess = await startSandboxProcess({
      abortSignal: options.signal,
      onExit: () => live.delete(proc),
      start: async (callbacks) =>
        await sandbox.startCommand(
          {
            command: options.command,
            cwd: options.workingDirectory,
            envs: { ...input.env(), ...options.env },
          },
          callbacks,
        ),
    });
    live.add(proc);
    return proc;
  }

  async function killAll(): Promise<void> {
    closed = true;
    await Promise.allSettled(starting);
    await Promise.all([...live].map(async (proc) => await proc.kill()));
  }

  return {
    spawn,

    async readFile({ path, signal }) {
      admit(signal);
      await keepAlive();
      return await sandbox.readFile(path);
    },

    async writeFiles({ files, signal }) {
      admit(signal);
      await keepAlive();
      for (const file of files) {
        signal?.throwIfAborted();
        await sandbox.writeFile(file.path, file.content);
      }
    },

    async removePath({ path, force, recursive, signal }) {
      const flags = [force === true ? "-f " : "", recursive === true ? "-r " : ""].join("");
      const proc = await spawn({
        command: `rm ${flags}-- ${shellQuote(path)}`,
        env: {},
        signal,
        workingDirectory: "/",
      });
      const [stderr, { exitCode }] = await Promise.all([streamToBytes(proc.stderr), proc.wait()]);
      if (exitCode !== 0) {
        const detail = new TextDecoder().decode(stderr).trim();
        throw new Error(
          `aliyun sandbox: failed to remove ${path}: ${detail || `exit ${exitCode}`}`,
        );
      }
    },

    // Kill the session's processes, then release the compute. A second stop,
    // or one after the sandbox is gone, is a no-op; a failed one can be retried.
    async stop() {
      stopping ??= (async () => {
        await killAll();
        await input.release();
      })().catch((error: unknown) => {
        stopping = undefined;
        throw error;
      });
      await stopping;
    },

    extensions: { setNetworkPolicy: input.setNetworkPolicy },
    killAll,
  };
}
