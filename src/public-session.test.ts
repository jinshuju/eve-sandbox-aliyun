import { describe, expect, test } from "vitest";
import type { InternalSession } from "./public-session.js";
import { buildPublicSession } from "./public-session.js";
import { resolveWorkspacePath } from "./paths.js";

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/** In-memory internal session: a real (tiny) filesystem, scripted processes. */
function memorySession(files: Record<string, Uint8Array> = {}) {
  const store = new Map(Object.entries(files));
  const removed: unknown[] = [];
  const spawned: unknown[] = [];
  const internal: InternalSession = {
    resolvePath: resolveWorkspacePath,
    async spawn(options) {
      spawned.push(options);
      return {
        stdout: bytesStream(utf8("out")),
        stderr: bytesStream(utf8("err")),
        wait: async () => ({ exitCode: 3 }),
        kill: async () => {},
      };
    },
    async readFile({ path }) {
      const bytes = store.get(path);
      return bytes === undefined ? null : bytesStream(bytes);
    },
    async writeFile({ path, content }) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of content as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
      store.set(path, Buffer.concat(chunks));
    },
    async removePath(options) {
      removed.push(options);
    },
  };
  return { internal, store, removed, spawned };
}

describe("buildPublicSession", () => {
  test("run resolves with output and a nonzero exit code instead of throwing", async () => {
    const { internal } = memorySession();
    const session = buildPublicSession(internal, async () => {});

    expect(await session.run({ command: "false" })).toEqual({
      exitCode: 3,
      stdout: "out",
      stderr: "err",
    });
  });

  test("readTextFile anchors relative paths to /workspace", async () => {
    const { internal } = memorySession({ "/workspace/a.txt": utf8("hello") });
    const session = buildPublicSession(internal, async () => {});

    expect(await session.readTextFile({ path: "a.txt" })).toBe("hello");
  });

  test("readTextFile returns null for a missing file", async () => {
    const session = buildPublicSession(memorySession().internal, async () => {});
    expect(await session.readTextFile({ path: "nope.txt" })).toBeNull();
  });

  test("readTextFile slices a 1-based inclusive line range, keeping line endings", async () => {
    const { internal } = memorySession({ "/workspace/f": utf8("one\ntwo\r\nthree\nfour") });
    const session = buildPublicSession(internal, async () => {});

    expect(await session.readTextFile({ path: "f", startLine: 2, endLine: 3 })).toBe(
      "two\r\nthree\n",
    );
  });

  test("readTextFile with endLine past EOF reads through EOF", async () => {
    const { internal } = memorySession({ "/workspace/f": utf8("one\ntwo") });
    const session = buildPublicSession(internal, async () => {});

    expect(await session.readTextFile({ path: "f", startLine: 2, endLine: 99 })).toBe("two");
  });

  test("readTextFile with startLine past EOF returns an empty string", async () => {
    const { internal } = memorySession({ "/workspace/f": utf8("one\n") });
    const session = buildPublicSession(internal, async () => {});

    expect(await session.readTextFile({ path: "f", startLine: 5 })).toBe("");
  });

  test("readTextFile rejects a non-positive startLine", async () => {
    const { internal } = memorySession({ "/workspace/f": utf8("one") });
    const session = buildPublicSession(internal, async () => {});

    await expect(session.readTextFile({ path: "f", startLine: 0 })).rejects.toThrow(
      "startLine must be a positive integer",
    );
  });

  test("readTextFile rejects startLine greater than endLine", async () => {
    const { internal } = memorySession({ "/workspace/f": utf8("one") });
    const session = buildPublicSession(internal, async () => {});

    await expect(session.readTextFile({ path: "f", startLine: 3, endLine: 2 })).rejects.toThrow(
      "startLine must not be greater than endLine",
    );
  });

  test("readTextFile decodes utf-8 in fatal mode", async () => {
    const { internal } = memorySession({ "/workspace/bin": new Uint8Array([0xff, 0xfe]) });
    const session = buildPublicSession(internal, async () => {});

    await expect(session.readTextFile({ path: "bin" })).rejects.toThrow();
  });

  test("readTextFile honours a non-utf-8 encoding", async () => {
    const { internal } = memorySession({ "/workspace/l1": new Uint8Array([0xe9]) });
    const session = buildPublicSession(internal, async () => {});

    expect(await session.readTextFile({ path: "l1", encoding: "latin1" })).toBe("é");
  });

  test("readBinaryFile returns the raw bytes, or null when missing", async () => {
    const { internal } = memorySession({ "/workspace/b": new Uint8Array([1, 2, 255]) });
    const session = buildPublicSession(internal, async () => {});

    expect(Array.from((await session.readBinaryFile({ path: "b" })) ?? [])).toEqual([1, 2, 255]);
    expect(await session.readBinaryFile({ path: "missing" })).toBeNull();
  });

  test("writeTextFile encodes and writes to the resolved path", async () => {
    const { internal, store } = memorySession();
    const session = buildPublicSession(internal, async () => {});

    await session.writeTextFile({ path: "dir/x.txt", content: "é", encoding: "latin1" });

    expect(Array.from(store.get("/workspace/dir/x.txt") ?? [])).toEqual([0xe9]);
  });

  test("writeBinaryFile writes raw bytes", async () => {
    const { internal, store } = memorySession();
    const session = buildPublicSession(internal, async () => {});

    await session.writeBinaryFile({ path: "/tmp/b", content: new Uint8Array([9, 8]) });

    expect(Array.from(store.get("/tmp/b") ?? [])).toEqual([9, 8]);
  });

  test("writeFile streams bytes to the resolved path", async () => {
    const { internal, store } = memorySession();
    const session = buildPublicSession(internal, async () => {});

    await session.writeFile({ path: "s", content: bytesStream(utf8("streamed")) });

    expect(Buffer.from(store.get("/workspace/s") ?? []).toString()).toBe("streamed");
  });

  test("removePath resolves the path and forwards force/recursive", async () => {
    const { internal, removed } = memorySession();
    const session = buildPublicSession(internal, async () => {});

    await session.removePath({ path: "old", force: true, recursive: true });

    expect(removed).toEqual([
      { abortSignal: undefined, path: "/workspace/old", force: true, recursive: true },
    ]);
  });

  test("setNetworkPolicy delegates to the supplied setter", async () => {
    const seen: unknown[] = [];
    const session = buildPublicSession(memorySession().internal, async (policy) => {
      seen.push(policy);
    });

    await session.setNetworkPolicy("deny-all");

    expect(seen).toEqual(["deny-all"]);
  });
});
