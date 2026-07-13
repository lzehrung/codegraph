# Documentation benchmarks

## What the checked results show

On these tiny local fixtures, with Codegraph caching disabled and a fresh process for each sample:

- The preselected-read baseline completes in the low single-digit milliseconds. It is a filesystem floor with known paths, not a competing repository-discovery workflow.
- Codegraph uses one declared `explore` step while the baseline uses three declared read steps. This count does not represent equivalent work, agent round trips, or tool quality.
- Every expected evidence anchor is present in every checked run.

These findings describe only the declared workflows and checked fixtures below. Completeness means that expected path anchors appear in captured evidence. It does not measure answer quality, reasoning, relevance, correctness, or whether an agent could produce a good final answer. The benchmark also does not show that either workflow is generally faster, cheaper, or better at repository discovery.

## Reproduce locally

From the repository root, run:

```bash
npm run bench:docs
```

This command rebuilds stale `dist` output when needed, runs every scenario and both variants serially, requires complete anchor evidence, rewrites `results.example.json` and the generated table below, and prints the median table. The fixtures are local and the run makes no network requests.

### Focused semantic regression fixture

`tests/refactor-plan-performance.test.ts` uses the deterministic TypeScript fixture under `tests/fixtures/refactor-plan-performance`. It records runtime metadata, operation samples for exact workspace lookup, direct and depth-3 calls, hierarchy and implementations, rename preview at 10, 100, and 1000 references, repeated warm plans, and hierarchy-index peak RSS.

The test asserts result structure, one-session and adjacency-cache behavior, plus deliberately generous environment-scoped time and memory ceilings. It is a regression guard, is not part of the checked comparison table below, and does not establish universal latency or scale claims.

## Workflows and metrics

Each checked scenario in [`scenarios.json`](./scenarios.json) defines a local fixture, a task, ordered expected anchors, and the exact steps for both variants. The scenarios cover TypeScript request paths, Python imports, SQL migration and application coupling, and Markdown-to-TypeScript request paths.

- **Baseline workflow:** three declared direct UTF-8 file reads. The files are selected in advance, so this is not an unaided discovery task.
- **Codegraph workflow:** one local `codegraph explore <query> --root <fixture> --cache off --json` call. It starts a fresh CLI process and builds a cold in-process index for every sample.
- **Tool calls:** declared workflow steps. A direct read and an `explore` call both count as one, despite doing unequal work.
- **File reads:** baseline read steps, or unique source paths Codegraph returns in `packets` or `fileView`. This is a context-delivery count, not total parser, indexer, operating-system, or disk I/O.
- **Wall time:** elapsed time around declared steps. It includes Codegraph process startup and cold indexing but excludes harness setup.
- **Completeness:** the fraction of expected path anchors found as text in captured evidence. It is evidence-anchor presence, not an answer-quality score.

Medians are calculated independently for each scenario and variant. Tool calls and returned files can approximate workflow coordination and delivered context, but they are not units of time, tokens, bytes, or effort.

## Checked results

[`results.example.json`](./results.example.json) contains the checked runs behind this table. A SHA-256 digest binds it to the exact ordered scenario definitions. Validation requires every selected scenario, both variants, and every expected run exactly once; it also checks declared step counts. The summarizer generates and orders every table cell, and `npm run bench:docs:check` detects drift.

<!-- benchmark-results:start -->

| Scenario                         | Variant   | Samples | Median tool calls | Median file reads | Median wall time (ms) | Complete runs | Minimum completeness |
| -------------------------------- | --------- | ------: | ----------------: | ----------------: | --------------------: | ------------: | -------------------: |
| repo-orientation-small-ts        | baseline  |       3 |                 3 |                 3 |                 2.571 |             3 |                 100% |
| repo-orientation-small-ts        | codegraph |       3 |                 1 |                 3 |               490.863 |             3 |                 100% |
| python-import-reference          | baseline  |       3 |                 3 |                 3 |                 2.068 |             3 |                 100% |
| python-import-reference          | codegraph |       3 |                 1 |                 2 |               480.674 |             3 |                 100% |
| sql-migration-application-review | baseline  |       3 |                 3 |                 3 |                  2.09 |             3 |                 100% |
| sql-migration-application-review | codegraph |       3 |                 1 |                 3 |               522.643 |             3 |                 100% |
| mixed-docs-source-graph          | baseline  |       3 |                 3 |                 3 |                 2.164 |             3 |                 100% |
| mixed-docs-source-graph          | codegraph |       3 |                 1 |                 3 |               461.371 |             3 |                 100% |

<!-- benchmark-results:end -->

The checked result document records Node, platform, architecture, CPU, logical CPU count, and memory so reruns can be compared in context.

## Where the checked latency comes from

The checked artifact was produced from a Windows checkout. Its environment metadata is recorded in `results.example.json`, and the generated table above is the source of its measured values.

The comparison is intentionally end-to-end but not process-symmetric. Baseline reads execute inside the already-running harness and read three preselected files; Codegraph launches a fresh Node process, discovers files, builds a cold index, searches, constructs evidence packets, and serializes JSON. The table measures workflow latency and call count, not equivalent-operation throughput or native parser speed.

Read the Codegraph wall-time rows as absolute cold CLI latency. Do not divide them by the baseline rows to estimate a slowdown; use an equal-work engine benchmark for parser or index throughput comparisons.

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
