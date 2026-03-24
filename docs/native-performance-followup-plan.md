# Native Performance Follow-up Plan

This document is the follow-up implementation plan for improving native Tree-sitter performance without changing the current architecture:

- one shared Tree-sitter model across languages
- Rust/native used as an implementation detail
- JS fallback preserved
- no alternate parser backend
- `Piscina` explicitly out of scope for this plan

The work below is ordered by expected ROI based on current code inspection plus representative fixture benchmarks.

Current benchmark signal on the representative fixtures:

- graph workloads are consistently faster in JS today
- full indexing is still often faster in JS on small and medium fixtures
- native is paying for work it does not fully replace yet

That means the next work should focus on removing wasted native work and duplicate JS work before considering parallelism.

---

## Goals

1. Reduce native work that does not contribute to the current command.
2. Remove duplicate parse and query work across Rust and JS.
3. Improve Rust-side reuse so native execution is not rebuilding parser/query state per file.
4. Reduce native-to-JS payload overhead.
5. Keep behavior identical and benchmark every step.

---

## Non-goals

- Do not introduce a second parser ecosystem.
- Do not add `Piscina` in this plan.
- Do not weaken fallback behavior or diagnostics to chase benchmark numbers.
- Do not optimize by dropping existing language coverage or report accuracy.

---

## Current Findings

These are the main performance issues this plan addresses.

1. Graph mode runs all four native query kinds per file even though it only needs imports.
   - `src/graphs.ts` calls `getNativeQueryExecution(...)`
   - `src/native/treeSitterNative.ts` always runs:
     - `imports`
     - `exports`
     - `locals`
     - `importBindings`

2. Full indexing still reparses native-backed files in JS.
   - `prepareFileForIndexing(...)` gets native query results first
   - later, `collectLocalsAndExportsFromSource(...)` reparses when it was not given a JS tree
   - native parse/query therefore does not replace enough of the total path yet

3. Successful empty native results still fall through to JS parsing/querying.
   - import/specifier extraction and import-binding extraction still do JS work after native returns no matches

4. Rust rebuilds parser and query state per file.
   - parsers are not pooled in Rust
   - queries are compiled from text on every call
   - JS currently has parser pooling and compiled-query caching

5. The native capture payload is larger than many callers need.
   - graph mode mostly needs specifiers
   - import binding extraction mostly needs binding names and source module
   - current native payload includes extra strings and point objects for every capture

---

## Workstream Order

Implement in this order:

1. Workstream A: Graph-mode query narrowing
2. Workstream B: Authoritative empty-native results
3. Workstream C: Remove duplicate JS parsing in full indexing
4. Workstream D: Rust parser and query caching
5. Workstream E: Payload minimization
6. Workstream F: Benchmark expansion and cleanup

Do not reorder these. The first three items remove the largest obvious waste with the lowest design risk.

---

## Workstream A: Graph-Mode Query Narrowing

### Goal

Stop paying for native query kinds that graph mode does not use.

### Problem

`collectGraph()` only needs import/specifier information, but the native runtime currently executes all query kinds for every graph file.

### Desired end state

- graph mode requests only native imports data
- full indexing still requests the full query bundle it needs
- report accounting stays correct

### Implementation steps

1. Introduce workload-aware native execution entrypoints.
   Add an explicit notion of native query scope, for example:
   - `imports`
   - `index`

   The exact API can vary, but the graph path must not request locals/exports/importBindings.

2. Split `getNativeQueryExecution(...)`.
   Options:
   - add a parameter that specifies which query kinds to execute
   - or add dedicated helpers such as:
     - `getNativeImportsExecution(...)`
     - `getNativeFullExecution(...)`

   Prefer the shape that keeps callers simple and type-safe.

3. Update graph path call sites.
   In `src/graphs.ts`, ensure `collectEdgesForFile(...)` only asks for the imports query kind.

4. Update Rust entrypoint if needed.
   If the current native binding only exposes the "all queries" call, add a narrower native entrypoint or a query-kind mask so Rust can skip unneeded query compilation and execution entirely.

5. Preserve backend reporting semantics.
   Graph reports should still report native usage accurately even if only imports were executed.
   Do not mislabel a narrowed graph-native path as "partial fallback".

### Tests

- add graph-focused native runtime tests proving only imports are requested
- extend CLI/report coverage for `graph --report`
- ensure graph output is unchanged

