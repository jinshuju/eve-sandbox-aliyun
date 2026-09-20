# @jinshuju/eve-sandbox-aliyun

[![npm](https://img.shields.io/npm/v/@jinshuju/eve-sandbox-aliyun)](https://www.npmjs.com/package/@jinshuju/eve-sandbox-aliyun)

An [Aliyun cloud sandbox](https://help.aliyun.com/zh/functioncompute/sandbox-function/)
(FC Agent Sandbox) `SandboxBackend` for [eve](https://eve.dev) agents. It gives agent-executed
code a real, remote Linux machine — real binaries, passwordless `sudo`, a firewall with
credential brokering — with nothing to run on the host but Node.

## Usage

```bash
npm install @jinshuju/eve-sandbox-aliyun
```

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { aliyun } from "@jinshuju/eve-sandbox-aliyun";

export default defineSandbox({
  backend: aliyun(),
});
```

Aliyun's sandbox speaks the E2B protocol, so the connection uses the variables Aliyun documents:

```bash
E2B_API_KEY=...
E2B_DOMAIN=cn-hangzhou.e2b.fc.aliyuncs.com
E2B_API_URL=https://api.cn-hangzhou.e2b.fc.aliyuncs.com   # optional; derived from the domain
```

Credentials are read on first use, not when `aliyun()` is called, so the sandbox module can be
imported at build time. There is deliberately no default endpoint: the underlying SDK defaults to
e2b.dev, and quietly sending an Aliyun key there would be the wrong way to fail.

Everything eve documents for a sandbox works — `bootstrap`, `onSession`, seeded
`agent/sandbox/workspace/**`, skills under `$HOME/.agents/skills`, and the full session API:

```ts
export default defineSandbox({
  backend: aliyun({ networkPolicy: { allow: ["deb.debian.org"] } }),
  revalidationKey: () => "tools-v1",
  async bootstrap({ use }) {
    const sandbox = await use();
    const result = await sandbox.run({
      command: "sudo apt-get update -qq && sudo apt-get install -y -qq jq",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  },
  async onSession({ use }) {
    await use({ networkPolicy: "deny-all" });
  },
});
```

### Per-session environment

`use({ env })` adds variables to every later command in that session — no env file on disk, no
login-shell tricks. Per-call `env` still wins, and the factory's `env` sits underneath:

```ts
async onSession({ use, ctx }) {
  await use({ env: { API_TOKEN: mintToken(ctx.session.id) } });
},
```

eve opens a new handle every turn but runs `onSession` once, so these variables travel in eve's
session state (next to the sandbox id) and are still there on the next turn, after a pause, and
in a replacement sandbox. They are visible to anything running in the sandbox — for a secret the
sandbox must never see, use a [network policy](#network-policy) `transform` instead.

[`examples/basic`](./examples/basic) is a complete agent (DeepSeek model, a seeded data file, a
`bootstrap` that installs `jq`).

### Options

| Option          | Default                                    | Meaning                                                                                                                                                                               |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`        | `E2B_API_KEY`                              | Aliyun sandbox API key.                                                                                                                                                               |
| `region`        | —                                          | Region id such as `cn-hangzhou`; derives `domain` and `apiUrl`.                                                                                                                       |
| `domain`        | `E2B_DOMAIN`                               | `<region>.e2b.fc.aliyuncs.com`.                                                                                                                                                       |
| `apiUrl`        | `E2B_API_URL`, else `https://api.<domain>` | Control-plane URL.                                                                                                                                                                    |
| `template`      | `"code-interpreter-v1"`                    | Aliyun template (base image) every sandbox starts from. Use a [custom image template](https://help.aliyun.com/zh/functioncompute/build-a-custom-image-template) for heavy toolchains. |
| `env`           | `{}`                                       | Environment variables for every sandboxed command. Per-call `env` wins.                                                                                                               |
| `timeoutMs`     | `1800000` (30 min)                         | **Idle** lifetime. Activity resets it; when it runs out Aliyun destroys the sandbox. This is your cost gate — see [Cost](#cost). Aliyun accepts up to 12 h and rejects 24 h.          |
| `networkPolicy` | `"allow-all"`                              | Egress policy every fresh sandbox starts with, `bootstrap` included.                                                                                                                  |
| `cacheDir`      | `<appRoot>/.eve/sandbox-cache/aliyun`      | Where template archives and session checkpoints are kept. Pin it outside the release directory so a redeploy does not discard them.                                                   |

## How it works

Aliyun's sandbox has **no snapshots** (`sandbox runtime does not support snapshot`), and
pause/resume is an allow-listed account feature. eve's model — a template captured once at
build time, durable sessions opened from it — is rebuilt on what the platform does have.

- **Base runtime.** A fresh sandbox has no `/workspace`, and the default user cannot create one.
  Before anything else, a root step creates a user-owned `/workspace` and drops a marker file.
- **prewarm** (build time) starts a throwaway sandbox, writes the seed files, runs your
  `bootstrap`, then archives **every filesystem entry whose inode changed since the marker** and
  downloads it to `cacheDir/templates/`. The sandbox is destroyed either way. Comparing `ctime`
  rather than `mtime` is deliberate: package managers restore old mtimes on the files they
  install, so an mtime comparison would miss exactly the `apt-get install` a bootstrap is for.
- **create** (runtime) reattaches when it can — first by the sandbox id eve persisted, then by
  the session key stored in the sandbox's metadata — and otherwise starts a fresh sandbox and
  restores an archive into it. A session checkpoint wins over the template, since it already
  contains the template it grew from.
- **run / spawn** go through the sandbox's login shell as the unprivileged user, in
  `/workspace`. `kill()` ends the process and its children.
- **stop / shutdown** kill the session's processes, then release the compute. Where the account
  has pause, the sandbox is paused and resumes intact on the next `create`. Where it does not,
  the session's filesystem delta is checkpointed to `cacheDir/sessions/` and the sandbox is
  destroyed; the next `create` restores it into a new sandbox. `stop()` rejects on failure;
  `shutdown()` never throws.
- **delete** destroys the sandbox and its checkpoint. Templates are shared and survive.

## Network policy

All three of eve's forms work, at creation, per session in `onSession`'s `use()`, and mid-turn
through `sandbox.setNetworkPolicy()` — no sandbox restart:

```ts
"allow-all"
"deny-all"
{ allow: ["ai-gateway.vercel.sh", "*.github.com"], subnets: { deny: ["10.0.0.0/8"] } }
```

**Credential brokering** works too. A `transform` injects headers at Aliyun's egress proxy, so the
secret never enters the sandbox:

```ts
await sandbox.setNetworkPolicy({
  allow: {
    "api.github.com": [{ transform: [{ headers: { authorization: "Bearer ..." } }] }],
    "*": [],
  },
});
```

Differences from the Vercel backend, which throw rather than silently changing what you asked for:

- `match` (method/path/header matchers) and `forwardURL` are not supported.
- A `transform` needs an exact domain — no wildcards — and Aliyun keeps one rule per domain, so
  several transforms on a domain are merged (later headers win). At most 10 domains carry rules.
- Aliyun gives allowed entries precedence over denied ones; Vercel is the other way round. It
  only matters if an allowed domain resolves into a subnet you also deny.
- `"deny-all"` blocks connections but not DNS resolution.
- HTTPS header injection relies on Aliyun's CA being trusted in the image. Official templates and
  recent Debian/Ubuntu custom images include it.

## Compatibility notes

- **`e2b` is pinned to exactly `2.31.0`.** Newer SDKs create sandboxes through `POST
/v2/sandboxes`, which Aliyun answers with `405`. 2.31.0 is the version Aliyun documents.
- **Process output is text.** The SDK delivers stdout/stderr as decoded strings, so invalid UTF-8
  arrives as U+FFFD. eve's own Vercel backend has the same model. File reads and writes are
  byte-exact; move binary data through files.
- **A checkpoint is a delta, not an image.** It records what was added or changed since base
  setup, not deletions of files that shipped in the base image, and `/tmp`, `/var/tmp`,
  `/var/cache`, `/var/log` and apt's package lists are excluded. Memory and running processes
  only survive `stop()` on accounts with pause.
- **Templates live in `cacheDir`.** If you build on one machine and run on another, ship the
  directory with the build or point both at shared storage.
- **A sandbox lost to the idle timeout** is replaced from the latest checkpoint, or the template.
  As on every eve backend, `onSession` does not run again for the replacement — put
  security-critical policy on the factory.

## Cost

Sandboxes bill while they run. eve sessions are durable, so a process exiting does **not** stop
its sandbox: after `eve invoke` returns, the sandbox idles until `timeoutMs` elapses. Keep
`timeoutMs` as low as your turn cadence allows, and call `ctx.getSandbox().stop()` (or
`.delete()`) when a task is finished.

`pnpm sweep` lists what is still running in the account. With `--kill` it destroys the provably
disposable sandboxes — smoke runs and template builds — and, with `--tag agent=<name>`, the ones
carrying that eve tag. Session sandboxes are never touched unless a `--tag` names them.

## Troubleshooting

| Symptom                                            | Likely cause                                                                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `405` when creating a sandbox                      | A newer `e2b` was hoisted over this package's pin. It must resolve to exactly `2.31.0`.                                                   |
| Requests go to e2b.dev, or `missing an endpoint`   | `E2B_DOMAIN` (or `region`) is not set. There is no default endpoint on purpose.                                                           |
| `SandboxTemplateNotProvisionedError` in production | `cacheDir` did not travel with the build. Ship it, or point build and runtime at shared storage.                                          |
| `bootstrap` cannot reach the network               | The factory's `networkPolicy` governs `bootstrap` too. Allow the package mirrors there and tighten per session in `onSession`.            |
| `500` from a sandbox object right after pausing it | A paused sandbox's old handle is dead; reconnect by id. This backend always does — it only bites code that drives the `e2b` SDK directly. |
| Sandboxes pile up                                  | `timeoutMs` is a backstop, not collection. Call `stop()`/`delete()` when work ends, and check with `pnpm sweep`.                          |

## eve version requirement

`eve` `>=0.27.0 <1.0.0`. The range is wide on purpose — the consumed surface is one small
interface — and `src/eve-compatibility.test.ts` typechecks the backend against both the range's
floor and the newest verified release, so `pnpm typecheck` is part of the contract.

## Testing

- `pnpm test` — unit tests. The cloud sits behind a small `Provider` interface with an in-memory
  fake, so they run anywhere and create nothing.
- `pnpm sweep` — lists live sandboxes in the account; see [Cost](#cost).
- `pnpm smoke` — the contract test against the **real** service, using `.env.local`. It creates
  billable sandboxes, destroys every one in `finally`, and ends by reporting how many remain in
  the account. Prints `ALIYUN SMOKE OK`. Run it before changing `src/e2b-provider.ts`,
  `src/archive.ts`, or `src/network-policy.ts`: twice during development the service disagreed
  with what the documentation and the SDK types implied.

```bash
pnpm lint && pnpm fmt:check && pnpm typecheck && pnpm test && pnpm build
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
