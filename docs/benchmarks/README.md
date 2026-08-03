# Documentation benchmarks

## What the checked results show

On these tiny local fixtures, with Codegraph caching disabled and a fresh process for each sample:

- The preselected-read baseline completes in the low single-digit milliseconds. It is a filesystem floor with known paths, not a competing repository-discovery workflow.
- Codegraph uses one declared `explore` step while the baseline uses three declared read steps. This count does not represent equivalent work, agent round trips, or tool quality.
- Every expected evidence anchor is present in every checked run.
- The installer-preservation corpus keeps reviewed installer anchors ahead of generic MCP and benchmark decoys, recommends the installer source first, and returns its direct test.

These findings describe only the declared workflows and checked fixtures below. Completeness requires expected path anchors and any declared reviewed ordering, recommendation, and candidate-test relationships. It does not measure general answer quality, reasoning, relevance, correctness, or whether an agent could produce a good final answer.

## Reproduce locally

From the repository root, run:

```bash
npm run bench:docs
```

This command rebuilds stale `dist` output when needed, runs every scenario and both variants serially, requires complete anchors and reviewed relationships, rewrites `results.example.json` and the generated table below, and prints the median table. The fixtures are local and the run makes no network requests.

### Focused semantic regression fixture

`tests/refactor-plan-performance.test.ts` uses the deterministic TypeScript fixture under `tests/fixtures/refactor-plan-performance`. It records runtime metadata, operation samples for exact workspace lookup, direct and depth-3 calls, hierarchy and implementations, rename preview at 10, 100, and 1000 references, repeated warm plans, and hierarchy-index peak RSS.

The test asserts result structure, one-session and adjacency-cache behavior, plus deliberately generous environment-scoped time and memory ceilings. It is a regression guard, is not part of the checked comparison table below, and does not establish universal latency or scale claims.

## Persistent query substrate

`scripts/benchmarks/measure-query-substrate.mjs` measures warm CLI searches launched in fresh processes for `hybrid`, `text`, `symbol`, `path`, and `graph`. It also measures repeated searches through one MCP handler.

```bash
npm run build
npm run bench:query -- --root . --cli-samples 5 --mcp-samples 10
```

Pass `--include-baseline` to add same-machine cache-off rows. CLI timing includes process startup, project snapshot validation, search, and JSON serialization. MCP timing discards one warmup and reports the following calls.
Results are not universal latency claims; compare the same root, revision, query, Node version, and machine state.

## Semantic correctness corpus

The [`SemanticCorpusV1` manifest](./semantic-corpus.json) measures library-level definition, reference, dependency, and candidate-test behavior. It is separate from the `explore` comparison above: `scenarios.json` measures evidence-anchor presence for two workflows, while the semantic corpus compares structured API observations with reviewed goldens.

The initial release tier is small, checked in, deterministic, and network-free. It covers Go, Python, and TypeScript fixtures, candidate-test ordering, and an explicit Markdown navigation limitation; the representative tier currently has no external cases and therefore cannot block a release.

Run and validate the checked example from the repository root:

```bash
npm run build
npm run bench:semantic -- --tier release --mode native --mode reduced --package-mode checkout --output docs/benchmarks/semantic-results.example.json
npm run bench:semantic:summarize -- --input docs/benchmarks/semantic-results.example.json --check
```

Use `--dry-run` to validate the manifest and print a byte-stable ordered plan without loading Codegraph. Release automation can point `--package-root` at an installed candidate and set `--package-mode packed`; checkout and packed results are never presented as the same package mode.

### Corpus and golden contract

Every case names a declared repository id, tier, language, operation, data-only request, expected observations, and review rationale. The validator rejects absolute and traversing paths, environment expansion, executable fields, undeclared repository ids, duplicate observations, unknown schema fields, and local fixture paths that escape through symlinks.

Definition and reference goldens use project-relative files and exact one-based ranges. Dependency goldens compare normalized `(from, to, kind)` tuples, where `kind` is `dependency` or `type-only`; candidate-test goldens compare ordered project-relative test files.

