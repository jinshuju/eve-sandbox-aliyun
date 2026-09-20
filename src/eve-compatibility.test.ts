import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { SandboxBackend as FloorEveSandboxBackend } from "eve-floor/sandbox";
import type { SandboxBackend as LatestEveSandboxBackend } from "eve/sandbox";
import { aliyun } from "./index.js";

/**
 * The peer range is deliberately wide. These are type-level tests — the
 * annotations are the assertion, so `pnpm typecheck` must run in CI — pinning
 * both ends of the range to real installed packages.
 */
describe("published eve compatibility", () => {
  test("the backend is structurally compatible with the peer range's floor", () => {
    const floorBackend: FloorEveSandboxBackend = aliyun();
    expect(floorBackend.name).toBe("aliyun");
  });

  test("the backend is structurally compatible with the newest verified eve", () => {
    const latestBackend: LatestEveSandboxBackend = aliyun();
    expect(latestBackend.name).toBe("aliyun");
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
