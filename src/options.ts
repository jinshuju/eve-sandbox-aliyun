import { createHash } from "node:crypto";
import path from "node:path";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";

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
   * Setup every session inherits: runs once while the template is built, after
   * the seed files are written. What it leaves on the filesystem becomes the
   * template archive.
   */
  readonly prepare?: (sandbox: SandboxSession) => Promise<void> | void;
}

/** Options accepted by `environment.open()`, once per durable session. */
export interface AliyunSandboxOpenOptions {
  /**
   * Environment variables added to every command in this session, over the
   * environment's `env`. Kept in eve's session state, so they outlast the turn.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Egress policy for this session, in force from the moment its sandbox
   * starts. Kept in eve's session state, so a replacement sandbox gets it too.
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
  readonly prepare: ((sandbox: SandboxSession) => Promise<void> | void) | null;
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
    prepare: options.prepare ?? null,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** eve's sandbox storage path, or the author's `cacheDir`. */
export function resolveCacheRoot(storagePath: string, cacheDir: string | null): string {
  return cacheDir ?? path.join(storagePath, "aliyun");
}

export interface TemplateIdentity {
  /** eve's revision of the authored sandbox source, `prepare` included. */
  readonly sourceRevision: string;
  /** Content keys of the seeded workspace and skill trees. */
  readonly resources: Readonly<Record<string, string | null>>;
}

/** A template is only reusable on the source, seeds, base image and environment it was built with. */
export function resolveTemplateArchiveName(
  identity: TemplateIdentity,
  options: ResolvedAliyunSandboxOptions,
): string {
  const key = JSON.stringify([
    identity.sourceRevision,
    identity.resources,
    options.template,
    options.env,
  ]);
  return `${sha256(key)}.tgz`;
}

export function resolveTemplateArchivePath(cacheRoot: string, archive: string): string {
  return path.join(cacheRoot, "templates", archive);
}

export function resolveSessionCheckpointPath(cacheRoot: string, sessionKey: string): string {
  return path.join(cacheRoot, "sessions", `${sha256(sessionKey)}.tgz`);
}
