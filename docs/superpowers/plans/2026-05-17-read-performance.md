# Common Read Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make common Codegraph reads faster while preserving exact graph, navigation, search, SQLite, and CLI output behavior.

**Architecture:** Keep the existing `ProjectIndex` as the primary in-process read model, but add reusable derived adjacency indexes so graph traversal is O(nodes + edges) instead of repeatedly scanning `graph.edges`. Reuse the manifest-backed index path for CLI graph queries where possible, and improve high-level SQLite canned traversals with indexed SQL rather than full edge loads. Do not change persistent SQLite schemas in this plan.

**Tech Stack:** TypeScript, Node 24 `node:sqlite`, Vitest, existing Codegraph graph/indexer/session abstractions.

---

## Safety Rules

- [x] Do not change persistent SQLite schema in this branch.
- [x] Do not change public output shapes for `deps`, `rdeps`, `path`, `cycles`, `unresolved`, `search`, `explain`, or raw SQLite queries.
- [x] Preserve accuracy before speed: every optimization must compare against the existing graph semantics.
- [x] Write regression tests before production changes for each behavior change.
- [x] Before every implementation commit, run `npm run build`, `npm run lint`, and `npm run test:ci`.
- [x] After each verified implementation commit, update this checklist and commit the checked-off plan changes.

## File Map

- Modify `src/indexer/types.ts`: add optional derived graph read indexes to `ProjectIndex`.
- Create `src/graphs/adjacency.ts`: build and consume forward/reverse adjacency maps.
- Modify `src/graphs.ts`: export adjacency helpers if needed by CLI/session callers.
- Modify `src/indexer/build-index.ts`: attach adjacency indexes to `ProjectIndex` returns.
- Modify `src/graphs/queries.ts`: route dependency, reverse dependency, shortest path, and cycle adjacency construction through reusable helpers while preserving array-graph compatibility.
- Modify `src/cli/graphQueries.ts`: load graph queries through a manifest-backed `ProjectIndex` path instead of raw `collectGraph` where this preserves behavior.
- Modify `src/sqlite.ts`: implement high-level dependency-chain and affected-function traversals with bounded recursive SQL or indexed stepwise SQL, not full edge loading.
- Modify `src/agent/search.ts` and `src/agent/explain.ts` only if they need direct adjacency access beyond `getDependencies`/`getReverseDependencies`.
- Modify `docs/how-it-works.md` and `docs/cli.md`: document the read-performance behavior at a high level without adding new user-facing contracts.
- Add/modify tests in `tests/graph-queries.test.ts`, `tests/cli-regressions.test.ts`, `tests/sqlite.test.ts`, `tests/agent-search.test.ts`, and `tests/agent-explain.test.ts` as needed.

## Task 1: Baseline Regression And Performance-Shape Tests

**Files:**
- Modify: `tests/graph-queries.test.ts`
- Modify: `tests/cli-regressions.test.ts`
- Modify: `tests/sqlite.test.ts`
- Modify: `tests/agent-search.test.ts` if agent search behavior coverage needs a fixture-level guard
- Modify: `tests/agent-explain.test.ts` if explain behavior coverage needs a fixture-level guard

- [x] **Step 1: Add graph traversal regression tests**

  Add tests that build a graph with branching and cycles, then assert:
  - `getDependencies(graph, start, { depth })` returns the same files and depths as current behavior.
  - `getReverseDependencies(graph, target, { depth })` returns the same files and depths as current behavior.
  - `getShortestPath(graph, from, to)` returns the same path as current behavior.
  - `findDetailedCycles(graph)` still ignores document-only cycles and reports code cycles.

- [x] **Step 2: Add a performance-shape guard for traversal**

  Add a test graph where a naive implementation would scan all edges once per visited node. The test should use an instrumented graph edge iterable or helper-level instrumentation so it fails unless adjacency is built once and then reused for traversal.

- [x] **Step 3: Add CLI graph-query cache reuse regression**

  Add or extend CLI tests so `deps`, `rdeps`, and `path` can be run after a warm index/manifest and still return the exact current JSON/text payloads. The test should prove the command path can consume `ProjectIndex.graph` rather than requiring raw `collectGraph`.

- [x] **Step 4: Add SQLite canned traversal regression tests**

  In `tests/sqlite.test.ts`, add tests for:
  - `queryGraphSqlite(..., "What is the dependency chain for class X?")`
  - `queryGraphSqlite(..., "What functions are affected if module path changes?")`
  - Cyclic file-edge graphs do not loop forever.
  - Deleted/touched-file incremental updates still affect traversal correctly.

