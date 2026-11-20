import { createHash } from "node:crypto";
import type { SandboxCommandResult, SandboxProcess } from "eve/sandbox";
import type {
  SandboxConnection,
  SandboxPrepareContext,
  SandboxSessionContext,
} from "eve/sandbox/provider";
import type { AliyunSandboxExtensions } from "../session.js";
import { streamToBytes } from "../streams.js";

export interface SeedFile {
  /** `/workspace/...` or `$HOME/.agents/skills/...`, as eve addresses seeds. */
  readonly path: string;
  readonly content: string | Uint8Array;
}

export const STORAGE_PATH = "/srv/app/.eve/sandbox-cache";

const WORKSPACE_ROOT = "/workspace";
const HOME_PREFIX = "$HOME/";

/**
 * A small stand-in for the session eve builds over a connection (eve's own
 * builder is internal): enough for tests, `prepare` callbacks and the smoke
 * test to drive a connection the way eve does — absolute paths, a working
 * directory on every spawn.
 */
export interface TestSession {
  run(options: {
    readonly command: string;
    readonly env?: Record<string, string>;
    readonly workingDirectory?: string;
    readonly signal?: AbortSignal;
  }): Promise<SandboxCommandResult>;
  spawn(options: {
    readonly command: string;
    readonly env?: Record<string, string>;
    readonly signal?: AbortSignal;
  }): Promise<SandboxProcess>;
  readText(path: string): Promise<string | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
  writeText(path: string, content: string): Promise<void>;
  writeBytes(path: string, content: Uint8Array): Promise<void>;
  removePath(options: { path: string; force?: boolean; recursive?: boolean }): Promise<void>;
  setNetworkPolicy: AliyunSandboxExtensions["setNetworkPolicy"];
}

const absolute = (path: string) => (path.startsWith("/") ? path : `${WORKSPACE_ROOT}/${path}`);

export function sessionOver(connection: SandboxConnection<AliyunSandboxExtensions>): TestSession {
  async function readBytes(path: string): Promise<Uint8Array | null> {
    const content = await connection.readFile({ path: absolute(path) });
    if (content === null || content instanceof Uint8Array) return content;
    return await streamToBytes(content);
  }
  const spawn: TestSession["spawn"] = async (options) =>
    await connection.spawn({
      command: options.command,
      env: options.env ?? {},
      signal: options.signal,
      workingDirectory: WORKSPACE_ROOT,
    });
  return {
    async run(options) {
      const proc = await connection.spawn({
        command: options.command,
        env: options.env ?? {},
        signal: options.signal,
        workingDirectory: absolute(options.workingDirectory ?? WORKSPACE_ROOT),
      });
      const [stdout, stderr, { exitCode }] = await Promise.all([
        streamToBytes(proc.stdout),
        streamToBytes(proc.stderr),
        proc.wait(),
      ]);
      const decoder = new TextDecoder();
      return { exitCode, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
    },
    spawn,
    readBytes,
    async readText(path) {
      const bytes = await readBytes(path);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },
    async writeBytes(path, content) {
      await connection.writeFiles({ files: [{ path: absolute(path), content }] });
    },
    async writeText(path, content) {
      await connection.writeFiles({
        files: [{ path: absolute(path), content: new TextEncoder().encode(content) }],
      });
    },
    async removePath(options) {
      await connection.removePath({ ...options, path: absolute(options.path) });
    },
    setNetworkPolicy: async (policy) => {
      const extensions = connection.extensions;
      if (extensions === undefined) throw new Error("the connection has no extensions");
      await extensions.setNetworkPolicy(policy);
    },
  };
}

/**
 * What eve's `prepare` context does, for a provider under test: `populate()`
 * writes the seeds through the connection (skills under the home directory a
 * spawn reports) and runs the authored `prepare` over it.
 */
export function prepareContext(
  input: {
    readonly seedFiles?: readonly SeedFile[];
    readonly prepare?: (session: TestSession) => Promise<void> | void;
    readonly sourceRevision?: string;
    readonly log?: (message: string) => void;
  } = {},
): SandboxPrepareContext {
  const seedFiles = input.seedFiles ?? [];
  const encode = (content: string | Uint8Array) =>
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  return {
    files: {
      list: async () => [],
      read: async (path) => Promise.reject(new Error(`no authored file ${path}`)),
      readText: async (path) => Promise.reject(new Error(`no authored file ${path}`)),
    },
    isEmpty: seedFiles.length === 0 && input.prepare === undefined,
    storagePath: STORAGE_PATH,
    log: input.log ?? (() => {}),
    async populate(connection) {
      const session = sessionOver(connection as SandboxConnection<AliyunSandboxExtensions>);
      const home = (await session.run({ command: 'printf %s "$HOME"' })).stdout || "/root";
      await connection.writeFiles({
        files: seedFiles.map((seed) => ({
          path: seed.path.startsWith(HOME_PREFIX)
            ? `${home}/${seed.path.slice(HOME_PREFIX.length)}`
            : seed.path,
          content: encode(seed.content),
        })),
      });
      await input.prepare?.(session);
    },
    resolveProjectPath: (path) => path,
    resourcesDirectory: async () => undefined,
    templateKey: (identity) =>
      createHash("sha256")
        .update(
          JSON.stringify([
            identity,
            input.sourceRevision ?? "rev-1",
            seedFiles.map((seed) => [seed.path, Buffer.from(encode(seed.content)).toString("hex")]),
          ]),
        )
        .digest("hex"),
  };
}

export function sessionContext(sessionId = "session-1"): SandboxSessionContext {
  return {
    kind: "session",
    resolveProjectPath: (path) => path,
    session: {
      auth: { current: null, initiator: null },
      id: sessionId,
      turn: { id: "turn-1", sequence: 1 },
    },
    storagePath: STORAGE_PATH,
  };
}
