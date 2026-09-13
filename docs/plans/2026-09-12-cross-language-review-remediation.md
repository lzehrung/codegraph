# Cross-language / tree-sitter review remediation

Local working plan. **Not** for GitHub. Source: 2026-09-12 deep review of the tree-sitter and
cross-language layer (9 probe slices + main-session verification). Every item below was proven with a
native-grammar probe, a `node-types.json` citation, or a real CLI run.

Grammar pins: `packages/codegraph-native/Cargo.toml`. Native id -> grammar map:
`packages/codegraph-native/src/languages.rs`.

## Delivery: 3 stacked PRs

| PR  | Branch                                        | Base   | Scope boundary                                                                                                            |
| --- | --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | `fix/language-query-grammar-alignment`        | `main` | `src/languages/**`, `src/util/member-access.ts`, `src/duplicates/units.ts`, matching tests                                |
| 2   | `fix/import-resolution-and-symbol-extraction` | PR 1   | `src/util/resolution*`, `src/indexer/imports/**`, `src/indexer/locals-and-exports.ts`, `src/languages.ts`, matching tests |
| 3   | `fix/native-runtime-and-document-links`       | PR 2   | `packages/codegraph-native/**`, `scripts/**`, `src/document-links/**`, diagnostics, docs                                  |

Rules for every wave: workers skip all builds/lints/tests; main owns one integrated `npm run check`
per PR (serialize it — `tests/viewer.test.ts` binds a fixed port, so only one full gate per host).
No release/version/tag edits. No merging without explicit authorization.

---

## PR 1 — language queries and grammar alignment

### 1.1 Stray query predicates (high)

A `(#eq? …)` / `(#match? …)` written after the closing paren of a pattern is a _separate_ top-level
pattern: it never filters, and it matches every node in the file. 29 occurrences found by static
sweep. Predicates written inside the pattern parens do work (verified for Ruby `require`, Zig
`@import`), so this is placement only.

- [x] `src/languages/definitions/javascript.ts` exports: move all 19 `(#eq? @mod "module")` /
      `(#eq? @prop "exports")` / `(#eq? @exp "exports")` predicates inside their patterns (use the
      already-correct grouped form at lines 61-64 as the model).
- [x] `src/languages/definitions/javascript.ts` importBindings: fix the 2 stray `(#eq? @req "require")`.
- [x] `src/languages/definitions/html.ts` imports: fix the 4 stray `(#match? @tag "^(link|a)$")` /
      `(#eq? @tag "img")`.
- [x] `src/languages/definitions/html.ts` importBindings: fix the same 4.
- [x] `src/duplicates/units.ts:118` Rust: `(mod_item) @stmt (#match? @stmt ";\s*$")` masks inline
      `mod x { … }` bodies as imports. Intended semantics are already in the regex fallback at
      `units.ts:153` (`^mod\b[^\r\n;]*;`).
- [x] Regression: `obj.prop = localVar` in a `.js` file must not become an export (proof: `goto`
      resolved a fake `foo` export to `bar`).
- [x] Regression: two identical Rust files wrapped in `mod inner { … }` must produce a duplicate
      group (before: `Units scanned: 0`; unwrapped control: 4 units / 1 group).
- [x] Regression: `<div href>` / `<video src>` must not be captured by the img/link-restricted
      HTML import patterns.
- [x] Add a guard test that fails on any stray top-level `(#…)` form in any registered query
      (imports/exports/locals/importBindings + generated chunk query).

### 1.2 Whole-query compile failures (high)

- [x] `src/languages/definitions/zig.ts:23`: `comments: ["line_comment", "doc_comment"]` ->
      `["comment"]`. tree-sitter-zig 1.1.2 has only `comment`, and one bad node type kills the entire
      chunking query (`codegraph chunk zig.sample.zig` currently returns a single `misc` chunk).
- [x] `tests/languages/zig.test.ts`: replace the assertion that pins the single `misc` chunk with
      function/test chunk expectations.
- [x] Add a sweep test: the generated chunking query must compile for every native-supported
      language (this is how Zig was found; it is the only current failure).

### 1.3 SCSS symbol queries (high)

- [x] `src/languages/definitions/scss.ts`: rewrite `exports`/`locals` for arborium-scss 2.16.0
      (`mixin_statement name: (identifier)`, `function_statement name: (identifier)`,
      `declaration (variable)`, `placeholder (identifier)`) — current queries use `(name)` and
      `variable_declaration`, which do not exist there.
