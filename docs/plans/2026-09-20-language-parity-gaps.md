# Language parity: audit results and gap plan

Audit date: 2026-09-20. Source under audit: `docs/language-parity.md` at commit 110c7796 (86 flat note bullets, 28 matrix rows, 11 ecosystem rows).

## Audit result

Claim-level verification against `src/` and `tests/`:

- 86 note bullets: 70 accurate, 14 imprecise, 1 inaccurate, 1 unverifiable.
- 28 matrix rows: 26 correct, 2 wrong or unstated (Vue and Svelte `Native addon`, SQL `PR impact mapping`).
- 11 ecosystem rows: 8 correct, 3 wrong (Node.js, Java and Kotlin, .NET name extraction).
- 1 wrong ignore-default statement (`target/` claimed to cover Gradle; Gradle uses `build/`).
- 15 bullets restated another bullet, 1 was pure test inventory, and 1 carried a historical bug story.

The doc has been rewritten into grouped capability sections: 86 bullets became 58, corrections applied, duplicates merged, trivia removed.

Corrections already applied in the same change:

- Removed the false claim that `this.field` stays unresolved. `this.member` resolves through the implicit-receiver path (`src/indexer/navigation-goto.ts:162-180`, `tests/goto.test.ts:685-709`).
- Named function expression self-binding is JavaScript only (`src/languages/definitions/javascript.ts:172-183`); TypeScript and TSX do not register it.
- Receiver member navigation includes Python (`src/indexer/navigation-goto.ts:268-281`); only the impact coverage diagnostic excludes it (`src/impact/member-resolution-coverage.ts:36`).
- Reduced mode: regex import recovery is JS/TS/TSX only (`src/native/js-bridge.ts:5-7`).
- SCSS is not graph-only in native parity: declaration references are `ok` while go-to-definition stays `not_found`.
- `exports` does not publish type members for every language; TypeScript, JavaScript, Zig, SQL, and PHP methods are exceptions.
- Fixed Node.js, Java/Kotlin, and .NET project-name verdicts and the Gradle ignore statement.
- Repaired the fixture-matrix generator (`scripts/benchmarks/generate-fixture-matrix.mjs`) and regenerated `docs/benchmarks/fixture-snapshot.md`, which had been stale since 2026-09-06 (256 recorded tests versus 477 actual).

## Addressable gaps

Ranked by user-visible value. Each item removes a documented limitation or an unstated condition rather than restating it.

### GAP-01: Go receiver method calls emit no edges

- Current: `b.GoHelper()` produces no `calls` edge, so `callers`, `callees`, and impact miss every Go method call site. Documented as intrinsic, but the root cause is extraction, not the language.
- Cause: Go `method_declaration` never reaches `MEMBER_CONTAINER_TYPES`, so no `member_of` edge ties a method to its receiver type (`src/graphs/symbol-graph-detailed/ast.ts`, `edge-passes.ts`).
- Change: emit `member_of` from the receiver type to the method during detailed extraction, and teach `receiverConstructorExpression` (`src/indexer/navigation-goto.ts`) Go composite literals (`b := GoBox{}`) and `&GoBox{}`.
- Acceptance: `tests/receiver-call-edges.test.ts` proves a Go receiver call edge and keeps free-function calls resolved; the Go clause leaves the parity doc; `CORE_ALGORITHM_EPOCH` is bumped.

### GAP-02: Python receiver coverage contradicts itself

- Current: navigation resolves Python receivers, but `computeMemberResolutionCoverage` hard-codes Python into `limitedLanguages` with a "until that lookup path has direct semantic coverage" comment.
- Change: add direct Python semantic coverage for constructor-assigned and `self` receivers in `tests/goto.test.ts` and `tests/references.test.ts`; when it passes, drop the Python exclusion in `src/impact/member-resolution-coverage.ts:36`. If the coverage cannot be made to pass, keep the exclusion and record the failing forms instead.
- Acceptance: one statement holds for both surfaces, and `tests/review.test.ts:124-125` is updated with the decision.

### GAP-03: C# namespace alias never resolves to a first-party file

- Current: `using X = Some.Namespace;` stays external; only type aliases resolve. Java and Kotlin already index package-to-file mappings (`src/util/resolution/jvm.ts:127`).
- Change: add `src/util/resolution/csharp.ts` that indexes `namespace_declaration` and `file_scoped_namespace_declaration` to files, and branch to it from `src/graphs/edge-resolution.ts`.
- Acceptance: `tests/languages/csharp.test.ts` resolves a first-party namespace alias to its file and keeps `using Col = System.Collections.Generic` external.

### GAP-04: SCSS go-to-definition and same-file uses

