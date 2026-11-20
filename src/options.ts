import { createHash } from "node:crypto";
import path from "node:path";
import type { SandboxNetworkPolicy } from "eve/sandbox";

export const DEFAULT_TEMPLATE = "code-interpreter-v1";
/** Same default lifetime as eve's Vercel provider. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface AliyunSandboxCreateOptions {
  /** Aliyun sandbox template (base image) every sandbox starts from. */
  readonly template?: string;
  /** Environment variables set for every sandboxed command. */
  readonly env?: Readonly<Record<string, string>>;
  /** Idle lifetime; activity resets it. The provider destroys the sandbox when it runs out. */
  readonly timeoutMs?: number;
  /** Absolute directory for template archives and session checkpoints. */
  readonly cacheDir?: string;
  /**
   * Egress policy every sandbox starts with, preparation included. Defaults to
   * `"allow-all"`. Override per session with `open({ networkPolicy })`, or
   * mid-turn with `sandbox.setNetworkPolicy()`.
   */
  readonly networkPolicy?: SandboxNetworkPolicy;
  /** Extra metadata labels on every sandbox this environment creates, e.g. for `pnpm sweep --tag`. */
  readonly metadata?: Readonly<Record<string, string>>;
  /**
   * `false` closes every sandbox's port URLs (`https://<port>-<id>.<domain>`)
   * to requests without the sandbox's traffic token. Omitted, the provider's
   * default applies, and anyone who knows a sandbox id reaches any port that
   * listens in it. The provider's own channel to the sandbox is not affected.
   */
  readonly allowPublicTraffic?: boolean;
}

/** Options accepted by `environment.open()`, once per durable session. */
export interface AliyunSandboxOpenOptions {
  /**
   * Environment variables added to every command in this session, over the
   * environment's `env`. Kept in eve's session state, so they outlast the turn.
   * Applied when the session's sandbox is created; a start that finds the
   * session's sandbox already running keeps the env it was created with.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Egress policy for this session, in force from the moment its sandbox
   * starts. Applied when the session's sandbox is created.
   */
  readonly networkPolicy?: SandboxNetworkPolicy;
}

export interface ResolvedAliyunSandboxOptions {
  readonly template: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly cacheDir: string | null;
  readonly networkPolicy: SandboxNetworkPolicy;
  readonly metadata: Readonly<Record<string, string>>;
  readonly allowPublicTraffic: boolean | undefined;
}

export function resolveAliyunSandboxOptions(
  options: AliyunSandboxCreateOptions = {},
): ResolvedAliyunSandboxOptions {
  return {
    template: options.template ?? DEFAULT_TEMPLATE,
    env: { ...options.env },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    cacheDir: options.cacheDir ?? null,
    networkPolicy: options.networkPolicy ?? "allow-all",
    metadata: { ...options.metadata },
    allowPublicTraffic: options.allowPublicTraffic,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** eve's sandbox storage path, or the author's `cacheDir`. */
export function resolveCacheRoot(storagePath: string, cacheDir: string | null): string {
  return cacheDir ?? path.join(storagePath, "aliyun");
}

/** A template archive's file name, from eve's template key. */
export function resolveTemplateArchiveName(templateKey: string): string {
  return `${templateKey.slice(0, 32)}.tgz`;
}

export function resolveTemplateArchivePath(cacheRoot: string, archive: string): string {
  return path.join(cacheRoot, "templates", archive);
}

/**
 * One checkpoint per eve session, keyed by its id: the files its sandbox had
 * when it last stopped. (0.4 keyed it by a session key unique to each start.)
 */
export function resolveSessionCheckpointPath(cacheRoot: string, key: string): string {
  return path.join(cacheRoot, "sessions", `${sha256(key)}.tgz`);
}
