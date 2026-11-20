# Performance opportunities

Status: Planned. Work these items between language-accuracy batches. Measurement-only work stays in
[the measurement backlog](2026-08-03-performance-measurement-backlog.md).

## Rules for every item

- Measure base and head as `AGENTS.md` requires: separate processes, at least five alternating
  rounds, pinned `threads` and `nativeThreads`, medians with spread, on large real projects.
- Cover every affected operation: `codegraph init`, cold index build, no-change update, one-file
  update, detailed graph build, search, references, and go-to-definition.
- An optimization must not change any answer. Prove it with a differential of detailed-graph edges,
  go-to-definition, and references (including coverage) over `tests/samples`, `tests/edge-corpus`,
  and the benchmark projects: zero differences.
- Record the before/after medians in this file when an item lands.

## Measurement

- [x] Commit a paired base/head benchmark command covering all eight operations, alternating run
      order, pinned thread limits, medians, both spreads, paired slower counts, and regression verdicts:
      `npm run bench:paired`. See [the command and measured boundaries](../benchmarks/paired.md).
- [x] Pin one real project per source-language family in `scripts/benchmarks/corpus.json`; Hono and
      Humanizer reuse `scripts/accuracy/corpus.json`. `--families` selects a smaller run.
- [x] Profile `main` on all eight operations and every pinned family; measured self-time follows.

### Baseline operation profiles

Codegraph 3.2.1 at `49465a849a8540f0f0537eb4d3d38ad05829daac`, Node 22.23.4, npm 10.9.9,
Windows x64. Each operation ran in its own process with `threads: 1`, `nativeThreads: 1`, and a
1 ms V8 sampling interval. The machine was shared, so the single instrumented elapsed times below
are context, not medians or regression evidence.

The profiles bracket only the named operation, excluding imports and query/index setup.
`init` means **init (library, CLI startup excluded)** because the CLI cannot pin `nativeThreads`.
Self time groups samples by function and source URL; the table omits profiler `post`, `(idle)`,
`(program)`, and GC frames when listing the two leading work functions. Native export labels such as
`tokenizeDuplicateSource` are V8 frame names, not a Rust-internal breakdown; extraction-worker CPU
is outside the main-isolate profile, and idle time is waiting rather than JavaScript work.

Source scopes and exact commits are in the manifest. Query workloads use up to 25 fixed declarations
and their real use-sites, not identical query counts across languages: Hono 25/15 refs/goto sites,
Humanizer 25/10, Okio 25/2, cJSON 25/24, Flask 25/11, RuboCop 25/14, Guzzle 25/18, Gin 25/11,
ripgrep 25/10, Kingfisher 25/9, and ZLS 25/19.

