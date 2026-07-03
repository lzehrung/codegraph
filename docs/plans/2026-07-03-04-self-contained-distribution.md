# Self-contained distribution

## Goal

Reduce install friction for CLI users who do not already have the required Node.js version or registry configuration, while preserving the current npm/library package model.

## Design

Add an optional release artifact channel that bundles a Node runtime with the built CLI. Do not replace the existing `@lzehrung/codegraph` package in this PR.

Release artifacts:

```text
codegraph-linux-x64.tar.gz
codegraph-linux-arm64.tar.gz
codegraph-darwin-x64.tar.gz
codegraph-darwin-arm64.tar.gz
codegraph-win32-x64.zip
codegraph-win32-arm64.zip
```

Bundle layout:

```text
codegraph-<target>/
  node | node.exe
  lib/
    dist/
    package.json
    node_modules/
  bin/
    codegraph | codegraph.cmd
```

## Build approach

Use a script under `scripts/`:

```bash
node scripts/build-bundle.mjs linux-x64
```

The script should:

- require a built `dist/`
- install production dependencies into a staging dir with `npm ci --omit=dev`
- copy package metadata and dist files
- download an official Node release for the target
- create launcher scripts
- produce archive and checksum

Do not cross-compile native Rust artifacts in this script. Use the already published/packaged native addon when available, or document reduced-mode fallback for unsupported targets.

## Installer scripts

Add minimal installers after bundle generation works:

- `install.sh`
- `install.ps1`

Behavior:

- detect OS/arch
- download matching release artifact
- verify checksum when available
- install under user-local directory
- add or print PATH instructions
- never require sudo by default

## Non-goals

- No auto-update in this PR.
- No package manager taps/casks/scoop manifests.
- No code signing or notarization.
- No change to source checkout development flow.

## Files likely touched

- new `scripts/build-bundle.mjs`
- new `install.sh`
- new `install.ps1`
- `.github/workflows/release.yml` if release automation exists or is added later
- `docs/installation.md`
- `README.md`
- `PUBLISHING.md`
- `codegraph-skill/codegraph/SKILL.md` only if install guidance changes
- tests under `tests/release-script.test.ts` or new installer tests

## Tests

- bundle script rejects missing `dist/` with clear message.
- bundle contains launcher, Node binary, dist, package metadata, and production deps.
- launcher invokes `dist/cli.js version` successfully on current platform.
- installer target detection maps known OS/arch pairs correctly.
- installer refuses unsupported target clearly.

## Acceptance

- A release artifact can run `codegraph version` without relying on system Node.
- Existing npm install path still works.
- Documentation clearly distinguishes source, npm, and bundled install paths.

## Review pass

Checked scope: this plan makes bundled distribution an additive channel. It avoids destabilizing the current package exports, native addon model, and contributor workflow.
