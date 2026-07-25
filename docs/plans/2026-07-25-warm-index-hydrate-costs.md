# Warm index hydrate: stop recomputing what is already persisted

Status: Planned. Measurements verified on `main` at `3024ed2b` (`v1.8.100`) on 2026-07-25
against this repository (668 indexed files, 8.97 MB snapshot). See
[performance program index](2026-07-25-performance-program-index.md) for the shared baseline.

## Goal

On a warm run where nothing changed, restore state from disk instead of recomputing it. Every
item below is data the cache already holds and then rebuilds anyway.

## Non-goals

- No change to index correctness, invalidation semantics, or what a cache hit means.
- No storage-format rewrite in this plan. The columnar/SQLite option is recorded as deferred
  with a measured upper bound, because the win does not justify the risk yet.

## Verified baseline defects

### F1: Bloom filters are rebuilt for every unchanged, cache-hit file

`src/indexer/build-index.ts:1241-1244` sits inside the branch that just got a cache hit:

```
if (cached) {
  modules.set(file, cached);
  collectJsonDependencies(cached.imports, jsonDependencies);
  if (bloomFilterCache) {
    const filter = await buildBloomFilterForFile(file);
    if (filter) bloomFilterCache.set(file, filter);
  }
}
```

`buildBloomFilterForFile` (`src/indexer/build-cache/module-cache.ts:223-231`) reads the whole
file and re-tokenizes it. The identical filters are already serialized into the snapshot at
`src/indexer/build-cache/project-snapshot.ts:180-182` and hydrated at `:152-154`.

Measured: rebuilding all 668 filters costs 404 ms. Hydrating the same filters from the snapshot
costs 2 ms. The persisted section is 275,949 bytes.

The same pattern exists on the full-build path at `src/indexer/build-index.ts:649-652`.

### F2: Detailed symbol-graph validation rebuilds the graph it is validating

`tryLoadDetailedSymbolGraphSnapshot` (`src/indexer/build-cache/project-snapshot.ts:216-239`)
performs, on every load:

1. `JSON.parse` of the 10.6 MB sidecar.
2. A predicate walk over all 35,107 nodes and 16,132 edges.
3. A full re-`stringify` plus SHA-256 of the parsed graph, to compare against a hash of the
   file's own contents (`:289-301`, `:323`).
4. `isDetailedSymbolGraphCompatibleWithProject` (`:420-459`), which at `:447` calls
   `await buildSymbolGraph(index)` and then compares node-by-node and edge-by-edge.

Measured: 240 ms first call, 215 ms repeat call, with no memoization. Components measured: read
16 ms, parse 21 ms, node map 6 ms, re-stringify plus hash of 11,068,197 bytes 36 ms,
`buildSymbolGraph` 27 ms, remainder in the predicate and comparison walks.

Step 3 buys nothing. The sidecar is written atomically (`:266-274`) and already keyed by
`projectSnapshotIdentity`. Step 4's rebuild is redundant for the same reason: a matching
identity already implies a matching index.

This cost lands on `explain`, `callHierarchy`, `typeHierarchy`, `refactorPlan`, and
`renamePreview`. It does not land on `orient`, `explore`, `search`, or `workspaceSymbols`, which
pass `skip` or `basic` after the change in PR #165.

### F3: The project snapshot is parsed twice on some warm runs

`reuseUnchangedSnapshot` is defined at `src/indexer/build-index.ts:1139` and invoked twice:
once at `:1172` on the early fast path, and again at `:1226` after signature validation. Each
invocation re-reads and re-parses the full 8.97 MB file.

Measured: read 16 ms plus parse 26 ms, so roughly 42 ms per parse and 80 ms when both run.

Byte breakdown of the 8,969,869-byte snapshot:

| Section        | Bytes     | Share |
| -------------- | --------- | ----- |
| `modules`      | 8,105,485 | 90.4% |
| `graph.edges`  | 542,334   | 6.0%  |
| `bloomFilters` | 275,949   | 3.1%  |
| `graph.nodes`  | 37,102    | 0.4%  |

Callers that pass `symbolGraph: "skip"` still materialize all 29,340 symbol definitions.

### F4: Cache databases are unpruned and re-prepare statements per file

- `index-cache.sqlite` is 17.4 MB holding 1,635 rows for 668 live files. Nothing deletes rows
  for renamed or removed files, so it grows monotonically.
- `duplicate-unit-cache.sqlite` is 145.4 MB and costs a measured 85 ms merely to open.
- `writeToCache` and `tryLoadFromCache` (`src/indexer/build-cache/module-cache.ts:278-279`,
  `:314`) call `db.prepare(...)` fresh for every file. Reusing one prepared statement across
  668 lookups measured 62 ms to 54 ms.

Worth stating so nobody re-investigates: on the true warm fast path no SQLite handle is opened
at all. The 26 ms `SqliteDatabase` entry in the tiny-fixture CPU profile is `node:sqlite` driver
initialization, not data volume.

