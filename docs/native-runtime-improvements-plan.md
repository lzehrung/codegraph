# Native Runtime Improvement Plan

This document is the execution plan for hardening and extending Codegraph's shared native Tree-sitter runtime. It assumes the current architecture remains in place:

- one cross-language Tree-sitter query model
- Rust/native execution as an implementation detail
- TypeScript remains the owner of higher-level resolution, indexing, reporting, and fallback behavior
- no JS/TS-only parser split

`Piscina` is intentionally isolated into its own workstream so performance experiments cannot destabilize correctness and maintainability work.

---

## Objectives

1. Make native behavior easier to reason about and harder to regress.
2. Improve edge-case test depth for all supported languages.
3. Improve observability so native usage and fallback causes are obvious.
4. Decompose native compatibility logic by language responsibility.
5. Add benchmark coverage before any worker-pool parallelization work.
6. Evaluate `Piscina` only after correctness, diagnostics, and benchmarks are in place.

---

## Non-goals

- Do not introduce a second parser ecosystem for a subset of languages.
- Do not move shared semantic behavior out of the Tree-sitter query contract.
- Do not add worker-pool complexity before baseline native behavior is fully observable and benchmarked.
- Do not claim support for behaviors the current extractor does not actually implement.

---

## Current Baseline

The current system already provides:

- a Rust addon in `packages/codegraph-native`
- shared Tree-sitter-based extraction for all supported source languages
- automatic JS fallback when the native addon is unavailable or a native query path fails
- native usage reporting at the overall run level
- native parity tests across all currently supported source and SFC script languages

Known remaining gaps:

- native query compatibility is still maintained via centralized ad hoc rewrites
- by-language native diagnostics are too coarse
- some important language scenarios are still under-documented or under-sampled
- benchmark evidence is still limited
- `Piscina` has not yet been evaluated against the native path

---

## Workstream Order

Implement the work in this order:

1. Workstream A: Native query compatibility hardening
2. Workstream B: Observability and diagnostics expansion
3. Workstream C: Test and sample coverage expansion
4. Workstream D: Documentation alignment
5. Workstream E: Stability, decomposition, and benchmarks
6. Workstream F: `Piscina` evaluation and optional integration

Do not start Workstream F before A-E are complete.

---

## Workstream A: Native Query Compatibility Hardening

### Goal

Make native query compatibility explicit, localized by language, and directly tested.

### Problem

Today, native query normalization lives in `src/native/treeSitterNative.ts`. That works, but it mixes multiple languages' grammar quirks in one place and makes drift harder to track.

### Desired end state

- each language definition owns any native-specific query normalization it requires
- normalization behavior is tested directly
- fallback reasons are explicit and stable

### Deliverables

- language-local native normalization hooks
- refactored native dispatch code
- normalization unit tests
- fallback-reason tests

### Implementation steps

1. Extend the language definition model.
   Add an optional native compatibility section to the language definition type, for example:
   ```ts
   native?: {
     normalizeQuery?: (
       kind: "imports" | "exports" | "locals" | "importBindings",
       query: string,
     ) => string;
     notes?: string[];
   };
   ```
   The exact shape can vary, but it must support:
   - query-kind-aware normalization
   - blanking a query intentionally when a capability is unsupported
   - optional metadata for diagnostics

2. Add hooks only where currently required.
   Start with:
   - `js`
   - `ts`
   - `tsx`
   - `scss`
   - `kotlin`

3. Preserve current behavior exactly.
   Re-home the current normalization rules without semantic changes:
   - JS:
     - rewrite unsupported function node references as needed
     - remove unsupported object-method export query fragments only if still required
   - TS and TSX:
     - strip unsupported export-assignment and default-export query fragments exactly as the current runtime does
     - preserve `class_declaration` identifier normalization
   - SCSS:
     - keep native import/specifier extraction enabled
     - intentionally blank unsupported symbol queries
   - Kotlin:
     - normalize `import_header` to the native grammar shape
     - normalize identifier node names
     - blank unsupported alias and wildcard query fragments if required by the native grammar

4. Refactor `src/native/treeSitterNative.ts`.
   The file should become responsible for:
   - loading the native binding
   - checking language support
   - asking the language definition whether a query needs normalization
   - executing the native query set
   - returning structured fallback reasons

   It should no longer be the long-term owner of language-specific grammar knowledge.

5. Add direct normalization tests.
   Create `tests/native-query-normalization.test.ts`.
   Cover:
   - JS normalization output
   - TS normalization output
   - TSX normalization output
   - SCSS query blanking
   - Kotlin normalization output
   - languages without a hook returning the original query unchanged

