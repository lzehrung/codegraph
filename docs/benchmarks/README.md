# Documentation benchmarks

This benchmark compares two declared workflows for fixed repository-understanding tasks on local fixtures. It measures workflow steps, source files returned to the workflow, elapsed time, and expected-anchor presence; it does not measure answer quality or establish general performance.

## Reproduce locally

From the repository root, run:

```bash
npm run bench:docs
```

This is the one-command reproduction. It rebuilds stale `dist` output when needed, runs both variants serially for every scenario in `scenarios.json`, requires complete anchor evidence, writes `.tmp/public-docs-benchmark-results.json`, and prints the median table.

To run one scenario directly, first ensure the CLI is built and then select the scenario:

```bash
node scripts/ensure-dist-for-tests.mjs
node scripts/benchmarks/run-scenario.mjs --scenario repo-orientation-small-ts --output .tmp/public-docs-benchmark-results.json --require-complete
```

`--scenario` is repeatable and also accepts comma-separated IDs. Without `--scenario`, the runner uses every scenario in `docs/benchmarks/scenarios.json`; `--runs` can override the positive sample count, and `--scenario-file` can select a different scenario file.

Summarize any compatible result file without changing documentation:

```bash
node scripts/benchmarks/summarize-results.mjs --input .tmp/public-docs-benchmark-results.json --scenario-file docs/benchmarks/scenarios.json
```

The checked table is refreshed only from the checked evidence and verified for drift with:

```bash
node scripts/benchmarks/summarize-results.mjs --input docs/benchmarks/results.example.json --scenario-file docs/benchmarks/scenarios.json --readme docs/benchmarks/README.md --write
npm run bench:docs:check
```

## Scenario and variant definitions

A scenario is the exact local repository, task, ordered expected anchors, metric list, and ordered variant steps checked into [`scenarios.json`](./scenarios.json). The checked scenarios cover TypeScript request paths, Python imports, SQL schema/migration/application coupling, and Markdown-to-TypeScript request paths.

- **Baseline:** an explicit, checked sequence of direct UTF-8 file reads named by the scenario. It is a reproducible file-read workflow, not an unaided human or language-model attempt.
- **Codegraph:** the scenario's checked query is executed as local `codegraph explore <query> --root <fixture> --cache off --json`. It uses the built CLI, disables Codegraph caching, and does not contact a network service.

Both variants execute exactly their declared steps. Scenarios and variants run serially, so there is no parallel-work advantage in either measurement.

## Metric semantics

- **Tool calls:** the number of declared workflow steps. Each direct baseline read and each Codegraph `explore` invocation counts as one call, although those calls have unequal computational cost and output.
- **File reads:** for the baseline, the number of declared direct read steps; for Codegraph, the number of unique source paths returned in `packets` or `fileView`. This metric excludes Codegraph parser/indexer reads and operating-system I/O, so it is a context-delivery count rather than total disk activity.
- **Wall time:** elapsed time around the variant's declared steps. It includes Codegraph process startup and cold indexing, but excludes harness setup before the variant timer starts.
- **Completeness:** the fraction of expected path anchors present as text in captured step evidence. It checks evidence presence only, not reasoning, relevance, correctness, prose quality, or whether a final answer could be written.

Tool calls approximate workflow coordination or round trips, while returned source files approximate how many distinct files are delivered into agent context. They matter for agent workflows, but neither is a unit of time, tokens, bytes, or cognitive effort, and one `explore` call is not cost-equivalent to one direct read.

Medians are calculated independently for each scenario and variant after sorting that group's samples. An odd sample count uses the middle value; an even sample count uses the arithmetic mean of the two middle values.

## Checked evidence

[`results.example.json`](./results.example.json) is the checked result document behind this table. Its `scenarioDigest` is SHA-256 over deterministic JSON containing `schemaVersion` and the exact selected scenario objects in scenario-file order. The digest binds the checked rows to the exact selected definitions—including repositories, tasks, anchors, metrics, and ordered variant steps—rather than relying on the `scenarioFile` path alone; `scenarioIds` records the ordered selection and `runsPerVariant` records the expected sample count.

