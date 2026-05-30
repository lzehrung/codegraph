# Method Local Symbol Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Completed on `method-local` and merged to `main` in #112. This file now records the completed checklist and verification surface; the original baseline-only assertions were replaced by permanent regression tests.

**Goal:** Add method-level changed-symbol support only where the index, navigation, and impact model can prove it without broadening false positives.

**Architecture:** The current changed-symbol path is index-driven: `locateChangedSymbols()` can only emit a changed symbol when the matching declaration exists in `mod.locals`. JavaScript and TypeScript method names are recognized during impact attribution, but they are not stored as locals, so method edits fall back to the containing class.

**Tech Stack:** TypeScript, Tree-sitter language definitions, native query results, scope fallback indexing, Vitest, Codegraph impact and navigation APIs.

---

## Current Finding

Class methods are not emitted as method-level changed-symbol locals for the JavaScript and TypeScript path that motivated the PR reply. The index model only lets `src/impact/map.ts` emit a changed symbol after it resolves the changed AST node to a `SymbolDef` in `index.byFile.get(file)?.locals`.

The relevant flow is:

- `locateChangedSymbolsWithLines()` gathers changed AST nodes and calls `findSymbolHandleForNode()`.
- `findSymbolHandleForNode()` checks exact declaration-name positions first.
- If the declaration-name position is not tracked in `mod.locals`, it climbs ancestors with `findTrackedDeclarationNameInAncestors()`.
- The final emitted `ChangedSymbol` is built from the matching `SymbolDef` local.

The JavaScript and TypeScript language definitions already mark class method names as declaration names. This is intentional: `src/languages/definitions/javascript.ts` includes `method_definition`, and `src/languages/definitions/typescript.ts` includes `method_definition`, `method_signature`, and `abstract_method_signature` in `isDeclarationName()`.

Those declaration-name hooks do not create locals. For JS/TS locals today:

- `src/indexer/shared.ts` excludes `js`, `ts`, and `tsx` from `QUERY_DRIVEN_LOCALS_LANGUAGES`, so they normally use `buildScopeIndexFromSource()`.
- `src/indexer/scope.ts` adds declarations for functions, classes, variables, and several non-JS method node types, but not `method_definition`.
- The JS/TS `graph.locals` query strings also list functions, classes, variables, and TS type/interface declarations, but not `method_definition`.
- `tests/detailed-symbol-native-only.test.ts` has a TS class with `run()` and asserts only `Service` and `helper` are locals.

This explains the current fallback behavior. `tests/parser-efficiency-fixes.test.ts` explicitly verifies that a JS or TS method-body edit is attributed to the enclosing class because methods are not tracked as separate locals.

## Call Compatibility Implication

`src/impact/callCompatibility.ts` attaches hints only for changed symbols whose `signatureChanged` flag is set and whose kind is `Function`, `Default`, or `Variable`. A JS/TS method edit currently becomes a class changed symbol, and `Class` is intentionally not treated as callable.

Adding method locals is necessary but not sufficient for useful method call compatibility. `findReferences()` must also find member callsites like `new Service().run(1)` or `service.run(1)` for the method `run`.

Today, cross-file reference discovery is export/import oriented. A class method local named `run` would usually not be exported on its own, and matching all property identifiers named `run` would be unsafe without receiver-aware validation.

## Language Survey

This survey is based on `src/languages/definitions/*.ts`, `src/indexer/shared.ts`, `src/indexer/scope.ts`, and the language parity tests.

