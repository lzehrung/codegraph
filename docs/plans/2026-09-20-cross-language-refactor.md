# Cross-language refactor, gaps, and edge cases

Audit date: 2026-09-20, against `main` at `bafe130c` (the commit that closed the parity gaps). Scope: the 28 registered languages, the shared indexer and graph pipeline, the resolution layer, and the extraction and reduced-mode paths. Findings come from five parallel read-only audits plus four defects the author reproduced directly.

Severity meaning:

- **P0** wrong results a user would notice, or a capability the matrix implies that does not exist.
- **P1** divergent behavior between languages with no stated reason, or duplication that has already drifted.
- **P2** cosmetic duplication, dead entries, or a documented limit worth revisiting.

## Reproduced defects

These four were confirmed by running the code, not by reading it.

| Probe                                                                          | Result                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `buildSymbolGraphDetailed` on `class Child extends Base`                       | `js` produced 0 inheritance edges, `ts` produced 1                  |
| `maskJsLikeCommentsAndStrings` on a Go raw string ending in `\`                | everything after the literal, including `import "x"`, was blanked   |
| Same masker on C# `var s = @"C:\";`                                            | the following `using A = B.C;` line was blanked                     |
| `maskPythonCommentsAndStrings` on `# don't` followed by `import os`            | the `import os` line was blanked                                    |
| `buildProjectIndex` on a C++20 `export module widget;` + `import widget;` pair | external without `graph.resolutionHints`, file edge only with hints |

## P0

### P0-1 JavaScript classes produce no inheritance edges

`emitClassInheritanceEdges` looks for `extends_clause` (`src/graphs/symbol-graph-detailed/edge-passes.ts:713`), which only the TypeScript grammar emits; `tree-sitter-javascript` produces `class_heritage > extends`. Consequence: JS `supertypes`, `subtypes`, and `implementations` return nothing, and `super.m()` emits no `calls` edge because the supertype walk follows `extends` edges (`receiver-calls.ts:431-434`). The parity matrix lists JavaScript as fully supported and the receiver bullet names JavaScript in the fixture set.

Fix: accept `class_heritage` in the JS branch, and lock it with a JS `super.shared()` case beside the TypeScript one in `tests/receiver-call-edges.test.ts` plus a JS row in `tests/type-hierarchy-language-parity.test.ts`. Effort S.

### P0-2 Trivia maskers silently blank real code

One trailing backslash inside a Go raw string, or a C# verbatim string ending in `\`, or an apostrophe in a Python comment, blanks the rest of the file for whichever consumer uses that masker. Consumers include import-binding attribution (`src/indexer/imports/binding-ranges.ts:132`), specifier extraction (`src/util/specifiers.ts:78,243`), duplicate masking (`src/duplicates/units.ts:249,406`), and Python import scanning (`src/indexer/imports/python.ts:198,223,269,280`).

Root cause: six independent maskers, each covering a different subset of string forms, with languages routed to whichever one their code path happens to call. `maskCsharpTrivia` (`src/util/resolution/csharp.ts:41`) already implements verbatim and raw strings correctly but is private to the resolver, so C# import bindings still use the JS masker.

Fix: one offset-preserving lexer driven by a per-language table (`lineComment`, `blockComment{open,close,nested}`, `strings[{open,close,escape,doubled,rawPrefix,hashes,interpolation}]`) declared on `LanguageDefinition`. Migrate all six implementations, then delete `maskNestedBlockCommentsAndStrings` (already unreachable) and `stripCssComments`. Effort M, and it subsumes P1-6 through P1-11.

### P0-3 C++20 module imports resolve only through resolution hints

`import widget;` stays external unless `graph.resolutionHints` names the directory; there is no index from a declared module name to the file that declares it. The parity doc now claims a first-party `import foo;` resolves to the declaring file, which is only true with hints.

Fix: index `module_declaration` names the way C# namespaces are indexed (see P1-1), and correct the parity sentence in the same change. Effort M. This is a published claim, so it should lead the next change.

### P0-4 `membersAreImplicitlyInScope` defaults to true

`src/languages.ts:52` applies `?? true`. Only js, ts, python, php, go, and rust set it explicitly to false, so Zig inherits unqualified member visibility it does not have, and every graph-first stub carries a member-resolution default it never uses.

Fix: default to false, set true explicitly on java, csharp, kotlin, swift, ruby, and cpp, bump `LANGUAGE_BEHAVIOR_EPOCH`. Effort S.

### P0-5 Reduced mode leaves five text parsers unused