| Family / project (indexed files) | Operation | Leading self-time frames (ms)                                           | Profiled elapsed (ms) |
| -------------------------------- | --------- | ----------------------------------------------------------------------- | --------------------: |
| ECMAScript / Hono (190)          | init      | exec 51.6; spawn 39.7                                                   |                1381.2 |
| ECMAScript / Hono                | cold      | spawn 17.7; anonymous project-files.js 12.2                             |                1102.0 |
| ECMAScript / Hono                | nochange  | getCompactImportsExecution 111.2; spawn 29.0                            |                 898.0 |
| ECMAScript / Hono                | onefile   | exec 50.9; spawn 30.5                                                   |                 652.9 |
| ECMAScript / Hono                | graph     | tokenizeDuplicateSource 125.7; walk 42.2                                |                 511.5 |
| ECMAScript / Hono                | search    | scoreCandidateChunk 172.3; all 72.7                                     |                1429.8 |
| ECMAScript / Hono                | refs      | tokenizeDuplicateSource 99.8; walk 24.2                                 |                 319.6 |
| ECMAScript / Hono                | goto      | tokenizeDuplicateSource 25.9; walk 5.6                                  |                  76.6 |
| .NET / Humanizer (212)           | init      | spawn 64.6; exec 52.3                                                   |                1923.2 |
| .NET / Humanizer                 | cold      | spawn 35.7; normalizePath 18.1                                          |                1229.1 |
| .NET / Humanizer                 | nochange  | dlopen 4490.1; getNativeSyntaxTreeExecution 244.9                       |                5753.3 |
| .NET / Humanizer                 | onefile   | spawn 37.9; getNativeExtractionExecution 25.1                           |                 829.6 |
| .NET / Humanizer                 | graph     | tokenizeDuplicateSource 220.6; walk 40.2                                |                1189.7 |
| .NET / Humanizer                 | search    | scoreCandidateChunk 427.7; all 202.6                                    |                1819.2 |
| .NET / Humanizer                 | refs      | tokenizeDuplicateSource 223.5; walk 34.8                                |                 721.9 |
| .NET / Humanizer                 | goto      | tokenizeDuplicateSource 30.7; walk 9.8                                  |                 108.3 |
| JVM / Okio (248)                 | init      | join 70.5; spawn 62.8                                                   |                2193.0 |
| JVM / Okio                       | cold      | join 88.5; spawn 45.7                                                   |                1774.8 |
| JVM / Okio                       | nochange  | getNativeSyntaxTreeExecution 223.4; spawn 56.9                          |                1299.7 |
| JVM / Okio                       | onefile   | spawn 58.0; resolve 30.7                                                |                 916.9 |
| JVM / Okio                       | graph     | tokenizeDuplicateSource 228.9; declaresName 52.2                        |                1337.6 |
| JVM / Okio                       | search    | scoreCandidateChunk 408.9; all 273.9                                    |                1997.8 |
| JVM / Okio                       | refs      | tokenizeDuplicateSource 202.0; walk 50.4                                |                1023.8 |
| JVM / Okio                       | goto      | tokenizeDuplicateSource 6.2; walk 4.5                                   |                  30.4 |
| C/C++ / cJSON (53)               | init      | spawn 36.9; exec 10.1                                                   |                 735.2 |
| C/C++ / cJSON                    | cold      | spawn 20.0; anonymous project-files.js 6.1                              |                 496.3 |
| C/C++ / cJSON                    | nochange  | getCompactImportsExecution 45.6; spawn 31.4                             |                 414.2 |
| C/C++ / cJSON                    | onefile   | spawn 34.5; getNativeExtractionExecution 26.5                           |                 437.8 |
| C/C++ / cJSON                    | graph     | anonymous star-import-precedence.js 277.7; fileIdentityKey 58.0         |                 800.4 |
| C/C++ / cJSON                    | search    | scoreCandidateChunk 101.1; writeSync 53.4                               |                 712.8 |
| C/C++ / cJSON                    | refs      | structurallyExportsDefinition 90.4; walk 50.2                           |                 495.7 |
| C/C++ / cJSON                    | goto      | tokenizeDuplicateSource 40.2; walk 11.6                                 |                 113.1 |
| Python / Flask (24)              | init      | getNativeExtractionExecution 79.5; spawn 39.7                           |                 749.8 |
| Python / Flask                   | cold      | getNativeExtractionExecution 83.6; spawn 20.3                           |                 492.0 |
| Python / Flask                   | nochange  | getCompactImportsExecution 36.5; spawn 31.6                             |                 492.8 |
| Python / Flask                   | onefile   | getNativeExtractionExecution 78.7; spawn 34.3                           |                 723.3 |
| Python / Flask                   | graph     | tokenizeDuplicateSource 32.1; visit 10.9                                |                 234.9 |
| Python / Flask                   | search    | scoreCandidateChunk 27.5; spawn 14.6                                    |                 215.7 |
| Python / Flask                   | refs      | tokenizeDuplicateSource 30.6; resolveNamedDefinition 13.0               |                 296.5 |
| Python / Flask                   | goto      | tokenizeDuplicateSource 19.4; walk 11.3                                 |                  73.8 |
| Ruby / RuboCop (957)             | init      | resolve 171.8; relative 124.1                                           |                4402.2 |
| Ruby / RuboCop                   | cold      | normalizePath 157.0; resolve 110.0                                      |                3441.4 |
| Ruby / RuboCop                   | nochange  | getCompactImportsExecution 478.1; normalizePath 145.2                   |                2609.8 |
| Ruby / RuboCop                   | onefile   | normalizePath 51.1; resolve 49.5                                        |                1309.8 |
| Ruby / RuboCop                   | graph     | tokenizeDuplicateSource 474.0; visit 146.7                              |                2091.4 |
| Ruby / RuboCop                   | search    | scoreCandidateChunk 369.2; all 232.1                                    |                1922.2 |
| Ruby / RuboCop                   | refs      | supportForFileWithoutHeaderSample 654.0; fileIdentityKey 617.3          |                3960.7 |
| Ruby / RuboCop                   | goto      | tokenizeDuplicateSource 11.9; moduleNameLookupsFor 4.1                  |                  74.0 |
| PHP / Guzzle (74)                | init      | spawn 73.3; tokenizePhpSource 18.3                                      |                1442.8 |
| PHP / Guzzle                     | cold      | spawn 60.4; tokenizePhpSource 17.9                                      |                1142.7 |
| PHP / Guzzle                     | nochange  | getNativeSyntaxTreeExecution 89.1; getCompactImportsExecution 75.6      |                 916.0 |
| PHP / Guzzle                     | onefile   | spawn 67.2; tokenizePhpSource 21.3                                      |                 763.4 |
| PHP / Guzzle                     | graph     | tokenizeDuplicateSource 81.9; inferPhpQualifiedReferenceImportType 36.5 |                 731.3 |
| PHP / Guzzle                     | search    | scoreCandidateChunk 196.9; all 67.4                                     |                 736.9 |
| PHP / Guzzle                     | refs      | tokenizeDuplicateSource 79.8; walk 47.4                                 |                 827.4 |
| PHP / Guzzle                     | goto      | tokenizeDuplicateSource 79.8; spawn 27.7                                |                 406.4 |
| Go / Gin (59)                    | init      | spawn 33.7; realpath 24.2                                               |                1094.4 |
| Go / Gin                         | cold      | handleErrorFromBinding 26.1; normalizePath 18.9                         |                 839.2 |
| Go / Gin                         | nochange  | getCompactImportsExecution 28.8; spawn 28.0                             |                 695.5 |
| Go / Gin                         | onefile   | spawn 30.4; normalizePath 7.5                                           |                 394.7 |
| Go / Gin                         | graph     | tokenizeDuplicateSource 41.8; visit 14.8                                |                 230.5 |
| Go / Gin                         | search    | scoreCandidateChunk 21.9; spawn 17.2                                    |                 293.4 |
| Go / Gin                         | refs      | visit 42.0; tokenizeDuplicateSource 34.4                                |                 275.7 |
| Go / Gin                         | goto      | tokenizeDuplicateSource 28.5; walk 13.9                                 |                  92.5 |
| Rust / ripgrep (90)              | init      | scanRustImportStatements 51.9; spawn 36.6                               |                1875.5 |
| Rust / ripgrep                   | cold      | scanRustImportStatements 36.5; skipRustBalancedDelimiters 23.2          |                1578.2 |
| Rust / ripgrep                   | nochange  | getCompactImportsExecution 190.1; spawn 30.6                            |                 868.5 |
| Rust / ripgrep                   | onefile   | getNativeExtractionExecution 82.2; spawn 36.3                           |                 858.1 |
| Rust / ripgrep                   | graph     | tokenizeDuplicateSource 188.3; declaresName 107.6                       |                 954.0 |
| Rust / ripgrep                   | search    | scoreCandidateChunk 104.7; all 60.0                                     |                 640.4 |
| Rust / ripgrep                   | refs      | visit 250.7; declaresName 246.0                                         |                1608.8 |
| Rust / ripgrep                   | goto      | tokenizeDuplicateSource 76.1; walk 24.3                                 |                 179.9 |
| Swift / Kingfisher (100)         | init      | spawn 46.1; anonymous project-files.js 16.4                             |                1854.4 |
| Swift / Kingfisher               | cold      | spawn 19.8; handleErrorFromBinding 13.2                                 |                1159.6 |
| Swift / Kingfisher               | nochange  | getCompactImportsExecution 114.7; spawn 32.4                            |                 606.0 |
| Swift / Kingfisher               | onefile   | getNativeExtractionExecution 142.4; spawn 34.3                          |                 655.1 |
| Swift / Kingfisher               | graph     | tokenizeDuplicateSource 132.1; declaresName 29.8                        |                 654.7 |
| Swift / Kingfisher               | search    | scoreCandidateChunk 194.6; all 88.9                                     |                1022.9 |
| Swift / Kingfisher               | refs      | tokenizeDuplicateSource 127.5; walk 27.1                                |                 456.1 |
| Swift / Kingfisher               | goto      | tokenizeDuplicateSource 57.0; walk 7.6                                  |                 126.5 |
| Zig / ZLS (41)                   | init      | spawn 40.3; exec 12.2                                                   |                1121.4 |
| Zig / ZLS                        | cold      | spawn 13.6; buildIndexedModuleForFile 5.1                               |                 695.0 |
| Zig / ZLS                        | nochange  | getCompactImportsExecution 185.5; spawn 25.7                            |                 541.3 |
| Zig / ZLS                        | onefile   | spawn 37.2; resolve 13.8                                                |                 459.3 |
| Zig / ZLS                        | graph     | tokenizeDuplicateSource 189.8; visit 69.5                               |                 704.0 |
| Zig / ZLS                        | search    | scoreCandidateChunk 242.3; normalizeQuerySearchText 99.4                |                1014.5 |
| Zig / ZLS                        | refs      | tokenizeDuplicateSource 195.3; walk 40.5                                |                 578.1 |
| Zig / ZLS                        | goto      | tokenizeDuplicateSource 146.6; walk 29.3                                |                 276.4 |

