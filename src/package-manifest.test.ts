import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";

/**
 * Aliyun only serves the unversioned E2B routes. e2b releases after 2.31.0
 * create sandboxes through `POST /v2/sandboxes`, which Aliyun answers with 405,
 * so a range here ships a package that cannot create a sandbox. The lockfile
 * hides that locally — consumers resolve the range, not our lockfile.
 */
test("e2b is pinned to the exact version Aliyun's API serves", async () => {
  const manifest = JSON.parse(
    await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };

  expect(manifest.dependencies.e2b).toBe("2.31.0");
});