| Language group                     | Method/member local status                                                                                                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JavaScript                         | Class `method_definition` is chunked and declaration-aware, but not emitted as a local. Assigned callables in `const fn = () => {}` are emitted as variables.                                                                                                     |
| TypeScript/TSX                     | Same as JavaScript, plus interfaces and type aliases are locals. `method_signature` and `abstract_method_signature` are declaration-aware but not locals.                                                                                                         |
| Python                             | `function_definition` is query-driven and not top-level constrained, so class methods can be emitted as function locals. Lambdas are function scopes but not named locals.                                                                                        |
| PHP                                | `method_declaration` and `property_element` are locals. Constructors should follow method behavior when represented as `method_declaration`, but this needs fixture confirmation.                                                                                 |
| Go                                 | Scope fallback includes `method_declaration`, so receiver methods can be locals. Graph local queries list parameters too, but Go is not query-driven today.                                                                                                       |
| Java                               | `method_declaration` and `variable_declarator` are locals. `constructor_declaration` is chunked and scoped but not listed in locals.                                                                                                                              |
| C#                                 | `method_declaration` and `variable_declarator` are locals. `property_declaration` is exported but not listed in locals, and constructors are not locals.                                                                                                          |
| Kotlin                             | Query locals include class/object declarations, function declarations, property declarations, enum entries, parameters, class parameters, and type parameters. Member functions and properties are likely emitted because the query is not top-level constrained. |
| Swift                              | Query locals include class/protocol declarations, functions, properties, protocol functions, protocol properties, and parameters. Initializers, deinitializers, and subscripts are chunks/scopes but not locals.                                                  |
| Ruby                               | Scope fallback includes `method` and `singleton_method`, plus class/module and assignments. The graph locals query does not include `singleton_method`, but Ruby is not query-driven today.                                                                       |
| Rust                               | Query locals include `function_item`, structs, traits, enums, consts, statics, lets, and parameters. Impl methods are likely covered when represented as `function_item`; struct fields are not locals.                                                           |
| C                                  | Scope fallback plus C-family helpers capture functions, structs, enums, typedefs, declarations, parameters, fields, and macros. C has no class method concept.                                                                                                    |
| C++                                | Query locals include functions, declarations, fields, classes, structs, enums, namespaces, aliases, and typedefs. Constructor, destructor, operator, and in-class method declaration coverage should be verified before claiming parity.                          |
| Zig                                | Functions and variable declarations are locals. Struct-associated functions are likely covered as function declarations, but this should be verified with a fixture.                                                                                              |
| HTML/CSS/SCSS/Less/Vue/Svelte/docs | These are graph/chunking-focused or special-case impact mappings, not general semantic local-symbol surfaces. They should not drive method-local claims.                                                                                                          |

Existing tests provide broad language parity for top-level exported symbols, imports, goto, and references. They are thinner for member-local extraction, constructor locals, property locals, anonymous callables, and assigned callables.

## Agentic Coding Value

This is a precision upgrade for review and impact packets. Agents need changed-symbol reports to name the smallest safe unit; class-level fallback makes method edits look broader than they are and prevents method signature changes from feeding call compatibility.

The highest-value path is:

1. emit JS/TS method locals safely;
2. map method body and parameter edits to method changed symbols;
3. add receiver-aware references for high-confidence method callsites;
4. attach method call compatibility hints only for verified callsites.

Do not add name-only reference matching. Common method names such as `run`, `handle`, and `render` are too ambiguous across classes.

## Implementation Approach

The safe implementation is two-phase.

Phase 1 adds JS/TS method locals without promising member call compatibility:

- Treat `method_definition` as a `Function` local in `src/indexer/scope.ts`.
- Keep `SymbolKind` unchanged unless a wider API change is approved.
- Update JS/TS `classifyDefinition()` helpers so method declarations classify as functions.
- Optionally add `method_definition` to JS/TS `graph.locals` for future query-driven parity, but keep current runtime behavior anchored in scope fallback.
- Update `tests/parser-efficiency-fixes.test.ts` expectations so method body edits map to method locals, not classes, once method locals exist.

Phase 2 makes method locals useful for call compatibility:

- Add receiver-aware method reference tests before implementation.
- Extend JS/TS member resolution in `src/indexer/navigation-goto.ts` to resolve class instance member calls to method locals only when the receiver type/class can be inferred with high confidence.
- Extend `findReferences()` or add a method-specific reference helper so call compatibility can inspect verified member callsites.
- Keep unresolved or low-confidence receivers out of call compatibility hints.
- Document limitations for constructors, overloads, interface-only signatures, getters/setters, private fields, and class-property arrow methods.

## Risks

Method names are commonly duplicated across classes. A naive name-only reference scan would over-report `run`, `handle`, `render`, and similar methods across unrelated types.

Constructor support is different from method support. A constructor declaration is named `constructor` in JS/TS syntax, but the callsite is `new ClassName(...)`, so signature and callsite matching need a class-to-constructor bridge.

TypeScript overloads and abstract/interface method signatures can have no body. The index may see declarations that cannot be compared safely to runtime callsites without more type information.

Adding method locals changes public-ish output shape. Symbol counts, changed-symbol summaries, review packets, impact reports, and cached graph artifacts may all show more symbols.

## Implementation Checklist

### Task 1: Capture Current Baseline

**Files:**

- Read: `src/indexer/scope.ts`
- Read: `src/languages/definitions/javascript.ts`
- Read: `src/languages/definitions/typescript.ts`
- Read: `src/impact/map.ts`
- Read: `tests/parser-efficiency-fixes.test.ts`

- [x] Run `npm run test:run -- tests/parser-efficiency-fixes.test.ts`.
- [x] Add a temporary local assertion or focused test proving TS `run()` is not in `moduleIndex.locals`.
- [x] Remove the temporary assertion before committing, or convert it into the failing regression in Task 2.

