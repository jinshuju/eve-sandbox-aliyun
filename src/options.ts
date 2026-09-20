import { createHash } from "node:crypto";
import path from "node:path";

export const DEFAULT_TEMPLATE = "code-interpreter-v1";
/** Same default lifetime as eve's Vercel backend. */
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
}

export interface ResolvedAliyunSandboxOptions {
  readonly template: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly cacheDir: string | null;
}

export function resolveAliyunSandboxOptions(
  options: AliyunSandboxCreateOptions = {},
): ResolvedAliyunSandboxOptions {
  return {
    template: options.template ?? DEFAULT_TEMPLATE,
    env: { ...options.env },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    cacheDir: options.cacheDir ?? null,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function resolveCacheRoot(appRoot: string, cacheDir: string | null): string {
  return cacheDir ?? path.join(appRoot, ".eve", "sandbox-cache", "aliyun");
}

/** A template is only reusable on the base image and environment it was built with. */
export function resolveTemplateArchivePath(
  cacheRoot: string,
  templateKey: string,
  options: ResolvedAliyunSandboxOptions,
): string {
  const identity = JSON.stringify([templateKey, options.template, options.env]);
  return path.join(cacheRoot, "templates", `${sha256(identity)}.tgz`);
}

export function resolveSessionCheckpointPath(cacheRoot: string, sessionKey: string): string {
  return path.join(cacheRoot, "sessions", `${sha256(sessionKey)}.tgz`);
}
