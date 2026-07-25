# Native runtime and worker startup costs

Status: Planned. Measurements verified on `main` at `3024ed2b` (`v1.8.100`) on 2026-07-25 by
tracing `process.dlopen` around a real CLI invocation. See
[performance program index](2026-07-25-performance-program-index.md) for the shared baseline.

## Goal

Stop loading, hashing, and verifying a 29 MB native addon on commands that never parse a file.

## Non-goals

- No change to native parsing behavior, language support, or the fallback contract when the
  addon is unavailable.
- No change to the security properties of the Windows native cache. Integrity verification stays;
  this plan changes how often it runs, not whether it can be skipped when it matters.

## Reading the numbers correctly

This repository resolves the addon from the workspace
(`src/native/bindingLoader.ts:65-77`), where `dlopen` measures 1 to 3 ms. Installed users get a
different path: `package.json` ships only `dist`, so `findLocalNativeBinary` always misses and
the Windows runtime-cache branch (`src/native/bindingLoader.ts:170-176`) is the production path.

So the 59 ms `dlopen` visible in the tiny-fixture CPU profile corresponds to the cache or
cold-mapping variant. The dominant installed-path cost is not `dlopen` at all; it is the double
29 MB hashing described in F2.

## Verified baseline defects

### F1: Cache validation forces a full addon load

`src/native/runtime.ts:136` calls `loadBinding()` inside `getNativeRuntimeFingerprint`. That
function is reached from `src/indexer/build-cache/options.ts:64`,
`src/indexer/build-cache/project-snapshot.ts:110`, `:128`, `:188`, and
`src/lifecycle/manifest.ts:387`.

Traced with a `process.dlopen` hook while importing `dist/cli.js` with argv `orient`: exactly one
`dlopen`, 271 ms into the process, with the stack
`loadNativeBinding <- loadBinding <- getNativeRuntimeFingerprint`. No parse had occurred.

The addon itself is correctly lazy; nothing imports it at module top level. The problem is that
cache-validity checking needs a fingerprint string, and that string embeds `supportedLanguageIds()`
plus binding origin, which the code obtains by actually loading the addon. Every cache-hit-only
command pays the entire native load to prove it does not need the native runtime.

Estimated removal: about 35 ms warm and about 300 ms cold per process on installed Windows; 1 to
3 ms on a developer checkout.

### F2: The Windows native cache hashes 29 MB twice per process

`src/native/runtimeCache.ts:234` hashes the source binary to derive the cache key, then `:251`
calls `verifyFile`, which at `:168-170` hashes the cached copy again.

Measured: the binary is 28.8 MB. A streaming SHA-256 using the same 1 MB chunk loop costs 14.5 to
17.7 ms with a warm page cache, and 130 to 162 ms when the file is not in the page cache,
measured across the five real entries currently in
`%LOCALAPPDATA%/codegraph/native-cache/v1/win32-x64-msvc`.

Add `realpathSync.native` three times, an `lstatSync` per path component in
`prepareSafeDirectory` (`:71-96`), and an `existsSync` per run. None of it is memoized across
processes.

The cache key is content-derived, which is why the source must be hashed before the entry can be
found. That is a design consequence, not an accident, so the fix is a cheap-identity fast path
rather than removing verification.

### F3: Every worker thread repeats the pipeline the main thread just ran

`src/worker/nativeExtractWorker.ts:48-54` calls `loadProductionBinding()`, invoked lazily per
worker at `:65`. The `bindingState` memo at `src/native/runtime.ts:15` is per-thread, and the
worker deliberately bypasses `runtime.ts` anyway.

The OS `LoadLibrary` refcount makes the second and later `dlopen` of the same DLL cheap within a
process, but the JavaScript-side `prepareNativeRuntimeCache` work is not deduplicated. Each
worker that receives at least one task re-runs two 29 MB SHA-256 passes plus the realpath and
stat probing.

Pool size is `min(max(cpus - 1, 1), 8)` (`src/worker/nativeWorkerPool.ts:22-27`), so this can be
up to 8 repetitions of roughly 30 ms warm, contending on the same file.

### F4: The worker pool spawns before the build knows whether anything changed

`src/indexer/build-index.ts:1182` calls `setupWorkerPool(opts)` before signature validation and
before the second `reuseUnchangedSnapshot()` early return. The only earlier escape is
`canSkipFileValidation` at `:1170-1180`, which today is false in any tree with an untracked file.

Piscina eagerly starts `minThreads` workers at construction (`nativeWorkerPool.ts:44-51`), and
threads are fixed at `min(cpus - 1, 8)` regardless of workload. Auto-enablement kicks in at 250
files (`src/agent/session.ts:78`), so it is effectively always on for real repositories.

Measured: spawning 8 Piscina threads and destroying them without any task costs 11 ms wall
(constructor 5 ms, destroy 6 ms). First task costs 30 ms.

The 11 ms is small. The real waste is on small incremental builds, where all 8 threads start and
up to 8 pay the F3 binding cost for a handful of files.

### F5: The native cache grows without bound

`prepareNativeRuntimeCache` (`src/native/runtimeCache.ts:229-275`) only ever adds entries.
Measured: five versions currently cached (1.8.73, 1.8.75, 1.8.76, 1.8.78, 1.8.79) at roughly
29 MB each, about 145 MB total.

This is a disk and working-set concern rather than a direct latency one, but it keeps the cache
directory cold.

### F6: Filesystem probing before the addon is even chosen

`src/native/bindingLoader.ts:65-77` runs `readdirSync` on a workspace directory that never exists
for installed users, a guaranteed-miss syscall on every run and every worker. Then `:94-108`
does a resolve, `realpathSync.native`, `statSync`, and a `readFileSync` plus `JSON.parse` of the
platform package manifest.

