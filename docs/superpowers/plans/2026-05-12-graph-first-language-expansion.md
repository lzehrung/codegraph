# Graph-First Language Expansion Implementation Plan

> **For:** Codegraph maintainers implementing Scala, Lua, PowerShell, Elixir, Objective-C, Julia, and Dart support
> **Goal:** Add useful graph/chunk/import coverage for seven source languages without claiming full semantic go-to/reference parity before it exists.

## Context

The repo has an established language-support workflow: define support surface, add a language definition, wire JS fallback and native grammars, add fixtures/tests, then update parity/scenario docs and the agent skill surface. Follow [docs/adding-language-support.md](../../adding-language-support.md) exactly.

This plan intentionally targets graph-first support. Each language should provide parsing, chunking, top-level symbol extraction, and static dependency edges. It should not claim full cross-file semantic navigation until shared `goto`, `references`, and native semantic parity tests prove that behavior.

Graph-first source-language support still participates in the normal code dependency graph for explicit imports/includes from that language. That is different from SQL artifact support, where SQL object candidates must stay isolated unless a separate bridge rule proves the SQL fact is relevant to code review. Do not use this language-expansion plan as precedent for globally linking artifact symbols into source-language dependency resolution.

## Target Languages

| Language    | Extensions               | npm grammar                                                                      | Rust grammar                                                                |
| ----------- | ------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Scala       | `.scala`, `.sc`          | [`tree-sitter-scala`](https://www.npmjs.com/package/tree-sitter-scala)           | [`tree-sitter-scala`](https://crates.io/crates/tree-sitter-scala)           |
| Lua         | `.lua`                   | [`tree-sitter-lua`](https://www.npmjs.com/package/tree-sitter-lua)               | [`tree-sitter-lua`](https://crates.io/crates/tree-sitter-lua)               |
| PowerShell  | `.ps1`, `.psm1`, `.psd1` | [`tree-sitter-powershell`](https://www.npmjs.com/package/tree-sitter-powershell) | [`tree-sitter-powershell`](https://crates.io/crates/tree-sitter-powershell) |
| Elixir      | `.ex`, `.exs`            | [`tree-sitter-elixir`](https://www.npmjs.com/package/tree-sitter-elixir)         | [`tree-sitter-elixir`](https://crates.io/crates/tree-sitter-elixir)         |
| Objective-C | `.m`                     | [`tree-sitter-objc`](https://www.npmjs.com/package/tree-sitter-objc)             | [`tree-sitter-objc`](https://crates.io/crates/tree-sitter-objc)             |
| Julia       | `.jl`                    | [`tree-sitter-julia`](https://www.npmjs.com/package/tree-sitter-julia)           | [`tree-sitter-julia`](https://crates.io/crates/tree-sitter-julia)           |
| Dart        | `.dart`                  | [`tree-sitter-dart`](https://www.npmjs.com/package/tree-sitter-dart)             | [`tree-sitter-dart`](https://crates.io/crates/tree-sitter-dart)             |

Deliberately defer Objective-C `.h` and `.mm` until header and Objective-C++ ownership can be resolved without breaking existing C/C++ `.h` heuristics.

## Agentic Coding Value

Graph-first support is valuable for agents even before full semantic navigation exists. It lets the standard Codegraph workflows answer first-pass questions in more polyglot repos:

- orient a repo and identify language-owned areas
- include static dependencies in `graph`, `inspect`, `impact`, and `review`
- chunk unfamiliar source files for bounded model context
- detect hotspots, unresolved imports, and duplicate code units where supported

The product boundary is important: graph-first languages may participate in dependency and chunking workflows, but docs and tests must continue to say when `goto` and `refs` are unsupported.

## Support Contract

For each language, v1 support should provide:

- File discovery for listed extensions.
- Tree-sitter parsing through JS fallback.
- Native parser support when the Rust grammar exposes a compatible API.
- Chunking for top-level declarations and important nested declarations.
- Definition extraction for top-level names.
- Static import/include/dependency extraction.
- File-level and chunk-level graph impact.

For each language, v1 support should not claim:

- Cross-file go-to definition.
- Cross-file references.
- Type-aware resolution.
- Build-system-aware package resolution.

Docs should mark these languages as graph-first source languages with "No" or "Partial" cells for source-navigation parity until the shared semantic suites prove more.

Unlike SQL artifact nodes, these source-language nodes may appear in dependency graph output when the language extractor emits explicit import/include/module relationships. Keep that distinction visible in docs if both plans are implemented near each other.

## Shared Implementation Shape

Add one definition file per language:

- `src/languages/definitions/scala.ts`
- `src/languages/definitions/lua.ts`
- `src/languages/definitions/powershell.ts`
- `src/languages/definitions/elixir.ts`
- `src/languages/definitions/objectiveC.ts`
- `src/languages/definitions/julia.ts`
- `src/languages/definitions/dart.ts`

Register them in:

- `src/languages/all.ts`
- `src/languages.ts`
- `src/util/projectFiles.ts` if discovery is not fully driven by definitions
- `packages/codegraph-js-fallback/package.json`
- `packages/codegraph-native/Cargo.toml`
- `packages/codegraph-native/src/languages.rs`

Add tests and fixtures:

- `tests/languages/scala.test.ts`
- `tests/languages/lua.test.ts`
- `tests/languages/powershell.test.ts`
- `tests/languages/elixir.test.ts`
- `tests/languages/objective-c.test.ts`
- `tests/languages/julia.test.ts`
- `tests/languages/dart.test.ts`
- `tests/samples/scala/*`
- `tests/samples/lua/*`
- `tests/samples/powershell/*`
- `tests/samples/elixir/*`
- `tests/samples/objective-c/*`
- `tests/samples/julia/*`
- `tests/samples/dart/*`

Add shared guard tests:

- `tests/project-file-discovery.test.ts`
- `tests/native-tree-sitter.test.ts`
- `tests/native-parser-ownership.test.ts`
- `tests/native-semantic-parity.test.ts`
- `tests/goto.test.ts`
- `tests/references.test.ts`

The semantic parity, go-to, and references tests should explicitly preserve honest unsupported behavior for these graph-first languages.

## Language-Specific Extraction Targets

### Scala

Extract:

- `package` declarations.
- `import` selectors.
- `class`, `case class`, `object`, `trait`, `enum`, `def`, and top-level `val`/`var`.
- Edges from imports to package/module strings.

Fixtures:

- Package plus imports.
- Companion object and class.
- Trait implemented by class.
- Scala script `.sc`.

### Lua

Extract:

- `require` calls with literal module names.
- `function name(...)`, `local function name(...)`, table method definitions, and returned module tables.
- Top-level assignment exports such as `M.foo = function(...)`.

Fixtures:

- CommonJS-like module table.
- Nested table method.
- Local require alias.

### PowerShell

Extract:

- `Import-Module`, `using module`, and dot-sourced script paths.
- `function` declarations.
- `class` declarations.
- exported functions from simple `Export-ModuleMember` calls.
- `.psd1` module manifest dependencies when parseable.

Fixtures:

- Script file `.ps1`.
- Module file `.psm1`.
- Manifest `.psd1` with required modules.
- Dot-sourced helper file.

### Elixir

Extract:

- `defmodule`.
- `alias`, `import`, `require`, and `use`.
- `def`, `defp`, `defmacro`.
- Nested modules.

Fixtures:

- Module with aliases and imports.
- `use GenServer`.
- Nested module.
- `.exs` script.

### Objective-C

Extract:

- `#import` and `#include`.
- `@interface`, `@implementation`, `@protocol`, `@class`.
- Method declarations and implementations.
- Category names such as `@interface Foo (Bar)`.

Fixtures:

- `.m` implementation with framework import.
- Interface and implementation in one file.
- Protocol and category.

Do not claim `.h` support in v1 because `.h` is already shared with C/C++ detection.

### Julia

Extract:

- `module`.
- `using` and `import`.
- `function`, compact assignment functions, `struct`, `mutable struct`, `abstract type`, and `macro`.
- `include("file.jl")` dependencies.

Fixtures:

- Module with `using`.
- Include graph.
- Struct and function.
- Macro.

### Dart

Extract:

- `import`, `export`, and `part`/`part of`.
- `library` declarations.
- `class`, `mixin`, `extension`, `enum`, `typedef`, and top-level functions.

Fixtures:

- Library with imports.
- Part file.
- Class with mixin.
- Barrel export file.

## Implementation Steps

### Task 1: Document graph-first support tier

Files:

- `docs/language-parity.md`
- `docs/scenario-catalog.md`
- `README.md`
- `codegraph-skill/codegraph/SKILL.md`

Changes:

- Add a graph-first source-language support tier if the existing docs do not already name it.
- Add planned rows for the seven languages with honest v1 claims.
- Add scenario catalog entries for import graph, chunking, native parser smoke, and unsupported semantic navigation.
- Distinguish graph-first source languages from isolated artifact languages such as SQL.

Verification:

- Review rendered markdown.
- Confirm README table of contents remains accurate if sections change.

Commit:

```bash
git add docs/language-parity.md docs/scenario-catalog.md README.md codegraph-skill/codegraph/SKILL.md
git commit -m "docs: define graph-first language tier"
```

### Task 2: Add grammar dependencies and native IDs

Files:

- `packages/codegraph-js-fallback/package.json`
- `packages/codegraph-native/Cargo.toml`
- `packages/codegraph-native/src/languages.rs`
- `tests/native-tree-sitter.test.ts`
- `tests/native-parser-ownership.test.ts`

Changes:

- Add JS grammar dependencies for all seven languages.
- Add Rust grammar dependencies for all seven languages.
- Register native IDs using stable lowercase language ids:
  - `scala`
  - `lua`
  - `powershell`
  - `elixir`
  - `objective-c`
  - `julia`
  - `dart`
- Add parser load and ownership tests.
- If a Rust grammar uses a nonstandard API, adapt that one language explicitly and document the reason in code.

Commands:

```bash
npm install
cargo test --manifest-path packages/codegraph-native/Cargo.toml
npx vitest run tests/native-tree-sitter.test.ts tests/native-parser-ownership.test.ts
```

Commit:

```bash
git add packages/codegraph-js-fallback/package.json packages/codegraph-native/Cargo.toml packages/codegraph-native/src/languages.rs package-lock.json tests/native-tree-sitter.test.ts tests/native-parser-ownership.test.ts
git commit -m "feat: add graph-first language parsers"
```

### Task 3: Add Scala graph-first support

Files:

- `src/languages/definitions/scala.ts`
- `src/languages/all.ts`
- `src/languages.ts`
- `tests/languages/scala.test.ts`
- `tests/samples/scala/*`
- `tests/project-file-discovery.test.ts`

Changes:

- Add `.scala` and `.sc` support.
- Extract packages, imports, classes, case classes, objects, traits, enums, defs, and top-level vals/vars.
- Add tests for chunks, symbols, imports, and discovery.

Command:

```bash
npx vitest run tests/languages/scala.test.ts tests/project-file-discovery.test.ts
```

Commit:

```bash
git add src/languages tests/languages/scala.test.ts tests/samples/scala tests/project-file-discovery.test.ts
git commit -m "feat: add Scala graph support"
```

### Task 4: Add Lua graph-first support

Files:

- `src/languages/definitions/lua.ts`
- `src/languages/all.ts`
- `src/languages.ts`
- `tests/languages/lua.test.ts`
- `tests/samples/lua/*`
- `tests/project-file-discovery.test.ts`

Changes:

- Add `.lua` support.
- Extract literal `require` dependencies, functions, local functions, table methods, and module-table exports.
- Add tests for chunks, symbols, requires, and discovery.

Command:

```bash
npx vitest run tests/languages/lua.test.ts tests/project-file-discovery.test.ts
```

Commit:

```bash
git add src/languages tests/languages/lua.test.ts tests/samples/lua tests/project-file-discovery.test.ts
git commit -m "feat: add Lua graph support"
```

### Task 5: Add PowerShell graph-first support

Files:

- `src/languages/definitions/powershell.ts`
- `src/languages/all.ts`
- `src/languages.ts`
- `tests/languages/powershell.test.ts`
- `tests/samples/powershell/*`
- `tests/project-file-discovery.test.ts`

Changes:

- Add `.ps1`, `.psm1`, and `.psd1` support.
- Extract imports, dot-sourced script dependencies, functions, classes, and simple module exports.
- Add tests for script, module, manifest, and discovery fixtures.

Command:

```bash
npx vitest run tests/languages/powershell.test.ts tests/project-file-discovery.test.ts
```

Commit:

```bash
git add src/languages tests/languages/powershell.test.ts tests/samples/powershell tests/project-file-discovery.test.ts
git commit -m "feat: add PowerShell graph support"
```

### Task 6: Add Elixir graph-first support

Files:

- `src/languages/definitions/elixir.ts`
- `src/languages/all.ts`
- `src/languages.ts`
- `tests/languages/elixir.test.ts`
- `tests/samples/elixir/*`
- `tests/project-file-discovery.test.ts`

Changes:

- Add `.ex` and `.exs` support.
- Extract modules, aliases, imports, requires, uses, functions, private functions, macros, and nested modules.
- Add tests for module graph, nested declarations, scripts, and discovery.

Command:

```bash
npx vitest run tests/languages/elixir.test.ts tests/project-file-discovery.test.ts
```

Commit:

```bash
git add src/languages tests/languages/elixir.test.ts tests/samples/elixir tests/project-file-discovery.test.ts
git commit -m "feat: add Elixir graph support"
```

### Task 7: Add Objective-C graph-first support

Files:

- `src/languages/definitions/objectiveC.ts`
- `src/languages/all.ts`
- `src/languages.ts`
- `tests/languages/objective-c.test.ts`
- `tests/samples/objective-c/*`
- `tests/project-file-discovery.test.ts`

Changes:

- Add `.m` support only.
- Extract imports, includes, interfaces, implementations, protocols, categories, and methods.
- Add tests that `.m` is discovered and `.h` behavior remains governed by the existing C/C++ heuristic.

Command:

```bash
npx vitest run tests/languages/objective-c.test.ts tests/project-file-discovery.test.ts
```

Commit:

```bash
git add src/languages tests/languages/objective-c.test.ts tests/samples/objective-c tests/project-file-discovery.test.ts
git commit -m "feat: add Objective-C graph support"
```

### Task 8: Add Julia graph-first support

Files:

- `src/languages/definitions/julia.ts`
- `src/languages/all.ts`
- `src/languages.ts`
- `tests/languages/julia.test.ts`
- `tests/samples/julia/*`
- `tests/project-file-discovery.test.ts`

Changes:

- Add `.jl` support.
- Extract modules, using/import dependencies, includes, functions, compact functions, structs, abstract types, and macros.
- Add tests for dependency graph, chunks, symbols, and discovery.

Command:

```bash
npx vitest run tests/languages/julia.test.ts tests/project-file-discovery.test.ts
```

Commit:

```bash
git add src/languages tests/languages/julia.test.ts tests/samples/julia tests/project-file-discovery.test.ts
git commit -m "feat: add Julia graph support"
```

### Task 9: Add Dart graph-first support

Files:

- `src/languages/definitions/dart.ts`
- `src/languages/all.ts`
- `src/languages.ts`
- `tests/languages/dart.test.ts`
- `tests/samples/dart/*`
- `tests/project-file-discovery.test.ts`

Changes:

- Add `.dart` support.
- Extract library declarations, imports, exports, parts, classes, mixins, extensions, enums, typedefs, and top-level functions.
- Add tests for part files, exports, chunks, symbols, and discovery.

Command:

```bash
npx vitest run tests/languages/dart.test.ts tests/project-file-discovery.test.ts
```

Commit:

```bash
git add src/languages tests/languages/dart.test.ts tests/samples/dart tests/project-file-discovery.test.ts
git commit -m "feat: add Dart graph support"
```

### Task 10: Add shared semantic boundary tests

Files:

- `tests/goto.test.ts`
- `tests/references.test.ts`
- `tests/native-semantic-parity.test.ts`
- `docs/language-parity.md`
- `docs/scenario-catalog.md`

Changes:

- Add negative or boundary tests proving graph-first languages do not falsely report full semantic navigation.
- If a language accidentally resolves something through a generic fallback, document and test the exact supported behavior.
- Finalize docs with the actual implemented support, not the planned support.

Command:

```bash
npx vitest run tests/goto.test.ts tests/references.test.ts tests/native-semantic-parity.test.ts
```

Commit:

```bash
git add tests/goto.test.ts tests/references.test.ts tests/native-semantic-parity.test.ts docs/language-parity.md docs/scenario-catalog.md
git commit -m "test: lock graph-first navigation boundaries"
```

### Task 11: Full verification and docs sweep

Files:

- `README.md`
- `docs/language-parity.md`
- `docs/scenario-catalog.md`
- `docs/how-it-works.md`
- `codegraph-skill/codegraph/SKILL.md`

Changes:

- Ensure every new language appears consistently in docs, scenarios, skill instructions, and tests.
- Verify docs do not claim cross-file go-to/reference support.
- Verify all public supported-language tables match the implemented extension set.

Commands:

```bash
npm run build
npm run test:ci
npm run test:native
```

Commit:

```bash
git add README.md docs/language-parity.md docs/scenario-catalog.md docs/how-it-works.md codegraph-skill/codegraph/SKILL.md
git commit -m "docs: finalize graph-first language support"
```

## Acceptance Criteria

- All seven languages parse through JS fallback.
- All seven languages parse through native runtime, unless a documented grammar compatibility blocker is found and reflected in parity docs.
- File discovery includes the planned extensions.
- Each language has a focused `tests/languages/*.test.ts` suite and fixtures.
- Each language extracts top-level declarations and static dependency edges listed in this plan.
- Go-to and references tests preserve honest unsupported behavior.
- Docs, scenario catalog, README, and agent skill instructions all describe the same support surface.

## Risks

- Grammar node names may differ substantially from assumptions. Mitigation: start each language with a fixture-driven AST inspection and keep extraction tied to observed node kinds.
- Objective-C extension ownership can conflict with C/C++ headers. Mitigation: support `.m` first and defer `.h`/`.mm`.
- PowerShell `.psd1` manifests are data files, not ordinary script files. Mitigation: parse simple manifests for dependencies only and mark complex cases unsupported.
- Graph-first support may be mistaken for full semantic navigation. Mitigation: parity docs and negative tests make the boundary explicit.

## References

- [Language support checklist](../../adding-language-support.md)
- [Language parity matrix](../../language-parity.md)
- [Scenario catalog](../../scenario-catalog.md)
- [`tree-sitter-scala` on npm](https://www.npmjs.com/package/tree-sitter-scala)
- [`tree-sitter-lua` on npm](https://www.npmjs.com/package/tree-sitter-lua)
- [`tree-sitter-powershell` on npm](https://www.npmjs.com/package/tree-sitter-powershell)
- [`tree-sitter-elixir` on npm](https://www.npmjs.com/package/tree-sitter-elixir)
- [`tree-sitter-objc` on npm](https://www.npmjs.com/package/tree-sitter-objc)
- [`tree-sitter-julia` on npm](https://www.npmjs.com/package/tree-sitter-julia)
- [`tree-sitter-dart` on npm](https://www.npmjs.com/package/tree-sitter-dart)
