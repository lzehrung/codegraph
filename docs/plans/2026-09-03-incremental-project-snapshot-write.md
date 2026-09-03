# Incremental project snapshot write

Status: Destination **C** implemented (2026-09-03). Snapshot version 11 is thin: SQLite-backed module bodies hydrate on load; JSON stubs and other non-cache rows stay in the snapshot. Version 10 blobs still load.

## Goal

Stop paying O(project) serialize + Brotli work on `project-index-snapshot.json` when only a few files changed, without losing the unchanged-index fast path or weakening snapshot identity.

This is cache-identity work. It lands alone, not bundled with visibility, teardown, or the disk-cache double-compression follow-up.

## Why this is expensive

`writeProjectIndexSnapshot` always builds one payload from the **full** in-memory index:

- `modules: [...index.byFile.values()]` then `transformSnapshotPaths(..., toRelative: true)` clones every module, local, export, and import path.
- `JSON.stringify` + `brotliCompressSync` quality 4 of that blob.
- Bloom sidecar `bloom-filters.json` walks `Array.from(index.byFile.values(), module => module.file)` and base64-encodes every bitset.

Call sites:

- Full file-list build: `src/indexer/build-index.ts` (`snapshot-write` step around the `writeProjectIndexSnapshot` call after finalize).
- Incremental update: the same `snapshot-write` `timeIndexBuildPhase` wrap (measurement PR). `--report` now times that rewrite.

The unchanged fast path already skips the write. `reuseUnchangedSnapshot()` returns before parse/graph/snapshot when `changedFiles` and deletes are empty and `tryLoadProjectIndexSnapshot` matches. The expensive write fires only on a real change or a full rebuild, and then rewrites the whole corpus.

Prior internal profiling on a ~3.8k-module repo (same write path, Codegraph 2.3.1): one persist pass was `structuredClone` ~487ms + JSON stringify ~136ms + Brotli q4 ~329ms + SQLite insert ~661ms. The snapshot write repeats stringify + Brotli over the same module objects the disk cache just compressed.

## Current identity and reuse model

Three layers, not one cache:

```text
unchanged project
  -> tryLoadProjectIndexSnapshot (all-or-nothing filesSignature)
     miss or some files changed
       -> tryLoadProjectSnapshotModules (per-file signature)
          miss
            -> SQLite module cache (tryLoadFromCache)
```

### Whole-index snapshot (fast path)

`tryLoadProjectIndexSnapshot` requires disk cache and **exact** match of:

- `PROJECT_SNAPSHOT_VERSION` (currently 10)
- `filesSignature` (sha256 of every manifest path + `sig` + `gitSig` + `sqlCorpusSig`)
- native mode, `nativeRuntimeFingerprint`, `implementationFingerprint`

On match it hydrates graph, modules, bloom, analysis, and `projectSnapshotIdentity` in one decompress. This is why the blob exists: one file reconstructs `ProjectIndex` without N SQLite lookups.

`createProjectSnapshotIdentity(filesSignature, opts)` hashes `filesSignature` + graph options + native fingerprint + implementation fingerprint. Any one-file content change changes `filesSignature` and therefore identity.

### Per-file snapshot modules (incremental warehouse)

`tryLoadProjectSnapshotModules` does **not** require `filesSignature` equality. It checks native/implementation fingerprints, then keeps a module only when `snapshotSignatureMatches` the current file (`gitSig`, else `cacheSig`, else `sig`).

The incremental builder prefers these modules, then falls back to SQLite. Read is already partial. It still **decompresses the entire blob** first; `parsedSnapshotCache` / `transformedSnapshotModulesCache` only help while the snapshot file identity (size/mtime/ctime) is unchanged.

### Bloom sidecar

`tryLoadPersistedBloomFilters` prefers `bloom-filters.json`, then the bloom section inside the project snapshot. Reuse is per-file via the same signature matcher. Sidecar `projectSnapshotIdentity` is checked for shape (`64` hex chars), not equality with the current identity, so unchanged filters survive a one-file identity change.

### Detailed symbol graph sidecar

`tryLoadDetailedSymbolGraphSnapshot` **does** require `index.projectSnapshotIdentity` equality. Session warmup (`src/agent/session.ts`) loads or rebuilds this sidecar after the base index. A new identity invalidates it. `writeProjectIndexSnapshot` sets `index.projectSnapshotIdentity` only after a successful snapshot write; a skipped write leaves identity unset and forces a detailed-graph rebuild.

`graphHash` is still written but no longer re-verified on load (re-stringify of an 11MB sidecar was measured ~36ms and is not a project check).

### What is already incremental

- Changed-file detection, dependent invalidation, parse, and SQLite `writeModulesToCache` (only pending writes).
- Graph assembly from manifest `cachedGraphEntries` plus `replaceFiles`.
- Bloom **compute** (`persistedFilter` then `buildBloomFilterForFile`).
- Unchanged snapshot load (skips write).
- Manifest rewrite (`writeIndexManifestSnapshot`) already stores per-file edges. Snapshot `graph` is a second copy of that assembled graph.

