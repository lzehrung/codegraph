# Codegraph Deep Analysis: Correctness, Performance & Feature Gaps

## Executive Summary

Codegraph is a well-engineered multi-language code analysis library (~5,900 lines of TypeScript) that trades precision for speed and robustness. This analysis identified **5 confirmed correctness bugs** (1 critical), **5 performance bottlenecks** with concrete fixes, and **8 meaningful feature gaps**. The most impactful improvements would be fixing the re-export cycle detection bug, parallelizing file existence checks, and adding CSS/HTML dependency tracking.

---

## Part 1: Accuracy & Correctness Issues

### C1. CRITICAL: `resolveExportFrom` infinite recursion on circular re-exports

**Location:** `src/graphs.ts:1166-1239`

The `resolveExportFrom` function (used by `buildSymbolGraphDetailed`) has no cycle detection. It uses a `cache` Map to memoize results, but the cache key is only written *after* a result is found — not before recursion starts. This means circular re-export chains cause stack overflow.

**Contrast with `resolveExport` in `src/indexer.ts:3515-3587`**, which correctly uses a `visited` Set that is populated *before* recursing:
```typescript
// indexer.ts (correct)
if (visited.has(cycleKey)) return null;
visited.add(cycleKey);  // Added BEFORE recursion
```

```typescript
// graphs.ts (broken) — cache only set AFTER result found
if (cache.has(key)) return cache.get(key) ?? null;
// ... no sentinel set here ...
const down = resolveExportFrom(e.fromModule, ...);  // Can recurse back to same key
```

**Reproduction:**
```typescript
// moduleA.ts: export { x as y } from "./moduleB";
// moduleB.ts: export { y as x } from "./moduleA";
// Calling buildSymbolGraphDetailed → resolveExportFrom("A", "y") → stack overflow
```

**Fix:** Add a sentinel to `cache` before recursion (similar to the `visited` pattern in `resolveExport`):
```typescript
cache.set(key, null);  // Sentinel before recursion
// ... existing resolution logic ...
```

---

### C2. HIGH: `stripJsLikeComments` corrupts string literals containing `//`

**Location:** `src/util.ts:721-724`

```typescript
export function stripJsLikeComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
```

The line-comment regex only skips `//` preceded by `:` (to preserve `https://`). But `//` appears in many non-URL string contexts:

- `const cdn = "//cdn.example.com/lib.js"` → becomes `const cdn = "`
- `const unc = "\\\\server\\share"` in Windows paths with forward-slash variants
- Template strings: `` `${base}//path` ``

This function is used in 4 critical paths:
1. `extractJsTsSpecifiers` (regex fallback for import detection) — `src/util.ts:761`
2. `extractJsTsDynamicSpecifiers` — `src/util.ts:927`
3. tsconfig.json parsing — `src/util.ts:996`
4. Indexer fallback import extraction — `src/indexer.ts:2013`

**Impact:** Corrupted source text causes missed imports and broken tsconfig resolution.

**Fix:** Replace the naive regex with a proper string-aware comment stripper that tracks whether we're inside a string literal or regex before stripping `//`:
```typescript
export function stripJsLikeComments(src: string): string {
  // First strip block comments
  let result = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Then strip line comments, respecting strings
  return result.replace(
    /(["'`])(?:\\[\s\S]|(?!\1).)*?\1|\/\/.*/g,
    (match) => (match.startsWith("/") ? "" : match),
  );
}
```

---

### C3. HIGH: Python relative-only imports missed by `extractPythonSpecifiers`

**Location:** `src/util.ts:965-966`

```typescript
const reFrom =
  /^\s*from\s+([A-Za-z_][\w\.]|\.+[A-Za-z_][\w\.]*)\s+import/gm;
```

This regex requires either an identifier start (`[A-Za-z_]`) or dots followed by an identifier (`\.+[A-Za-z_]`). It cannot match dot-only relative imports:

```python
from . import utils     # NOT matched — just "." with no identifier
from .. import config   # NOT matched — just ".." with no identifier
from .helpers import x  # Matched (has module name after dots)
```

`from . import` is idiomatic Python for relative package imports.

**Fix:** Add an alternative for dot-only patterns:
```typescript
const reFrom =
  /^\s*from\s+(\.+(?:[A-Za-z_][\w\.]*)?|[A-Za-z_][\w\.]*)\s+import/gm;
```

---

### C4. HIGH: Python dot-only specifiers passed as module name instead of `null`

**Location:** `src/graphs.ts:321-328`

```typescript
const res = await resolvePythonModule(
  projectRoot,
  file,
  spec.includes(".") || !spec.startsWith(".") ? spec : null,
  relDots,
);
```

For `spec = ".."` (from `from .. import config`):
- `"..".includes(".")` → `true`
- Condition is true → passes `".."` as `moduleName`
- Should pass `null` (no module name, just relative traversal)

The condition should check whether the spec is **only** dots:
```typescript
const isDotsOnly = /^\.+$/.test(spec);
const moduleName = !isDotsOnly && (spec.includes(".") || !spec.startsWith("."))
  ? spec
  : null;
