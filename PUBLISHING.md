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

`release:*` detects changed packages, bumps only those packages, refreshes the lockfile, runs tests/builds, commits, creates package-scoped tags, and pushes.

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

The GitHub Release workflow does not publish packages again. It rebuilds, verifies, packs the root tarball, and uploads that tarball asset to the GitHub Release.

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

`npm run build` attempts the native workspace build when Cargo is available. Use `npm run build:native` when you want to rebuild the native addon without rebuilding `dist/`, or when release/publish flows should fail fast if Rust is missing.

2. Create the per-target npm package directories:

```powershell
npm run native:create-npm-dirs
```

3. For a local single-platform release, stage the binary you just built:

```powershell
npm run native:stage-local
```

For multi-platform releases, collect CI artifacts into `packages/codegraph-native/npm/<target>/` instead.

4. Sync the native meta package so its `optionalDependencies` only reference staged binaries:

```powershell
npm run native:sync-meta
```

5. Publish the staged per-platform binary packages:

```powershell
npm run publish:native:targets
```

6. Publish the native meta package:

```powershell
npm run publish:native:meta
```

7. Publish the root package:

```powershell
npm publish
```

8. Publish the fallback package when it changed:

```powershell
npm publish --workspace=@lzehrung/codegraph-js-fallback
```

## Release Notes

- Root releases create both `v1.8.44` and `@lzehrung/codegraph@1.8.44`; workspace package releases keep package-scoped tags like `@lzehrung/codegraph-native@1.8.44`.
- `@lzehrung/codegraph`, `@lzehrung/codegraph-native`, and `@lzehrung/codegraph-js-fallback` version independently.
- `src/native/treeSitterNative.ts` prefers the installed `@lzehrung/codegraph-native` package and falls back to the local workspace package for development.
- If a native binary or query is unavailable at runtime, Codegraph automatically uses the JS Tree-sitter implementation.
