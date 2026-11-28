# Paired source-family benchmark

`npm run bench:paired` compares two already-built checkouts in separate Node processes. It adapts the accuracy batches' paired benchmark and measures nine operations, with base/head order reversed on every round. The default is six rounds for balanced run order, one project per source-language family, and `threads: 1` / `nativeThreads: 1` for both versions.

## Inputs and command

Build each checkout before starting, then leave both builds unchanged until the run ends. Prepare clean local Git checkouts at the revisions in [`scripts/benchmarks/corpus.json`](../../scripts/benchmarks/corpus.json); `accuracyId` entries reuse the URL, commit, and include/exclude scope from [`scripts/accuracy/corpus.json`](../../scripts/accuracy/corpus.json). The command checks each input's HEAD and tracked contents, clones it locally into isolated temporary projects with separate caches, and never modifies the input checkout.

Each Codegraph checkout prints `dirty` (tracked changes and untracked files) and `distOlderThanSources` on stdout and records them with its revision and version in JSON. Freshness compares the newest tracked/untracked source or build-input timestamp against the oldest runtime artifact anywhere under `dist` (excluding maps and declarations); missing tracked build inputs also mark it stale. These are provenance signals, not a content-level build attestation: build and commit each checkout before recording final performance evidence. The default `paired-benchmark.json` output is git-ignored.

```bash
npm run bench:paired -- /checkouts/base /checkouts/head \
  --corpus-dir /data/corpora --output /data/results/paired.json
```

The corpus directory contains `hono`, `humanizer`, `okio`, `cjson`, `flask`, `rubocop`, `guzzle`, `gin`, `ripgrep`, `Kingfisher`, and `zls`. To run a smaller comparison, pass `--families ecmascript,dotnet` (also available: `jvm,c-cpp,python,ruby,php,go,rust,swift,zig`). A `--corpus-map paths.json` can supply an object mapping corpus IDs to existing checkout paths instead of relocating them; unspecified IDs use `--corpus-dir`.

- `--rounds N`: at least five paired rounds; default 6. Prefer an even count to balance which version runs first.
- `--operations search-index,search`: time only the listed operations, in the order of the table below; default all nine.
- `--threads N` / `--native-threads N`: positive, identical limits for both versions; default 1 each. Native worker auto-selection is unchanged, and every build report records whether workers actually ran.
- `--output file.json`: raw samples, medians, spreads, paired ratio/noise, slower counts, verdicts, build counters, and memory observations. Default: `paired-benchmark.json` in the caller's directory.
- `--profile-dir directory`: after timing, capture a separate baseline V8 CPU profile for each operation. Instrumented runs never enter the paired verdict.
- `--profile-only --profile-dir directory`: skip paired timing and capture each baseline operation once, useful for identifying self-time costs. No regression verdict is produced in this mode.

## Measured boundaries

| Operation      | Timed work                                                                                      | Untimed setup                                 |
| -------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `init`         | `initCodegraphLifecycle` with a clean project lifecycle directory and empty isolated disk cache | Library import and cache removal              |
| `cold`         | `buildProjectIndexIncremental` with `cache: "off"`                                              | Library import                                |
| `nochange`     | `buildProjectIndexIncremental` with its populated disk cache                                    | Initial cache warmup                          |
| `onefile`      | The same incremental builder after toggling one appended comment line                           | Source edit                                   |
| `graph`        | `buildSymbolGraphDetailed`                                                                      | Disk-backed index load                        |
| `search-index` | `ensureSessionQueryIndex` creating the search sidecar from source                               | Session, index load, and sidecar removal      |
| `search`       | One hybrid `searchCodegraphWithSession` per sampled declaration name                            | Session, basic graph, and query-index loading |
| `refs`         | `findReferences` for up to 25 fixed declaration positions                                       | Disk-backed index load                        |
| `goto`         | `goToDefinition` at reference use-sites of those declarations                                   | Disk-backed index load                        |

`init` is **init (library, CLI startup excluded)**, not end-to-end `node dist/cli.js init` latency. The CLI has no `nativeThreads` control, so measuring its implementation through the library is necessary to pin both thread limits. Every operation runs in a fresh process; all timings exclude process startup and library loading.

The baseline chooses and records the exact declarations, search terms, use-sites, and touched source once; head uses the same positions. Queries must have actual reference use-sites, and preparation fails rather than reporting an empty navigation workload. Search runs each distinct term once in the prepared session, so it measures query work rather than repeated result-cache hits.

## Verdict and limitations

Each round must return identical base/head workload counters: indexed files, graph nodes/edges, sidecar files and source files read, search queries/matches, or navigation sites/found targets/references, as applicable. A mismatch fails the command rather than comparing different work. Build-strategy counters and memory remain diagnostic, not equality requirements.

