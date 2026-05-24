# Duplicate Findings Refactor Plan

## Baseline Scan

Generated from the repo-local CLI on branch `elim-dups` after rebuilding `dist`.

Commands:

```bash
node ./dist/cli.js duplicates --root . ./src --min-confidence medium --limit 100 --include-same-file
node ./dist/cli.js duplicates --root . . --min-confidence high --limit 200 --include-same-file
```

Results:

- `src` scan: 100 returned groups, 1234 omitted groups, 1669 omitted raw suggestions.
- whole-repo scan: 200 returned groups, 2097 omitted groups, 2995 omitted raw suggestions.
- Whole-repo top results are dominated by test helpers and setup snippets.
- Product-code top results are concentrated in `src/graphs`, `src/cli`, `src/impact`, `src/chunking`, `src/mcp`, and language definitions.

Post-refactor comparison:

- `src` scan: 100 returned groups, 869 omitted groups, 1611 omitted raw suggestions.
- whole-repo scan: 200 returned groups, 899 omitted groups, 2904 omitted raw suggestions.
- The previous `src/graphs/symbol-render.ts`, `src/cli/graph.ts`, chunk tokenizer, AST range, CSS/LESS, and first-pass test helper findings dropped out of the top product-code results.
- The analyzer no longer ranks the large C/C++ query chunk against tiny language snippets as a top medium/high finding.

The grouped output is usable for triage. Remaining caveats:

- Some chunk findings are sub-ranges of a larger duplicate and should be handled through the larger refactor.
- Some renamed findings compare very different-sized chunks; those are analyzer noise unless a human can identify a clear shared behavior.
- Repeated declarative language-definition shapes are not automatically bad duplication.

## Refactor Checklist

### Product Code

- [x] Refactor symbol graph renderers.
  - Findings: `src/graphs/symbol-render.ts:84-149` and `src/graphs/symbol-render.ts:151-218`.
  - Extract shared file-node, symbol-node, and graph-edge collection.
  - Keep Mermaid and DOT formatting separate so escaping and syntax remain explicit.
  - Add or update renderer tests if output ordering or formatting can change.

- [x] Refactor compact graph symbol projection.
  - Findings: `src/cli/graph.ts:121-146` and `src/cli/graph.ts:169-194`.
  - Extract shared file index, symbol index, symbol array, and sorted symbol edge construction.
  - Keep the difference between full compact graph output and symbols-only output visible at the call site.

- [x] Share AST range conversion.
  - Findings: `src/impact/suggestions.ts:372-385` and `src/util/ast.ts:32-41`.
  - Reuse `toRange` from `src/util/ast.ts` or move the non-null conversion into a shared helper.
  - Preserve the existing null-node behavior used by current callers.

- [x] Share default token counting.
  - Findings: `src/chunking/chunkFile.ts:28-31` and `src/chunking/chunkTextFile.ts:21-24`.
  - Introduce a small shared tokenizer helper in `src/chunking`.
  - Keep public chunking options unchanged.

- [x] Consolidate dependency and reverse-dependency wrappers where useful.
  - Findings: `src/agent-tools.ts:366-441`, `src/mcp/server.ts:228-246`, and `src/mcp/tools.ts:88-114`.
  - Prefer a small result-mapping helper over forcing identical public response shapes.
  - Verify both CLI/agent tools and MCP tools still expose `dependencies` and `reverseDependencies` separately.

- [x] Revisit CSS and Less language definitions.
  - Findings: `src/languages/definitions/css.ts:9-17` and `src/languages/definitions/less.ts:9-17`.
  - Extract shared CSS-family structure/query pieces only if it keeps each language definition readable.
  - Consider whether Vue/Svelte stylesheet definitions can reuse the same helper without hiding language-specific behavior.

- [x] Evaluate JS fallback type duplication.
  - Findings: `packages/codegraph-js-fallback/js-fallback.d.ts` and `src/jsFallback.ts`.
  - Prefer generating or importing a single declaration source if package boundaries allow it.
  - Leave as-is if the duplication is required to keep the fallback package self-contained.
  - Decision: leave as-is because the fallback package publishes a self-contained `js-fallback.d.ts`.

- [x] Review smaller wrapper candidates opportunistically.
  - `src/cli/artifact.ts`, `src/cli/explain.ts`, and `src/cli/search.ts` command context interfaces.
  - `src/cli/projectFile.ts` and `src/session.ts` file-input resolution.
  - `src/cli/options.ts` positive and non-negative integer parsers.
  - `src/sqlite/canned-query.ts` direct dependencies and dependents queries.
  - Decision: extracted the common agent CLI context and canned-query edge loader; left session file resolution and option parsing as-is because their existing helpers already separate concerns.

### Tests

- [x] Add a shared temporary directory helper for tests.
  - Findings: repeated `mkTmpDir` helpers across dynamic resolution, fast graph edge cases, node modules, resolution precedence, robust fast graph, TS paths workspace, cache, and parsed-cache tests.
  - Put it near existing test helpers and migrate only obvious identical helpers first.

- [x] Add shared edge-normalization helpers for graph tests.
  - Findings: `tests/fast-graph.test.ts`, `tests/monorepo-fast-graph.test.ts`, and related fast graph tests.
  - Replace duplicated `normEdge`, `toKey`, and slash normalization only where it improves readability.

