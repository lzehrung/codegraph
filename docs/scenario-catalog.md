# Scenario catalog

Minimal catalog of Tree-sitter scenarios with sample coverage.

## C#

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Using directives | `tests/samples/csharp/Main.cs` | Dependency graph includes edges to `Utils.cs` and `Helpers.cs` for using directives. | https://github.com/tree-sitter/tree-sitter-c-sharp | 2026-01-22 |

## CSS

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| `@import` stylesheets | `tests/samples/css/main.css` | Dependency graph includes edges to `base.css` and `theme.css` for `@import`. | https://github.com/tree-sitter/tree-sitter-css | 2026-01-22 |

## Go

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Package imports | `tests/samples/go/main.go` | Dependency graph includes edges to `utils.go` and `helpers.go` for `import` paths. | https://github.com/tree-sitter/tree-sitter-go | 2026-01-22 |

## HTML

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Script and stylesheet references | `tests/samples/html/index.html` | Dependency graph includes edges to `app.js` and `styles.css` via `src` and `href`. | https://github.com/tree-sitter/tree-sitter-html | 2026-01-22 |

## Java

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Static imports | `tests/samples/java/static-imports.java` | Dependency graph includes edges to `utils/Utils.java` and `helpers/Helpers.java` for static imports. | https://github.com/tree-sitter/tree-sitter-java | 2026-01-22 |

## JavaScript

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Dynamic import specifier | `tests/samples/javascript/dynamic-import.js` | Dependency graph includes edge to `helpers.js` when `import()` is used. | https://github.com/tree-sitter/tree-sitter-javascript | 2026-01-22 |

## LESS

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| `@import` stylesheets | `tests/samples/less/main.less` | Dependency graph includes edges to `variables.less` and `theme.less` for `@import`. | https://github.com/tree-sitter/tree-sitter-css | 2026-01-22 |

## Python

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Relative `from` imports | `tests/samples/python/relative-imports.py` | Dependency graph includes edges to `utils.py` and `helpers.py` for relative `from` imports. | https://github.com/tree-sitter/tree-sitter-python | 2026-01-22 |

## Ruby

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| `require_relative` imports | `tests/samples/ruby/main.rb` | Dependency graph includes edges to `utils.rb` and `helpers.rb` for relative requires. | https://github.com/tree-sitter/tree-sitter-ruby | 2026-01-22 |

## Rust

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Module and `use` imports | `tests/samples/rust/main.rs` | Dependency graph includes edges to `utils.rs` and `helpers.rs` for `mod` and `use`. | https://github.com/tree-sitter/tree-sitter-rust | 2026-01-22 |

## SCSS

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| `@use` partials | `tests/samples/scss/use-partials.scss` | Dependency graph includes edges to `_variables.scss` and `_mixins.scss` for `@use`. | https://github.com/tree-sitter/tree-sitter-scss | 2026-01-22 |

## Svelte

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Inline script imports | `tests/samples/svelte/inline-script.svelte` | Dependency graph includes edge to `logic.ts` for inline script imports. | https://github.com/tree-sitter/tree-sitter-svelte | 2026-01-22 |

## TypeScript

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Dynamic import specifier | `tests/samples/typescript/dynamic-import.ts` | Dependency graph includes edge to `helpers.ts` when `import()` is used. | https://github.com/tree-sitter/tree-sitter-typescript | 2026-01-22 |

## TSX

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Component imports | `tests/samples/tsx/App.tsx` | Dependency graph includes edges to `components/Button.tsx` and `utils.ts` for TSX imports. | https://github.com/tree-sitter/tree-sitter-typescript | 2026-01-22 |

## Vue

| Scenario | Sample | Expected behavior | Source | Date added |
| --- | --- | --- | --- | --- |
| Inline script imports | `tests/samples/vue/inline-script.vue` | Dependency graph includes edge to `logic.ts` for inline script imports. | https://github.com/tree-sitter/tree-sitter-vue | 2026-01-22 |
