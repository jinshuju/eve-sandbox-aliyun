import { CommandExitError, NotFoundError, Sandbox } from "e2b";
import type {
  Provider,
  ProviderCommand,
  ProviderCreateOptions,
  ProviderSandbox,
} from "./provider.js";

/** How to reach the Aliyun FC Agent Sandbox endpoint through the E2B protocol. */
export interface AliyunConnection {
  readonly apiKey: string;
  /** `https://api.<region>.e2b.fc.aliyuncs.com` */
  readonly apiUrl: string;
  /** `<region>.e2b.fc.aliyuncs.com` */
  readonly domain: string;
}

/** The static side of the SDK's `Sandbox` class this adapter uses; injectable for tests. */
export interface E2bSandboxStatic {
  create(template: string, options: Record<string, unknown>): Promise<Sandbox>;
  connect(sandboxId: string, options: Record<string, unknown>): Promise<Sandbox>;
  list(options: Record<string, unknown>): {
    readonly hasNext: boolean;
    nextItems(): Promise<ReadonlyArray<{ readonly sandboxId: string }>>;
  };
}

const realSdk: E2bSandboxStatic = {
  create: async (template, options) => await Sandbox.create(template, options),
  connect: async (sandboxId, options) => await Sandbox.connect(sandboxId, options),
  list: (options) => Sandbox.list(options),
};

/** Exit code the provider reports for a process it killed. */
const PROVIDER_KILLED_EXIT_CODE = -1;
const SIGKILL_EXIT_CODE = 137;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function wrapSandbox(sandbox: Sandbox): ProviderSandbox {
  return {
    id: sandbox.sandboxId,

    async startCommand(options, callbacks): Promise<ProviderCommand> {
      const handle = await sandbox.commands.run(options.command, {
        background: true,
        // The SDK kills commands after 60 s by default; eve's spawn() is unbounded.
        timeoutMs: 0,
        cwd: options.cwd,
        envs: options.envs === undefined ? undefined : { ...options.envs },
        user: options.user,
        onStdout: callbacks.onStdout,
        onStderr: callbacks.onStderr,
      });
      return {
        pid: handle.pid,
        async wait() {
          try {
            return { exitCode: (await handle.wait()).exitCode };
          } catch (error) {
            // The SDK throws on any nonzero exit; eve reports the code instead.
            if (!(error instanceof CommandExitError)) throw error;
            return {
              exitCode:
                error.exitCode === PROVIDER_KILLED_EXIT_CODE ? SIGKILL_EXIT_CODE : error.exitCode,
            };
          }
        },
        async kill() {
          await handle.kill();
        },
      };
    },

    async readFile(path, user) {
      try {
        return await sandbox.files.read(path, { format: "stream", user });
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },

    async writeFile(path, content, user) {
      await sandbox.files.write(path, toArrayBuffer(content), { user });
    },

    async setTimeout(timeoutMs) {
      await sandbox.setTimeout(timeoutMs);
    },

    async pause() {
      await sandbox.pause();
    },

    async kill() {
      await sandbox.kill();
    },
  };
}

export interface CreateE2bProviderInput {
  readonly connection: AliyunConnection;
  readonly sdk?: E2bSandboxStatic;
}

export function createE2bProvider(input: CreateE2bProviderInput): Provider {
  const sdk = input.sdk ?? realSdk;
  const { connection } = input;
  return {
    async create(options: ProviderCreateOptions) {
      const { template, ...createOptions } = options;
      return wrapSandbox(
        await sdk.create(template, {
          ...connection,
          ...createOptions,
          envs: createOptions.envs === undefined ? undefined : { ...createOptions.envs },
          metadata:
            createOptions.metadata === undefined ? undefined : { ...createOptions.metadata },
        }),
      );
    },

    async connect(sandboxId) {
      try {
        return wrapSandbox(await sdk.connect(sandboxId, { ...connection }));
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },

    async findByMetadata(metadata) {
      const paginator = sdk.list({ ...connection, query: { metadata: { ...metadata } } });
      const ids: string[] = [];
      while (paginator.hasNext) {
        for (const info of await paginator.nextItems()) ids.push(info.sandboxId);
      }
      return ids;
    },
  };
}