Measured ranking: repeated search's chunk scoring/normalization and Ruby reference candidate/path
work are prominent shared JavaScript costs; native calls, import rehydration, and path/Git work are
visible elsewhere. Humanizer's 4490.1 ms `dlopen` sample records loader work in that single run, not
evidence that no-change indexing itself regressed. These profiles rank investigations; they do not justify
changing semantic answers or establish cross-project latency ratios.

### Paired harness acceptance

A five-round Hono comparison against the same baseline covered all eight operations, with run order
alternating each round and both thread limits set to one. These shared-machine timings remain
provisional, not a speedup claim. The table's paired ratio/MAD verdicts were recalculated from the
saved raw samples; the current harness defaults to six balanced rounds and checks equal workloads.

| Operation      | Base median (ms) | Head median (ms) | Paired delta (%) | Paired noise (%) | Head slower rounds | Verdict      |
| -------------- | ---------------: | ---------------: | ---------------: | ---------------: | -----------------: | ------------ |
| init (library) |           1436.1 |           1411.9 |             -0.5 |              3.0 |                2/5 | Inconclusive |
| cold           |           1258.8 |           1245.2 |             -0.8 |              0.7 |                0/5 | Within noise |
| nochange       |            703.6 |            780.7 |              1.0 |              2.6 |                4/5 | Inconclusive |
| onefile        |            565.2 |            570.1 |              0.9 |              2.6 |                4/5 | Inconclusive |
| graph          |            604.3 |            570.3 |             -4.6 |             12.1 |                2/5 | Inconclusive |
| search         |            964.4 |           1018.8 |             -3.5 |             13.6 |                2/5 | Inconclusive |
| refs           |            359.8 |            378.7 |              4.1 |              8.1 |                3/5 | Inconclusive |
| goto           |             78.1 |             77.7 |             -0.8 |              1.1 |                0/5 | Within noise |

- Both builds indexed 190 files; cold reports submitted 190 native tasks on one worker with zero
  failures. Unchanged runs reported 190 cache hits and zero misses; one-file runs reported 189
  cached files and one changed/parsed file.
- Both graph workloads returned 5821 nodes and 3339 edges. Both search workloads returned 480
  matches over 25 terms; references found all 25 targets and 65 references; goto found all 15 use-sites.
  These counts validate workload execution, not semantic equivalence by themselves.
- Median peak RSS was 169.3/170.4 MiB for base/head graph work and 221.0/239.4 MiB for search;
  post-GC heap medians were 48.6/48.6 MiB and 32.7/32.7 MiB respectively. Peak RSS includes setup.

An initial six-round cJSON acceptance run exercised 96 measured processes with balanced order and
both thread limits pinned to one. All 48 base/head workload pairs matched automatically; the shared
machine timings are not speedup evidence. Contamination-aware reclassification marks all eight
operations inconclusive, including search's two large head-only bursts.

| Operation      | Base median (ms) | Head median (ms) | Paired delta (%) | Paired noise (%) | Head slower rounds | Verdict      |
| -------------- | ---------------: | ---------------: | ---------------: | ---------------: | -----------------: | ------------ |
| init (library) |            826.8 |            835.8 |             -0.7 |              3.2 |                2/6 | Inconclusive |
| cold           |            550.3 |            527.7 |             -2.4 |             21.5 |                2/6 | Inconclusive |
| nochange       |            444.8 |            466.4 |              1.0 |             25.6 |                4/6 | Inconclusive |
| onefile        |            455.4 |            479.7 |             -1.6 |             15.3 |                2/6 | Inconclusive |
| graph          |            886.3 |            836.1 |             -3.5 |              5.4 |                1/6 | Inconclusive |
| search         |            761.6 |           1348.3 |              0.3 |              0.9 |                5/6 | Inconclusive |
| refs           |            505.7 |            520.7 |              3.3 |              3.2 |                6/6 | Inconclusive |
| goto           |            113.7 |            115.7 |              3.3 |              9.4 |                4/6 | Inconclusive |

- Both versions indexed 53 files, returned 10990 nodes and 11840 edges, found 357 search matches
  over 25 terms, found all 25 reference targets with 92 references, and resolved all 24 goto use-sites.
- Median graph peak RSS was 157.2/157.0 MiB and post-GC heap 43.1/43.1 MiB for base/head; search
  peak RSS was 243.6/219.4 MiB and post-GC heap 34.3/34.3 MiB. Peak RSS includes setup.

A subsequent schema-3 cJSON smoke again matched all 48 operation workload pairs. Provenance recorded
a clean baseline, a dirty head, and runtime artifacts newer than the build inputs on both sides;
these shared-machine timings remain provisional.