Individually sub-millisecond, but it is the same answer every time and is never cached.

## Explicit non-issues

- `src/parserBackend.ts` is a pure stub. All functions throw or return literals; no grammar
  loading happens there.
- `src/runtimeIdentity.ts` performs no hashing. It reads `package.json` at most every 30 s
  (`:5`, `:63-66`). Native fingerprinting lives entirely in `src/native/runtime.ts:89-147`.
- `piscina` is correctly behind a dynamic import (`src/indexer/build-workers.ts:65`), so it is
  not in the cold ESM graph.

## Priority 0: Derive the fingerprint without loading the addon

- [ ] Extend the existing cache manifest written at `src/native/runtimeCache.ts:208-230` to
      record `supportedLanguageIds` and the serialized fingerprint.
- [ ] Change `getNativeRuntimeFingerprint` (`src/native/runtime.ts:119-147`) to read that
      manifest when a cache entry for the current (package version, target) validates by size and
      mtime, and only fall back to load-and-serialize on a manifest miss.
- [ ] Keep `loadBinding()` strictly on the parse paths in `src/native/execution.ts`.
- [ ] Add a test proving that a warm cache-hit command performs zero `dlopen` calls, by hooking
      `process.dlopen`.

Likely files: `src/native/runtime.ts`, `src/native/runtimeCache.ts`,
`tests/native-fallback-contract.test.ts`.

Acceptance:

- [ ] Warm `orient`, `search`, and `refs` on a cache hit load no native addon.
- [ ] The fingerprint value is identical to today's for the same binary, so no cache
      invalidation is triggered by the change itself.
- [ ] A missing or corrupt manifest still produces a correct fingerprint via the fallback.

## Priority 1: Cheap-identity fast path for the Windows native cache

- [ ] Record (package name, package version, target, source size, source mtimeMs) in the cache
      manifest.
- [ ] When those stat-only fields match and the final binary's size and mtime match, return
      `reused` with the stored sha256 without hashing anything.
- [ ] Keep full hashing for cache population and for any manifest mismatch.
- [ ] Optionally re-verify on a TTL, for example once per day, rather than every process.
- [ ] Preserve the existing path-confinement and safe-directory checks; this plan changes hashing
      frequency only.

Likely files: `src/native/runtimeCache.ts`, `src/native/bindingLoader.ts`,
`tests/native-fallback-reporting.test.ts`.

Acceptance:

- [ ] A warm installed-mode process performs zero full-file SHA-256 passes over the addon.
- [ ] Tampering with the cached binary is still detected on the next full verification, and a
      size or mtime change forces immediate re-verification.

## Priority 2: Stop workers repeating the pipeline

- [ ] Pass the resolved `loadedPath` and its verified sha256 from the main thread into the pool
      via Piscina `workerData`.
- [ ] Have `src/worker/nativeExtractWorker.ts` require that path directly, skipping
      `prepareNativeRuntimeCache` entirely.
- [ ] Fall back to `loadProductionBinding()` only when `workerData` is absent, which keeps tests
      working.

Acceptance:

- [ ] A build with N active workers performs one addon verification, not N.
- [ ] Worker parse results are unchanged, proven by the native parity suites.

## Priority 3: Right-size and defer the worker pool

- [ ] Move `setupWorkerPool` (`src/indexer/build-index.ts:1182`) below the `changedList`
      computation, or make it lazy so it is created on the first file that actually needs a
      worker.
- [ ] Size threads as `min(resolvedThreads, changedList.length)`.
- [ ] Skip the pool entirely below a small threshold, for example 16 changed files, where
      per-worker bootstrap exceeds the parsing it saves. Measure to pick the threshold rather
      than guessing.

Acceptance:

- [ ] A warm no-change run creates zero worker threads.
- [ ] A 3-file incremental build creates at most 3 workers.
- [ ] Full-build throughput on this repository is unchanged.

## Priority 4: Prune the native cache

- [ ] After a successful `reused` or `cached` result, best-effort delete sibling entries under
      the target directory whose manifest `packageVersion` differs from the current one.
- [ ] Ignore `EBUSY`, since Windows locks loaded DLLs.
- [ ] Fold the F6 probing into the Priority 1 fast path: when a valid cached entry exists for the
      running version and target, skip workspace probing and platform-package metadata reads.

Acceptance:

- [ ] Cache directory holds entries for the current version plus at most one prior version.
- [ ] Pruning never deletes the entry currently loaded by another process.

## Validation checklist

### Focused automated checks

- [ ] `npx vitest run tests/native-fallback-contract.test.ts tests/native-fallback-reporting.test.ts`
- [ ] `npx vitest run tests/native-worker-parity.test.ts tests/native-semantic-parity.test.ts`
- [ ] `npm run test:native`
- [ ] A `process.dlopen` hook test asserting zero native loads on a warm cache-hit command.

### Measurement protocol

Because this repository resolves the workspace binary, validate installed mode explicitly:

- [ ] Measure warm and cold `--version` and `orient` using a globally installed build, not the
      workspace checkout, before and after Priorities 0 and 1.
- [ ] Record `dlopen` count and total SHA-256 bytes read per process.

### Repository qualification

- [ ] `node ./dist/cli.js doctor`
- [ ] `npm run check`

## Documentation

- [ ] `docs/how-it-works.md`: note that the native addon loads only when parsing is required.
- [ ] `docs/installation.md` if native cache behavior or its disk footprint guidance changes.

## Success criteria

Commands that answer from the graph cache never touch the native addon. Commands that parse pay
for it once per process, and workers inherit that work rather than repeating it.
