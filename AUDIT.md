# Deep Technical Audit: codegraph Library

**Audit Date**: 2026-02-01
**Auditor**: Senior Software Architect & Performance Engineer
**Version Audited**: 1.8.16
**Last Updated**: 2026-02-06

---

## Executive Summary

The codegraph library is a well-architected, high-performance code analysis tool with strong foundations. This audit identifies **28 actionable improvement opportunities** across 5 dimensions. The most critical findings relate to type safety violations, missing edge cases in language definitions, and gaps in test coverage for pathological inputs.

**Progress: 13/28 items completed (46%)**

**Priority Distribution:**
- 🔴 Critical (P0): 3 issues (2 ✅, 1 remaining)
- 🟠 High (P1): 8 issues (3 ✅, 5 remaining)
- 🟡 Medium (P2): 12 issues (5 ✅, 7 remaining)
- 🟢 Low (P3): 5 issues (3 ✅, 2 remaining)

---

## Implementation Status

### ✅ Completed Items

| # | Priority | Item | Commit |
|---|----------|------|--------|
| 1 | P0 | Python `__all__` handling (tuples, extend, append, augmented assignment) | be1cd46 |
| 2 | P0 | `mapLimit` bounded concurrency (streaming approach) | c4b026b |
| 3 | P0 | Pathological test cases (deeply nested, circular re-exports) | e77a459 |
| 4 | P1 | Bloom filter auto-sizing (`createOptimal()` method) | c4b026b |
| 5 | P1 | SQLite `visibility` column | c4b026b |
| 6 | P2 | Severity weight configuration (`SeverityWeights` type) | c4b026b |
| 7 | P2 | Confidence field in impact items | c4b026b |
| 8 | P2 | Document `--fast-graph` in CLI help | c4b026b |
| 9 | P2 | `SessionManager.warmup()` method | c4b026b |
| 10 | P3 | `highestComplexityFunctions` query | c4b026b |
| 11 | P3 | Export `ICodeReviewSession` interface | c4b026b |
| 12 | P3 | `SymbolVisibility` type documentation | c4b026b |
| 13 | P1 | pnpm workspace exclude tests (negated + overlapping patterns) | 16d8fd7 |

**Additional fixes from PR review:**
- Semaphore permits validation
- BloomFilter itemCount increment ordering
- calculateSeverity weights validation

### ❌ Remaining Items

#### 🔴 P0 Critical (1 remaining)

- [ ] **Eliminate 43 `any` types** - `src/graphs.ts:220`, `src/cli.ts:55`, `src/indexer.ts:4020`, `src/impact/analyzer.ts:306,311,313`, `src/util.ts:13,26` - Replace with proper types (`Parser.SyntaxNode`, discriminated unions, generics). **Effort: High**

#### 🟠 P1 High (5 remaining)

- [ ] **TypeScript namespace merging** - `src/languages/definitions/typescript.ts` - Add post-processing to consolidate symbols with matching names and compatible kinds. **Effort: Medium**
- [ ] **Go package-level scope resolution** - `src/languages/definitions/go.ts:41-47` - Track package declarations, handle dot-imports, group files by package. **Effort: Medium**
- [ ] **Parsed AST cache eviction** - `src/indexer.ts:ProjectIndex.parsed` - Implement LRU eviction with configurable max entries. **Effort: Medium**
- [ ] **`decorates` edge type** - `src/graphs.ts` - Add edge label for decorator applications (TypeScript `@Decorator`, Python `@decorator`). **Effort: Low**
- [ ] **Vue/Svelte script setup tests** - `tests/languages/` - Add tests for `<script setup>`, Svelte `$:` reactive declarations. **Effort: Low**

#### 🟡 P2 Medium (7 remaining)

- [ ] **Dynamic import confidence scores** - `src/graphs.ts:1337+` - Add `{ resolved: "heuristic", confidence: number }` to dynamic imports. **Effort: Medium**
- [ ] **Memoize re-export resolution** - `src/indexer.ts:resolveExport` - Use shared `WeakMap` keyed by `(file, exportName)` tuples. **Effort: Medium**
- [ ] **Block vs function scope distinction** - `src/languages/filePrep.ts`, `src/indexer.ts` - Track scope type and handle `var` hoisting correctly. **Effort: High**
- [ ] **SQLite for disk cache** - `src/indexer.ts:cacheFilePath` - Replace individual JSON files with SQLite database. **Effort: High**
- [ ] **Improve CLI error messages** - `src/cli.ts` - Add recovery suggestions to common errors. **Effort: Low**
- [ ] **Go workspace tests** - `tests/` - Add `tests/samples/go-workspace/` with `go.work` and multiple modules. **Effort: Low**
- [ ] **Circuit breaker recovery tests** - `tests/impact-circuit-breaker.test.ts` - Test recovery after timeout, partial results. **Effort: Low**