| Operation      | Base median (ms) | Head median (ms) | Paired delta (%) | Paired noise (%) | Head slower rounds | Verdict      |
| -------------- | ---------------: | ---------------: | ---------------: | ---------------: | -----------------: | ------------ |
| init (library) |            809.4 |            796.4 |              3.2 |              7.8 |                4/6 | Inconclusive |
| cold           |            512.8 |            545.0 |              4.4 |              5.3 |                5/6 | Inconclusive |
| nochange       |            445.6 |            414.5 |             -4.5 |             12.1 |                2/6 | Inconclusive |
| onefile        |            471.6 |            431.5 |             -6.6 |              7.6 |                1/6 | Inconclusive |
| graph          |            790.3 |            785.2 |             -0.5 |              1.1 |                2/6 | Within noise |
| search         |            723.1 |            717.2 |             -0.5 |              3.1 |                2/6 | Inconclusive |
| refs           |            504.3 |            493.3 |             -1.8 |              4.0 |                2/6 | Inconclusive |
| goto           |            105.3 |            107.5 |              2.1 |              0.7 |                4/6 | Inconclusive |

The same 53-file workload returned 10990 nodes, 11840 edges, 357 search matches, 92 references, and
24 resolved goto use-sites. Base/head graph peak RSS medians were 153.8/153.6 MiB and post-GC heap
43.1/43.1 MiB; search peak RSS was 229.0/228.3 MiB and heap 34.3/34.3 MiB.

### Stability acceptance

- Startup watcher idle time previously began before warmup settled. A held real-resource warmup now
  keeps watches open beyond its idle interval, then starts the full interval after settling; the
  watcher still pauses and resumes on the next tool call.
- A disposable stdio discovery probe can be forcibly terminated while holding an unexpired lifecycle
  lease. The loaded baseline reproduced the resulting cleanup conflict in 20.839 s; the corrected
  modern stdio conversation passed in 3.259 s under the same two-CPU-worker load.
- Hard-killed holder recovery, live/foreign/legacy lease retention, concurrent-reclaimer exclusion,
  and stable nonzero hard-link identity passed on Windows NTFS and Linux. Eager warmup is retained;
  unexpired recovery additionally requires matching platform, Linux PID namespace, and Linux boot ID.
- With the same hostname and shared storage, a live Windows holder was retained by Linux `server stop`
  in 4.795 s, and a live Linux holder was retained by Windows `server stop` in 3.209 s. Both commands
  refused acquisition, preserved the still-unexpired lease bytes, and left the holder alive.
- Crafted platform/namespace mismatches, inaccessible and reused PIDs, zero-inode content validation,
  and actual nonzero-inode recovery are covered. A blocking claim waits for a fresh expiry observation;
  claim age is no longer an authorization to delete it.
- The change adds early recovery of provably dead local holders, not a new cross-process mutex.
  Both early and expired recovery reuse the existing detach/verify/restore procedure. A late stale
  observer can still rename away a replacement lease briefly before mismatch verification restores
  it, allowing another contender to enter in that window, as in the pre-existing expiry procedure.
- Already-expired leases bypass the early-claim gate. Stale claims therefore cannot permanently
  wedge expiry; only the claim owner or cleanup after the corresponding lease is detached removes
  them. The previous clock-injected claim-age cases and broad F1 no-detachment assertion were
  removed with that age-retirement protocol; scoped F2/F3, expiry-wedge, and early-claim barrier
  tests replace them. Full atomic exclusion is outside this recovery change.
- Atomic-file path assertions now include intentional transient contention and check every rename
  attempt's destination. Failed-session warmup assertions await the actual pending initialization
  rather than a one-second poll; native parity explicitly disables workers in its baseline instead
  of accidentally starting an automatic pool.
- The stdio recovery test keeps a 60-second budget so an old 30-second lease reaches the expiry
  assertion rather than timing out. A prior loaded corrected run completed that recovery in 4.318 s.
- Lifecycle temporary-directory EBUSY was not attributed: all 25 baseline lifecycle cases passed
  with 12 CPU workers and failure-only handle diagnostics. The two reported cleanup test bodies
  and deletion policy remain unchanged; no removal retries were added.

#### Bounded recovery verification

An earlier five-suite check passed under two CPU workers with the repository's existing test timeouts:
241 passed and 5 skipped, including the F2/F3 interleavings, expired/unexpired blocking-claim cases,
and eight-contender unexpired-claim barrier. The F3 regression failed against the exact previous
recovery source, observing `entered` instead of `settled`; the same regression passed after removal
of age-based claim retirement. Eight ordinary installer lock/lease/metadata tests also passed.

A final three-suite lifecycle check passed 59 tests with 2 platform skips, including expiry recovery
with a changed reported inode and claim cleanup racing a live, paused claimant. The published
replacement lease stayed intact and later contenders remained blocked; eight ordinary installer
lock/lease/metadata tests also passed.

The real-clock reviewer F3 schedule and its 40-root, four-contender natural counterpart behaved
identically on main and the bounded change on Windows and WSL: no age-retirement action, overlap,
lost lease, or overwrite. All 160 contenders in each natural run were rejected while the deliberately
unexpired leases and their blocking claims remained intact. Those retained fixtures were removed
only after all contenders exited.

The separate expired-lease stress test used eight contenders, 150 rounds, and eight CPU burners
for each run. The table is one load-dependent sample, not a stable failure rate or evidence of
improved exclusion. Both builds fail intermittently on Windows and routinely on WSL because of
the existing late-stale-observer window:

| Runtime | Main entries / attempts | Bounded entries / attempts | Main / bounded violation events | Main / bounded stuck rounds | Main / bounded leftover leases |
| ------- | ----------------------: | -------------------------: | ------------------------------: | --------------------------: | -----------------------------: |
| Windows |             1197 / 1200 |                1200 / 1200 |                          18 / 0 |                       0 / 0 |                          0 / 0 |
| WSL     |             1200 / 1200 |                1200 / 1200 |                         20 / 11 |                       0 / 0 |                          0 / 0 |

The events were overlap, lease loss, and overwrite; Windows main also recorded three `ENOENT`
outcomes. Other paired runs recorded 23 / 6 main/head events on a quiet Windows batch and
301 / 321 on WSL. These load- and scheduling-dependent results do not establish improved or full
mutual exclusion; a zero in one sample is not an exclusion guarantee.

A final six-round cJSON smoke matched all 48 base/head operation-workload pairs and printed clean
base / dirty head provenance with fresh-build flags on stdout as well as in JSON. All eight timing
verdicts were inconclusive on the shared machine:

