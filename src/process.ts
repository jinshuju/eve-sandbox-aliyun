import type { SandboxProcess } from "eve/sandbox";
import type { ProviderCommand, ProviderCommandCallbacks } from "./provider.js";

export interface StartSandboxProcessInput {
  start(callbacks: ProviderCommandCallbacks): Promise<ProviderCommand>;
  readonly abortSignal?: AbortSignal;
  /** Called once when the process has ended, however it ended. */
  readonly onExit?: () => void;
}

function createOutputChannel() {
  let cancelled = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    enqueue: (bytes: Uint8Array) => void (cancelled || controller.enqueue(bytes)),
    close: () => void (cancelled || controller.close()),
    error: (reason: unknown) => void (cancelled || controller.error(reason)),
  };
}

/**
 * Adapts a provider command to eve's {@link SandboxProcess}. The provider
 * delivers output as decoded strings, so bytes are re-encoded as UTF-8 — the
 * same model eve's own Vercel provider uses. Byte-exact data belongs in files.
 */
export async function startSandboxProcess(
  input: StartSandboxProcessInput,
): Promise<SandboxProcess> {
  input.abortSignal?.throwIfAborted();

  const encoder = new TextEncoder();
  const stdout = createOutputChannel();
  const stderr = createOutputChannel();
  const command = await input.start({
    onStdout: (chunk) => stdout.enqueue(encoder.encode(chunk)),
    onStderr: (chunk) => stderr.enqueue(encoder.encode(chunk)),
  });

  let exited = false;
  let killing: Promise<void> | undefined;
  const kill = () => {
    if (exited) return Promise.resolve();
    return (killing ??= command.kill());
  };
  const onAbort = () => void kill().catch(() => {});
  input.abortSignal?.addEventListener("abort", onAbort, { once: true });

  const exit = command.wait().then(
    (result) => {
      stdout.close();
      stderr.close();
      return { exitCode: result.exitCode };
    },
    (error: unknown) => {
      stdout.error(error);
      stderr.error(error);
      throw error;
    },
  );
  const settled = exit.finally(() => {
    exited = true;
    input.abortSignal?.removeEventListener("abort", onAbort);
    input.onExit?.();
  });
  settled.catch(() => {});

  return {
    stdout: stdout.stream,
    stderr: stderr.stream,
    wait: async () => await settled,
    kill: async () => await kill(),
  };
}
