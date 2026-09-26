import type {
  SandboxNetworkPolicy,
  SandboxProcess,
  SandboxReadFileOptions,
  SandboxSession,
  SandboxSpawnOptions,
  SandboxWriteFileOptions,
} from "eve/sandbox";

/**
 * The byte-oriented primitives a provider has to supply. Same shape as eve's
 * (unexported) `InternalSandboxSession`: `readFile`/`writeFile`/`removePath`
 * receive already-resolved paths.
 */
export interface InternalSession {
  resolvePath(path: string): string;
  spawn(options: SandboxSpawnOptions): Promise<SandboxProcess>;
  readFile(options: SandboxReadFileOptions): Promise<ReadableStream<Uint8Array> | null>;
  writeFile(options: SandboxWriteFileOptions): Promise<void>;
  removePath(options: {
    readonly abortSignal?: AbortSignal;
    readonly force?: boolean;
    readonly path: string;
    readonly recursive?: boolean;
  }): Promise<void>;
}

export type NetworkPolicySetter = (policy: SandboxNetworkPolicy) => Promise<void>;

/**
 * The session this provider hands to authored code. Its firewall is mutable, so
 * `setNetworkPolicy` is always there. eve 0.64 and 0.65 spelled this shape
 * `MutableNetworkSandboxSession`; 0.66 dropped that alias and asks each provider
 * to declare its own session type, as eve's docker provider does.
 */
export interface AliyunSandboxSession extends SandboxSession {
  /** Applies a firewall policy to the live sandbox. */
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
}

export async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function validateLineRange(startLine?: number, endLine?: number): void {
  if (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) {
    throw new Error("startLine must be a positive integer (1-based).");
  }
  if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) {
    throw new Error("endLine must be a positive integer (1-based).");
  }
  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    throw new Error("startLine must not be greater than endLine.");
  }
}

function splitLinesPreservingEndings(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

function applyLineRange(text: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) return text;
  const lines = splitLinesPreservingEndings(text);
  const start = startLine ?? 1;
  if (start > lines.length) return "";
  return lines.slice(start - 1, Math.min(endLine ?? lines.length, lines.length)).join("");
}

function isUtf8(encoding: string): boolean {
  return encoding === "utf-8" || encoding === "utf8";
}

function decodeBytes(bytes: Uint8Array, encoding: string): string {
  return isUtf8(encoding)
    ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
        encoding as BufferEncoding,
      );
}

function encodeString(text: string, encoding: string): Uint8Array {
  return isUtf8(encoding)
    ? new TextEncoder().encode(text)
    : Buffer.from(text, encoding as BufferEncoding);
}

/**
 * Builds eve's public sandbox session on top of provider primitives, with the
 * same semantics as eve's own builder so authored code behaves identically on
 * this provider. The firewall is mutable here, so the session always carries
 * `setNetworkPolicy`.
 */
export function buildPublicSession(
  internal: InternalSession,
  setNetworkPolicy: NetworkPolicySetter,
): AliyunSandboxSession {
  return {
    resolvePath: (path) => internal.resolvePath(path),
    setNetworkPolicy,

    async run(options) {
      const proc = await internal.spawn(options);
      const [stdout, stderr, { exitCode }] = await Promise.all([
        streamToBytes(proc.stdout),
        streamToBytes(proc.stderr),
        proc.wait(),
      ]);
      const decoder = new TextDecoder();
      return { exitCode, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
    },

    async spawn(options) {
      return await internal.spawn(options);
    },

    async readFile({ path, abortSignal }) {
      return await internal.readFile({ abortSignal, path: internal.resolvePath(path) });
    },

    async readBinaryFile({ path, abortSignal }) {
      const stream = await internal.readFile({ abortSignal, path: internal.resolvePath(path) });
      return stream === null ? null : await streamToBytes(stream);
    },

    async readTextFile({ path, abortSignal, encoding, startLine, endLine }) {
      validateLineRange(startLine, endLine);
      const stream = await internal.readFile({ abortSignal, path: internal.resolvePath(path) });
      if (stream === null) return null;
      const text = decodeBytes(await streamToBytes(stream), encoding ?? "utf-8");
      return applyLineRange(text, startLine, endLine);
    },

    async writeFile({ path, content, abortSignal }) {
      await internal.writeFile({ abortSignal, content, path: internal.resolvePath(path) });
    },

    async writeBinaryFile({ path, content, abortSignal }) {
      await internal.writeFile({
        abortSignal,
        content: bytesToStream(content),
        path: internal.resolvePath(path),
      });
    },

    async writeTextFile({ path, content, encoding, abortSignal }) {
      await internal.writeFile({
        abortSignal,
        content: bytesToStream(encodeString(content, encoding ?? "utf-8")),
        path: internal.resolvePath(path),
      });
    },

    async removePath({ path, abortSignal, force, recursive }) {
      await internal.removePath({
        abortSignal,
        force,
        path: internal.resolvePath(path),
        recursive,
      });
    },
  };
}
