# Documentation benchmarks

## What the checked results show

On these tiny local fixtures:

- The preselected-read baseline completes in the low single-digit milliseconds. It is a filesystem floor with known paths, not a competing repository-discovery workflow.
- Each codegraph variant uses one declared `explore` step while the baseline uses three declared read steps. This count does not represent equivalent work, agent round trips, or tool quality.
- Cold CLI starts a fresh process with caching disabled. Warm CLI starts a fresh process for each measured sample after an unmeasured disk-cache warmup. Warm MCP reuses one handler session after an unmeasured first request.
- Every expected evidence anchor is present in every checked run.
- The installer-preservation corpus keeps reviewed installer anchors ahead of generic MCP and benchmark decoys, recommends the installer source first, and returns its direct test.

These findings describe only the declared workflows and checked fixtures below. Completeness requires expected path anchors and any declared reviewed ordering, recommendation, and candidate-test relationships. It does not measure general answer quality, reasoning, relevance, correctness, or whether an agent could produce a good final answer.

## Reproduce locally

From the repository root, run:

```bash
npm run bench:docs
```

This command rebuilds stale `dist` output when needed, runs every scenario and all four variants serially, requires complete anchors and reviewed relationships, rewrites `results.example.json` and the generated table below, and prints the median table. Each warm workflow uses an isolated temporary cache that is removed after its scenario. The fixtures are local and the run makes no network requests.

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

## Fixture test matrix

[`fixture-snapshot.md`](./fixture-snapshot.md) shows per-language status and test counts generated directly from `tests/languages/*.test.ts` runs. Regenerate with `npm run bench:fixtures`; verify it is current with `npm run bench:fixtures:check`. This, and the rest of the automated test suite, is also what release certification checks: there is no separate hand-authored golden corpus.

## Workflow definitions

Each checked scenario in [`scenarios.json`](./scenarios.json) defines a local fixture, a task, expected anchors, and exact steps for the required baseline and cold CLI variants. It may also declare the warm CLI and warm MCP variants, which use the same query steps.

- **Baseline workflow:** three declared direct UTF-8 file reads from preselected files.
- **Cold CLI workflow (`codegraph`):** one local `codegraph explore <query> --root <fixture> --cache off --json` call in a new process for every sample.
- **Warm CLI workflow (`warm-cli`):** one local `explore` call in a new process for every measured sample, using an isolated disk cache populated by the same unmeasured query.
- **Warm MCP workflow (`warm-mcp`):** one `explore` call through one in-process MCP handler session after the same unmeasured first request. It uses a separate isolated disk cache.
- **Tool calls:** declared measured workflow steps only. Warmup calls are excluded.
- **File reads:** baseline read steps, or unique source paths codegraph returns in `packets` or `fileView`.
- **Wall time:** elapsed time around declared measured steps. It excludes setup, warmup, and cache cleanup.
- **Completeness:** whether the expected anchors were present in the captured evidence. Reviewed scenarios also require their declared order, recommendation, and candidate-test relationships in every codegraph variant.

Medians are calculated independently for each scenario and variant.

## Checked results

[`results.example.json`](./results.example.json) contains the checked runs behind this table. A SHA-256 digest binds it to the exact ordered scenario definitions. Validation requires every selected scenario, each declared variant, and every expected run exactly once; it also checks declared step counts and the exact reviewed relationship schema. The summarizer generates and orders every table cell, and `npm run bench:docs:check` detects drift.

<!-- benchmark-results:start -->