### F5: Content hashes are computed even when a git blob hash already exists

`prepareFileSignatures` (`src/indexer/build-index.ts:466-480`) passes
`forceContentHash: args.cacheEnabled` at `:475` and again at `:611`. `cacheEnabled` is true
whenever cache is not `off`, and agent sessions default to `cache: "disk"`
(`src/agent/session.ts:273`). So the standard warm path reads every byte of the project and
SHA-1s it.

Meanwhile `cacheSignatureForFile` (`src/indexer/build-cache/module-cache.ts:207-212`) already
prefers `sigInfo.gitSig` when present, so for tracked unmodified files the computed hash is dead
work. Separately, `src/agent/session.ts:267-269` stats every file, and the indexer then stats
them all again.

Measured on this repository with a warm page cache: stat of 667 files 14 ms; stat plus read plus
SHA-1 of 667 files (5,776,401 bytes) 17 ms. Small here, but linear in repository size and much
worse on a cold page cache or a network drive.

## Explicit non-issues

Measured and confirmed cheap. Do not spend effort here:

- `buildGraphAdjacency` is rebuilt every load (`project-snapshot.ts:145`, `finalize.ts:34`) at
  1 ms for 3,446 edges. Persisting it is not worth it.
- Rebuilding Maps and Sets from arrays (`project-snapshot.ts:138-142`): approximately 0 ms.
- `buildReferenceCandidateIndex` (`project-snapshot.ts:156`): 1 ms.
- Snapshot validation predicates over all 673 modules: 2 ms.
- `projectSnapshotFilesSignature` over 667 entries: 0.9 to 2.0 ms.

## Priority 0: Hydrate bloom filters instead of rebuilding them -- IMPLEMENTED (`5dc3ecb7`)

- [x] Add `tryLoadPersistedBloomFilters(projectRoot, opts)` in `project-snapshot.ts`, reusing
      the existing `deserializeBloomFilterCache` and `isSerializedBloomFilterRecord`/
      `isProjectIndexSnapshotPayload` validation, but deliberately _not_ requiring the whole
      snapshot's `filesSignature`/`nativeRuntimeFingerprint` to match: a bloom filter is a pure
      function of file text, so a filter persisted for a specific file is safe to reuse for
      that file whenever the caller has independently proven (via its own cache-hit signature
      comparison) the file's content is unchanged -- exactly the same trust model that already
      lets a cache-hit reuse that file's `ModuleIndex`.
- [x] Call `buildBloomFilterForFile` only when the file is missing from the persisted map,
      in both the incremental cache-hit loop and the full-build cache-hit loop
      (`src/indexer/build-index.ts`, both loops).
- [x] Correction from the original write-up: the "warm run with zero changed files" case
      described below was **already** hydrating bloom filters correctly before this fix, via
      the pre-existing `reuseUnchangedSnapshot()` whole-snapshot early return (confirmed by a
      pre-existing passing test, `tests/cache-invalidation.test.ts`, predating this session).
      The real gap this priority closes is a **genuine partial incremental update** -- some
      files changed, most did not -- where the whole-snapshot early return cannot fire
      (`changedFiles.size > 0`), so control used to fall into the per-file cache-hit loop and
      rebuild every _unchanged_ file's bloom filter from source anyway.
- [x] Added a regression exercising exactly that gap: 3 files, only 1 modified between builds,
      asserting `buildBloomFilterForFile` is never called (the 2 unchanged files reuse the
      persisted filter; the 1 changed file gets its filter from the in-memory source during
      fresh parsing, not from this function at all). Verified the test fails on the prior code
      with a call count of exactly 2, matching the 2 unchanged files.

Likely files: `src/indexer/build-index.ts`, `src/indexer/build-cache/project-snapshot.ts`,
`src/indexer/build-cache.ts`, `tests/cache-invalidation.test.ts`.

Acceptance:

- [x] A genuine partial incremental update (some files changed, most unchanged) performs zero
      `buildBloomFilterForFile` calls for the unchanged files. Measured on a 20-file fixture
      with 1 changed file: 0 rebuilds, 19 reused (was 19 rebuilds, 0 reused).
- [x] Bloom-filter-dependent behavior (reference candidate prefiltering) is unchanged, proven by
      existing reference and navigation suites plus a search-correctness smoke test across both
      the reused and freshly-changed files.

## Priority 1: Make sidecar validation cheap and memoized

Three independent cuts, each shippable alone.

- [ ] Remove the re-`stringify` plus SHA-256 self-hash at `project-snapshot.ts:289-301` and
      `:323`. Replace with a node and edge count check plus the existing
      `projectSnapshotIdentity` guard. The sidecar is written atomically, so a torn file is not
      the failure mode this hash defends against.
