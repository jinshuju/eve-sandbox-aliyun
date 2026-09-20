import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { ProviderNetworkConfig } from "./provider.js";

const ALL_TRAFFIC = "0.0.0.0/0";
const CATCH_ALL = "*";

function unsupported(feature: string): Error {
  return new Error(`aliyun sandbox: network policy ${feature}`);
}

/**
 * Translates eve's firewall policy into the provider's egress configuration.
 * The provider replaces its whole configuration on every update, so the
 * result is always complete — empty lists clear whatever was set before.
 *
 * Not everything maps: the provider keeps one header-injection rule per exact
 * domain and has no request matchers or proxy forwarding. Those throw rather
 * than silently widening or narrowing what the author asked for.
 */
export function translateNetworkPolicy(policy: SandboxNetworkPolicy): ProviderNetworkConfig {
  if (policy === "allow-all") return { allowOut: [], denyOut: [], rules: {} };
  if (policy === "deny-all") return { allowOut: [], denyOut: [ALL_TRAFFIC], rules: {} };

  const allow = policy.allow ?? [];
  const domains = Array.isArray(allow) ? allow : Object.keys(allow);
  const rules: ProviderNetworkConfig["rules"] = {};

  if (!Array.isArray(allow)) {
    for (const [domain, domainRules] of Object.entries(allow)) {
      const headers: Record<string, string> = {};
      for (const rule of domainRules) {
        if (rule.match !== undefined) {
          throw unsupported(
            `rule for "${domain}" uses "match", which this provider cannot express`,
          );
        }
        if (rule.forwardURL !== undefined) {
          throw unsupported(`rule for "${domain}" uses "forwardURL", which is not supported`);
        }
        for (const transform of rule.transform) Object.assign(headers, transform.headers);
      }
      if (Object.keys(headers).length === 0) continue;
      if (domain.includes("*")) {
        throw unsupported(`transform for "${domain}" needs an exact domain, not a wildcard`);
      }
      rules[domain] = [{ transform: { headers } }];
    }
  }

  // "*" keeps general egress open; only explicitly denied subnets are blocked.
  if (domains.includes(CATCH_ALL)) {
    return { allowOut: [], denyOut: [...(policy.subnets?.deny ?? [])], rules };
  }
  return {
    allowOut: [...domains, ...(policy.subnets?.allow ?? [])],
    denyOut: [ALL_TRAFFIC, ...(policy.subnets?.deny ?? [])],
    rules,
  };
}
