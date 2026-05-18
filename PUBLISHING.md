# Publishing Guide

Codegraph publishes as three standalone packages:

- `@lzehrung/codegraph`: the main JS package and CLI
- `@lzehrung/codegraph-native`: the optional native Tree-sitter meta package plus per-platform binary packages
- `@lzehrung/codegraph-js-fallback`: the opt-in JS Tree-sitter fallback package

The main package depends on the native package optionally, so installs still succeed when no matching native binary exists. The JS fallback package is standalone and is only published when its own package changes.

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

`release:*` detects changed packages, bumps only those packages, refreshes the lockfile, reapplies the Node 24 Tree-sitter patch, rebuilds native npm dependencies, requires the native addon to build or load for the current platform, runs tests/builds, commits, creates package-scoped tags, and pushes.

`publish:*` does the same work and also publishes:

- staged native target packages when `@lzehrung/codegraph-native` is selected
- the `@lzehrung/codegraph-native` meta package when it changed
- the `@lzehrung/codegraph-js-fallback` package when it changed
- the root `@lzehrung/codegraph` package when it changed

You can force a package-scoped release with `--package`:

```powershell
npm run publish:patch -- --package js-fallback
npm run release:minor -- --package @lzehrung/codegraph-native
```

## GitHub Release Workflows

Use the `release-root` GitHub Actions workflow when you want GitHub to cut a root package release end-to-end.

- Trigger it manually with `release_type=patch|minor|major`.
- The workflow runs `npm run publish:<release_type> -- --package root`.
- On success it creates or updates the matching `vX.Y.Z` GitHub Release and uploads the root `.tgz` asset.
- The workflow refuses reruns from a commit that is already tagged for the current root version. A fresh Actions runner cannot reconstruct the dirty local resume state that `publish:resume` expects.

Use the `release-native` GitHub Actions workflow for native package releases.

- Trigger it manually with `release_type=patch|minor|major`.
- The workflow builds every target declared in `packages/codegraph-native/package.json` `napi.targets`.
- It collects the per-target npm package artifacts, then runs `npm run publish:<release_type> -- --package native`.
- The publish step still verifies that every supported target artifact is present before publishing target packages or the native meta package.

## Package Roles

- `@lzehrung/codegraph`
  - Publishes `dist/` and the CLI.
  - Loads `@lzehrung/codegraph-native` when present.
  - Falls back to the JS Tree-sitter path automatically otherwise.
- `@lzehrung/codegraph-native`
  - Publishes the meta package.
  - Resolves and loads the correct per-platform binary package.
- `@lzehrung/codegraph-js-fallback`
  - Publishes the opt-in JS fallback runtime and Tree-sitter grammars.
  - Does not depend on the root package through a local `file:` dependency.

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

9. Publish the fallback package when it changed:

```powershell
npm publish --workspace=@lzehrung/codegraph-js-fallback
```

## Release Notes

- Root releases create both `v1.8.44` and `@lzehrung/codegraph@1.8.44`; workspace package releases keep package-scoped tags like `@lzehrung/codegraph-native@1.8.44`.
- `@lzehrung/codegraph`, `@lzehrung/codegraph-native`, and `@lzehrung/codegraph-js-fallback` version independently.
- `src/native/treeSitterNative.ts` prefers the installed `@lzehrung/codegraph-native` package and falls back to the local workspace package for development.
- If a native binary or query is unavailable at runtime, Codegraph automatically uses the JS Tree-sitter implementation.
