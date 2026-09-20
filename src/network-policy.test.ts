import { describe, expect, test } from "vitest";
import { translateNetworkPolicy } from "./network-policy.js";

const ALL_TRAFFIC = "0.0.0.0/0";

describe("translateNetworkPolicy", () => {
  test("allow-all places no restrictions", () => {
    expect(translateNetworkPolicy("allow-all")).toEqual({ allowOut: [], denyOut: [], rules: {} });
  });

  test("deny-all blocks all egress", () => {
    expect(translateNetworkPolicy("deny-all")).toEqual({
      allowOut: [],
      denyOut: [ALL_TRAFFIC],
      rules: {},
    });
  });

  test("a domain list allows only those domains", () => {
    expect(translateNetworkPolicy({ allow: ["ai-gateway.vercel.sh", "*.github.com"] })).toEqual({
      allowOut: ["ai-gateway.vercel.sh", "*.github.com"],
      denyOut: [ALL_TRAFFIC],
      rules: {},
    });
  });

  test("an object policy without an allow list denies everything", () => {
    expect(translateNetworkPolicy({})).toEqual({ allowOut: [], denyOut: [ALL_TRAFFIC], rules: {} });
  });

  test("allowed subnets join the allow list", () => {
    expect(
      translateNetworkPolicy({ allow: ["github.com"], subnets: { allow: ["10.0.0.0/8"] } }),
    ).toEqual({ allowOut: ["github.com", "10.0.0.0/8"], denyOut: [ALL_TRAFFIC], rules: {} });
  });

  test("the record form allows its keys", () => {
    expect(translateNetworkPolicy({ allow: { "github.com": [], "*.npmjs.org": [] } })).toEqual({
      allowOut: ["github.com", "*.npmjs.org"],
      denyOut: [ALL_TRAFFIC],
      rules: {},
    });
  });

  test("a '*' catch-all keeps general egress open and only denies the listed subnets", () => {
    expect(
      translateNetworkPolicy({ allow: { "*": [] }, subnets: { deny: ["10.0.0.0/8"] } }),
    ).toEqual({ allowOut: [], denyOut: ["10.0.0.0/8"], rules: {} });
  });

  test("a transform becomes a header-injection rule for that domain", () => {
    expect(
      translateNetworkPolicy({
        allow: {
          "github.com": [{ transform: [{ headers: { authorization: "Basic abc" } }] }],
          "*": [],
        },
      }),
    ).toEqual({
      allowOut: [],
      denyOut: [],
      rules: { "github.com": [{ transform: { headers: { authorization: "Basic abc" } } }] },
    });
  });

  test("several transforms on one domain merge into its single rule, later headers winning", () => {
    const translated = translateNetworkPolicy({
      allow: {
        "api.example.com": [
          { transform: [{ headers: { a: "1", b: "1" } }, { headers: { b: "2" } }] },
          { transform: [{ headers: { c: "3" } }] },
        ],
      },
    });

    expect(translated.rules).toEqual({
      "api.example.com": [{ transform: { headers: { a: "1", b: "2", c: "3" } } }],
    });
    expect(translated.allowOut).toEqual(["api.example.com"]);
  });

  test("rejects request matchers, which the provider cannot express", () => {
    expect(() =>
      translateNetworkPolicy({
        allow: {
          "api.example.com": [
            { match: { method: ["POST"] }, transform: [{ headers: { a: "1" } }] },
          ],
        },
      }),
    ).toThrow(/match/);
  });

  test("rejects forwardURL rules", () => {
    expect(() =>
      translateNetworkPolicy({
        allow: { "api.example.com": [{ forwardURL: "https://proxy.example.com" }] },
      }),
    ).toThrow(/forwardURL/);
  });

  test("rejects header injection on a wildcard domain", () => {
    expect(() =>
      translateNetworkPolicy({
        allow: { "*.example.com": [{ transform: [{ headers: { a: "1" } }] }] },
      }),
    ).toThrow(/exact domain/);
  });
});
