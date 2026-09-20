import type { SandboxBackend } from "eve/sandbox";
import { createAliyunSandboxBackend } from "./backend.js";
import type { AliyunConnectionOptions } from "./connection.js";
import { resolveAliyunConnection } from "./connection.js";
import { createE2bProvider } from "./e2b-provider.js";
import type { AliyunSandboxCreateOptions, AliyunSandboxUseOptions } from "./options.js";

export {
  ALIYUN_BACKEND_NAME,
  createAliyunSandboxBackend,
  type CreateAliyunSandboxBackendInput,
} from "./backend.js";
export { resolveAliyunConnection, type AliyunConnectionOptions } from "./connection.js";
export { createE2bProvider, type AliyunConnection } from "./e2b-provider.js";
export { translateNetworkPolicy } from "./network-policy.js";
export {
  DEFAULT_TEMPLATE,
  DEFAULT_TIMEOUT_MS,
  type AliyunSandboxCreateOptions,
  type AliyunSandboxUseOptions,
} from "./options.js";
export type {
  Provider,
  ProviderCommand,
  ProviderCreateOptions,
  ProviderNetworkConfig,
  ProviderSandbox,
} from "./provider.js";

export interface AliyunSandboxOptions extends AliyunSandboxCreateOptions, AliyunConnectionOptions {
  /** Environment the connection is read from. Defaults to `process.env`. */
  readonly connectionEnv?: Readonly<Record<string, string | undefined>>;
}

/**
 * Creates the Aliyun cloud sandbox (FC Agent Sandbox) backend for
 * `defineSandbox({ backend })`.
 *
 * ```ts
 * // agent/sandbox.ts
 * import { defineSandbox } from "eve/sandbox";
 * import { aliyun } from "@jinshuju/eve-sandbox-aliyun";
 *
 * export default defineSandbox({ backend: aliyun() });
 * ```
 *
 * Credentials are resolved on first use rather than here, so the sandbox
 * module can be imported at build time before the environment is populated.
 */
export function aliyun(
  options: AliyunSandboxOptions = {},
): SandboxBackend<AliyunSandboxUseOptions, AliyunSandboxUseOptions> {
  return createAliyunSandboxBackend({
    createOptions: options,
    provider: () =>
      createE2bProvider({ connection: resolveAliyunConnection(options, options.connectionEnv) }),
  });
}
