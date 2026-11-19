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

- [ ] Commit a paired base/head benchmark command that covers all eight operations above, alternates
      the run order each round, and reports median, spread, rounds where head was slower, and the
      regression verdict. The accuracy batches used an uncommitted version of this harness.
- [ ] Pin a real-project corpus per language family (repository URL and commit), reusing the
      accuracy benchmark manifest where possible.
- [ ] Profile `main` on each operation and corpus, and record the top self-time functions here so
      the items below can be ranked by measured cost.

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
- [ ] **Size the native worker pool by project size.** Cold builds start up to eight native
      extraction workers regardless of file count. Measure worker startup against extraction work
      for 100 to 500 file projects and for `codegraph init`, and choose the pool size from the
      file count.
- [ ] **Count Git processes per operation.** Incremental fixes in #523 and #529 showed per-update Git
      listing and stat passes as visible costs (an end-of-line stat pass alone added 185 to 467 ms
      per unchanged update on a 10,000-file repository before it was removed). Count spawned Git
      processes for init, updates, and queries, then batch or reuse their results.
- [ ] **Profile `codegraph init`.** A cold `init` on a 651-file project measured a 3,788 ms median on
      3.2.0 versus 3,390 ms on 3.1.3 (three alternating runs, about 12% slower). The cause is
      unconfirmed; candidates are lifecycle root discovery, incremental Git checks, and new
      per-file facts.
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
