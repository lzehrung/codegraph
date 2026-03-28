# Native Query Backend Migration Plan

This document is the phased migration plan for making `@lzehrung/codegraph-native` the single Tree-sitter query backend for Codegraph.

Target end state:

- all Tree-sitter parsing and query execution happens in `packages/codegraph-native`
- the TypeScript codebase remains the owner of indexing, graph assembly, resolution, reporting, CLI behavior, SQLite output, and product semantics
- the top-level package no longer depends on per-language `tree-sitter-*` npm packages
- JS fallback remains available only as an explicit temporary migration aid and is removed or heavily constrained once parity and release confidence are sufficient

This is a backend consolidation plan, not a full rewrite of the library in Rust.

---

## Objectives

1. Eliminate install instability caused by the JS Tree-sitter grammar packages and `node-gyp-build`-driven fallback loading.
2. Consolidate grammar ownership into one native package instead of one npm package per language.
3. Keep the existing high-level TypeScript architecture and behavior intact.
4. Preserve semantic parity, reporting fidelity, and platform support while the backend shifts.
5. Make the migration reversible phase by phase until the final dependency removal step.

---

## Non-goals

- Do not rewrite graph assembly, symbol shaping, navigation, CLI orchestration, or SQLite export in Rust.
- Do not introduce a second long-term parser ecosystem.
- Do not drop supported languages to make the migration easier.
- Do not hide native failures by silently weakening semantics or reducing diagnostics.
- Do not remove documented fallback behavior until equivalent or better release confidence exists.

---

## Current Baseline

Today the repo has two Tree-sitter backends:

- a JS backend driven by `tree-sitter` plus per-language npm packages loaded from `src/languages/definitions/loadLanguage.ts`
- a Rust/N-API backend in `packages/codegraph-native` used by the native extraction path

The native path already bundles multiple grammars into one addon and exposes shared query execution, but the JS backend still owns:

- parser construction for the general `LanguageDefinition` grammar path
- chunking parser access
- remaining fallback and compatibility escape hatches
- install-time dependency surface for per-language grammar packages

That means the main problem is not that Codegraph is written in TypeScript. The problem is that parser/runtime ownership is still split.

---

## Guiding Principles

1. Keep one semantic model.
   Native and JS must not diverge in what imports, exports, locals, and bindings mean.

2. Migrate by responsibility, not by language count alone.
   The migration should first make native the source of truth for each query path, then remove JS grammar dependencies.

3. Preserve observable behavior before simplifying internals.
   Reports, counters, CLI output, and documented support claims must remain accurate during every phase.

4. Keep rollback cheap until the final cutover.
   Each phase should be releasable and reversible without data migrations or permanent API breakage.

5. Remove duplicate parser ownership.
   The final architecture should have exactly one implementation of Tree-sitter parsing and query execution.

---

## Target Architecture

In the target state:

- `packages/codegraph-native` owns:
  - grammar registration
  - parser creation and pooling
  - query compilation and caching
  - query normalization tied to native grammar behavior
  - parse and query execution for all supported languages and SFC sub-grammars
  - compact/native result encoding back to TypeScript

- TypeScript owns:
  - language registry and product capability metadata
  - file discovery, workspace awareness, and path resolution
  - graph assembly and symbol/index shaping
  - definition/reference resolution policy
  - incremental indexing and SQLite persistence
  - CLI/report formatting and diagnostics

The boundary should be:

- Rust answers: "Given source text, language ID, and query intent, what are the Tree-sitter matches?"
- TypeScript answers: "What do those matches mean for Codegraph's product behavior?"

---

## Major Risks

### Semantic drift

If TypeScript fallbacks currently repair cases that native does not model directly, the migration could reduce correctness.

Mitigation:

- lock current behavior with parity tests before each removal step
- treat every current JS-only repair path as explicit migration inventory
- refuse final dependency removal until those paths are either moved, intentionally retained as text-only fallbacks, or explicitly de-scoped in docs

