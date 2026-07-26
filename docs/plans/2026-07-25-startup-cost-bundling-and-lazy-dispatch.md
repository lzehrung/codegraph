# Startup cost: bundling, lazy dispatch, and compile cache

Status: Priority 0-3 implemented on branch. Measurements verified on `main` at `3024ed2b` (`v1.8.100`), Node v24.15.0,
Windows 11, on 2026-07-25. See
[performance program index](2026-07-25-performance-program-index.md) for the shared baseline.

## Goal

Remove the fixed per-invocation cost that every command pays before doing any work, and remove
the per-file cold-start penalty that dominates a first run.

## Non-goals

- No change to command behavior, output, or flag surface.
- No removal of the unbundled `dist/` layout used by tests and library consumers.
- No daemon. This plan makes one-shot invocations cheaper; it does not replace MCP.

## Verified baseline defects

### F1: The full command surface loads on every invocation

`src/cli.ts:30-59` statically imports roughly 30 command handlers. Only four commands are
dynamically imported today (`cli/sql.js`, `cli/artifact.js`, `cli/mcp.js`, `cli/graph.js`,
reached via `import()` in `src/cli.ts`).

Walking the static ESM graph from `dist/cli.js` measured:

- 283 of 335 `.js` files load eagerly, totalling 1.84 MB.
- Only 52 files (257 KB) are outside the eager graph.

Per-command closures, if each handler were lazily imported:

| Command   | Modules needed | Bytes   | Share of today's eager graph |
| --------- | -------------- | ------- | ---------------------------- |
| `install` | 4              | 32 KB   | 2%                           |
| `doctor`  | 12             | 46 KB   | 2%                           |
| `orient`  | 165            | 920 KB  | 49%                          |
| `search`  | 161            | 962 KB  | 51%                          |
| `review`  | 190            | 1180 KB | 63%                          |
| `impact`  | 204            | 1277 KB | 68%                          |
| `explore` | 210            | 1358 KB | 72%                          |

37 modules (317 KB) are reachable only from `duplicates`, `review`, `impact`, `renamePreview`,
`install`, and `drift`. Every agent query loads them and never calls them.

### F2: Fixed overhead is 262 ms before any work happens

Measured medians over 5 runs each:

- `node -e 0`: 36 ms
- `node dist/cli.js --version`: 299 ms
- `node dist/cli.js --help`: 293 ms
- `node dist/cli.js doctor`: 299 ms

Printing a version string costs 263 ms more than starting Node. `--help` and `doctor` cost the
same, which confirms the cost is module loading, not command work.

### F3: Cold start is dominated by per-file module loading

- First `import dist/cli.js` after a build: 6119 ms
- Same import warm: 301 ms

The gap is per-file overhead across 283 modules. A CPU profile of a warm `orient` on the tiny
fixture attributes roughly 80 ms of self time to ESM loader machinery alone
(`internalModuleStat`, `compileSourceTextModule`, `resolveSync`, `module_map`,
`package_json_reader`).

### F4: Node's compile cache is available and unused

Node v24 exposes `module.enableCompileCache()`. There is no reference to it, nor to
`NODE_COMPILE_CACHE`, anywhere in `src/`, `scripts/`, or `package.json`.

## Measured proof of the fix

A throwaway esbuild bundle of `dist/cli.js` (single file, 3.54 MB, `node:*` and the native
addon left external) produced byte-identical `orient --json` output and these medians:

| Entry                                | `--version` | `orient` (tiny fixture) | `search` (tiny fixture) |
| ------------------------------------ | ----------- | ----------------------- | ----------------------- |
| `dist/cli.js`                        | 299 ms      | 471 ms                  | 455 ms                  |
| bundled                              | 111 ms      | 287 ms                  | 266 ms                  |
| bundled + `NODE_COMPILE_CACHE`       | 89 ms       | not measured            | not measured            |
| `dist/cli.js` + `NODE_COMPILE_CACHE` | 283 ms      | not measured            | not measured            |