Completion note: the temporary baseline assertion was not retained. The completed branch converted the behavior into persistent method-local regression coverage in `tests/parser-efficiency-fixes.test.ts` and `tests/method-local-symbols.test.ts`.

### Task 2: Add JS/TS Method Locals

**Files:**

- Modify: `src/indexer/scope.ts`
- Modify: `src/languages/definitions/javascript.ts`
- Modify: `src/languages/definitions/typescript.ts`
- Test: `tests/parser-efficiency-fixes.test.ts`
- Test: nearest symbol extraction test, likely `tests/detailed-symbol-native-only.test.ts` or a new focused indexer test

- [x] Add `method_definition` to the declaration branch in `buildScopeIndexFromSource()`.
- [x] Ensure `method_definition` declarations use the same `Function` symbol kind as other callables.
- [x] Update JS/TS `classifyDefinition()` to return `function` for method definitions.
- [x] Add or update a test showing `Service.run` appears in locals by name and start position.
- [x] Update the method-body changed-symbol tests so the changed symbol is `add` or `fetchUser`, not only `Calculator` or `UserService`.

### Task 3: Prove Signature Detection Still Works

**Files:**

- Modify: `tests/parser-efficiency-fixes.test.ts`
- Possibly modify: `tests/impact.test.ts`

- [x] Add a JS or TS method parameter-change test.
- [x] Assert `signatureChanged` is true when a method parameter list changes.
- [x] Assert `signatureChanged` is false when only a method body changes.
- [x] Keep the existing function signature tests unchanged.

### Task 4: Add Member-Aware References Before Method Call Compatibility

**Files:**

- Modify: `src/indexer/navigation-goto.ts`
- Modify: `src/indexer/navigation-references.ts`
- Test: `tests/goto.test.ts`
- Test: `tests/references.test.ts`
- Test: `tests/native-semantic-parity.test.ts` if native and JS paths both claim the behavior

- [x] Add a fixture where `new Service().run(1)` resolves to `Service.run`.
- [x] Add a fixture where `const service = new Service(); service.run(1)` resolves only if the receiver inference is implemented.
- [x] Add a negative fixture with two unrelated classes that both define `run()`.
- [x] Do not return a method reference when receiver inference is ambiguous.

### Task 5: Attach Method Call Compatibility Hints

**Files:**

- Modify: `src/impact/callCompatibility.ts` only if the existing callable filter or extraction is insufficient
- Modify: `tests/impact.test.ts` or add a focused call-compatibility impact test

- [x] Create a JS/TS diff where a method parameter is added.
- [x] Assert the changed symbol is the method local and has `signatureChanged`.
- [x] Assert a verified callsite with too few arguments receives `likely_mismatch`.
- [x] Assert an unrelated same-name method call does not receive a hint.

### Task 6: Update Public Documentation If Behavior Changes

**Files:**

- Modify: `docs/language-parity.md`
- Modify: `docs/scenario-catalog.md`
- Modify: `docs/cli.md`, `docs/library-api.md`, and `docs/agent-workflows.md` if impact output contracts change
- Modify: `codegraph-skill/codegraph/SKILL.md` if CLI commands, flags, or capabilities change

- [x] Document the exact JS/TS method-local support claim.
- [x] Document intentional exclusions, especially constructors, overloads, abstract/interface signatures, getters/setters, and ambiguous receivers.
- [x] Keep README changes minimal unless the public support summary changes.

Completion note: the public docs split the claim between broad method-like local indexing and JS/TS-only receiver-aware references/call compatibility. `README.md` did not need a table-of-contents or workflow update because no README section or first-run guidance changed.

## Verification Guidance

Run focused tests first:

```powershell
npm run test:run -- tests/parser-efficiency-fixes.test.ts
npm run test:run -- tests/detailed-symbol-native-only.test.ts
npm run test:run -- tests/goto.test.ts tests/references.test.ts
```

Run broader gates after focused behavior is green:

```powershell
npm run lint
npm run test:fast
```

Run native parity when member resolution or source-language support claims change:

```powershell
npm run test:integration
```

For this markdown-only planning artifact, a lightweight check is enough:

```powershell
npx prettier --check docs/superpowers/plans/2026-05-27-method-local-symbol-support.md
git diff -- docs/superpowers/plans/2026-05-27-method-local-symbol-support.md
```

## Non-Goals

- Do not add unsafe name-only method call compatibility.
- Do not introduce a new `SymbolKind.Method` unless the API and docs update are explicitly scoped.
- Do not claim constructor or overload support until dedicated tests prove the behavior.
- Do not update public support docs in the planning-only change that created this file.
