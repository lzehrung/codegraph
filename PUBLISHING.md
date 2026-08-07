# Publishing Guide

codegraph publishes two top-level npm packages:

- `@lzehrung/codegraph`: the main JS package and CLI
- `@lzehrung/codegraph-native`: the optional native Tree-sitter meta package plus per-platform binary packages

The main package depends on the native package optionally, so installs still succeed when no matching native binary exists. When native is unavailable, codegraph degrades to reduced graph-only and regex recovery mode; there is no separate JavaScript parser fallback package.

## Local Release Commands

The local release scripts remain available for package-scoped maintenance and recovery:

```powershell
npm run release:patch
npm run release:minor
npm run release:major
npm run release:resume

npm run publish:patch
npm run publish:minor
npm run publish:major
npm run publish:resume
```

`release:*` detects changed packages, updates versions and the lockfile, runs the local release checks, commits, tags, and pushes. `publish:*` also publishes from the local checkout.

These commands do not provide the full cross-platform certification evidence chain. Use the GitHub `release` workflow for a normal public release; use local publishing only for deliberate recovery with all target artifacts already collected.

You can force a package-scoped local release with `--package`:

```powershell
npm run publish:patch -- --package root
npm run release:minor -- --package @lzehrung/codegraph-native
```

## GitHub Release Workflow

Use the manually triggered `release` GitHub Actions workflow for a complete certified release. Select `release_type=patch|minor|major`; the workflow publishes the certified packages, then builds, smokes, and attaches the standalone preview assets.

The workflow uses this immutable byte flow:

1. Plan the source revision and root/native versions.
2. Build all native target directories.
3. Build the root package, then run `npm pack` exactly once for each target package, the native meta package, and the root package.
4. Store those tarballs under `temp/release-candidates/packages/`.
5. Record every relative path, package identity, target, SHA-256 digest, and size in `release-candidate-manifest.json`; write the matching `SHA256SUMS`.
6. Run production security, fixture hermeticity, package smoke, reduced-mode, and checked-in release semantic gates.
7. Merge the gate outputs into `CertificationReportV1`.
8. Revalidate every candidate checksum and required report row before the first registry write.
9. Publish the tarball paths from the manifest, without rebuilding or repacking.
10. Attach the same tarballs, manifest, checksums, package summary, and certification report to the GitHub Release.

### Standalone release assets

The `release` workflow invokes `standalone-release` automatically after the certified package release and `v<version>` GitHub Release exist. `standalone-release` remains manually dispatchable with an existing release tag for deliberate recovery or reruns.

It downloads the certified package assets from that release, then builds and verifies these self-contained preview assets:

```text
codegraph-win32-x64.zip
codegraph-win32-arm64.zip
codegraph-darwin-x64.tar.gz
codegraph-darwin-arm64.tar.gz
codegraph-linux-x64.tar.gz
codegraph-linux-arm64.tar.gz
install.ps1
install.sh
SHA256SUMS
```

Each archive contains a target-matching Node.js runtime, the built CLI, production dependencies, matching native packages, the bundled skill, licenses/notices, relative launchers, and `manifest.json`. The manifest records `schemaVersion: 1`, `channel: "standalone-preview"`, version, target, native suffix, Node version, source revision, and per-file SHA-256 records.
The Linux standalone archives bundle glibc Node and GNU native targets. The bootstrap rejects musl hosts; musl remains supported through the certified package channel, not these standalone assets.

The standalone matrix assembles archives from the released immutable package candidates plus a target-matching Node runtime. Five targets run versioned installation plus `version` and `doctor`; `win32-arm64` receives structural bundle verification only and must not be described as runtime-certified.

Only archives that pass their matrix gate are uploaded as `standalone-smoked-*`. The aggregation job copies those exact archives without rebuilding, adds `install.sh` and `install.ps1` from the tagged source revision, and generates one combined `SHA256SUMS`.

The standalone publish job attaches that post-smoke artifact to the existing GitHub Release. It does not rebuild or repackage standalone assets after smoke. Package publication happens first; if standalone assembly fails, the published packages remain available while the overall `release` workflow reports the standalone failure.

The bootstrap scripts preview their target and user-owned paths, confirm interactively or require explicit `-Yes`/`--yes`, verify the selected archive against `SHA256SUMS`, reject unsafe archive entries, and run bundled `version` and `doctor`. For a same-version root, bundled Node verifies both roots and requires exact target, native suffix, source revision, Node version, and per-file path, size, and SHA-256 manifest matches before reuse; a mismatch leaves the launcher and install manifest unchanged. They install under a versioned root, atomically replace the launcher and manifest with rollback, retain the previous version, and record channel, target, release URL, archive hash, verification method, and previous/current versions.

Checksums prove integrity only after the release download is trusted. Until signing or attestation is wired into this channel, retain the `standalone-preview` label and do not describe the assets as signed.