`supportsReducedModeRegexRecovery` is js/ts/tsx only (`src/native/js-bridge.ts:5-7`), yet pure-text parsers already exist for Java, Kotlin, Rust, C#, and PHP (`src/languages/import-statement-parsers.ts`), and Java, Kotlin, Rust, and Python already recover through the indexer path (`src/indexer/imports/language-specific.ts:105,157,529`, `src/indexer/imports/python.ts:265`). The graph path returns nothing for them, and C#, PHP, Swift, Go, C, C++, Zig, Ruby, and SCSS recover nothing anywhere. The parity doc understates Java, Kotlin, Rust, and Python and overstates nothing, so the code and the doc are both wrong in different directions.

Fix: add a `textImport(source, sink)` definition hook called from both `collectModuleSpecifiersFromSource` and `finalizeLanguageSpecificImports`; wire the five existing parsers, then the mechanical one-regex languages. Rust needs `scanRustImportStatements` moved out of the indexer first. Effort M.

### P0-6 Symbol indexes ignore registered file extensions

`matchExts` and the resolver globs disagree: Kotlin registers `.ktm` but the JVM index globs `**/*.kt` and `**/*.kts` (`src/util/resolution/jvm.ts:103`); PHP registers `.phtml`, `.php4`, `.php8` but Composer and path-like resolution use `.php` only (`src/util/resolution/php.ts:36`, `php-composer.ts:137`); Ruby path-like resolution uses the default `.rb` list. Files in those extensions are indexed as their language but never enter the package or namespace index, so first-party imports to them stay external.

Fix: derive the language-scoped candidate and glob lists from `supportById(id).matchExts`, minus a declared non-importable set (`.pyw`, `.rbw`, `.rake`, `.gemspec`). Effort S.

### P0-7 Languages with no first-party module resolver

`resolveImportSpecifier` special-cases go, kotlin, java, php, rust; `edge-resolution.ts` adds python, csharp, ruby. Swift, Zig, C, and C++ have none, so `import Foo`, `@import("foo")`, and `#include "x.h"` resolve only when a literal path or a resolution hint matches.

Fix: decide per language rather than in bulk. Swift has real module identity through `Package.swift` targets; Zig has `build.zig`; C and C++ have include roots, which is what `graph.resolutionHints` already models and should be documented as the answer. Effort L; P0-3 is the first slice.

### P0-8 PHP named receivers fall back to bare-name resolution

PHP is absent from `supportsReceiverMemberResolution`, so the `not_found` guard at `src/indexer/navigation.ts:253` does not apply and `$box->helper()` resolves as a bare identifier. With `use function Imported\helper;` in scope, the call navigates to the imported function: a wrong target, not a missing one. `assignment_expression` is also absent from the binding-declaration set, so `$box = new Box();` proves nothing.

Fix: include PHP in the guard, and recognize `assignment_expression` as a binding declaration. Effort M.

### P0-9 A receiver reassigned after construction keeps the stale type

`findPriorNewConstructorInContainer` aborts only when it recognizes a second constructor (`src/indexer/navigation-goto.ts:480-500`), and `constructorFromAssignmentLike` parses assignments only for ruby, rust, and python. So `let l = new Lib(); l = other(); l.target();` still attributes `target` to `Lib` in JS/TS, Java, C#, and Go: a wrong `calls` edge and a wrong goto target.

Fix: treat any prior assignment to the receiver name as conflicting proof unless it proves the same constructor, for every language. Effort M.

### P0-10 No language models declaration visibility except Python

Java `private`, C# `internal`, Kotlin `private`, Swift `fileprivate`, and Rust non-`pub` items are all published as importable module symbols. No `visibility_modifier`, `private`, or `pub` check exists under `src/languages`. Python's `__all__` and `_` prefix are the only export filters.

Fix: an optional `isExportedDeclaration(node)` hook consulted next to `exportScopeBlockers`, implementing Rust `pub`/`pub(crate)` and the JVM-family modifiers first. Effort M. This changes cross-module resolution, so it needs a `CORE_ALGORITHM_EPOCH` bump and a careful pass over existing export expectations.

### P0-11 C# method parameters are not locals

`src/languages/definitions/csharp.ts:82-96` captures record `parameter_list` and `declaration_pattern` but no method or constructor `(parameter name: (identifier) @name)`, while Java captures `formal_parameter` and Kotlin captures `parameter`. Because C# sets `usesQueryDrivenLocals`, the scope-walk fallback never fills them, so C# parameters are missing from symbol lists, rename, and impact while their Java and Kotlin equivalents are present.

Fix: add the capture; the C# `isDeclarationName` already accepts `parameter`. Effort S.

## P1

### P1-1 One declared-container index for JVM packages, C# namespaces, PHP namespaces, and C++ modules

`project-symbols.ts` exports a builder that assumes one container per file, so C# and PHP copy its scan loop to register several (`src/util/resolution/csharp.ts:169-195`, `php.ts:70-96`). The lookup is the same `filesByPackage.get(spec)` in all three.

