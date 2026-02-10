# Codegraph Feature Roadmap

Remaining feature work after the initial analysis and #54 remediation. Each item was partially addressed with heuristic/scaffolding implementations — this documents what exists and what remains.

---

## Tier 1: High Value / Moderate Effort

### F4. Configuration file impact analysis

**Done:** Semantic config-impact suggestions classify key config families (`package.json` scripts/deps, tsconfig/jsconfig, `.env`) with per-family detail messages and confidence levels. Integrated into impact reports via `ImpactSuggestion` with `kind: "configImpact"`.

**Remaining:**
- Precise key-level blast-radius mapping (e.g., `tsconfig paths` change → list which files use affected path aliases)
- Build tool configs (vite, webpack, rollup, esbuild) — matched by regex but lack semantic classification
- Monorepo tool configs (turbo.json, nx.json) — detected but not analyzed for cross-package impact

**Approach:** For tsconfig specifically, cross-reference `paths` keys against `resolveSpecifier` cache to identify which files would be affected. For build tools, parse the config AST to identify entry points and output targets.

---

### F6. Test coverage gap detection

**Done:** `collectUntestedChangeSuggestions` checks each changed symbol's references against test files, accepts optional LCOV files, and ranks confidence using covered vs uncovered changed lines. Suggestions now include candidate test files and a concrete test command hint.

**Remaining:**
- Coverage ingestion beyond LCOV (for example Istanbul JSON)
- Confidence calibration using symbol kind, export status, and fan-in in addition to coverage
- Optional direct integration with test runner output for repository-specific command templates

**Approach:** Extend current LCOV-based range matching to additional coverage formats and richer repository-aware ranking signals.

---

## Tier 2: High Value / High Effort

### F3. Vue/Svelte template-level dependencies

**Done:** HTML-like attribute/import fallback extraction for Vue/Svelte source, including template-local asset references and inline-script imports.

**Remaining:**
- Component references in templates: `<MyComponent>` → link to imported component definition
- Directive bindings: `:prop="expr"`, `@event="handler"` → link to script-block symbols
- `<script setup>` composition API: `defineProps`, `defineEmits`, `defineSlots` macro tracking
- Slot usage tracking across parent/child component boundaries
- Dynamic component resolution: `<component :is="name">`

**Approach:** Parse template AST to extract identifiers from bindings/directives, then resolve them against the script block's local symbol table. Would require template-specific tree-sitter queries or a regex-based template identifier extractor.

---

### F5. Breaking change detection

**Done:** Heuristic suggestions still trigger on exported symbol removals, and additional signature-aware checks now detect exported function arity changes (high confidence) and rename/removal candidates from paired diff lines (medium confidence).

**Remaining:**
- Type-level API diffing (parameter/return type compatibility)
- Semantic compatibility checks (narrowing vs widening)
- Cross-file move detection and alias-preserving rename handling
- Per-language compatibility rules (Python, Go, TypeScript, etc)

**Approach:** Evolve from diff-line signature heuristics to AST-level before/after signature models per language, then run compatibility rulesets.

---

## Tier 3: Specialized / Exploratory

### F2. Cycle detection enhancements

**Done:** `findCycles()` (Tarjan's SCC) already existed. #54 added cycle summaries to impact reports with severity (`high`/`medium`) and flags for changed/impacted-file involvement. This is now extended with detailed cycle metadata: internal entry edges (`from` -> `to` + raw import), SCC prioritization (`priorityScore`, size, fan-in), and remediation hints that suggest a candidate edge to break.

**Remaining:**
- Improve remediation quality using symbol-level coupling (for example choose edge with weakest call density)
- Add optional CLI sorting modes (by file count vs fan-in vs changed-file relevance)

---

### F7. Cross-language monorepo dependency modeling

**Done:** Workspace manifest dependency edges (`package.json` → dependent workspace `package.json`) so cross-package relationships are represented.

**Remaining:**
- Non-Node manifest support (pip/poetry `pyproject.toml`, Maven/Gradle, Cargo.toml, Go workspace)
- FFI boundaries (napi-rs, ctypes, JNI)
- Shared schema dependencies (protobuf, GraphQL, OpenAPI definitions)
- Build-system-level dependency graphs (Bazel, Nx task dependencies)

---

### F8. Incremental SQLite graph updates

**Done:** SQLite updates are changed-file scoped for nodes/edges. Incremental updates now reconcile deleted files, remove stale symbol/file edges, and support CI-friendly incremental patching via `codegraph graph --git-base ... --sqlite ...` backed by `updateGraphSqlite({ fullGraphSync: true })`.

**Remaining:**
- Truly incremental parse+graph+persist pipeline without full in-memory graph materialization
- Temporal graph tracking (store snapshots over time for evolution analysis)
- Snapshot metadata/version tables for historical querying and retention policies