The package smoke runner installs local candidate tarballs into a fresh temporary directory outside the checkout. Runtime rows compare installed file paths, sizes, and SHA-256 hashes with the certified tarball contents, then verify root/native imports, `version`, `doctor`, a native symbol parse, and a stdio MCP initialize/list-tools/search exchange.

Linux musl rows execute inside matching-architecture Alpine containers. A separate reduced row installs the root tarball with optional dependencies omitted and proves the packed CLI starts without native code.

### Native certification classes

- Runtime: `win32-x64-msvc`, `linux-x64-gnu`, `linux-arm64-gnu`, `linux-x64-musl`, `linux-arm64-musl`, `darwin-x64`, and `darwin-arm64`.
- Structural: `win32-arm64-msvc`.

`win32-arm64-msvc` is inspected but never loaded by the current workflow. Its reviewed exception is owned and expiry-bounded in `scripts/certification/native-target-exceptions.json`; when it expires, certification fails until a matching runtime host is added or the exception is reviewed again.

A structural result proves archive checksum, package identity, target naming, and required files only. It must never be described as runtime-certified.

### Publish authorization

Publishing waits for every required package row plus security, semantics, and hermeticity. Missing, failed, stale-revision, wrong-version, expired-exception, size, or checksum evidence stops the job before `npm publish` is invoked.

The workflow exposes the `PACKAGE_PUBLISH_TOKEN` Actions secret as both `NODE_AUTH_TOKEN` for `actions/setup-node` and `GITHUB_TOKEN` for the repository `.npmrc` in the registry preflight and publication job. It must contain a current classic personal access token with `read:packages` and `write:packages`; GitHub Packages does not support fine-grained personal access tokens for this purpose.

## Package Roles

- `@lzehrung/codegraph`
  - Publishes `dist/` and the CLI.
  - Loads `@lzehrung/codegraph-native` when present.
  - Drops to reduced graph-only and regex recovery mode when native is unavailable.
- `@lzehrung/codegraph-native`
  - Publishes the meta package.
  - Resolves and loads the correct per-platform binary package.

## Manual Native Staging

Use these when you need to inspect or customize the native publish flow manually.

These steps do not produce `CertificationReportV1` and do not establish that published bytes equal certified candidates. Do not use direct manual publishing as the normal release path.

1. Build the JS package and the local native workspace addon:

```powershell
npm run build
```

`npm run build` rebuilds `dist/` and requires the native workspace build to succeed when Cargo is available. Use `npm run build:native` when you want to rebuild the native addon without rebuilding `dist/`, or when release/publish flows should fail fast if Rust is missing.

2. Create the per-target npm package directories:

```powershell
npm run native:create-npm-dirs
```

3. For a local smoke check, stage the binary you just built:

```powershell
npm run native:stage-local
```

This is not enough for a publish. For a native release, collect CI artifacts for every target in `packages/codegraph-native/npm/<target>/`.

4. Verify that every supported target package has a staged binary:

```powershell
npm run native:check-artifacts
```

The supported target set is read from `packages/codegraph-native/package.json` `napi.targets`. Publishing now fails if any supported target is missing, so the native meta package cannot accidentally publish with only the platform that built the release.

5. Sync the native meta package so its `optionalDependencies` reference every supported binary package:

```powershell
npm run native:sync-meta
```

6. Publish the staged per-platform binary packages:

```powershell
npm run publish:native:targets
```

7. Publish the native meta package:

```powershell
npm run publish:native:meta
```

8. Publish the root package:

```powershell
npm publish
```

The root package should be published last so its optional native dependency points at the final native meta version.

## Windows Native Cache Validation

Before publishing a cache-enabled release:

- package both `win32-x64-msvc` and `win32-arm64-msvc` target artifacts;
- run `npm run test:native` on Windows, including the live-process source-rename integration test;
- install the packed root package into a synthetic or disposable prefix and confirm `codegraph doctor` reports `native.origin.mode` as `cache`;
- verify a cache-loaded process remains healthy while its synthetic package source is renamed;
- verify a global update succeeds while a cache-enabled MCP process remains alive;
- verify the old process reports restart required and a new process reports the new version and cache key;
- state the one-time stop-update-restart requirement in the first cache-enabled release notes.

Do not claim updates are universally lock-free. The supported claim is that codegraph no longer maps the npm-owned native addon; antivirus, backup tools, and stale npm retirement paths can still cause `EBUSY`.

## Release Notes

- `@lzehrung/codegraph` and `@lzehrung/codegraph-native` version independently.
- `src/native/bindingLoader.ts` loads a local workspace binary directly, caches installed Windows binaries, and uses the installed native package directly on other platforms or as a safe fallback.
- If the cache is unavailable, codegraph records the cache error and preserves the existing native package fallback; if native loading or a query remains unavailable, it degrades to reduced graph-only and regex recovery mode.
