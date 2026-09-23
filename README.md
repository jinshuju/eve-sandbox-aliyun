# @jinshuju/eve-sandbox-aliyun

[![npm](https://img.shields.io/npm/v/@jinshuju/eve-sandbox-aliyun)](https://www.npmjs.com/package/@jinshuju/eve-sandbox-aliyun)

An [Aliyun cloud sandbox](https://help.aliyun.com/zh/functioncompute/sandbox-function/)
(FC Agent Sandbox) sandbox provider for [eve](https://eve.dev) agents. It gives agent-executed
code a real, remote Linux machine — real binaries, passwordless `sudo`, a firewall with
credential brokering — with nothing to run on the host but Node.

## Usage

```bash
npm install @jinshuju/eve-sandbox-aliyun
```

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { AliyunSandbox } from "@jinshuju/eve-sandbox-aliyun";

export const environment = AliyunSandbox.environment();
export default defineSandbox(() => environment.open());
```

Aliyun's sandbox speaks the E2B protocol, so the connection uses the variables Aliyun documents:

```bash
E2B_API_KEY=...
E2B_DOMAIN=cn-hangzhou.e2b.fc.aliyuncs.com
E2B_API_URL=https://api.cn-hangzhou.e2b.fc.aliyuncs.com   # optional; derived from the domain
```

Credentials are read on first use, not when `AliyunSandbox.environment()` is called, so the
sandbox module can be imported at build time. There is deliberately no default endpoint: the
underlying SDK defaults to e2b.dev, and quietly sending an Aliyun key there would be the wrong way
to fail.

Everything eve documents for a sandbox works — `prepare`, `open()` options, seeded
`agent/sandbox/workspace/**`, skills under `$HOME/.agents/skills`, and the full session API:

```ts
export const environment = AliyunSandbox.environment({
  networkPolicy: { allow: ["deb.debian.org"] },
  // Once, at build time; what it leaves on disk is the template every session starts from.
  async prepare(sandbox) {
    const result = await sandbox.run({
      command: "sudo apt-get update -qq && sudo apt-get install -y -qq jq",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  },
});

// Once per session, when it first touches the sandbox.
export default defineSandbox(() => environment.open({ networkPolicy: "deny-all" }));
```

### Per-session options

`open()` takes an `env` and a `networkPolicy` for that session. `env` adds variables to every
command in the session — no env file on disk, no login-shell tricks. Per-call `env` still wins,
and the environment's `env` sits underneath. `networkPolicy` is in force from the moment the
session's sandbox starts:

```ts
export default defineSandbox(({ session }) =>
  environment.open({ env: { API_TOKEN: mintToken(session.id) } }),
);
```

eve runs the selector once per session and never again, so both travel in eve's session state and
are still there on the next turn, after a pause, and in a replacement sandbox. That also means
they are stored with the session: `env` is visible to anything running in the sandbox, and a
`networkPolicy` with header `transform`s is persisted with its headers. For a secret shared by
every session, put the `transform` on the environment's `networkPolicy`, which lives only in the
build.

Anything else the selector does after `open()` — writing a file, running a command — happens once,
in the sandbox that session started with. Setup every session needs belongs in `prepare`, and
per-session values in `open()`, so that a [replacement sandbox](#compatibility-notes) has them too.

[`examples/basic`](./examples/basic) is a complete agent (DeepSeek model, a seeded data file, a
`prepare` that installs `jq`, a per-session `env`).

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
| `networkPolicy` | `"allow-all"`                              | Egress policy every sandbox starts with, `prepare` included, unless the session's `open()` names one.                                                                                 |
| `metadata`      | `{}`                                       | Extra metadata labels on every sandbox, e.g. `{ agent: "support" }` for `pnpm sweep --tag agent=support`.                                                                             |
| `prepare`       | —                                          | `(sandbox) => Promise<void>`, run once at build time after the seed files are written. What it leaves on disk becomes the template.                                                   |
| `cacheDir`      | `<appRoot>/.eve/sandbox-cache/aliyun`      | Where template archives and session checkpoints are kept. Pin it outside the release directory so a redeploy does not discard them.                                                   |

## How it works

Aliyun's sandbox has **no snapshots** (`sandbox runtime does not support snapshot`), and
pause/resume is an allow-listed account feature. eve's model — a template captured once at
build time, durable sessions opened from it — is rebuilt on what the platform does have.

- **Base runtime.** A fresh sandbox has no `/workspace`, and the default user cannot create one.
  Before anything else, a root step creates a user-owned `/workspace` and drops a marker file.
- **prepare** (`eve build`, or the first sandbox access in `eve dev`) starts a throwaway
  sandbox, writes the seed files, runs your `prepare`, then archives **every filesystem entry
  whose inode changed since the marker** and downloads it to `cacheDir/templates/`. The sandbox
  is destroyed either way. eve records only the archive's name in the build; an archive already
  built for the same source, seeds, base template and `env` is reused. Comparing `ctime` rather
  than `mtime` is deliberate: package managers restore old mtimes on the files they install, so
  an mtime comparison would miss exactly the `apt-get install` a `prepare` is for. With nothing
  to seed and no `prepare`, no template is built at all.
- **start** (once per session) creates the session's sandbox with its egress policy already in
  force and restores the template into it. eve persists the state it returns — the sandbox id, a
  session key unique to this start, and the `open()` options — and never updates it.
- **resume** (every later access, in any process) reattaches when it can — first by the recorded
  sandbox id, then by the session key stored in the sandbox's metadata — and otherwise starts a
  fresh sandbox and restores an archive into it. A session checkpoint wins over the template,
  since it already contains the template it grew from.
- **run / spawn** go through the sandbox's login shell as the unprivileged user, in
  `/workspace`. `kill()` ends the process and its children.
- **stop / runtime shutdown** kill the session's processes, then release the compute. Where the
  account has pause, the sandbox is paused and resumes intact on the next `resume`. Where it does
  not, the session's filesystem delta is checkpointed to `cacheDir/sessions/` and the sandbox is
  destroyed; the next `resume` restores it into a new sandbox. `sandbox.stop()` rejects on
  failure; shutdown never throws.
- **delete** destroys the sandbox and its checkpoint. Templates are shared and survive.

## Network policy

All three of eve's forms work — on the environment, per session in `open()`, and mid-turn through
`sandbox.setNetworkPolicy()` with no sandbox restart:

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

Differences from eve's Vercel provider, which throw rather than silently changing what you asked
for — on the environment, when the sandbox module loads:

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
  arrives as U+FFFD. eve's own Vercel provider has the same model. File reads and writes are
  byte-exact; move binary data through files.
- **Custom templates can be BusyBox-based.** Base setup, capture and restore use only what GNU
  and BusyBox userlands share (`bash`, `find`, `stat`, `awk`, `tar`), and are verified against a
  Debian template and a Wolfi one. Such images often have no `sudo` and no `~/.profile`, so a
  `prepare` written for Debian may need adjusting — e.g. `~/.local/bin` is not on `PATH`
  unless you put it there with `env`.
- **A checkpoint is a delta, not an image.** It records what was added or changed since base
  setup, not deletions of files that shipped in the base image, and `/tmp`, `/var/tmp`,
  `/var/cache`, `/var/log` and apt's package lists are excluded. Memory and running processes
  only survive `stop()` on accounts with pause.
- **Templates live in `cacheDir`.** If you build on one machine and run on another, ship the
  directory with the build or point both at shared storage.
- **A sandbox lost to the idle timeout** is replaced from the latest checkpoint, or the template,
  with the session's `open()` options applied again. eve's built-in providers fail the session
  instead; this one keeps it working, because on an account without pause the idle timeout is
  the normal way a sandbox ends. What the selector did after `open()`, and files written since
  the last checkpoint, are not replayed — keep setup in `prepare` and per-session values in
  `open()`. A policy changed mid-session with `setNetworkPolicy()` reverts to the session's.

## Cost

Sandboxes bill while they run. eve sessions are durable, so a process exiting does **not** stop
its sandbox: after `eve invoke` returns, the sandbox idles until `timeoutMs` elapses. Keep
`timeoutMs` as low as your turn cadence allows, and call `ctx.getSandbox().stop()` (or
`.delete()`) when a task is finished.

`pnpm sweep` lists what is still running in the account. With `--kill` it destroys the provably
disposable sandboxes — smoke runs and template builds — and, with `--tag agent=<name>`, the ones
carrying that label from the environment's `metadata`. Session sandboxes are never touched unless
a `--tag` names them.

## Troubleshooting

| Symptom                                            | Likely cause                                                                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `405` when creating a sandbox                      | A newer `e2b` was hoisted over this package's pin. It must resolve to exactly `2.31.0`.                                                   |
| Requests go to e2b.dev, or `missing an endpoint`   | `E2B_DOMAIN` (or `region`) is not set. There is no default endpoint on purpose.                                                           |
| `SandboxTemplateNotProvisionedError` in production | `cacheDir` did not travel with the build. Ship it, or point build and runtime at shared storage.                                          |
| `prepare` cannot reach the network                 | The environment's `networkPolicy` governs `prepare` too. Allow the package mirrors there and tighten per session in `open()`.             |
| `500` from a sandbox object right after pausing it | A paused sandbox's old handle is dead; reconnect by id. This package always does — it only bites code that drives the `e2b` SDK directly. |
| Sandboxes pile up                                  | `timeoutMs` is a backstop, not collection. Call `stop()`/`delete()` when work ends, and check with `pnpm sweep`.                          |

## eve version requirement

`eve` `>=0.64.0 <1.0.0`. eve 0.64 replaced the `SandboxBackend` interface with sandbox providers;
0.2.x of this package is the one for eve `<0.64`. The ceiling is wide on purpose — the consumed
surface is one small interface — and `src/eve-compatibility.test.ts` typechecks the provider
against both the range's floor and the newest verified release, so `pnpm typecheck` is part of the
contract.

### Migrating from 0.2

| 0.2 (eve `<0.64`)                               | 0.3 (eve `>=0.64`)                                               |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `defineSandbox({ backend: aliyun(options) })`   | `export const environment = AliyunSandbox.environment(options)`  |
| `bootstrap({ use })`                            | `prepare(sandbox)` in the environment options                    |
| `revalidationKey`                               | gone: eve tracks the sandbox source, seeds and options itself    |
| `onSession({ use, ctx })` + `use({ env, ... })` | `defineSandbox(({ session }) => environment.open({ env, ... }))` |
| eve's `agent` / `sessionId` tags on sandboxes   | `metadata` in the environment options, plus `eveSessionId`       |

Sessions do not carry over: eve 0.64 cannot resume a session whose sandbox state 0.2 wrote.

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