- [x] `src/languages/definitions/scss.ts:53-56`: delete the blanket `normalizeQuery` that returns
      `""` for the whole query; it also kills the valid `class_selector`/`id_selector` patterns.
- [x] Decide and set `usesQueryDrivenLocals` for scss now that locals actually capture.
- [x] Regression: `$brand`, `@mixin`, `@function` must appear as symbols (before: `Locals: (none)`,
      `Exports: (none)`).
- [x] Make the `@use`/`@forward` string capture tolerant of a wrapping node so `as *` /
      `as prefix-*` are not silently dropped (`(use_statement (_)* (string_value) @mod)`); `with (…)`
      stays deferred (see Deferred).

### 1.4 Kotlin grammar divergence (high)

Native is `tree-sitter-kotlin-ng` 1.1.0, which emits `identifier`. The definition tests for
`simple_identifier` / `type_identifier` / `control_structure_body`, none of which exist there.
Net effect: **non-call identifier references never resolve in Kotlin** (`refs S.kt::topName` returns
the declaration only; the same shape resolves in Swift, Java, Python).

- [x] `src/languages/definitions/kotlin.ts:98-101`: `nodeTypes.propertyIdentifier` must include
      kotlin-ng's `identifier`.
- [x] `src/languages/definitions/kotlin.ts:110-125` `isDeclarationName`: accept `identifier` for
      class/object/type-alias/property/parameter/enum-entry/type-parameter.
- [x] `src/languages/definitions/kotlin.ts:129-134` `createsBlockScope`: drop the non-existent
      `control_structure_body`; add the real `block`.
- [x] `src/util/member-access.ts:81-87` `getNavigationExpressionProperty`: kotlin-ng
      `navigation_expression` has no `navigation_suffix`, so the `expr.child(1)` fallback returns
      `"."`. Select the last named child for kotlin while keeping Swift's `navigation_suffix` path.
- [x] Prefer collapsing the kotlin `normalizeQuery` hook: with correct node names the query text
      should target kotlin-ng directly instead of being rewritten at runtime.
- [x] Regression: intra-file identifier read (`val topName` used in another top-level function)
      must resolve; property/type-parameter shadowing must bind.

### 1.5 Export scope anchoring (high)

Unanchored patterns publish function-local names as module exports. Leaks confirmed for `python`,
`c`, `cpp`, `swift`, `kotlin`, `zig`; `go`, `rust`, `java`, `csharp`, `ts/js` are already anchored.
Worst case proven: `from mod_a import secret_tmp` resolved to a Python function-local.

- [x] `src/languages/definitions/python.ts`: anchor `(assignment left: (identifier) @name)` and the
      function/class name patterns to module/class scope for `exports`.
- [x] `src/languages/definitions/c-family.ts`: anchor `declaration` / `init_declarator` export
      patterns to translation-unit (and type-member) scope so function-body locals stop exporting.
- [x] `src/languages/definitions/swift.ts`: anchor export patterns; local `let` / local `func` must
      not export.
- [x] `src/languages/definitions/kotlin.ts`: same for local `val` / local `fun`.
- [x] `src/languages/definitions/zig.ts`: same for function-body `const` / `var`.
- [x] Keep `locals` unanchored where it is intentional (locals are file-scoped symbols); only
      `exports` changes.
- [x] Regression per language: a name declared inside a function body must be absent from
      `dumpmod` Exports and from `apisurface`.

### 1.6 Missing construct coverage (high / medium)

- [x] **C#** `src/languages/definitions/csharp.ts`: add `struct_declaration`,
      `delegate_declaration`, `local_function_statement` to exports/locals; add
      `struct_declaration` chunk blocks. Verified before the fix: `struct Point`, its constructor,
      `operator +`, `delegate`, `~Holder()`, the indexer and the local function produced **no**
      symbol at all. Constructors, destructors, operators, conversion operators and indexers were
      deliberately left out during integration: a constructor/destructor repeats the type name and
      made `Point`/`Holder` ambiguous, and the rest have no identifier in the grammar, so they would
      publish symbols literally named `operator`/`this`.
- [x] **C#**: make fields/properties symmetric — `property_declaration` into locals, and
      `field_declaration` / `event_field_declaration` `variable_declarator` into exports.