Rationales begin with `Source review:` or `Limitation review:` so a golden cannot be an unexplained Codegraph dump. A golden change still requires source review and a second human reviewer; symbol handles are request inputs only and are not golden identities.

### Scoring and result schema

For a supported case, a returned required observation is a true positive and an omitted required observation is a false negative. A returned forbidden observation is a false positive, an allowed observation is neutral, and an unexpected observation is reported for triage rather than silently reclassified.

Duplicate returned observations are reported and de-duplicated before scoring. Precision is `TP / (TP + FP)`, recall is `TP / (TP + FN)`, and F1 is their harmonic mean; a metric with no denominator is `null`, not an invented perfect score.

Support is successful cases divided by all selected cases. Unsupported and execution-error rows stay in that denominator but are excluded from precision and recall, so every public accuracy row must be read with its support count.

Candidate-test cases also report reciprocal rank for the first required test, and summaries report mean reciprocal rank. Latency uses nearest-rank p50, p95, and maximum over successful operation calls; it excludes index construction, and one cache-off explicit-file index is reused for cases in the same repository and runtime mode.

[`semantic-results.example.json`](./semantic-results.example.json) records the corpus digest and revision, selected tiers and cases, package name, version and mode, runtime environment, every returned observation, per-case score, and grouped summaries. Native and reduced rows are always separate and are summarized by operation, language, repository, and total.

The checked result is informational. No absolute accuracy or latency threshold exists yet, and the no-baseline scaffold reports `not-configured` without turning the example into a release gate.

### Representative tier and limits

The scheduled [`semantic-corpus.yml`](../../.github/workflows/semantic-corpus.yml) job is informational and has `continue-on-error`. It currently writes a schema-valid empty representative report; pinned public repositories should be added only with an immutable commit, a reviewed permissive license, bounded include roots, and no release dependency on clone availability.

This corpus is not a compiler conformance suite and does not prove universal correctness. Its fixtures are tiny, checked-in examples; ambiguous language behavior, generated code, macros, dynamic dispatch, large-repository scaling, cold index latency, and network reliability remain outside the current evidence.

## Workflows and metrics

Each checked scenario in [`scenarios.json`](./scenarios.json) defines a local fixture, a task, ordered expected anchors, and the exact steps for both variants. The scenarios cover TypeScript request paths, Python imports, SQL migration and application coupling, Markdown-to-TypeScript request paths, and installer-preservation ranking.

- **Baseline workflow:** three declared direct UTF-8 file reads. The files are selected in advance, so this is not an unaided discovery task.
- **Codegraph workflow:** one local `codegraph explore <query> --root <fixture> --cache off --json` call. It starts a fresh CLI process and builds a cold in-process index for every sample.
- **Tool calls:** declared workflow steps. A direct read and an `explore` call both count as one, despite doing unequal work.
- **File reads:** baseline read steps, or unique source paths Codegraph returns in `packets` or `fileView`. This is a context-delivery count, not total parser, indexer, operating-system, or disk I/O.
- **Wall time:** elapsed time around declared steps. It includes Codegraph process startup and cold indexing but excludes harness setup.
- **Completeness:** the fraction of expected path anchors found as text in captured evidence. It is evidence-anchor presence, not an answer-quality score.
- **Reviewed relationships:** selected scenarios declare exact anchor partial orders, one recommended file, and required candidate tests. Results record one-based ranks and reciprocal ranks descriptively; no aggregate accuracy threshold, top-k target, or percentage is inferred.

Medians are calculated independently for each scenario and variant. Tool calls and returned files can approximate workflow coordination and delivered context, but they are not units of time, tokens, bytes, or effort.

## Checked results

[`results.example.json`](./results.example.json) contains the checked runs behind this table. A SHA-256 digest binds it to the exact ordered scenario definitions. Validation requires every selected scenario, both variants, and every expected run exactly once; it also checks declared step counts and the exact reviewed relationship schema. The summarizer generates and orders every table cell, and `npm run bench:docs:check` detects drift.

<!-- benchmark-results:start -->

