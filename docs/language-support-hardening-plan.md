# Language Support Hardening Plan

This document is the execution plan for making language support more equal, more explicit, and more defensible across Codegraph.

It focuses on four gaps identified in review:

- navigation and reference coverage is not equally deep across all supported languages
- native parity coverage is strong for extraction, but thinner for end-to-end semantic behavior
- the scenario catalog does not fully mirror the real tested surface
- the Rust native crate has only light direct language smoke coverage relative to the supported language set

This plan is written as a handoff document. A junior developer or agent should be able to implement it step by step without needing to infer intent.

Follow-on:
- the remaining `Partial` language-support closures were captured in [partial-language-support-plan.md](./partial-language-support-plan.md) and completed
- the next depth-oriented hardening pass is captured in [further-language-hardening-plan.md](./further-language-hardening-plan.md)

---

## Objectives

1. Make language support depth more equal across the advertised language set.
2. Add end-to-end native parity checks for navigation and references, not only extraction.
3. Make the scenario catalog a reliable maintenance map for real behaviors and fixture coverage.
4. Add direct Rust-side smoke coverage for every native-supported language id.
5. Keep documentation accurate and conservative: claim only what the tests clearly support.

---

## Non-goals

- Do not add support for new languages in this workstream.
- Do not broaden capability claims beyond what the implementation already supports.
- Do not add alternate parser backends.
- Do not mix this work with `Piscina` or worker-pool experimentation.
- Do not replace existing focused tests with broad snapshot tests.

---

## Current Baseline

The current system already provides:

- dependency-graph, symbol, and native parity coverage across the advertised language set
- dedicated `goto` and `references` suites for:
  - TypeScript
  - JavaScript
  - Python
  - Java
  - C#
  - Ruby
  - Rust
- generic language-parity coverage for:
  - Go
  - C
  - C++
  - Kotlin
  - Swift
  - HTML
  - CSS
  - SCSS
  - Less
  - Vue
  - Svelte
- native extraction parity across all current native-supported source and SFC script languages
- a scenario catalog that covers many representative fixtures

Remaining gaps:

- `Go`, `C`, `C++`, `Kotlin`, and `Swift` do not yet have dedicated `goto` and `references` suites comparable to the stronger languages
- native parity tests mostly prove extraction parity, not end-to-end semantic parity through `buildProjectIndex`, `goToDefinition`, and `findReferences`
- scenario docs still under-represent navigation/reference scenarios and some deeper syntax variants
- `packages/codegraph-native/src/lib.rs` does not directly smoke-test all advertised native language ids

---

## Workstream Order

Implement the work in this order:

1. Workstream A: Navigation and reference depth equalization
2. Workstream B: End-to-end native semantic parity
3. Workstream C: Rust native crate language smoke coverage
4. Workstream D: Scenario and parity documentation alignment
5. Workstream E: Final review and claim tightening

Do not reorder B ahead of A. The semantic native parity work should compare against strong, explicit language behavior tests rather than thin generic coverage.

---

## Workstream A: Navigation and Reference Depth Equalization

### Goal

Bring `goto` and `references` coverage for `Go`, `C`, `C++`, `Kotlin`, and `Swift` up to the same standard already used for `TypeScript`, `JavaScript`, `Python`, `Java`, `C#`, `Ruby`, and `Rust`.

### Problem

Those languages are currently represented in the generic parity runner, but not in the stronger dedicated suites in `tests/goto.test.ts` and `tests/references.test.ts`. That means the support exists, but it is not pressure-tested equally.

### Deliverables

- dedicated `goto` tests for `Go`, `C`, `C++`, `Kotlin`, and `Swift`
- dedicated `references` tests for the same set
- fixture additions where current samples are too shallow to support robust navigation assertions

### General implementation rules

- Follow the style and structure already used in `tests/goto.test.ts` and `tests/references.test.ts`.
- Prefer concrete assertions on target file and start line, not vague truthy assertions.
- Use existing fixtures first. Add new fixtures only when the current sample cannot express the desired behavior clearly.
- Each test should protect one behavior.
- Avoid giant mixed-behavior fixtures.

### Implementation steps

#### A1. Audit existing fixture suitability

Inspect the fixture directories:

- `tests/samples/go`
- `tests/samples/c`
- `tests/samples/cpp`
- `tests/samples/kotlin`
- `tests/samples/swift`

For each language, determine whether the current sample set already supports dedicated assertions for:

- imported or included function navigation
- imported or included type/class/struct navigation
- at least one reference query on a definition

If the answer is no for any behavior, add a new fixture file targeted at that one missing behavior.

#### A2. Add dedicated `goto` tests

Extend `tests/goto.test.ts` with new `describe(...)` blocks for:

- `Go`
- `C`
- `C++`
- `Kotlin`
- `Swift`

For each language, add at least two tests:

1. imported or included function definition
2. imported or included type/class/struct definition

Language-specific targets:

- Go:
  - imported function from another package file
  - imported type or interface from another package file if the current resolver supports it
- C:
  - function declaration in header from a usage site in `.c`
  - typedef or struct declaration in header if current symbol support handles it
- C++:
  - function or static helper declaration from header usage
  - class or namespace-scoped type definition
- Kotlin:
  - imported top-level function
  - imported class, enum, type alias, or object depending on what current extraction reliably supports
- Swift:
  - imported helper function
  - imported type or protocol declaration

Rules:

- Use exact expected file and expected definition line.
- If a language intentionally cannot resolve one of these targets, do not force an `ok` assertion. Either:
  - omit that case, or
  - add an explicit `not_found` test only if the docs already claim the limitation.

#### A3. Add dedicated `references` tests

Extend `tests/references.test.ts` with new `describe(...)` blocks for:

- `Go`
- `C`
- `C++`
- `Kotlin`
- `Swift`

For each language, add at least two tests:

1. references for an exported or shared function
2. references for an exported or shared type/class/struct/protocol where supported

Rules:

- Assert `status === "ok"` when behavior is supported.
- Assert a minimum reference count that includes the definition site.
- Where useful, assert that at least one non-definition use-site is present in the calling file.
- Do not inflate expected counts if they are brittle across harmless fixture edits. Use `>=` style thresholds.

#### A4. Add fixture depth only where needed

If any language lacks clear fixtures for the above:

- add one targeted fixture per missing behavior
- update the sample root consistently
- keep names descriptive, for example:
  - `contracts.go`
  - `advanced.h`
  - `advanced.hpp`
  - `Models.kt`
  - `Protocols.swift`

Do not rewrite existing samples unless the current structure is actively blocking good tests.

### Acceptance criteria

- `tests/goto.test.ts` includes dedicated coverage for `Go`, `C`, `C++`, `Kotlin`, and `Swift`
- `tests/references.test.ts` includes dedicated coverage for the same languages
- the new tests assert concrete results, not only generic parity

---

## Workstream B: End-to-End Native Semantic Parity

### Goal

Prove that native-backed runs produce the same user-facing semantic behavior as JS-backed runs for indexing, navigation, and references on representative languages.

### Problem

Current native parity tests mostly cover imports, exports, locals, and specifiers. They do not fully exercise downstream semantic consumers such as `buildProjectIndex`, `goToDefinition`, or `findReferences`.

### Deliverables

- a new end-to-end native parity test suite
- optional helper utilities for toggling native vs JS mode in tests
- coverage for a representative language subset

### Scope

This suite does not need to cover every language immediately. It needs to cover a representative set that stresses the different extraction shapes:

- TypeScript
- JavaScript
- Python
- Go
- Java
- C#
- Rust
- Kotlin
- Swift
- one header/include language: either `C` or `C++`
- one SFC/script-embedded language for graph/specifier parity: `Vue` or `Svelte`

### Implementation steps

#### B1. Create native-mode toggle helpers

Add or extend test helpers so a test can build an index in:

- native-enabled mode
- forced-JS mode

Use the existing `CODEGRAPH_DISABLE_NATIVE=1` behavior where appropriate, but keep the test helper API ergonomic. For example, add helpers that:

- temporarily set the env var for the duration of one test branch
- restore the original env after the assertion

Do not leak environment changes between tests.

#### B2. Create a new end-to-end parity suite

Create a file such as:

- `tests/native-semantic-parity.test.ts`

For each chosen language fixture root:

1. build the project index in native mode
2. build the project index in forced-JS mode
3. compare key semantic outputs

Minimum comparisons:

- graph edges for the fixture root
- symbol presence for one or more expected names
- one `goToDefinition` result
- one `findReferences` result

Comparison rules:

- compare normalized path output where needed
- compare semantically relevant fields, not unstable incidental fields
- for references, compare:
  - status
  - count or normalized file-plus-line tuples
- for definitions, compare:
  - status
  - target file
  - target start line

#### B3. Cover graph/specifier-focused languages conservatively