Base/head spreads remain `(maximum - minimum) / median * 100` for context. The paired effect is the median of each round's `head / base` ratio; paired noise is `1.4826 * median(abs(ratio - median ratio))`, expressed as a percentage. This robust noise band is descriptive, not a confidence interval or significance test.

A regression requires the entire paired band above `1.02` and head slower in a majority of rounds; an improvement requires the entire band below `0.98` and head faster in a majority. A band wholly within `[0.98, 1.02]` is `within-noise`; all other results are `inconclusive`, not evidence of no regression. A regression verdict exits nonzero after saving results; inconclusive runs must be repeated under quieter conditions before accepting an optimization.

Two contamination guards override a verdict to `inconclusive`: at least two paired ratios outside `median +/- max(3 * noise, 0.05)`, or a series-median ratio more than five percentage points away from the paired median ratio. They prevent tight MAD estimates from hiding multiple large bursts or opposing distribution shifts while retaining the single-outlier regression case. JSON retains both median ratios and the outlier count.

Local clones retain Git discovery and status behavior. An unchanged update uses a warm disk snapshot in a fresh process, not an in-memory session update. OS page caches, native/Node installation caches, antivirus activity, and other processes are not reset or controlled; run on an idle machine and treat busy-machine wall time as provisional.

V8 profiles bracket only the named operation on the main isolate. They include native calls executed there but not native CPU running on extraction worker isolates; `(idle)` is waiting, not a JavaScript bottleneck. Peak RSS is process-wide (including setup and workers); `heapUsedAfterGc` and `rssAfterGc` are taken after an explicit GC at the end, not incremental allocation counts.

Environment metadata records Node, npm, platform, CPU, memory, and both Codegraph revisions/versions. The manifest scopes are source-family representatives, not a performance claim for every language or graph-only format. A timing verdict is not semantic validation: optimization reviews still need detailed-graph, go-to-definition, and reference/coverage differentials over samples, edge corpora, and real projects.

## Single-operation profiles

`scripts/benchmarks/profile-operation.mjs` runs one operation of one checkout in a fresh process, including incremental updates, MCP refresh and freshness checks, search sidecar builds, and every agent query batch. It records process CPU, wall time, `fs` and Git call counts, and memory, and optionally writes a CPU profile, precise call counts, or a sampling heap profile; `scripts/benchmarks/summarize-profile.mjs` maps those to `src/` lines. It ranks costs and gives no regression verdict; [the performance ROI analysis](../plans/2026-11-27-performance-roi.md) lists the commands per item.

## Answer snapshots for reviews

`npm run answers:snapshot:check` checks committed answers for every sample project and edge-corpus scenario, alongside `graph:snapshot:check` in `npm run check` and in CI. `npm run answers:snapshot` regenerates them; classify every changed answer against base/head evidence before committing. Each file records goto targets and public `via=`/`prov=` metadata, plus references for every indexed declaration and deduplicated goto target (including parameters, local/type parameters, aliases, and Rust modules); there is no sampling or result cap.

Identifiers use each language's identifier/property/shorthand vocabulary plus constant/type/field forms and PHP `new` sites; nested nodes sharing a start position issue the same goto query once. SCSS member leaves parsed inside `ERROR` nodes, other punctuation/operator leaves, and keyword leaves are excluded even when an ancestor-based lookup could resolve them; examples include PHP `\`, C++ `::`/`<`/`>`, JS/TS `as`/`=`, and Terraform `.`/`[*]`. Graph-only formats have no syntax identifiers, and unsupported parsers (such as indexed JSON exports) are explicit outcomes, not successful empty answers.

Reference `order=` ranks and `affectedFiles` arrays preserve the API's returned order; sorted records do not hide ordering changes that affect truncated consumers. `findReferences` and other locale-sensitive data-output sorts use fixed en-US collation rather than the process locale. Metadata keys are sorted, path fields are project-relative, and path spelling is normalized to NFC, while source identifier spelling is preserved. Rename previews are not recorded: they repeat reference collection, conflict scans, and source verification.

For real projects, use the same clean checkouts and include/exclude scopes as the paired benchmark. Write the baseline to an external scratch directory, then compare head without committing either result:

```bash
node scripts/answer-snapshot-corpora.mjs --dist /checkouts/base/dist \
  --corpus-dir /data/corpora --dir /data/review/answers
node scripts/answer-snapshot-corpora.mjs --dist /checkouts/head/dist \
  --corpus-dir /data/corpora --dir /data/review/answers --check
```

The runner verifies pinned commits and clean inputs, never clones or edits them, and rejects output overlapping a Codegraph checkout or indexed corpus. Explicit `--dir` paths resolve against the caller's working directory; write mode refuses directories containing unrelated `.txt` files. Optional `--families ecmascript,dotnet` selects benchmark families; use separate output directories for different selections. `--dist` also works with `scripts/answer-snapshot.mjs` to compare both builds on identical fixture bytes without rebuilding either checkout; a failed check prints a regeneration command retaining its runtime and family selection.