- [x] **Step 5: Run focused tests and verify expected failures**

  Run:
  ```powershell
  npm run test:run -- tests/graph-queries.test.ts tests/cli-regressions.test.ts tests/sqlite.test.ts
  ```
  Expected before implementation: the new performance-shape and/or cache-reuse tests fail for the intended reason, not because of syntax or fixture mistakes.

## Task 2: Add Reusable Graph Adjacency Indexes

**Files:**
- Create: `src/graphs/adjacency.ts`
- Modify: `src/graphs.ts`
- Modify: `src/indexer/types.ts`
- Modify: `src/indexer/build-index.ts`
- Test: `tests/graph-queries.test.ts`

- [x] **Step 1: Implement adjacency helper module**

  Create `GraphAdjacencyIndex` with:
  - `forward: Map<FileId, FileId[]>`
  - `reverse: Map<FileId, FileId[]>`
  - `buildGraphAdjacency(graph: Graph): GraphAdjacencyIndex`
  - `getForwardNeighbors(index, file)`
  - `getReverseNeighbors(index, file)`

  The helper must include only `edge.to.type === "file"` edges and must preserve existing edge order.

- [x] **Step 2: Attach adjacency to `ProjectIndex`**

  Add an optional `graphAdjacency?: GraphAdjacencyIndex` to `ProjectIndex`.
  Populate it in all `ProjectIndex` return paths in `src/indexer/build-index.ts`, including empty-index returns and manifest-backed incremental returns.

- [x] **Step 3: Keep helper API narrow**

  Do not expose mutable adjacency maps through new public API unless needed internally. If exported from `src/graphs.ts`, export only the type and pure helper functions.

- [x] **Step 4: Run focused tests**

  Run:
  ```powershell
  npm run test:run -- tests/graph-queries.test.ts
  ```
  Expected after this task: adjacency construction tests pass; traversal routing tests may still fail until Task 3.

## Task 3: Route Common In-Memory Reads Through Adjacency

**Files:**
- Modify: `src/graphs/queries.ts`
- Modify: `src/agent/search.ts` only if direct traversal changes are needed
- Modify: `src/agent/explain.ts` only if direct traversal changes are needed
- Test: `tests/graph-queries.test.ts`
- Test: `tests/agent-search.test.ts`
- Test: `tests/agent-explain.test.ts`

- [x] **Step 1: Update `getDependencies`**

  Use a built-once adjacency index for traversal. Preserve:
  - depth behavior
  - limit behavior
  - result order
  - start-file exclusion from results

- [x] **Step 2: Update `getReverseDependencies`**

  Use reverse adjacency with the same behavior guarantees as `getDependencies`.

- [x] **Step 3: Update `getShortestPath`**

  Use forward adjacency and preserve the first shortest path based on existing edge order.

- [x] **Step 4: Reuse adjacency in cycle detection where useful**

  Keep `findDetailedCycles` output stable. If reusing the helper makes the code simpler without changing ordering, do so; otherwise leave cycle logic unchanged.

- [x] **Step 5: Run focused tests**

  Run:
  ```powershell
  npm run test:run -- tests/graph-queries.test.ts tests/agent-search.test.ts tests/agent-explain.test.ts
  ```
  Expected: all focused tests pass and traversal performance-shape tests prove adjacency is not rebuilt or edges are not rescanned per BFS step.

- [x] **Step 6: Run full verification and commit**

  Run:
  ```powershell
  npm run build
  npm run lint
  npm run test:ci
  ```
  Expected: all commands exit 0.

  Commit:
  ```powershell
  git add src tests docs/superpowers/plans/2026-05-17-read-performance.md
  git commit -m "perf: index graph adjacency for common reads"
  ```

## Task 4: Reuse Manifest-Backed Index For CLI Graph Queries

**Files:**
- Modify: `src/cli/graphQueries.ts`
- Modify: `src/cli.ts` only if context wiring needs to pass index options
- Test: `tests/cli-regressions.test.ts`

- [x] **Step 1: Change graph-query loading**

  Replace raw `collectGraph(...)` loading for `deps`, `rdeps`, `path`, `cycles`, and `unresolved` with an index-backed loader where command options allow it. The loaded `ProjectIndex.graph` must be behaviorally identical to the previous graph for the same scan scope and graph flags.

- [x] **Step 2: Preserve dependency injection tests**

  `GraphQueryCommandContext` currently accepts injected `collectGraph` and `buildProjectIndex`. Keep testability by allowing injected graph/index loaders. Existing command-module tests should not need brittle filesystem fixtures.

- [x] **Step 3: Verify no output contract changes**

  Add JSON and text assertions for `deps`, `rdeps`, and `path`. Keep path formatting unchanged.

