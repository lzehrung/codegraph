# Library review and remediation plan

Status: All eight original fixes, the approved #357 TypeScript/workspace cache extension, and the #359 security patch are merged. The extended #357 passed its full check and all five CI jobs. Its fresh review raised no new comments but requested closer cache review. Proposals remain unstarted.

## Original review scope and evidence

- Reviewed revision: `5efb24a762b269bd09e8df5ddc3fa47b3e9f93e7`, Codegraph `2.3.21`.
- Review areas: performance, correctness, language accuracy, usability, feature overlap, and missing capabilities.
- Runtime: Windows x64, Node `22.16.0`, npm `11.19.0`, native runtime available.
- Evidence: current source inspection and isolated runtime probes through the compiled library, CLI, and MCP handlers.
- Verification: `npm run check` passed, including native checks and fixture cleanliness. The coverage run reported 4,129 passed and 19 skipped tests.
- At review time, no source fixes were made. Probe fixtures were removed. Repository caches were left warm.

The original passing suite did not cover the failures below. Timings are local samples, not general performance claims. Recheck source locations and behavior if the implementation revision changes.

## Implementation status

This report remains local and is excluded from all commits. The table records the initial implementation checks: each original draft passed `npm run check`, including native checks and fixture cleanliness, with 19 tests skipped. Runtime checks used the compiled library, public package entrypoints, or CLI. Current feedback verification is recorded below.

