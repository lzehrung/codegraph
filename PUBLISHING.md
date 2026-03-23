# Publishing Guide

Codegraph now publishes as two coordinated packages:

- `@lzehrung/codegraph`: the main JS package and CLI
- `@lzehrung/codegraph-native`: the optional native Tree-sitter meta package plus per-platform binary packages

The main package depends on the native package optionally, so installs still succeed when no matching native binary exists.

## Fast Path

The old release ergonomics are available again at the repo root:

```powershell
npm run release:patch
npm run release:minor
npm run release:major

npm run publish:patch
npm run publish:minor
npm run publish:major
```

`release:*` bumps both package versions, refreshes the lockfile, runs tests/builds, commits, tags, and pushes.

`publish:*` does the same work and also publishes:
- staged native target packages
- the `@lzehrung/codegraph-native` meta package
- the root `@lzehrung/codegraph` package

## Package Roles

- `@lzehrung/codegraph`
  - Publishes `dist/` and the CLI.
  - Loads `@lzehrung/codegraph-native` when present.
  - Falls back to the JS Tree-sitter path automatically otherwise.
- `@lzehrung/codegraph-native`
  - Publishes the meta package.
  - Resolves and loads the correct per-platform binary package.

## Manual Native Staging

Use these when you need to inspect or customize the native publish flow manually.

1. Build the JS and native packages:

```powershell
npm run build
npm run build:native
```

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

## Release Notes

- Keep `@lzehrung/codegraph` and `@lzehrung/codegraph-native` on the same version.
- `src/native/treeSitterNative.ts` prefers the installed `@lzehrung/codegraph-native` package and falls back to the local workspace package for development.
- If a native binary or query is unavailable at runtime, Codegraph automatically uses the JS Tree-sitter implementation.
