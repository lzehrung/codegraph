# Native runtime and worker startup costs

Status: Implemented (priorities 0 through 4). Original measurements verified on `main` at `3024ed2b` (`v1.8.100`) on 2026-07-25 by
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

- [x] Recorded, in a separate `identity.json` beside the manifest rather than as new manifest
      fields. `manifest.json` is content-addressed and published once, immutably; this record is
      mutable (the TTL refreshes it) and holds facts that only exist after a load. Keeping them
      apart is what lets an entry written by the previous version stay valid.
- [x] `resolveCachedRuntimeIdentity` finds the entry by scanning the target directory for the
      version prefix and comparing recorded stat fields, then replays the stored origin. Any
      miss falls back to load-and-serialize.
- [x] Unchanged; the parse paths still load.
- [x] Covered without a `dlopen` hook, which cannot run here: the cache path is Windows-only
      and CI for this change is Linux. `tests/native-runtime-identity.test.ts` drives the
      resolver with an injected platform and cache root and asserts it answers from the record
      without a binding, which is the same claim at the seam that would have been hooked.

Likely files: `src/native/runtime.ts`, `src/native/runtimeCache.ts`,
`tests/native-fallback-contract.test.ts`.

Acceptance:

- [x] By construction: the fingerprint was the only non-parse caller of `loadBinding()`.
- [x] Guaranteed by storing the origin whole rather than rebuilding it, and asserted directly.
- [x] Missing, truncated, and malformed records all fall through to a full load.

## Priority 1: Cheap-identity fast path for the Windows native cache

- [x] Recorded, plus the cached copy's own size and mtime.
- [x] Implemented, and the result reports whether it hashed so callers can tell the two apart.
- [x] Unchanged.
- [x] Taken up rather than skipped: 24 hours. Only a run that actually hashed may refresh the
      record, so a stream of fast-path hits cannot push the deadline out.
- [x] Untouched. The probe also never creates directories, so asking for a fingerprint has no
      side effects.

Likely files: `src/native/runtimeCache.ts`, `src/native/bindingLoader.ts`,
`tests/native-fallback-reporting.test.ts`.

Acceptance:

- [x] Proven by swapping the cached bytes under a matching stat record: the digest still comes
      back, which it could not if anything had hashed.
- [x] Both covered, including the TTL boundary.

## Priority 2: Stop workers repeating the pipeline

- [x] The path and the whole origin, so a worker reports the same provenance as its parent.
- [x] Implemented.
- [x] Absent, malformed, or unloadable all fall back.

Acceptance:

- [x] By construction. Not observable on Linux, where there is no verification step at all.
- [x] Parity suites pass, plus a real Piscina pool exercised with a valid handoff, an
      unloadable one, and none.

## Priority 3: Right-size and defer the worker pool

- [x] Moved below `changedList`.
- [x] Implemented, and zero files now means no pool at all, including under an explicit
      request, since Piscina starts `minThreads` eagerly.
- [x] Measured: the crossover on this repository is 24 files, so the threshold is 32. The
      suggested 16 would have been 26% slower than no pool. The full table is in the code
      comment on `NATIVE_WORKER_AUTO_FILE_THRESHOLD`.

Acceptance:

- [x] Asserted end to end on a real build.
- [x] Asserted.
- [x] 811 files, cold, three runs each: median 21314 ms with the change against 20879 ms
      without, ranges 21081-22478 and 19259-22097.

## Priority 4: Prune the native cache

- [x] Implemented on the verified path only, but by age rather than by version - see the
      acceptance note below. A fast-path hit installs nothing, so it prunes nothing.
- [x] All removal failures are skipped, which is the mechanism behind the guarantee below.
- [ ] **Not done, and not doable as written.** The fast path needs the source path and package
      version to locate the entry, which is exactly what the platform-package reads produce, and
      the workspace probe is what establishes that the installed path applies at all. Skipping
      either means persisting a separate "there is no workspace here" fact across processes:
      a different change with its own failure modes, for a few sub-millisecond syscalls.

Acceptance:

- [x] Met differently, and deliberately. Deleting every entry that is not the version now
      installing looks right for one project and is wrong on a real machine: the cache root is
      per-user and shared, so two projects pinned to different native versions would delete each
      other's entry on every run, each re-copying 29 MB and never reaching the fast path - worse
      than the growth this set out to fix. Entries are removed once no project has used them for
      30 days instead. An entry in use is re-verified at least daily, which refreshes its
      timestamp, so age separates abandoned from active where version does not.
- [x] Rests on four things: the Windows DLL lock, never touching the entry just written or any
      entry for its version, leaving any entry whose manifest is unreadable or undated since
      that is what a concurrent population looks like, and the 30-day window above.

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
