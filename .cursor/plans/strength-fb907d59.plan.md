---
name: Strengthen Codegraph Core
overview: ""
todos:
  - id: 15086cf3-e581-4e50-8264-9b39a98d8a09
    content: Adopt parser pool in graphs, indexer, grep
    status: pending
  - id: 246812fe-f5c9-478b-ae4f-685730e99eba
    content: Use getCompiledQueries everywhere querying is done
    status: pending
  - id: 7f6fba71-f9d9-49b3-a16b-8f7281cc0fbd
    content: "Harden fast-graph: skip strings or add lightweight lexer"
    status: pending
  - id: c3420935-c98d-4a3c-9557-60eeb653a90d
    content: Create shared JS/TS/Python specifier extraction utils
    status: pending
  - id: 76a07b9b-c9c1-4dba-8d7a-b199b8fcf074
    content: Add visited-set guard to resolveExport and tests
    status: pending
  - id: aaa63a1d-674c-4b0d-8388-c39b0d7f9513
    content: Make namespace member refs AST-based, not regex
    status: pending
  - id: c134c8e9-0fc1-4f27-a6ab-e35e1fc28727
    content: Switch Python specifier collection to parser captures
    status: pending
  - id: 88bc136d-98db-4902-aece-21b701ad72fc
    content: Enhance __all__ extraction for tuples/multiline/concat
    status: pending
  - id: a881e63b-f22e-4c36-a4cd-863ab8356ef4
    content: Add concurrency control to collectGraph and CLI flag
    status: pending
  - id: bf82d6f1-0d06-47bd-b9fd-ecf381d507af
    content: Reuse parsed trees in goto/refs via ProjectIndex
    status: pending
  - id: 7c48e29a-2aa3-4f2e-9432-6c7ad58b38e7
    content: Add optional node_modules resolution flag
    status: pending
  - id: 777b78e7-110a-4c1a-85a6-3ebbd5fd86a2
    content: Style type-only edges in Mermaid (flagged)
    status: pending
  - id: 05d4db45-18e8-4c99-a027-b5081fc37b6d
    content: Add normalizePath util and apply consistently
    status: pending
  - id: 6095119c-d7b6-476c-97a1-a4dbe51fc201
    content: Create types.ts for shared types
    status: pending
  - id: 2a0f1a32-0533-4887-8ee5-b41a4363e0bd
    content: "Tests: fast-graph ignore strings/template literals"
    status: pending
  - id: 6916b464-e958-4a86-be5f-7f478f727b13
    content: "Tests: circular re-exports resolution and no recursion blowup"
    status: pending
  - id: 8f346d56-3a50-45c2-9ebf-ddb46e8c461a
    content: "Tests: ns.member only in code, across newlines"
    status: pending
  - id: e68a1375-06e9-4abb-990b-532fd607a038
    content: "Tests: Python parenthesized/multiline/relative imports"
    status: pending
  - id: 18954a0a-d700-4d92-9b96-7903605af919
    content: "Tests: Python __all__ variants"
    status: pending
  - id: bd721061-1cd3-4054-939a-b5d55aafbeaf
    content: "Tests: TS paths/baseUrl and workspace exports maps"
    status: pending
  - id: a544ae17-174b-4e53-9674-08d08efc3044
    content: "Tests: type-only edge styling in Mermaid and DOT"
    status: pending
  - id: 753655e2-d702-4eb6-9364-0ebeb351a0f5
    content: "Tests: graph --threads concurrency behavior"
    status: pending
---

# Strengthen Codegraph Core

### Parsing and Query Reuse

- Use a shared parser pool from `src/util.ts` in `graphs.ts`, `indexer.ts`, and AST grep to avoid repeated `new Parser()`.
- Reuse compiled queries via `getCompiledQueries` from `src/languages.ts` instead of constructing new `Parser.Query` objects at call sites.

Code references:

```84:101:src/graphs.ts
  try {
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = opts?.tree ?? parser.parse(source);
    const q = new Parser.Query(lang, support.queries.imports);
    // ...
  }
```
```1183:1189:src/indexer.ts
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
```
```546:565:src/util.ts
export function acquireParser(lang: Parser.Language, key: LangKey): Parser { /* ... */ }
export function releaseParser(parser: Parser, key: LangKey) { /* ... */ }
```
```316:337:src/languages.ts
export function getCompiledQueries(/* ... */) { /* caches Parser.Query */ }
```

### Fast-graph reliability

- Harden fast JS/TS specifier extraction to avoid matching inside string literals. Either:
  - Strip strings before regex, or
  - Implement a tiny lexer for string/comment skipping.
- Add tests for false positives like `const s = "require('x')"` and template strings.

Code reference:

```56:81:src/graphs.ts
// Fast path (only strips comments; strings can cause false positives)
```

### DRY specifier extraction

- Consolidate JS/TS/Python specifier extraction into util helpers used by both `collectGraph` and `collectImportsForFile` to eliminate duplicated regex logic and keep behavior consistent.

Code references:

```32:54:src/graphs.ts
// Python regex path in graph specifier collection
```
```965:1021:src/indexer.ts
// Regex fallback for JS/TS import clause parsing
```

### Robust export resolution

- Guard `resolveExport` against circular re-exports with a `visited` set to prevent infinite recursion on cycles; add cycle tests.

Code reference:

```1435:1475:src/indexer.ts
export function resolveExport(/* ... recursive without visited guard ... */)
```

### Namespace member references

- Replace `collectNamespaceMemberRefs` regex with AST-based member-expression scanning to avoid false positives in strings/comments and to capture spaced/newline-separated member accesses.

Code reference:

```2084:2101:src/indexer.ts
// Regex-only scan for ns.member occurrences
```

### Python accuracy

- Use Tree-sitter for Python import specifiers (capture module and level fields) instead of regex to handle parenthesized and multiline imports.
- Improve `__all__` extraction to support tuples, concatenations, and multiline lists.

Code references:

```248:268:src/languages.ts
// Python import queries exist; currently graph uses regex path
```
```41:53:src/graphs.ts
// Python specifier collection via regex & stripping
```

### Concurrency, caching, and reuse

- Limit concurrency in `collectGraph` similar to `mapLimit` to avoid I/O bursts on very large repos; expose `--threads` for `graph`.
- Reuse parsed trees in navigation: thread `parsed` maps through `ProjectIndex` and into `goToDefinition`/`findReferences` to avoid re-parsing.
- Call `releaseParser` and delete trees where appropriate to reduce memory.

### Resolution enhancements

- Strengthen workspace `exports` subpath handling; add tests for condition maps and nested objects.
- Optional: add `--resolve-node-modules` to resolve package entry points in `node_modules` (keep default as external for current behavior).

### Output polish

- In Mermaid, style type-only edges (e.g., dotted) analogous to DOT output; add a flag to toggle.
- Normalize paths via a single `normalizePath()` util.

### Types and structure

- Centralize common types (`FileId`, `Range`, `EdgeTo`) in a shared `types.ts` to prevent duplication across `graphs.ts` and `indexer.ts`.

### Tests to add (key cases)

- JS/TS fast-graph: string literal false positives; template literals; mixed comments/strings.
- Circular re-exports: depth, cycles across files; ensure no stack overflow and correct resolution.
- Namespace member refs: ensure only code hits, across newlines and with spacing.
- Python: parenthesized imports, relative imports with multiple dots, multiline `from ... import (...)`.
- Python `__all__`: simple list, tuple, multiline, concatenations.
- TS path mapping (`baseUrl`, `paths`) and workspace `exports` maps.
- Mermaid/DOT: type-only styling applied and serialized correctly.
- Graph concurrency flag: behavior with different `--threads`.