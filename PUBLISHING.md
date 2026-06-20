# Publishing Guide

Codegraph publishes as two standalone packages:

- `@lzehrung/codegraph`: the main JS package and CLI
- `@lzehrung/codegraph-native`: the optional native Tree-sitter meta package plus per-platform binary packages

The main package depends on the native package optionally, so installs still succeed when no matching native binary exists. When native is unavailable, Codegraph degrades to reduced graph-only and regex recovery mode; there is no separate JavaScript parser fallback package.

## Fast Path

The root release scripts now use independent package versioning:

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

`release:*` detects changed packages, bumps only those packages, refreshes the lockfile, requires the native addon to build or load for the current platform, runs tests/builds, commits, creates package-scoped tags, and pushes.

`publish:*` does the same work and also publishes:

- staged native target packages plus the `@lzehrung/codegraph-native` meta package when `@lzehrung/codegraph-native` is selected
- the root `@lzehrung/codegraph` package when it changed

When a publish includes `@lzehrung/codegraph-native`, the script verifies the complete supported native target set before running the full test suite. A local WSL/macOS/Windows shell can only build its own target, so use the `release` GitHub Actions workflow or manually collect every target artifact before running a native publish locally.

You can force a package-scoped release with `--package`:

```powershell
npm run publish:patch -- --package root
npm run release:minor -- --package @lzehrung/codegraph-native
```

## GitHub Release Workflows

Use the `release` GitHub Actions workflow when you want GitHub to cut a complete release.

- Trigger it manually with `release_type=patch|minor|major`.
- The workflow builds every target declared in `packages/codegraph-native/package.json` `napi.targets`.
- It collects the per-target npm package artifacts, then runs `npm run publish:<release_type> -- --package root --package native`.
- The publish step verifies that every supported native target artifact is present before publishing target packages, the native meta package, and the root package.
- On success it pushes all package tags, creates or updates the overall `vX.Y.Z` GitHub Release for the root package version, and uploads the root `.tgz` asset.
- The workflow refuses reruns from a commit that is already tagged for the current root version. A fresh Actions runner cannot reconstruct the dirty local resume state that `publish:resume` expects.
- By default the workflow uses `GITHUB_TOKEN` for GitHub Packages. If an existing package is not linked to this repository or does not grant this repository write access, create a `PACKAGE_PUBLISH_TOKEN` Actions secret from a classic PAT that can write the `@lzehrung` packages; the workflow will use it for npm publishing.

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

## Release Notes

- `@lzehrung/codegraph` and `@lzehrung/codegraph-native` version independently.
- `src/native/treeSitterNative.ts` prefers the installed `@lzehrung/codegraph-native` package and falls back to the local workspace package for development.
- If a native binary or query is unavailable at runtime, Codegraph degrades to reduced graph-only and regex recovery mode.
