# Performance return on investment

Status: Analysis. This file ranks measured costs; it does not implement or authorize an optimization. Each item
still needs the paired base/head measurements and answer differentials that `AGENTS.md` and
[the performance opportunities plan](2026-11-12-performance-opportunities.md) require.

## Scope and environment

- Codegraph 3.3.0 at `6f5b0463`, Node 22.23.4, Windows x64, 32 logical CPUs, 128 GiB RAM. The machine was shared
  with other workloads, so rankings use CPU self-time shares and work counts, not wall-clock deltas.
- Corpora, whole repository with default discovery: Hono `f6fbaf02` (515 indexed files, TypeScript), Django
  `a1f2b45c` (3,487 files, Python), Humanizer `4574b938` (2,525 files, C# plus Markdown/MDX docs), and Codegraph itself
  at `6f5b0463` (2,108 files, mostly TypeScript plus multi-language test fixtures). Edit operations ran on disposable
  local clones.
- CPU is process CPU (`process.cpuUsage`, all threads, libuv threadpool included; Git children excluded). Self time
  comes from V8 sampling (500 us) of the main isolate; worker threads were profiled separately where named.
- Work counts come from V8 precise coverage (`--no-opt --no-maglev`) and from counting `fs` and `child_process`
  calls during the measured phase.
- Builds used `threads: 2` unless a row says "default concurrency" (`threads` unset). An explicit `threads` caps the
  files in flight at that number whatever the native pool size, so worker rows use the default.
- The planned large JavaScript corpus (three.js) did not finish within this run; the harness below reproduces it with
  the same commands.

## Ranked list

Score is expected gain on a high-volume operation times confidence, divided by risk times effort. "Quick" items are
local changes with unchanged answers; "structural" items change a data flow or a cache lifetime.

| Rank | Item                                                                  | Main use case                          | Evidence (corpus)                                                                      | Expected gain                                                   | Conf. | Risk | Effort | Kind       |
| ---: | --------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----- | ---- | ------ | ---------- |
|    1 | Search sidecar compresses every chunk separately into 16 KiB buffers  | MCP warmup, `search`, memory           | Django: 64% of 47.5 s worker CPU in Brotli; 2,293 MiB of buffers for 143,290 chunks    | -30 s CPU and -2.2 GiB peak RSS per Django sidecar build        | High  | Low  | S      | Quick      |
|    2 | `workspace_symbols` rebuilds every candidate per query                | MCP `workspace_symbols`                | Django: 600 ms/query, 69% in per-candidate path work, 24% in tokenizing                | about -90% per query; avoids +1.5 GiB session RSS               | High  | Low  | S      | Quick      |
|    3 | Python import probes on the cold-build critical path                  | Cold index, `init`                     | Django: 34.9% of a saturated main thread; 15,993 `statSync` + 8,212 `readdirSync`      | Django cold wall 9.6 s to about 7.1 s with workers              | High  | Low  | S      | Quick      |
|    4 | C# namespace index rediscovers each project root                      | Cold index, one-file update (.NET)     | Humanizer: 1,166 Git processes per cold build; spawn = 38% of main-thread time         | about -4 s of 12 s cold wall; one-file update about -1.5 s      | High  | Low  | S-M    | Quick      |
|    5 | Disk index load rewrites every stored path                            | Every CLI query, sync, MCP start       | Django no-change: `transformModulePaths` 34% of main-thread time                       | about -0.5 s of 1.55 s per Django load                          | High  | Low  | S      | Quick      |
|    6 | Name resolution scans exports and imports linearly per lookup         | Detailed graph, references, rename     | Django graph: 33 M scan callbacks for 180,843 lookups; 29 M identifier normalizations  | Django graph -1.5 s (9%); rename -0.9 s (15%)                   | High  | Low  | S      | Quick      |
|    7 | Parsed trees and scopes die with each index generation                | MCP refresh after an edit              | Django post-edit detailed graph: 3.0 s native parse + 1.6 s scopes for unchanged files | -4.6 s (28%) of the post-edit rebuild; no reparse for queries   | Med.  | Med. | M      | Structural |
|    8 | Freshness scan on every MCP tool call after 5 s                       | Every MCP tool call                    | Django: 8 Git processes, 6,765 `stat` + 3,487 `access`, 0.45-0.5 s wall per check      | about -0.4 s wall and -0.7-1.3 s CPU per checked call           | High  | Med. | M      | Structural |
|    9 | Search scores decompressed rows for every candidate                   | MCP and CLI `search`, `explore`        | Hono: 2,467 rows decoded and 10,370 scorings per query; Humanizer 297 ms/query         | about -30-40% per query                                         | Med.  | Low  | S-M    | Quick      |
|   10 | Search sidecar insert is one synchronous main-thread transaction      | MCP warmup responsiveness              | Django: 24.4 s CPU, 27.6 s wall blocked; two trigram FTS5 tables per chunk             | No 27 s event-loop block; about -50% insert CPU with one table  | Med.  | Med. | M      | Structural |
|   11 | Receiver type proof rescans containers per call site                  | Detailed graph, member references      | Django graph: 21.9 M container node visits for 107,599 scans (15.6% of build)          | Django graph about -2 s (12%)                                   | Med.  | Med. | M      | Structural |
|   12 | Memory-cache builds reprocess uncached graph-only files and importers | Library `cache: "memory"` updates      | Hono no-change 3.1-4.2 s CPU (cold 2.7-2.9 s); 180 of 515 modules redone each build    | Hono about -2.7 s, Django about -9 s per no-change memory build | High  | Med. | S-M    | Quick      |
|   13 | Every disk build checkpoints, truncates, and reopens SQLite           | `sync`, MCP refresh, one-file update   | Humanizer one-file: checkpoint 401 ms of 1.85 s main-thread time                       | -0.1-0.4 s per incremental build                                | Med.  | Med. | S      | Quick      |
|   14 | Native pool sized past the main-thread bottleneck                     | Cold index with workers                | Django: 8 vs 4 workers, same 9.4-9.6 s wall, +3.8 s CPU, +249 MiB peak RSS             | -3.8 s CPU and -249 MiB at equal wall on Django                 | Med.  | Low  | S      | Quick      |
|   15 | Detailed graph is all-or-nothing after an edit                        | MCP `rename_preview`, `calls`, refresh | Django: first detailed-graph tool call after one edit 27.3 s CPU, 21.0 s wall          | Most of 20 s per post-edit rebuild                              | Med.  | High | L      | Structural |
|   16 | One-shot queries reparse candidate files                              | CLI `refs`, `goto`, graph              | Native parse is 25-46% of refs/goto/graph CPU on a disk-backed index                   | Unproven; depends on persisted-tree size                        | Low   | Med. | L      | Structural |

## Baseline measurements

CPU and wall time in ms for one operation in a fresh process. Hono shows unprofiled / CPU-profiled runs as a
two-run spread; Django and Humanizer show one CPU-profiled run unless noted (profiling adds a few percent). Query
batches: goto 200 sites, refs 50 declarations, families the 5 largest reference families, rename 15 handles, search
and `workspace_symbols` 25 terms, explore 10 terms.

| Operation                          | Hono CPU (wall)               | Django CPU (wall)                 | Humanizer CPU (wall) |
| ---------------------------------- | ----------------------------- | --------------------------------- | -------------------- |
| cold, workers off                  | 2,749 / 2,907 (1,853 / 1,823) | 18,235 (13,776)                   | 16,891 (17,880)      |
| cold, workers, default concurrency | 3,781 / 3,969 (1,610 / 1,527) | 29,047 / 28,546 (9,568 / 9,580)   | 22,094 (12,004)      |
| init (library)                     | 3,703 / 3,922 (2,619 / 2,662) | 23,173 (13,218)                   | -                    |
| no-change, disk                    | 407 / 423 (336 / 377)         | 2,188 (1,875)                     | 1,078 (918)          |
| one-file, disk                     | 595 / 547 (935 / 893)         | 2,766 (3,226)                     | 3,281 (3,002)        |
| no-change, memory                  | 4,203 / 3,110 (1,772 / 1,368) | 10,938 (7,025)                    | 13,093 (15,658)      |
| sync, no edit / one file           | 594 / 781 (498 / 972)         | 3,626 / 4,173 (2,422 / 3,361)     | -                    |
| index load for a query             | -                             | 3,422 / 3,156 (2,040 / 2,110)     | -                    |
| detailed graph                     | 2,173 / 2,203 (1,292 / 1,338) | 22,203 (17,045)                   | 8,782 (6,241)        |
| goto                               | 719 / 860                     | 1,187                             | 1,156                |
| refs                               | 1,860 / 2,297                 | 8,141                             | 6,578                |
| families                           | 1,015 / 1,297                 | 10,906                            | 797                  |
| rename                             | 625 / 672                     | 8,187                             | 1,438                |
| search                             | 3,173 / 3,203                 | 5,015                             | 9,594                |
| `workspace_symbols`                | 2,188 / 2,532                 | 17,812                            | 5,078                |
| explore                            | 1,344 / 1,484                 | 2,484                             | -                    |
| freshness, 5 checks                | 375 / 609                     | 4,437 (2,348)                     | -                    |
| refresh after one edit, total      | 4,172 / 3,500                 | 33,765 (25,563)                   | 17,202 (11,812)      |
| search sidecar, cold build         | -                             | 58,328 / 60,421 (42,312 / 40,660) | -                    |

- Peak RSS: Django long-lived session (detailed graph, sidecar, every query batch) 2,886 MiB unprofiled; after GC
  RSS 2,860 MiB with 744 MiB of live heap. Search preparation peaked at 803 MiB on Hono, 3,350 MiB on Django, and
  5,513 MiB on Humanizer.
- Git children per build: 7 for a cold build and 8 for a no-change build on Hono and Django; 1,166 for a Humanizer
  cold build, 122 for a Codegraph cold build, and 24 for a Humanizer one-file update.
- Codegraph itself, CPU (wall): cold with workers and default concurrency 28,641 (5,236); cold workers off 17,468
  (13,433); no-change disk 1,343 (1,169); detailed graph 17,500 (12,103); refs 8,344 (6,177); `workspace_symbols`
  15,969 (13,516). Unlike Django, its TypeScript main thread is not saturated: workers cut cold wall 2.6x.

## Top items

### 1. Search sidecar chunk compression

- Use case: the first `search`, `explore`, or MCP startup warmup (`symbolGraph` and `queryIndex` needs) on a project
  without a current sidecar, and every rebuild after a version or epoch change.
- Functions: `compressQueryText` (`src/agent/query-index/content.ts:11`), called per chunk from
  `prepareQueryIndexFile` (`content.ts:131-169`); decode per candidate in `storedCandidateChunkFromRow`
  (`src/agent/query-index/store.ts:142`).
- Evidence (Django): cold build 58.3 s CPU / 42.3 s wall, peak RSS 3,258 MiB. Worker preparation 32.4 s CPU; worker
  profiles attribute 30.6 s of 47.5 s busy time (64%) to Brotli (`writeSync` 17.4 s, encoder `close` 8.8 s). After
  preparation, `arrayBuffers` held 2,293 MiB for 143,290 chunks: `brotliCompressSync` returns a view on a 16,384-byte
  buffer, and the structured clone from the worker copies the whole buffer.
- Why slow: one Brotli encoder per chunk (setup and teardown dominate small inputs), and each view retains and clones a
  16 KiB backing buffer.
- Fix direction: copy each compressed view into an exact-size buffer now; then store chunk text per file in one
  compressed block, or uncompressed, and decode only result rows.
- Expected gain: 143,290 x 16 KiB = 2,239 MiB of the 3,258 MiB peak; removing per-chunk compression saves up to
  30.6 s of worker CPU and the per-query Brotli decode (6-10% of search CPU, item 9).
- Risk: low. A storage-format change bumps the sidecar schema or chunker version so old sidecars rebuild.
- Proof: `query-index-split --rss-sampler` window peaks and `arrayBuffersAfterGcMiB`; search answer equality for the
  plan's terms.

### 2. `workspace_symbols` per-query candidate materialization

- Use case: MCP `workspace_symbols`, a direct primitive agents call repeatedly.
- Functions: `workspaceSymbols` (`src/indexer/workspace-symbols.ts:73`) maps every cached local through `toLocalMatch`
  (`:150`) per query, then `rankCandidate` (`:217`) runs `identifierTokens` (`:244`) for nearly every candidate.
- Evidence: per query 640 ms on Codegraph, 600 ms on Django, 200 ms on Humanizer, 65 ms on Hono. On Django, `toLocalMatch` is 8.9 s of
  13.0 s inclusive (path `relative`/`resolve`/`normalizePath` per candidate) and `rankCandidate` 3.2 s. Hono counts:
  464,600 `toProjectDisplayPath` and 928,422 `identifierTokens` calls for 25 queries. In the long-lived Django
  session, this batch raised peak RSS from 1,382 to 2,868 MiB while live heap stayed near 744 MiB.
- Why slow: work that depends only on the index (display path, id, qualified name, lowercase names, identifier
  tokens) is recomputed for every candidate on every query.
- Fix direction: compute those fields once in the existing per-index `LOOKUP_CACHE` entry and rank with precomputed
  values.
- Expected gain: 69% + 24% of the operation is precomputable, so about -90% per query (Django about 600 ms to under
  60 ms) and no per-query allocation churn.
- Risk: low; the ranking and tie-break order are unchanged. Proof: identical `workspace_symbols` responses for the
  plan's terms, plus the `wsymbols` CPU and the `session` phase peak RSS.

### 3. Python import probes on the cold-build critical path

- Use case: cold index and `codegraph init` on Python projects; the main thread is the bottleneck once workers run.
- Functions: `resolvePythonSubmoduleExact` (`src/util/resolution/python.ts:193`) runs `statSync` and
  `readdirSync` with no cache; `pythonPackageSource` (`src/indexer/imports/python.ts:65`) caches a package
  initializer's parse only per importing file; both run under `pushNamedImport` (`:132`).
- Evidence (Django, workers, default concurrency): main thread busy 8,747 of 9,581 ms. `pushNamedImport` 3,053 ms
  (34.9%), `resolvePythonSubmoduleExact` 1,948 ms (22.3%), `pythonPackageSource` 741 ms, `resolvePythonModule`
  834 ms. A workers-off cold build made 15,993 `statSync` and 8,212 `readdirSync` calls.
- Why slow: the same directories are listed and the same `__init__.py` files reparsed once per importing statement.
- Fix direction: build-scoped caches for directory entries and package-initializer facts.
- Expected gain: about 2.5 s off a saturated main thread, so Django cold wall about 9.6 s to 7.1 s and -2.5 s CPU.
- Risk: low; same lookups, one build lifetime. Proof: identical import bindings and detailed-graph edges; the `cold`
  operation's `statSync`/`readdirSync` counts.

### 4. C# namespace index rediscovers each project root

- Use case: cold index, `init`, and one-file updates in .NET repositories with many project files.
- Functions: `resolveCsharpProjectNamespaceIndex` (`src/util/resolution/csharp.ts:160-188`) builds one index per
  nearest project root through `listProjectLanguageFiles` (`src/util/resolution/project-symbols.ts:17`), which calls
  `listProjectFiles` without the build's discovery context.
- Evidence (Humanizer): 146 discovery contexts and 1,022 `listProjectFilesInternal` calls per cold build, spawning
  438 `git ls-files`, 436 `git rev-parse`, 146 `git check-ignore`, and 146 `git config` (Django and Hono: 7 in
  total). Spawning is 3,494 ms self plus 673 ms `normalizeSpawnArguments`, 38% of 10.9 s main-thread time. Nested
  roots overlap, so 735 C# files were read 1,433 times. A one-file update still made 24 Git calls, 2,194 `readdir`,
  and 493 file reads. Codegraph's own cold build spawns 122 Git processes (its C# fixture projects), 392 ms of spawn.
- Fix direction: filter the build's discovered file list by project-root prefix and share one discovery context.
- Expected gain: about -4 s of the 12.0 s cold wall and about -1,159 Git processes; one-file updates drop most of
  their 3.0 s.
- Risk: low to medium: the filtered list must equal per-root discovery, including nested `.gitignore` rules. Proof:
  identical namespace candidates and C# goto/references answers; the `child` counts of `cold` and `onefile-disk`.

### 5. Disk index load rewrites every stored path

- Use case: every one-shot CLI query, `codegraph sync`, MCP startup, and each in-session rebuild loads the disk index.
- Functions: `loadAllCachedModules` (`src/indexer/build-cache/module-cache.ts:738`) and `transformModulePaths`
  (`:645`), which resolves, normalizes, and confines each local's `file` although it equals the module file;
  `freezeSnapshotPayload` (`src/indexer/build-cache/project-snapshot.ts:410`); `transformManifestEntries`
  (`src/indexer/build-cache/manifest.ts:164`).
- Evidence (Django no-change): 2,188 ms CPU, 1,875 ms wall, main thread busy 1,554 ms. Snapshot load is 1,153 ms
  (74%), path transforms 522 ms (34%), recursive freeze 108 ms (7%), manifest transforms 81 ms.
- Fix direction: memoize the path transform per distinct stored path during one load; freeze only the shared top
  level.
- Expected gain: about -0.5 s per Django load (522 ms transforms reduced to the distinct paths, plus most of the
  freeze).
- Risk: low; the mapping is a pure function of root and path. Proof: deep-equal loaded indexes; `nochange-disk` and
  `load` CPU.

### 6. Linear scans in name resolution

- Use case: detailed graph, references, rename, and goto on Python-heavy projects; same code in every language.
- Functions: `namedImportStage` scans `mod.exports.find(...)` and normalizes each export name per lookup
  (`src/indexer/navigation-named-core.ts:136-141`), `matchesExplicitBinding` (`:147-152`) calls
  `isExpandedStarBinding` (`src/indexer/star-import-precedence.ts:87`), itself a scan of all imports; Python
  `normalizeIdentifier` (`src/languages/definitions/python.ts:263`) iterates code points through
  `hasNonAsciiCodePoint` (`src/util/identifiers.ts:5`).
- Evidence (Django detailed graph, one build): 180,843 `resolveBareName` calls drove 11.83 M export-scan callbacks,
  14.21 M `isExpandedStarBinding`, 6.76 M `matchesExplicitBinding`, and 29.19 M identifier normalizations.
  Self time: `normalizeIdentifier` 928 ms (5.6%); on Django rename `normalizeIdentifier` 438 ms and
  `isExpandedStarBinding` 437 ms of 6.06 s.
- Fix direction: a per-module, immutable map from normalized export name to first local export, a per-module set of
  star-import keys, and a char-code ASCII fast path.
- Expected gain: about -1.5 s (9%) of the Django graph build and -0.9 s (15%) of Django rename.
- Risk: low; preserve first-match order. Proof: graph-edge and answer snapshots; the coverage counts above.

### 7. Parsed trees and scopes die with each index generation

- Use case: MCP sessions after an edit: the rebuilt index is a new object, and `querySyntaxCaches` is a `WeakMap`
  keyed by `ProjectIndex` (`src/indexer/parsed-cache.ts:145`).
- Evidence: Django's detailed graph spends 3,016 ms in native parse (18%) and 1,572 ms building scopes (9.4%) for
  3,054 files; after one edit all of it is redone for 3,053 unchanged files. The Hono post-edit rebuild repeated 453
  of 454 parses; native parse is 27% of Codegraph's own detailed-graph main thread.
- Fix direction: carry query-cache entries for files whose content signature is unchanged into the next generation's
  cache, and drop the rest.
- Expected gain: about -4.6 s (28%) of a Django post-edit detailed rebuild; goto/refs after a refresh stop
  reparsing.
- Risk: medium: entries must be keyed by content identity, with the stale-source checks kept. Proof: warm (memory and
  disk) equals cold after edit, delete, rename back, and restore; `refresh` phase CPU.

### 8. Freshness scan per MCP tool call

- Use case: `withFreshness` runs `checkFreshness` (`src/agent/session.ts:593-702`) on most tool calls once the cached
  result is older than 5 s, and again after every refresh.
- Evidence: a Django check made 8 Git processes, 6,765 `stat`, and 3,487 `access` calls: 702-1,312 ms CPU and
  451-495 ms wall. It stats every file in `collectAgentFileSignatures` (`:258`), probes every tracked file in
  `partitionTrackedManifestFiles` (`src/indexer/incremental-plan.ts:89`), and transforms manifest paths again
  (79 ms per check). The in-session rebuild after one edit then made 14,168 `stat`, 11,470 `access`, and 6,993
  `realpath` calls.
- Fix direction: with an active watcher, skip the scan unless events or a pause occurred; otherwise reuse the Git
  diff and untracked listing for changes instead of a second full stat pass.
- Expected gain: about -0.4 s wall per checked call on Django, and O(changed files) refresh probes.
- Risk: medium: a missed watcher event must not leave a stale answer, so keep the scan on watcher errors and after
  pauses. Proof: watcher and freshness tests; `freshness` and `refresh` phase counts.

### 9. Search scores fully decoded rows for every candidate

- Use case: `search` and `explore`, through `findQueryIndexChunkCandidates`
  (`src/agent/query-index/candidates.ts:98`).
- Evidence: Hono decoded 61,668 rows and ran 259,257 `scoreCandidateChunk` calls for 25 queries; median per query
  94 ms on Hono and 297 ms on Humanizer, 166 ms average on Django. Self-time shares: SQLite reads 16-24%, scoring and
  its regexes 20-30%, Brotli decode 6-10%.
- Why slow: `candidateChunkRetrievalForTerms` (`src/agent/query-index/store.ts:620-626`) decodes the compressed text
  of every candidate although ranking reads only `normalized_text`; scoring splits each candidate into a word set.
- Fix direction: fetch and decode text only for the ranked rows that are returned; score with index-based word
  boundary checks.
- Expected gain: about -30-40% per query.
- Risk: low; identical ranking inputs. Proof: identical search results for the plan's terms; `search` CPU.

### 10. Search sidecar insert blocks the main thread

- Use case: MCP startup warmup, where the server's event loop serves tool calls and progress.
- Functions: `replaceFiles` (`src/agent/query-index/store.ts:315`) inserts every chunk in one transaction on the main
  thread; triggers fill two trigram FTS5 tables (`src/agent/query-index/schema.ts:66-81`).
- Evidence (Django): insert 24.4 s CPU, 27.6 s wall; SQLite `run` 23.3 s and `exec` 6.3 s of 33.6 s main-thread
  busy time; 200 MiB sidecar plus a 214 MiB uncheckpointed WAL.
- Fix direction: write the sidecar from a worker (or in yielded batches), then decide from search differentials
  whether the case-sensitive compact trigram table can be dropped or narrowed.
- Expected gain: no 27 s event-loop block; up to about half of the insert CPU if one trigram table goes.
- Risk: medium; dropping a table changes candidate retrieval. Proof: search result differentials and MCP progress
  delivered during warmup.

## Other measured costs

- Receiver type proofs (item 11): `findPriorConstructorInContainer` and `bindingContainerDeclaresNameBefore`
  (`src/graphs/symbol-graph-detailed/receiver-calls.ts:1022`, `:1089`) walk the container up to each receiver, and
  the module root when no inner proof exists: 204 nodes per scan on Django. A per-tree, per-name index of binding
  sites in document order would replace the walks.
- Memory-cache updates (item 12): JSON, YAML, and lock modules never receive memory rows
  (`src/indexer/build-cache/module-cache.ts:944-965` writes only pending modules), so each memory build treats them
  as added and the added-stem scan (`src/indexer/build-index.ts:1651-1680`) re-resolves their importers. Humanizer
  memory builds also repeat item 4's 1,166 Git processes. This is library-only; the CLI and MCP use the disk cache.
- SQLite lifetime (item 13): `closeDiskCacheDatabase` (`module-cache.ts:295`) runs `wal_checkpoint(TRUNCATE)` and
  closes in the `finally` of every incremental build (`build-index.ts:4343-4347`), including in-session rebuilds.
- Worker pool (item 14): the pool is sized from parse-miss bytes (`src/indexer/build-workers.ts:195-199`). With an
  explicit `threads`, in-flight files equal `threads` (`build-index.ts:2393-2394`); at `threads: 2` on Django, worker
  profiles spent 57% of their time in `atomicsWaitLoop`. A fixed cap is wrong for TypeScript, where the main thread
  keeps up (Codegraph: 8 workers, 2.6x faster cold wall), so the cap should follow main-thread saturation.
- Long-lived memory: the sampled live heap of the Django session was led by module rows (65 MiB), the materialized
  detailed graph (64 MiB), ranges from reference walks (60 MiB), reference spelling walks (51 MiB), the search
  neighbor index (40 MiB), and projected syntax trees (33 MiB). RSS stayed 2.1 GiB above live heap after GC, mostly
  heap growth from per-query allocation churn (item 2).
- `codegraph init` profile: beyond the cold build, SQLite open pragmas (197 ms) and the closing checkpoint (221 ms)
  were 25% of Hono's 1.64 s main-thread time.

## Status of earlier plans

[Performance opportunities](2026-11-12-performance-opportunities.md):

- Paired harness, pinned corpora, baseline profiles: done.
- Gate language-specific work in shared passes: done; no unconditional language setup appeared in these profiles.
- Cache owner, ancestor, and member facts: done. Local receiver binding scans remain (item 11).
- Keep every name on the Bloom prefilter and index identifier spellings once per tree: done; the reference spelling
  walk is 3-4% of reference CPU.
- Size the native pool by project size: done, but partly disproven at scale; past the main-thread bottleneck, more
  workers add CPU and memory without wall gain (item 14).
- Count Git processes per operation: done; the counts still miss per-project discovery in C# (item 4).
- Profile `codegraph init`, stylesheet scans, graph-build retention: done.
- Bound graph-build cost per resolved edge: open. Measured detailed-graph CPU: Hono 2.2 s, Humanizer 8.8 s, Django
  22.2 s.
- Measure repeated search: done here (item 9).

[Measurement backlog](2026-08-03-performance-measurement-backlog.md):

- Duplicate preprocessing: not measured. `tokenizeDuplicateSource`, the leading frame of the 3.2.1 graph, refs, and
  goto profiles, no longer appears in those operations.
- Reference lookup: measured; native parse is 25-46% of refs CPU on a disk-backed index, and candidate verification
  runs about 540 goto resolutions per Hono references query.
- Repeated search: measured (items 1, 9, 10).
- Discovery and cache-path observability: build reports already carry the step timings used here; the remaining
  discovery costs are items 4, 5, and 8.

## Reproduce

Run on disposable local clones; edit operations and `init` modify the project. Use separate plan and cache paths per
corpus. Each command writes `<out>.json` (CPU, wall, `fs` and Git counts, memory, workload) and, with `--profile`,
a `.cpuprofile`, `.coverage.json`, or `.heapprofile`.

```bash
# Build the disk cache and choose the queries and the edited file
node scripts/benchmarks/profile-operation.mjs --checkout . --root /work/django --op prepare \
  --plan /work/perf/django.plan.json --cache-dir /work/perf/cache/django --out /work/perf/django-prepare
# One operation, unprofiled or with --profile cpu|coverage|retained
node scripts/benchmarks/profile-operation.mjs --checkout . --root /work/django --op wsymbols \
  --plan /work/perf/django.plan.json --cache-dir /work/perf/cache/django --out /work/perf/django-wsymbols --profile cpu
# Self time, inclusive time, and callers mapped to src/ through the dist source maps
node scripts/benchmarks/summarize-profile.mjs /work/perf/django-wsymbols.cpuprofile --top 30 --callers toLocalMatch
```

| Item | Operation and flags                                                                                                                                                                                                                  |
| ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|    1 | `--op query-index-split --rss-sampler`; worker threads: `node --expose-gc --import ./scripts/benchmarks/worker-cpu-profile.mjs scripts/benchmarks/profile-operation.mjs ...` with `WORKER_PROFILE_DIR` set, then summarize all files |
|    2 | `--op wsymbols --profile cpu`; counts with `--profile coverage`; session memory with `--op session --rss-sampler --profile retained`                                                                                                 |
|    3 | `--op cold --workers on --threads 0 --profile cpu`; `--op cold --workers off --threads 0` for `statSync`/`readdirSync` counts                                                                                                        |
|    4 | `--op cold --workers off --profile coverage` (counts of 146/438) and the `child` counts of `cold` and `onefile-disk`                                                                                                                 |
|    5 | `--op nochange-disk --profile cpu`; `--op load`                                                                                                                                                                                      |
|    6 | `--op graph-detailed --profile coverage`; `--op rename --profile cpu`                                                                                                                                                                |
|    7 | `--op refresh --profile coverage` (parse counts); `--op graph-detailed --profile cpu`                                                                                                                                                |
|    8 | `--op freshness`; `--op refresh --profile cpu --profile-phase watcher:rebuild-index`                                                                                                                                                 |
|    9 | `--op search --profile coverage` and `--profile cpu`                                                                                                                                                                                 |
|   10 | `--op query-index-split --rss-sampler` and `--op query-index --profile cpu`                                                                                                                                                          |
