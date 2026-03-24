# Codegraph Performance Optimization Plans

This document tracks the major architectural options for improving Codegraph performance.

Current status:

- Implemented: one shared native Rust Tree-sitter runtime via `napi-rs`
- Implemented: shared cross-language query model preserved across languages
- Implemented: automatic JS fallback when the native addon is unavailable or a native query path fails
- Implemented: native package publishing flow and runtime loading
- Implemented: native backend usage reporting for graph, index, and review flows plus native parity tests across the supported source-language set
- Implemented: benchmark harness with cold/warm full-index runs, graph-only runs, runtime-environment metadata, a repo-scale local fixture option, and a coarse cold-only CI smoke benchmark for native-vs-JS regression detection
- Implemented: explicit per-file native fallback contract tests for full and incremental indexing
- Implemented: query-driven local-symbol extraction for the native-safe compiled-language subset (`java`, `csharp`, `rust`, `kotlin`, `swift`, `cpp`, plus `python`) with conservative fallback to scope-walk extraction where needed for correctness
- Implemented: parser reuse cleanups so import/specifier extraction and scope-index building no longer acquire parsers when callers already supply parsed trees
- Not implemented yet: `Piscina` worker-pool parallelization
- Not implemented yet: any alternate non-Tree-sitter parser backend

At this point, the major architecture work is complete. The remaining non-`Piscina` optimization work is targeted hot-path cleanup and better benchmark evidence, not another large backend rewrite.

The chosen direction is to keep one shared Tree-sitter model across languages and move hot parse/query execution into Rust, rather than introducing a separate parser stack for a subset of languages.

The remaining native-runtime status is summarized here. Language-support and parity follow-on work has been completed and is now reflected directly in [language-parity.md](./language-parity.md) and [scenario-catalog.md](./scenario-catalog.md).

---

## Plan 1: Native Rust N-API Addon (`napi-rs`) for Tree-sitter
Status: Implemented

**Objective:** Move Tree-sitter parsing and query execution out of Node.js and into a native Rust addon while preserving the existing cross-language query definitions. This reduces FFI overhead without introducing parser divergence between languages.

### Implemented
1. Added the `packages/codegraph-native` workspace package.
2. Added the Rust `napi-rs`, Tree-sitter, and grammar-crate dependencies needed for the native runtime.
3. Implemented the native `run_language_queries(...)` entrypoint and plain capture/result objects in Rust.
4. Wired the addon into `src/native/treeSitterNative.ts`.
5. Threaded native query results through the main extraction and indexing paths while preserving the existing TypeScript-side contracts.
6. Added automatic JS fallback for unavailable or incompatible native execution.
7. Added native package publishing support and automatic runtime loading from the published package.
8. Added backend usage reporting and native parity tests for the supported source-language set.

### Remaining work
- continue replacing avoidable JS-side tree walks with query-driven extraction where semantics stay identical
- remove redundant parsing or repeated hot-path work after native extraction
- benchmark the native path more rigorously on representative larger roots
- keep tightening diagnostics, coverage, and maintainability so future optimizations stay safe

---

## Plan 2: Maximize Tree-sitter Queries (Zero-FFI Filtering)
Status: Partially implemented, but not tracked as a separate completed project

**Objective:** For code that remains in Node.js, prefer Tree-sitter queries over manual tree walking to minimize node-property FFI crossings.

### Notes
- Some extraction paths already prefer query-driven capture collection.
- This is still an ongoing cleanup area rather than a distinct finished milestone.
- Any additional work here should be driven by profiling and by removal of redundant JS-side AST traversal after native extraction is fully stabilized.

### Remaining implementation steps
1. Audit existing traversal for `.children`, `.parent`, `.nextSibling`, `.walk()`, and similar recursive scanning.
2. Replace manual discovery logic with explicit queries wherever the language grammar allows it.
3. Batch node-property reads so helper functions operate on plain JS objects instead of raw Tree-sitter nodes.
4. Remove duplicated parse or extraction work from indexing and graph hot paths once query-driven replacements are in place.

---

## Plan 3: True Multi-Threading via `worker_threads` (Piscina)
Status: Not implemented

**Objective:** Fan out CPU-bound parsing and indexing tasks across multiple physical cores using Node.js `worker_threads` to achieve true parallelism.

### Notes
- This remains intentionally deferred.
- The worker-pool work is isolated so it does not interfere with correctness, diagnostics, or native parity work.
- It should only begin after benchmarking proves there is a real gain around native per-file extraction.

### Remaining implementation steps
1. Add `piscina` only if benchmarking shows real gains around native per-file extraction work.
2. Keep SQLite access and cache writes on the main thread.
3. Dispatch only serializable per-file work to workers and aggregate `ModuleIndex` plus edge results on the main thread.

---

## Plan 4: Alternate Parser Backends for Specific Languages
Status: Explicitly not adopted

**Objective:** Evaluate language-specific parser swaps only if they preserve cross-language maintainability constraints and clearly outperform the shared Tree-sitter model.

### Notes
- This repo intentionally did not adopt a JS/TS-only alternate parser path.
- The active design keeps one Tree-sitter-based parsing model across languages for maintenance consistency.
- Treat this plan as a rejected default, not an active workstream.

### Guardrails if reconsidered in the future
1. Treat parser divergence as a last resort, not the default optimization path.
2. Keep the existing Tree-sitter query contracts as the source of truth unless there is an explicit decision to fork semantics.
3. Require benchmarking plus maintenance justification before adopting a language-specific backend.
