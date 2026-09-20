import { describe, expect, test } from "vitest";
import type { ProviderCommand, ProviderCommandCallbacks } from "./provider.js";
import { startSandboxProcess } from "./process.js";
import { streamToBytes } from "./public-session.js";

/** A scripted provider command the test drives by hand. */
function scriptedCommand() {
  let callbacks: ProviderCommandCallbacks | undefined;
  let finish!: (result: { exitCode: number }) => void;
  let fail!: (error: Error) => void;
  const done = new Promise<{ exitCode: number }>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  let kills = 0;
  const command: ProviderCommand = {
    pid: 42,
    wait: async () => await done,
    async kill() {
      kills += 1;
      finish({ exitCode: 137 });
    },
  };
  return {
    start: async (cb: ProviderCommandCallbacks) => {
      callbacks = cb;
      return command;
    },
    stdout: (text: string) => callbacks?.onStdout(text),
    stderr: (text: string) => callbacks?.onStderr(text),
    finish,
    fail,
    kills: () => kills,
  };
}

const text = async (stream: ReadableStream<Uint8Array>) =>
  new TextDecoder().decode(await streamToBytes(stream));

describe("startSandboxProcess", () => {
  test("streams stdout and stderr as separate UTF-8 byte streams and reports the exit code", async () => {
    const script = scriptedCommand();
    const proc = await startSandboxProcess({ start: script.start });

    script.stdout("héllo ");
    script.stderr("warn");
    script.stdout("wörld");
    script.finish({ exitCode: 0 });

    expect(await proc.wait()).toEqual({ exitCode: 0 });
    expect(await text(proc.stdout)).toBe("héllo wörld");
    expect(await text(proc.stderr)).toBe("warn");
  });

  test("resolves wait with a nonzero exit code rather than rejecting", async () => {
    const script = scriptedCommand();
    const proc = await startSandboxProcess({ start: script.start });

    script.finish({ exitCode: 7 });

    expect(await proc.wait()).toEqual({ exitCode: 7 });
  });

  test("kill is idempotent and ends the process", async () => {
    const script = scriptedCommand();
    const proc = await startSandboxProcess({ start: script.start });

    await Promise.all([proc.kill(), proc.kill()]);
    await proc.kill();

    expect(script.kills()).toBe(1);
    expect(await proc.wait()).toEqual({ exitCode: 137 });
  });

  test("kill after a natural exit does not reach the provider", async () => {
    const script = scriptedCommand();
    const proc = await startSandboxProcess({ start: script.start });
    script.finish({ exitCode: 0 });
    await proc.wait();

    await proc.kill();

    expect(script.kills()).toBe(0);
  });

  test("an abort signal kills the running process", async () => {
    const script = scriptedCommand();
    const abort = new AbortController();
    const proc = await startSandboxProcess({ start: script.start, abortSignal: abort.signal });

    abort.abort();

    expect(await proc.wait()).toEqual({ exitCode: 137 });
    expect(script.kills()).toBe(1);
  });

  test("refuses to start when the signal is already aborted", async () => {
    const script = scriptedCommand();
    const abort = new AbortController();
    abort.abort(new Error("stop"));

    await expect(
      startSandboxProcess({ start: script.start, abortSignal: abort.signal }),
    ).rejects.toThrow("stop");
  });

  test("a transport failure rejects wait and errors both streams", async () => {
    const script = scriptedCommand();
    const proc = await startSandboxProcess({ start: script.start });

    script.fail(new Error("connection lost"));

    await expect(proc.wait()).rejects.toThrow("connection lost");
    await expect(text(proc.stdout)).rejects.toThrow("connection lost");
  });

  test("output arriving after the consumer cancelled a stream is dropped quietly", async () => {
    const script = scriptedCommand();
    const proc = await startSandboxProcess({ start: script.start });

    await proc.stdout.cancel();
    script.stdout("late");
    script.finish({ exitCode: 0 });

    expect(await proc.wait()).toEqual({ exitCode: 0 });
  });

  test("notifies onExit exactly once when the process ends", async () => {
    const script = scriptedCommand();
    let exits = 0;
    const proc = await startSandboxProcess({ start: script.start, onExit: () => (exits += 1) });

    script.finish({ exitCode: 0 });
    await proc.wait();
    await proc.wait();

    expect(exits).toBe(1);
  });
});