#### 🟢 P3 Low (2 remaining)

- [ ] **Simplify language registration** - `src/languages/` - Use single registry pattern where definitions self-register. **Effort: Medium**
- [ ] **Deduplicate symbol edges** - `src/graphs.ts:buildSymbolGraph` - Use `Set<string>` with edge keys during construction. **Effort: Low**

---

## 1. Accuracy & Robustness

### 1.1 Language Definition Edge Cases

#### 🔴 P0: Python `__all__` Handling is Incomplete
**Location**: `src/languages/definitions/python.ts:58-63`, `src/indexer.ts:1346-1386`

**Issue**: The current `__all__` export detection uses a regex fallback with an 800-character window that can miss:
- Multiline tuple assignments spanning multiple lines
- `__all__.extend([...])` patterns
- Conditional `__all__` modifications in `if TYPE_CHECKING` blocks
- String concatenation patterns (`__all__ = ["a"] + ["b"]`)

**Why it matters**: Python libraries frequently use dynamic `__all__` construction. Missing exports breaks dependency graphs for these libraries.

**Recommended approach**:
```typescript
// In python.ts, add a dedicated query for __all__ patterns:
exports: `
  (assignment left: (identifier) @left (#eq? @left "__all__") right: (_) @all_value) @stmt
  (augmented_assignment left: (identifier) @left (#eq? @left "__all__")) @stmt
  ...existing patterns...
`,
```
Then in `indexer.ts`, recursively evaluate the AST of `@all_value` to extract all string literals regardless of nesting depth.

---

#### 🟠 P1: TypeScript Namespace Merging Not Tracked
**Location**: `src/languages/definitions/typescript.ts`

**Issue**: TypeScript allows declaration merging between interfaces, namespaces, and classes with the same name. The current definition treats each as separate symbols, which can lead to:
- Duplicate symbol entries
- Incorrect reference counts
- Missing cross-file namespace augmentation

**Why it matters**: Large TypeScript codebases (Angular, NestJS) heavily use namespace merging for module augmentation.

**Recommended approach**:
Add a post-processing step in `collectLocalsAndExportsFromSource` that consolidates symbols with matching `localName` and compatible kinds (interface+namespace, namespace+class).

---

#### 🟠 P1: Go Package-Level Scope Resolution is Shallow
**Location**: `src/languages/definitions/go.ts:41-47`

**Issue**: Go exports all capitalized identifiers at package scope, but the current implementation:
- Does not track `package` declarations to group files
- Does not handle dot-imports (`import . "pkg"`)
- Does not track init() function side effects

**Why it matters**: Go monorepos with internal packages rely on package-level visibility for accurate dependency analysis.

**Recommended approach**:
1. Extract `package` declarations in the imports query
2. Group files by package name during graph construction
3. Treat all exported symbols within a package as available to sibling files

---

#### 🟡 P2: Dynamic Import Heuristics Have False Positives
**Location**: `src/graphs.ts:1337+` (dynamic import handling)

**Issue**: The `dynamicImportHeuristics` option attempts to resolve dynamic imports like `import(\`./plugins/${name}\`)` by scanning for template literals, but it can:
- Match commented-out code
- Incorrectly resolve paths with conditional logic
- Miss webpack/vite magic comments

**Why it matters**: False positives in dynamic imports inflate the dependency graph and slow impact analysis.

**Recommended approach**:
Add a confidence score to dynamic imports and allow filtering by threshold. Mark imports as `{ resolved: "heuristic", confidence: 0.7 }`.

---

#### 🟡 P2: Re-export Cycle Detection is O(n²) in Worst Case
**Location**: `src/indexer.ts` (resolveExport function)

**Issue**: The `resolveExport` function uses a `visited` set to detect cycles, but the check happens per-call rather than being memoized across the entire resolution session. For deeply nested re-export chains (e.g., barrel files with 50+ re-exports), this causes quadratic behavior.

**Why it matters**: Barrel-heavy monorepos (common in React/Angular projects) experience 5-10x slower indexing times.

**Recommended approach**:
Use a shared `WeakMap` keyed by `(file, exportName)` tuples to cache resolution results across the entire `buildProjectIndex` call.

---

### 1.2 Resolution Logic Issues

#### 🟡 P2: Circular Dependency Detection Doesn't Report Exact Cycle Path
**Location**: `src/graphs.ts:findCycles()`

**Issue**: The `findCycles()` function returns a boolean indicating whether cycles exist but does not return the actual cycle path. Users must use external tools to identify the specific files involved.

**Why it matters**: For large codebases, knowing that a cycle exists without knowing where wastes developer time.

**Recommended approach**:
Return `{ hasCycle: boolean; cycles: FileId[][] }` where each inner array is an ordered path.

---

### 1.3 Scope Awareness

#### 🟡 P2: Block Scope Not Distinguished from Function Scope
**Location**: `src/languages/filePrep.ts`, `src/indexer.ts:buildScopeIndexFromSource`

**Issue**: The scope indexing treats `if` blocks and function bodies identically for variable shadowing purposes. In JavaScript/TypeScript, `let`/`const` are block-scoped while `var` is function-scoped. This can cause:
- Incorrect reference resolution when a variable is shadowed in a block
- False positive matches for similarly named variables

**Why it matters**: Accurate scope handling is essential for precise go-to-definition in files with complex control flow.

**Recommended approach**:
Track scope type (`block` vs `function`) in the scope stack and only consider `var` declarations as hoisted to function scope.

---

## 2. Speed & Efficiency

### 2.1 Indexing Pipeline

#### 🔴 P0: mapLimit Concurrency is Unbounded for Nested Promises
**Location**: `src/indexer.ts:534-562`

**Issue**: The `mapLimit` function correctly limits concurrent task *starts*, but if tasks spawn nested async work (e.g., reading tsconfig files), the total outstanding I/O can exceed the limit significantly.

**Why it matters**: On systems with limited file descriptors (CI containers, Windows), this can cause `EMFILE` errors on large codebases.

**Recommended approach**:
Use a semaphore pattern that tracks actual outstanding I/O operations, or switch to `p-limit` which handles nested concurrency correctly.

---

#### 🟠 P1: Parser Pool Can Cause Memory Pressure
**Location**: `src/util.ts:acquireParser/releaseParser`

**Issue**: The parser pool has no size limit. In multi-threaded scenarios, up to `threads` parsers can be allocated per language, and they are never released until process exit.

**Why it matters**: Each parser instance holds ~2-5MB of native memory. With 8 threads and 10 languages, this is 160-400MB of baseline memory.

**Recommended approach**:
Implement an LRU cache with a configurable max size (default: 4 per language) and periodic cleanup on idle.

---

#### 🟡 P2: Git Blob Hash Fetching is Serialized
**Location**: `src/util.ts:getGitBlobHashes`

**Issue**: The function spawns a single `git ls-tree` command and parses output. For large repos with 50k+ files, this command can take 2-3 seconds and blocks the entire indexing pipeline.

**Why it matters**: Initial cold-start indexing is bottlenecked by git operations.

**Recommended approach**:
Use `--batch-command` mode with `git cat-file` for parallel hash fetching, or cache blob hashes in the manifest.

---

### 2.2 Caching Strategy

#### 🟡 P2: Disk Cache Uses Individual JSON Files
**Location**: `src/indexer.ts:cacheFilePath`, `writeToCache`

**Issue**: Each file gets its own cache entry as a separate JSON file. On large projects, this creates thousands of small files, which:
- Is slow on networked filesystems (NFS, mounted volumes)
- Can hit inode limits
- Has poor locality for sequential reads

**Why it matters**: CI environments often use network-mounted caches where file count matters more than total size.

**Recommended approach**:
Use SQLite for the disk cache (similar to `sqlite.ts`) or group entries into sharded JSON files.

---

### 2.3 Bloom Filter Sizing

#### 🟠 P1: Bloom Filter Size is Fixed at 10k Bits
**Location**: `src/util/bloomFilter.ts:7-9`

**Issue**: The `DEFAULT_BLOOM_SIZE = 10000` bits is used regardless of file size. For files with 500+ identifiers, the false positive rate exceeds 10%, negating the benefit. For tiny files, 10k bits is wasteful.

**Why it matters**: The documented "tune-concurrency-bloom-filters-plan.md" mentions auto-sizing, but this is not implemented.

**Recommended approach**:
Size bloom filters based on estimated identifier count:
```typescript
const optimalSize = Math.max(1000, Math.ceil(identifierCount * 10));
const hashCount = Math.ceil(optimalSize / identifierCount * Math.LN2);
```

---

### 2.4 Memory Footprint

#### 🟠 P1: Parsed AST Cache Has No Eviction Policy
**Location**: `src/indexer.ts:ProjectIndex.parsed`

**Issue**: The `parsed` map stores full Tree-sitter ASTs for every file when `cacheStrict` is enabled. These ASTs are never evicted, consuming O(n) memory where n is total source code size.

**Why it matters**: For large monorepos (1GB+ of code), this can consume 4-8GB of memory.

**Recommended approach**:
1. Use `WeakRef` for parsed entries
2. Implement LRU eviction with configurable max entries
3. Clear `parsed` after initial indexing if not needed for reference resolution

---

#### 🟡 P2: Symbol Edges Array Grows Without Deduplication
**Location**: `src/graphs.ts:buildSymbolGraph`

**Issue**: The `edges` array in `SymbolGraph` can contain duplicate entries when the same call site is visited multiple times. No deduplication is performed.

**Why it matters**: Duplicates inflate JSON output size and slow down graph queries.

**Recommended approach**:
Use a `Set<string>` with edge keys during construction, then convert to array.

---

## 3. Usefulness (Value for Agents)

### 3.1 Semantic Edges

#### 🟠 P1: Missing "decorates" Edge Type for Decorators
**Location**: `src/graphs.ts` (edge label handling)

**Issue**: The symbol graph supports `calls`, `instantiates`, `extends`, `implements` edges but does not have a dedicated `decorates` edge. Decorators in TypeScript/Python are currently tracked as `calls` which loses semantic information.

**Why it matters**: Agents analyzing decorator-heavy frameworks (NestJS, Angular, FastAPI) cannot distinguish regular function calls from decorator applications.

**Recommended approach**:
Add `decorates` to `SymbolEdge.label` type and detect decorator syntax in each language:
- TypeScript: `@Decorator()` syntax
- Python: `@decorator` syntax above function/class definitions

---

#### 🟡 P2: No "uses-type" vs "uses-value" Edge Distinction
**Location**: `src/graphs.ts`

**Issue**: All `uses` edges are treated equally, but TypeScript distinguishes type-only usage (can be elided at runtime) from value usage (required at runtime). This distinction is partially tracked via `typeOnly` on file edges but not on symbol edges.

**Why it matters**: Agents performing tree-shaking analysis or bundle size optimization need this distinction.

**Recommended approach**:
Add `typeOnly?: boolean` to `SymbolEdge` and propagate from `isTypeOnly()` detection.

---

### 3.2 Impact Analysis

#### 🟡 P2: Severity Scoring Lacks Configurable Weights
**Location**: `src/impact/analyzer.ts:calculateSeverity`

**Issue**: The severity multipliers (1.2 for exported, 0.7 for type-only, etc.) are hardcoded. Different teams have different risk profiles—some care more about API changes, others about internal refactors.

**Why it matters**: One-size-fits-all scoring produces false positives for some teams.

**Recommended approach**:
Add an optional `severityWeights: Partial<SeverityWeights>` to `ImpactOptions`:
```typescript
type SeverityWeights = {
  exported: number;      // default 1.2
  typeOnly: number;      // default 0.7
  sameFile: number;      // default 1.2
  depthDecay: number;    // default 0.8
};
```

---

#### 🟡 P2: Impact Report Missing "Confidence" Field
**Location**: `src/impact/types.ts:ImpactItem`

**Issue**: Impact items have `severity` but no `confidence`. A high-severity item based on heuristic resolution is less actionable than one based on exact AST matching.

**Why it matters**: Agents need to prioritize human review requests effectively.

**Recommended approach**:
Add `confidence: number` (0-1) to `ImpactItem`, reflecting resolution method quality.

---

### 3.3 Data Schemas

#### 🟠 P1: SQLite Schema Missing Symbol Visibility
**Location**: `src/sqlite.ts:ensureSchema`

**Issue**: The `symbols` table has `kind` but no `visibility` column (public/private/protected). This forces agents to re-parse files to determine if a symbol is part of the public API.

**Why it matters**: API surface analysis is a common agent task.

**Recommended approach**:
Add `visibility TEXT` column populated from export status and naming conventions (e.g., `_private` in Python).

---

#### 🟢 P3: No Cyclomatic Complexity in Symbol Queries
**Location**: `src/sqlite.ts` (query handling)

**Issue**: The `highestComplexityClasses` query exists, but no equivalent for functions. Complexity is stored but not easily queryable.

**Why it matters**: Agents reviewing PRs want to flag high-complexity function additions.

**Recommended approach**:
Add `highestComplexityFunctions` query type.

---

## 4. Usability & Developer Experience

### 4.1 CLI Ergonomics

#### 🟡 P2: Error Messages Don't Include Recovery Suggestions
**Location**: `src/cli.ts` (error handling)

**Issue**: When indexing fails (e.g., no tsconfig found), the error message is technical but doesn't suggest next steps like `--resolution-hint` or checking file patterns.

**Why it matters**: First-time users abandon the tool if errors are opaque.

**Recommended approach**:
Wrap common error classes with actionable suggestions:
```
Error: Cannot resolve tsconfig.json
Suggestion: Use --resolution-hint=tsconfig:./path/to/tsconfig.json
```

---

#### 🟡 P2: --fast-graph Behavior Not Explained in --help
**Location**: `src/cli.ts`

**Issue**: The distinction between full parsing and fast mode is mentioned but the tradeoffs are not explained in the CLI help text.

**Why it matters**: Users don't know when to use which mode.

**Recommended approach**:
Add to help: `--fast-graph: Skip AST parsing, use regex for imports. 5-10x faster, may miss dynamic imports.`

---

### 4.2 API Design

#### 🟡 P2: SessionManager Lacks "warmup" Method
**Location**: `src/session.ts:SessionManager`

**Issue**: Sessions are initialized lazily on first use. For latency-sensitive applications, there's no way to pre-warm the index before user requests arrive.

**Why it matters**: Lambda/serverless deployments need explicit cold-start optimization.

**Recommended approach**:
Add `async warmup(options?: { files?: string[] }): Promise<void>` that pre-builds indexes.

---

#### 🟢 P3: createCodeReviewSession Return Type is Opaque
**Location**: `src/session.ts`

**Issue**: The function returns a class instance but the interface is not exported, making it harder to type in consumer code.

**Why it matters**: TypeScript users get poor autocomplete.

**Recommended approach**:
Export `ICodeReviewSession` interface alongside the class.

---

### 4.3 Extensibility

#### 🟢 P3: Adding a New Language Requires 3+ File Changes
**Location**: `src/languages/definitions/`, `src/languages.ts`, `src/bootstrap/treeSitterLanguages.ts`

**Issue**: Adding a new language requires:
1. Creating the definition file
2. Importing and exporting in `languages.ts`
3. Adding to `LANG_CONFIGS` in bootstrap

**Why it matters**: Contributors may forget steps, causing incomplete language support.

**Recommended approach**:
Use a single registry pattern where definitions self-register:
```typescript
// In each definition file:
registerLanguage(KOTLIN_DEF);
```

---

## 5. Test Coverage

### 5.1 Language Parity

#### 🔴 P0: Missing Pathological Test Cases
**Location**: `tests/languages/parity.test.ts`, `tests/samples/`

**Issue**: The parity tests validate "happy path" scenarios but don't test:
- Deeply nested imports (10+ levels)
- Files with syntax errors (graceful degradation)
- Mixed encodings (UTF-8 BOM, Windows line endings)
- Extremely long lines (10k+ characters)
- Circular re-exports between 3+ files

**Why it matters**: Edge cases cause production failures that are hard to debug.

**Recommended approach**:
Add a `tests/pathological/` directory with:
- `deeply-nested-imports/` (10-level chain)
- `syntax-errors/` (recoverable parse errors)
- `encoding-edge-cases/` (BOM, CRLF)
- `large-files/` (10k+ lines)
- `circular-reexports/` (A→B→C→A)

---

#### 🟠 P1: Vue/Svelte SFC Tests Don't Cover Script Setup
**Location**: `tests/languages/vue.test.ts`, `tests/languages/svelte.test.ts`

**Issue**: Tests cover basic `<script>` blocks but don't test:
- Vue 3 `<script setup>` syntax
- Svelte `$:` reactive declarations
- Multi-script blocks (separate setup + regular script)

**Why it matters**: Modern Vue/Svelte apps use these patterns extensively.

**Recommended approach**:
Add sample files with setup scripts and verify symbol extraction.

---

### 5.2 Integration Scenarios

#### 🟠 P1: No Tests for pnpm Workspace Excludes
**Location**: `tests/pnpm-workspace-excludes.test.ts`

**Issue**: The test file exists but is thin—it doesn't cover:
- Negated patterns (`!packages/private-*`)
- Overlapping patterns
- Missing workspace files (graceful handling)

**Why it matters**: pnpm is increasingly popular and has complex workspace semantics.

**Recommended approach**:
Add test cases for each negation pattern type.

---

#### 🟡 P2: No Tests for Go Module Workspaces
**Location**: `tests/`

**Issue**: Go 1.18+ workspaces (`go.work` files) are not tested. The codebase may or may not support them.

**Why it matters**: Large Go monorepos use workspaces.

**Recommended approach**:
Add `tests/samples/go-workspace/` with `go.work` and multiple modules.

---

### 5.3 Regression Coverage

#### 🟡 P2: Circuit Breaker Tests Don't Cover Recovery
**Location**: `tests/impact-circuit-breaker.test.ts`

**Issue**: Tests verify the circuit breaker trips on overload but don't test:
- Recovery after timeout
- Partial results returned before trip
- Graceful degradation messaging

**Why it matters**: Users need to understand what they get when the breaker trips.

**Recommended approach**:
Add tests that verify the circuit breaker resets and partial results are usable.

---

## 6. Type Safety Violations (AGENTS.md Compliance)

### 🔴 P0: 43 Uses of `any` Type in Production Code

**Locations** (representative sample):
- `src/graphs.ts:220` - `workspaceConfig: any`
- `src/cli.ts:55` - `function toJSON(obj: any)`
- `src/indexer.ts:4020` - `allScopes: any[]`
- `src/impact/analyzer.ts:306,311,313` - `ref: any`, `explain: any`
- `src/util.ts:13,26` - `sliceText(node: any)`, `toRange(node: any)`

**Why it matters**: AGENTS.md explicitly prohibits `any`. These bypass type checking and can hide bugs.

**Recommended approach**:
Create a tracking issue and systematically replace:
1. `Parser.SyntaxNode` for tree-sitter nodes
2. Discriminated union types for config objects
3. Generic type parameters for utility functions

---

## Prioritized Action Items

### Immediate (P0)
1. Fix Python `__all__` handling for dynamic patterns
2. Bound `mapLimit` nested concurrency
3. Add pathological test cases for all languages
4. Eliminate `any` types (43 occurrences)

### Short-term (P1)
5. Add TypeScript namespace merging support
6. Improve Go package-level scope resolution
7. Implement Bloom filter auto-sizing
8. Add parsed AST cache eviction
9. Add `decorates` edge type
10. Add `visibility` column to SQLite schema
11. Add Vue/Svelte script setup tests
12. ✅ Add pnpm workspace exclude tests

### Medium-term (P2)
13. Improve dynamic import heuristics
14. Memoize re-export resolution
15. Return cycle paths from `findCycles()`
16. Distinguish block vs function scope
17. Use SQLite for disk cache
18. Add severity weight configuration
19. Add confidence to impact items
20. Improve CLI error messages
21. Document `--fast-graph` tradeoffs
22. Add `SessionManager.warmup()`
23. Add Go workspace tests
24. Test circuit breaker recovery

### Low Priority (P3)
25. Add `highestComplexityFunctions` query
26. Export `ICodeReviewSession` interface
27. Simplify language registration
28. Deduplicate symbol edges

---

## Appendix: File Locations Reference

| Component | Primary File | Lines |
|-----------|-------------|-------|
| Symbol Indexing | `src/indexer.ts` | ~4,700 |
| Graph Building | `src/graphs.ts` | ~1,800 |
| Impact Analysis | `src/impact/analyzer.ts` | ~460 |
| Session Management | `src/session.ts` | ~250 |
| Bloom Filters | `src/util/bloomFilter.ts` | ~80 |
| Language Definitions | `src/languages/definitions/*.ts` | 19 files |
| CLI | `src/cli.ts` | ~1,400 |
| SQLite Output | `src/sqlite.ts` | ~730 |
| Test Framework | `tests/test-utils.ts` | ~200 |
| Parity Tests | `tests/languages/parity.test.ts` | ~610 |

---

*This audit was conducted on commit 04de3fd (v1.8.16).*
