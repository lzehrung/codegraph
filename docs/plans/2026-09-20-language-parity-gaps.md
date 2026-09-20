# Language parity: audit results and gap plan

Audit date: 2026-09-20. Source under audit: `docs/language-parity.md` at commit 110c7796 (86 flat note bullets, 28 matrix rows, 11 ecosystem rows).

## Audit result

Claim-level verification against `src/` and `tests/`:

- 86 note bullets: 70 accurate, 14 imprecise, 1 inaccurate, 1 unverifiable.
- 28 matrix rows: 26 correct, 2 wrong or unstated (Vue and Svelte `Native addon`, SQL `PR impact mapping`).
- 11 ecosystem rows: 8 correct, 3 wrong (Node.js, Java and Kotlin, .NET name extraction).
- 1 wrong ignore-default statement (`target/` claimed to cover Gradle; Gradle uses `build/`).
- 15 bullets restated another bullet, 1 was pure test inventory, and 1 carried a historical bug story.

The doc was rewritten into grouped capability sections: 86 bullets became 58, corrections applied, duplicates merged, trivia removed.

Documentation corrections applied in the first pass:

- Removed the false claim that `this.field` stays unresolved. `this.member` resolves through the implicit-receiver path (`src/indexer/navigation-goto.ts`, `tests/goto.test.ts`).
- Reduced mode: regex import recovery is JavaScript, TypeScript, and TSX only (`src/native/js-bridge.ts`).
- `exports` does not publish type members for every language; TypeScript, JavaScript, Zig, SQL, and PHP methods are exceptions.
- Fixed the Node.js, Java/Kotlin, and .NET project-name verdicts and the Gradle ignore statement.
- Repaired the fixture-matrix generator and regenerated `docs/benchmarks/fixture-snapshot.md`, stale since 2026-09-06 (256 recorded tests versus 477 actual).

## Gap resolution

All eleven gaps are closed. Each item lists what changed and the test that holds it.

### GAP-01: Go receiver method calls (done)

Go `method_declaration` now publishes a `member_of` edge to its receiver type, and receiver proof accepts `GoBox{}`, `&GoBox{}`, and `var b GoBox`, so `b.GoHelper()` emits a resolved `calls` edge. Changed `src/graphs/symbol-graph-detailed/{ast,edge-passes,receiver-calls}.ts` and `src/indexer/navigation-goto.ts`. `tests/receiver-call-edges.test.ts` covers value, pointer, and `var` receivers, same-name package function versus method, the same method name on two types, and the unproven interface and factory receivers. The Go limitation left the parity doc.

### GAP-02: Python receiver support (done, scope raised)

The audit's plan was to align the coverage diagnostic with navigation. Measurement showed navigation did not actually resolve any Python receiver form even though `supportsReceiverMemberResolution` accepted Python, so the capability was implemented instead. `self` and `cls` members, `__init__`-assigned attributes, unique inherited members, and constructor-assigned locals now resolve; the Python branch in `src/impact/member-resolution-coverage.ts` is gone. Held by `tests/goto.test.ts`, `tests/references.test.ts`, `tests/languages/python.test.ts`, and `tests/review.test.ts`, with negatives for factory-assigned and unannotated-parameter receivers and for a same-named module function.

### GAP-03: C# namespace alias resolution (done)

New `src/util/resolution/csharp.ts` indexes declared namespaces to files, mirroring `src/util/resolution/jvm.ts`, and `src/graphs/edge-resolution.ts` consults it before path-like resolution. A single declaring file also binds the alias, so member access navigates; a split namespace keeps the alias unresolved but still edges to every declaring file; external namespaces stay external. Cache clearing is wired into `clearImportResolutionCaches`, proven by a rebuild test that moves the declaring file. `extern alias X;` gained the missing fixture and is recognized without inventing an edge.

### GAP-04: SCSS navigation (done)

