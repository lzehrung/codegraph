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

- [ ] Revisit CSS and Less language definitions.
  - Findings: `src/languages/definitions/css.ts:9-17` and `src/languages/definitions/less.ts:9-17`.
  - Extract shared CSS-family structure/query pieces only if it keeps each language definition readable.
  - Consider whether Vue/Svelte stylesheet definitions can reuse the same helper without hiding language-specific behavior.

- [ ] Evaluate JS fallback type duplication.
  - Findings: `packages/codegraph-js-fallback/js-fallback.d.ts` and `src/jsFallback.ts`.
  - Prefer generating or importing a single declaration source if package boundaries allow it.
  - Leave as-is if the duplication is required to keep the fallback package self-contained.

- [ ] Review smaller wrapper candidates opportunistically.
  - `src/cli/artifact.ts`, `src/cli/explain.ts`, and `src/cli/search.ts` command context interfaces.
  - `src/cli/projectFile.ts` and `src/session.ts` file-input resolution.
  - `src/cli/options.ts` positive and non-negative integer parsers.
  - `src/sqlite/canned-query.ts` direct dependencies and dependents queries.

### Tests

- [ ] Add a shared temporary directory helper for tests.
  - Findings: repeated `mkTmpDir` helpers across dynamic resolution, fast graph edge cases, node modules, resolution precedence, robust fast graph, TS paths workspace, cache, and parsed-cache tests.
  - Put it near existing test helpers and migrate only obvious identical helpers first.

- [ ] Add shared edge-normalization helpers for graph tests.
  - Findings: `tests/fast-graph.test.ts`, `tests/monorepo-fast-graph.test.ts`, and related fast graph tests.
  - Replace duplicated `normEdge`, `toKey`, and slash normalization only where it improves readability.

- [ ] Consolidate repeated SQLite/test database setup blocks.
  - Findings: repeated chunks in `tests/sqlite.test.ts`, `tests/sql-artifact-graph.test.ts`, and `tests/sql-review-context.test.ts`.
  - Extract helpers that describe domain intent, not just line-for-line setup.

- [ ] Leave intentional fixture repetition alone.
  - Repeated sample snippets are often test data, not production maintenance debt.
  - Do not refactor setup that would make an individual test harder to read.

### Analyzer Follow-Ups

- [ ] Consider a length-ratio guard for high-confidence renamed groups.
  - Example noise: large C/C++ query chunks paired with tiny language-definition snippets.
  - The detector already reports `lengthRatio`; ranking or confidence can use it more aggressively.

- [ ] Consider collapsing adjacent same-file chunk findings under a larger group.
  - Example: multiple `src/cli/graph.ts` chunk findings are one underlying helper extraction.
  - Keep raw variants available through `--raw-pairs`.

## Verification Plan

- [ ] Run `npm run build`.
- [ ] Run `npm run lint`.
- [ ] Run focused tests for touched areas.
- [ ] Run `npm test` before pushing a completed refactor batch.
- [ ] Re-run the duplicate analyzer and compare top findings against this baseline.