- [x] **C#**: alias `using X = Y;` now captures `Y` as the module (arborium puts the alias in the
      `name:` field, so the old `. (_)` anchor captured the alias) and keeps the alias binding;
      `extern_alias_directive` is recognized.
- [x] **C++** `src/languages/definitions/c-family.ts` + `cpp.ts`: extend the function-name query with
      `qualified_identifier`, `operator_name`, `destructor_name`, `reference_declarator`,
      `template_function`, and apply it to `field_declaration` (in-class declarations). Verified
      missing: `void A::f()`, `A::~A()`, `A& A::operator+=`, and their in-class declarations.
- [x] **C++**: add `namespace_definition name: (nested_namespace_specifier …)` and
      `class_specifier name: (template_type …)`; add `concept_definition`.
- [x] **C++**: reuse the C extras — `union_specifier`, `preproc_def`, `preproc_function_def` (C
      indexes them, C++ does not).
- [x] **Rust** `src/languages/definitions/rust.ts`: add `type_item`, `associated_type`,
      `function_signature_item` to exports/locals with declaration-name + classification handling
      (`pub type Alias`, `type Assoc`, declaration-only trait methods are all invisible today).
- [x] **Ruby** `src/languages/definitions/ruby.ts`: accept `name: [(constant) (scope_resolution)]`
      in exports and in the chunk `nameQuery` (`module Outer::Compact` is a local but never an
      export, so cross-file references cannot resolve).
- [x] **Ruby**: add `singleton_method name: (identifier)` and `method name: (setter)` to
      exports/locals; extend the import method predicate with `load` / `autoload`.
- [x] **Java** `src/languages/definitions/java.ts`: add `formal_parameter` (plus spread/receiver
      parameter forms) to locals — method parameters are absent from query-driven locals.
- [x] **Go** `src/languages/definitions/go.ts`: add `type_parameter_declaration name: (identifier)`
      to locals; fix `const_spec` / `var_spec` so every `name` field is captured (`const (B, C = …)`
      silently drops `C`).
- [x] **Swift** `src/languages/definitions/swift.ts`: add `associatedtype_declaration` (and
      `macro_declaration`, `operator_declaration`) to exports/locals. `init`/`deinit`/`subscript`
      were dropped again during integration: they have no identifier name in the grammar and repeat
      per type, so they stay chunks only.
- [x] **Python** `src/languages/definitions/python.ts`: add
      `(as_pattern alias: (as_pattern_target (identifier) @name))` — today `except E as e` indexes
      `E`, not `e`; add `named_expression` (walrus), tuple/pattern-list unpacking,
      `type_alias_statement` (PEP 695), and `keyword_pattern` captures.
- [x] **TS/TSX** `src/languages/definitions/typescript.ts`: add `function_signature name:` to locals
      (declaration-only overloads and `.d.ts` APIs are never symbols) and
      `internal_module` / `module` names (namespaces are chunked but not indexed).
- [x] **JS/TS/TSX**: add `class_static_block` to `createsBlockScope` — a static-block `let`
      currently resolves from sibling methods.
- [x] **TS**: allow `(string)` in the `module` chunk name query so `declare module "x"` is chunked.
- [x] **Zig**: `classifyDefinition` must use the initializer after `=`, not the first non-name named
      child; `pub const flag: bool = true` and `var counter: i32 = 0` are currently classified as
      `type`.
- [x] **Zig**: accept `@cImport` in imports/importBindings and `using_namespace_declaration` as a
      star import.
- [x] **C** `src/languages/definitions/c-family.ts`: add `path: (call_expression …)` to
      `preproc_include` and ignore `preproc_include` nodes containing ERROR —
      `#include MACRO("x.h")` currently binds a neighboring preprocessor identifier as the path.
- [x] **C++20 modules**: stop false-exporting `export module foo;` / `import std;` (they parse as
      `declaration` + ERROR under tree-sitter-cpp 0.23.4). Exclude declarations whose `type` text is
      `import`/`export`, or containing ERROR children; update `tests/languages/cpp.test.ts`.

### 1.7 Extension dispatch (medium)

- [x] Add compatible suffixes whose pinned grammar already parses them cleanly: `.pyw`, `.rbw`,
      `.rake`, `.gemspec`, `.ktm`, `.csx`, `.phtml`/`.php4`/`.php8`, `.xhtml`, `.ddl`/`.pgsql`/
      `.mysql`. Do **not** add `.m`/`.mm`, `.styl`, `.templ`, `.zon` (no grammar). `.sass` was
      rejected during integration: indented Sass yields an ERROR node per rule under arborium-scss.