### Packaging and release complexity

Moving fully to native shifts risk from npm install of grammar packages to native binary publication and platform coverage.

Mitigation:

- keep current prebuilt target matrix
- add install smoke tests per platform artifact
- keep the previous JS path behind a guarded flag until binary publishing is proven stable in CI and release flow

### Chunking dependency on JS parser objects

Chunking currently consumes `tree-sitter` parser/language objects directly in TypeScript.

Mitigation:

- design chunking migration explicitly instead of treating it as an incidental follow-up
- either move chunk boundary extraction into native or expose a native chunk-oriented parse API

### Worker and payload overhead

If native becomes the only backend but still returns bulky match payloads, performance may regress.

Mitigation:

- keep compact query entrypoints
- add workload-specific native APIs before final cutover

### Release confidence

Removing JS grammar packages too early could leave users without a viable escape hatch.

Mitigation:

- require staged rollout, telemetry/reporting evidence, and documented rollback rules

---

## Phase 0: Migration Inventory and Decision Freeze

### Goal

Produce a complete inventory of every place where JS Tree-sitter is still required and lock the migration scope before implementation starts.

### Deliverables

- a source-of-truth inventory of all `tree-sitter` and `tree-sitter-*` call sites
- a categorized map of JS parser consumers
- a release policy decision for temporary fallback support

### Work

1. Inventory all direct JS Tree-sitter consumers.
   Cover at minimum:
   - `src/languages/definitions/loadLanguage.ts`
   - `src/util.ts`
   - `src/chunking/*`
   - any language-definition grammar hooks
   - tests that instantiate JS grammars directly

2. Categorize each consumer into one of:
   - native-ready today
   - requires a native API addition
   - can become a text/regex fallback
   - should be removed

3. Inventory all JS fallback behaviors that are semantically meaningful.
   Examples:
   - regex import extraction fallback
   - query blanking for unsupported native capabilities
   - post-query shaping that assumes a JS tree exists

4. Freeze migration policy.
   Decide and document:
   - whether the temporary JS backend remains available behind `native: "off"` during intermediate releases
   - whether local development may still use JS-only parser dependencies during a short transition period
   - whether final GA of this migration removes `native: "off"` entirely or leaves it as a non-Tree-sitter text-only fallback mode

### Exit criteria

- every JS Tree-sitter dependency has an owner and a target phase
- there is a written answer for what happens to `native: "off"` at the end

---

## Phase 1: Make Native the Formal Source of Truth for Query Execution

### Goal

Ensure every Codegraph query path is routed through `codegraph-native`, even if TypeScript still performs higher-level shaping.

### Deliverables

- one native query facade in TypeScript
- workload-aware native entrypoints
- no product code path that chooses between JS and native for Tree-sitter querying

### Work

1. Consolidate TypeScript-to-native access behind one module.
   `src/native/treeSitterNative.ts` should become the only way product code requests Tree-sitter query execution.

2. Remove direct JS query execution from graph and indexing paths.
   Callers should request native execution for:
   - imports/specifiers
   - exports
   - locals
   - import bindings

3. Add explicit query scopes.
   Native should expose APIs for at least:
   - imports-only workloads
   - full indexing workloads
   - chunking-oriented parse workloads, if chunking cannot be migrated in one step

4. Preserve structured fallback reasons while fallback exists.
   Keep:
   - `unavailable`
   - `unsupportedLanguage`
   - `queryFailure`

5. Stop treating JS Tree-sitter as a peer backend.
   During this phase, JS is only a temporary recovery path behind the native facade, never a first-class alternate execution model.

### Exit criteria

- all query execution in product code flows through the native facade
- direct JS Tree-sitter query invocation is removed from runtime code paths

---

## Phase 2: Move Language Compatibility Logic to Native-Owned Definitions

### Goal

