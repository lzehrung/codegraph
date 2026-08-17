# Unicode identifier canonicalization for name resolution (2026-08-17)

Status: Planned. Not started; no code in this plan has landed.

## Problem

PR #262 broadened import/alias extraction regexes (`src/util/identifiers.ts`,
`src/languages/importStatementParsers.ts`, `src/indexer/imports/*.ts`,
`src/graphs/specifiers.ts`, `src/util/specifiers.ts`) to accept each source
language's real identifier grammar, including combining-mark continuations
(Mn/Mc) for Java, C#, and PHP, and identifier-ignorable formatting/control
characters (Cf, plus a handful of ISO control ranges) for Java.

Accepting a wider identifier at the regex layer is necessary but not
sufficient for correct resolution: four languages define two spellings of
"the same" identifier as equal for name-resolution purposes, and
`codegraph` currently compares raw captured text everywhere, so it will
treat those equal spellings as different symbols.

- **Python (PEP 3131)**: identifiers are compared after NFKC normalization.
  `café` (NFC, U+00E9) and `cafe\u0301` (NFD, "e" + combining acute) are the
  _same_ identifier to CPython.
- **Rust**: `rustc` normalizes identifiers to NFC before name resolution
  (tracked via `rustc_lexer`/`rustc_parse` identifier normalization since
  the RFC on non-ASCII idents). Same NFC/NFD pair collapses to one name.
