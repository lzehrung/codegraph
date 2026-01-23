# Scenario catalog

Minimal catalog of Tree-sitter scenarios with sample coverage.

## JavaScript

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Dynamic import specifier | `tests/samples/javascript/dynamic-import.js` | Dependency graph includes edge to `helpers.js` when `import()` is used. | https://github.com/tree-sitter/tree-sitter-javascript | 2026-01-22 |

## Python

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Relative `from` imports | `tests/samples/python/relative-imports.py` | Dependency graph includes edges to `utils.py` and `helpers.py` for relative `from` imports. | https://github.com/tree-sitter/tree-sitter-python | 2026-01-22 |

## TypeScript

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Dynamic import specifier | `tests/samples/typescript/dynamic-import.ts` | Dependency graph includes edge to `helpers.ts` when `import()` is used. | https://github.com/tree-sitter/tree-sitter-typescript | 2026-01-22 |

## Java

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Static imports | `tests/samples/java/static-imports.java` | Dependency graph includes edges to `utils/Utils.java` and `helpers/Helpers.java` for static imports. | https://github.com/tree-sitter/tree-sitter-java | 2026-01-22 |