Eliminate split grammar knowledge where TypeScript and Rust both understand native grammar quirks differently.

### Deliverables

- a single normalization strategy per language/query kind
- compatibility tests tied to native behavior
- explicit unsupported-query handling where needed

### Work

1. Move normalization ownership out of ad hoc runtime logic.
   Each language should define:
   - how query text is normalized for the native grammar
   - which query kinds are intentionally unsupported
   - what metadata should be surfaced for reporting

2. Decide where this metadata lives.
   Preferred options:
   - keep canonical query text in TypeScript and canonical native normalization rules in Rust
   - or introduce a shared generated manifest consumed by both sides

   Avoid a design where both TypeScript and Rust hand-maintain parallel normalization tables.

3. For each language, classify the status of each query kind:
   - supported unchanged
   - supported with normalization
   - intentionally skipped
   - supported only through a separate text fallback

4. Preserve current documented limitations.
   For example:
   - graph-first languages remain graph-first until symbol/navigation support truly exists
   - SCSS symbol-query limitations stay explicit

### Exit criteria

- every supported language has an explicit native compatibility definition
- there is no hidden language-specific query rewrite logic scattered across runtime code

---

## Phase 3: Migrate Chunking Off JS Parser Objects

### Goal

Remove the last large structural reason to keep JS `tree-sitter` in the main package.

### Why this phase matters

Chunking currently depends on TypeScript-side Tree-sitter parser/language objects. If this phase is skipped, the repo still needs the JS parser ecosystem even after graph and index querying are native-only.

### Deliverables

- a native chunking parse/query API or equivalent native chunk boundary extractor
- chunking parity tests covering current supported languages and SFC flows
- removal of JS `Parser.Language` dependence from chunking runtime code

### Work

1. Identify what chunking actually needs from parse trees.
   Break the need into:
   - top-level semantic boundaries
   - symbol/type labels
   - line spans
   - fallback behavior when semantic chunking fails

2. Choose one of two designs.

   Option A: Native chunk boundary extraction.
   Rust returns chunk candidates with span/type metadata and TypeScript keeps merge/split/token-budget logic.

   Option B: Native parse tree projection.
   Rust returns a compact tree shape sufficient for chunking logic in TypeScript.

   Option A is preferred because it avoids inventing a second general-purpose tree API.

3. Add SFC-aware support.
   Native or the TS/native boundary must account for:
   - Vue block extraction
   - Svelte block extraction
   - mapping block-local spans back to file-local spans

4. Keep text-file chunking separate.
   JSON, YAML, and pure text chunking should remain independent of Tree-sitter ownership.

### Exit criteria

- chunking runtime no longer imports JS Tree-sitter parser/language types
- chunking parity is proven for existing semantic-chunking languages and SFC block flows

---

## Phase 4: Collapse Temporary JS Fallbacks into Explicit Policy

### Goal

Reduce the JS backend from a silent safety net to a deliberate, narrow migration policy.

### Deliverables

- explicit fallback matrix
- feature flags or mode gates for any remaining JS-only path
- release notes and docs that describe exactly what remains

### Work

1. Replace implicit fallback with explicit policy branches.
   For every fallback path, declare whether it is:
   - temporary migration-only
   - long-term non-Tree-sitter text fallback
   - unsupported and should error

2. Tighten `native` runtime modes.
   Proposed interim behavior:
   - `native: "auto"`: use native first; allow declared temporary fallback
   - `native: "on"`: require native; fail loudly if unavailable
   - `native: "off"`: disable native, but do not promise full Tree-sitter parity forever

3. Add CI jobs that run with:
   - native required
   - native unavailable
   - per-language unsupported simulation where relevant

4. Surface fallback use clearly in reports and CLI progress output.
   If a release still uses temporary JS fallback, users should be able to see that immediately.

### Exit criteria

- every remaining fallback path is intentional and documented
- there are no accidental JS fallback paths left

