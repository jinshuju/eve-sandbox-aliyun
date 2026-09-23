import { describe, expect, test } from "vitest";
import { createAliyunEnvironment } from "./environment.js";
import { ALIYUN_PROVIDER_NAME, AliyunSandbox } from "./index.js";
import { sessionContext } from "./testing/eve-context.js";

describe("AliyunSandbox", () => {
  test("an environment constructs without credentials, so a sandbox module can load at build time", () => {
    const environment = AliyunSandbox.environment({ connectionEnv: {} });

    expect(AliyunSandbox.name).toBe(ALIYUN_PROVIDER_NAME);
    expect(environment.provider).toBe(ALIYUN_PROVIDER_NAME);
  });

  test("an environment policy the provider cannot express fails when the module loads", () => {
    expect(() =>
      AliyunSandbox.environment({
        connectionEnv: {},
        networkPolicy: { allow: { "a.example.com": [{ forwardURL: "https://proxy.example" }] } },
      }),
    ).toThrow(/forwardURL/);
  });

  test("open() belongs to eve's defineSandbox() selector", async () => {
    await expect(AliyunSandbox.environment({ connectionEnv: {} }).open()).rejects.toThrow(
      /defineSandbox/,
    );
  });
});

describe("createAliyunEnvironment", () => {
  test("reports missing credentials on first use", async () => {
    const implementation = createAliyunEnvironment({ connectionEnv: {} });

    await expect(
      implementation.start(sessionContext(), undefined, { archive: null }),
    ).rejects.toThrow(/E2B_API_KEY/);
  });
});
