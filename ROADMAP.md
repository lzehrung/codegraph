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

**Done:** `collectUntestedChangeSuggestions` checks each changed symbol's references against test files. Symbols with no test-file references produce `kind: "untestedChange"` suggestions with candidate test file names.

**Remaining:**
- Coverage-aware ranking tied to actual executed test coverage data (lcov/istanbul)
- Confidence calibration (currently all "medium" — could weight by symbol kind, export status, fan-in)
- Integration with test runner output to suggest specific test commands to run

**Approach:** Accept optional coverage data (lcov paths) and cross-reference with changed symbol ranges for precise covered/uncovered classification.

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

**Done:** Heuristic suggestions when exported symbols overlap removed lines or when modules with exports contain removals. Produces `kind: "breakingChange"` suggestions with "medium"/"low" confidence.

**Remaining:**
- Structural before/after API signature diffing (parameter count/types, return types)
- Semantic compatibility checks (narrowing vs. widening changes)
- Renamed/moved symbol detection (not just removed)
- Per-language rules (e.g., Python `*args` changes, Go interface additions, TS union narrowing)

**Approach:** Capture symbol signatures (parameter list, return annotation) in `SymbolDef`, diff against the previous version from the base branch's index, classify changes as breaking/non-breaking per language rules.

---

## Tier 3: Specialized / Exploratory

### F2. Cycle detection enhancements

**Done:** `findCycles()` (Tarjan's SCC) already existed. #54 added cycle summaries to impact reports with severity (`high`/`medium`) and flags for changed/impacted-file involvement.

**Remaining:**
- Entry edge details per cycle (which specific imports form the cycle)
- SCC-level prioritization (rank cycles by size, fan-in, or involvement in changed code)
- Automated remediation hints (suggest which edge to break based on dependency direction)

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

**Done:** SQLite updates are changed-file scoped for nodes/edges.

**Remaining:**
- Truly incremental parse+graph+persist pipeline without full in-memory graph materialization
- Temporal graph tracking (store snapshots over time for evolution analysis)
- Efficient diff-based patching for CI pipelines that maintain persistent databases
