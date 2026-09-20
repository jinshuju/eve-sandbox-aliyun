import { describe, expect, test } from "vitest";
import { resolveAliyunConnection } from "./connection.js";

const env = {
  E2B_API_KEY: "env-key",
  E2B_API_URL: "https://api.cn-hangzhou.e2b.fc.aliyuncs.com",
  E2B_DOMAIN: "cn-hangzhou.e2b.fc.aliyuncs.com",
};

describe("resolveAliyunConnection", () => {
  test("reads the E2B-protocol variables Aliyun documents", () => {
    expect(resolveAliyunConnection({}, env)).toEqual({
      apiKey: "env-key",
      apiUrl: "https://api.cn-hangzhou.e2b.fc.aliyuncs.com",
      domain: "cn-hangzhou.e2b.fc.aliyuncs.com",
    });
  });

  test("explicit options win over the environment", () => {
    expect(resolveAliyunConnection({ apiKey: "explicit" }, env).apiKey).toBe("explicit");
  });

  test("a region derives both endpoints", () => {
    expect(resolveAliyunConnection({ region: "cn-beijing" }, { E2B_API_KEY: "k" })).toEqual({
      apiKey: "k",
      apiUrl: "https://api.cn-beijing.e2b.fc.aliyuncs.com",
      domain: "cn-beijing.e2b.fc.aliyuncs.com",
    });
  });

  test("the domain alone is enough to derive the API URL", () => {
    expect(
      resolveAliyunConnection(
        {},
        { E2B_API_KEY: "k", E2B_DOMAIN: "cn-shanghai.e2b.fc.aliyuncs.com" },
      ).apiUrl,
    ).toBe("https://api.cn-shanghai.e2b.fc.aliyuncs.com");
  });

  test("names every missing setting and never falls back to e2b.dev", () => {
    expect(() => resolveAliyunConnection({}, {})).toThrow(
      /E2B_API_KEY.*E2B_DOMAIN|E2B_DOMAIN.*E2B_API_KEY/s,
    );
  });

  test("treats blank values as missing", () => {
    expect(() => resolveAliyunConnection({}, { ...env, E2B_API_KEY: "  " })).toThrow(/E2B_API_KEY/);
  });

  test("the error never contains the API key", () => {
    try {
      resolveAliyunConnection({ apiKey: "super-secret" }, {});
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("super-secret");
    }
  });
});
