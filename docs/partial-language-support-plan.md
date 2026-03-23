# Partial Language Support Closure Plan

This document is the execution plan for eliminating the remaining `Partial` entries in [language-parity.md](./language-parity.md).

Status:
- Completed on 2026-03-23. `Go`, `C`, and `Kotlin` no longer have `Partial` entries in the parity matrix.

It is a follow-on plan. The broader native-runtime and language-support-hardening plans are already complete enough to treat as finished workstreams. This plan focuses only on the remaining known partial areas:

- `Go`: `Go-to-definition`, `Find references`
- `C`: `Find references`
- `Kotlin`: `Go-to-definition`, `Find references`

The goal is not to add new languages. The goal is to close the known support gaps in the existing languages and then update the matrix conservatively.

---

## Objectives

1. Turn the remaining partial language capabilities into explicit, test-backed behavior.
2. Close the known semantic gaps before changing documentation claims.
3. Keep native and JS behavior aligned while support depth expands.
4. Leave the parity matrix more defensible, not more optimistic.

---

## Non-goals

- Do not add support for new languages.
- Do not broaden product-file parsing beyond the current architecture.
- Do not add alternate parser backends.
- Do not mix this work with `Piscina` or other parallelization work.
- Do not rewrite fixture families unless the current fixtures truly block clear tests.

---

## Current Known Partials

### Go

Current state:
- imported function navigation works
- imported type navigation is still partial
- reference recovery is weaker for type-oriented cases than for function-oriented cases

Known symptoms:
- imported struct/interface lookups do not resolve as reliably as imported functions
- type references are not as consistently recovered across files

### C

Current state:
- function-oriented support is solid
- typedef/type-oriented references are still partial

Known symptoms:
- typedef-backed types can keep the definition anchor without recovering all real use-sites

### Kotlin

Current state:
- imported top-level function navigation works
- imported class/type navigation is still partial
- imported type/class references are still partial

Known symptoms:
- some imported class/type lookups return `not_found`
- some reference results keep the definition anchor without a distinct use-site

---

## Execution Order

Implement the work in this order:

1. Workstream A: Gap inventory and fixture audit
2. Workstream B: Go partial support closure
3. Workstream C: C partial support closure
4. Workstream D: Kotlin partial support closure
5. Workstream E: Native parity expansion for the closed gaps
6. Workstream F: Documentation update and final claim review

Do not update the matrix from `Partial` to `Yes` until Workstream E is complete for that language.

---

## Workstream A: Gap Inventory and Fixture Audit

### Goal

Make each partial capability concrete before changing code.

### Deliverables

- a precise gap list for `Go`, `C`, and `Kotlin`
- fixture reuse decisions
- any new fixtures needed to isolate missing behavior

### Implementation steps

1. Audit the current fixtures in:
   - `tests/samples/go`
   - `tests/samples/c`
   - `tests/samples/kotlin`

2. For each language, write down which of these currently work and which do not:
   - imported/shared function `goToDefinition`
   - imported/shared type/class/struct `goToDefinition`
   - function `findReferences`
   - type/class/struct `findReferences`

3. Confirm whether the current fixtures already express the missing behavior clearly.

4. If not, add one focused fixture per missing behavior.

Preferred fixture names:
- Go:
  - `types.go`
  - `interfaces.go`
- C:
  - `typedef-uses.c`
  - `typedef-uses.h`
- Kotlin:
  - `Models.kt`
  - `TypeConsumers.kt`

### Acceptance criteria

- each partial capability is mapped to one or more concrete failing-or-missing scenarios
- fixture needs are known before resolver changes begin

---

## Workstream B: Go Partial Support Closure

### Goal

Upgrade `Go` from partial to fully supported for the currently claimed semantic surface.

### Known target gaps

- imported struct navigation
- imported interface/type navigation if already extractable
- references for imported/shared types

### Deliverables

- stronger Go fixtures where needed
- dedicated Go navigation tests for imported types
- dedicated Go reference tests for imported/shared types
- implementation changes that make those tests pass

### Implementation steps

#### B1. Add or refine fixtures

Ensure the Go samples include:

- an imported function usage
- an imported struct usage
- an imported interface or named type usage if the current extractor exposes it
- at least one real cross-file type use-site

If needed, add a focused fixture file such as:
- `tests/samples/go/types.go`
- `tests/samples/go/type-consumer.go`

