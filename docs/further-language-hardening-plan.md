# Further Language Hardening Plan

This document is the follow-on plan for strengthening language support after the remaining `Partial` semantic entries were removed from [language-parity.md](./language-parity.md).

Status:
- Implemented on the `improvement-plan-next` branch as of 2026-03-23.
- The prior language-support hardening plans are complete enough to treat as finished.
- Remaining advanced limitations are now documented in [language-parity.md](./language-parity.md) and covered by explicit regression tests.

This plan does not target new languages. It targets deeper, more robust support for the languages and product types we already advertise.

## Goals

1. Increase robustness for the strongest source languages by covering more real-world syntax shapes.
2. Reduce reliance on shallow happy-path fixtures for compiled and package-oriented languages.
3. Harden package/module resolution behavior where we still depend on heuristics.
4. Expand native-vs-JS semantic parity beyond representative cases into deeper stress cases.
5. Keep docs aligned with tested reality while avoiding overstated claims.

## Non-goals

- Do not add new parser backends.
- Do not mix this work with `Piscina` or concurrency changes.
- Do not broaden graph-first product types into full semantic languages unless the implementation and tests justify it.
- Do not update the parity matrix optimistically before the new tests exist.

## Workstreams

Implement the work in this order:

1. Workstream A: Source-language depth expansion
2. Workstream B: Package and module resolution hardening
3. Workstream C: Graph-first product type hardening
4. Workstream D: Native semantic stress parity
5. Workstream E: Documentation and claim review

---

## Workstream A: Source-Language Depth Expansion

### Goal

Broaden semantic coverage for the languages that already say `Yes`, but still rely on relatively shallow fixtures compared with the strongest ecosystems.

### Target languages

- `Go`
- `Kotlin`
- `Java`
- `Rust`
- `C++`
- `Swift`
- `C`
- `Ruby`

### Deliverables

- deeper sample fixtures
- dedicated `goto` and `references` tests for the new syntax families
- parity updates only after the dedicated tests pass

### A1. Go

Add fixtures for:
- aliased imports of packages that expose both functions and types
- dot imports and blank imports
- interface declarations and interface-typed values
- embedded structs or promoted members where supported

Add tests for:
- aliased package-qualified type navigation
- interface/type references across files
- dot-imported symbol navigation and references if support is intended
- blank imports remaining graph-only and not inventing semantic resolution

Likely files:
- `tests/samples/go/aliased-types.go`
- `tests/samples/go/interfaces.go`
- `tests/goto.test.ts`
- `tests/references.test.ts`
- `tests/languages/parity.test.ts`

Acceptance criteria:
- imported package aliases resolve functions and types consistently
- type and interface use sites are covered in references
- unsupported blank-import semantics remain explicit

### A2. Kotlin

Add fixtures for:
- aliased imports
- wildcard imports
- type aliases with real use sites
- object singletons
- companion-object members
- enum entries referenced across files if the current extractor can support them

Add tests for:
- aliased import navigation
- wildcard-import reference coverage
- type alias navigation/reference behavior
- object and companion-member navigation where support is intended

Likely files:
- `tests/samples/kotlin/Aliases.kt`
- `tests/samples/kotlin/TypeConsumers.kt`
- `tests/samples/kotlin/Objects.kt`

Acceptance criteria:
- Kotlin class/type support is no longer only top-level-import happy-path support
- import alias and wildcard behavior are either supported and tested or explicitly documented as unsupported

### A3. Java

Add fixtures for:
- wildcard imports
- nested classes across package files
- interfaces and enums
- static imports with class and member references

Add tests for:
- wildcard-import navigation
- nested-class reference recovery
- interface or enum references across files

Likely files:
- `tests/samples/java/WildcardImports.java`
- `tests/samples/java/NestedPackages.java`

Acceptance criteria:
- package/class resolution works beyond direct single-class imports
- static and nested-type cases are explicitly covered

### A4. Rust

Add fixtures for:
- `pub use`
- nested modules
- `crate::` and `super::`
- trait declarations and method call sites

Add tests for:
- reexport navigation through `pub use`
- nested-module references
- trait/type method reference coverage where the current model supports it

Likely files:
- `tests/samples/rust/reexports.rs`
- `tests/samples/rust/nested/mod.rs`

Acceptance criteria:
- reexports and nested module paths are directly covered
- trait-oriented symbol cases have explicit expected behavior

### A5. C++

Add fixtures for:
- namespace-qualified types and functions
- aliases
- template functions/classes
- overloaded functions

Add tests for:
- namespace-qualified navigation and references
- alias target navigation
- template declaration/reference coverage
- overloaded-function behavior, with explicit constraints if overload disambiguation remains shallow

Likely files:
- `tests/samples/cpp/namespaces.hpp`
- `tests/samples/cpp/templates.hpp`

Acceptance criteria:
- C++ support is no longer limited to simple headers and struct/class basics

### A6. Swift

Add fixtures for:
- protocols
- extensions
- type aliases
- static members

Add tests for:
- protocol/typealias navigation
- reference recovery for imported protocol-conforming types
- static-member cases where semantic support is intended

Likely files:
- `tests/samples/swift/Extensions.swift`
- `tests/samples/swift/StaticMembers.swift`

Acceptance criteria:
- Swift support includes more than top-level functions and structs

### A7. C and Ruby

For `C`, add fixtures for:
- function-pointer typedefs
- enum constants
- macro-defined names where we intentionally do or do not support semantic lookup