| Operation      | Base median (ms) | Head median (ms) | Paired delta (%) | Head slower rounds |
| -------------- | ---------------: | ---------------: | ---------------: | -----------------: |
| init (library) |            960.2 |            780.7 |             -6.9 |                2/6 |
| cold           |            526.8 |            587.9 |              2.2 |                6/6 |
| nochange       |            438.1 |            420.5 |             -0.7 |                2/6 |
| onefile        |            461.2 |            439.3 |             -1.5 |                3/6 |
| graph          |            843.3 |            819.5 |             -0.8 |                3/6 |
| search         |            701.7 |            748.2 |              1.9 |                5/6 |
| refs           |            488.5 |            503.3 |              3.8 |                4/6 |
| goto           |            105.5 |            106.3 |              1.7 |                4/6 |

## Cache freshness costs

- Relative JSON freshness checks add one `stat` per recorded candidate and one `realpath` per existing
  candidate, plus one root `realpath` per update. A directory-index import can record a missing
  `dir.json` even when it resolves to `dir/index.ts`, because the resolver checks `dir.json` first.
  For no-change incremental updates, measured total stat calls were:

  | Project                       | Candidates | Before | After |
  | ----------------------------- | ---------: | -----: | ----: |
  | Hono                          |         59 |    639 |   698 |
  | JSON-heavy fixture            |        175 |    173 |   348 |
  | Directory-index-heavy fixture |        400 |  1,223 | 1,623 |

- Warm full builds now reuse JSON candidates for unchanged importers. In single Hono no-change
  profiles on a shared machine, sampled inclusive candidate-update CPU fell from 50.31 ms to 2.28 ms
  for disk cache and from 74.13 ms to 6.02 ms for memory cache. These are CPU samples, not paired
  wall-clock timings; freshness stat and realpath checks are unchanged.

- Vue and Svelte stylesheet edges can coincide with script side-effect edges, so their JSON candidate
  signatures use the observed state. A JSON change may re-extract a style-only component once.

- A no-change memory build with 500 importers of one JSON file made 143,791 file-identity calls;
  indexing candidate membership reduced this to 19,041. With 2,000 importers the same counts fell
  from 2,075,041 to 76,041. On Hono, which has fewer shared candidates, calls rose from 42,644 to
  42,851; filesystem probe counts were unchanged.

- Full disk builds reuse prior candidate rows; a damaged but valid row is not repaired until its
  importer changes or the cache is cleared. This has not been observed in normal operation.
- Candidate reuse state has a 128-project limit but no byte cap and is freed by `clearMemoryCache()`.
  A 100,000-file measurement used about 360 bytes per file for the recorded file scopes.

## Opportunities

Each item comes from a cost found and fixed in one language during the accuracy batches. The same
pattern likely exists elsewhere.

- [x] **Gate language-specific work in shared passes.** The PHP accuracy fixes built PHP trait state
      for every index; on the TypeScript-only Hono project this added 8.7 ms of self time to
      `buildSymbolGraphDetailed` (graph build +2.2%) until it was gated on PHP being present. Audit
      `symbol-graph-detailed.ts`, `edge-passes.ts`, `receiver-calls.ts`, `member-selection.ts`,
      `navigation-goto.ts`, and `locals-and-exports.ts` for setup that runs regardless of the
      languages in the index or module.