---

## Phase 5: Packaging Consolidation and Dependency Removal

### Goal

Remove the per-language JS Tree-sitter packages from the main package once native ownership is complete enough.

### Deliverables

- updated root `package.json`
- updated install/build/test scripts
- release automation that treats native artifacts as first-class deliverables

### Work

1. Remove runtime dependencies on:
   - `tree-sitter`
   - `tree-sitter-c`
   - `tree-sitter-c-sharp`
   - `tree-sitter-cpp`
   - `tree-sitter-css`
   - `tree-sitter-go`
   - `tree-sitter-html`
   - `tree-sitter-java`
   - `tree-sitter-javascript`
   - `tree-sitter-kotlin`
   - `tree-sitter-python`
   - `tree-sitter-ruby`
   - `tree-sitter-rust`
   - `tree-sitter-scss`
   - `tree-sitter-svelte`
   - `tree-sitter-swift`
   - `tree-sitter-typescript`
   - `tree-sitter-vue`

2. Remove JS-only type shims that exist purely to satisfy those packages.
   Review:
   - `src/global.d.ts`
   - any type aliases that only model JS parser bindings

3. Re-evaluate `optionalDependencies`.
   Decide whether `@lzehrung/codegraph-native` remains optional or becomes effectively required.

   Recommended direction:
   - keep it optional only if install UX and docs make fallback behavior crystal clear
   - otherwise promote a package layout where platform-specific native artifacts are the normal install path

4. Update the local-development workflow.
   Document the required build/test flow for:
   - TypeScript-only changes
   - native changes
   - release packaging verification

5. Add install smoke coverage.
   Verify:
   - clean install on supported OS/arch targets
   - no surprise `node-gyp-build` installation path from grammar packages
   - native package resolution works from published artifacts and local workspace

### Exit criteria

- the main package no longer ships per-language JS Tree-sitter grammar dependencies
- clean installs no longer rely on grammar-package `node-gyp-build` behavior

---

## Phase 6: Test, Parity, and Fixture Hardening

### Goal

Prove that native-only query ownership does not reduce supported behavior.

### Deliverables

- expanded parity coverage
- migration-specific regression suites
- install and publish smoke tests

### Work

1. Keep and expand language parity tests.
   Cover:
   - `tests/languages/*.test.ts`
   - `tests/goto.test.ts`
   - `tests/references.test.ts`
   - `tests/native-semantic-parity.test.ts` where native runtime applies

2. Add migration-specific suites.
   At minimum:
   - native-only runtime smoke tests with JS grammar packages absent
   - chunking parity under native-only execution
   - CLI/reporting tests for native-required mode
   - install tests that validate artifact resolution

3. Add negative-path tests.
   Cover:
   - missing native artifact
   - unsupported language capability
   - query compilation failure
   - malformed or stale native package resolution

4. Run fixtures from both perspectives while fallback still exists.
   Compare:
   - native-required behavior
   - auto-with-fallback behavior

5. Freeze support claims only after test proof exists.
   If a capability regresses or remains incomplete, update docs rather than silently carrying optimistic claims forward.

### Exit criteria

- native-only CI is green across supported language fixtures
- documented support claims match actual native-only behavior

---

## Phase 7: Documentation, Skill, and Release Alignment

### Goal

Make public docs match the new architecture exactly.

### Deliverables

- updated README install/runtime sections
- updated language parity and scenario docs
- updated skill and contributor guidance

### Work

1. Update `README.md`.
   Cover:
   - installation expectations
   - native runtime as the default query backend
   - any remaining fallback contract
   - troubleshooting for missing native binaries

2. Update `docs/language-parity.md`.
   Reflect native-only backend ownership and any intentionally limited capabilities.

3. Update `docs/scenario-catalog.md`.
   Ensure fixture coverage claims match the migrated backend.