- [x] Add a dispatch test covering each newly mapped suffix.

### 1.8 Documentation (canonical coverage docs)

- [x] `docs/language-parity.md`: SCSS row `Symbol extraction` -> `Yes`, `Find references` ->
      `Partial`; notes for grammar-targeted queries (Kotlin `identifier` names, no rewrite layer),
      export scope anchoring, the per-language symbol-set changes, HTML tag-restricted asset
      attributes, the new extension mappings and the deliberate `.sass` non-mapping, and Zig
      chunking actually working.
- [x] `docs/scenario-catalog.md`: rows for the duplicate-detection inline-`mod` fix, the new
      query-hygiene guard, and the per-language behavior changes; correct the stale SCSS
      `@forward` "semantic navigation stays not_found" row, the C++ module row, and the
      self-contradicting Markdown raw-HTML row.

### 1.9 Integration fixes found while making PR 1 green

These were not in the original finding list; each was caused by a PR 1 change and is part of PR 1.

- [x] `src/indexer/expand-star-imports.ts`: stylesheet star imports now expand only from explicit
      exports. Once SCSS had locals, `@import "./theme.scss"` invented a named import binding for
      every class selector in the imported sheet.
- [x] `src/languages/definitions/javascript.ts`: a named function expression binds its own name
      (`$scope.refresh = function refresh()`, `const f = function inner() {}`). Those symbols used
      to come from the fake-CJS-export defect, so removing it would have lost them.
- [x] `src/languages/definitions/javascript.ts`: restored the `namespace_import` binding pattern a
      worker deleted; without it every `import * as ns` and all JS namespace-member navigation broke.
- [x] `src/languages/definitions/javascript.ts`: explicit pattern for
      `module.exports = function () {}` so the whole-module CJS export survives the predicate fix.
- [x] `src/languages/definitions/typescript.ts`: `scopeDeclarationNames` opts `function_signature`,
      `internal_module` and `module` names into scope construction. TS locals are scope-driven, so
      adding them to the locals query alone had no effect.
- [x] `src/languages/definitions/scss.ts`: `classifyDefinition` so `@mixin`/`@function` are
      `function`-kind rather than `variable`-kind, and the `$variable` predicate uses `[$]` (a
      `"^\\$"` literal is unescaped by the query parser into `^$`, which matches nothing).
- [x] `src/util/member-access.ts`: `getNavigationExpressionProperty` takes the language support; the
      two callers in `src/graphs/symbol-graph-detailed/receiver-calls.ts` and
      `src/indexer/navigation-goto.ts` were updated with it.
