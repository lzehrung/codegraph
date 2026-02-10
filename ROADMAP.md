# Codegraph Feature Roadmap

Feature gaps identified during deep analysis, organized by priority and effort.

---

## Tier 1: High Value / Moderate Effort

### CSS/SCSS/Less `@import` dependency tracking

**Current state:** CSS, SCSS, and Less files are supported for chunking only — no import queries are defined.

**Gap:**
- CSS `@import "file.css"` and `@import url("...")`
- SCSS `@use`, `@forward`, `@import`
- Less `@import`
- HTML `<link rel="stylesheet" href="...">` already handled, but inline `<style>` with `@import` is not

**Why it matters:** Web projects have significant dependencies through stylesheets. These are invisible to impact analysis — changing a shared CSS variable file shows zero impacted consumers.

**Approach:** Tree-sitter-css and tree-sitter-scss can parse `@import`/`@use` rules. Add graph queries to the existing CSS/SCSS language definitions following the same pattern as JS/TS import queries.

---

### Configuration file impact analysis

**Current state:** Config files (tsconfig.json, vite.config.ts, etc.) are not analyzed for impact.

**Gap:**
- tsconfig.json `baseUrl`/`paths` changes affect import resolution project-wide
- Build config changes (webpack, vite) affect bundle output
- Linter configs affect rule enforcement
- `.env` changes affect runtime behavior

**Why it matters:** A single config change can have project-wide impact, but impact analysis shows zero impacted symbols. This is a significant false-negative risk for code review.

**Approach:** Define config-type-specific rules that map known config keys to impact scopes (e.g., `compilerOptions.strict` → all TS files, `paths` → all files with bare-specifier imports).

---

### Test coverage gap detection

**Current state:** `listCandidateTestFiles` uses filename patterns to find potentially related tests, but there's no analysis of whether changed code is actually exercised by tests.

**Gap:**
- Map changed symbols to test files that import/reference them
- Flag changed symbols with zero test references as "untested changes"
- Suggest which test files to run for a given diff

**Why it matters:** The most dangerous changes are untested ones. Agents and reviewers need to know "This function was modified but no test file references it."

**Approach:** Use existing `findReferences` to check if any file matching test patterns references each changed symbol. Integrate into impact report as an "untested changes" section.

---

## Tier 2: High Value / High Effort

### Vue/Svelte template-level dependencies

**Current state:** SFC parsing extracts `<script>` blocks for analysis. Template blocks are used only for chunking.

**Gap:**
- Component references in templates: `<MyComponent>` → import dependency
- Prop bindings: `:prop="value"` → symbol reference
- Event handlers: `@click="handler"` → function reference
- `<script setup>` defineProps/defineEmits tracking

**Why it matters:** Template-level references are the primary interaction surface for Vue/Svelte components, but they're completely invisible to impact analysis.

**Approach:** Parse template AST, extract identifiers, and link them to script-block symbols. Would need template-specific tree-sitter queries and a mapping layer between template and script scopes.

---

### Breaking change detection

**Current state:** Impact analysis tracks which symbols changed and which files reference them, but doesn't classify what changed.

**Gap:**
- Parameter addition/removal/reorder detection
- Return type changes
- Access modifier changes (public → private)
- Removed exports
- Interface member changes

**Why it matters:** "Function `foo` changed" is far less useful than "Function `foo` had parameter `bar` removed, breaking 12 callers."

**Approach:** Before/after AST comparison with per-language semantic understanding of what constitutes a breaking change. Would need a `SymbolSignature` type and diffing logic.

---

## Tier 3: Specialized / Exploratory

### Cross-language dependency tracking in monorepos

**Current state:** Monorepo workspace detection handles npm/yarn/pnpm/lerna. Cross-language boundaries are opaque.

**Gap:**
- FFI boundaries (Rust ↔ Node via napi, Python ↔ C via ctypes)
- Shared schema dependencies (protobuf, GraphQL, OpenAPI)
- Build-system-level dependencies (Makefile targets, Bazel rules)

**Why it matters:** Modern monorepos increasingly mix languages. A Rust crate change has no visible impact on its napi TypeScript consumer.

**Approach:** Build-system config parsing (Cargo.toml napi references, pyproject.toml extension modules), shared schema file detection, and cross-language edge injection.

---

### Incremental SQLite export

**Current state:** `writeGraphSqlite` does a full export; `updateGraphSqlite` does a complete rebuild.

**Gap:**
- True incremental updates (only changed files)
- Temporal graph tracking (evolution over time)

**Why it matters:** For CI systems maintaining a persistent database, full re-export is wasteful on large projects.

**Approach:** Track file-level content hashes in the database, DELETE/INSERT only rows for changed files.
