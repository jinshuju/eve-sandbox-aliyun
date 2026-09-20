import { describe, expect, test } from "vitest";
import { aliyun, ALIYUN_BACKEND_NAME } from "./index.js";

describe("aliyun()", () => {
  test("constructs without credentials, so a sandbox module can load at build time", () => {
    const backend = aliyun({ connectionEnv: {} });

    expect(backend.name).toBe(ALIYUN_BACKEND_NAME);
  });

  test("reports missing credentials on first use", async () => {
    const backend = aliyun({ connectionEnv: {} });

    await expect(
      backend.create({ templateKey: null, sessionKey: "s", runtimeContext: { appRoot: "/tmp/x" } }),
    ).rejects.toThrow(/E2B_API_KEY/);
  });
});
