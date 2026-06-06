# Performance and Cache Opportunities Plan

This plan captures remaining high-impact opportunities from a broad repo audit focused on MCP startup, cache behavior, search, references, impact/review, and duplicate detection performance. It is self-contained so another agent can implement items without the original conversation.

Existing unrelated worktree context when this plan was written:

- `src/cli/help.ts`, `tests/cli-command-modules.test.ts`, `src/review.ts`, and `tests/review.test.ts` had small fixes for CLI help and review `head` metadata.
- `package-lock.json` was modified by `npm install` to restore a missing optional Rolldown native dependency needed by Vitest.

Use focused tests while implementing each item. Run `npm run check` before concluding major work.

## Observed Baseline

Commands run from repo root:

- `node ./dist/cli.js doctor`
- `node ./dist/cli.js orient --root . --budget small --json`
- `node ./dist/cli.js hotspots ./src --limit 25 --json`
- `node ./dist/cli.js inspect ./src --limit 20`

Observed facts:

- Native backend is available.
- `inspect ./src` saw 287 TypeScript source files, zero unresolved imports, and zero cycles.
- Hotspots included `src/indexer/build-index.ts`, `src/indexer/navigation.ts`, `src/agent/search.ts` dependencies, `src/native/treeSitterNative.ts`, and project-file utilities.
- Duplicate health reported many high-confidence duplicate opportunities in `src`; this makes duplicate detection and duplicate-context paths important performance targets.

## MCP Server and Cache Behavior Today

Starting `mcp serve` does **not** refresh the on-disk cache today.

Evidence:

- `serveCodegraphMcp()` only creates handlers/server and connects transports in `src/mcp/server.ts`.
- `createCodegraphMcpHandlers()` creates an `AgentSession`, but does not call `loadProject()`.
- `createAgentSession()` defers all index work until `loadProject()`.
- The first actual tool request calls `buildProjectIndexIncremental()` with `cache: "disk"` and `keepParsed: true`, which can refresh `.codegraph-cache/index-v1`.

Implication:

- Lazy startup is fast, but the first MCP request pays indexing and cache-refresh cost.
- Long-running MCP sessions can serve stale in-memory snapshots until manually invalidated or restarted.

## Priority 1: Avoid Eager Symbol Graph Construction in MCP

Several MCP tools only need the base `ProjectIndex` or file graph, but currently can force detailed symbol graph construction.

Why this matters:

- This is likely the highest ROI small change for MCP first-query latency.
- `createAgentSession.loadProject({ symbolGraph: "skip" })` already exists and shares the same cached base snapshot with later eager loads.
- Later symbol-heavy tools can still build the detailed graph once when needed.

Implementation checklist:

- [ ] In `src/agent/orient.ts`, load with `session.loadProject({ symbolGraph: "skip" })` unless orientation starts using `snapshot.symbolGraph`.
- [ ] In `src/mcp/server.ts`, use skipped symbol graph loads for `deps`, `rdeps`, `path`, `goto`, and position-based `refs`.
- [ ] Keep handle-based `refs`, `get_symbol`, `packet_get`, and hybrid/symbol search eager where explain/search needs symbol graph context.
- [ ] Add tests proving these MCP calls do not invoke `buildSymbolGraphDetailed()`.
- [ ] Preserve current eager behavior for tools that need symbol graph neighbors or symbol handles.

Likely files:

- `src/mcp/server.ts`
- `src/agent/orient.ts`
- `src/agent/session.ts`
- `tests/mcp-server.test.ts`
- `tests/agent-session.test.ts`

Validation:

- [ ] `npx vitest run tests/mcp-server.test.ts tests/agent-session.test.ts`
- [ ] `node ./dist/cli.js orient --root . --budget small --json`

## Priority 2: Add Explicit MCP Warmup

Add an opt-in warmup mode so users can refresh the disk cache before the first agent request.

Why this matters:

- Lazy startup is good for stdio, but HTTP and long-lived agent processes often prefer paying setup cost once.
- Warmup can refresh the on-disk incremental cache while reusing the same in-memory session that handlers will use.

