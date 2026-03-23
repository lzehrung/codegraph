# Codegraph Performance Optimization Plans

This document tracks the major architectural options for improving Codegraph performance. The current implementation direction is to keep one shared Tree-sitter model across languages and move hot parse/query execution into Rust, rather than introducing a separate parser stack for a subset of languages.

The execution plan for the remaining native-runtime hardening, coverage, diagnostics, benchmarks, and isolated `Piscina` evaluation work lives in [native-runtime-improvements-plan.md](./native-runtime-improvements-plan.md).

---

## Plan 1: Native Rust N-API Addon (`napi-rs`) for Tree-sitter
**Objective:** Move Tree-sitter parsing and query execution out of Node.js and into a native Rust addon while preserving the existing cross-language query definitions. This reduces FFI overhead without introducing parser divergence between languages.

### Implementation Steps:
1. **Initialize `napi-rs` workspace:**
   - Add a private workspace package such as `packages/codegraph-native`.
   - Expose a small JS loader plus generated typings for the built `.node` artifact.

2. **Add Rust dependencies:**
   - In `packages/codegraph-native/Cargo.toml`, add:
     - `napi`, `napi-derive`, and `napi-build`
     - `tree-sitter`
     - grammar crates for each supported language
     - `streaming-iterator` for efficient query iteration

3. **Define the N-API interface:**
   - In `packages/codegraph-native/src/lib.rs`, define N-API objects for plain query captures and grouped query results using `#[napi(object)]`.
   - Expose one native entrypoint that parses once and runs the current query set:
     ```rust
     #[napi]
     pub fn run_language_queries(...) -> NativeQueryResults { ... }
     ```

4. **Implement Tree-sitter logic in Rust:**
   - Instantiate a `tree_sitter::Parser` and set the language from `language_id`.
   - Parse the source once, compile the provided query strings, and execute them with `tree_sitter::QueryCursor`.
   - Return plain capture data to TypeScript so the JS side does not touch Tree-sitter nodes for the hot query paths.
   - Keep TypeScript responsible for higher-level resolution heuristics and fallback behavior so all languages stay on one shared extraction contract.

5. **Integrate with Node.js extraction paths:**
   - Import the native addon through a loader in `src/native/treeSitterNative.ts`.
   - Run native query execution once per parsed file, then thread those capture results through `collectModuleSpecifiersFromSource`, `collectImportsForFile`, and `collectLocalsAndExportsFromSource`.
   - Keep an automatic JS fallback whenever the addon is missing or a query is incompatible with the Rust grammar binding.

---

## Plan 2: Maximize Tree-sitter Queries (Zero-FFI Filtering)
**Objective:** For code that remains in Node.js, prefer Tree-sitter queries over manual tree walking to minimize node-property FFI crossings.

### Implementation Steps:
1. Audit existing traversal for `.children`, `.parent`, `.nextSibling`, `.walk()`, and similar recursive scanning.
2. Replace manual discovery logic with explicit queries wherever the language grammar allows it.
3. Batch node-property reads so helper functions operate on plain JS objects instead of raw Tree-sitter nodes.

---

## Plan 3: True Multi-Threading via `worker_threads` (Piscina)
**Objective:** Fan out CPU-bound parsing and indexing tasks across multiple physical cores using Node.js `worker_threads` to achieve true parallelism.

### Implementation Steps:
1. Add `piscina` only if benchmarking shows real gains around native per-file extraction work.
2. Keep SQLite access and cache writes on the main thread.
3. Dispatch only serializable per-file work to workers and aggregate `ModuleIndex` plus edge results on the main thread.

---

## Plan 4: Alternate Parser Backends for Specific Languages
**Objective:** Evaluate language-specific parser swaps only if they preserve cross-language maintainability constraints and clearly outperform the shared Tree-sitter model.

### Implementation Steps:
1. Treat parser divergence as a last resort, not the default optimization path.
2. Keep the existing Tree-sitter query contracts as the source of truth unless there is an explicit decision to fork semantics.
3. Require benchmarking plus maintenance justification before adopting a language-specific backend.