| Scenario                         | Variant   | Samples | Median tool calls | Median file reads | Median wall time (ms) | Complete runs | Minimum completeness | Reviewed relationships                              |
| -------------------------------- | --------- | ------: | ----------------: | ----------------: | --------------------: | ------------: | -------------------: | --------------------------------------------------- |
| repo-orientation-small-ts        | baseline  |       3 |                 3 |                 3 |                 2.528 |             3 |                 100% | -                                                   |
| repo-orientation-small-ts        | codegraph |       3 |                 1 |                 3 |               750.271 |             3 |                 100% | -                                                   |
| repo-orientation-small-ts        | warm-cli  |       3 |                 1 |                 3 |               761.233 |             3 |                 100% | -                                                   |
| repo-orientation-small-ts        | warm-mcp  |       3 |                 1 |                 0 |                 0.899 |             3 |                 100% | -                                                   |
| python-import-reference          | baseline  |       3 |                 3 |                 3 |                 2.113 |             3 |                 100% | -                                                   |
| python-import-reference          | codegraph |       3 |                 1 |                 3 |               762.438 |             3 |                 100% | -                                                   |
| python-import-reference          | warm-cli  |       3 |                 1 |                 3 |               768.556 |             3 |                 100% | -                                                   |
| python-import-reference          | warm-mcp  |       3 |                 1 |                 0 |                 0.618 |             3 |                 100% | -                                                   |
| sql-migration-application-review | baseline  |       3 |                 3 |                 3 |                 2.381 |             3 |                 100% | -                                                   |
| sql-migration-application-review | codegraph |       3 |                 1 |                 3 |               809.596 |             3 |                 100% | -                                                   |
| sql-migration-application-review | warm-cli  |       3 |                 1 |                 3 |                749.54 |             3 |                 100% | -                                                   |
| sql-migration-application-review | warm-mcp  |       3 |                 1 |                 0 |                 0.478 |             3 |                 100% | -                                                   |
| mixed-docs-source-graph          | baseline  |       3 |                 3 |                 3 |                 1.884 |             3 |                 100% | -                                                   |
| mixed-docs-source-graph          | codegraph |       3 |                 1 |                 3 |               746.868 |             3 |                 100% | -                                                   |
| mixed-docs-source-graph          | warm-cli  |       3 |                 1 |                 3 |               744.929 |             3 |                 100% | -                                                   |
| mixed-docs-source-graph          | warm-mcp  |       3 |                 1 |                 0 |                 0.856 |             3 |                 100% | -                                                   |
| installer-preservation-ranking   | baseline  |       3 |                 3 |                 3 |                 2.066 |             3 |                 100% | -                                                   |
| installer-preservation-ranking   | codegraph |       3 |                 1 |                 3 |               760.986 |             3 |                 100% | 4 exact observations; ranks in results.example.json |
| installer-preservation-ranking   | warm-cli  |       3 |                 1 |                 3 |               762.427 |             3 |                 100% | 4 exact observations; ranks in results.example.json |
| installer-preservation-ranking   | warm-mcp  |       3 |                 1 |                 0 |                 0.284 |             3 |                 100% | 4 exact observations; ranks in results.example.json |

<!-- benchmark-results:end -->

The checked result document records Node, platform, architecture, CPU, logical CPU count, and memory so reruns can be compared in context.

## Where the checked latency comes from

The checked artifact was produced from a Windows checkout. Its environment metadata is recorded in `results.example.json`, and the generated table above is the source of its measured values.

The comparison is intentionally end-to-end but not process-symmetric. Baseline reads execute inside the already-running harness and read three preselected files; cold CLI launches a fresh Node process, discovers files, builds a cold index, searches, constructs evidence packets, and serializes JSON. Warm CLI separates cache reuse from process startup.

Warm MCP also reuses an in-process handler session. The table measures workflow latency and call count, not equivalent-operation throughput or native parser speed.

Read each wall-time row only as the named workflow latency. Do not divide any codegraph row by the baseline row to estimate a slowdown; use an equal-work engine benchmark for parser or index throughput comparisons. Compare query benchmarks only when root, revision, query, Node version, and machine state are the same.

## Limitations and variability

- These fixtures are tiny, local, synthetic, and network-free. They do not represent large repositories, remote tools, concurrent agents, or ambiguous discovery tasks.
- The baseline reads preselected files, while codegraph discovers, indexes, and returns structured evidence. The workflows do not perform equivalent internal work.
- Cold CLI runs with `--cache off`. The two warm workflows use fresh isolated temporary disk-cache directories, but the harness does not clear operating-system file caches or reboot the host. Node version, hardware, storage, memory pressure, antivirus, scheduling, build freshness, and system load can change wall times.
- Warm MCP is an in-process handler measurement. It excludes transport framing and client-process overhead.
- Three measured samples per variant are a modest evidence set. Treat small timing differences cautiously and compare reruns using the recorded environment.
- The benchmark does not measure answer quality, tokens, output size, or human effort. Complete anchors can still accompany misleading evidence or a wrong answer.
- Fixture trees, scenario files, and output parents are trusted local maintainer inputs. Traversal and symlink checks prevent common mistakes, but the harness is not an adversarial sandbox; do not rename or retarget these paths during a run.

Use the table only for claims directly supported by its checked fixtures and rows, not for broad claims about speed, quality, scale, or universal performance.

## Related documentation

- [How it works](../how-it-works.md) explains runtime performance and cache behavior.
- [Agent workflows](../agent-workflows.md) describes the agent-facing `explore` workflow measured here.