Fix: `buildDeclaredContainerIndex(projectRoot, globs, readContainers)` where `readContainers` returns the container names and optional symbols per file. JVM supplies one, C# and PHP many, and C++20 module names become the fourth caller (P0-3). Effort M.

### P1-2 Java and Kotlin import resolution are copy-pasted

`resolveJavaImportPath` and `resolveKotlinImportPath` (`src/util/resolution/jvm.ts:137-202`) differ only in bare-package handling and a Java filename fallback. Effort S to merge behind one function with options.

### P1-3 Receiver keywords are declared twice and the three receiver capability sets disagree

`implicitClassReceiver` (`navigation-goto.ts:164-167`) and `RECEIVER_KEYWORDS` (`receiver-calls.ts:39-53`) encode the same concept; `supportsReceiverMemberResolution` and `receiverAwareLanguages` then bucket languages a third way. Kotlin, Swift, C++, Ruby, and Zig emit receiver `calls` edges but are absent from goto; PHP navigates but is reported as limited; Go resolves both but is in neither set.

Fix: one `receiverKeywords` hook feeding both paths, and split the single predicate into `receiverMemberNavigation` and `receiverCallEdges` so the impact diagnostic stops conflating them. Then the parity doc can state the two rows separately. Effort M.

### P1-4 Construction and binding forms are hand-coded per language

`receiverConstructorExpression` and `findPriorNewConstructorInContainer` carry a branch per language, with `BINDING_CONTAINER_TYPES` and `BINDING_DECLARATION_TYPES` as the only shared data. Kotlin, Swift, PHP, C++, and Zig cannot prove a constructor-assigned receiver purely because their node types are missing from those lists. Zig is the cheapest: its struct literal has the same shape as Go's `composite_literal`, which is currently gated to `sup.id === "go"`.

Fix: a `receiverConstruction` hook (`constructionTypeName` plus `bindingDeclarations`). Effort L overall, S for the Zig slice.

### P1-5 Ruby `@ivar` receivers never reach the working `.new` path

The receiver gate requires the object node to be in `nodeTypes.identifier` (`navigation-goto.ts:359`), and Ruby lists only `identifier` and `constant`, so `@box = Box.new` plus `@box.helper` is unprovable even though the Ruby assignment branch exists. Fix: a per-language value-identifier list including `instance_variable` and `class_variable`. Effort S.

### P1-6 Hook duplication across definitions

The same three shapes repeat in ten or more definitions: `isDeclarationName` as a parent-name-field check, `classifyDefinition` as a parent-type switch, and the scope predicates as node-type unions. Drift is already visible: Java's `isDeclarationName` omits `constructor_declaration` that its own `classifyDefinition` and `createsFunctionScope` name.

Fix: `src/languages/definitions/shared.ts` with `isNameFieldOnParent`, `classifyByParentType`, and `nodeTypeIn`, following the `js-family.ts` and `c-family.ts` precedent. Effort M.

### P1-7 Scope construction hard-codes fourteen node lists

`src/indexer/scope.ts` holds callable, class, type, enum-member, variable-declaration, member-container, parameter-container, destructuring, and child-skip lists that duplicate data already declared per language. Nothing enforces that a node creating a function scope also appears in the name-registration list.

Fix: move them to a `scopeNodes` block on `LanguageDefinition` and drive the walker from it. Effort M.

### P1-8 Class base clauses and single-language edge passes are `sup.id` gates

`emitClassInheritanceEdges` is nine language branches that differ only in container node type and label rule (`edge-passes.ts:622-728`), and six one-language passes sit behind early returns (Python decorators, Go receivers, Go `new`/`make`, Ruby `new`, Rust impl, Ruby `Struct.new`).

Fix: a declarative `baseClauses` table plus an `edgePasses` registry on the definition. Effort M. P0-1 and the missing Go embedding case (P1-12) both become table rows instead of new branches.

### P1-9 Graph query captures are not a schema

PHP and Python import queries capture only `@stmt`, so text parsers own specifier extraction; Java exposes `@from` while Kotlin exposes `@from`, `@alias`, and `@wild`; JS adds seven CommonJS captures. Downstream code therefore branches on language in `locals-and-exports.ts`, `native-captures.ts`, and `language-specific.ts`.

Fix: standardize on `@stmt` plus `@from`, with optional `@alias`, `@wild`, `@iname`, `@def`, `@ns`, `@type_kw`, and give PHP and Python a `@from` capture. Only then is a generator worth extending to graph queries. Effort L.

### P1-10 Query text duplication between sibling languages

SCSS copies the CSS-like graph verbatim before adding Sass statements; Vue and Svelte have identical graph strings; HTML declares the same five patterns twice for `@mod` and `@from`; C and C++ set `extraExportQueries` equal to `extraLocalQueries`. Fix with family helpers (`cssLikeGraph` reuse, `sfcExternalScriptGraph`, an HTML capture parameter, one `extraSymbolQueries` array). Effort S.

