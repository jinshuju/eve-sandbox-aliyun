import type { AliyunConnectionOptions } from "./connection.js";
import { resolveAliyunConnection } from "./connection.js";
import { createE2bProvider } from "./e2b-provider.js";
import {
  type AliyunSandboxImplementation,
  createAliyunSandboxImplementation,
} from "./implementation.js";
import type { AliyunSandboxCreateOptions } from "./options.js";

export interface AliyunSandboxEnvironmentOptions
  extends AliyunSandboxCreateOptions, AliyunConnectionOptions {
  /** Environment the connection is read from. Defaults to `process.env`. */
  readonly connectionEnv?: Readonly<Record<string, string | undefined>>;
}

/**
 * The implementation behind `AliyunSandbox.environment()`. eve calls this when
 * the sandbox module loads, so credentials are resolved on first use instead:
 * the module has to import at build time before the environment is populated.
 */
export function createAliyunEnvironment(
  options: AliyunSandboxEnvironmentOptions = {},
): AliyunSandboxImplementation {
  return createAliyunSandboxImplementation({
    createOptions: options,
    provider: () =>
      createE2bProvider({ connection: resolveAliyunConnection(options, options.connectionEnv) }),
  });
}
