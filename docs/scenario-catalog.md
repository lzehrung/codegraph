# Scenario catalog

Minimal catalog of Tree-sitter scenarios with sample coverage.

## JavaScript

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Dynamic import specifier | `tests/samples/javascript/dynamic-import.js` | Dependency graph includes edge to `helpers.js` when `import()` is used. | https://github.com/tree-sitter/tree-sitter-javascript | 2026-01-22 |

## TypeScript

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Dynamic import specifier | `tests/samples/typescript/dynamic-import.ts` | Dependency graph includes edge to `helpers.ts` when `import()` is used. | https://github.com/tree-sitter/tree-sitter-typescript | 2026-01-22 |
