# Documentation benchmarks

## What the checked results show

On these tiny local fixtures, with Codegraph caching disabled and a fresh process for each sample:

- Direct reads are far faster: their median wall times are tens of milliseconds, while the Codegraph runs take several seconds.
- Codegraph reduces each declared workflow from three calls to one `explore` call.
- Every expected evidence anchor is present in every checked run.

These findings describe only the declared workflows and checked fixtures below. Completeness means that expected path anchors appear in captured evidence. It does not measure answer quality, reasoning, relevance, correctness, or whether an agent could produce a good final answer. The benchmark also does not show that either workflow is generally faster, cheaper, or better at repository discovery.

## Reproduce locally

From the repository root, run:

```bash
npm run bench:docs
```

This command rebuilds stale `dist` output when needed, runs every scenario and both variants serially, requires complete anchor evidence, writes `.tmp/public-docs-benchmark-results.json`, and prints the median table. The fixtures are local and the run makes no network requests.

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
| repo-orientation-small-ts        | baseline  |       3 |                 3 |                 3 |                60.458 |             3 |                 100% |
| repo-orientation-small-ts        | codegraph |       3 |                 1 |                 3 |              3762.148 |             3 |                 100% |
| python-import-reference          | baseline  |       3 |                 3 |                 3 |                27.293 |             3 |                 100% |
| python-import-reference          | codegraph |       3 |                 1 |                 2 |              3620.385 |             3 |                 100% |
| sql-migration-application-review | baseline  |       3 |                 3 |                 3 |                39.783 |             3 |                 100% |
| sql-migration-application-review | codegraph |       3 |                 1 |                 3 |              3569.998 |             3 |                 100% |
| mixed-docs-source-graph          | baseline  |       3 |                 3 |                 3 |                39.589 |             3 |                 100% |
| mixed-docs-source-graph          | codegraph |       3 |                 1 |                 3 |              3437.486 |             3 |                 100% |

<!-- benchmark-results:end -->

The checked result document records Node, platform, architecture, CPU, logical CPU count, and memory so reruns can be compared in context.

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