| Finding | PR                                                     | Initial coverage tests passed | Runtime check                                                                        |
| ------- | ------------------------------------------------------ | ----------------------------: | ------------------------------------------------------------------------------------ |
| COR-01  | [#351](https://github.com/lzehrung/codegraph/pull/351) |                         4,130 | Nested call targets the local helper.                                                |
| COR-02  | [#356](https://github.com/lzehrung/codegraph/pull/356) |                         4,130 | Generic argument creates no inheritance edge.                                        |
| COR-03  | [#357](https://github.com/lzehrung/codegraph/pull/357) |                         4,131 | Changed hints agree across bindings and edges; old-runtime cache is repaired.        |
| COR-04  | [#353](https://github.com/lzehrung/codegraph/pull/353) |                         4,132 | Config-only change updates the C++ dependency target.                                |
| COR-05  | [#354](https://github.com/lzehrung/codegraph/pull/354) |                         4,134 | Path-only search sees a rename without semantic indexing.                            |
| COR-06  | [#358](https://github.com/lzehrung/codegraph/pull/358) |                         4,132 | Late exact phrase ranks first with either cache mode and through the CLI.            |
| API-01  | [#352](https://github.com/lzehrung/codegraph/pull/352) |                         4,130 | Both public agent entrypoints support shared-session discovery, packets, and search. |
| PERF-02 | [#355](https://github.com/lzehrung/codegraph/pull/355) |                         4,134 | Warm MCP symbol lookup reads neither SQL source file.                                |

A COR-06 warm-cache sample used 20 Markdown files with 40,000 matching lines and native parsing disabled. Search took 204 ms: candidate retrieval took 133 ms, final scoring took 7 ms, and no source files were read. Peak process RSS was 177 MiB; RSS grew by 38 MiB during the query. The response disclosed lower-bound candidate counts and passed 2,000 candidates to final scoring. This is one synthetic sample, not a performance baseline.

The #351/#356 and #353/#354 overlaps are resolved. Preserve both cache-epoch updates when combining #356 with #357. The checklists below remain criteria for PR review, not merge approval. PERF-01, package consolidation, breaking option removal, and capability proposals are not implemented.

### Review feedback update

The first feedback round updated all five drafts from `main` at `5b63237e`, resolved their original comment threads, and requested fresh Copilot reviews. No PR was merged by the assistant.

- #353 (`21eb74ef`): Configuration-read errors retain a stale snapshot instead of repeatedly rebuilding it; successful recovery refreshes once. The new regression failed before the fix. Full checks passed before the main update; the updated build, 82 focused tests, and compiled recovery probe passed afterward.
- #354 (`d323ac4a`): Missing baselines return before discovery or file stats; the later guard still covers invalidation during I/O. Source-file stat calls fell from 1 to 0 in the compiled invalidation probe. The updated build and 83 focused tests passed.
- #356 (`316136b7`): Restored the Source and Date added cells and corrected fixture coverage claims. Integration preserves both lexical binding and generic-base narrowing. Post-integration `npm run check` passed: 4,137 tests passed, 19 skipped, including native checks; both compiled semantic probes passed.
- #357 (`a2b12436`): Named `--resolution-hint` and `graph.resolutionHints` explicitly. Documentation checks, the updated build, and 138 focused tests passed; one test was skipped.
- #358 (`ef7116ad`): Used the full `candidateCounts.indexedTextChunksLowerBound` field name. Documentation checks, the updated build, and 77 focused tests passed.

The suppressed #351 comment describes an optional scope-scan simplification, not a correctness defect. A real 104-scope fixture required one predicate check in `find()` and 104 visits in the full loop; nested binding was correct. No further change to #351 was made, and no speed gain is claimed.

### Second feedback round

- #353 (`6cc3bb0a`): Configuration failures use a generic stale reason without raw filesystem paths. The privacy regression failed before the fix. Build, 48 session tests, documentation links, and a compiled privacy/recovery probe passed.
- #354 (`5cf4ed41`): Discovery baselines retain paths that disappear before signature capture, without inventing stat values. The new deletion-race regression failed before the fix. The compiled probe passed; `npm run check` passed with 4,142 coverage tests, 19 skipped, native checks, and fixture cleanliness.
- #357 (`7c8e16d2`, then `444ea306`): Retained the epoch 3 call-edge rationale. Further review found that the reorder test allowed an old edge alongside the new one; it now checks the exact outgoing target list. After rebuilding stale compiled output, 135 cache-invalidation tests passed and one was skipped.
- #358 (`8640a0f8`): Removed the duplicate substring predicate and repeated FTS eligibility check. Build and 76 query-index/search tests passed. A compiled SQLite probe preserved late exact phrases for short, non-ASCII, and FTS terms.
- #356: Copilot approved the unchanged head. CI failed because the runner could not resolve `index.crates.io`; the failed job was rerun and passed.

All reported threads were resolved, and fresh Copilot reviews were requested on the four changed drafts. The report remains local and uncommitted.

### Main integration at 9d3fa9c6

- #353 (`00720e35`, `93b4d742`): Fixed the suppressed `useConfig: false` comment. The configuration hash excludes unused Codegraph settings while retaining language config and ignore inputs. The regression failed before the fix. Source and test conflicts with #354 were resolved, preserving both freshness paths and deletion-race handling.
- #353 verification: `npm run check` passed with 4,147 coverage tests, 19 skipped, native checks, and fixture cleanliness. Compiled probes confirmed snapshot reuse for unused settings, configuration-error recovery, and discovery deletion handling.
- #356 (`4aaf4592`): Build and 56 hierarchy, call, and session tests passed.
- #357 (`2187f04c`): Build and 185 cache, resolution, and session tests passed; one skipped.
- #358 (`dd7225c7`): Build and 126 query-index, search, and session tests passed.

All four changelog conflicts retain both entries. Published branch hashes were verified against origin, and GitHub reports all four PRs as mergeable. Fresh Copilot review requests were confirmed by GitHub events; CI and review results remain pending. No PR was merged by the assistant.

### Feedback after #353 merged

- #356 (`84be0471`): Corrected C++/Ruby qualifier examples to use `::`. Scoped base types now prefer the parser's `name` field and retain the annotation-aware child fallback. Both review threads were answered and resolved.
- #356 verification: `npm run check` passed with 4,148 coverage tests, 19 skipped, native checks, and fixture cleanliness. A compiled probe confirmed exact inheritance targets for annotated qualified Java generic bases, C++ qualified generic bases, and Ruby qualified bases. Documentation link checks passed.
- #357 (`1e9130e0`): Integrated `main` at `2d9abf68`, retaining both changelog entries. Build and 190 cache, resolution, and session tests passed; one skipped.
- #358 (`253ecbf0`): Integrated the same `main`, retaining both changelog entries. Build and 131 query-index, search, and session tests passed.

All three published heads match origin and are mergeable. Fresh Copilot review requests are recorded in GitHub events. CI has no reported failures but remains in progress. The report remains uncommitted; no PR was merged by the assistant.

### CI repair and additional cache finding

- #357's first failed CI job aborted in Node 22.16.0's `v8::Module::IsGraphAsync`, not a test assertion. The failed-job retry stopped earlier at three new Hono production advisories.
- [#359](https://github.com/lzehrung/codegraph/pull/359) (`2d9d56fb`) updates only the locked Hono package from 4.12.34 to 4.13.7 and adds a security note. The production audit reports no vulnerabilities; the install dry run and full check passed (4,148 coverage tests, 19 skipped).
- #357 (`de43d1ef`) retains both cache invalidation reasons after integration. Its full check passed with 4,150 coverage tests and 19 skipped.
- #358 (`541917d5`) retains both conflicting changelog entries and includes the security patch. Its full check passed with 4,151 coverage tests and 19 skipped.
- All five CI jobs passed on each of #357, #358, and #359. The Node abort did not recur on the updated #357 run. No test suppression or audit exception was added. Fresh reviews recommend approval for #358 and #359.
- The new [#357 review finding](https://github.com/lzehrung/codegraph/pull/357#discussion_r3963724352) was valid but predated its resolution-hint fix. Compiled probes reproduced it both on #357 and on the #359 baseline without #357: changing `tsconfig.json` paths from `one.ts` to `two.ts` updated graph edges but left cached imports at `one.ts`; changing a workspace package's exports left both imports and graph edges at `one.ts`. Cache-off builds selected `two.ts` in both cases. The approved extension below fixes it.
- Changelog recommendation: one release-note file per PR, collected by the existing `release:prepare-changelog` command. This is a recommendation, not an implemented workflow change.

### Approved #357 cache extension

- Commit `2b20a231` includes effective TypeScript `baseUrl`/`paths` (including `extends`) and workspace package names, paths, `main`, and `exports` in both module and graph cache identity, even with `resolveNodeModules` disabled.
- Epoch 5 invalidates older cached targets, including cases where configuration was removed. The earlier call-edge and inheritance invalidation reasons remain documented.
- Six new memory/disk/incremental regression cases failed before the fix. `npm run check` passed with 4,156 coverage tests, 19 skipped, native checks, and fixture cleanliness. Documentation links passed.
- Compiled probes matched cache-off results after configuration changes, removal, and restoration for TypeScript, a mapped extension, MDX, and Astro. Upgrade probes used old-runtime cache contents with native origin paths normalized to model an in-place upgrade.
- A 100-directory warm probe read the shared TypeScript config once instead of 100 times, with no files parsed. This is a read-count result, not a timing comparison.
- [CI run 34300920045](https://github.com/lzehrung/codegraph/actions/runs/34300920045) passed all five jobs. Fresh Copilot review generated no new comments but requested closer review because cache identity changes span several layers; it did not recommend approval.
- GitHub reports #357 merged as `1f0e3c46` and #358 merged as `f82dc9c4`; the user confirmed that all remaining PRs, including #359, are now merged. No PR was merged by the assistant.

The report remains uncommitted. No PR was merged by the assistant.

## Recommended order

| Order | Work                                       | Reason                                                               |
| ----- | ------------------------------------------ | -------------------------------------------------------------------- |
| 1     | COR-01 and COR-02: semantic relationships  | Incorrect links undermine graph-based analysis.                      |
| 2     | COR-03 through COR-05: cache and freshness | Results must not depend on old configuration or query order.         |
| 3     | COR-06 and PERF-01: search recall and cost | Improve candidate retrieval without losing relevant results.         |
| 4     | API-01, PERF-02, and PKG-01                | Complete session access and remove unnecessary work and code copies. |
| 5     | Surface cleanup and capability proposals   | Add features only after the underlying evidence is reliable.         |

Keep module-cache identity and session freshness fixes separate: they occur at different reuse boundaries, and neither fix alone addresses the other. COR-01 and COR-02 share detailed-graph code; coordinate their edits and cache invalidation.

## Confirmed correctness findings

### COR-01: Direct calls ignore lexical scope

Priority: P1. Status: Reproduced.

Evidence: [detailed graph resolver](../../src/graphs/symbol-graph-detailed.ts), `resolveIdentifier` near line 216; [edge passes](../../src/graphs/symbol-graph-detailed/edge-passes.ts), `tryResolveNode` near line 108.

Reproduction:

```typescript
export function helper() {
  return 1;
}
export function outer() {
  function helper() {
    return 2;
  }
  return helper();
}
```

Build with `buildProjectIndex(root, { cache: "off", native: "on", keepParsed: true })`, then call `buildSymbolGraphDetailed(index)`.

- Expected: the call inside `outer` targets the nested `helper`.
- Observed: it targets the top-level `helper`.
- Cause: the resolver checks import aliases, then the first module local with the same name. It does not resolve the binding at the use site.
- Impact: false callers/callees relationships and unreliable graph-based impact results.

Remediation:

- Resolve identifiers through the existing scope and import machinery at the source location.
- Respect local shadowing before consulting module bindings or imports.
- Apply the shared resolution rule to affected call, instantiation, and hierarchy consumers; do not patch only this fixture.

Acceptance:

- [ ] The fixture targets the nested declaration, with the correct callsite.
- [ ] A local declaration that shadows an imported alias does not create a call to that import.
- [ ] Ambiguous or unproven bindings do not become guessed edges.
- [ ] Existing cross-language call and navigation behavior remains valid.

Start with `tests/call-hierarchy-language-parity.test.ts` and the nearest detailed-graph tests. Update shared semantic parity coverage where the behavior changes.

### COR-02: Generic arguments become inheritance edges

Priority: P1. Status: Reproduced in C#.

Evidence: [edge passes](../../src/graphs/symbol-graph-detailed/edge-passes.ts), `recordIdentifierRelations` near line 438 and the C# base-list branch.

```csharp
class Payload {}
class Base<T> {}
class Derived : Base<Payload> {}
```

- Expected: `Derived` extends `Base`.
- Observed: the graph also says `Derived` implements `Payload`.
- Cause: recursive identifier collection treats generic arguments as separate bases.
- Impact: false hierarchy and implementation relationships. Other language branches share the collector, but equivalent failures were not runtime-tested in this review.

Remediation: extract direct base-specifier types according to the grammar. Resolve the outer type without treating its arguments or qualifiers as additional base types.

Acceptance:

- [ ] The fixture contains no inheritance or implementation edge from `Derived` to `Payload`.
- [ ] Real interfaces and multiple direct bases remain represented correctly.
- [ ] Audit the other users of the shared collector and add language fixtures for changed behavior.

Start with `tests/type-hierarchy-language-parity.test.ts` and `tests/type-hierarchy.test.ts`.

### COR-03: Module cache identity omits resolution hints

Priority: P1. Status: Reproduced.

Evidence: [index builder](../../src/indexer/build-index.ts), `moduleCacheSignatureForFile` near line 449. Import bindings and graph edges have separate reuse paths.

Reproduction:

1. Create `main.ts` importing `value` from bare specifier `foo`.
2. Create `one/foo.ts` and `two/foo.ts`, both exporting `value`.
3. Call `buildProjectIndex` with disk cache and `graph.resolutionHints: ["one"]`.
4. Repeat without source changes using `graph.resolutionHints: ["two"]`.
5. Compare the import binding and the file graph edge. Repeat with cache off as a control.

Observed:

| Run                   | Import binding   | File graph edge |
| --------------------- | ---------------- | --------------- |
| Disk, hint `one`      | `one/foo.ts`     | `one/foo.ts`    |
| Disk, hint `two`      | **`one/foo.ts`** | `two/foo.ts`    |
| Cache off, hint `two` | `two/foo.ts`     | `two/foo.ts`    |

Remediation: include normalized, ordered resolution hints in module cache identity. Audit other inputs that affect cached import bindings. A full graph rebuild is insufficient if it still accepts incompatible cached modules.

Acceptance:

- [ ] Both imports and graph edges target `two/foo.ts` after the hint change.
- [ ] Definition and reference queries agree with a cache-off build.
- [ ] Reordering hints invalidates affected state; an unchanged hint list still reuses compatible state.
- [ ] Existing persisted state cannot retain the old derived resolution under the new contract.

Start with `tests/cache-invalidation.test.ts` and `tests/dynamic-resolution.test.ts`.

### COR-04: Configuration-only changes remain fresh in agent sessions

Priority: P1. Status: Reproduced.

Evidence: [agent session](../../src/agent/session.ts), `checkFreshness` near line 542 and `diffAgentFileSignatures` near line 320.

Reproduction:

1. Create `main.cpp` including `Thing.h`, plus `A/Thing.h` and `B/Thing.h`.
2. Set `codegraph.config.json` resolution hints to `A`.
3. Create an agent session with `freshness.policy: "auto"` and cache off; load the project.
4. Change only the resolution hint to `B`, then check freshness and reload.
5. Build a new session as a control.

- Observed: the existing session reports `fresh` and retains the edge to `A/Thing.h`.
- Control: a new session points to `B/Thing.h`.
- Cause: file-signature comparison does not cover all configuration inputs. In this fixture, the config file is not in the tracked session file list.

Remediation: track configuration/discovery identity with the session snapshot. Reuse existing indexer configuration rules rather than adding a separate ignore or resolution policy.

Acceptance:

- [ ] `check` reports stale configuration without silently replacing the snapshot.
- [ ] `auto` refreshes when permitted and returns the new dependency target.
- [ ] `manual` retains its explicit caller-controlled behavior.
- [ ] Configuration drift is detected even when discovered source paths and bytes are unchanged.

Start with `tests/agent-session.test.ts`.

### COR-05: Path-only search retains renamed files

Priority: P2. Status: Reproduced.

Evidence: [path search fast path](../../src/agent/search.ts), `searchCodegraphWithSession` near line 261; [agent session](../../src/agent/session.ts), `loadFiles` and the early return in `checkFreshness`.

Reproduction: create `before.ts`; run path-mode search through an auto-refresh session; rename it to `after.ts`; wait beyond the five-second freshness interval; search again.

Observed: the old path remains in search results and the response says `fresh`. A live `discoverFiles()` call returns `after.ts`, but the cached path-search list does not.

Remediation: validate the cached discovery plan even when no full project index has loaded. Preserve the cheap path-only route; do not force semantic indexing merely to check file names.

Acceptance:

- [ ] Auto-refresh path search finds the new name and stops returning the deleted name.
- [ ] Additions, deletions, and renames work before the first full-index query.
- [ ] Path-only search remains independent of semantic graph construction.

Start with `tests/agent-search.test.ts` and `tests/agent-session.test.ts`.

### COR-06: Candidate caps discard the best search result

Priority: P2. Status: Reproduced.

Evidence: [query store](../../src/agent/query-index/store.ts), `candidateChunksForTerms` near line 379; [candidate ranking](../../src/agent/query-index/candidates.ts), `findQueryIndexChunkCandidates` near line 90; [result totals](../../src/agent/search.ts), `selectTopResults`.

Reproduction: write a Markdown file containing 4,001 lines of `quasar filler`, then 4,001 lines of `beacon filler`, then `quasar beacon`. Search for `quasar beacon` with `mode: "text"` and `limit: 3` using disk cache and cache off.

| Mode      | Best result                                  | Reported candidates | Reported omitted results |
| --------- | -------------------------------------------- | ------------------: | -----------------------: |
| Cache off | Exact phrase at line 8,003                   |               8,003 |                    8,000 |
| Disk      | Partial match at line 1; exact phrase absent |               2,000 |                    1,997 |

SQL applies path-ordered per-term limits before relevance ranking. A later cap retains only 2,000 candidates. The response does not separately disclose matches lost during retrieval.

Remediation:

- Preserve high-quality matches before applying output caps; do not rely only on a larger fixed cap.
- Expose candidate-stage truncation or lower-bound totals separately from final result omissions.
- Keep deterministic ranking and bounded resource use.

Acceptance:

- [ ] The late exact phrase ranks first with either cache mode.
- [ ] Equivalent content near the end of path order is not excluded solely by its path.
- [ ] Remaining retrieval limits are visible to consumers and are not presented as complete match counts.
- [ ] Large common-term queries stay bounded and have measured latency and memory use.

Start with `tests/query-index.test.ts` and `tests/agent-search.test.ts`.

## API and performance work

### API-01: Export existing session-aware orientation and packet APIs

Priority: P2. Status: Reproduced public API gap.

Both `orientCodegraphWithSession` and `getCodegraphPacketWithSession` exist internally but are absent from the product and core public agent entrypoints. Runtime imports returned `undefined` for both names. The [library guide](../library-api.md) recommends warm sessions for these operations.

Remediation: export the existing functions through [the agent entrypoint](../../src/agent.ts) and document shared-session use. Do not create another session abstraction.

Acceptance:

- [ ] Both functions are available from both documented agent packages, with usable TypeScript declarations.
- [ ] A consumer can perform orientation, packet retrieval, and search through one supplied session.
- [ ] Examples use public package paths and explain lifecycle ownership.

Start with `tests/package-exports.test.ts` and existing agent workflow tests.

### PERF-01: Improve candidate retrieval before text scoring

Status: Measured opportunity; no optimization implemented.

Observed on this repository, with 848 files in scope and warm disk state:

| Operation                                     |         Local samples |
| --------------------------------------------- | --------------------: |
| CLI `orient --budget small --json --report`   | 1.22-1.24 s wall time |
| CLI hybrid search, fresh process              | 2.35-2.46 s wall time |
| Different queries in one warm library session |           0.83-1.23 s |
| Immediate repeat of the same session query    |        Less than 1 ms |

The warm CLI queries were `buildProjectIndexIncremental` and `normalizePath`. Candidate retrieval took about 0.4-0.6 seconds, final text scoring about 10 milliseconds, and index checking about 0.76-0.77 seconds. The first measured search after the source update took 14.07 seconds and updated 430 query-index files; it was not a warm-query sample or a clean-project benchmark.

Remediation: inspect candidate SQL, repeated normalization, and text hydration. Resolve COR-06 with this work so faster retrieval does not reduce recall. Avoid parser tuning without evidence that parsing dominates the target workload.

Acceptance: compare identical queries, revision, runtime, and cache states; preserve relevant results; report candidate, scoring, index-validation, and total time separately. Use the existing [query benchmark workflow](../benchmarks/README.md) and [measurement backlog](2026-08-03-performance-measurement-backlog.md), not a second benchmark framework.

### PERF-02: Resolve MCP symbols without building discarded explanations

Priority: P2. Status: Source and runtime evidence confirmed unnecessary work.

The [MCP `get_symbol` handler](../../src/mcp/handlers.ts), near line 829, calls `explainCodegraphTargetWithSession` and returns only `explanation.target`. The explanation builder collects additional context that the response discards.

A warm handler probe resolving SQL table `users` read both `tables.sql` and `views.sql`, then returned only the target identity, range, and freshness. This proves extra reads, not a general latency estimate.

Remediation: use a shared lightweight target resolver. Keep SQL, file, chunk, and portable symbol handle behavior intact; reserve full explanation work for packet/explanation requests.

Acceptance: equivalent target resolution and freshness/error behavior, without unrelated explanation analysis. Verify through the real handler and measure a representative repository before claiming a speedup.

## Redundancy and usability decisions

### PKG-01: One core implementation, two package roles

Priority: P2. Status: Duplication verified; consolidation is a proposal.

The product depends on `codegraph-core` but also contains its own implementation. [Core staging](../../scripts/stage-core-package-lib.mjs) copies compiled implementation files into the core package. Runtime imports from both packages produced distinct `buildProjectIndex` and `createAgentSession` functions, rather than one forwarded implementation.

Recommendation: keep the slim core package and the product package, but make the product library exports forward to one core implementation. Audit internal imports so mixed-package consumers do not load separate engine state. Package-size and memory savings were not measured.

Acceptance: public imports remain supported; the slim package does not gain CLI/MCP/viewer dependencies; mixed-package session ownership works; published package tests prove the intended dependency boundary.

### Remove a no-op option, not useful workflows

`includeHeuristic` is accepted by [call hierarchy APIs](../../src/agent/call-hierarchy.ts) but unused. The limitation is documented, so this is not an undisclosed accuracy defect. Remove the option at a suitable breaking release unless a real, clearly marked heuristic mode is implemented. Do not add guessed edges merely to give the option behavior.

Keep these roles distinct:

| Surface                          | Reason to keep it                                                     |
| -------------------------------- | --------------------------------------------------------------------- |
| `search` / `explore`             | Find targets / add bounded supporting evidence.                       |
| `explain` / `packet`             | Explain a known target / package evidence with a consistent envelope. |
| `review` / `impact` / `affected` | Compact review / broader effects / test selection.                    |
| `drift` / `graph-delta`          | Architecture comparison / narrow edge comparison.                     |
| `index` / `init` / `sync`        | Query state / lifecycle initialization / lifecycle update.            |

Improve the selection rules and naming crosswalk rather than merging these operations. No runtime evidence from this review justifies deleting them.

## Missing capabilities worth prioritizing

These are proposals, not confirmed defects or approved implementation scope.

1. **Compiler/LSP-backed accuracy benchmarks.** Measure false links and missed links on reviewed cross-language cases. Extend the existing benchmark system. Passing fixtures alone do not establish precision or recall.
2. **Go receiver-method ownership.** Connect methods declared outside a type to their proven receiver type, then support the dependent call and hierarchy queries.
3. **Node `#imports` and custom export conditions.** Add explicit resolution inputs and cache identity for them before expanding to more languages.
4. **Consistent completeness information.** Extend existing analysis, freshness, omission, and coverage fields so consumers can distinguish unsupported analysis, truncated retrieval, stale state, and a genuine empty result. Avoid adding a parallel diagnostics envelope.

The Go and Node gaps are explicitly documented in [language parity](../language-parity.md). They should remain separate from the reproduced regressions above.

## Completion rules

- Keep each fix tied to its observed consumer failure. Do not add unrelated optimizations or broad new abstractions.
- Add regression cases that fail on the reviewed revision and pass after the fix. Do not pin source text, incidental wording, or internal call counts.
- Build `dist` before native-worker or compiled-CLI checks. Use focused tests during implementation, then run `npm run check` on the integrated change.
- Invalidate or migrate persistent derived state when semantic relationships or cache identity change. Verify an existing cache, not only an empty cache.
- Update the relevant canonical docs and add an `[Unreleased]` entry for user-visible fixes. Language changes also require parity and scenario-catalog updates; CLI changes require CLI and bundled skill updates.
- Record the fixing commit or PR and verification evidence against each finding before marking it complete.
- Do not combine release/version changes with this remediation unless separately requested.