### Acceptance criteria

- graph mode no longer executes native locals/exports/importBindings
- graph behavior is unchanged
- graph benchmarks improve measurably on representative fixtures

---

## Workstream B: Authoritative Empty-Native Results

### Goal

Avoid paying both native and JS cost for files where native successfully found nothing.

### Problem

Today, several paths only trust native if it produced matches. A successful empty native result still falls through to JS parse/query logic.

### Desired end state

- if native ran successfully and returned zero matches for the requested query kind, that result is treated as authoritative
- JS fallback only happens when native was unavailable, unsupported, or failed

### Implementation steps

1. Audit all native-query consumers.
   At minimum:
   - `collectModuleSpecifiersFromSource(...)`
   - `collectImportsForFile(...)`

2. Separate "native unavailable/failed" from "native succeeded with no matches".
   The current callers often only branch on whether results are present or whether output length is non-zero.
   They need to branch on execution status instead.

3. Introduce explicit execution-status handling in callers.
   Example:
   - if native execution failed -> JS fallback
   - if native execution succeeded and results are empty -> return empty

4. Keep behavior correct for the regex fast path.
   Do not break:
   - JS/TS `--fast-graph`
   - HTML/CSS-family attribute/url helper extraction that is intentionally additive

5. Keep fallback reporting correct.
   A successful empty native result must not increment fallback counters.

### Tests

- add targeted tests for files with zero imports and zero import bindings
- verify JS fallback is not invoked in those cases
- verify report counters show native used, not fallback

### Acceptance criteria

- empty successful native results do not trigger JS fallback
- fallback counters remain accurate
- graph and index outputs remain unchanged

---

## Workstream C: Remove Duplicate JS Parsing in Full Indexing

### Goal

Stop reparsing files in JS when native has already done the parse/query work and the remaining JS step does not truly need a full tree.

### Problem

The current full-index path still reparses native-backed files in JS for locals/exports shaping and related logic.

### Desired end state

- the full-index path only creates a JS tree when a downstream feature genuinely needs it
- native-backed extraction avoids unconditional second parsing

### Implementation steps

1. Audit what `collectLocalsAndExportsFromSource(...)` actually needs the JS tree for.
   Break usage into categories:
   - required for classification
   - required for docstring extraction
   - required only for fallback traversal

2. Split the function by responsibility if needed.
   Recommended decomposition:
   - native capture shaping
   - optional tree-assisted enrichment
   - full fallback tree traversal

3. Only parse when enrichment truly needs the tree.
   For example:
   - if native captures plus lightweight source heuristics are enough for a language/query shape, do not create a JS tree
   - if a specific language still needs a tree for classification or docstrings, parse only for that case

4. Audit import-binding extraction too.
   `collectImportsForFile(...)` should not parse when native import bindings already gave enough information.

5. Preserve correctness conservatively.
   If a language's local/export shaping becomes uncertain without a tree, keep the tree for that language until a tested lighter path exists.

### Tests

- extend parser-efficiency regression tests
- add tests that verify tree creation is skipped for safe native-backed cases
- rerun native semantic parity

### Acceptance criteria

- native-backed full indexing does less JS parsing
- semantic outputs remain unchanged
- full-index benchmarks improve on representative fixtures

---

## Workstream D: Rust Parser and Query Caching

### Goal

Bring Rust-side reuse closer to the JS runtime so native does not repeatedly rebuild expensive parser/query state.

### Problem

The Rust addon currently constructs a new parser per file and recompiles query text on every call.

### Desired end state

- parser reuse per language in Rust
- compiled query reuse keyed by language and normalized query text
- no behavior change

### Implementation steps

1. Add parser pooling or per-thread parser reuse in Rust.
   Keep the design simple and single-thread-safe for the current non-`Piscina` world.
   Avoid introducing global mutable state that is hard to test.

2. Add compiled query caching.
   Cache by:
   - language id
   - normalized query text
   - query kind if useful

3. Ensure cache keys reflect normalized queries.
   Since JS normalizes query text before calling Rust, the Rust cache should see the final normalized text as the key.

4. Keep unsupported blank queries cheap.
   Empty queries should still short-circuit without cache churn.

5. Add Rust unit tests for cache correctness if practical.
   At minimum:
   - repeat the same language/query call and verify same outputs
   - ensure different query texts do not cross-contaminate