6. Add fallback-reason tests.
   Create `tests/native-fallback-reporting.test.ts`.
   Cover:
   - addon unavailable -> `unavailable`
   - unsupported language -> `unsupportedLanguage`
   - query compilation failure -> `queryFailure`
   Verify that an error string is preserved when present.

### Acceptance criteria

- no centralized language-quirk logic remains in `treeSitterNative.ts` beyond generic dispatch
- all current native parity tests still pass
- normalization behavior is directly tested
- fallback reasons are stable and tested

---

## Workstream B: Observability and Diagnostics Expansion

### Goal

Make one report sufficient to answer which languages used native, which fell back, and why.

### Problem

Current reporting is useful but too coarse. It does not show a compact language-by-language view of native usage and fallback.

### Desired end state

- per-language native usage counters in reports
- per-language fallback counters in reports
- optional visibility into normalized and skipped query kinds
- better progress output without breaking JSON consumers

### Deliverables

- expanded backend report shape
- by-language native reporting
- progress-line backend summaries
- tests for report shape and counters

### Implementation steps

1. Extend the report schema.
   Add `backend.native.byLanguage` to report output. The structure should include:
   - `filesSeen`
   - `filesUsed`
   - `filesFellBack`
   - fallback counters by reason
   - optional `normalizedQueryKinds`
   - optional `skippedQueryKinds`

   Example target shape:
   ```ts
   backend.native.byLanguage[languageId] = {
     filesSeen: number;
     filesUsed: number;
     filesFellBack: number;
     fallbackReasons: {
       unavailable: number;
       unsupportedLanguage: number;
       queryFailure: number;
     };
     normalizedQueryKinds?: string[];
     skippedQueryKinds?: string[];
   };
   ```

2. Record outcomes at file-preparation time.
   Every time a file is prepared for indexing:
   - increment `filesSeen` for its language
   - if native query results are available, increment `filesUsed`
   - if native fallback occurred, increment `filesFellBack` and the matching fallback reason

3. Report normalization and skip metadata.
   If a language hook rewrites or blanks a query:
   - record the query kind
   - expose it in the by-language report section

4. Improve `--progress` stderr output.
   Keep stdout machine-safe.
   Only write human-readable backend summaries to stderr when `--progress` is enabled.

   Emit:
   - startup summary:
     - `Backend: native tree-sitter available`
   - completion summary:
     - `Backend: native used for 120 file(s); fallback for 8 file(s)`
   - optional compact by-language fallback summary if non-zero fallbacks exist

5. Add tests for backend report shape.
   Extend existing report tests or create new ones to verify:
   - `backend.native.byLanguage` exists
   - counters increment correctly
   - load errors remain attached where appropriate
   - `--progress` does not pollute JSON output

### Acceptance criteria

- users can identify native usage and fallback by language from `--report`
- `--progress` output remains useful and concise
- report shape is tested and stable

---

## Workstream C: Test and Sample Coverage Expansion

### Goal

Expand language depth so each supported language has meaningful edge-case coverage beyond a single happy path.

### Problem

We now have baseline native parity and deeper coverage for many compiled languages, but there are still important language-specific variants that are either under-tested or not represented in the scenario catalog.

### Desired end state

For each supported language:

- at least one happy-path fixture
- at least one deeper syntax-variant fixture
- native parity coverage where native support exists
- explicit unsupported behavior tests where capabilities are intentionally absent

### General rules

- every new fixture must protect a specific behavior
- prefer one fixture per behavior, not giant omnibus fixtures
- unsupported behavior must be asserted explicitly with `not_found` or documented fallback, not ignored
- do not write tests that assume support the implementation does not claim

### Sub-work C1: JavaScript and TypeScript

Add or extend fixtures for:

- JS:
  - `module.exports = fn`
  - `exports.foo = bar`
  - `module.exports = { foo, bar }`
  - mixed ESM and CJS files
  - namespace import member usage
- TS:
  - `import type`
  - `export type`
  - `export * as ns from`
  - chained reexports
  - namespace import member access
  - `export =`
  - default exported class and function declarations
  - TSX component reexports where applicable

Add tests for:
- dependency graph
- symbol extraction
- go-to-definition
- references
- native parity

Relevant files:
- `tests/languages/javascript.test.ts`
- `tests/languages/typescript.test.ts`
- `tests/native-tree-sitter.test.ts`
- existing focused tests such as reexport and namespace tests

### Sub-work C2: Python

Add fixtures for:

- `__init__.py` reexports
- namespace-package import variants
- alias-heavy relative imports
- `import module as alias`
- `from pkg import submod as alias`
- all currently supported `__all__` forms, including list/tuple/append/extend combinations

Add tests for:
- dependency graph
- symbol extraction
- go-to-definition
- references
- native parity for imports and module exports

