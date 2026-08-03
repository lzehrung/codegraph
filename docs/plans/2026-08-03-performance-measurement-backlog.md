# Performance measurement backlog

Status: Planned. This file owns measurement and instrumentation work only. It does not authorize an optimization by itself.

## Goal

Collect reproducible evidence for the remaining speculative performance ideas before they become implementation plans. Use the existing benchmark corpus and command timing reports instead of one-off stopwatch claims.

## Measurements

### Duplicate preprocessing

- Add a checked-in benchmark scenario with enough repeated units to exercise native and reduced duplicate preprocessing.
- Record elapsed time, units, fingerprints, candidate pairs, omitted counts, and native mode.
- Use parity as a hard contract. Establish a stable baseline before choosing a regression threshold.

Decision unlocked: whether more duplicate candidate generation should move to Rust.

### Reference lookup

- Add a realistic multi-file reference scenario with imports, re-exports, ambiguous names, and negative candidates.
- Record candidate files, files parsed, references verified, cache path, and elapsed time for cold and warm runs.
- Separate candidate selection cost from semantic verification cost.

Decision unlocked: whether occurrence vectors or additional navigation caches have measurable value.

### Repeated search

- Measure repeated MCP symbol, hybrid, text, and path searches in one session and across one-shot processes.
- Record base-index, detailed-graph, content-cache, ranking, and total time separately.
- Compare JavaScript scoring with any native experiment only after the current cache paths are warm and visible.

Decision unlocked: whether token scoring or text prefilters justify native implementation.

### Discovery and cache-path observability

- Add report fields for snapshot hit, Git reconciliation, exhaustive discovery, module-cache hits, and detailed-graph cache hit.
- Measure project-file and metadata discovery separately on cold and exhaustive builds.
- Revisit Git hash enumeration, freshness stat narrowing, and non-Git discovery only when their measured phase dominates a representative scenario.

Decision unlocked: whether another discovery or manifest change is worth its correctness and migration cost.

## Output contract

- Put reusable scenarios and expected fields under `docs/benchmarks/` and the existing benchmark scripts.
- Record environment, revision, native mode, cache state, corpus size, and command arguments with every result.
- Prefer relative comparisons across the same environment. Do not turn workstation-specific timings into universal product promises.
- Any follow-up implementation plan must cite the scenario and measured bottleneck it addresses.

## Acceptance

- Each scenario is deterministic, bounded, and runnable from a source checkout.
- Results distinguish cold, warm, one-shot, and long-lived-session behavior.
- Measurement output is sufficient to accept or reject the corresponding optimization without reopening the original audit documents.
