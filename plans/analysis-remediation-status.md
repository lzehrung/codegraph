# ANALYSIS Remediation Status

Tracks the disposition of every item from the original `ANALYSIS.md`.

## Correctness — all resolved

| ID | Issue | Status |
|----|-------|--------|
| C1 | `resolveExportFrom` cycle safety | Fixed — sentinel cache before recursion (`graphs.ts:1259`) |
| C2 | JS comment stripping corrupting string literals | Fixed — character-level scanner replacing naive regex (`util.ts:724-795`) |
| C3 | Python dot-only relative import extraction | Fixed — regex updated (`util.ts:1039`) |
| C4 | Python dot-only resolution moduleName handling | Fixed — `isDotsOnly` guard (`graphs.ts:396-400`) |
| C5 | Stale module-level file existence cache | Fixed — `clearResolutionCaches()` export (`util.ts:2425-2431`) |

## Performance — all resolved

| ID | Issue | Status |
|----|-------|--------|
| P1 | Sequential candidate existence checks | Fixed — `Promise.all` parallelization (`util.ts:1850-1855`) |
| P2 | Sequential per-file specifier resolution | Fixed — concurrent resolution via `specs.map(async ...)` (`graphs.ts:390`) |
| P3 | `resolveSpecifier` lacks early short-circuit | **False positive** — early return already existed for relative/absolute paths. #54 added URL/scheme + Windows path guards. |
| P4 | Multiple regex passes in JS/TS extraction | Fixed — single combined regex pass (`util.ts:835-856`) |
| P5 | Redundant fan-in/reverse-dep computation | Fixed — single-pass `buildDependencyStats()` (`analyzer.ts:39-58`) |

## Feature gaps

| ID | Feature | Status | Detail |
|----|---------|--------|--------|
| F1 | CSS/HTML dependency tracking | **False positive** — CSS `@import`, SCSS `@use`/`@forward`, Less `@import` already existed. | #54 added HTML `a[href]`, `img[src]`, inline-script extraction. |
| F2 | Cycle detection/reporting | **False positive** — `findCycles()` (Tarjan's SCC) already existed. | #54 added cycle summaries in impact reports. |
| F3 | Vue/Svelte template deps | Partially addressed | HTML-like fallback extraction added. Remaining: component refs, directives, `<script setup>`. See ROADMAP.md. |
| F4 | Config file impact | Partially addressed | Semantic classification for package.json, tsconfig, .env. Remaining: key-level blast-radius. See ROADMAP.md. |
| F5 | Breaking change detection | Partially addressed | Heuristic suggestions for exported symbol removals. Remaining: structural signature diffing. See ROADMAP.md. |
| F6 | Test coverage gaps | Partially addressed | Untested-change suggestions via `findReferences`. Remaining: coverage-data integration. See ROADMAP.md. |
| F7 | Cross-language monorepo deps | Partially addressed | Workspace manifest edges. Remaining: non-Node manifests, FFI, schemas. See ROADMAP.md. |
| F8 | Incremental SQLite | Partially addressed | Changed-file scoped updates. Remaining: full incremental pipeline. See ROADMAP.md. |

## Summary

- **5/5 correctness bugs** were real and fixed
- **3/5 performance items** were real and fixed; 1 was a false positive (P3), 1 was real but already partially addressed (P3 additions in #54 were improvements beyond the false claim)
- **2/8 feature gaps** were false positives (F1, F2 — capabilities already existed)
- **6/8 feature gaps** were partially addressed with heuristic implementations; deeper work tracked in ROADMAP.md