Reading of those numbers:

- Bundling removes about 185 ms per invocation. Fixed overhead drops from 263 ms to 75 ms.
- Compile cache adds a further 22 ms only once bundled, because unbundled cost is resolution
  and file I/O rather than compilation.
- Together, fixed overhead drops from 263 ms to 51 ms.

An esbuild build with `splitting: true` produced 20 chunks totalling 3.38 MB, confirming that
code splitting is viable and that lazy dispatch survives bundling.

## Priority 0: Lazy command dispatch

Convert static handler imports in `src/cli.ts` to dynamic `import()` resolved at dispatch,
matching the pattern already used for `sql`, `artifact`, `mcp`, and `graph`.

- [x] Replace the static `handle*Command` imports in `src/cli.ts` with `import()` calls
      inside each command branch.
- [x] Keep `src/cli/help.js` and `src/cli/options.js` eager. Argument validation and help text
      run before dispatch.
- [x] Keep the `runCli` export signature and `isDirectCliExecution` behavior unchanged.
- [x] Confirm no handler is imported for its side effects. If any is, make the side effect
      explicit rather than relying on import order.

Also required to hit the <30-module acceptance gate (not obvious from the original sketch):

- [x] Make `buildDoctorReport`, `collectGraph`, and `CodegraphLifecycleUserError` dynamic.
      The lifecycle error class was a silent eager pull of ~120 modules via
      `lifecycle/manifest.js`.
- [x] Use `import type` for `GraphBuildOptions` / `NativeRuntimeMode`. With
      `verbatimModuleSyntax`, `import { type X }` was emitting empty `import {}` statements
      that still loaded those modules.

Likely files: `src/cli.ts`, `tests/cli-startup-eager-modules.test.ts`.

Acceptance:

- [x] `codegraph --version`, `--help`, and `doctor` load fewer than 30 project modules,
      asserted by a test that counts resolved module URLs.
      Measured after change: `--version`/`--help` 18 modules, `doctor` 27 (was 283 for
      `--version`).
- [x] Focused CLI startup tests green; existing handler surface unchanged (dispatch only).

### Priority 0 measured result

Warm medians over 5 runs on this repository (Node v24.15.0, Windows):

| Entry | Before (plan baseline) | After Priority 0 |
| ----- | ---------------------- | ---------------- |
| `--version` | 299 ms | 139 ms |
| `--help` | 293 ms | 140 ms |
| `doctor` | 299 ms | 150 ms |

Lazy dispatch alone removes ~160 ms from fixed overhead on the unbundled path by collapsing
the eager graph from 283 modules to 18 for `--version`. Bundling (Priority 1) remains the
main cold-start lever and should compose with these split points.

### Note on interaction with bundling

Lazy dispatch alone helps the unbundled path. Bundling alone helps cold start. They compose only
if the bundle uses `splitting: true` so dynamic imports become separate chunks. Land lazy
dispatch first so the bundle has real split points to work with.

## Priority 1: Ship a bundled CLI entry -- IMPLEMENTED (`a7115e40`)

Add a bundling step to the build that emits a split ESM bundle, and point the `codegraph` bin at
it. Keep the unbundled `dist/` output intact for tests and for library consumers importing
`@lzehrung/codegraph`.

- [x] Added `scripts/bundle-cli.mjs` / `bundle-cli-lib.mjs` using esbuild 0.27.2 (now an
      explicit `devDependency`; previously only transitive via vitest) producing `dist/bin/`
      from `dist/cli.js` with `bundle: true`, `platform: "node"`, `format: "esm"`,
      `splitting: true`, and `node:*` plus `@lzehrung/codegraph-native` external.
- [x] Emit a `createRequire` banner on every chunk. Required not just for
      `src/sqlite-driver.ts`, but because some transitive CJS deps still emit bare
      `require("os")`-style calls that esbuild otherwise rewrites into a throwing helper.
