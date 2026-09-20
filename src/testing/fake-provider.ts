import type {
  Provider,
  ProviderCommand,
  ProviderCommandCallbacks,
  ProviderCreateOptions,
  ProviderSandbox,
  ProviderStartCommandOptions,
} from "../provider.js";

export interface FakeCommandResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  /** Keep the command running until it is killed. */
  readonly hang?: boolean;
}

export type FakeShell = (
  options: ProviderStartCommandOptions,
  sandbox: FakeSandbox,
) => FakeCommandResult | Promise<FakeCommandResult>;

/** In-memory stand-in for one cloud sandbox: a real map-backed filesystem and a scripted shell. */
export class FakeSandbox implements ProviderSandbox {
  readonly files = new Map<string, Uint8Array>();
  readonly commands: ProviderStartCommandOptions[] = [];
  readonly timeouts: number[] = [];
  liveCommands = 0;
  killed = false;
  paused = false;

  constructor(
    readonly id: string,
    readonly createOptions: ProviderCreateOptions,
    private readonly shell: FakeShell,
    private readonly provider: FakeProvider,
  ) {}

  async startCommand(
    options: ProviderStartCommandOptions,
    callbacks: ProviderCommandCallbacks,
  ): Promise<ProviderCommand> {
    if (this.killed) throw new Error(`sandbox ${this.id} is gone`);
    this.commands.push(options);
    const result = await this.shell(options, this);
    if (result.stdout) callbacks.onStdout(result.stdout);
    if (result.stderr) callbacks.onStderr(result.stderr);
    this.liveCommands += 1;
    let finish!: (value: { exitCode: number }) => void;
    const done = new Promise<{ exitCode: number }>((resolve) => (finish = resolve));
    const end = (exitCode: number) => {
      this.liveCommands -= 1;
      finish({ exitCode });
    };
    if (!result.hang) end(result.exitCode ?? 0);
    let killed = false;
    return {
      pid: this.commands.length,
      wait: async () => await done,
      kill: async () => {
        if (killed || !result.hang) return;
        killed = true;
        end(137);
      },
    };
  }

  async readFile(path: string): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = this.files.get(path);
    if (bytes === undefined) return null;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    this.files.set(path, content);
  }

  async setTimeout(timeoutMs: number): Promise<void> {
    this.timeouts.push(timeoutMs);
  }

  async pause(): Promise<void> {
    if (!this.provider.pauseSupported) throw new Error("pauseSession is not enabled");
    this.paused = true;
  }

  async kill(): Promise<void> {
    this.killed = true;
    this.provider.sandboxes.delete(this.id);
  }

  text(path: string): string | undefined {
    const bytes = this.files.get(path);
    return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8");
  }
}

/** In-memory stand-in for the cloud control plane. */
export class FakeProvider implements Provider {
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly created: FakeSandbox[] = [];
  pauseSupported = false;
  private nextId = 1;

  constructor(private readonly shell: FakeShell = () => ({})) {}

  async create(options: ProviderCreateOptions): Promise<FakeSandbox> {
    const sandbox = new FakeSandbox(`sbx-${this.nextId++}`, options, this.shell, this);
    this.sandboxes.set(sandbox.id, sandbox);
    this.created.push(sandbox);
    return sandbox;
  }

  async connect(sandboxId: string): Promise<FakeSandbox | null> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (sandbox === undefined) return null;
    sandbox.paused = false;
    return sandbox;
  }

  async findByMetadata(metadata: Readonly<Record<string, string>>): Promise<string[]> {
    return [...this.sandboxes.values()]
      .filter((sandbox) =>
        Object.entries(metadata).every(
          ([key, value]) => sandbox.createOptions.metadata?.[key] === value,
        ),
      )
      .map((sandbox) => sandbox.id);
  }
}
