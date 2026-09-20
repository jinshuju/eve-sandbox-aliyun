/**
 * The narrow slice of the cloud sandbox API this backend depends on. The E2B
 * SDK sits behind it (`src/e2b-provider.ts`) so backend logic is unit-testable
 * without creating cloud resources.
 */

export interface ProviderCommandCallbacks {
  onStdout(chunk: string): void;
  onStderr(chunk: string): void;
}

export interface ProviderCommand {
  readonly pid: number;
  /** Resolves with the exit code, nonzero included. Rejects only on transport failure. */
  wait(): Promise<{ exitCode: number }>;
  /** Kills the process and its children. */
  kill(): Promise<void>;
}

export interface ProviderStartCommandOptions {
  /** Run through the sandbox's login shell (`bash -l -c`). */
  readonly command: string;
  readonly cwd?: string;
  readonly envs?: Readonly<Record<string, string>>;
  /** Sandbox OS user; the template's default user when omitted. */
  readonly user?: string;
}

export interface ProviderSandbox {
  readonly id: string;
  /** Starts a command with no provider-side time limit. */
  startCommand(
    options: ProviderStartCommandOptions,
    callbacks: ProviderCommandCallbacks,
  ): Promise<ProviderCommand>;
  /** `null` when the file does not exist. */
  readFile(path: string, user?: string): Promise<ReadableStream<Uint8Array> | null>;
  /** Creates parent directories and overwrites. */
  writeFile(path: string, content: Uint8Array, user?: string): Promise<void>;
  /** Resets the sandbox's remaining lifetime to `timeoutMs` from now. */
  setTimeout(timeoutMs: number): Promise<void>;
  /** Suspends the sandbox, preserving its state. Rejects where the account lacks the feature. */
  pause(): Promise<void>;
  /** Destroys the sandbox. Succeeds when it is already gone. */
  kill(): Promise<void>;
}

export interface ProviderCreateOptions {
  readonly template: string;
  readonly timeoutMs: number;
  readonly envs?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly allowInternetAccess?: boolean;
}

export interface Provider {
  create(options: ProviderCreateOptions): Promise<ProviderSandbox>;
  /** Reattaches to (and resumes) a sandbox; `null` when it no longer exists. */
  connect(sandboxId: string): Promise<ProviderSandbox | null>;
  /** Ids of live sandboxes whose metadata contains every given pair. */
  findByMetadata(metadata: Readonly<Record<string, string>>): Promise<string[]>;
}
