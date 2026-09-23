import type { MutableNetworkSandboxSession } from "eve/sandbox";
import { defineSandboxProvider } from "eve/sandbox/provider";
import { type AliyunSandboxEnvironmentOptions, createAliyunEnvironment } from "./environment.js";
import {
  ALIYUN_PROVIDER_NAME,
  type AliyunSandboxPreparedArtifact,
  type AliyunSandboxSessionState,
} from "./implementation.js";
import type { AliyunSandboxOpenOptions } from "./options.js";

export type { AliyunSandboxEnvironmentOptions } from "./environment.js";
export {
  ALIYUN_PROVIDER_NAME,
  createAliyunSandboxImplementation,
  type AliyunSandboxImplementation,
  type AliyunSandboxPreparedArtifact,
  type AliyunSandboxSessionState,
  type CreateAliyunSandboxImplementationInput,
} from "./implementation.js";
export { resolveAliyunConnection, type AliyunConnectionOptions } from "./connection.js";
export { createE2bProvider, type AliyunConnection } from "./e2b-provider.js";
export { translateNetworkPolicy } from "./network-policy.js";
export {
  DEFAULT_TEMPLATE,
  DEFAULT_TIMEOUT_MS,
  type AliyunSandboxCreateOptions,
  type AliyunSandboxOpenOptions,
} from "./options.js";
export type {
  Provider,
  ProviderCommand,
  ProviderCreateOptions,
  ProviderNetworkConfig,
  ProviderSandbox,
} from "./provider.js";

/**
 * The Aliyun cloud sandbox (FC Agent Sandbox) provider for eve.
 *
 * ```ts
 * // agent/sandbox.ts
 * import { defineSandbox } from "eve/sandbox";
 * import { AliyunSandbox } from "@jinshuju/eve-sandbox-aliyun";
 *
 * export const environment = AliyunSandbox.environment();
 * export default defineSandbox(() => environment.open());
 * ```
 *
 * Credentials are resolved on first use rather than when the environment is
 * created, so the sandbox module can be imported at build time before the
 * environment is populated.
 */
export const AliyunSandbox = defineSandboxProvider<
  AliyunSandboxEnvironmentOptions,
  AliyunSandboxOpenOptions,
  AliyunSandboxPreparedArtifact,
  AliyunSandboxSessionState,
  MutableNetworkSandboxSession
>({
  name: ALIYUN_PROVIDER_NAME,
  environment: (options) => createAliyunEnvironment(options),
});