- [ ] Remove the `await buildSymbolGraph(index)` rebuild and subsequent node/edge comparison at
      `project-snapshot.ts:447-464`. `projectSnapshotIdentity` already encodes files signature,
      graph options, and native fingerprint. Keep the cheap structural checks at `:427-445`,
      which validate that the sidecar refers only to indexed, in-root files.
- [ ] Memoize the loaded detailed graph in a module-level Map keyed by
      (sidecar path, `projectSnapshotIdentity`) so repeat loads in one process are free. This
      matters most for MCP, where the same session answers many tools.
- [ ] Add a test that a corrupted or identity-mismatched sidecar is still rejected, so the
      cheaper validation does not weaken invalidation.

Likely files: `src/indexer/build-cache/project-snapshot.ts`, `src/agent/session.ts`,
`tests/cache-invalidation.test.ts`, `tests/detailed-symbol-native-only.test.ts`.

Acceptance:

- [ ] `explain`, `callHierarchy`, `typeHierarchy`, `refactorPlan`, and `renamePreview` each drop
      roughly 180 to 200 ms warm.
- [ ] A second call in the same process pays approximately 0 ms for the sidecar.
- [ ] A tampered sidecar, a stale identity, and an out-of-root node are all still rejected.

## Priority 2: Remove the duplicate snapshot parse

- [ ] Memoize the parsed snapshot inside `project-snapshot.ts` keyed by
      (path, files signature) so the second `reuseUnchangedSnapshot()` at
      `src/indexer/build-index.ts:1226` is free, or restructure so only one call site remains.
- [ ] Confirm the memo is invalidated when the snapshot file is rewritten within the same
      process, which happens on build completion.

Acceptance:

- [ ] Warm runs that reach both call sites parse the snapshot once.
- [ ] No behavior change when the fast path succeeds at the first call site.

## Priority 3: Signature and stat deduplication

- [ ] Stop passing `forceContentHash` when a git blob hash is available for the file. Compute
      the content hash lazily only when `gitSig` is absent.
- [ ] Have `collectAgentFileSignatures` (`src/agent/session.ts:174-188`) reuse the indexer's
      `fileSignatures` map rather than performing an independent stat pass.
- [ ] Gate the whole pass behind the early fast path once the git plan's Priority 0 lands.

Note the ordering dependency: this priority is much less valuable until
[the git plan](2026-07-25-git-subprocess-elimination.md) re-enables the fast path, because today
the fast path is disabled by any untracked file.

Acceptance:

- [ ] A warm run on a clean tree reads no file contents for signature purposes.
- [ ] Cache invalidation tests still detect content changes for untracked and non-git files.

## Priority 4: Cache hygiene

- [ ] Prune `module_cache` after a successful build: delete rows whose file is not in the
      current manifest. Vacuum periodically or store payloads compressed.
- [ ] Cache prepared statements in a module-level Map keyed by database handle instead of
      re-preparing per file.
- [ ] Defer opening `duplicate-unit-cache.sqlite` until a duplicate query actually needs it, so
      its 85 ms open never lands on unrelated commands.
- [ ] Consider an upper bound or age-based eviction for the duplicate unit cache, currently
      145 MB.

Acceptance:

- [ ] `index-cache.sqlite` row count tracks live file count rather than growing monotonically.
- [ ] Disk footprint of `.codegraph-cache/index-v1/` drops materially on this repository, from
      roughly 183 MB.
- [ ] No command that does not analyze duplicates opens the duplicate cache.

## Deferred: snapshot storage format

Recorded so it is not rediscovered. `modules` is 90.4% of the snapshot, and the same
`ModuleIndex` payloads are also stored in `index-cache.sqlite` (14,912,335 bytes of live
payload), so the data is persisted twice in two formats.

Moving `modules` into SQLite with per-file lazy loading would leave a roughly 860 KB JSON
snapshot. The measured ceiling on that win is about 40 ms per load, because parse is only 26 ms
today. Do not attempt this until Priorities 0 through 4 have landed and been re-measured.

## Validation checklist

### Focused automated checks

- [ ] `npx vitest run tests/cache-invalidation.test.ts`
- [ ] `npx vitest run tests/agent-session.test.ts tests/references.test.ts tests/goto.test.ts`
- [ ] `npx vitest run tests/detailed-symbol-native-only.test.ts`
- [ ] A regression that starts from a snapshot written by an older build and proves the new
      hydrate path upgrades it correctly, per the repository's persistent-storage rule.

### Measurement protocol

Medians of 5 warm runs on this repository, before and after each priority:

- [ ] `orient --root . --budget small --json`
- [ ] `search <symbol> --root . --limit 3`
- [ ] `explain <handle> --root .` for the sidecar path.

### Repository qualification

- [ ] `node ./dist/cli.js doctor`
- [ ] `npm run check`

## Success criteria

A warm run with no changes restores the index from disk and performs no work proportional to
repository size beyond validating that nothing changed.