### Tests

- Rust unit tests for cache behavior where possible
- existing native runtime tests
- focused benchmark comparison before/after

### Acceptance criteria

- native runtime no longer constructs parser/query state from scratch per file
- results remain identical
- benchmark improvements are measurable, especially on medium and mixed fixtures

---

## Workstream E: Payload Minimization

### Goal

Reduce native-to-JS marshaling overhead by returning only the data the caller actually needs.

### Problem

The current native payload is rich and generic, but graph mode and some binding paths do not need full capture text plus node metadata plus full ranges for every capture.

### Desired end state

- graph mode gets a compact import-focused payload
- full indexing gets only the capture fields it needs
- no extra strings or objects are marshaled without purpose

### Implementation steps

1. Identify minimum payload per workload.
   For graph/import specifiers:
   - module specifier text
   - type-only flag if relevant

   For import bindings:
   - imported/local names
   - source module
   - namespace/default/star shape

   For locals/exports:
   - only keep range and text fields that downstream logic genuinely consumes

2. Consider separate Rust result structs by workload.
   Avoid one "kitchen sink" object if callers need very different data shapes.

3. Keep the TypeScript adapter layer small and explicit.
   If Rust returns compact workload-specific results, convert them once at the boundary rather than inflating them into generic capture objects first.

4. Preserve diagnostics where needed.
   Do not strip fields required for:
   - fallback error reporting
   - normalized/skipped query reporting
   - semantic parity tests

### Tests

- native tree-sitter tests
- native semantic parity tests
- report tests if payload changes touch backend accounting

### Acceptance criteria

- native boundary allocations are smaller
- graph mode especially benefits
- no semantic regression

---

## Workstream F: Benchmark Expansion and Cleanup

### Goal

Make the benchmark harness better at validating the work above and less noisy on Windows.

### Problem

The current harness is useful, but repo-scale Windows runs can hit temp-file contention and mixed worktree noise.

### Desired end state

- stable representative benchmarks
- repeatable before/after comparisons for each workstream
- clearer output for graph-vs-full and native-vs-JS decisions

### Implementation steps

1. Keep the representative fixture set as the primary regression baseline.
   Use:
   - `typescript`
   - `python`
   - `go`
   - `rust`
   - `mixed`

2. Make repo-scale benchmarking optional and more robust.
   Avoid temp-cache collisions and Windows sqlite cleanup issues.

3. Record benchmark baselines before and after each workstream.
   Update the plan or a benchmark note with:
   - elapsed time
   - files/sec
   - files used/fallback

4. Keep CI benchmark assertions coarse.
   Do not overfit CI to exact timings.

### Acceptance criteria

- each workstream above has measurable benchmark evidence
- representative fixture benchmarking stays easy to run locally
- repo-scale runs are less fragile when used manually

---

## Recommended Execution Order

1. Workstream A
2. Workstream B
3. Workstream C
4. Workstream D
5. Workstream E
6. Workstream F

This order is important:

- A and B remove obviously wasted native work
- C removes duplicated parse cost
- D improves native engine reuse once the workload is trimmed
- E reduces boundary overhead after the right workload shape is established
- F then verifies and hardens the benchmark story

---

## Validation Checklist

Run after each workstream:

- `npm run build`
- focused tests for touched areas
- `npm run test:all`
- `node ./scripts/bench-native.mjs --runs 1 --fixtures typescript,python,go,rust,mixed --workloads full,graph --temperatures cold`

Additional validation by workstream:

- A:
  - graph CLI/report tests
  - native graph-mode benchmark improvement
- B:
  - explicit empty-result tests
  - fallback counter validation
- C:
  - parser-efficiency regression tests
  - native semantic parity
- D:
  - Rust unit tests
  - repeated benchmark comparisons
- E:
  - native runtime and parity tests
  - benchmark comparisons
- F:
  - benchmark harness smoke checks

---

## Definition of Done

This plan is complete when all of the following are true:

- graph mode no longer runs unnecessary native query kinds
- successful empty native results do not trigger JS fallback work
- native-backed full indexing no longer reparses files in JS unless required
- Rust reuses parser and compiled query state
- native payloads are smaller and workload-specific where useful
- representative fixture benchmarks show clear improvement from the current baseline
- behavior and reporting remain correct across the full test suite