- [x] Repointed `package.json` `bin.codegraph` to `dist/bin/cli.js`.
- [x] Kept `dist/index.js` and the rest of `dist/` unbundled and exported as today. Tests still
      import unbundled modules; `ensure-dist-for-tests` now also requires the bundled entry so a
      partial build fails closed.
- [x] `package.json` `files` already ships `dist/`, which includes `dist/bin/`.
- [x] Bundle step verifies `--version` parity and `orient --json` parity on a fresh tiny
      fixture before the build succeeds. Regression coverage in
      `tests/cli-bundle-entry.test.ts`.

Likely files: `package.json`, `scripts/bundle-cli.mjs`, `scripts/bundle-cli-lib.mjs`,
`scripts/ensure-dist-for-tests-lib.mjs`, `docs/installation.md`,
`tests/cli-bundle-entry.test.ts`.

Acceptance:

- [x] Bundled `--version` at or under 120 ms on the reference machine.
      Measured warm median over 5 runs: **73 ms** (unbundled after Priority 0: 147 ms;
      original baseline: 299 ms).
- [x] Bundled `orient --json` output is byte-identical to unbundled for a tiny fixture (build
      smoke + test) and for this repository (manual A/B).
- [x] Focused bundle/startup tests green; `test:fast` still exercises unbundled `dist/`
      imports.

### Priority 1 measured result

Warm medians over 5 runs on this repository (Node v24.15.0, Windows):

| Entry | After Priority 0 (unbundled) | After Priority 1 (bundled bin) |
| ----- | ---------------------------- | ------------------------------ |
| `--version` | 144 ms | 73 ms |
| `--help` | 146 ms | 72 ms |
| `doctor` | 151 ms | 83 ms |

Cold-start still benefits further from Priority 2 (compile cache) because bundling removes
per-file resolution cost but not V8 parse/compile of the remaining entry chunk.

## Priority 2: Enable the V8 compile cache -- IMPLEMENTED (`69d3ec77`)

- [x] Added `src/cliBootstrap.ts` that calls `enableCliCompileCache()` before dynamically importing
      the heavy `cli.js` graph, so compile cache is armed before V8 parses the main entry chunk.
- [x] Cache directory is under the per-user codegraph state root (`%LOCALAPPDATA%/codegraph/compile-cache`
      on Windows; `$XDG_CACHE_HOME/codegraph/compile-cache` or `~/.cache/codegraph/compile-cache`
      elsewhere), never under project `.codegraph/` / `.codegraph-cache/`.
- [x] Failures are non-fatal. `NODE_COMPILE_CACHE` still overrides the directory; `NODE_DISABLE_COMPILE_CACHE=1`
      disables as usual.
- [x] Bundler entry switched to `dist/cliBootstrap.js` with `entryNames: "cli"` so the published
      `dist/bin/cli.js` remains the bin path.
- [x] Regression coverage in `tests/cli-compile-cache.test.ts` (path resolution, enable smoke,
      bootstrap ordering, delete-cache behavior-only).

Likely files: `src/cliBootstrap.ts`, `src/cli/compileCache.ts`, `src/cli.ts`, `scripts/bundle-cli-lib.mjs`,
`tests/cli-compile-cache.test.ts`, `docs/installation.md`.

Acceptance:

- [x] Second and subsequent invocations measurably faster than the first, with the delta
      recorded below.
- [x] Deleting the cache directory changes timing only, never behavior.

### Priority 2 measured result

Warm medians over 5 runs on this repository (Node v24.15.0, Windows), bundled bin:

| Entry | Priority 1 (cache disabled) | Priority 2 (compile cache) |
| ----- | --------------------------- | -------------------------- |
| `--version` | 75 ms | **64 ms** |
| `--help` | 74 ms | **64 ms** |
| `doctor` | 80 ms | **72 ms** |