- [x] Consolidate repeated SQLite/test database setup blocks.
  - Findings: repeated chunks in `tests/sqlite.test.ts`, `tests/sql-artifact-graph.test.ts`, and `tests/sql-review-context.test.ts`.
  - Extract helpers that describe domain intent, not just line-for-line setup.

- [x] Leave intentional fixture repetition alone.
  - Repeated sample snippets are often test data, not production maintenance debt.
  - Do not refactor setup that would make an individual test harder to read.

### Analyzer Follow-Ups

- [x] Consider a length-ratio guard for high-confidence renamed groups.
  - Example noise: large C/C++ query chunks paired with tiny language-definition snippets.
  - The detector already reports `lengthRatio`; ranking or confidence can use it more aggressively.

- [x] Consider collapsing adjacent same-file chunk findings under a larger group.
  - Example: multiple `src/cli/graph.ts` chunk findings are one underlying helper extraction.
  - Keep raw variants available through `--raw-pairs`.

## Follow-Up Scan: 2026-05-23

Generated after the first duplicate cleanup pass on branch `elim-dups`.

Commands:

```bash
node ./dist/cli.js duplicates --root . ./src --min-confidence medium --limit 120 --include-same-file
node ./dist/cli.js duplicates --root . . --min-confidence high --limit 120 --include-same-file
node ./dist/cli.js inspect --root . ./src --limit 8
node ./dist/cli.js review --base main --head HEAD --summary
node ./dist/cli.js doctor
```

Results:

- `src` scan: 120 returned groups, 849 omitted groups, 1611 omitted raw suggestions.
- whole-repo scan: 120 returned groups, 973 omitted groups, 2898 omitted raw suggestions.
- `doctor` reports native runtime availability and artifact health only; it does not surface duplicate cleanup opportunities.
- `review --summary` reports diff risk and candidate tests only; it does not surface duplicate cleanup opportunities.
- `inspect` reports hotspots, unresolved imports, cycles, and recommended commands only; it is the best current home for an at-a-glance duplicate opportunity section.

### Product Output Follow-Ups

- [x] Coalesce repeated grouped duplicate findings with the same primary ranges.
  - Finding: `src/indexer/imports/languageSpecific.ts:249-258 applyJavaStatementOverride` vs `src/indexer/imports/languageSpecific.ts:260-269 applyKotlinStatementOverride` appeared multiple times with the same primary pair.
  - Preserve raw evidence counts through `rawPairCount` and bounded `variants`.
  - Keep `--raw-pairs` as the explicit escape hatch for low-level pair inspection.

- [x] Surface bounded duplicate opportunities in `inspect` output.
  - Include high-signal fields only: confidence, clone type, score, files/ranges, token counts, and raw pair count.
  - Keep the summary bounded by `--limit`.
  - Add a `duplicates` follow-up command to `recommendedCommands` so agents can drill into full grouped JSON.
  - Leave `doctor` focused on package/runtime/artifact health.

### Remaining Source Cleanup Candidates

- [x] Share C/C++ language-definition scaffolding where it stays readable.
  - Findings: `src/languages/definitions/c.ts:14-147` and `src/languages/definitions/cpp.ts:14-165`.
  - Preserve C-specific macro support and C++ namespace/class/alias/using/lambda behavior.

- [x] Share package export target selection between node-module and workspace resolution.
  - Findings: `src/util/resolution/node.ts:22-34 tryResolveRelative` and `src/util/workspace.ts:298-307 pickExportTarget`.
  - Prefer a small resolver helper over duplicating `exports` target precedence.

- [x] Share Java/Kotlin import override plumbing.
  - Findings: `src/indexer/imports/languageSpecific.ts:249-258` and `src/indexer/imports/languageSpecific.ts:260-269`.
  - Keep Java and Kotlin parsing differences explicit at the call site.

- [x] Share range line-counting for coverage suggestions.
  - Findings: `src/impact/report-suggestions.ts:820-827` and `src/impact/report-suggestions.ts:829-836`.
  - Preserve zero-count behavior when no coverage is available.

- [x] Share file-like agent handle parsing.
  - Findings: `src/agent/handles.ts:54-60` and `src/agent/handles.ts:82-88`.
  - Keep public handle prefixes and return types unchanged.

- [x] Share discovery glob relative-path matching.
  - Findings: `src/cli/context.ts:25-35` and `src/util/projectFiles.ts:278-288`.
  - Keep CLI include/ignore globs relative to active scan roots and config globs relative to project roots.

Follow-up verification:

- [x] `src` scan reports `0` repeated displayed primary pairs in the first 80 medium-or-higher groups.
- [x] `inspect --root . ./src --limit 5` emits compact high-confidence duplicate opportunities and a `duplicates` follow-up command.
- [x] Focused duplicate, inspect, C/C++, resolution, references, impact-suggestion, and agent-search tests pass.
- [x] Full test suite passes.

## Verification Plan

- [x] Run `npm run build`.
- [x] Run `npm run lint`.
- [x] Run focused tests for touched areas.
- [x] Run `npm test` before pushing a completed refactor batch.
- [x] Re-run the duplicate analyzer and compare top findings against this baseline.