- [x] Recovered `tests/duplicates.test.ts`, `tests/languages/{go,java,python}.test.ts` after a worker
      pasted truncated `read` output (including the tool's `[Showing lines …]` footer) into them.

---

## PR 2 — resolution and extraction paths

### 2.1 Stylesheet import resolution (high)

- [x] `src/util/resolution.ts:224`: bare quoted CSS/SCSS/LESS specifiers are directory-relative, but
      `isRelativeOrAbsolute` demands a `.`/`/` prefix, so `@use "variables"` and
      `@import "theme.css"` are reported external. Treat stylesheet-kind specifiers as relative
      first, then fall back to bare resolution.
- [x] `src/util/resolution.ts:237`: the `allowScssPartialResolution` branch is unreachable for bare
      partials because it sits inside the relative branch; make Sass `_name.scss` resolution reachable.
- [x] Ensure the indexer path (`resolveImportSpecifier`, used by `collectImportsForFile`) passes the
      same stylesheet options that `src/graphs/edge-resolution.ts:70` passes.
- [x] Regression: `@use "variables"` next to `_variables.scss` must produce a file edge; today
      `unresolved` lists `variables` and `other` although both files are indexed.

### 2.2 Python import bindings (high)

- [x] `src/indexer/imports/python.ts:134`: `fromLinePattern` is single-line, so
      `from pkg import (\n a,\n b,\n)` yields **no** bindings (file edges survive via the native
      query). Drive bindings from the native `import_statement` / `import_from_statement` /
      `future_import_statement` matches, which already match, instead of a second parser that
      disagrees with the grammar.
- [x] Same change must fix `import a, b` (the module pattern only captures the first name) and
      backslash-continued `from` lists.
- [x] Regression: `refs pkg/alpha.py::one` must include both consumer sites for the parenthesized
      form (the single-line comma form already works).

### 2.3 Symbol/export plumbing (medium)

- [x] `src/indexer/locals-and-exports.ts`: de-duplicate export rows. `typedef struct Point {…}
Point;` currently exports `Point` twice (visible in `apisurface`); a Kotlin shadowed `val`
      duplicates the same way.
- [x] `src/indexer/locals-and-exports.ts:479,496`: remove the `tname` capture handling — no
      registered language emits `@tname`.
- [x] `src/indexer/locals-and-exports.ts:512`: remove the dead
      `extractLocalsFromJsQueries = () => false` stub and its call.
- [x] `src/indexer/imports/native-captures.ts`: assign `typeOnly` per specifier instead of per
      statement so `import { type A, b }` does not record `A` as a value edge.
- [x] `src/languages/definitions/typescript.ts`: drop the phantom binding for aliased named imports
      — the no-alias pattern also matched `b as c`, yielding an extra binding under `b`. Done in
      PR 1 with a `!alias` negated field on the no-alias import-specifier pattern.

### 2.4 Rust module resolution (high)

- [x] `src/languages/import-statement-parsers.ts:60-64` + `src/indexer/imports/language-specific.ts`:
      flatten nested `scoped_use_list` so `use crate::a::{b::{Thing as Renamed}, A}` binds `Thing`
      to `src/a/b.rs`, not to the outer module.
- [x] `src/util/resolution/rust.ts`: honor `#[path = "custom.rs"] mod external;` before the
      conventional `<module>.rs` / `<module>/mod.rs` candidates (today it resolves to the wrong file).

### 2.5 Classification and JVM heuristics (medium)

- [x] `src/languages.ts:194` `CPP_HEADER_HINT`: match only outside comments and strings, and add
      `using\s+\w+\s*=` (and `concept` / `co_await`). Proven false positives: `/* template for the
audio driver */`, `/* network operator id */`, `/* see C++ std::vector */`. Proven false
      negatives: `using Foo = int;`, `import std;`.
- [x] Resolve the `c` vs `cpp` `usesQueryDrivenLocals` asymmetry (`cpp.ts:20` sets it, `c.ts` does
      not), so the same `.h` does not yield different symbol sets depending on the sniff.
- [x] `src/indexer/imports/language-specific.ts:469`: Java implicit imports drop any class whose last
      segment is not uppercase-initial; stop discarding lowercase class names.
- [x] `src/indexer/imports/language-specific.ts` Kotlin text fallback: accept a trailing `;`.

### 2.6 Integration fixes found while making PR 2 green

- [x] PR 1 anchored the C/C++ `exports` query on `translation_unit`, which silently dropped every
      declaration inside an include guard: `tests/samples/c/utils.h` exported only its guard macro.
      The anchor is gone again; a new `exportScopeBlockers` hook
      (`src/languages/types.ts`, `src/languages.ts`, `src/indexer/locals-and-exports.ts`) drops an
      export capture that has a `compound_statement` ancestor instead, which is exact and does not
      care about preprocessor nesting depth. Covered in the cache fingerprint
      (`src/indexer/build-cache/options.ts`).
- [x] `src/languages/definitions/c-family.ts`: the C/C++ locals query now captures function
      prototypes (`(declaration <functionNameQuery>)`) and declarator-wrapped typedef names
      (`typedef int (*Comparator)(int, int);`, `typedef int *IntPtr;`). Turning on query-driven
      locals for C had dropped all three; a worker had downgraded the C tests to match.
- [x] `src/languages/definitions/{c,cpp}.ts`: `classifyDefinition` walks to the enclosing
      `type_definition`, so a function-pointer typedef name is a `type`, not a `variable`.
- [x] `typedef struct X { … } X;` now yields two C symbols (tag and alias) exactly as it already did
      for C++. `goto` on a use lands on the tag; the C goto/reference tests and the native parity
      snapshot were updated with that reasoning.

---

## PR 3 — native runtime, diagnostics, documents

### 3.1 Native runtime (medium / low)

- [x] `packages/codegraph-native/src/query.rs:57-104`: bound the compiled-query cache (small LRU on
      the existing `(language_id, query_text)` key). 5,000 distinct queries in one isolate retained
      ~12 MB RSS, and each worker thread keeps its own copy.
- [x] `packages/codegraph-native/Cargo.toml:15`: remove the unused `tree-sitter-c-sharp` dependency
      (`languages.rs:37` uses `arborium-c-sharp`); refresh `Cargo.lock`.
- [x] `scripts/generate-duplicate-identifier-ranges.mjs:12`: wrap the resolved path with
      `pathToFileURL(...).href`; on Windows the dynamic import fails with
      `ERR_UNSUPPORTED_ESM_URL_SCHEME` so the pinned tokenizer ranges cannot be regenerated.

### 3.2 Diagnostics honesty (medium)

- [x] `src/graphs/specifiers.ts:275-318`: distinguish "native unavailable" from "native query
      returned nothing". With the binding disabled, Python reports `reason: "query-empty"` although
      no query ran; SCSS reports the same for a deliberately blanked query.
- [x] Surface the affected languages in degraded output (`src/cli/context.ts`,
      `src/native/native-backend-report.ts`, `src/cli/doctor.ts`) — the per-language breakdown
      already exists in the report but is suppressed.

### 3.3 Document links (medium / low)

- [x] `src/document-links/markdown.ts:571-575` `stripMarkdownCode`: mask HTML comments and a leading
      YAML (`---`) / TOML (`+++`) front-matter block; commented-out and front-matter links currently
      become graph edges.
- [x] `src/document-links/markdown.ts:574`: do not treat a 4-space-indented _list item_ as indented
      code; nested-list link destinations are dropped today (2-space nesting works).
- [x] `src/document-links/asciidoc.ts:10-36`: blank `ifdef` / `ifndef` / `ifeval` regions through
      the matching `endif::`; conditional includes are extracted as live edges.
- [x] `src/document-links/markdown.ts:44-46`: make the occurrence walker skip a full
      `![…][…]` reference image the way the specifier walker does, so `codegraph links` stops
      failing on image destinations the graph intentionally ignores.
- [x] `src/languages/definitions/html-stub.ts:3-13`: rewrite the comment — it claims these languages
      borrow `tree-sitter-html` and do not participate in dependency extraction; neither is true.
- [x] `docs/scenario-catalog.md:149`: fix the self-contradicting Markdown row (raw `<a href>` _is_ an
      edge; images are not).

### 3.4 Integration fixes found while making PR 3 green

- [x] `src/cli/context.ts` printing the affected-language list pulled `native-backend-report.ts`,
      and therefore the native runtime, into the CLI startup module graph, and `doctor` reading the
      graph-only ids pulled the whole `document-links` barrel. Both now come from dedicated leaf
      modules (`src/native/backend-report-format.ts`, `src/document-links/language-ids.ts`), so
      `tests/cli-startup-eager-modules.test.ts` stays within its budget for no args, `--version`
      and `--help`, and `doctor` no longer loads `document-links.js` at all.
- [x] `packages/codegraph-native/src/query.rs`: the test-only cache accessors are `#[cfg(test)]` so
      the release build has no dead-code warning.

---

## Deferred (recorded, not in these PRs)

Each needs a new grammar, a new feature, or a product decision — not a defect fix.

- [ ] Pin a real LESS grammar. `languages.rs:36` maps `less` to `tree-sitter-css`; a 15-line
      ordinary LESS file yields 15 ERROR nodes (variables, mixins, guards, `:extend`, escaping,
      detached rulesets). Until then, stop advertising LESS as a native peer of CSS.
- [ ] SCSS module configuration (`@use "x" with (…)`) — arborium-scss 2.16.0 does not model it.
- [ ] Use the loaded `arborium-vue` / `tree-sitter-svelte-next` grammars on `.vue` / `.svelte`, or
      document those ids as split-only (today the SFC split routes to js/ts + embedded html/css and
      the grammars are never used).
- [ ] Heading-aware document chunker. `.md`/`.mdx`/`.rst`/`.adoc` fall through to
      `chunkTextFile`, which splits through fenced code.
- [ ] SQL `CREATE SCHEMA` / `CREATE TYPE` facts and symbols; SQL procedure chunking vs the fact
      pipeline; table-to-table lineage edges.
- [ ] Go / Rust visibility in `apisurface` (lowercase Go identifiers and non-`pub` Rust items are
      reported as exported) — needs a product decision on what "export" means for resolution vs API.
- [ ] Cross-file member-access resolution for JVM/C#/Swift (`Util.helper()` through an imported
      type). Go resolves it via namespace bindings; TS resolves instance methods. Not a Kotlin-only
      gap.
