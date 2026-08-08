# Fixture test matrix

This table is generated directly from running `tests/languages/*.test.ts` with Vitest. There is no hand-curated corpus behind it: every row is a real test file, and every count is a real pass/fail result from the run that produced this file.

Regenerate with `npm run bench:fixtures`. Verify it is current with `npm run bench:fixtures:check`.

Generated: 2026-08-08T02:00:08.120Z (Node v22.16.0)

Total: 227 tests, 0 failed.

| Language         | Status  | Tests | Passed | Failed | Skipped | Test file(s)                                                           |
| ---------------- | ------- | ----- | ------ | ------ | ------- | ---------------------------------------------------------------------- |
| AsciiDoc         | passing | 3     | 3      | 0      | 0       | `tests/languages/adoc.test.ts`                                         |
| Astro            | passing | 3     | 3      | 0      | 0       | `tests/languages/astro.test.ts`                                        |
| C                | passing | 5     | 5      | 0      | 0       | `tests/languages/c.test.ts`                                            |
| C#               | passing | 3     | 3      | 0      | 0       | `tests/languages/csharp.test.ts`                                       |
| C++              | passing | 6     | 6      | 0      | 0       | `tests/languages/cpp.test.ts`                                          |
| CSS              | passing | 2     | 2      | 0      | 0       | `tests/languages/css.test.ts`                                          |
| Go               | passing | 6     | 6      | 0      | 0       | `tests/languages/go.test.ts`                                           |
| Handlebars       | passing | 3     | 3      | 0      | 0       | `tests/languages/hbs.test.ts`                                          |
| HTML             | passing | 2     | 2      | 0      | 0       | `tests/languages/html.test.ts`                                         |
| Java             | passing | 13    | 13     | 0      | 0       | `tests/languages/java.test.ts`                                         |
| JavaScript       | passing | 2     | 2      | 0      | 0       | `tests/languages/javascript.test.ts`                                   |
| Kotlin           | passing | 8     | 8      | 0      | 0       | `tests/languages/kotlin.test.ts`                                       |
| Less             | passing | 2     | 2      | 0      | 0       | `tests/languages/less.test.ts`                                         |
| Markdown         | passing | 3     | 3      | 0      | 0       | `tests/languages/markdown.test.ts`                                     |
| MDX              | passing | 3     | 3      | 0      | 0       | `tests/languages/mdx.test.ts`                                          |
| PHP              | passing | 44    | 44     | 0      | 0       | `tests/languages/php.test.ts`                                          |
| Python           | passing | 4     | 4      | 0      | 0       | `tests/languages/python-all.test.ts`, `tests/languages/python.test.ts` |
| reStructuredText | passing | 3     | 3      | 0      | 0       | `tests/languages/rst.test.ts`                                          |
| Ruby             | passing | 5     | 5      | 0      | 0       | `tests/languages/ruby.test.ts`                                         |
| Rust             | passing | 5     | 5      | 0      | 0       | `tests/languages/rust.test.ts`                                         |
| SCSS             | passing | 5     | 5      | 0      | 0       | `tests/languages/scss.test.ts`                                         |
| SQL              | passing | 6     | 6      | 0      | 0       | `tests/languages/sql.test.ts`                                          |
| Svelte           | passing | 4     | 4      | 0      | 0       | `tests/languages/svelte.test.ts`                                       |
| Swift            | passing | 4     | 4      | 0      | 0       | `tests/languages/swift.test.ts`                                        |
| TSX              | passing | 2     | 2      | 0      | 0       | `tests/languages/tsx.test.ts`                                          |
| TypeScript       | passing | 3     | 3      | 0      | 0       | `tests/languages/typescript.test.ts`                                   |
| Vue              | passing | 4     | 4      | 0      | 0       | `tests/languages/vue.test.ts`                                          |
| Zig              | passing | 7     | 7      | 0      | 0       | `tests/languages/zig.test.ts`                                          |

This is fixture pass/fail, not a claimed-capability matrix. For claimed capability support per language, see [Language coverage parity matrix](../language-parity.md). For the fixture behind each named scenario, see [Scenario catalog](../scenario-catalog.md).
