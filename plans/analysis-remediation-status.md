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
- **F2 — cycle detection/reporting:** ⚠️ Core file-graph cycle detection exists (`findCycles`), but richer reporting/severity surfacing remains.
- **F3 — Vue/Svelte template dependency tracking:** ⏳ Not implemented.
- **F4 — config-file impact semantics:** ⏳ Not implemented.
- **F5 — breaking-change classification:** ⏳ Not implemented.
- **F6 — test coverage gap analysis in impact output:** ⏳ Not implemented.
- **F7 — cross-language monorepo dependency modeling:** ⏳ Not implemented.
- **F8 — true incremental SQLite graph updates:** ⏳ Not implemented.

## Notes

The correctness/performance issues in `ANALYSIS.md` are now fully addressed. Remaining entries are larger product features and should be planned as scoped roadmap work rather than bug-fix follow-ups.