- [ ] Java `module-info.java`: no graph or chunk representation.
- [ ] HTML `type="importmap"` entries as edges; SFC `<template lang="pug">` and custom blocks.
- [ ] Parser resource policy in `parser_pool.rs` (no timeout/cancellation configured).

---

## Verification ledger

- [x] PR 1: `npm run check` green; language sweeps (chunk-query compile, stray-predicate guard) green.
- [x] PR 2: `npm run check` green; stylesheet, Python import, Rust module reproductions re-run.
- [x] PR 3: `npm run check` green; native cache probe re-run; `codegraph links` on a doc fixture.
- [x] All three PRs open and stacked; none merged without explicit authorization.

### Review corrections

- PR #364: `17925435`; full check passed with 4,265 tests plus native checks.
- PR #365: `4fa30a78`; full check passed with 4,292 tests plus native checks.
- PR #366: `618006e5`; full check passed with 4,316 tests (19 skipped), 36 Rust tests, 185 required-native tests, and 27 native-off tests.
- Compiled CLI checks covered exports, declaration navigation, nested Rust edges, Python import comments, document links, and graph-only extraction with native unavailable.
- All three PRs are open and conflict-free. Fresh Copilot reviews were requested; no fresh review result was available at publication.
- Temporary review scripts and CLI fixtures were removed. Deferred items above remain outside these PRs.

