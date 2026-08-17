# End-to-end fixture coverage for Unicode import identifiers (2026-08-17)

Status: Planned. Not started; no code in this plan has landed.

## Problem

PR #262 broadened import/alias extraction across JS/TS, Python, PHP, Rust,
Go, Java, Kotlin, and C# (`src/util/identifiers.ts` and the parsers/fallback
extractors that consume it) and added parser-level unit coverage in
`tests/import-extraction-unicode-identifiers.test.ts`. Those tests prove the
regexes and binding-construction functions accept/reject the right inputs
in isolation, matching each language's real identifier grammar.

They do not prove a Unicode-named import survives the full pipeline: native
parse → import binding → graph edge → symbol declaration → `goto`/
`references` resolution. Per `AGENTS.md`, "when adding or changing a
cross-file language scenario, add or update the nearest language test in
`tests/languages/*.test.ts` and the shared semantic coverage in
`tests/goto.test.ts`, `tests/references.test.ts`, and
`tests/native-semantic-parity.test.ts` when the language uses the native
runtime" — this PR's identifier-breadth change qualifies and that coverage
is currently missing.

## Scope

One cross-file scenario per already-native language touched by the
identifier-breadth work, following the existing fixture pattern in
`tests/samples/<language>/` (see `tests/samples/python/.regressions/
unicode_def.py` / `unicode_consumer.py`, already added by this PR, as the
template):

| Language | Sample directory                     | Unicode case to cover                                                                      |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Java     | `tests/samples/java/.regressions/`   | `$`-prefixed and combining-mark class/import name                                          |
| Kotlin   | `tests/samples/kotlin/.regressions/` | Unicode `import ... as alias`                                                              |
| C#       | `tests/samples/csharp/.regressions/` | `using alias = Namespace;` with a combining-mark alias, plus `@class`-style verbatim alias |
| Go       | `tests/samples/go/.regressions/`     | Unicode-letter import alias                                                                |
| PHP      | `tests/samples/php/.regressions/`    | non-`\p{L}` `use ... as alias` (e.g. emoji)                                                |
| Rust     | `tests/samples/rust/.regressions/`   | `use ... as alias` with XID continuation beyond `\p{L}`/`\p{N}`                            |

JS/TS/TSX and Python already have adjacent native-semantic-parity coverage
from this PR (`tests/samples/python/.regressions/unicode_*.py`,
`tests/native-semantic-parity.test.ts` Python fixtures); this plan extends
the same pattern to the remaining six languages.

## Per-language work (repeat for each row above)

1. Add a two-file fixture: a declaration file with a Unicode-named
   exported symbol, and a consumer file that imports it using the
   Unicode form the corresponding parser fix now accepts.
2. Extend `tests/languages/<language>.test.ts` with a case asserting the
   dependency graph includes the edge between consumer and declaration
   file (mirrors existing `LanguageTestDefinition` fixtures in that file).
3. Extend `tests/goto.test.ts` with a case asserting go-to-definition from
   the consumer's Unicode-named reference resolves to the declaration.
4. Extend `tests/references.test.ts` with a case asserting the declaration
   appears in `findReferences` results from the consumer's usage site.
5. If the language uses the native runtime (all six do), extend
   `tests/native-semantic-parity.test.ts` with the same fixture pair so
   native-mode regression coverage catches drift.
6. Add a `docs/scenario-catalog.md` row per language (companion to the
   parser-level rows already added by PR #262) pointing at the new
   `tests/languages/*.test.ts` case as the "Sample".

## Verification plan

- `npx vitest run tests/languages/<language>.test.ts tests/goto.test.ts
tests/references.test.ts tests/native-semantic-parity.test.ts` per
  language as each is added.
- Full `npm run check` once all six languages are covered.
- Confirm each new case fails against the pre-PR-#262 regex (sanity check
  that the fixture actually exercises the fixed code path, not an
  already-passing ASCII-only case).

## Non-goals

- No new fixtures for languages whose identifier grammar was not changed
  by PR #262 (Ruby, Swift, Zig, C, C++, SQL, etc.).
- No fixture coverage for the NFC/NFKC normalization work — that is
  tracked separately in `2026-08-17-unicode-identifier-normalization.md`
  and should reuse this plan's fixture pattern for Python/Rust once it
  lands, rather than duplicating fixture setup here.