#### B2. Add tests first

Extend:
- `tests/goto.test.ts`
- `tests/references.test.ts`

Add explicit Go cases for:
- imported struct type navigation
- imported interface or named type navigation if support is intended
- references for exported/shared type names with at least one non-definition use-site

Also update:
- `tests/languages/parity.test.ts`

The parity runner should assert `ok`, not `not_found`, only after the dedicated tests pass.

#### B3. Fix implementation

Inspect:
- `src/indexer.ts`
- any Go-specific extraction or symbol classification in language definitions
- import-binding and reference recovery logic

Likely work areas:
- improve Go type-symbol extraction where imported type names are not being represented consistently
- ensure `goToDefinition` can map imported type identifiers through import bindings, not only function-call positions
- ensure `findReferences` tracks type occurrences as symbol uses, not just function identifiers

Do not special-case file names. Fix the semantic path.

#### B4. Add regression coverage

Once the implementation is fixed, add:
- a native semantic parity case for the new Go imported-type scenario

### Acceptance criteria

- Go imported type navigation passes in dedicated tests
- Go imported/shared type references include real use-sites
- Go native-vs-JS semantic parity stays equal for the newly closed cases

---

## Workstream C: C Partial Support Closure

### Goal

Upgrade `C` references from partial to fully supported for the currently claimed semantic surface.

### Known target gaps

- typedef-backed type references
- struct-type references where use-sites are currently weaker than function cases

### Deliverables

- focused typedef/type-use fixtures
- stronger dedicated C reference tests
- implementation changes that recover real use-sites instead of only the definition anchor

### Implementation steps

#### C1. Add or refine fixtures

Ensure the C sample set includes:
- typedef declaration in a header
- one or more use-sites in `.c` files
- struct/type usage in declarations, variable definitions, parameters, or returns

If current fixtures are too shallow, add:
- `tests/samples/c/typedef-uses.h`
- `tests/samples/c/typedef-uses.c`

Keep them small and explicit.

#### C2. Add tests first

Extend:
- `tests/references.test.ts`

Add dedicated C cases for:
- typedef-backed type references including non-definition use-sites
- struct/type references across header and implementation files

If `goToDefinition` for these types already works, keep it covered, but the main goal here is references.

Also update:
- `tests/languages/parity.test.ts`

Only promote the parity expectation after the dedicated tests pass.

#### C3. Fix implementation

Inspect:
- `src/indexer.ts`
- C language definitions and local/export query behavior
- the scope/reference collection logic

Likely work areas:
- classify typedef-backed declarations consistently as definitional symbols
- ensure use-sites of typedef names are indexed as occurrences
- ensure type references are not dropped just because they are not call-like or value-like identifiers

The implementation should recover actual semantic occurrences, not inflate counts artificially.

#### C4. Add regression coverage

Add:
- a native semantic parity case for the typedef/type-reference scenario once it works end to end

### Acceptance criteria

- C typedef/type references include real use-sites
- the language parity matrix can promote `C` references from `Partial` to `Yes`
- native-vs-JS parity holds for the newly closed type-reference case

---

## Workstream D: Kotlin Partial Support Closure

### Goal

Upgrade `Kotlin` from partial to fully supported for the currently claimed semantic surface.

### Known target gaps

- imported class/type navigation
- imported class/type references

### Deliverables

- stronger Kotlin fixtures for imported type/class usage
- dedicated Kotlin navigation and reference tests
- implementation changes that resolve imported classes/types and recover their real use-sites

### Implementation steps

#### D1. Add or refine fixtures

Ensure the Kotlin fixtures include:
- imported top-level function use
- imported class use
- imported type alias, enum, or object usage if already extractable
- at least one real non-definition use-site for an imported class/type

If the current fixtures are not enough, add:
- `tests/samples/kotlin/TypeConsumers.kt`
- `tests/samples/kotlin/Aliases.kt`

#### D2. Add tests first

Extend:
- `tests/goto.test.ts`
- `tests/references.test.ts`

Add explicit Kotlin cases for:
- imported class navigation
- imported type alias, enum, or object navigation where support is intended
- references for imported classes/types with at least one real use-site

Also update:
- `tests/languages/parity.test.ts`

Do not keep `Partial` expectations once the dedicated tests pass.

#### D3. Fix implementation