Implementation checklist:

- [ ] Add `warmup?: "off" | "base" | "symbols"` to `CodegraphMcpServerOptions`.
- [ ] Add CLI flags in `src/cli/mcp.ts`, for example `--warmup` and `--warmup-symbols`.
- [ ] Implement base warmup with `session.loadProject({ symbolGraph: "skip" })`.
- [ ] Implement symbol warmup with the default eager `session.loadProject()`.
- [ ] Reuse the handler session so a concurrent first request joins the same promise rather than building twice.
- [ ] Decide default behavior explicitly: keep stdio lazy; for HTTP either keep lazy or start background base warmup after listen.
- [ ] Document that warmup refreshes `.codegraph-cache/index-v1` through the incremental disk cache.

Risks:

- Foreground warmup delays server readiness.
- Background warmup can race the first request unless it shares the same `AgentSession` promise.

Likely files:

- `src/cli/mcp.ts`
- `src/mcp/server.ts`
- `src/agent/session.ts`
- `src/cli/help.ts`
- `docs/cli.md`
- `docs/mcp.md`
- `docs/agent-workflows.md`
- `codegraph-skill/codegraph/SKILL.md`
- `tests/mcp-server.test.ts`
- `tests/cli-command-modules.test.ts`

Validation:

- [ ] `npx vitest run tests/mcp-server.test.ts tests/cli-command-modules.test.ts`
- [ ] `node ./dist/cli.js mcp serve --help`

## Priority 3: Add MCP Session Invalidation

Long-running MCP servers need a way to refresh stale snapshots when files, config, or cache inputs change.

Why this matters:

- Disk cache invalidation is handled when a build runs, but MCP may not trigger a new build because `AgentSession` holds resolved snapshots.
- Current behavior can omit files created after the first load from later artifact/search results.

Implementation checklist:

- [ ] Add a cheap staleness check before handlers that depend on indexed repo state.
- [ ] Prefer conservative triggers: config hash, manifest timestamp/version, file-list fingerprint, or explicit user refresh.
- [ ] Avoid full discovery on every request; debounce any file-system check.
- [ ] Add a read-only MCP tool or request option such as `refresh_index` if automatic invalidation is too expensive or risky.
- [ ] Call `session.invalidate()` before the next `loadProject()` when stale.
- [ ] Keep `get_file` independent because it reads directly from disk.

Likely files:

- `src/agent/session.ts`
- `src/mcp/server.ts`
- `src/mcp/tools.ts`
- `src/indexer/build-cache/manifest.ts`
- `src/indexer/build-index.ts`
- `tests/mcp-server.test.ts`
- `tests/cache-invalidation.test.ts`

Validation:

- [ ] Add a test that loads a session, creates `late.ts`, refreshes/invalidates, then verifies search or artifact output includes `late.ts`.
- [ ] `npx vitest run tests/mcp-server.test.ts tests/cache-invalidation.test.ts`

## Priority 4: Skip Detailed Symbol Graph for SQL-Only Search

`mode: "sql"` can use SQL locals already present in the base index instead of building the detailed symbol graph.

Why this matters:

- `searchNeedsSymbolGraph()` currently returns eager for every mode except `path` and `text`.
- SQL object symbols are produced by SQL indexing into `ProjectIndex.byFile`; detailed graph construction mostly wraps them for search.
- SQL-only search should be closer to path/text search cost.

Implementation checklist:

- [ ] Add a SQL-specific result path in `src/agent/search.ts` that iterates `.sql` module locals from `snapshot.index.byFile`.
- [ ] Reuse existing token scoring and SQL handle formatting.
- [ ] Change `searchNeedsSymbolGraph()` so `mode === "sql"` loads with `symbolGraph: "skip"`.
- [ ] Keep hybrid behavior unchanged initially to avoid ranking churn.
- [ ] Avoid symbol-neighbor work for SQL-only mode unless it can be sourced from the base file graph.

Likely files:

- `src/agent/search.ts`
- `src/sql/sourceGraph.ts`
- `src/graphs/symbol-graph.ts`
- `tests/agent-search.test.ts`
- `tests/agent-session.test.ts`

Validation:

- [ ] Extend SQL search tests to assert SQL object results still appear.
- [ ] Add a spy assertion that SQL-only search does not call `buildSymbolGraphDetailed()`.
- [ ] `npx vitest run tests/agent-search.test.ts tests/agent-session.test.ts`

## Priority 5: Reuse Reference Scans Across Impact and Review

Impact and review paths can scan references for the same changed symbol more than once.

Why this matters:

- `attachCallCompatibilityHints()` calls `findReferences()` per changed callable.
- `analyzeDirectReferences()` then calls `findReferences()` again for direct impact.
- `summarizeChangedFiles()` repeats a similar pattern for review callsites.
- Reference scans are among the most expensive semantic operations on larger repos.

Implementation checklist:

- [ ] Add a per-run reference cache keyed by symbol id plus options that affect output.
- [ ] Include at least max reference limit, context mode, context line/block settings, and filters in the cache key.
- [ ] Let `attachCallCompatibilityHints()` accept a cache or callback for reference lookup.
- [ ] Let direct impact consume cached uncontextualized references when options match.
- [ ] In review, reuse compatibility references for callsites when the requested limit is compatible; otherwise top up with a larger scan instead of starting from zero.
- [ ] Keep contextual reference snippets separate unless the cached result includes the same context options.

Likely files:

- `src/impact/analyzer.ts`
- `src/impact/direct.ts`
- `src/impact/callCompatibility.ts`
- `src/review/summaries.ts`
- `tests/impact-analyzer.test.ts`
- `tests/review.test.ts`
- `tests/impact-call-compatibility/fallback-budget.test.ts`

Validation:

- [ ] Add tests with a spy/count around `findReferences()` for one changed callable.
- [ ] `npx vitest run tests/impact-analyzer.test.ts tests/review.test.ts tests/impact-call-compatibility/fallback-budget.test.ts`

## Priority 6: Native Duplicate Candidate Generation

Move the duplicate-detection hot path into `packages/codegraph-native` when the payoff justifies native expansion.

Why this matters:

- `src/duplicates.ts` tokenizes source, normalizes tokens, builds shingles, stores token sets/signatures, buckets units, and scores candidate pairs in JavaScript.
- The audit observed very large duplicate candidate counts even for `src`-only scans.
- Rust can reduce allocations, avoid JS `Set<string>` overhead, and parallelize pair generation more predictably.

Implementation checklist:

- [ ] Define a native API that accepts duplicate units or source spans and returns compact fingerprints/candidate pairs.
- [ ] Start with tokenization, normalization, shingle/winnow fingerprints, and candidate-pair bucket generation.
- [ ] Keep final reporting, grouping, and CLI JSON schema in TypeScript initially.
- [ ] Preserve JS fallback behavior when native is unavailable or disabled.
- [ ] Add parity fixtures comparing native and JS duplicate results for exact, renamed, near, and low-confidence cases.
- [ ] Add a benchmark fixture with many repeated units and a performance threshold or regression report.

Likely files:

- `src/duplicates.ts`
- `src/native/treeSitterNative.ts`
- `packages/codegraph-native/src/*`
- `packages/codegraph-native/Cargo.toml`
- `tests/duplicates.test.ts`
- `tests/native-semantic-parity.test.ts` or a new native duplicate parity test

Validation:

- [ ] `npx vitest run tests/duplicates.test.ts`
- [ ] `npm run test:native`
- [ ] A targeted duplicate benchmark before and after the native path.

## Priority 7: Persist a Ready-to-Load Project Index Snapshot

Warm disk cache still reconstructs a `ProjectIndex` from per-file entries. A ready snapshot could make MCP first requests much faster.

Why this matters:

- On large repos, reconstructing maps, exports, import graph, and derived metadata can dominate warm start even when per-file parsing is cached.
- MCP and agent commands repeatedly need the same immutable project snapshot.

Implementation checklist:

