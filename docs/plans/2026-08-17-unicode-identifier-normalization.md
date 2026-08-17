# Unicode identifier normalization for name resolution (2026-08-17)

Status: Planned. Not started; no code in this plan has landed.

## Problem

PR #262 broadened import/alias extraction regexes (`src/util/identifiers.ts`,
`src/languages/importStatementParsers.ts`, `src/indexer/imports/*.ts`,
`src/graphs/specifiers.ts`, `src/util/specifiers.ts`) to accept each source
language's real identifier grammar, including combining-mark continuations
(Mn/Mc) for Java, C#, and PHP.

Accepting a decomposed identifier at the regex layer is necessary but not
sufficient for correct resolution. Two languages have an explicit
normalization rule in their spec:

- **Python (PEP 3131)**: identifiers are compared after NFKC normalization.
  `café` (NFC, U+00E9) and `cafe\u0301` (NFD, "e" + combining acute) are the
  _same_ identifier to CPython.
- **Rust**: `rustc` normalizes identifiers to NFC before name resolution
  (tracked via `rustc_lexer`/`rustc_parse` identifier normalization since
  Rust 1.0-era RFC on non-ASCII idents). Same NFC/NFD pair collapses to one
  name.

Java, C#, Kotlin, and Go do **not** normalize identifiers (each raw code
point sequence is a distinct identifier per their specs), so this plan is
scoped to Python and Rust only.

Today, `codegraph` captures whatever byte sequence appears at each site
(import statement, declaration, reference) and compares those sequences
verbatim. A decomposed import (`import cafe\u0301`) will not resolve to a
composed declaration (`def café(): ...`) or vice versa, even though the
source language treats them as identical. This is a real, silent
navigation/reference gap, not a parsing gap — it cannot be fixed by
adjusting a regex character class.

## Why this is a separate PR

Fixing this only where PR #262 touched code (import binding extraction)
would be incomplete and misleading: it would make imports parse but not
resolve, or resolve inconsistently depending on which side of a match was
normalized. Correct behavior requires normalizing at every point a Python
or Rust identifier is captured or compared:

1. **Import/alias extraction** (already regex-broadened in #262):
   - `src/indexer/imports/python.ts` (`collectPythonImportsFromSource`)
   - `src/graphs/specifiers.ts` (native Python `import`/`from` parsing)
   - `src/util/specifiers.ts` (`extractPythonSpecifiers` fallback)
   - `src/languages/importStatementParsers.ts` (`parseRustImportStatement`)
2. **Symbol declaration indexing** — not touched by #262, and the actual
   source of the "declaration name" side of every match:
   - `src/indexer/locals-and-exports.ts` (native capture → `SymbolDef.localName`)
   - Wherever Rust/Python detailed symbol extraction reads a node's text as
     a declaration name (`src/graphs/symbol-graph-detailed/*`, native query
     capture text for `name`/`tname` captures).
3. **Navigation/resolution matching**:
   - `src/indexer/navigation.ts` (`findReferences`)
   - `src/indexer/navigation-resolve.ts` (`resolveExport`, import → declaration matching)
   - `src/indexer/navigation-references.ts` (scope-based reference matching)
   - `src/agent/renamePreview.ts`, `src/agent/refactorPlan.ts` (candidate
     matching reuses the navigation layer, so should inherit this for free
     once navigation normalizes)
4. **Symbol/reference hashing and IDs** — `defNodeId` in
   `src/graphs/symbol-graph.ts` includes `localName` verbatim in the node
   ID; normalizing only for comparison (not for the stored ID/display name)
   avoids changing portable handles or displayed source text.

## Proposed approach

- Add `normalizeIdentifierForComparison(name: string, languageId: string): string`
  to `src/util/identifiers.ts`. For `"python"` apply `name.normalize("NFKC")`;
  for `"rust"` apply `name.normalize("NFC")`; for every other language return
  `name` unchanged (explicit passthrough, not a default `.normalize()` call,
  so adding a new language never silently opts in).
- Normalize **only at comparison sites**, never at storage sites: keep
  `SymbolDef.localName`, import binding `imported`/`local`, and displayed
  text exactly as they appear in source (required for accurate ranges,
  rename edits, and portable handles). Build a normalized comparison key
  alongside the raw name wherever lookups currently do `a === b` or
  `map.get(name)` on a Python/Rust identifier, and use that key for the
  lookup while keeping the raw name for everything else.
- Concretely: extend whatever lookup structure `resolveExport`/`findReferences`
  use (name → declaration map) to key by `normalizeIdentifierForComparison`
  instead of the raw string, for Python and Rust only.

## Verification plan

- Unit tests in `tests/import-extraction-unicode-identifiers.test.ts`
  proving decomposed vs. composed import specs normalize to the same
  extracted name (already partially covered for extraction; extend to
  prove the _declaration_ side too).
- New cross-file fixture (see the companion E2E fixture plan
  `2026-08-17-unicode-import-e2e-fixtures.md`) with a Python/Rust file
  declaring a composed identifier and a consumer importing the decomposed
  form (or vice versa), asserting `goto`/`references` resolve across the
  pair.
- Explicit regression proving Java/C#/Kotlin/Go/PHP do **not** normalize
  (a decomposed and composed Java identifier remain distinct symbols),
  so this change cannot silently over-normalize those languages.
- Update `docs/language-parity.md`: state which languages normalize
  identifiers for resolution (Python NFKC, Rust NFC) and which do not.

## Non-goals

- No change to displayed/stored identifier text, portable search handles,
  or rename-edit content — normalization is comparison-only.
- No normalization for languages without a documented spec rule (Java, C#,
  Kotlin, Go, PHP, JS/TS) even though their regex grammars now accept
  combining marks; those combining-mark characters remain part of the
  identifier's identity for those languages, matching their real compilers.