### What is still O(project) on a one-file change

- Transform + stringify + Brotli of every module into `project-index-snapshot.json`.
- Serialize + Brotli of every bloom filter into `bloom-filters.json`.
- Incremental snapshot write is untimed.
- Next unchanged run only recovers the fast path if that full blob was rewritten.

`writeProjectIndexSnapshot` itself does not gate on `opts.cache === "disk"` (loaders do). Incremental always calls it. Loaders ignore the file when cache is not disk.

## Options

### A. Patch the cached relative payload, still rewrite one blob

On incremental write, reuse `parsedSnapshotCache` (just read during module hydration), replace changed modules / signatures / bloom entries / graph, update `filesSignature`, stringify + Brotli the whole payload.

- Preserves format, fast path, identity, and tests.
- Avoids re-transforming unchanged modules.
- Does **not** remove O(project) stringify + Brotli. Modest win unless measurement shows transform dominates.

### B. Defer the full snapshot rewrite on small incrementals

Skip `writeProjectIndexSnapshot` when the changed set is small; rely on SQLite + per-file snapshot/bloom signatures. Restore the blob on the next incremental assembly, on full rebuild, or when the changed fraction exceeds a threshold.

- No format change.
- Speeds the edit/`refresh_index` run.
- Next unchanged run **misses** `tryLoadProjectIndexSnapshot` (`filesSignature` stale), reassembles from modules + SQLite, then likely writes the blob anyway.
- If identity is not set, detailed-graph warmup rebuilds every time until a snapshot write lands.
- Behavior change: warm-after-edit is cheaper; warm-after-that is more expensive until the blob is restored.

### C. Thin snapshot: stop embedding module bodies (recommended architecture)

Bump `PROJECT_SNAPSHOT_VERSION`. Snapshot keeps identity, fingerprints, `filesSignature`, `fileSignatures`, graph, analysis, `projectFiles`, language/native metadata. Module bodies live only in the SQLite disk cache that incremental already writes.

- Incremental write: one SQLite row (already) + rewrite a **thin** snapshot (graph + signatures, no module corpus) + patch bloom sidecar.
- Fast path: load thin snapshot, hydrate modules from SQLite in one transaction.
- `tryLoadProjectSnapshotModules` becomes SQLite (or a thin index of `file -> cacheSig`).
- Version mismatch: treat as invalidation (current exact-version check already misses), not corruption. AGENTS.md migration rule: ship a v10 reader that still hydrates modules from the old blob **or** document a one-time rebuild.
- Subsumes the module-body half of double compression.
- Risk: unchanged fast path may slow if N SQLite decompresses lose to one blob decompress, especially on Windows Defender. This is the measurement gate, not a guess.

### D. Content-addressed module shards on disk

Same split as C, but modules are files keyed by `cacheSig` instead of SQLite. Reject unless SQLite hydrate is proven unusable; the disk cache already is this store.

## Recommendation

Do not implement C until the gate below is green. Do not land A or B as the product fix; they do not make write O(change) for the expensive part.

1. **Measure (first PR, tiny).** Wrap the incremental `writeProjectIndexSnapshot` call in the same `snapshot-write` `timeIndexBuildPhase` the full build uses. Capture `--report` `steps` on a one-file edit in a ~500-file tree and a larger tree. Split wall time in a local probe if needed: transform vs stringify vs Brotli vs bloom sidecar vs atomic write.
2. **Measure unchanged load.** Time `tryLoadProjectIndexSnapshot` vs "thin header + `SELECT` all module payloads" on the same trees. Accept C only if hydrate is within ~20% of blob load, or if edit-path savings dominate the session mix and hydrate stays acceptable.
3. **Implement C alone** if the gate passes: version bump, SQLite hydrate for both loaders, thin write, v10 fallback or explicit rebuild, tests listed below.
4. If hydrate is much slower, record that in this plan and fall back to **B with an explicit restore rule** (rewrite the blob at end of incremental when changed files is 0, i.e. the first unchanged assembly after edits). Do not ship A as the destination.

Bloom sidecar scoping can ride with C (patch one filter in the sidecar payload) or wait; it is smaller than module bodies. Do not incrementally rewrite `detailed-symbol-graph.json` in this work. Identity coupling stays: a content change still invalidates the detailed sidecar, matching today's semantics.

## Contracts that must not silently change

- Unchanged project still hits `tryLoadProjectIndexSnapshot` after a snapshot that reflects current `filesSignature`.
- One-file edit still updates that file's module and does not reuse a stale snapshot module when `cacheSig` differs (existing collision test).
- Display-path vs `fileIdentityKey` lookup still works.
- Malformed snapshot still records corruption and falls back to parse/SQLite.
- Fingerprint / version / native mismatch still invalidates, not corrupts.
- Snapshot bytes stay frozen for callers (`TypeError` on mutate); parse-once memoization still holds while file identity is unchanged.
- Atomic temp-file + rename + fsync remains; write failure must not fail indexing.
- Path confinement of snapshot files stays inside cache root.
- `cacheSig` remains stronger than `mtime:size` `sig` for reuse.