- **Java (JLS §3.8)**: two identifiers are the same "if, after ignoring
  characters for which `Character.isIdentifierIgnorable` returns true, they
  have the same sequence of characters." This is not Unicode normalization;
  it is deletion of `Cf` formatting characters (ZWNJ/ZWJ/bidi/etc.) and a
  handful of ISO control ranges — the exact character set
  `JAVA_IDENTIFIER_SOURCE` (added in #262) now accepts as legal continuation
  characters. `Foo` and `Foo\u200C` are the same field to `javac` but would
  currently resolve as two different symbols here.
- **C# (ECMA-334)**: two identifiers match if identical after (1) removing
  a leading `@` verbatim-identifier prefix, (2) resolving
  unicode-escape-sequences, and (3) removing `Cf` formatting characters.
  `@Widget` and `Widget` name the same symbol; `Widget` and `Widget\u200C`
  do too. `CSHARP_IDENTIFIER_SOURCE` (added in #262) accepts both the `@`
  prefix and `Cf` continuation but nothing downstream removes them for
  comparison.

Kotlin and Go have no such rule (raw code point sequences are compared
directly per their specs, and neither grammar admits `Cf`/ignorable
characters at all), so this plan does not touch them. PHP compares raw
bytes with no normalization step either. JS/TS (ECMAScript) also performs
no identifier normalization for name resolution — two different Unicode
spellings are genuinely different bindings.

Today, `codegraph` captures whatever byte sequence appears at each site
(import statement, declaration, reference) and compares those sequences
verbatim. This is a real, silent navigation/reference gap, not a parsing
gap — it cannot be fixed by adjusting a regex character class.

## Why this is a separate PR

Fixing this only where PR #262 touched code (import binding extraction)
would be incomplete and misleading: it would make imports parse but not
resolve, or resolve inconsistently depending on which side of a match was
canonicalized. Correct behavior requires canonicalizing at every point a
Python, Rust, Java, or C# identifier is captured or compared:

1. **Import/alias extraction** (already regex-broadened in #262):
   - `src/indexer/imports/python.ts` (`collectPythonImportsFromSource`)
   - `src/graphs/specifiers.ts` (native Python `import`/`from` parsing)
   - `src/util/specifiers.ts` (`extractPythonSpecifiers` fallback)
   - `src/languages/importStatementParsers.ts` (`parseRustImportStatement`,
     `parseJavaImportStatement`, `parseCsharpUsingDirective`)
   - `src/indexer/imports/languageSpecific.ts` (Java text fallback)
2. **Symbol declaration indexing** — not touched by #262, and the actual
   source of the "declaration name" side of every match:
   - `src/indexer/locals-and-exports.ts` (native capture → `SymbolDef.localName`)
   - Wherever Rust/Python/Java/C# detailed symbol extraction reads a node's
     text as a declaration name (`src/graphs/symbol-graph-detailed/*`,
     native query capture text for `name`/`tname` captures).
3. **Navigation/resolution matching**:
   - `src/indexer/navigation.ts` (`findReferences`)
   - `src/indexer/navigation-resolve.ts` (`resolveExport`, import → declaration matching)
   - `src/indexer/navigation-references.ts` (scope-based reference matching)
   - `src/agent/renamePreview.ts`, `src/agent/refactorPlan.ts` (candidate
     matching reuses the navigation layer, so should inherit this for free
     once navigation canonicalizes)
4. **Symbol/reference hashing and IDs** — `defNodeId` in
   `src/graphs/symbol-graph.ts` includes `localName` verbatim in the node
   ID; canonicalizing only for comparison (not for the stored ID/display
   name) avoids changing portable handles or displayed source text.

## Proposed approach

- Add `canonicalizeIdentifierForComparison(name: string, languageId: string): string`
  to `src/util/identifiers.ts` with one explicit branch per language that
  needs it, and an explicit passthrough default for every other language
  (never a default `.normalize()`/strip call, so adding a new language
  never silently opts in):
  - `"python"`: `name.normalize("NFKC")`.
  - `"rust"`: `name.normalize("NFC")`.
  - `"java"`: strip every code point in the `JAVA_IDENTIFIER_SOURCE`
    continuation class's `Cf`/ISO-control set (reuse the same ranges
    documented on `JAVA_IDENTIFIER_SOURCE` so the two never drift apart).
  - `"csharp"`/`"cs"`: strip a single leading `@`, then strip `Cf`
    characters (reuse the `Cf` portion of `CSHARP_IDENTIFIER_SOURCE`).
  - everything else: return `name` unchanged.
- Canonicalize **only at comparison sites**, never at storage sites: keep
  `SymbolDef.localName`, import binding `imported`/`local`, and displayed
  text exactly as they appear in source (required for accurate ranges,
  rename edits, and portable handles). Build a canonicalized comparison key
  alongside the raw name wherever lookups currently do `a === b` or
  `map.get(name)` on a Python/Rust/Java/C# identifier, and use that key for
  the lookup while keeping the raw name for everything else.
- Concretely: extend whatever lookup structure `resolveExport`/`findReferences`
  use (name → declaration map) to key by
  `canonicalizeIdentifierForComparison` instead of the raw string, for
  Python, Rust, Java, and C# only.

## Verification plan

- Unit tests in `tests/import-extraction-unicode-identifiers.test.ts`
  proving each canonicalization branch collapses the documented equal
  pairs (`café`/`cafe\u0301` for Python, `Foo`/`Foo\u200C` for Java,
  `@Widget`/`Widget` for C#, NFC/NFD pairs for Rust) to the same key,
  covering both the extraction and declaration side.
- New cross-file fixtures (see the companion E2E fixture plan
  `2026-08-17-unicode-import-e2e-fixtures.md`) per canonicalizing language:
  a declaration file using one spelling and a consumer importing the
  equal-but-differently-spelled form, asserting `goto`/`references`
  resolve across the pair.
- Explicit regression proving Kotlin/Go/PHP/JS/TS do **not** canonicalize
  (two differently-spelled-but-"equal" forms remain distinct symbols for
  those languages), so this change cannot silently over-canonicalize them.
- Update `docs/language-parity.md`: state which languages canonicalize
  identifiers for resolution (Python NFKC, Rust NFC, Java
  identifier-ignorable stripping, C# `@`-prefix + formatting-character
  stripping) and which do not.

## Non-goals

- No change to displayed/stored identifier text, portable search handles,
  or rename-edit content — canonicalization is comparison-only.
- No canonicalization for languages without a documented spec rule
  (Kotlin, Go, PHP, JS/TS) even though PR #262 broadened their extraction
  grammars; those characters remain part of the identifier's identity for
  those languages, matching their real compilers.