- Current: find references returns the declaration only, and go-to-definition returns `not_found` even on a declaration, because SCSS registers no `isDeclarationName` or scope hooks.
- Change: route SCSS go-to-definition through the same `localAtPosition` path find-references uses, and add `isDeclarationName` so same-file `$var` reads and `@include` uses resolve. Namespaced `@use` members (`b.$brand`) need a namespace model and stay out of scope.
- Acceptance: `tests/languages/scss.test.ts` proves declaration go-to-definition and at least one same-file use reference; the matrix cell moves from `No`/`Partial` only if both pass. Bump `LANGUAGE_BEHAVIOR_EPOCH`.

### GAP-05: TypeScript named function expressions do not self-bind

- Current: `const f = function inner() {}` binds `inner` in JavaScript but not in TypeScript or TSX.
- Change: add the `function_expression`/`generator_function` parents to `isDeclarationName` and `scopeDeclarationNames` in `src/languages/definitions/typescript.ts`, plus the locals capture.
- Acceptance: `tests/languages/typescript.test.ts` resolves a self-recursive named function expression; bump `LANGUAGE_BEHAVIOR_EPOCH`.

### GAP-06: C++20 modules are invisible

- Current: `export module foo;` and `import std;` publish no symbols and create no edges; the pinned `tree-sitter-cpp` 0.23.4 has no module nodes. Upstream revision `8b5b49e` exposes them.
- Change: upgrade the pinned grammar, then add module declaration and import extraction plus dependency edges.
- Acceptance: `tests/languages/cpp.test.ts` indexes a module declaration and a module import edge; the limitation leaves the parity doc. Blocked on the grammar bump.

### GAP-07: SQL impact is file level only

- Measured 2026-09-20 on a throwaway repo (`db/schema.sql` read by `db/report.sql`, plus a TypeScript control). The SQL change produced `changedSymbols: []`, one impacted file with `reasons: ["fileLevelChange"]`, `diagnostics.changedFilesWithoutSymbols: 1`, no call-compatibility hints, a low-confidence `breakingChange` suggestion, and a pattern-matched candidate test. The TypeScript control produced changed symbols, `directRef`/`importAlias` reasons, `refsCount`, two call-compatibility hints, `exportChanged`/`signatureChanged` explain hints, an export summary, and a high-confidence candidate test. Editing an unreferenced table in the same file impacted the same dependent, so fan-out is whole-file.
- Conclusion: `Partial` is the right cell. The condition is now stated in the SQL section of the parity doc.
- Change to close it: map indexed SQL objects into `changedSymbols` so a changed object reaches only its readers, with `sql:*` edge reasons instead of `fileLevelChange`.
- Acceptance: `tests/impact-analyzer.test.ts` proves that editing one object impacts its readers and that editing an unreferenced object in the same file does not; the matrix cell moves to `Yes` only when both hold.

### GAP-08: The fixture matrix can go stale silently

- Current: `npm run bench:fixtures:check` is not part of `npm run check` or a CI job, so the generated snapshot drifted for two weeks and the generator failed on an unmapped test stem.
- Change: run `bench:fixtures:check` in the docs or build workflow, or add it to `npm run check`.
- Acceptance: adding a new `tests/languages/<name>.test.ts` without regenerating fails CI with the generator's message.

### GAP-09: Claims that are code-true but fixture-thin

Each of these is currently stated in the parity doc or implied by it, and would become provable with one focused test:

- Ruby `extend` and `prepend` mixin edges (`src/graphs/symbol-graph-detailed/edge-passes.ts:638`) have no hierarchy fixture.
- A Java or C# `record` with a base list has no type-hierarchy fixture.
- The C++ `Ns::Base` qualifier exclusion is implemented but only Java, C#, and Ruby qualifiers are exercised.
- SQL routine symbols (`CREATE FUNCTION`) have no fixture under `tests/samples/sql`.
- C# `extern alias` has query support and no fixture.
- Reduced-mode call hierarchy has no test; the provenance downgrade is only code-supported.
- The C entry in the receiver-gap statement is code-true but not locked by `tests/receiver-call-edges.test.ts`.

### GAP-10: Dead SQL schema symbol

- `src/sql/graph.ts:14` declares `sql_current_schema`, and nothing produces or consumes it. Remove it or implement schema inference explicitly.

### GAP-11: Cross-document duplication

`docs/scenario-catalog.md` repeats capability sentences that `docs/language-parity.md` owns: the HTML asset-walker sentence, the C# constructor exclusion, the Rust trait declaration ambiguity, the Swift `init`/`deinit`/`subscript` exclusion, the Python binding-form list, and the `.sass` exclusion. The duplicated C/C++ resolution-hints paragraph is already replaced by a pointer.

- Rule to apply: the parity doc states the capability; the scenario catalog names the fixture and the observable behavior it locks. When the two disagree, the parity doc is the claim of record.
- Change: reword those catalog rows to describe the fixture rather than restate the rule.