For `Ruby`, add fixtures for:
- nested modules
- module-qualified constants
- class-in-module references across files

Acceptance criteria:
- `C` and `Ruby` have explicit edge-case expectations instead of implicit happy-path assumptions

---

## Workstream B: Package and Module Resolution Hardening

### Goal

Reduce fragile heuristic behavior in languages where package/module mapping is still relatively thin.

### Target languages

- `Kotlin`
- `Go`
- `Java`
- `Ruby`

### Deliverables

- stronger resolution fixtures
- implementation updates in shared resolution paths where possible
- direct regression tests for resolution behavior

### B1. Kotlin

Current risk:
- package-to-file mapping currently depends on source scanning heuristics for top-level declarations

Harden by:
- supporting multiple files in the same package with overlapping imports
- ensuring package resolution stays stable for `.kt` and `.kts`
- adding tests where a package exports several symbols from separate files

### B2. Go

Current risk:
- package resolution is good for current fixtures but still needs deeper same-package/multi-file coverage

Harden by:
- adding multi-file same-package fixtures
- ensuring imported package symbols resolve correctly when definitions are spread across files
- covering relative package imports and module-root imports where fixtures allow

### B3. Java

Current risk:
- package/class resolution is not yet pressure-tested on broader package trees

Harden by:
- adding package trees with multiple classes per package
- testing same-package implicit visibility patterns only where the current support intends to resolve them

### B4. Ruby

Current risk:
- namespace/module constant resolution remains relatively shallow

Harden by:
- adding nested module fixtures
- testing `Module::Class` and `Module::CONSTANT` patterns

Acceptance criteria:
- each language has dedicated resolution tests that go beyond single-import happy paths
- resolution logic changes remain shared where possible and language-specific only when necessary

---

## Workstream C: Graph-First Product Type Hardening

### Goal

Improve robustness for graph/specifier-first product types without falsely claiming full semantic support.

### Target product types

- `Vue`
- `Svelte`
- `SCSS`
- `Less`
- `HTML`

### Deliverables

- deeper graph/specifier fixtures
- explicit tests for unsupported semantic behavior
- docs that clearly separate graph support from semantic symbol support

### C1. Vue and Svelte

Add fixtures for:
- richer embedded script cases
- `script setup`
- TypeScript script blocks
- component imports across sibling files
- reusable helper modules plus component-local usage

Add tests for:
- graph edges
- module specifier extraction parity
- explicit `not_found` for navigation when symbol support is not intended

### C2. SCSS and Less

Add fixtures for:
- `@use`
- `@forward`
- nested partials
- alias/config-like import patterns where the current graph model supports them

Add tests for:
- specifier extraction
- file-edge correctness
- explicit unsupported semantic cases

### C3. HTML

Add fixtures for:
- module scripts
- multiple asset references
- script/style combinations across pages

Add tests for:
- graph/specifier parity
- explicit `not_found` semantic behavior

Acceptance criteria:
- graph-first languages are better covered without pretending they are full semantic languages

---

## Workstream D: Native Semantic Stress Parity

### Goal

Move beyond representative native parity into deeper construct coverage for the languages most at risk of drift.

### Deliverables

- expanded `tests/native-semantic-parity.test.ts`
- optional helper refactors if the parity suite becomes too repetitive

### Target additions

Add one or more deeper semantic parity cases for:
- `Go` aliased and interface/type scenarios
- `Kotlin` alias/typealias/object scenarios
- `Java` wildcard/nested-class scenarios
- `Rust` reexport/nested-module scenarios
- `C++` namespace/template scenarios
- `Swift` protocol/typealias scenarios
- `Ruby` nested-module constant scenarios

For graph-first product types, keep parity assertions limited to:
- graph edges
- specifiers
- matching `not_found` semantics

Acceptance criteria:
- deeper language constructs produce identical JS and native semantic results
- languages with native normalization or resolver heuristics have explicit stress coverage

---

## Workstream E: Documentation and Claim Review

### Goal

Keep docs minimal, current, and conservative after the deeper hardening work lands.

### Deliverables

- updated `docs/language-parity.md`
- updated `docs/scenario-catalog.md`
- README update only if wording becomes inaccurate

### Implementation steps

1. Re-read the dedicated tests and the native semantic parity suite.
2. Update the scenario catalog to include each newly meaningful fixture family.
3. Keep the parity matrix compact and avoid overstating product-type semantics.
4. Update README only if its language-support wording becomes stale.

Acceptance criteria:
- every meaningful new fixture family appears in the scenario catalog
- docs remain shorter than the code and tests, but accurately reflect them

---

## Validation

After each workstream:
- `npm run build`
- focused tests for the touched languages

Before merging the whole effort:
- `npm run test:all`

Recommended focused commands:
- `npm test -- tests/goto.test.ts tests/references.test.ts`
- `npm test -- tests/native-semantic-parity.test.ts`
- `npm test -- tests/languages/parity.test.ts`

---

## Definition of Done

This plan is complete when:

- the major target languages have second-generation semantic fixtures beyond happy paths
- package/module resolution is better pressure-tested for `Go`, `Kotlin`, `Java`, and `Ruby`
- graph-first product types have deeper graph/specifier coverage with explicit unsupported semantic expectations
- native semantic parity covers deeper constructs for the higher-risk languages
- docs reflect the broader, stronger fixture coverage without overstating unsupported behaviors
