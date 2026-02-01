# Deep Technical Audit of `codegraph`

## Executive Summary
`codegraph` is a well-structured, lightweight library for code analysis. Its use of Tree-sitter provides robustness against syntax errors, and its architecture supports extensibility. However, scaling to large repositories (50k+ files) presents challenges, particularly regarding memory usage and I/O efficiency. This audit identifies critical improvements for scalability and specific language robustness issues.

## 1. Accuracy & Robustness

### Findings
- **Python `__all__` Handling:** The current implementation correctly handles `__all__ = ["list", "of", "strings"]`. However, it fails to capture:
  - Tuple assignments: `__all__ = ("foo", "bar")`
  - Appending: `__all__.append("foo")` (dynamic, hard to catch statically, but common).
  - Variable references: `__all__ = exported_symbols`
- **TypeScript Namespace Merging:** Multiple `namespace` declarations with the same name are treated as distinct local symbols. This can lead to incomplete resolution when a namespace is split across blocks or files.
- **Go Package Scope:** The library correctly identifies cross-file package members, leveraging the `supportsCrossModuleSymbols` flag.

### Recommendations
1.  **Enhance Python Exports:** Update Tree-sitter queries to capture tuple assignments for `__all__`.
2.  **Merge Namespaces:** Implement logic in the indexer to merge locals from identically named namespaces within the same scope.

## 2. Speed & Efficiency

### Findings
- **Critical Memory Leak:** The `ProjectIndex` structure retains a `parsed` map containing the full Tree-sitter `Tree` object and source code string for *every* indexed file. For a 50k file repository, this will exhaust the Node.js heap.
- **Concurrency Bottleneck:** The `mapLimit` function manages concurrency for I/O, but `tree-sitter` parsing is often synchronous (CPU-bound) on the main thread. This limits the benefits of "concurrency" to just I/O overlap.
- **Caching:** The disk cache and Bloom filters are effective for incremental builds and reference search.

### Recommendations
1.  **Lazy Parsing (High Priority):** Modify `ProjectIndex` to NOT store `parsed` trees by default. `ensureParsedContext` already handles on-demand re-parsing. This trades CPU (re-parsing on lookup) for massive memory savings.
2.  **Worker Threads:** For truly parallel indexing, move the parsing logic to `worker_threads`.

## 3. Usefulness

### Findings
- **Semantic Edges:** The graph correctly identifies `calls`, `instantiates`, `extends`, etc. The logic in `src/graphs.ts` is comprehensive for supported languages.
- **Impact Analysis:** The `analyzeImpact` function provides valuable context (severity scores, explanations).
- **Data Schemas:** The SQLite export and JSON outputs are well-structured for agent consumption.

### Recommendations
1.  **Type-Only Edge Distinction:** Ensure consumers can easily filter out `type-only` edges if they are only interested in runtime dependencies (the current `typeOnly` flag in `Edge` supports this).

## 4. Usability & DX

### Findings
- **API Design:** `SessionManager` and `createCodeReviewSession` provide a clean, high-level API for agents.
- **Extensibility:** Adding a new language is straightforward via the `LanguageDefinition` interface.
- **CLI:** The CLI is feature-rich but `npx codegraph chunk` could benefit from better documentation on token counting.

### Recommendations
1.  **Expose Memory Options:** Add `keepParsed` options to `SessionOptions` so users can choose between speed (memory-heavy) and scalability (memory-light).

## 5. Test Coverage

### Findings
- **Language Parity:** Most languages have basic tests.
- **Edge Cases:** Missing tests for:
  - Python `__all__` tuples.
  - TypeScript namespace merging.
  - Deeply nested re-exports in monorepos.

### Recommendations
1.  **Add Regression Tests:** Specifically for the identified edge cases in Python and TypeScript.
2.  **Scalability Test:** Add a test that generates a large number of dummy files to verify memory stability (optional but recommended).

## Prioritized Action Plan

1.  **Fix Memory Footprint:** Implement "Lazy Parsing" by making the storage of parsed trees in `ProjectIndex` optional (defaulting to off).
2.  **Fix Python `__all__`:** Update queries to support tuples.
3.  **Add Tests:** Cover the above fixes.