- [x] **Cache owner, ancestor, and member facts per index for every language.** Swift owner proofs
      recomputed per call cost 319 ms of self time in the Kingfisher graph build (+5.6%) before a
      per-index cache. Ruby on RuboCop: `collectType` 81 to 8 ms, `rubyEnclosingNamespaces` 49 to
      4 ms, `rubyConstantRoot` 44 to 1.5 ms, `resolveSharedOwnerContainers` 26 to 8 ms after
      caching. `resolveSharedOwnerContainers` is shared; check the Kotlin, Java, TypeScript,
      Python, C++, and PHP paths for per-call recomputation (C# already warms owner chains).
- [x] **Keep every name on the Bloom prefilter.** Ruby names ending in `?`, `!`, or `=` failed the
      Bloom token check, so each references query scanned all 2,248 RuboCop modules (2.1 s to
      117 ms after normalizing the name first). Count full-scan fallbacks per language on the
      corpora and normalize Kotlin and Swift backtick names, C# `@` names, and PHP case-folded
      names the same way.
- [x] **Index identifier spellings once per parsed tree.** Indexing Ruby send names once per tree
      cut `rubyMethodName` from 13.3 to 1.5 ms in reference queries. Share one name-to-nodes index
      per tree across references, rename preview, call hierarchy, and the detailed graph.
- [x] **Size the native worker pool by project size.** An initial file-count heuristic gave five-round
      medians of 1,179 to 938 ms, 1,636 to 1,242 ms, and 2,307 to 2,328 ms on 50, 150, and
      500 real files, but slowed small projects with large files. The corrected heuristic sizes from
      parse-miss bytes. On three alternating builds of 150 x 20 KiB, 150 x 10 KiB, and 100 x 5 KiB,
      median wall time was 1,334 to 1,286 ms, 1,095 to 964 ms, and 762 to 706 ms; pool sizes were
      8 to 7, 8 to 4, and 8 to 2. Baseline spreads were 2.2%, 16.2%, and 2.9%, with head slower in
      1, 0, and 0 rounds. For 100 x 150 KiB, both pools used 8 workers; median time was 3,763 to
      4,093 ms, within the 16.8% baseline spread, with head slower in all three rounds.
      Five further rounds measured 3,105 to 3,343 ms, with head slower in all five rounds.
      The native binaries differed only in PE link timestamps and the PDB GUID; their `.text`
      and `.data` sections were identical. Seven rotated A/B/A heavy-file runs measured 3,070,
      3,190, and 2,937 ms, showing the earlier gap was run-to-run noise.
      Wall times are provisional under shared load. At `threads: 16` and `nativeThreads: 2`, all 150 tasks
      completed without queue failures; the baseline rejected 92 to 94 per run.
      Three clean `init` runs on the 150 x 20 KiB fixture, with a cleared external cache anchor,
      had median wall time 3,611 to 3,414 ms.
- [x] **Count Git processes per operation.** On a 953-file Git project, process counts for
      clean init fell from 15 to 13 and a one-file update from 13 to 12. References,
      go-to-definition, and search after that edit fell from 11 to 10; cold builds stayed at 7
      and no-change updates at 8. The staged and modified listings and the two lifecycle
      ignore checks each share one child process.
- [x] **Profile `codegraph init`.** The 953-file clean-init profile spent 21.9 s idle, 1.8 s in
      SQLite execution, and 1.5 s in realpath on the main thread under shared-machine load.
      Five alternating clean-init runs had median wall time 5,846 to 5,933 ms and process CPU
      11,343 to 11,405 ms; head was slower in two rounds and baseline wall spread was 22%.
      Removing two Git children reduces avoidable work; the earlier 3.2.0 versus 3.1.3
      regression on the 651-file project remains unclassified.
- [x] **Avoid quadratic stylesheet scans on masked SFC scripts.** Five alternating builds of
      the 744 KB script fixture had median wall time 20,689 to 740 ms for Vue, 19,833 to
      730 ms for Svelte, and 570 to 568 ms for plain JavaScript. Baseline wall spreads were
      39.6%, 27.6%, and 3.0%, with head slower in 0, 0, and 2 rounds respectively. Median CPU for Vue
      fell from 20,609 to 766 ms, and for Svelte from 19,391 to 734 ms. Three CSS-module
      regexes accounted for 13.2 s of baseline profile self time and no longer backtrack
      across the masked lines.
- [x] **Measure graph-build retention.** Five alternating Humanizer and Spectre.Console runs had
      median peak RSS of 723 to 776 MiB and 394 to 364 MiB; baseline spreads were 10.5% and
      1.9%, with head higher in 3 and 0 rounds. Median post-GC build heap was 83 to 84 MiB and
      32 to 32 MiB, and graph heap was 214 to 214 MiB and 88 to 88 MiB. The query caches held
      765 and 468 parsed views while their indexes were live; after release, both indexes were
      collected in every run and heap fell to 41 and 29 MiB.
- [ ] **Bound graph-build cost per resolved edge.** After caching, the Ruby fixes still add about 8%
      correct edges on RuboCop (21,621 to 23,286); track graph-build time per edge so new
      resolution rules do not grow cost faster than the edges they add.
- [ ] **Measure repeated search.** No search cost has been measured in these batches yet; start
      from the "Repeated search" item in the measurement backlog.

## Shared-pass audit (2026-11-19)

Baseline: `49465a84`, Node 22.23.4 on Windows x64, with `threads: 1` and `nativeThreads: 1`.
The cold builds used `cache: "off"`. References and go-to-definition used 50 deterministic
declaration/use pairs per corpus, after a detailed graph build; CPU profiles sampled at 500 us.
Concurrent workloads make wall-clock timings provisional.

- **Language setup: no change needed.** PHP namespace and trait setup is already guarded by PHP
  module presence. C# alias and owner-chain setup, Python receiver caches, Kotlin callable facts,
  Swift spelling sets, C/C++ callable aliases, and language-specific extraction supplements are
  guarded or lazy. The profiles did not identify another material unconditional language setup.
- **Bloom probes: no change needed.** Receiver scans already normalize each candidate language's
  spelling before probing, fold PHP class/function names, and retain conservative scans for names
  that are not whole Bloom tokens. Full-scan member-name fallbacks were zero in Hono, Spectre.Console,
  okio, Django, Vapor, Guzzle, and ripgrep. The audit included normalized Kotlin, C#, Swift, and PHP
  member spellings (1, 4, 19, and 189 declarations respectively).
- **Material member work.** Django's `directLocalsWithinNode` consumed 428 ms of graph-build self
  time. Spectre.Console references spent 107 ms in that scan and its name predicate. Module-local
  normalized-name tables narrow those walks without caching owner, visibility, or receiver answers.
  The remaining owner/ancestor walks did not justify another cache: okio's
  `collectDeclaredBaseTypes` used 10 ms of graph-build self time; `resolveSharedOwnerContainers`
  only applies to C# and Swift, whose owner facts and tree container lists were already cached.
- **Material spelling work.** Reference candidate walks used 39-328 ms of self time across the seven
  corpora. References and rename share a per-tree spelling table built during a repeated lookup's
  own walk, preserving source order and language name-equivalence checks. Tables count against
  the live query-cache budget and are evicted before parsed views. The detailed graph already
  shares parsed trees, while call hierarchy reuses graph adjacency.

### Deterministic evidence

- Django graph-build self time in `directLocalsWithinNode`: 427.5 to 8.2 ms, with 17.1 ms in the
  new module-name table helper. `findDirectLocalsWithinNode` fell from 173.6 to 16.4 ms.
  First-batch reference spelling-walk self time, base/head in ms: Hono 129/45, Spectre.Console
  39/29, okio 137/19, Django 328/375, Vapor 118/38, Guzzle 208/79, ripgrep 117/45, and Humanizer
  129/84. Django pays table construction in the first batch; the repeated batch benefits from reuse.
- Across 50 reference queries, `namedChildren` reads fell from 3,575,411 to 1,679,248 on Hono
  and from 1,066,394 to 819,659 on Spectre.Console. The number of distinct nodes read stayed
  493,723 and 267,196 respectively. Django fell from 8,413,189 to 6,604,021 reads in the first batch
  and from 8,413,106 to 2,921,052 additional reads in the repeated batch, with the same 2,798,739
  distinct nodes overall.
- All 76 sample and edge-corpus projects matched: 756 files, 2,104 detailed edges, 2,485 reference
  queries including coverage, and 6,647 go-to-definition queries. One JSON-symbol reference query
  throws the same existing `UnsupportedParserInputError` on both sides; it was not counted as an
  empty answer. The 58 committed graph snapshots also matched.
- All eight real corpora matched their full detailed graphs and 50 reference/coverage and 50
  go-to-definition answers each. On Django, fresh real sessions also produced byte-identical
  library graph arrays, CLI compact graph output, portable artifact JSON, and MCP responses
  for 50 reference and 50 go-to-definition requests. An initial Django baseline that fell back
  from a 30-second Git listing to filesystem discovery was excluded and repeated with successful
  Git discovery before comparing array order.

### Paired measurements

Five alternating, unprofiled rounds per comparison. CPU milliseconds are `median [min-max]`,
base/head. These are shared-load measurements, not idle-machine speed claims. Index/build rows
precede all spelling-table lookups.

| Corpus          | Cold index                                | No-change cached build                | One-file cached build                   | Detailed graph                            |
| --------------- | ----------------------------------------- | ------------------------------------- | --------------------------------------- | ----------------------------------------- |
| Hono            | 4953 [4062-6390] / 5344 [4046-6532]       | 1562 [1375-1563] / 1453 [1328-1547]   | 1594 [1391-1672] / 1625 [1376-1860]     | 4547 [4344-4765] / 4438 [3718-4874]       |
| Spectre.Console | 3718 [3391-5922] / 3765 [3156-5656]       | 1173 [953-1281] / 1344 [766-1375]     | 5172 [4094-5234] / 4767 [3593-5546]     | 5703 [3797-5985] / 5531 [3954-5892]       |
| okio            | 2579 [2375-3251] / 2469 [2266-2812]       | 703 [468-797] / 625 [468-719]         | 3485 [3142-3578] / 3343 [3203-3641]     | 3546 [2937-3734] / 3594 [2876-3766]       |
| Django          | 41141 [28313-51532] / 44483 [40672-47126] | 9094 [7609-11562] / 9422 [8329-10282] | 10343 [7531-12079] / 10593 [8750-11203] | 44828 [35641-49187] / 41437 [37766-49297] |
| Vapor           | 2016 [1844-2250] / 2093 [1875-2266]       | 438 [391-531] / 407 [391-562]         | 610 [548-688] / 579 [485-875]           | 2891 [2469-3156] / 2812 [2563-3547]       |
| Guzzle          | 1891 [1860-2891] / 1796 [1703-1859]       | 280 [203-359] / 282 [188-328]         | 2360 [2093-2594] / 1968 [1844-2375]     | 3859 [3532-4531] / 3874 [3624-4204]       |
| ripgrep         | 3109 [2750-3563] / 3125 [2750-4124]       | 360 [219-532] / 501 [235-562]         | 626 [453-687] / 718 [453-734]           | 2296 [2047-3562] / 3031 [1984-3343]       |
| Humanizer       | 13625 [13125-25079] / 13093 [12844-23202] | 3938 [3376-6202] / 3797 [3625-6077]   | 11625 [9829-16407] / 9547 [8890-16484]  | 11766 [11594-18015] / 10781 [10328-17406] |

References use a fresh disk-backed index and detailed graph, then the same 50 queries twice.
The slower-round columns count pairs where head used more CPU, out of five.

| Corpus          | First 50 references                 | Repeated 50 references              | Slower rounds, first/repeated |
| --------------- | ----------------------------------- | ----------------------------------- | ----------------------------- |
| Hono            | 875 [781-1250] / 985 [766-1391]     | 922 [750-1563] / 968 [766-1126]     | 3/2                           |
| Spectre.Console | 1641 [1344-1765] / 906 [844-1063]   | 1422 [1328-1515] / 860 [735-1000]   | 0/0                           |
| okio            | 3093 [2327-3297] / 2032 [1781-2891] | 2016 [1657-2312] / 1484 [1297-1922] | 0/1                           |
| Django          | 5828 [4047-6485] / 4109 [3734-5110] | 4235 [2938-4438] / 2751 [2327-3328] | 0/0                           |
| Vapor           | 780 [719-1047] / 766 [547-1125]     | 640 [484-922] / 718 [547-766]       | 3/3                           |
| Guzzle          | 1360 [1234-1687] / 813 [750-937]    | 1109 [813-1500] / 407 [345-578]     | 0/0                           |
| ripgrep         | 1859 [1578-2108] / 1391 [1359-1844] | 2359 [2203-2485] / 1485 [1438-1953] | 1/0                           |
| Humanizer       | 2891 [2625-5812] / 3110 [2765-5876] | 2421 [2157-4374] / 2892 [2390-5015] | 3/3                           |

The Hono, Vapor, and Humanizer reference medians are mixed within broad ranges; they are not
evidence of an idle-speed improvement. Windows CPU accounting also quantized many 50-query goto
batches to zero. Their provisional wall-time medians, base/head in ms, were Hono 5/5,
Spectre.Console 5/5, okio 1/1, Django 11/9, Vapor 4/3, Guzzle 5/5, ripgrep 10/13, and Humanizer 4/4.

### Reference memory

Five alternating, unprofiled rounds; medians in MiB. Heap was measured after forced GC following
the disk-backed index build, detailed graph, and first 50 reference queries. Peak RSS is the
process peak through that operation, not a per-cache byte estimate.

| Corpus    | Post-GC heap base/head | Peak RSS base/head |
| --------- | ---------------------- | ------------------ |
| Hono      | 98.1 / 102.6           | 271.2 / 276.1      |
| Humanizer | 195.1 / 199.6          | 472.9 / 472.8      |

The added spelling tables use existing node references rather than new per-occurrence objects.
Their estimated map, string-key, and reference-array bytes count against the live query-cache
budget. Retention regressions verify the first lookup retains no spelling table, construction
on reuse, budget-triggered eviction, zero retained spelling bytes after eviction, reuse of native
columns, and identical answers after rebuilding.

### Retention and repeated-lookup refinements

- Retained-heap measurements found actual spelling-table bytes were 1.12-1.39x the original
  estimate. The estimate now includes 192 bytes per table and LRU entry, 24 bytes per occurrence,
  and 120 bytes plus two bytes per character for each distinct spelling.
- Spelling tables are optional accelerators and are evicted before parsed views or scopes.
  The original shared LRU lost 3-7% of Django's live entries at 150/250 MiB budgets; table
  eviction now has priority within the same live-byte budget.
- A repeated lookup collects candidate sites while building its table, without a separate
  candidate-bucket pass. The first lookup allocates no spelling map, and language-specific
  keys and skip rules come from language hooks and member-lookup policies.
- Member-name tables rely on each module's `locals` list remaining immutable and retain no
  cross-file answers. Three cache-on/off graph runs isolated 0.20 MiB [0.15-0.23] on Hono
  (18,584 indexed locals, about 11 bytes per indexed local) and 1.41 MiB [1.41-1.63] on Humanizer
  (28,242 indexed locals, about 52 bytes per indexed local). These module-lifetime facts are
  separate from the query syntax budget.

### Refinement measurements

Five alternating CPU-profile rounds repeated the same `StringHumanizeTests.cs` reference
lookup, with a third lookup checking reuse. Median spelling-region self time, in milliseconds:

| Lookup | Main self ms | Original table self ms | Fused collection self ms |
| ------ | ------------ | ---------------------- | ------------------------ |
| First  | 7.6          | 8.8                    | 7.9                      |
| Second | 7.7          | 11.1                   | 9.1                      |
| Third  | 7.8          | 0.0                    | 0.0                      |

Every first and second lookup read `namedChildren` 122,796 times in all three versions;
the third read it 122,796 times on main and once with either table implementation.
The second lookup still pays table-construction cost; the change removes the separate
candidate-bucket pass, not all construction overhead.

Self time is not the inclusive cost of the region. Inclusive second-lookup time was
17.1 / 27.3 ms on main/fused for Humanizer and 7.9 / 16.6 ms for Hono; table construction
breaks even at the third or fourth lookup, not the second. Across the full Hono batch,
inclusive region time was 181 / 109 ms initially and 170 / 13 ms on repeat.

Three profiled Humanizer first-50 batches read `namedChildren` 2,045,055 times on main and
1,523,116 times with either table implementation. Median spelling-region self time was
115.4 / 92.4 / 91.3 ms on main / original / fused; their ranges overlapped, so these shared-load
runs do not establish a whole-operation speedup.

Five cache-on/off runs compared retained spelling payloads with the revised estimates:

| Corpus    | First batch estimated/measured MiB | Repeated batch estimated/measured MiB |
| --------- | ---------------------------------- | ------------------------------------- |
| Hono      | 5.17 / 4.16                        | 5.53 / 4.50                           |
| Humanizer | 4.00 / 3.40                        | 7.63 / 6.64                           |

Matching five-run, unprofiled main/fused memory medians after graph construction and reference
queries are below. This controlled workload does not include the earlier index-update stages.

| Corpus and batch   | Post-GC heap main/fused MiB | Peak RSS main/fused MiB |
| ------------------ | --------------------------- | ----------------------- |
| Hono first         | 98.00 / 102.39              | 277.69 / 281.23         |
| Hono repeated      | 98.56 / 103.24              | 293.91 / 301.75         |
| Humanizer first    | 193.22 / 198.05             | 471.92 / 474.22         |
| Humanizer repeated | 193.64 / 201.74             | 474.51 / 476.74         |

Forward/reverse query differentials matched main with both the default and zero live-byte
budgets: 76 fixture projects, 756 files, 2,104 graph edges, 4,970 reference queries, 4,970 rename
collections, and 13,294 go-to-definition queries per budget. The 15 extra name/owner probes
also matched: 31 files, 244 graph edges, 628 reference queries, 628 rename collections, and
2,118 go-to-definition queries per budget. Coverage and matching unsupported-JSON errors
were compared rather than discarded; zero live bytes retained zero spelling-table bytes.

Before admission gating, constrained Django runs retained the same live-entry counts as main after both batches:
545 at 150 MiB and 962 at 250 MiB. No spelling payload remained at 150 MiB; at 250 MiB,
1,192,368 spelling bytes used spare budget without evicting another live entry.
The 150 MiB first/repeated `namedChildren` counts were unchanged at 12,360,832 / 12,383,793;
at 250 MiB the first count was 10,395,318 / 10,394,828 on main/fused and the repeated count
was 9,634,710 in both versions.

Under a saturated live budget, repeatedly building and immediately evicting tables added
39-47% to Django's region time despite leaving no retained spelling payload. The first
targeted walk now records an allocation-free upper bound by treating every occurrence as
a distinct spelling. Later lookups stay targeted unless that bound fits the remaining
live budget; the source-only hint survives view eviction and permits admission after space frees.

If a live view is evicted for budget pressure, that cache stops admitting new spelling
tables until its live budget is raised or a new index replaces it. A long-lived session
at its budget limit therefore runs main's targeted path; retained tables still have
eviction priority over views and scopes.

The final Django pressure-gated runs built zero tables and retained zero spelling bytes
in every 50-query batch. Both versions performed 1,775 targeted walks per batch, kept
545 / 962 live entries at 150 / 250 MiB, and returned 150 references.
The following inclusive region times are single paired, instrumented observations under
shared load, not idle-machine speed claims.

| Live budget | Batch    | Main region ms | Pressure-gated region ms |
| ----------- | -------- | -------------- | ------------------------ |
| 150 MiB     | First    | 522.0          | 488.5                    |
| 150 MiB     | Repeated | 551.7          | 526.8                    |
| 250 MiB     | First    | 607.7          | 554.8                    |
| 250 MiB     | Repeated | 561.8          | 547.4                    |

Default-budget Hono and Humanizer matched all six recorded work counters from `5a8f3f79`
exactly: tables built, targeted walks, reuses, build-node visits, targeted-node visits,
and bucket inserts. Their first/repeated built-targeted-reused counts remained
255-310-522 / 55-0-1032 for Hono and 503-1309-231 / 806-0-1237 for Humanizer.

## Batch evidence

The initial batch measurements compared against `49465a84` on Node 22.23.4 under shared Windows load.
On a 957-module project, five alternating runs had median baseline to head times of 6,525 to
8,650 ms for cold indexing, 704 to 707 ms for an unchanged update, 1,355 to 1,382 ms for a
one-file update, and 6,024 to 6,123 ms for the detailed graph. The corresponding times were
278 to 302 ms for references, 29.7 to 30.5 ms for go-to-definition, and 2,347 to 2,152 ms
for search. Each median stayed within the baseline spread; search's first round built its sidecar.

In that operation order, baseline wall spreads were 52.2%, 26.7%, 53.7%, 23.8%, 20.5%, 21.8%,
and 709.9%; head was slower in 2, 3, 3, 4, 3, 5, and 3 of the five rounds respectively. The first search
round accounts for most of its spread.

After the worker-sizing correction, five alternating runs on the same project, pinned to one
build and native thread, had median baseline to head times of 5,945 to 6,025 ms for cold indexing,
672 to 695 ms for an unchanged update, 1,370 to 1,446 ms for a one-file update, and 5,523 to
5,513 ms for the detailed graph. References, go-to-definition, and search were 269 to 266 ms,
29.6 to 30.4 ms, and 2,059 to 2,110 ms. Baseline spreads were 47.8%, 44.9%, 27.4%, 23.6%,
11.9%, 6.8%, and 59.3%; head was slower in 2, 4, 2, 2, 3, 3, and 2 rounds respectively.

Across 76 sample and edge-corpus projects and five real projects, 21,540 file edges, 40,438
detailed edges, and 2,886 go-to-definition and 2,886 reference answers, including coverage,
matched the baseline. All extracted specifiers in 100 stylesheet and SFC files also matched.
The detailed graph skipped one Humanizer file in both builds because its syntax tree was unavailable.