First touch into an empty cache directory for `--version`: 88 ms; immediate second touch: 70 ms.
Compile cache is a smaller warm win once Priority 1 has already collapsed the module graph; it still
cuts first-touch parse/compile after a clean cache and shaves ~8-11 ms from warm lightweight commands.

## Priority 3: Trim what stays eager -- IMPLEMENTED (`1a527e87`)

Even after Priority 0–2, the unbundled `dist/cli.js` entry still pulled discovery/config/git
helpers into the lightweight `--version` / `--help` / `doctor` graph via static imports from
`src/cli.ts` and `src/cli/context.ts`.

- [x] Re-ran the static module-load walk for `--version`, `--help`, and `doctor`. After this
      cut, each stays under the existing `<30` dist-module gate and no longer loads
      `projectFiles.js`, `config.js`, `git.js`, or `duplicates.js`.
- [x] Confirmed `os.cpus()` already lives inside `resolveThreadCount()` in
      `src/worker/nativeWorkerPool.ts` (not at module scope); locked that with a regression.
- [x] Moved CLI discovery-glob helpers out of eager `cli/context.ts` into
      `cli/discoveryGlobs.ts`, extracted path match helpers into lightweight
      `util/discoveryPath.ts`, and lazy-loaded `config`, `projectFiles`, `git`,
      `includeRoots`, and discovery globs from `cli.ts` only after the lightweight early
      returns (and after `doctor` returns).
- [x] `duplicates.js` is not in the eager set for `--version` / `--help` / `doctor`.

Likely files: `src/cli.ts`, `src/cli/context.ts`, `src/cli/discoveryGlobs.ts`,
`src/util/discoveryPath.ts`, `src/util/projectFiles.ts`,
`tests/cli-startup-eager-modules.test.ts`.

Acceptance:

- [x] Eager dist-module count for `--version` / `--help` / `doctor` stays under 30.
- [x] Those lightweight entrypoints do not load `duplicates.js` or `projectFiles.js`.
- [x] Measured warm medians recorded below.

### Priority 3 measured result

Warm medians over 5 runs on this repository (Node v24.15.0, Windows), bundled bin after Priority 3:

| Entry | Priority 2 | Priority 3 |
| ----- | ---------- | ---------- |
| `--version` | 64 ms | **41 ms** |
| `--help` | 64 ms | **42 ms** |
| `doctor` | 72 ms | **48 ms** |

Unbundled `dist/cli.js` eager dist-module counts after Priority 3: `--version`/`--help` **8**, `doctor` **19** (still under the `<30` gate; none load `duplicates.js`, `projectFiles.js`, `config.js`, or `git.js`).

## Validation checklist

### Focused automated checks

- [ ] `npx vitest run tests/cli-regressions.test.ts`
- [ ] `npx vitest run tests/agent-search.test.ts tests/agent-session.test.ts`
- [x] New test asserting the eager module count for `--version` stays under a threshold, so this
      regression cannot silently return.

### Measurement protocol

Record medians of 5 runs, warm, on this repository, before and after each priority:

- [x] `--version`
- [ ] `orient --root . --budget small --json`
- [ ] `search <symbol> --root . --limit 3`
- [ ] First-touch cold `import` of the CLI entry, measured after a clean rebuild.

### Repository qualification

- [ ] `node ./dist/cli.js doctor`
- [ ] `npm run check`

## Documentation

Per repository policy, update in the same change if behavior or guidance moves:

- [ ] `docs/installation.md` if the shipped entry point changes.
- [ ] `PUBLISHING.md` if the release workflow gains a bundle step.
- [ ] `docs/how-it-works.md` with a short note on startup cost and why MCP remains preferred for
      repeated operations.

## Success criteria

A one-shot CLI invocation costs close to Node's own floor plus the command's real work. Cold
first use no longer pays a multi-second module-loading penalty.
