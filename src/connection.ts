import type { AliyunConnection } from "./e2b-provider.js";

export interface AliyunConnectionOptions {
  /** Defaults to `E2B_API_KEY`. */
  readonly apiKey?: string;
  /** Defaults to `E2B_API_URL`, else derived from the domain. */
  readonly apiUrl?: string;
  /** Defaults to `E2B_DOMAIN`, else derived from `region`. */
  readonly domain?: string;
  /** Aliyun region id such as `cn-hangzhou`; derives `domain` and `apiUrl`. */
  readonly region?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const present = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);

/**
 * Resolves how to reach Aliyun's E2B-protocol endpoint. There is deliberately
 * no default endpoint: the SDK's own default is e2b.dev, and silently sending
 * an Aliyun key (or a user's workload) there would be the wrong failure mode.
 */
export function resolveAliyunConnection(
  options: AliyunConnectionOptions,
  env: Env = process.env,
): AliyunConnection {
  const apiKey = present(options.apiKey) ?? present(env.E2B_API_KEY);
  const domain =
    present(options.domain) ??
    (present(options.region) ? `${present(options.region)}.e2b.fc.aliyuncs.com` : undefined) ??
    present(env.E2B_DOMAIN);
  const apiUrl =
    present(options.apiUrl) ??
    (present(options.region) ? undefined : present(env.E2B_API_URL)) ??
    (domain ? `https://api.${domain}` : undefined);

  const missing = [
    ...(apiKey ? [] : ["an API key (apiKey option or E2B_API_KEY)"]),
    ...(domain ? [] : ["an endpoint (region or domain option, or E2B_DOMAIN)"]),
  ];
  if (!apiKey || !domain || !apiUrl) {
    throw new Error(
      `aliyun sandbox: missing ${missing.join(" and ")}. ` +
        `Aliyun FC Agent Sandbox endpoints look like <region>.e2b.fc.aliyuncs.com.`,
    );
  }
  return { apiKey, apiUrl, domain };
}