For `Vue`, `Svelte`, `HTML`, `CSS`, `Less`, and `SCSS`, do not invent semantic parity claims that the implementation does not support.

If including one of these languages in the new suite:

- compare graph/specifier-level outputs only
- if `goto` or `references` are intentionally unsupported, assert the same `not_found` result in native and JS modes rather than pretending the language has semantic navigation support

#### B4. Add one regression around native normalization-sensitive languages

Specifically include at least:

- TypeScript or TSX with a case that depends on native query normalization
- Kotlin with a case that depends on native query normalization
- SCSS or Vue/Svelte with intentionally skipped or limited native capability

The purpose is to lock end-to-end downstream behavior, not just raw query parity.

### Acceptance criteria

- one dedicated suite compares native-enabled and forced-JS semantic behavior end to end
- differences in index, goto, and references would fail the suite
- graph/specifier-only languages are handled conservatively and honestly

---

## Workstream C: Rust Native Crate Language Smoke Coverage

### Goal

Add direct Rust-side confidence that every advertised native language id can at least parse source and execute a simple query.

### Problem

The Rust native crate currently has only a few direct tests. Most language-specific failures would be caught only later in TypeScript integration tests.

### Deliverables

- Rust smoke tests for every `supported_language_id`
- a small table of sample source snippets in the Rust test module
- direct query-execution assertions at the crate boundary

### Implementation steps

#### C1. Define the smoke-test contract

For every language id returned by `supported_language_ids()`:

1. `language_for_id(language_id)` returns a parser language
2. a tiny valid source snippet parses successfully
3. a minimal query executes without throwing

The goal is not semantic exhaustiveness. The goal is to catch:

- missing grammar registration
- broken parser setup
- catastrophic query incompatibility

#### C2. Add per-language source snippets

Inside `packages/codegraph-native/src/lib.rs` test module, define a helper such as:

```rust
fn smoke_case(language_id: &str) -> (&'static str, &'static str) { ... }
```

Return:

- a minimal valid source string
- a minimal query string that should match something simple

Suggested examples:

- `ts` / `tsx` / `js`: function or variable declaration
- `python`: `def helper(): pass`
- `go`: `package main\nfunc Helper() {}`
- `java`: `class Main { void helper() {} }`
- `csharp`: `class Program { void Helper() {} }`
- `rust`: `fn helper() {}`
- `kotlin`: `fun helper() {}`
- `swift`: `func helper() {}`
- `c`: `int helper(void);`
- `cpp`: `class Helper {};`
- `html`: `<script src="./app.js"></script>`
- `css` / `less` / `scss`: `@import "base.css";`
- `vue`: `<script setup>import "./dep.ts";</script>`
- `svelte`: `<script>import "./dep.js";</script>`
- `ruby`: `def helper; end`

The exact snippet can differ if the grammar requires a different minimal form.

#### C3. Add a single exhaustive smoke test over all supported language ids

Add a test that:

- iterates `supported_language_ids()`
- loads the source/query pair
- parses the source
- executes the query
- asserts no panic or error

If a language genuinely needs a blank query for the smoke case, document why in a code comment. Prefer real queries where possible.

#### C4. Add one test that the supported-id list and smoke-case table stay in sync

Guard against future drift.

For example:

- build a fixed set of smoke-case keys
- compare it to the returned `supported_language_ids()` set

This ensures a newly added language id cannot silently miss Rust-side smoke coverage.

### Acceptance criteria

- every supported native language id has direct Rust smoke coverage
- the smoke-case table and supported-language list are kept in sync by test
- failures in native grammar registration are caught at the crate boundary

---

## Workstream D: Scenario and Parity Documentation Alignment

### Goal

Make the docs reflect the real tested surface, especially for navigation/reference depth and native end-to-end parity.

### Problem

The language parity matrix and scenario catalog are useful, but they currently compress some important differences in test depth.

### Deliverables

- updated `docs/language-parity.md`
- updated `docs/scenario-catalog.md`
- minimal README note updates only if needed

### Implementation steps

#### D1. Tighten the parity matrix language claims

Review `docs/language-parity.md` after Workstreams A-C land.

For each language, confirm that each `Yes` claim is backed by:

- an implementation path that is intentionally supported
- direct tests, not only incidental coverage

If a capability is real but still intentionally thin or limited, consider:

- keeping `Yes` if support is truly present and now explicitly tested
- changing to `Partial` if the real behavior is narrower than the current label suggests

Be conservative.