## Tests to preserve

Primary suite: `tests/cache-invalidation.test.ts` (direct `writeProjectIndexSnapshot` / both loaders, cacheSig collision, display paths, malformed payload, fingerprint invalidation, parse-once memo, module-transform memo, bloom sidecar).

Also: `tests/cache-path-confinement.test.ts`, `tests/disk-cache-sqlite.test.ts`, `tests/disk-cache-concurrency.test.ts` (snapshot remains readable under module-cache writers), `tests/agent-session.test.ts` (snapshot path + detailed graph identity), `tests/load-current-index.test.ts`, `tests/index.test.ts` snapshot removal cases.

## Tests to add with the implementation PR

- N-file fixture, edit one file: unchanged modules are not re-serialized (assert via spy on `JSON.stringify` payload module count, or snapshot version C with SQLite row count / thin snapshot missing `modules`).
- After that edit, a no-change rebuild still returns the new module and hits the fast path (or the documented restore rule if B).
- Deleted file disappears from snapshot identity and loaders.
- Dependent invalidation still reparses importers.
- v10 blob still loads or is a quiet rebuild, never a hard failure.
- Incremental `--report` includes `snapshot-write`.

## Files likely touched

- `src/indexer/build-cache/project-snapshot.ts`
- `src/indexer/build-index.ts` (timing wrap; loader wiring)
- `src/indexer/build-cache/module-cache.ts` only if hydrate needs a bulk read API (keep that API in the snapshot PR if required; do not collapse double-compression into this PR)
- `tests/cache-invalidation.test.ts` and a focused new test file if the suite is already too large
- `CHANGELOG.md` Unreleased when behavior ships
- this plan (status line)

No public CLI/MCP contract change is expected. `docs/how-it-works.md` cache paragraph only if the on-disk snapshot shape becomes user-visible.

## Non-goals

- Disk-cache vs snapshot double compression of the same module (see companion plan). C removes the duplicate module corpus; leftover bloom/graph overlap stays out of this PR.
- Incremental detailed symbol graph writes.
- Thread-count tuning, discovery, or HTML/CSS `query-empty` logging.
- `process.exit` / Windows teardown.
- Mixing this into an open visibility or release PR.

## Decision

**C** (thin snapshot + SQLite hydrate). Recorded 2026-09-03.

Fallback remains **B** only if the measurement gate shows N SQLite hydrates much slower than one blob load (hydrate worse than ~20% of blob load _and_ edit-path savings do not dominate). Do not ship A as the product fix.

## Measurement results

Recorded 2026-09-03 on Windows, Node 22.16.0, isolated disk cache. Fresh-process blob vs SQLite hydrate (not same-process memo).

This repository (1263 in-memory modules, 1166 SQLite rows):

| Cost                                                         | ms    |
| ------------------------------------------------------------ | ----- |
| Cold `snapshot-write`                                        | 409   |
| One-file incremental `snapshot-write`                        | 321   |
| Incremental update wall                                      | 1319  |
| Blob `tryLoadProjectIndexSnapshot` first load (same process) | 340   |
| Blob load, same process (parse memo)                         | 33    |
| SQLite `SELECT` all + Brotli + `JSON.parse`                  | 76-82 |

Gunship (3848 in-memory modules, 3785 SQLite rows). Cold wall 74.3s.

| Cost                                                      | ms      |
| --------------------------------------------------------- | ------- |
| Cold `snapshot-write`                                     | 1246    |
| One-file incremental `snapshot-write`                     | 1116    |
| Incremental update wall                                   | 11314   |
| Fresh-process blob load                                   | 1454    |
| Blob load, same process (parse memo)                      | 55-60   |
| Fresh-process SQLite hydrate                              | 274-289 |
| Cold `index-manifest` (pretty JSON of every file's edges) | 40977   |
| Cold `cache-probe`                                        | 13834   |
| Cold `git-ignore`                                         | 8977    |
| Cold `persist-cache`                                      | 1131    |

Gate: hydrate is **faster** than a cold/fresh-process blob load. Gunship hydrate is ~5x faster (289ms vs 1454ms). Edit-path savings are real: ~1.1s of an 11.3s one-file refresh is the full-corpus snapshot rewrite. Incremental `--report` currently names only `snapshot-write`; the other ~10s is untimed (signatures, full-blob module load, manifest rewrite).

**C constraint:** SQLite rows are fewer than in-memory modules (1166/1263 here, 3785/3848 on Gunship). JSON stubs, empty parse results, and other non-cache writes live only in the snapshot. Thin snapshot must keep those bodies, or those files must start writing SQLite rows. Do not drop them on hydrate.

**Out of scope for C:** Gunship cold time is dominated by `index-manifest` (41s of 74s), a pretty-printed `JSON.stringify(manifest, null, 2)` of every file's edges. That is a separate plan. Do not mix it into the thin-snapshot PR.
