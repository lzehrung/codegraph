# Code Review Follow-up Plan

Scope: `src/graphs`, `src/impact`, and `src/indexer`.

## Checklist

- [x] Thread `maxRefs` through impact reference lookup.
  - `src/impact/analyzer.ts` applies `maxRefs` after `findReferences()` returns, so hot symbols can still scan and contextualize more references than needed.
  - Suggested fix: pass `maxReferences` to `findReferences()` with enough headroom for test and ignore filtering, then keep the existing post-filter cap.
  - Tests: impact analysis with a hot symbol, ignored/test refs, and `refContext` enabled.

- [x] Reuse parsed context for namespace member reference lookup.
  - `src/indexer/navigation.ts` builds or retrieves scope for namespace imports, then `collectNamespaceMemberRefs()` reparses the same file with no cached context.
  - Suggested fix: pass parsed context, or a tree/source/sup tuple, into namespace member collection.
  - Tests: namespace reference lookup with `keepParsed` enabled and disabled.

- [x] Consolidate native and JS fallback import-binding conversion.
  - `src/indexer/imports.ts` duplicates capture-to-`ImportBinding` conversion and per-language heuristics across native and JS fallback branches.
  - Suggested fix: introduce a shared helper that accepts normalized captures and emits bindings.
  - Tests: parity coverage for Java, C#, Go, Rust, Kotlin, Swift, Zig, C, and C++ import binding extraction.

- [x] Share module specifier parsing between graph and index extraction.
  - `src/graphs/specifiers.ts` has its own parser path for Python, PHP, Kotlin, Rust, C#, JS/TS fallback, HTML-like, and stylesheet specifiers.
  - Suggested fix: factor common statement/specifier parsing below both graph specifiers and index import binding extraction.
  - Tests: graph/index parity tests for extracted raw specifiers and type-only behavior.

- [x] Deduplicate member-chain resolution in detailed symbol graph.
  - `src/graphs/symbol-graph-detailed.ts` contains two near-identical chain walkers for namespace/member usage.
  - Suggested fix: extract a shared chain resolver that accepts the emitting callback and label.
  - Tests: `membersOnly` and full detailed symbol graph cases for optional chaining, subscript/string keys, and namespace imports.

- [x] Review manifest/index build edge merging for duplicate handling cost.
  - `src/indexer/build-index.ts` only deduplicates workspace manifest edges through `appendUniqueGraphEdges`; per-file graph edges are appended directly.
  - Suggested fix: decide whether duplicate edges are expected from per-file collectors, and centralize edge key generation if deduplication is required.
  - Tests: duplicate import edges from mixed graph/index paths and workspace manifest edges.

- [x] Extract shared diff hunk utilities for impact workflows.
  - Hunk line parsing exists in `src/impact/map.ts`, `src/impact/suggestions.ts`, `src/impact/report.ts`, and `src/impact/report-suggestions.ts`.
  - Suggested fix: create a small shared module for changed-line collection, added/removed line text extraction, removed-line mapping, and new-file hunk ranges.
  - Tests: deletion-only hunks, mixed replacement hunks, EOF deletion, and report hunk range rendering.

- [x] Reuse graph adjacency helpers in impact context and test candidate discovery.
  - `src/impact/context.ts` rebuilds forward and reverse dependency maps locally instead of using `index.graphAdjacency` or `buildGraphAdjacency`.
  - Suggested fix: route file-subgraph and candidate-test traversal through existing graph adjacency helpers while preserving edge metadata where needed.
  - Tests: candidate test ranking and N-hop context traversal with duplicate and type-only edges.

- [x] Cap reference scans in untested-change suggestions.
  - `src/impact/report-suggestions.ts` calls `findReferences()` for every changed symbol while building test coverage suggestions, but does not pass `maxReferences`.
  - Suggested fix: add a small cap or option-derived cap for this probe, since it only needs to know whether any reference is in a test file.
  - Tests: exported hot symbol with many references and at least one test reference.

- [x] Reduce expensive streaming impact item deduplication.
  - `src/impact/streaming.ts` deduplicates emitted items by `JSON.stringify(item)`, which can become expensive when context refs are included in large partial updates.
  - Suggested fix: use a stable structural key based on file, phase, reasons, symbols, severity/depth, and ref count instead of serializing full context payloads.
  - Tests: streaming with repeated partial updates and `refContext` enabled.