The validator requires a complete scenario × variant × run matrix: exactly one run for every selected scenario, each of the baseline and Codegraph variants, and every expected run number, with no extras or gaps. When a scenario file is supplied, it also checks each run's tool-call count against the declared step count and each baseline file-read count against the declared baseline read-step count; Codegraph file reads remain derived from returned evidence. The generated block is ordered by scenario-file order and then baseline before Codegraph, and every numeric cell is rendered by the summarizer rather than hand-edited.

<!-- benchmark-results:start -->

| Scenario                         | Variant   | Samples | Median tool calls | Median file reads | Median wall time (ms) | Complete runs | Minimum completeness |
| -------------------------------- | --------- | ------: | ----------------: | ----------------: | --------------------: | ------------: | -------------------: |
| repo-orientation-small-ts        | baseline  |       3 |                 3 |                 3 |                60.458 |             3 |                 100% |
| repo-orientation-small-ts        | codegraph |       3 |                 1 |                 3 |              3762.148 |             3 |                 100% |
| python-import-reference          | baseline  |       3 |                 3 |                 3 |                27.293 |             3 |                 100% |
| python-import-reference          | codegraph |       3 |                 1 |                 2 |              3620.385 |             3 |                 100% |
| sql-migration-application-review | baseline  |       3 |                 3 |                 3 |                39.783 |             3 |                 100% |
| sql-migration-application-review | codegraph |       3 |                 1 |                 3 |              3569.998 |             3 |                 100% |
| mixed-docs-source-graph          | baseline  |       3 |                 3 |                 3 |                39.589 |             3 |                 100% |
| mixed-docs-source-graph          | codegraph |       3 |                 1 |                 3 |              3437.486 |             3 |                 100% |

<!-- benchmark-results:end -->

Read row counts, sample counts, completeness, and comparative medians directly from the generated table. Interpret any observed differences only as evidence about these checked local fixtures; they do not establish that Codegraph is faster.

Read the checked runtime and hardware values from the result document's `environment` object. Its recorded Node version, platform, architecture, CPU model, logical CPU count, and total memory let readers interpret reruns in their runtime and hardware context without duplicating values in prose.

## Cold-run policy and variability

Codegraph uses `--cache off` and starts a fresh CLI process for every sample, so wall time includes a cold in-process index. The harness does not reboot the host or clear operating-system file caches between samples, and its fixed serial order can expose thermal, scheduler, filesystem-cache, antivirus, and background-load effects.

Wall times will vary with Node version, CPU, storage, memory pressure, platform, build freshness, and system load. The configured sample count remains a modest evidence set, so compare reruns in context rather than treating small differences as stable.

## Limitations and claim policy

- The fixtures are deliberately tiny, local, synthetic, and network-free; they do not represent large repositories, remote tools, warm indexes, long sessions, or concurrent agents.
- The checked paths and Codegraph queries are scenario-specific and name expected concepts. The benchmark does not measure discovery from an ambiguous prompt.
- Anchor presence can be complete even when evidence is misleading or an answer would be wrong. No quality, token-use, output-size, or human-effort score is collected.
- Baseline reads only the files declared in advance, while Codegraph performs parsing and indexing to produce structured evidence. The comparison describes these workflows, not equivalent internal work.
- Cold process startup dominates these small Codegraph runs, and cache-off results do not characterize repeated warm-cache use.
- Scenario repository trees, the scenario file, and output parent directories are trusted local maintainer inputs. Static traversal and symlink checks catch accidental misuse, but the harness is not an adversarial sandbox and does not provide TOCTOU-safe confinement; these paths must not be concurrently renamed or retargeted during a run.

A benchmark claim belongs here only when it is directly supported by a checked scenario and a checked result row generated from it. Do not publish broad speedup, quality, scale, or universal performance claims from this table, and do not add numeric prose that can drift independently of the generated evidence.

## Related documentation

- [How it works](../how-it-works.md) explains runtime performance and cache behavior.
- [Agent workflows](../agent-workflows.md) describes the agent-facing `explore` workflow measured here.
