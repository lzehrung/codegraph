# Source language expansion

Status: Planned. Add one language per pull request; do not ship a language pack.

## Goal

Extend Codegraph to a new source language through the existing language-support workflow without claiming semantic behavior that the shared suites do not prove.

## Candidate backlog

| Language    | Extensions               | Initial static dependency shapes              |
| ----------- | ------------------------ | --------------------------------------------- |
| Lua         | `.lua`                   | Literal `require(...)`                        |
| Scala       | `.scala`, `.sc`          | Package and import declarations               |
| PowerShell  | `.ps1`, `.psm1`, `.psd1` | Module imports and literal dot-sourcing       |
| Elixir      | `.ex`, `.exs`            | `alias`, `import`, `require`, and `use`       |
| Objective-C | `.m`                     | Imports and includes                          |
| Julia       | `.jl`                    | `using`, `import`, and literal `include(...)` |
| Dart        | `.dart`                  | Imports, exports, and parts                   |

Lua is the default first candidate because it offers a compact vertical slice with common plugin and configuration use cases. Product evidence may select another candidate.

Objective-C `.h` and `.mm` remain out of the initial slice until ownership can be resolved without breaking the existing C/C++ header heuristic.

## Per-language contract

The first pull request for a language must provide:

- discovery for the documented extensions
- native parsing when a compatible, license-acceptable Rust grammar exists
- safe reduced-mode graph and regex recovery when native parsing is unavailable
- block-aware chunking for important declarations
- top-level symbol extraction
- conservative static dependency edges
- file and symbol participation in search, graph, impact, and review

Cross-file `goto`, references, call hierarchy, type hierarchy, and implementation lookup are supported only where the existing shared semantic suites prove them. Partial or unsupported behavior must remain explicit in parity docs and negative tests.

## Slice workflow

Follow [the language support checklist](../adding-language-support.md) rather than duplicating its file-by-file instructions here:

1. Inspect the grammar against representative fixtures and record exact node kinds.
2. Add the language definition, registry entry, discovery extensions, and native grammar identity.
3. Implement declarations, imports, and chunks from observed syntax only.
4. Add the nearest `tests/languages/*.test.ts` suite and representative fixtures.
5. Add shared coverage in `tests/goto.test.ts`, `tests/references.test.ts`, and `tests/native-semantic-parity.test.ts` for every claimed cross-file capability.
6. Update `docs/language-parity.md` and `docs/scenario-catalog.md`; update public language tables and the agent skill when their claims change.
7. Run the focused language and parity suites, `npm run test:native`, and `npm run check`.

## Candidate-specific boundaries

- Lua: accept literal module names; skip dynamic `require`, metatable inference, and runtime path execution.
- Scala: cover packages, classes, objects, traits, enums, defs, and top-level values before advanced implicit or type resolution.
- PowerShell: treat `.psd1` as a data-oriented manifest and extract only conservative literal dependencies.
- Elixir: cover modules and explicit import-like forms; do not infer macro expansion or runtime module construction.
- Objective-C: cover interfaces, implementations, protocols, categories, and methods in `.m`; defer header and Objective-C++ ownership.
- Julia: cover modules, declarations, and literal includes; skip dynamic evaluation and generated names.
- Dart: cover libraries, parts, classes, mixins, extensions, enums, typedefs, and top-level functions without build-system inference.

## Acceptance

- The new language appears in doctor and native supported-language output when native support is available.
- Discovery, parsing, chunks, declarations, and static dependency edges match the documented fixtures.
- Unsupported dynamic forms fail conservatively.
- Public claims match the shared semantic tests and language parity matrix.
- Existing supported-language behavior and extension ownership remain unchanged.

## Non-goals

- No multiple-language pull request.
- No arbitrary grammar loading from project config.
- No type-aware or build-system-aware resolution without a separate proven design.
- No promotion from graph-first support to semantic parity based on generic fallback behavior alone.
