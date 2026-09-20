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