### P1-11 Document formats diverge on HTML forms

Markdown and AsciiDoc pass `{a: ["href"]}` while Handlebars and Astro use the full default tag set; Astro extracts inline `<script>` but no inline `<style>`; Handlebars extracts neither. Identical markup produces different edges per format. Fix: one shared attribute table with explicit per-format opt-outs, and one helper that runs attributes, inline script, and inline style. Effort M.

### P1-12 Per-language capability holes with no stated reason

- Go interface and struct embedding produce no hierarchy edge; Go is absent from the ten-language parity fixture.
- Python `from a import *` never becomes a re-export, so a downstream `from b import name` fails where the ECMAScript equivalent resolves.
- PHP has no `createsBlockScope` and no `exportScopeBlockers`, so nested function declarations can publish as module exports.
- Ruby has a live locals query that `usesQueryDrivenLocals: false` disables; enabling it first needs `classifyDefinition` to cover classes and methods.
- JavaScript has no `isTypeOnly`, so `import type` in JSDoc-typed JS projects is a runtime edge.
- The AngularJS heuristic filters on the `.js` suffix, so `.ts`, `.mjs`, `.cjs`, and `.jsx` AngularJS projects get no framework edges.
- The `isTypeOnly` hook takes statement text only, so Python `if TYPE_CHECKING:` imports cannot be classified.

Each is S or M on its own; several disappear as table rows once P1-6 through P1-9 land.

### P1-13 Receiver edge cases unhandled across all languages

Chained receivers (`a.b.c()`), receivers from a type-annotated parameter (the dependency-injection shape), and receivers assigned inside a conditional or loop all resolve to nothing, and static-versus-instance mismatch is checked only for JS/TS. The parity doc excuses only unannotated parameters, which understates the limit.

Fix: resolve the receiver through `resolveExpression` before classification, add a parameter-annotation hook, add an `isStaticMember` hook, and document the no-dominance-analysis limit. Effort M each.

### P1-14 Resolution edge cases are uneven

First-party hits are not realpath-checked except in Rust `#[path]`; JVM, C#, and Python symbol indexes are not scoped to the nearest manifest, so a monorepo can bind a same-named package from another project; directory hits can become file edges for languages whose runtime has no directory module. Effort L, and worth splitting per symptom.

### P1-15 Dynamic-import heuristics are three hand-written extractors

js, ts, and python each carry their own mask and their own call-shape matcher (`src/util/specifiers.ts:539-568`). A fourth language means a fourth copy. Fix: a shared static-string fold plus per-language adapters that supply only the call shapes. Effort M, and it depends on P0-2 for the mask.

## P2

- Dead language ids `javascript`, `typescript`, and `jsx` appear in three capability lists although only `js`, `ts`, and `tsx` are registered; derive the lists from the registry instead.
- Two diverging parameter-list node sets exist (`receiver-calls.ts:132-139` and `call-compatibility.ts:198-204`); Kotlin's `function_value_parameters` is only in one, Ruby's `block_parameters` only in the other.
- Unreachable receiver-map entries: `svelte` keywords (SFC scripts are parsed as js/ts) and Swift `extension_declaration` (Swift extensions parse as `class_declaration`).
- The native addon ships Vue and Svelte grammars that no pipeline path parses with; either use them or drop them and say so.
- Less is registered as a native language but parsed with the CSS grammar, so `@brand: #fff;` is an ERROR node and Less has no symbols; the matrix records the symptom, not the cause.
- Thin suites hide real defects: JavaScript and Swift have 9 tests each, every inheritance fixture is TypeScript, and only 7 of 15 source languages have a call-hierarchy fixture. P0-1 survived review for exactly this reason.
- BOM, lone-CR, and oversized-file handling are inconsistent: a BOM silently disables tsconfig path mapping, a lone-CR file reports every symbol on line 1, and a file over 8 MiB loses symbols with only a warn log.
- CommonJS export expansion and Rust `#[path]` crate-tree resolution are genuinely language-inherent; do not generalize them. Only the crate-root and manifest readers belong in a shared manifest-resolver interface alongside Composer.

## Suggested sequence

1. **Correct the published claim first**: P0-3 (C++20 module resolution) plus the parity sentence, since it shipped in the last change.
2. **Wrong-result defects**: P0-1, P0-2, P0-8, P0-9. These produce bad edges and bad navigation targets today.
3. **Silent capability holes**: P0-4, P0-5, P0-6, P0-11, then P0-10 behind its own epoch bump.
4. **Consolidation that prevents the next drift**: the trivia lexer (already in step 2), then the receiver hooks (P1-3, P1-4), the definition helpers (P1-6), and the scope node tables (P1-7).
5. **Schema work last**: P1-9 and P1-8 are the largest and are only worth doing once the hooks above prove the pattern.