- [ ] Design a manifest-backed serialized project-index snapshot, probably SQLite or compact binary JSON.
- [ ] Include all invalidation inputs: codegraph version, native backend version, config hash, discovery options, graph options, file list, file signatures, and language definitions version.
- [ ] Load the snapshot before reconstructing from per-file cache entries.
- [ ] Fall back to current incremental path on any version or manifest mismatch.
- [ ] Keep schema migrations explicit if SQLite is used.
- [ ] Measure warm start for `orient`, `search`, `refs`, and MCP first request.

Likely files:

- `src/indexer/build-index.ts`
- `src/indexer/build-cache/*`
- `src/sqlite/*`
- `src/agent/session.ts`
- `tests/cache-invalidation.test.ts`
- New snapshot-cache regression tests

Validation:

- [ ] Old-cache migration or fallback test.
- [ ] Warm-cache parity test comparing current incremental output and snapshot output.
- [ ] `node ./dist/cli.js orient --root . --budget small --json` before/after timing.

## Priority 8: Stop Hashing Every File on Warm Git-Backed Cache Runs

When the repo is clean and tracked, git object ids or index metadata can avoid rereading every file to verify cache entries.

Why this matters:

- Warm cache performance can still suffer from file reads/hashes before doing useful work.
- WSL and network filesystems make repeated stat/read operations expensive.

Implementation checklist:

- [ ] Identify where file signatures are computed for disk cache entries.
- [ ] Add a git-backed signature provider when the project root is inside a git worktree.
- [ ] Use git object id for tracked clean files when safe.
- [ ] Use content hashing for `--cache-strict`; use mtime/size metadata only in non-strict modes where `--cache-verify` and existing cache contracts allow it.
- [ ] Keep `--cache-strict` and `--cache-verify` semantics intact.

Likely files:

- `src/indexer/build-index.ts`
- `src/indexer/build-cache/*`
- `src/drift/git.ts` or a new git metadata helper
- `tests/cache-invalidation.test.ts`

Validation:

- [ ] Tests for clean tracked file, modified tracked file, untracked file, and `--cache-strict`.
- [ ] Warm-cache timing on this repo.

## Priority 9: Add a Reference Candidate Index

Create a ProjectIndex-level reverse lookup for reference candidates to reduce broad scans.

Why this matters:

- `findReferences()` is used by user commands, MCP, impact, and review.
- Current verified reference scans often find candidates by walking AST/text and then validating via navigation.
- A precomputed candidate index can drastically reduce files/ranges to inspect.

Implementation checklist:

- [ ] Build an identifier/member occurrence index during project indexing or native extraction.
- [ ] Index imports, exports, local declarations, member accesses, and language-specific reference capture nodes.
- [ ] Use the index as a candidate filter before expensive go-to verification.
- [ ] Preserve current correctness by keeping verification for ambiguous candidates.
- [ ] Consider native/Rust extraction for occurrence vectors to avoid JS AST walking.

Likely files:

- `src/indexer/navigation.ts`
- `src/indexer/navigation-local.ts`
- `src/indexer/reference-context.ts`
- `src/indexer/build-index.ts`
- `packages/codegraph-native/src/*`
- `tests/references.test.ts`
- `tests/native-semantic-parity.test.ts`

Validation:

- [ ] Existing references test suite.
- [ ] A benchmark for reference lookup across a large fixture.

## Priority 10: Make Review Duplicate-Sibling Detection Target-First

Review duplicate tasks should not need broad duplicate detection for every review.

Why this matters:

- Review only needs duplicates overlapping changed symbols or changed lines.
- Broad duplicate detection is valuable for the dedicated `duplicates` command, but too expensive as a review side effect.

Implementation checklist:

- [ ] In review, collect duplicate targets from changed symbols and uncovered changed lines.
- [ ] Build candidate buckets only around those targets.
- [ ] Reuse existing `findDuplicateContexts()` behavior where possible, but ensure it does target-first work internally.
- [ ] Keep exhaustive duplicate detection unchanged for `codegraph duplicates`.
- [ ] Report omitted/partial metadata when target-first budgets truncate results.