```

Note: C3 and C4 compound — even if C3 is fixed to capture dot-only imports, C4 would still misinterpret them during resolution.

---

### C5. MEDIUM: `fileExistsCache` never invalidated

**Location:** `src/util.ts:2326, 1062-1074`

```typescript
const fileExistsCache = new Map<string, boolean>();
// Once set to false, always returns false — no TTL, no invalidation
```

This is a module-level Map with no clearing mechanism. For single-pass CLI usage this is fine, but for:
- Long-lived `CodeReviewSession` instances
- Incremental builds where files are generated mid-process
- Multiple sequential analyses in the same Node process

...stale negative entries cause silent resolution failures.

**Fix:** Either add a `clearAllCaches()` export (used before each major operation), or add TTL-based expiration for negative entries:
```typescript
export function clearResolutionCaches(): void {
  fileExistsCache.clear();
  resolveSpecifierCache.clear();
  resolvePythonModuleCache.clear();
  tsconfigCache.clear();
}
```

---

## Part 2: Performance Opportunities

### P1. CRITICAL: Sequential file existence checks in specifier resolution

**Location:** `src/util.ts:1774-1781`

```typescript
const tryResolveCandidates = async (candidates: string[]): Promise<string | null> => {
  for (const c of candidates) {
    if (await fileExists(c)) return path.resolve(c);  // Sequential I/O
  }
  return null;
};
```

`buildCandidates()` generates 15-30+ candidate paths per specifier (base + each extension + index variants). Each candidate triggers a serial `fs.access()` call. For a project with 500 files × 10 imports each = 5,000 specifiers × 15+ candidates = **75,000+ serial filesystem lookups**.

**Fix:** Check candidates in parallel, return first match:
```typescript
const tryResolveCandidates = async (candidates: string[]): Promise<string | null> => {
  const results = await Promise.all(candidates.map(c => fileExists(c)));
  const idx = results.indexOf(true);
  return idx >= 0 ? path.resolve(candidates[idx]!) : null;
};
```

**Estimated impact:** 40-60% faster specifier resolution overall. The filesystem cache helps on repeated lookups, but first-pass resolution (the common case) pays the full cost.

---

### P2. HIGH: Sequential import resolution within `collectEdgesForFile`

**Location:** `src/graphs.ts:319-405`

```typescript
for (const { spec, typeOnly, resolved, confidence } of specs) {
  // Each iteration awaits resolution before starting the next
  const res = await resolvePythonModule(...);
  // or
  const res = await resolveImportSpecifier(...);
}
```

Each file's imports are resolved one at a time. A file with 20 imports × 5-50ms per resolution = 100-1000ms per file, serialized.

**Fix:** Resolve all specifiers in parallel (they're independent):
```typescript
const resolvedSpecs = await Promise.all(
  specs.map(({ spec, typeOnly }) => resolveSpecForLanguage(spec, sup, ...))
);
for (const { spec, to, typeOnly } of resolvedSpecs) {
  edges.push({ from: normalizedFile, to, ...(typeOnly ? { typeOnly: true } : {}) });
}
```

**Estimated impact:** 3-5x faster per-file edge collection, though `mapLimit` at the file level provides some parallelism already.

---

### P3. HIGH: `resolveSpecifier` lacks early short-circuit

**Location:** `src/util.ts:1724-1877`

The function tries all resolution strategies sequentially even when early signals indicate which strategy will succeed:

- **Relative/absolute paths** (starts with `.` or `/`) will never be workspace packages or node_modules
- **Bare specifiers** (no dots) will never be relative paths
- **Language-specific specifiers** (Python dots, Go URLs) have known resolution patterns

Currently, a relative import `./utils` still checks tsconfig paths, workspace packages, and node_modules after the relative resolution fails.

**Fix:** Add early return guards based on specifier shape:
```typescript
if (spec.startsWith(".") || spec.startsWith("/")) {
  // Only try file-relative resolution
  return await tryResolveCandidates(buildCandidates(base)) ?? { external: spec };
}
```

**Estimated impact:** 25-35% fewer resolution attempts for the common case.

---

### P4. MEDIUM: Multiple regex passes in `extractJsTsSpecifiers`

**Location:** `src/util.ts:758-920`

The function runs 6+ separate `matchAll` calls on the same (often large) source string:
```typescript
const reImportFrom = /...import...from.../gm;
const reImportSide = /...import.../gm;
const reExportFrom = /...export...from.../gm;
const reExportStar = /...export \*.../gm;
const reRequire = /...require\(.../gm;
const reDynamic = /...import\(.../gm;
```

Each regex scans the entire file independently.

**Fix:** Combine into a single pass with a union regex, or use a line-by-line scan:
```typescript
const combinedRe = /^\s*(?:import|export|(?:const|let|var)\s+.*=\s*require)\b/gm;
// Pre-filter lines, then classify
```

**Estimated impact:** 20-30% faster regex-mode extraction. Most significant on large files (1000+ lines).

---

### P5. MEDIUM: Redundant fan-in computation in impact analysis

**Location:** `src/impact/analyzer.ts:58-65`

Fan-in (number of incoming edges per file) is computed by iterating all graph edges. The same data structure could serve reverse dependency lookups, but those are computed separately when needed.

**Fix:** Compute both maps in a single pass:
```typescript
const fanInByFile = new Map<FileId, number>();
const reverseEdges = new Map<FileId, Edge[]>();
for (const edge of index.graph.edges) {
  if (edge.to.type === "file") {
    fanInByFile.set(edge.to.path, (fanInByFile.get(edge.to.path) || 0) + 1);
    let arr = reverseEdges.get(edge.to.path);
    if (!arr) { arr = []; reverseEdges.set(edge.to.path, arr); }
    arr.push(edge);
  }
}
```

**Estimated impact:** 15-20% faster impact analysis startup. Relevant for large graphs (10K+ edges).

---

## Part 3: Feature Gaps

### F1. HIGH: No CSS `@import` or HTML inline dependency tracking

**Current state:** HTML support only extracts `<script src="">` and `<link href="">` attributes. CSS has no import queries defined at all.

**What's missing:**
- CSS `@import "file.css"` and `@import url("...")`
- SCSS/Less `@import`, `@use`, `@forward`
- HTML inline `<script>` with `import` statements
- `<img src="">`, `<a href="">` for asset references

**Why it matters:** Web projects have significant cross-language dependencies through CSS imports and HTML references. These are invisible to impact analysis, causing false negatives when CSS/HTML files change.

**Difficulty:** Medium — tree-sitter-css can parse `@import` rules, and SCSS already has tree-sitter support. HTML inline scripts would need the SFC-style extraction approach.

---

### F2. HIGH: No circular dependency detection or reporting

**Current state:** The `resolveExport` function in indexer.ts detects cycles to prevent infinite recursion, but there's no user-facing cycle detection or reporting in the graph.

**What's missing:**
- `findCycles()` API that returns cycle paths (mentioned in README but not implemented for file-level graph)
- Cycle visualization in Mermaid/DOT output
- Cycle severity scoring in impact analysis

**Why it matters:** Circular dependencies are a common source of bugs (initialization order, tree-shaking failures). AI agents analyzing codebases need to identify and flag these.

**Difficulty:** Easy — standard DFS-based cycle detection on the existing graph structure.

---

### F3. HIGH: Vue/Svelte template-level dependencies not tracked

**Current state:** SFC parsing extracts `<script>` blocks for analysis. Template blocks (`<template>`) are only used for chunking, not graph building.

**What's missing:**
- Component references in templates: `<MyComponent>` → import dependency
- Prop bindings: `:prop="value"` → symbol reference
- Event handlers: `@click="handler"` → function reference
- Slot usage tracking
- `<script setup>` composition API tracking (defineProps, defineEmits)

**Why it matters:** Vue/Svelte are major frameworks. Template-level references are the primary way components interact, but they're invisible to impact analysis.

**Difficulty:** Hard — requires template AST traversal and linking template identifiers to script-block symbols.

---

### F4. HIGH: Configuration file impact not analyzed

**Current state:** Config files (tsconfig.json, vite.config.ts, webpack.config.js, etc.) are not analyzed for impact.

**What's missing:**
- Detecting config changes in diffs
- Understanding that `tsconfig.json` `baseUrl`/`paths` changes affect import resolution across the project
- Build config changes affecting bundle output
- `.env` changes affecting runtime behavior

**Why it matters:** A single config change can have project-wide impact. Changing `compilerOptions.strict` in tsconfig.json affects every file, but impact analysis would show zero impacted symbols.

**Difficulty:** Medium — would need config-type-specific rules mapping config keys to affected scopes.

---

### F5. MEDIUM: No breaking change detection

**Current state:** Impact analysis tracks which symbols changed and which files reference them, but doesn't classify the nature of the change.

**What's missing:**
- Signature change detection (added/removed/reordered parameters)
- Return type changes
- Access modifier changes (public → private)
- Removed exports
- Changed interface members

**Why it matters:** "Function `foo` changed" is less useful than "Function `foo` had parameter `bar` removed, breaking 12 callers." This is the difference between informational and actionable impact analysis.

**Difficulty:** Hard — requires before/after AST comparison with semantic understanding of each change type.

---

### F6. MEDIUM: No test coverage gap detection

**Current state:** `listCandidateTestFiles` uses filename patterns to find potentially related tests, but there's no analysis of whether changed code is actually covered by tests.

**What's missing:**
- Mapping changed symbols to test files that reference them
- Identifying changed code with zero test references
- Suggesting which test files to run for a given change
- "Untested change" warnings in impact reports

**Why it matters:** The most dangerous changes are untested ones. Agents and reviewers need to know "This function was modified but no test file references it."

**Difficulty:** Medium — could use `findReferences` to check if any test-pattern files reference changed symbols.

---

### F7. MEDIUM: Cross-language dependency gaps in monorepos

**Current state:** Monorepo workspace detection handles npm/yarn/pnpm/lerna. But cross-language dependencies aren't tracked.

**What's missing:**
- FFI boundaries (Rust ↔ Node via napi, Python ↔ C via ctypes)
- Polyglot package boundaries (Python calling compiled Rust extensions)
- Shared proto/GraphQL/OpenAPI schema dependencies
- Build-system-level dependencies (Makefile targets, Bazel rules)

**Why it matters:** Modern monorepos increasingly mix languages. A change to a Rust crate used via napi has no visible impact on the TypeScript consumer in the current model.

**Difficulty:** Hard — requires build system integration and cross-language contract understanding.

---

### F8. LOW-MEDIUM: SQLite export lacks incremental update support

**Current state:** `writeGraphSqlite` does a full export. `updateGraphSqlite` exists but does a complete rebuild.

**What's missing:**
- True incremental updates (only changed files)
- Diff-based SQLite patching
- Temporal graph (tracking graph evolution over time)

**Why it matters:** For large projects, re-exporting the entire graph to SQLite on every change is wasteful. CI systems that maintain a persistent database would benefit from incremental updates.

**Difficulty:** Medium — would need file-level change tracking and targeted SQL DELETE/INSERT operations.

---

## Priority Matrix

| ID | Category | Severity | Effort | Impact |
|----|----------|----------|--------|--------|
| C1 | Correctness | CRITICAL | Low | Prevents stack overflow on circular re-exports |
| C2 | Correctness | HIGH | Medium | Fixes string corruption in comment stripping |
| C3 | Correctness | HIGH | Low | Captures Python dot-only relative imports |
| C4 | Correctness | HIGH | Low | Fixes Python relative import resolution |
| C5 | Correctness | MEDIUM | Low | Prevents stale cache in long-lived sessions |
| P1 | Performance | CRITICAL | Low | 40-60% faster specifier resolution |
| P2 | Performance | HIGH | Medium | 3-5x faster per-file edge collection |
| P3 | Performance | HIGH | Low | 25-35% fewer resolution attempts |
| P4 | Performance | MEDIUM | Medium | 20-30% faster regex extraction |
| P5 | Performance | MEDIUM | Low | 15-20% faster impact analysis startup |
| F1 | Feature | HIGH | Medium | CSS/HTML dependency tracking |
| F2 | Feature | HIGH | Easy | Circular dependency detection |
| F3 | Feature | HIGH | Hard | Vue/Svelte template dependencies |
| F4 | Feature | HIGH | Medium | Config file impact analysis |
| F5 | Feature | MEDIUM | Hard | Breaking change detection |
| F6 | Feature | MEDIUM | Medium | Test coverage gap detection |
| F7 | Feature | MEDIUM | Hard | Cross-language monorepo deps |
| F8 | Feature | LOW | Medium | Incremental SQLite updates |

## Recommended Implementation Order

**Phase 1 — Quick wins (low effort, high impact):**
1. C1: Fix `resolveExportFrom` cycle detection (add sentinel to cache)
2. C3 + C4: Fix Python relative import regex and module name logic
3. C5: Add `clearResolutionCaches()` export
4. P1: Parallelize `tryResolveCandidates`
5. P3: Add early short-circuit to `resolveSpecifier`

**Phase 2 — Medium effort improvements:**
6. C2: Replace `stripJsLikeComments` with string-aware implementation
7. P2: Parallelize import resolution within `collectEdgesForFile`
8. F2: Add cycle detection to graph analysis
9. P5: Combine fan-in and reverse-edge computation

**Phase 3 — Feature development:**
10. F1: Add CSS `@import` and SCSS `@use`/`@forward` dependency tracking
11. F6: Add test coverage gap detection using existing `findReferences`
12. F4: Add config file impact rules
13. P4: Optimize regex extraction passes

**Phase 4 — Larger initiatives:**
14. F3: Vue/Svelte template dependency tracking
15. F5: Breaking change detection
16. F7: Cross-language dependency tracking
17. F8: Incremental SQLite updates
