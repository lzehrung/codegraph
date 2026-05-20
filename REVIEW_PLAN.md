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

## Second-Pass Complexity Findings

- [ ] Split the CLI dispatcher into shared command context plus focused command runners.
  - `src/cli.ts` has a 1,188-line `runCliWithActiveRuntime()` block that mixes argument parsing, discovery setup, graph/index/review command execution, output formatting, report writing, and repeated build-option assembly.
  - Suggested fix: extract a `CliCommandContext` builder, a `resolveCliScanPlan()` helper that returns files plus deleted/existing git state once, and move the remaining in-file command bodies into focused modules. Start with `graph`, `index`, `impact`, and `review` because they contain the most duplicated build/index/report plumbing.
  - Tests: CLI regression coverage for `graph --sqlite`, `graph --symbols-detailed`, `index --json`, `impact --pretty`, `review --summary`, and include-root/git-diff combinations.

- [ ] Factor import extraction into language-specific extractors with a shared binding sink.
  - `src/indexer/imports.ts` still has a 1,018-line `collectImportsForFile()` orchestration block. It now shares implicit binding conversion, but graph-only handling, Python regex import extraction, statement overrides, native capture handling, and JS/CJS fallback remain coupled in one function.
  - Suggested fix: introduce an `ImportExtractionContext` with `resolveFrom()`, `pushBinding()`, fallback reporting, and source/language metadata; move Python, JS/CJS fallback, graph-only, and native statement override logic into separate modules under `src/indexer/imports/`.
  - Tests: import binding parity for TypeScript/JavaScript, Python multiline and alias forms, Java/Kotlin/C#/Go/Rust/PHP native and fallback paths, and graph-only module specifier behavior.

- [ ] Decompose detailed symbol graph collection into reusable AST passes.
  - `src/graphs/symbol-graph-detailed.ts` has a 690-line `buildSymbolGraphDetailed()` with nested walkers for definitions, aliases, member chains, calls, class inheritance, decorators, and Rust impls.
  - Suggested fix: build per-file indexes (`localsByName`, imported alias maps, namespace maps), extract small collectors for `uses/calls`, member chains, decorators, class inheritance, and Rust impls, and run one merged traversal per function body where possible.
  - Performance opportunity: current function-body processing walks the same subtree separately for alias uses, member uses, and calls; a merged visitor should reduce repeated AST traversal on large functions.
  - Tests: detailed symbol graph edge cases for namespace members, `membersOnly`, decorator edges, Java/C# inheritance, Rust impls, optional chaining, and max-edge pruning.

- [ ] Split review report generation into staged pipeline helpers.
  - `src/review.ts` has a 485-line `buildReviewReport()` that handles change discovery, diff normalization, deleted snapshots, incremental indexing, changed-symbol mapping, reference lookups, file summaries, graph delta, candidate tests, SQL context, risk summary, and final report assembly.
  - Suggested fix: extract `collectReviewChanges()`, `buildReviewIndex()`, `summarizeChangedFiles()`, `collectReviewGraphDelta()`, and `assembleReviewReport()` so each stage has explicit inputs/outputs and can be tested directly.
  - Correctness opportunity: make deleted/missing/ignored file status transitions explicit in one data structure instead of spreading them across changed-file sets, diff maps, and final summary branches.
  - Tests: raw diff, git `WORKTREE`, deleted files, missing explicit files, ignored diff files, include-symbol-details, SQL context, and candidate-test sorting.

- [ ] Share full and incremental index-build state machines.
  - `src/indexer/build-index.ts` has two large overlapping flows: `buildIndexFromFileListShared()` at 303 lines and `buildProjectIndexIncremental()` at 371 lines. Both initialize reports, graph options, file signatures, worker pools, parsed caches, bloom filters, JSON dependency modules, graph adjacency, manifest writes, and final `ProjectIndex` assembly.
  - Suggested fix: extract reusable helpers for `IndexBuildRunState`, `prepareFileSignatures()`, `buildFileModules()`, `writeIndexManifest()`, `finalizeProjectIndex()`, and parsed-cache trimming. Keep full and incremental file-selection logic separate, but share execution and finalization.
  - Performance opportunity: centralizing file signature and cached-edge reuse should make it easier to avoid recomputing graph edges or SQL fact caches when only module cache state changed.
  - Tests: cache modes, incremental strict, manifest option mismatch, deleted tracked files, SQL corpus signatures, worker pool parity, and parsed-cache reuse.

- [ ] Split multi-language resolution into per-language modules and unify project symbol indexes.
  - `src/util/resolution.ts` is 1,872 lines and combines TS path config, generic specifier resolution, node_modules resolution, JVM package indexes, PHP composer/symbol scanning, Go module/workspace handling, and Python package resolution.
  - Suggested fix: move language-specific resolvers into `src/util/resolution/{go,jvm,php,python,node}.ts` and keep `resolveImportSpecifier()` as a small dispatcher. Share a generic project-symbol-index builder for Java, Kotlin, and PHP while keeping PHP's multi-namespace/kind metadata.
  - Correctness opportunity: PHP, Java, and Kotlin symbol indexers use regex/token scanners independent of native parsed symbols; consider reusing native/local export extraction where available so import resolution and indexed symbols stay aligned.
  - Tests: resolution regression suites for Java, Kotlin, PHP Composer/autoload/classmap, Go workspaces, Python namespace packages, TS paths, node_modules exports, and cache clearing.