### Sub-work C3: Ruby

Add fixtures for:

- nested module and class namespace patterns
- constant references through module namespaces
- `require_relative` plus module-qualified usage

Add tests for:
- symbol extraction
- go-to-definition
- references
- native parity for imports and symbols

### Sub-work C4: Go, Java, C#, and Rust

Add or extend fixtures for:

- Go:
  - alias imports
  - blank imports `_`
  - dot imports `.`
  - interface and receiver method usage
- Java:
  - wildcard imports
  - nested class references
  - interface method usage
- C#:
  - alias `using`
  - nested class references
  - namespace-qualified usage
  - extension-style static usage if the implementation currently supports it
- Rust:
  - `pub use`
  - nested modules
  - `crate::` and `super::`
  - trait plus impl method references

Add not only symbol extraction tests, but also navigation and reference tests where support already exists.

### Sub-work C5: C, C++, Kotlin, and Swift

Add or extend fixtures for:

- C:
  - more typedef-backed declarations
  - macro functions
  - unions if supported
- C++:
  - namespace-qualified usage
  - alias declarations
  - class method references
  - template function references
- Kotlin:
  - alias imports
  - wildcard imports
  - enum-entry usage
  - object usage
- Swift:
  - protocol member usage
  - typealias usage
  - property and subscript declarations where already supported

Add tests for:
- symbol extraction parity
- dependency graph where applicable
- references and goto only when the implementation already supports them

### Sub-work C6: Vue, Svelte, and CSS-family

Vue and Svelte:

- add more SFC fixtures for:
  - `script setup`
  - TS script blocks
  - component import plus local usage
  - reactive Svelte statements

CSS, Less, and SCSS:

- expand coverage for:
  - multiple `@import` forms
  - `@use`
  - `@forward`
  - partial resolution variants

Keep unsupported navigation and symbol behavior explicit.

### Acceptance criteria

- every supported language has at least one deeper variant fixture beyond happy path
- native parity coverage exists for all native-supported source languages
- scenario docs match the real fixture set

---

## Workstream D: Documentation Alignment

### Goal

Make the documentation a reliable maintenance map of what is supported, what is intentionally unsupported, and which fixtures protect which scenarios.

### Problem

Docs are much better than before but still need to evolve alongside the expanded fixture set and native diagnostics.

### Deliverables

- updated README notes
- updated language parity matrix
- updated scenario catalog
- skill doc updates only if CLI or report surface changes

### Implementation steps

1. README
   Add one concise note describing:
   - native Tree-sitter is shared across all supported source languages
   - `--report` exposes backend usage by language
   - some languages still intentionally have capability limits

2. `docs/language-parity.md`
   Keep the matrix compact.
   Add a small native-notes section that calls out:
   - JS normalization
   - TS and TSX normalization
   - Kotlin normalization
   - SCSS skipped symbol queries

3. `docs/scenario-catalog.md`
   Every meaningful fixture should have:
   - a named scenario
   - the sample path
   - expected behavior
   - source
   - date added

4. `codegraph-skill/codegraph/SKILL.md`
   Update only if CLI or report surface changes in user-visible ways.

### Acceptance criteria

- docs are accurate and minimal
- all non-trivial fixtures appear in the scenario catalog
- native limitations and normalizations are documented explicitly

---

## Workstream E: Stability, Decomposition, and Benchmarks

### Goal

Improve long-term maintainability and gather performance evidence before parallelization work.

### Problem

The code is working, but some bookkeeping and native runtime logic can still be decomposed more cleanly. Also, performance claims are not yet backed by a repeatable benchmark harness.

### Deliverables

- cleaner native/backend bookkeeping boundaries
- benchmark harness
- stability tests around fallback behavior

### Current status

- Implemented: `scripts/bench-native.mjs`
- Implemented: `bench:native` and `bench:native:smoke`
- Implemented: cold/warm full-index benchmarking, graph-only benchmarking, and a coarse cold-only CI smoke benchmark with a generous native slowdown guard
- Implemented: benchmark JSON output includes runtime environment details, the harness can target the repo itself for larger local comparison runs, and graph workloads report processed files separately from resulting graph node count
- Implemented: focused tests that lock the per-file native fallback contract for full and incremental indexing
- Implemented: backend-native bookkeeping extraction into `src/native/nativeBackendReport.ts`

### Implementation steps

1. Extract backend report bookkeeping.
   Create a small helper module such as:
   - `src/native/nativeBackendReport.ts`

   This helper should own:
   - initializing backend-native report state
   - recording per-file and per-language outcomes
   - summarizing fallback counters

   Do not leave this logic scattered through indexing code.

