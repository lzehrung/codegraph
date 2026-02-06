# Opportunities for Improvement Report

## 1. Logic Accuracy & Robustness

### Fragile Regex-based Comment Stripping
**Severity:** High
**Status:** **Deferred**
**Location:** `src/util.ts` (`stripJsLikeComments`, `stripPythonCommentsAndStrings`)
**The Issue:**
The functions use regular expressions to strip comments and strings. This is known to be fragile and can be tricked by strings containing comment markers.
**Resolution:**
Deferred for future refactoring as it requires significant changes to the "fast mode" parsing strategy.

**Recommended Solution:**
Prefer parsing the source with `tree-sitter` (or another proper parser) to obtain a syntax tree. Traverse the syntax tree, and when searching for module specifiers, explicitly skip nodes that correspond to comments and string literals. Only fall back to regex-based stripping if the performance impact of a full parse is unacceptable, and in that case ensure the regexes are carefully designed not to match comment delimiters that appear inside strings. This avoids the common pitfalls of regex-based comment stripping, such as incorrectly handling URLs or nested constructs, and makes the module-specifier extraction logic more robust.

### Python Relative Import Resolution
**Severity:** Medium
**Status:** **Fixed**
**Location:** `src/graphs.ts`, `src/util.ts` (`resolvePythonModule`)
**The Issue:**
The logic relied on implicit behavior for `..` imports and did not correctly handle absolute imports in non-standard project structures.
**The Fix:**
Updated `resolvePythonModule` to explicitly walk directory trees for relative imports and check both package-relative and anchor-relative paths for absolute imports.

### Default Language Support
**Severity:** Medium
**Status:** **Fixed**
**Location:** `src/languages.ts` (`supportForFile`)
**The Issue:**
`supportForFile` defaulted to `TS_SUPPORT`, potentially causing parsing errors for binary or unknown files.
**The Fix:**
Removed default fallback. `supportForFile` now returns `undefined`. Callers (e.g., `parseFile`, `resolveGoPackageExport`) updated to handle `undefined` safely.

### Docstring Extraction Fragility
**Severity:** Low
**Status:** **Fixed**
**Location:** `src/indexer.ts` (`extractLeadingDocstring`)
**The Issue:**
Line-by-line backward scanning was fragile.
**The Fix:**
Updated `collectLocalsAndExportsFromSource` to use Tree-sitter AST traversal (`previousNamedSibling`) to locate comments associated with declarations.

## 2. TypeScript Type Safety

### Implicit Any and Unsafe Casts
**Severity:** Medium
**Status:** **Fixed**
**Location:** `src/indexer.ts`, `src/util.ts`
**The Issue:**
Multiple usage of `any` and strict null check failures.
**The Fix:**
- Updated `ProjectIndex` to allow `undefined` in `parsed` map.
- Added strict null checks in `src/util.ts` for workspace package resolution.
- Used strict types in `loadJSON` and internal maps where possible (with intentional `any` bypasses for specific complex mapped types to satisfy compiler without breaking API).

### Circular Dynamic Import
**Severity:** Low
**Status:** **Fixed**
**Location:** `src/indexer.ts` (`buildProjectIndexFromExport`)
**The Issue:**
Dynamic import of self caused circular dependency issues.
**The Fix:**
Replaced with direct function call.

## 3. Test Coverage Gaps

### Missing Interface Locals in TypeScript
**Severity:** Low
**Status:** **Verified**
**Location:** `src/languages/definitions/typescript.ts`
**The Issue:**
Concern that interface/type declarations were missing from queries.
**Resolution:**
Verified that `interface_declaration` and `type_alias_declaration` are already present in the `locals` query. No changes needed.

## 4. Performance Optimizations

### Inefficient Concurrency Control
**Severity:** High
**Status:** **Fixed**
**Location:** `src/util.ts` (`mapLimit`)
**The Issue:**
Previous implementation or inline `Promise.all` created all promises upfront.
**The Fix:**
Implemented a robust `mapLimit` utility in `src/util.ts` using a streaming/recursive approach with proper error abort handling to prevent resource exhaustion (EMFILE).

### Synchronous File Reading
**Severity:** Medium
**Status:** **Deferred**
**Location:** `src/languages.ts` (`readFileSample`)
**The Issue:**
`fs.readFileSync` used for `.h` file disambiguation.
**Resolution:**
Deferred to avoid cascading async refactoring requirements across synchronous resolution paths (`resolveExport`, `resolveSymbolId`). The impact is minor as it only affects `.h` files.
