<!-- fb907d59-edec-478a-8d8a-0aa87835de22 1504f481-e083-46ba-b6da-101dc0a8b660 -->
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

### To-dos

- [ ] Adopt parser pool in graphs, indexer, grep
- [ ] Use getCompiledQueries everywhere querying is done
- [ ] Harden fast-graph: skip strings or add lightweight lexer
- [ ] Create shared JS/TS/Python specifier extraction utils
- [ ] Add visited-set guard to resolveExport and tests
- [ ] Make namespace member refs AST-based, not regex
- [ ] Switch Python specifier collection to parser captures
- [ ] Enhance __all__ extraction for tuples/multiline/concat
- [ ] Add concurrency control to collectGraph and CLI flag
- [ ] Reuse parsed trees in goto/refs via ProjectIndex
- [ ] Add optional node_modules resolution flag
- [ ] Style type-only edges in Mermaid (flagged)
- [ ] Add normalizePath util and apply consistently
- [ ] Create types.ts for shared types
- [ ] Tests: fast-graph ignore strings/template literals
- [ ] Tests: circular re-exports resolution and no recursion blowup
- [ ] Tests: ns.member only in code, across newlines
- [ ] Tests: Python parenthesized/multiline/relative imports
- [ ] Tests: Python __all__ variants
- [ ] Tests: TS paths/baseUrl and workspace exports maps
- [ ] Tests: type-only edge styling in Mermaid and DOT
- [ ] Tests: graph --threads concurrency behavior