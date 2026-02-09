# ANALYSIS Remediation Status

This tracks the items from `ANALYSIS.md` and their current disposition.

## Correctness

- **C1 — `resolveExportFrom` cycle safety:** ✅ Completed.
  - Added sentinel caching before recursive re-export descent to avoid infinite recursion.
- **C2 — JS-like comment stripping corrupting literals:** ✅ Completed.
  - Replaced naive regex stripping with a string-aware scanner preserving literals/templates.
- **C3 — Python dot-only relative import extraction:** ✅ Completed.
  - Updated `extractPythonSpecifiers` regex to capture `from . import ...` / `from .. import ...`.
- **C4 — Python dot-only resolution moduleName handling:** ✅ Completed.
  - Dot-only specs are now passed as `moduleName = null` with explicit dot count.
- **C5 — stale module-level file existence cache:** ✅ Completed.
  - Added `clearResolutionCaches()` and exported it for explicit cache invalidation.

## Performance

- **P1 — sequential candidate existence checks:** ✅ Completed.
  - Candidate checks now run via `Promise.all`.
- **P2 — sequential per-file specifier resolution:** ✅ Completed.
  - Per-file specifier resolution in `collectEdgesForFile` now runs concurrently.
- **P3 — additional strategy short-circuiting in `resolveSpecifier`:** ✅ Completed.
  - Existing relative/absolute short-circuit retained.
  - Added URL/scheme fast external short-circuit.
  - Added Windows absolute-path handling to avoid false external classification.
  - Reduced path-like fallback attempts for simple package names.
- **P4 — multiple regex passes in JS/TS fallback extraction:** ✅ Completed.
  - Consolidated to a single combined regex pass.
- **P5 — fan-in and reverse-dep redundant passes in impact analysis:** ✅ Completed.
  - Built both maps in one pass and reused them across phases.

## Feature gaps

- **F1 — richer CSS/HTML dependency tracking:** ⚠️ Partially addressed.
  - Existing CSS/SCSS import tracking is in place.
  - HTML graph tracking now includes `script[src]`, inline `<script>` imports, `link[href]`, `a[href]`, and `img[src]`.
  - Remaining gap: broader HTML asset semantics beyond the currently covered tags.
- **F2 — cycle detection/reporting:** ⚠️ Partially addressed.
  - Added cycle summaries (`cycles`) to impact reports with severity (`high`/`medium`) and flags for changed/impacted-file involvement.
  - Remaining gap: deeper cycle explainability (entry edge details, SCC-level prioritization, automated remediation hints).
- **F3 — Vue/Svelte template dependency tracking:** ⚠️ Partially addressed.
  - Added HTML-like attribute/import fallback extraction for Vue/Svelte source in graph collection, including template-local asset references and inline-script imports.
  - Remaining gap: full template-aware semantic extraction for framework directives and non-HTML idioms.
- **F4 — config-file impact semantics:** ⚠️ Partially addressed.
  - Added semantic config-impact detail classification for key config families (`package.json`, TS/JS config, `.env`) instead of one generic message.
  - Remaining gap: precise key-level blast-radius mapping per tool ecosystem.
- **F5 — breaking-change classification:** ⚠️ Partially addressed.
  - Added heuristic breaking-change suggestions when exported symbols overlap removed lines or when exports exist in files with removals.
  - Remaining gap: structural before/after API signature diffing and typed compatibility checks.
- **F6 — test coverage gap analysis in impact output:** ⚠️ Partially addressed.
  - Added untested-change suggestions when changed symbols have no discovered references in test files, with candidate-test hints.
  - Remaining gap: coverage-aware ranking tied to actual executed tests/coverage data.
- **F7 — cross-language monorepo dependency modeling:** ⚠️ Partially addressed.
  - Added workspace manifest dependency edges (`package.json` -> dependent workspace `package.json`) so cross-package relationships are represented even when languages differ.
  - Remaining gap: deeper semantics for non-Node manifests and language-specific package graphs (pip/poetry, Maven/Gradle, Cargo, etc.).
- **F8 — true incremental SQLite graph updates:** ⚠️ Partially addressed.
  - Current SQLite updates are changed-file scoped for nodes/edges but still depend on full in-memory graph builds before persistence.
  - Remaining gap: truly incremental parse+graph+persist pipeline without full graph materialization.

## Notes

The correctness/performance issues in `ANALYSIS.md` are now fully addressed. Remaining entries are larger product features and should be planned as scoped roadmap work rather than bug-fix follow-ups.