4. Update `codegraph-skill/codegraph/SKILL.md`.
   If CLI behavior, flags, or installation assumptions change, the skill definition must match.

5. Add concise release notes for the migration.
   Call out:
   - dependency removal
   - install behavior changes
   - fallback policy changes
   - platform support expectations

### Exit criteria

- no documentation still describes JS Tree-sitter grammar packages as the normal backend path
- support and limitation claims are aligned everywhere

---

## Phase 8: Final Cutover and Cleanup

### Goal

Finish the backend consolidation by deleting obsolete JS Tree-sitter infrastructure.

### Deliverables

- removed dead code
- simplified runtime mode logic
- final architecture documentation

### Work

1. Remove obsolete JS backend code.
   Delete:
   - JS grammar loader code no longer used
   - dead fallback branches that only existed for migration
   - unused type declarations and tests tied only to deleted code

2. Simplify runtime configuration.
   Revisit whether `native: "off"` still exists and what it means.
   Recommended end state:
   - `native: "auto"` and `native: "on"` remain
   - `native: "off"` either becomes a clearly degraded non-Tree-sitter mode or is removed in the next major version

3. Re-baseline performance and package size.
   Measure:
   - install success rate
   - cold start
   - graph/index throughput
   - package size and artifact size tradeoffs

4. Close the migration with a final architecture doc update.
   Replace transitional language such as "native addon optional fallback path" if it is no longer true.

### Exit criteria

- there is one Tree-sitter query backend in the product
- obsolete JS grammar infrastructure is removed
- the resulting architecture is simpler than the starting point in both install surface and runtime ownership

---

## Cross-Phase Test Strategy

These checks should run continuously through the migration, not only at the end:

- unit tests for native query normalization and fallback accounting
- language tests for every supported language touched by query ownership changes
- go-to-definition and reference tests for shared semantic behavior
- chunking tests once chunking migration starts
- native-only smoke tests with JS grammar packages unavailable
- publish/install smoke tests for supported native targets

Every phase that changes support claims or fixture coverage must update:

- `docs/language-parity.md`
- `docs/scenario-catalog.md`

If CLI behavior, installation guidance, or runtime mode semantics change, also update:

- `README.md`
- `codegraph-skill/codegraph/SKILL.md`

---

## Rollout Strategy

Recommended release sequence:

1. Internal refactor releases.
   Native facade consolidation, workload-aware entrypoints, and compatibility cleanup with no dependency removals yet.

2. Native-first public releases.
   Native remains default, JS fallback still exists, but reports make any fallback usage explicit.

3. Native-only validation releases.
   CI and selected users exercise builds where JS grammar packages are absent.

4. Dependency-removal release.
   Remove JS grammar packages from the main package only after native-only validation is stable.

5. Cleanup release.
   Remove migration scaffolding and finalize runtime-mode semantics.

If the project wants to minimize user disruption, the dependency-removal release should be a major version unless the existing public contract already clearly treats native as the canonical backend.

---

## Recommended Implementation Order Inside the Repo

Work in this order:

1. Phase 0 inventory
2. Phase 1 native query facade consolidation
3. Phase 2 compatibility ownership cleanup
4. Phase 3 chunking migration
5. Phase 4 fallback policy tightening
6. Phase 6 parity/install hardening
7. Phase 5 dependency removal
8. Phase 7 documentation alignment for the dependency-removal release
9. Phase 8 cleanup

This order deliberately moves test hardening ahead of the final package-dependency deletion.

---

## Definition of Done

The migration is complete when all of the following are true:

- all Tree-sitter parsing and querying happens in `packages/codegraph-native`
- the root package does not depend on per-language JS Tree-sitter grammar packages
- chunking no longer requires JS Tree-sitter parser/language objects
- native-only CI passes across the documented supported-language matrix
- fallback behavior, if any remains, is explicit, narrow, and documented
- README, parity docs, scenario catalog, and skill docs match the shipped behavior