| Scenario                         | Variant   | Samples | Median tool calls | Median file reads | Median wall time (ms) | Complete runs | Minimum completeness | Reviewed relationships                              |
| -------------------------------- | --------- | ------: | ----------------: | ----------------: | --------------------: | ------------: | -------------------: | --------------------------------------------------- |
| repo-orientation-small-ts        | baseline  |       3 |                 3 |                 3 |                 2.529 |             3 |                 100% | -                                                   |
| repo-orientation-small-ts        | codegraph |       3 |                 1 |                 3 |               410.586 |             3 |                 100% | -                                                   |
| python-import-reference          | baseline  |       3 |                 3 |                 3 |                 2.507 |             3 |                 100% | -                                                   |
| python-import-reference          | codegraph |       3 |                 1 |                 3 |               447.115 |             3 |                 100% | -                                                   |
| sql-migration-application-review | baseline  |       3 |                 3 |                 3 |                 2.515 |             3 |                 100% | -                                                   |
| sql-migration-application-review | codegraph |       3 |                 1 |                 3 |               456.471 |             3 |                 100% | -                                                   |
| mixed-docs-source-graph          | baseline  |       3 |                 3 |                 3 |                 3.781 |             3 |                 100% | -                                                   |
| mixed-docs-source-graph          | codegraph |       3 |                 1 |                 3 |               400.407 |             3 |                 100% | -                                                   |
| installer-preservation-ranking   | baseline  |       3 |                 3 |                 3 |                 2.418 |             3 |                 100% | -                                                   |
| installer-preservation-ranking   | codegraph |       3 |                 1 |                 3 |               435.459 |             3 |                 100% | 4 exact observations; ranks in results.example.json |

<!-- benchmark-results:end -->

The checked result document records Node, platform, architecture, CPU, logical CPU count, and memory so reruns can be compared in context.

## Where the checked latency comes from

The checked artifact was produced from a Windows checkout. Its environment metadata is recorded in `results.example.json`, and the generated table above is the source of its measured values.

The comparison is intentionally end-to-end but not process-symmetric. Baseline reads execute inside the already-running harness and read three preselected files; Codegraph launches a fresh Node process, discovers files, builds a cold index, searches, constructs evidence packets, and serializes JSON. The table measures workflow latency and call count, not equivalent-operation throughput or native parser speed.

Read the Codegraph wall-time rows as absolute cold CLI latency. Do not divide them by the baseline rows to estimate a slowdown; use an equal-work engine benchmark for parser or index throughput comparisons.
Compare query benchmarks only when root, revision, query, Node version, and machine state are the same.

Persistent MCP/server sessions amortize process startup and project loading. Measure those warm workflows separately before using this cold CLI table to set interactive latency targets.

## Limitations and variability

- These fixtures are tiny, local, synthetic, and network-free. They do not represent large repositories, remote tools, warm indexes, long sessions, concurrent agents, or ambiguous discovery tasks.
- The baseline reads preselected files, while Codegraph starts a process, parses, indexes, and returns structured evidence. The workflows do not perform equivalent internal work.
- Codegraph runs with `--cache off`; the harness does not clear operating-system file caches or reboot the host. Node version, hardware, storage, memory pressure, antivirus, scheduling, build freshness, and system load can change wall times.
- Three samples per variant are a modest evidence set. Treat small timing differences cautiously and compare reruns using the recorded environment.
- The benchmark does not measure answer quality, tokens, output size, or human effort. Complete anchors can still accompany misleading evidence or a wrong answer.
- Fixture trees, scenario files, and output parents are trusted local maintainer inputs. Traversal and symlink checks prevent common mistakes, but the harness is not an adversarial sandbox; do not rename or retarget these paths during a run.

Use the table only for claims directly supported by its checked fixtures and rows, not for broad claims about speed, quality, scale, or universal performance.

## Related documentation

- [How it works](../how-it-works.md) explains runtime performance and cache behavior.
- [Agent workflows](../agent-workflows.md) describes the agent-facing `explore` workflow measured here.