SCSS registers `isDeclarationName` and `scopeDeclarationNames`, and `goToDefinition` falls back to the same local lookup find-references uses. Same-file `$variable` reads, `@include` names, and `@extend %placeholder` resolve both ways. Namespaced `@use` members and selectors inside comments or strings stay `not_found`. Matrix cells moved to `Partial`/`Partial`, and the SCSS entries in `tests/native-semantic-parity.test.ts` moved from `not_found` to `ok`.

### GAP-05: TypeScript named function expressions (done)

`src/languages/definitions/typescript.ts` now registers the self-binding for `function_expression` and `generator_function`, shared by `.ts` and `.tsx`. The name stays inside the body: not exported, not resolvable from a sibling statement. Anonymous and arrow forms still bind nothing.

### GAP-06: C++20 modules (done)

No published `tree-sitter-cpp` release exposes module nodes (crates.io tops out at 0.23.4), so the grammar is pinned to upstream revision `8b5b49eb196bec7040441bee33b2c9a4838d6967`, which builds against the existing `tree-sitter` 0.25.10 pin because its `tree-sitter` 0.26 dependency is optional and unused. `export module foo;` publishes the module name, first-party `import foo;` resolves to the declaring file, and `import std;` stays external. `Cargo.lock` was regenerated by cargo, `unicode-ident` is unchanged, and the existing C and C++ suites plus native semantic parity still pass.

Risk to watch: this is a git dependency rather than a registry release, so native builds need Git access to that revision until the grammar ships a release that includes modules.

### GAP-07: SQL object-level impact (done)

Changed SQL statements now map to the objects they define, so a changed `CREATE TABLE users` yields a changed symbol and reaches only files that read it, carrying a symbol-level reason from the `sql:*` edge. An unreferenced object in the same file no longer fans out, and unmapped statements keep the file-level fallback. Matrix cell moved from `Partial` to `Yes`. Held by `tests/impact-analyzer.test.ts`.

### GAP-08: Fixture matrix gate (done)

`npm run bench:fixtures:check` runs in the `build-and-test` job of `.github/workflows/on-demand-ci.yml`, next to the other artifact checks, so a new unmapped `tests/languages/<stem>.test.ts` or a stale snapshot fails CI. The stale message now names which artifact drifted. The generated snapshot JSON is Prettier-ignored because the freshness gate compares the generator's own output.

### GAP-09: Fixture-thin claims (done, one claim corrected)

- Ruby `extend` and `prepend` mixin edges now have parity fixtures alongside `include`.
- Java `record ... implements` and C# `record class`/`record struct` base lists are fixture-proven.
- The C++ `Ns::Base` qualifier exclusion has a fixture where the qualifier names a real indexed class.
- SQL `CREATE FUNCTION` has a routine-symbol and navigation fixture.
- Reduced-mode call hierarchy has a test for the `capability: "graph"` medium-confidence downgrade.
- C# `extern alias` has a fixture (see GAP-03).
- The C receiver limitation is now locked by a struct function-pointer test in `tests/receiver-call-edges.test.ts`.
- Corrected claim: C# positional record components produced no symbol while Java's did. Rather than weaken the doc, the C# locals query gained the record `parameter_list` capture so both languages behave the same.

### GAP-10: Dead SQL schema symbol (done)

`sql_current_schema` had no producer and no consumer; it is removed, and the artifact-graph test now asserts the node and edge kinds the fixture actually emits instead of the dead one.

### GAP-11: Cross-document duplication (done)

The verbatim C/C++ resolution-hints section in `docs/scenario-catalog.md` is replaced by a pointer to the parity doc, and the catalog header now states the ownership rule: the parity doc is the claim of record, and each catalog row names the fixture and the behavior it locks. The remaining overlaps are Expected-behavior cells that describe what a fixture asserts, which is the column's purpose; they were left intact rather than reworded into vaguer text.

## Follow-ups not taken here

- Cross-file SCSS navigation and `@use` namespace members need a namespace model, not a hook.
- `tree-sitter-cpp` should move back to a registry release once one ships the C++20 module nodes.
- SQL call compatibility stays out of scope: SQL has no callables.