Inspect:
- Kotlin language definitions
- query normalization paths
- import-binding resolution logic
- reference collection logic in `src/indexer.ts`

Likely work areas:
- ensure Kotlin imported class/type names are extracted in a form navigation can resolve
- ensure the same imported names are visible to `findReferences`
- check whether current normalization or symbol classification drops class/type declarations or use-sites

Keep the fix aligned with the shared pipeline. Avoid a Kotlin-only alternate semantic path unless there is no shared-path option.

#### D4. Add regression coverage

Add:
- native semantic parity cases for imported Kotlin class/type lookups once they work

### Acceptance criteria

- Kotlin imported class/type navigation passes in dedicated tests
- Kotlin imported class/type references include real use-sites
- native-vs-JS parity remains equal for the newly closed cases

---

## Workstream E: Native Parity Expansion for Closed Gaps

### Goal

Ensure any newly closed partial capability behaves the same in native and JS-backed runs.

### Deliverables

- expanded `tests/native-semantic-parity.test.ts`
- any supporting helper updates

### Implementation steps

1. Add one case for each newly closed gap:
   - Go imported type navigation/reference
   - C typedef/type references
   - Kotlin imported class/type navigation/reference

2. For each case:
   - build native-enabled index
   - build forced-JS index
   - compare graph edges if relevant
   - compare symbols if relevant
   - compare `goToDefinition`
   - compare `findReferences`

3. Keep timeouts explicit if the suite grows enough to make the default timeout brittle.

### Acceptance criteria

- every newly closed partial behavior is protected by end-to-end native parity

---

## Workstream F: Documentation Update and Final Claim Review

### Goal

Only promote matrix entries once the tests prove it.

### Deliverables

- updated `docs/language-parity.md`
- updated `docs/scenario-catalog.md`
- minimal README update only if wording becomes misleading

### Implementation steps

1. Re-read:
   - `docs/language-parity.md`
   - `docs/scenario-catalog.md`
   - `tests/goto.test.ts`
   - `tests/references.test.ts`
   - `tests/native-semantic-parity.test.ts`

2. For each candidate promotion from `Partial` to `Yes`, verify:
   - there is a direct dedicated test
   - there is no remaining intentional limitation documented in the code or tests
   - native parity covers the behavior if the language uses the native path

3. Update the matrix conservatively:
   - promote `Go` only if imported type navigation and type references are truly resolved
   - promote `C` only if typedef/type references recover real use-sites
   - promote `Kotlin` only if imported class/type navigation and references are truly resolved

4. Add scenario-catalog rows for the new closed-gap cases.

5. Update README only if its wording still implies the old partial state.

### Acceptance criteria

- the parity matrix no longer shows `Partial` for a capability unless a real limitation remains
- every promoted claim is backed by direct tests

---

## Validation Checklist

After each workstream, run:

- `npm run build`
- focused tests for the touched area

Before merging the full effort, run:

- `npm run test:all`

Recommended focused commands:

- Go:
  - `npm test -- tests/goto.test.ts tests/references.test.ts`
  - `npm test -- tests/native-semantic-parity.test.ts`
- C:
  - `npm test -- tests/references.test.ts`
  - `npm test -- tests/native-semantic-parity.test.ts`
- Kotlin:
  - `npm test -- tests/goto.test.ts tests/references.test.ts`
  - `npm test -- tests/native-semantic-parity.test.ts`

---

## Likely File Touch List

Tests:

- `tests/goto.test.ts`
- `tests/references.test.ts`
- `tests/languages/parity.test.ts`
- `tests/native-semantic-parity.test.ts`

Implementation:

- `src/indexer.ts`
- language definitions under `src/languages/definitions/*`
- native query normalization only if needed for parity, not as a first resort

Fixtures:

- `tests/samples/go/*`
- `tests/samples/c/*`
- `tests/samples/kotlin/*`

Docs:

- `docs/language-parity.md`
- `docs/scenario-catalog.md`
- `README.md` only if needed

---

## Definition of Done

This plan is complete when all of the following are true:

- `Go` no longer has partial support for `Go-to-definition` or `Find references`
- `C` no longer has partial support for `Find references`
- `Kotlin` no longer has partial support for `Go-to-definition` or `Find references`
- the newly closed behaviors are covered by dedicated tests
- the newly closed behaviors are covered by end-to-end native semantic parity
- the parity matrix is updated conservatively and accurately
