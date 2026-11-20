# AGENTS.md

This file applies to the entire repository. It is working guidance for coding
agents; user-facing behavior belongs in `README.md`.

## What this repository is

One published package, `@jinshuju/eve-sandbox-aliyun`: an eve sandbox provider
(`defineSandboxProvider`, eve 1.x) on Aliyun's cloud sandbox (FC Agent
Sandbox), which speaks the E2B protocol. It implements eve's connection-based
provider contract (eve >= 0.83): a byte-level `SandboxConnection` that eve
builds the session on. 0.4.x implemented the handle-based contract of eve
0.75-0.82; 0.2.x the `SandboxBackend` interface eve 0.64 removed.

## Start here

Read `README.md` first — particularly **How it works** and **Compatibility
notes**. Several non-obvious behaviors are deliberate:

- A template is a delta archive (`find -cnewer` against a marker), not a
  provider snapshot, because the provider has none. `ctime`, not `mtime`:
  package managers restore old mtimes on the files they install.
- `stop()` tries pause, and falls back to checkpoint-then-destroy. Pause is an
  allow-listed account feature; the fallback is what most accounts get.
- eve requires `start()` to be an idempotent upsert per `ctx.session.id`, across
  processes, and the service has no create-if-absent. A session's sandbox is
  labelled `eveSessionId`; `start()` adopts a labelled sandbox only once its
  session file (`STATE_DIR/session.json`, written last at creation) exists, and
  takes the env from that file, not from its own `open()` options. It never
  kills another sandbox: two processes racing to create can leave a second
  one, which session end destroys. Do not "fix" the race by killing the loser —
  the loser may already be serving a turn.
- `resume()` never recreates: a sandbox that is gone throws
  `SandboxSessionGoneError`, eve reruns the selector, and the `start()` that
  follows restores the session's checkpoint (keyed by session id), else the
  template. On an account without pause, stop and idle end in checkpoint-then-
  destroy, so this is the normal path, not an error path.
- `onSessionIdle()` must never resume a paused sandbox, and connecting does. It
  asks `Provider.getState()` first and only connects to a running one.
- State written by 0.4 (`version: 1`, with a per-start `sessionKey`) is still
  accepted by `resume()` and `onSessionEnd()`, so sessions in flight survive
  the upgrade: its checkpoint moves to the session-id path when its sandbox is
  gone, and its `eveSessionKey`-labelled sandboxes are destroyed at session end.
- Unsupported network policy shapes throw. Never degrade a policy silently —
  widening egress or dropping a header rule is a security bug, not a fallback.

## The platform disagrees with its documentation

Treat the live service as the source of truth, above both Aliyun's docs and the
E2B SDK's types. Each of these was found by probing, and each would have shipped
as a bug otherwise:

- e2b releases after 2.31.0 create sandboxes through `POST /v2/sandboxes`, which
  Aliyun answers with `405`.
- `createSnapshot` is rejected; `pause` is `403` unless the account is allow-listed.
- A `network` block that is present but empty is rejected at create, yet is
  exactly how restrictions are cleared on update.
- `commands.kill` reaps child processes here, which upstream envd does not promise.
- Templates are not all Debian. `code-interpreter-v1` is, but custom ones can be
  Wolfi/Alpine with a BusyBox userland: no `find -cnewer`, no `tar --null`, no
  `sudo`, no `~/.profile`. 0.2.0's capture script failed there, and silently —
  the only symptom was "captured archive is missing". Anything in
  `src/archive.ts` must run on both; `src/archive.test.ts` guards the flags.
