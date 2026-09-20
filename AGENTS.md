# AGENTS.md

This file applies to the entire repository. It is working guidance for coding
agents; user-facing behavior belongs in `README.md`.

## What this repository is

One published package, `@jinshuju/eve-sandbox-aliyun`: an implementation of eve's
`SandboxBackend` interface on Aliyun's cloud sandbox (FC Agent Sandbox), which
speaks the E2B protocol.

## Start here

Read `README.md` first — particularly **How it works** and **Compatibility
notes**. Several non-obvious behaviors are deliberate:

- A template is a delta archive (`find -cnewer` against a marker), not a
  provider snapshot, because the provider has none. `ctime`, not `mtime`:
  package managers restore old mtimes on the files they install.
- `stop()` tries pause, and falls back to checkpoint-then-destroy. Pause is an
  allow-listed account feature; the fallback is what most accounts get.
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

So: run `pnpm smoke` before pushing changes to `src/e2b-provider.ts`,
`src/archive.ts`, or `src/network-policy.ts`. It needs `.env.local` and creates
billable sandboxes; it destroys every one in `finally` and reports what remains.

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

`peerDependencies.eve` is `>=0.27.0 <1.0.0`, wide on purpose. Three mechanisms
keep it honest:

1. `src/eve-compatibility.test.ts` typechecks the backend against the range's
   floor (`eve-floor`) and the newest verified eve. These are **type-level**
   tests, so `pnpm typecheck` must run in CI, not just `pnpm test`.
2. The CI `pack` job imports the tarball against both ends of the range —
   `dist/backend.js` imports a _value_ from `eve/sandbox`, so a version that
   typechecks could still fail to load.
3. `.github/workflows/eve-drift.yml` re-runs the suite against `eve@latest` on a
   schedule and opens an issue on failure. It is the only thing covering the
   `<1.0.0` ceiling.

Raising the floor means changing `peerDependencies.eve` **and** the `eve-floor`
devDependency together; a test asserts they name the same minor line.

## How to work here

- Test first: write the failing test, watch it fail for the right reason, then
  implement the smallest change. Work on a branch, conventional commits, PR,
  merge.
- The cloud sits behind the `Provider` interface (`src/provider.ts`). Unit tests
  use the in-memory fake in `src/testing/`, so they create nothing and run
  anywhere. A test that needs the real service belongs in
  `src/integration/aliyun-backend-smoke.ts`.
- `src/testing/` is excluded from the published build. Keep test-only code there.
- Never commit secrets. `.env*` is ignored; `.env.example` holds names only.

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
anywhere and there should never be one. Do not add `--provenance` — that flag is
for token-based publishing. npm attaches provenance on its own only for public
source repositories; this one is private, so releases carry no attestation.

Trusted publishing cannot cover the _first_ publish of a name, so 0.1.0 was
published by hand and the trusted publisher was configured afterwards against
this repository and `release.yml`. If the package is ever unpublished and
recreated, or the repository or workflow file is renamed, that configuration has
to be redone on npmjs.com.