- [x] **Step 4: Run focused tests**

  Run:
  ```powershell
  npm run test:run -- tests/cli-command-modules.test.ts tests/cli-regressions.test.ts
  ```
  Expected: all focused CLI tests pass.

- [x] **Step 5: Run full verification and commit**

  Run:
  ```powershell
  npm run build
  npm run lint
  npm run test:ci
  ```
  Expected: all commands exit 0.

  Commit:
  ```powershell
  git add src tests docs/superpowers/plans/2026-05-17-read-performance.md
  git commit -m "perf: reuse indexed graphs for CLI reads"
  ```

## Task 5: Optimize High-Level SQLite Traversal Reads

**Files:**
- Modify: `src/sqlite.ts`
- Test: `tests/sqlite.test.ts`

- [x] **Step 1: Replace full edge loads for dependency chain**

  Update the `dependencyChain` high-level query to walk `file_edges` through indexed `to_type = 'file'` lookups rather than calling `loadFileEdges(db, "file")` and traversing all edges in JS.

- [x] **Step 2: Replace full edge loads for affected functions**

  Update `affectedFunctionsForModule` to use indexed reverse traversal and then query functions for impacted files. Preserve result shape and ordering semantics where existing tests assert them.

- [x] **Step 3: Guard cycles and duplicate paths**

  Ensure traversal tracks visited files, handles cycles, dedupes results in existing order, and handles missing start modules.

- [x] **Step 4: Run focused SQLite tests**

  Run:
  ```powershell
  npm run test:run -- tests/sqlite.test.ts tests/mcp-server.test.ts
  ```
  Expected: all focused SQLite and MCP SQLite tests pass.

- [x] **Step 5: Run full verification and commit**

  Run:
  ```powershell
  npm run build
  npm run lint
  npm run test:ci
  ```
  Expected: all commands exit 0.

  Commit:
  ```powershell
  git add src tests docs/superpowers/plans/2026-05-17-read-performance.md
  git commit -m "perf: use indexed SQLite traversal for graph queries"
  ```

## Task 6: Documentation And Operator Guidance

**Files:**
- Modify: `docs/how-it-works.md`
- Modify: `docs/cli.md`
- Modify: `codegraph-skill/codegraph/SKILL.md` only if command behavior or guidance changes
- Test: documentation covered by full build/lint/test gates

- [x] **Step 1: Document read-performance model**

  Add concise documentation that common in-process reads use derived adjacency indexes and that CLI graph queries reuse manifest-backed index data when available.

- [x] **Step 2: Confirm no command-surface changes**

  If no CLI flags, output fields, or commands changed, do not update `codegraph-skill/codegraph/SKILL.md`. If wording about performance-sensitive usage changes, update it consistently with `docs/cli.md`.

- [x] **Step 3: Run full verification and commit**

  Run:
  ```powershell
  npm run build
  npm run lint
  npm run test:ci
  ```
  Expected: all commands exit 0.

  Commit:
  ```powershell
  git add docs codegraph-skill docs/superpowers/plans/2026-05-17-read-performance.md
  git commit -m "docs: describe optimized read paths"
  ```

## Task 7: Review, Refine, Push, And Open PR

**Files:**
- Modify as required by review findings
- Update: `docs/superpowers/plans/2026-05-17-read-performance.md`

- [x] **Step 1: Deep review changed files**

  Review branch diff against `origin/main` for:
  - accuracy regressions
  - stale or incomplete tests
  - avoidable API widening
  - cache invalidation mistakes
  - unnecessary docs churn
  - TypeScript style issues, including no `any` and no `as unknown as`

- [x] **Step 2: Run behavior comparison commands**

  Run representative commands before final push:
  ```powershell
  npm run build
  npm run lint
  npm run test:ci
  node .\dist\cli.js deps src/index.ts --json
  node .\dist\cli.js rdeps src/index.ts --json
  node .\dist\cli.js path src/cli.ts src/index.ts --json
  node .\dist\cli.js search "sqlite graph" --json
  ```
  Expected: build/lint/test pass, commands return valid JSON, and no command errors.

- [x] **Step 3: Fix all real review findings**

  If review finds issues, add or update tests first, implement fixes, rerun full verification, update the checklist, and commit.

- [x] **Step 4: Repeat review/refine cycle**

  Repeat Steps 1-3 until review finds no real issues.

- [x] **Step 5: Push branch**

  Run:
  ```powershell
  git push -u origin readspeed
  ```

- [x] **Step 6: Open pull request**

  Use `gh pr create` if authenticated. The PR description must include:
  - Summary of performance changes
  - Accuracy safeguards
  - Test and verification commands run
  - Notes that persistent SQLite schema was not changed