2. Keep native compatibility helpers small and focused.
   After Workstream A, ensure:
   - language definitions own normalization rules
   - shared native runtime code only handles dispatch and execution
   - shared report code only handles diagnostics and counters

3. Add a benchmark harness.
   Create a script such as:
   - `scripts/bench-native.mjs`

   Measure:
   - JS path vs native path
   - cold run vs warm cache
   - graph-only vs full index

   Run it against:
   - JS or TS fixture root
   - Python fixture root
   - Go fixture root
   - Rust fixture root
   - mixed-language fixture root

4. Emit benchmark outputs that are easy to compare.
   Include at minimum:
   - elapsed time
   - files processed
   - files per second
   - native used count
   - native fallback count

5. Add a small CI-safe smoke benchmark mode if practical.
   Keep assertions coarse.
   Example rule:
   - native path must not be catastrophically slower than JS path on benchmark fixtures

6. Clarify and test fallback policy.
   Decide whether native fallback remains all-or-nothing per file.

   Recommended contract:
   - if native query execution for a file is not trustworthy, fall back cleanly for that file
   - do not mix native and JS query kinds inside a single file unless you explicitly design and test for partial-mode behavior later

   Add tests to lock that behavior.

### Acceptance criteria

- native bookkeeping is isolated by responsibility
- benchmark harness exists and is documented
- fallback policy is explicit and tested

---

## Workstream F: `Piscina` Evaluation and Optional Integration

This workstream must remain isolated from the rest of the plan.

### Goal

Determine whether `Piscina` materially improves throughput around native extraction work, and only integrate it if the gains justify the added complexity.

### Entry criteria

Do not begin this work until:

- all tests are green after Workstreams A-E
- native diagnostics are available by language
- benchmark baselines exist for native vs JS execution

### Non-goals

- do not reintroduce parser divergence
- do not parallelize before measuring
- do not mutate shared caches or report objects directly from workers

### Deliverables

- benchmark comparison for native with and without `Piscina`
- optional worker-pool path behind a flag
- worker-pool correctness tests
- worker-pool observability in reports

### Implementation steps

1. Benchmark first.
   Using the benchmark harness from Workstream E, measure:
   - JS path
   - native path
   - native plus `Piscina`

   Identify whether real wall-clock gains exist and on what repo sizes.

2. Define the parallelization boundary.
   Recommended boundary:
   - workers handle per-file native extraction
   - the main thread owns graph assembly, final index mutation, cache writes, and report aggregation

3. Design a small serializable worker contract.
   Worker input should include:
   - file path
   - source text if already loaded, or enough information to load it
   - language id
   - normalized query text or query bundle
   - options required for extraction

   Worker output should include only plain structured data:
   - imports, exports, locals, import bindings
   - fallback reason if any
   - timing metadata if useful

4. Add the worker path behind a feature flag.
   Add an internal option first, for example:
   - `useNativeWorkers?: boolean`
   - `nativeThreads?: number`

   Do not make it the default until benchmark results justify it.

5. Preserve observability.
   Reports must show:
   - whether `Piscina` was enabled
   - worker count
   - worker extraction time vs merge time if available
   - the same native fallback counters as non-worker mode

6. Add correctness parity tests.
   For representative fixture roots, verify that:
   - no-worker native mode
   - worker-pool native mode

   produce identical graph and symbol outputs.

7. Add performance benchmarks and decide default behavior.
   If `Piscina` shows clear wins on realistic repo sizes without harming small repos too much, consider enabling it by default.
   Otherwise:
   - keep it optional
   - document when it helps

### Acceptance criteria

- worker-pool mode is optional first
- worker-pool and non-worker outputs are identical
- reports clearly expose worker-pool usage
- benchmark evidence exists for any decision to enable or not enable it by default

---

## Validation Checklist

After each workstream, run:

- `npm run build`
- focused tests for the files touched
- `npm test` before merging the workstream

Additional validation by workstream:

- A:
  - native normalization tests
  - fallback-reason tests
- B:
  - report-shape tests
  - CLI progress output tests
- C:
  - language-specific parity and scenario tests
  - native parity tests
- D:
  - doc review for accuracy against fixture set
- E:
  - benchmark harness run
  - fallback policy tests
- F:
  - worker-pool parity tests
  - benchmark comparison runs

---

## Definition of Done

This plan is complete when all of the following are true:

- every advertised source language can use the native package
- native compatibility quirks are owned by language definitions, not hidden in one shared file
- reports show native usage and fallback by language
- every supported language has meaningful syntax-variant coverage beyond happy path
- docs accurately describe supported behavior and intentional limitations
- benchmark data exists for JS, TS, Python, Go, Rust, and mixed-language fixture roots
- `Piscina` has either been proven worthwhile and integrated safely, or explicitly left optional with documented tradeoffs