#### D2. Expand scenario entries for navigation and references

Update `docs/scenario-catalog.md` so it includes dedicated entries for the new `goto` and `references` scenarios added in Workstream A.

At minimum, add entries for:

- `Go`
- `C`
- `C++`
- `Kotlin`
- `Swift`

Also add entries for the new end-to-end native semantic parity suite introduced in Workstream B.

Each row should include:

- scenario name
- sample or test file
- expected behavior
- source
- date added

#### D3. Document native end-to-end parity honestly

In `docs/language-parity.md` or a short note beneath the matrix:

- distinguish extraction parity from end-to-end semantic parity
- state which behaviors are now covered by the new suite
- keep graph-only languages explicitly marked as graph/chunking-focused

Do not imply full semantic parity for `HTML`, `CSS`, `Less`, `Vue`, or `Svelte` if the suite only proves graph/specifier behavior there.

#### D4. Update README only if wording is now misleading

If the README currently says something that the stronger review disproves or materially expands, update it minimally.

Examples of acceptable README adjustments:

- clarify that native parity now includes end-to-end semantic checks for representative source languages
- clarify that graph/specifier-only languages are supported at that level, not as full semantic navigation languages

Do not add large new sections unless necessary.

### Acceptance criteria

- docs match the new test reality
- the parity matrix does not over-claim
- the scenario catalog can be used as a maintenance map for language behaviors

---

## Workstream E: Final Review and Claim Tightening

### Goal

Finish with an explicit review pass that either confirms parity claims or narrows them.

### Problem

After adding new tests and docs, it is still easy to accidentally leave an over-broad claim in place.

### Deliverables

- one final review pass
- any last doc corrections
- final validation run

### Implementation steps

1. Re-read:
   - `docs/language-parity.md`
   - `docs/scenario-catalog.md`
   - `tests/goto.test.ts`
   - `tests/references.test.ts`
   - `tests/native-semantic-parity.test.ts` or equivalent
   - `packages/codegraph-native/src/lib.rs`

2. Verify these questions explicitly:
   - Is every `Yes` in the matrix backed by a direct test?
   - Are graph-only languages clearly distinguished from semantic-navigation languages?
   - Does every supported native language id have a Rust smoke case?
   - Does the end-to-end native suite compare meaningful downstream behavior rather than only raw extraction?

3. If any answer is no:
   - add the missing test, or
   - lower the documentation claim

4. Run the full validation set and do not merge until it is green.

### Acceptance criteria

- no obvious over-claim remains in docs
- direct tests back the language-support claims
- the final suite is green

---

## Validation Checklist

After each workstream, run:

- `npm run build`
- focused tests for the touched areas

Before merging the full effort, run:

- `npm run test:all`

Additional validation by workstream:

- A:
  - `npm test -- tests/goto.test.ts tests/references.test.ts`
  - any language-specific focused tests for new fixtures
- B:
  - `npm test -- tests/native-semantic-parity.test.ts`
  - existing native parity suite
- C:
  - `cargo test` in `packages/codegraph-native`
- D:
  - manual doc review against touched tests and samples
- E:
  - final full-suite pass

---

## Recommended File Touch List

This is the most likely set of files to change. Use it as a guide, not a rigid requirement.

Tests:

- `tests/goto.test.ts`
- `tests/references.test.ts`
- `tests/native-tree-sitter.test.ts`
- `tests/native-semantic-parity.test.ts`
- `tests/languages/parity.test.ts`

Rust native crate:

- `packages/codegraph-native/src/lib.rs`

Fixtures:

- `tests/samples/go/*`
- `tests/samples/c/*`
- `tests/samples/cpp/*`
- `tests/samples/kotlin/*`
- `tests/samples/swift/*`

Docs:

- `docs/language-parity.md`
- `docs/scenario-catalog.md`
- `README.md` only if needed

---

## Definition of Done

This plan is complete when all of the following are true:

- `Go`, `C`, `C++`, `Kotlin`, and `Swift` have dedicated `goto` and `references` tests
- a native end-to-end semantic parity suite exists and compares native-enabled vs forced-JS behavior
- every native-supported language id has direct Rust smoke coverage
- the language parity matrix is conservative and accurate
- the scenario catalog reflects both fixture coverage and navigation/reference coverage
- the full repo test command passes from the repo root

The narrower follow-on plan for eliminating the remaining `Partial` entries in the parity matrix lives in [partial-language-support-plan.md](./partial-language-support-plan.md).
