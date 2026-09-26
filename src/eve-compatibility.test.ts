import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { MutableNetworkSandboxSession as FloorSession } from "eve-floor/sandbox";
import {
  defineSandboxProvider as defineFloorProvider,
  type SandboxProviderImplementation as FloorImplementation,
} from "eve-floor/sandbox/provider";
import type { SandboxEnvironment as LatestEnvironment } from "eve/sandbox";
import type { SandboxProviderImplementation as LatestImplementation } from "eve/sandbox/provider";
import { type AliyunSandboxEnvironmentOptions, createAliyunEnvironment } from "./environment.js";
import type { AliyunSandboxPreparedArtifact, AliyunSandboxSessionState } from "./implementation.js";
import { AliyunSandbox } from "./index.js";
import type { AliyunSandboxOpenOptions } from "./options.js";
import type { AliyunSandboxSession as LatestSession } from "./public-session.js";

/**
 * The peer range is `>=floor <1.0.0`. These are type-level tests — the
 * annotations are the assertion, so `pnpm typecheck` must run in CI — pinning
 * both ends of the range to real installed packages.
 *
 * An environment's identity is keyed by `unique symbol`s that each eve copy
 * declares for itself, so the floor is checked at the provider contract below
 * it: the implementation, and the floor's own `defineSandboxProvider`.
 */
describe("published eve compatibility", () => {
  test("the implementation satisfies the peer range's floor", () => {
    const implementation: FloorImplementation<
      AliyunSandboxOpenOptions,
      AliyunSandboxPreparedArtifact,
      AliyunSandboxSessionState,
      FloorSession
    > = createAliyunEnvironment({ connectionEnv: {} });
    const provider = defineFloorProvider<
      AliyunSandboxEnvironmentOptions,
      AliyunSandboxOpenOptions,
      AliyunSandboxPreparedArtifact,
      AliyunSandboxSessionState,
      FloorSession
    >({ name: "aliyun", environment: (options) => createAliyunEnvironment(options) });

    expect(typeof implementation.start).toBe("function");
    expect(provider.environment({ connectionEnv: {} }).provider).toBe("aliyun");
  });

  test("the implementation and environment satisfy the newest verified eve", () => {
    const implementation: LatestImplementation<
      AliyunSandboxOpenOptions,
      AliyunSandboxPreparedArtifact,
      AliyunSandboxSessionState,
      LatestSession
    > = createAliyunEnvironment({ connectionEnv: {} });
    const environment: LatestEnvironment<AliyunSandboxOpenOptions, LatestSession> =
      AliyunSandbox.environment({ connectionEnv: {} });

    expect(typeof implementation.resume).toBe("function");
    expect(environment.provider).toBe("aliyun");
  });

  test("the advertised peer floor is the eve line actually typechecked against", async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { devDependencies: Record<string, string>; peerDependencies: { eve: string } };

    const declaredFloor = /^>=(\d+\.\d+)\.\d+/.exec(packageJson.peerDependencies.eve)?.[1];
    const testedFloor = /^npm:eve@(\d+\.\d+)\.\d+$/.exec(
      packageJson.devDependencies["eve-floor"] ?? "",
    )?.[1];

    expect(declaredFloor).toBeDefined();
    expect(testedFloor).toBe(declaredFloor);
  });
});
