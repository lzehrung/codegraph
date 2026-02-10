# Codegraph Analysis: Correctness & Performance

Analysis of bugs and performance issues identified in the codebase.

**Status: All items resolved in #54.** This document records what was found and where each fix landed.

Items marked **(false positive)** were incorrectly flagged — the issue did not exist in the code at the time of analysis.

---

## Part 1: Correctness Issues (all fixed)

### C1. ~~`resolveExportFrom` infinite recursion on circular re-exports~~

**Fixed in:** `src/graphs.ts:1259` — sentinel `cache.set(key, null)` added before recursive descent.

The function previously had no cycle detection. The cache key was only written after a result was found, so circular re-export chains (e.g., `A re-exports from B, B re-exports from A`) caused stack overflow. Now matches the `visited` Set pattern used by `resolveExport` in `indexer.ts`.

### C2. ~~`stripJsLikeComments` corrupted string literals containing `//`~~

**Fixed in:** `src/util.ts:724-795` — replaced naive regex with a character-by-character scanner that tracks string/template literal state.

The old regex `/(^|[^:])\/\/.*$/gm` only skipped `://` (URL protocols) but stripped `//` inside string literals (e.g., `"//cdn.example.com"` became `"`). The new implementation properly preserves single-quoted, double-quoted, and template strings.

### C3. ~~Python relative-only imports missed by `extractPythonSpecifiers`~~

**Fixed in:** `src/util.ts:1039` — regex updated to `/(\.+(?:[A-Za-z_][\w\.]*)?|[A-Za-z_][\w\.]*)/`.

The old regex required an identifier after dots, so `from . import utils` and `from .. import config` were not matched.

### C4. ~~Python dot-only specifiers passed as module name instead of `null`~~

**Fixed in:** `src/graphs.ts:396-400` — added `const isDotsOnly = /^\.+$/.test(spec)` guard, passing `null` as module name for dot-only specs.

Previously, `"..".includes(".")` evaluated to `true`, so `".."` was incorrectly passed as a module name to `resolvePythonModule`.

### C5. ~~`fileExistsCache` never invalidated~~

**Fixed in:** `src/util.ts:2425-2431` — added `clearResolutionCaches()` export that clears `fileExistsCache`, `resolveSpecifierCache`, `resolvePythonModuleCache`, `tsconfigCache`, and `workspaceCache`.

---

## Part 2: Performance Issues (all fixed)

### P1. ~~Sequential file existence checks in specifier resolution~~

**Fixed in:** `src/util.ts:1850-1855` — candidates now checked via `Promise.all()` with first-hit selection by priority order.

### P2. ~~Sequential import resolution within `collectEdgesForFile`~~

**Fixed in:** `src/graphs.ts:390` — specifier resolution refactored from sequential `for` loop to `specs.map(async ...)` with `Promise.all`.

### P3. ~~`resolveSpecifier` lacks early short-circuit~~ (false positive)

The original claim that relative imports fell through to tsconfig/workspace/node_modules resolution was **wrong**. The code already had an early return for relative/absolute paths before the analysis was written (`src/util.ts:1782-1794`). The `dae5b22` commit added URL/scheme fast-exit and Windows absolute-path guards, which are genuine improvements but the original characterization was inaccurate.

### P4. ~~Multiple regex passes in `extractJsTsSpecifiers`~~

**Fixed in:** `src/util.ts:835-856` — consolidated 6 separate regex `matchAll` calls into a single combined regex pass.

### P5. ~~Redundant fan-in computation in impact analysis~~

**Fixed in:** `src/impact/analyzer.ts:39-58` — extracted `buildDependencyStats()` function that computes both `fanInByFile` and `reverseDeps` in a single pass over graph edges.

---

## Part 3: Feature Gaps

### F1. ~~No CSS `@import` or HTML inline dependency tracking~~ (false positive)

The original claim that "CSS has no import queries defined at all" was **wrong**. At the time of analysis:
- `css.ts` already had `(import_statement (string_value) @mod) @stmt`
- `scss.ts` already had `@import`, `@use`, and `@forward` queries
- `less.ts` already had `@import` via the CSS grammar
- `html.ts` already had `script[src]` and `link[href]`

The `dae5b22` commit added `a[href]`, `img[src]`, inline `<script>` import extraction, and unquoted attribute support to HTML — genuine improvements, but the core CSS/SCSS/Less import tracking was already in place.

### F2. ~~No circular dependency detection or reporting~~ (false positive)

`findCycles()` already existed at `src/graphs.ts:814` as a Tarjan's SCC implementation, exported and used in the CLI, before the analysis was written. The `dae5b22` commit added cycle summaries to impact reports with severity flags — a useful enhancement, not a gap fix.

### F3-F8: Partially addressed — see ROADMAP.md

The remaining feature items (Vue/Svelte template deps, config impact, breaking changes, test coverage gaps, cross-language monorepo deps, incremental SQLite) were all partially addressed in `dae5b22` with heuristic/scaffolding implementations. Remaining work is documented in `ROADMAP.md`.