Likely files:

- `src/review.ts`
- `src/duplicates.ts`
- `src/review/types.ts`
- `tests/review.test.ts`
- `tests/duplicates.test.ts`

Validation:

- [ ] Review duplicate-sibling tests still pass.
- [ ] Add a test proving unchanged duplicate-heavy files do not dominate review runtime or pair count.

## Priority 11: Search Hot-Loop and Ranking Optimizations

Repeated agent/MCP searches can avoid repeated file reads, normalization, and full-result sorts.

Why this matters:

- Agent search is an interactive path.
- Path/text searches already skip detailed symbol graph, but still benefit from cached normalized text and bounded top-K ranking.

Implementation checklist:

- [ ] Add session-level caches for file text, normalized text, text chunks, and chunk boundaries.
- [ ] Replace full-result sort with bounded top-K where output limit is small.
- [ ] Make path-only search a file-list fast path that avoids index load entirely when possible.
- [ ] Move token scoring and text prefilter loops to native/Rust only after cache boundaries are stable.

Likely files:

- `src/agent/search.ts`
- `src/agent/session.ts`
- `src/chunking/*`
- `packages/codegraph-native/src/*`
- `tests/agent-search.test.ts`

Validation:

- [ ] Existing agent search tests.
- [ ] Repeated MCP search timing before/after.

## Priority 12: Smaller Performance Cleanups

These are useful after the larger wins or when touching nearby code.

Checklist:

- [ ] Persist SQL navigation lookup/facts on `ProjectIndex` instead of rebuilding per SQL goto/refs request.
- [ ] Auto-enable native workers for large MCP/agent cold builds, with explicit opt-out.
- [ ] Precompute candidate-test indexes once per impact/review run.
- [ ] Cache receiver/member/local-scope lookup primitives used by `goToDefinition()`.
- [ ] Scope detailed symbol graph construction to changed-file context for impact where full graph context is unnecessary.
- [ ] Persist or reuse Bloom filters instead of rereading every cached source file.

## Correctness Opportunities Still Worth Tracking

These are not primarily performance work, but they remained confirmed high-value gaps from the same audit stream.

Checklist:

- [ ] TypeScript enum declarations should be indexed as real symbols for goto/refs.
- [ ] Anonymous JS/TS default exports should resolve through default imports.
- [ ] JS/TS shorthand binding nodes should navigate to the actual binding/import.
- [ ] Breaking-change suggestions should handle multiline exported signatures.
- [ ] Publishing/install docs should clarify that JS fallback is only available when `@lzehrung/codegraph-js-fallback` is installed.
- [ ] Consider stable subpath exports before narrowing the broad root API.

## Suggested Execution Order

- [ ] Start with Priority 1 because it is small, low-risk, and directly improves MCP latency.
- [ ] Add MCP warmup and invalidation next so long-running server behavior is explicit and correct.
- [ ] Optimize SQL-only search and reference reuse before native expansion; both are medium effort with clear tests.
- [ ] Tackle duplicate native acceleration only after budgets and JS behavior are well covered by parity tests.
- [ ] Add project-index snapshots after cache invalidation semantics are settled.

## Validation Checklist

Use the narrowest tests during iteration, then run broader gates before finalizing major implementation work.

- [ ] `npx vitest run tests/mcp-server.test.ts tests/agent-session.test.ts`
- [ ] `npx vitest run tests/agent-search.test.ts`
- [ ] `npx vitest run tests/impact-analyzer.test.ts tests/review.test.ts tests/impact-call-compatibility/fallback-budget.test.ts`
- [ ] `npx vitest run tests/duplicates.test.ts`
- [ ] `npm run test:native` when touching `packages/codegraph-native`
- [ ] `node ./dist/cli.js doctor`
- [ ] `node ./dist/cli.js orient --root . --budget small --json`
- [ ] `node ./dist/cli.js inspect --root . ./src --limit 20 --json`
- [ ] `npm run check` before concluding major work