### Second review round

- PR #364: `967b4045`; 4,272 tests. Function-local export leaks removed for Python/Kotlin/Swift/Rust/C++ through one `exportScopeBlockers` mechanism (`parent>node` entries separate a Python function body from a class body); nested top-level type members stay exported at any depth. C++ namespace/template/prototype exports reach C parity. Aliased Rust `pub use` keeps the original member as its source. AGENTS.md gained three verification guidelines.
- PR #365: `d64999c7`; 4,301 tests. `#[path]` survives comments between the attribute and the item; explicit-path confinement compares real paths, so an in-root symlink cannot escape the root.
- PR #366: `13f6dfb8`; 4,325 tests plus 36 Rust, 185 required-native, and 27 native-off tests. Fallback wording distinguishes graph-only extraction from a regex fallback, the merged-query failure memo refreshes on its hit path, and the startup guard again covers every heavy command module per entrypoint as observed module loads.
- Disproved and left unchanged: the `#include MACRO("x.h")` include capture. A direct query run returns only the real string path.
- Known unrelated gap, unchanged: Rust re-export chains do not resolve through a barrel module for `goto`, with or without an alias.

### Third review round (inline plus suppressed comments)

- PR #364 `e545fa05`; 4,279 tests. C/C++ exports returned to unanchored queries plus `exportScopeBlockers`, which restored include-guarded exports that the earlier anchoring dropped and removed the duplicate C++ enum row. Kotlin and Swift blockers now cover lambda/closure bodies. `DUPLICATE_UNIT_CACHE_VERSION` bumped because the key does not fingerprint the import-masking query. `.xhtml` added to document-relative link extensions.
- PR #365 `acd51328`; 4,315 tests. Rust text recovery skips macro token trees; the cfg-test guard finds the real keyword instead of `mod` inside `#[path = "mod.rs"]`; `#[path]` discovery is trivia-aware, reads the attribute from the declaring module across prefix hops, and memoizes per-file attributes by path plus stat signature. Python module-level detection admits only a prefix of complete imports.
- PR #366 `3948c064`; 4,340 tests plus 38 Rust, 186 required-native, and 27 native-off tests. Markdown masking strips blockquote markers before measuring code indentation; the native query cache and failure memo release per-language capacity on eviction.
- Disproved, unchanged: `preproc_include path: (call_expression)` captures nothing for `#include MACRO("x.h")` in imports or importBindings; Go `const (B, C = iota, iota)` and `var D, E = 1, 2` already export and index every name.
- Documented limitation: extensionless module resolution keeps each language runtime's importable extensions, so `import util` does not resolve to `util.pyw` and `require_relative "helper"` does not resolve to `helper.rbw`.