- `PUT /sandboxes/{id}/network` replaces the egress block, and the SDK says
  omitted fields are cleared, yet it leaves `allowPublicTraffic` as created: a
  sandbox created closed stays closed across every `setNetworkPolicy()` shape.
  The smoke test asserts this; if it ever fails, `updateNetwork` has to carry
  the field (the SDK's update body cannot).
- On accounts that do have pause, the SDK object that paused a sandbox is dead
  afterwards (`500` on any call); only a fresh `connect` by id works. Reported by
  the GitLab-hosted predecessor of this package. Never reuse a handle after
  `pause()`. Whether the smoke test takes the pause path or the checkpoint path
  depends on the key in `.env.local`; it prints which ("resumed by pause" or
  "restored from checkpoint"), and both have been seen passing.

So: run `pnpm smoke` before pushing changes to `src/e2b-provider.ts`,
`src/archive.ts`, or `src/network-policy.ts`. It needs `.env.local` and creates
billable sandboxes; it destroys every one in `finally` and reports what remains.
`pnpm sweep` lists (and with `--kill` destroys) what a crashed run left behind.

## The e2b pin is the central invariant

`dependencies.e2b` must be exactly `2.31.0` — not a range. **The lockfile hides a
range**: this repo always installs 2.31.0, so every test passes, while consumers
resolve the range and get an SDK that cannot create a sandbox. That mistake
reached a release candidate once. Two things keep it from recurring — do not
remove one without replacing it:

1. `src/package-manifest.test.ts` asserts the exact specifier.
2. The CI `pack` job installs the real tarball into a clean project and asserts
   the e2b version the _installed package_ resolves. This is the check that
   actually models a consumer.

Moving the pin means proving a newer SDK works against the live service first.

## The eve peer range

`peerDependencies.eve` is `>=1.0.0 <2.0.0`. The provider contract it implements
arrived in eve 0.83, a minor release, and 0.4.x's range (`>=0.75.0 <1.0.0`)
went on claiming 0.83-0.91 without working on them; the drift check caught it.
1.0.0 is the floor because the owner chose to support eve 1.x, 1.0.x included.
1.1 added the optional `onSessionIdle`: an eve 1.0 runtime never calls it, so on
1.0 nothing stops an idle sandbox (README says so). The source therefore builds
against eve >= 1.1 (the `eve` devDependency); against 1.0's types the
`onSessionIdle` member is an excess property. Consumers on 1.0 are unaffected —
the published `.d.ts` only names eve's implementation type — and the floor test
plus the CI pack job on 1.0.0 cover them.
Three mechanisms keep the range honest:

1. `src/eve-compatibility.test.ts` typechecks the provider against the range's
   floor (`eve-floor`) and the newest verified eve. These are **type-level**
   tests, so `pnpm typecheck` must run in CI, not just `pnpm test`.
2. The CI `pack` job imports the tarball against both ends of the range —
   `dist/index.js` imports a _value_ (`defineSandboxProvider`) from
   `eve/sandbox/provider`, so a version that typechecks could still fail to load.
3. `.github/workflows/eve-drift.yml` re-runs the suite against `eve@latest` on a
   schedule and opens an issue on failure. It is the only thing covering the
   `<2.0.0` ceiling.

Raising the floor means changing `peerDependencies.eve` **and** the `eve-floor`
devDependency together; a test asserts they name the same minor line.

## How to work here

- Test first: write the failing test, watch it fail for the right reason, then
  implement the smallest change. Work on a branch, conventional commits, PR,
  merge.
- The cloud sits behind the `Provider` interface (`src/provider.ts`). Unit tests
  use the in-memory fake in `src/testing/`, so they create nothing and run
  anywhere. A test that needs the real service belongs in
  `src/integration/aliyun-provider-smoke.ts`.
- `src/testing/` is excluded from the published build. Keep test-only code there.
- Never commit secrets. `.env*` is ignored; `.env.example` holds names only.
  This repository is public, history included: a secret that reaches any pushed
  commit is leaked even if a later commit removes it, and must be rotated.

## Verification

```bash
pnpm lint && pnpm fmt:check && pnpm typecheck && pnpm test && pnpm build
```

That is what CI's `verify` job runs. CI also runs `pack`. `pnpm smoke` is not in
CI: it needs credentials and costs money.

## Releases

Conventional commits drive release-please, which keeps one open release PR.
Nothing publishes while that PR sits there; merging it is the decision to
release. The merge tags the commit and cuts a GitHub release, and only then does
the `publish` job run. Do not hand-edit `version` in `package.json` or
`.release-please-manifest.json`.

Only `feat`, `fix`, `perf` and `revert` commits produce a release; `docs`, `ci`,
`chore`, `test` and `refactor` are hidden from the changelog and do not.

`prepack` builds `dist/`, the only code the tarball ships. It is written as
`npm run build`, not `pnpm build`, because `npm publish` is what triggers it.

Publishing uses **npm trusted publishing (OIDC)**. There is no `NPM_TOKEN`
anywhere and there should never be one: the `id-token: write` permission lets
npm verify the workflow's identity directly, and because this repository and the
package are both public, npm attaches a provenance attestation on its own. Do
not add `--provenance` — that flag is for token-based publishing.

Trusted publishing cannot cover the _first_ publish of a name, so 0.1.0 was
published by hand and the trusted publisher was configured afterwards against
this repository and `release.yml`. If the package is ever unpublished and
recreated, or the repository or workflow file is renamed, that configuration has
to be redone on npmjs.com.
