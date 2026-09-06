# Fixture test matrix

This table is generated directly from running `tests/languages/*.test.ts` with Vitest. There is no hand-curated corpus behind it: every row is a real test file, and every count is a real pass/fail result from the run that produced this file.

Scope: this counts only the dedicated per-language smoke files, not a language's total coverage. Every native-runtime language is also exercised by shared cross-language suites (for example `tests/goto.test.ts`, `tests/references.test.ts`, `tests/native-semantic-parity.test.ts`, `tests/type-hierarchy-language-parity.test.ts`, `tests/call-hierarchy-language-parity.test.ts`, `tests/impact-call-compatibility/cross-language.test.ts`) that are not reflected in the counts below. TypeScript/JavaScript are undercounted the most: they are codegraph's own implementation language and default fixture, so most of the non-language-specific tests in this repo exercise them too.

Regenerate with `npm run bench:fixtures`. Verify it is current with `npm run bench:fixtures:check`.

Generated: 2026-09-06T15:59:40.664Z (Node v22.16.0)

Total: 256 tests, 0 failed.

| Language         | Status  | Tests | Test file(s)                         |
| ---------------- | ------- | ----- | ------------------------------------ |
| AsciiDoc         | passing | 4     | `tests/languages/adoc.test.ts`       |
| Astro            | passing | 5     | `tests/languages/astro.test.ts`      |
| C                | passing | 5     | `tests/languages/c.test.ts`          |
| C#               | passing | 8     | `tests/languages/csharp.test.ts`     |
| C++              | passing | 10    | `tests/languages/cpp.test.ts`        |
| CSS              | passing | 6     | `tests/languages/css.test.ts`        |
| Go               | passing | 13    | `tests/languages/go.test.ts`         |
| Handlebars       | passing | 3     | `tests/languages/hbs.test.ts`        |
| HTML             | passing | 5     | `tests/languages/html.test.ts`       |
| Java             | passing | 19    | `tests/languages/java.test.ts`       |
| JavaScript       | passing | 5     | `tests/languages/javascript.test.ts` |
| Kotlin           | passing | 9     | `tests/languages/kotlin.test.ts`     |
| Less             | passing | 6     | `tests/languages/less.test.ts`       |
| Markdown         | passing | 3     | `tests/languages/markdown.test.ts`   |
| MDX              | passing | 3     | `tests/languages/mdx.test.ts`        |
| PHP              | passing | 50    | `tests/languages/php.test.ts`        |
| Python           | passing | 12    | `tests/languages/python.test.ts`     |
| reStructuredText | passing | 4     | `tests/languages/rst.test.ts`        |
| Ruby             | passing | 8     | `tests/languages/ruby.test.ts`       |
| Rust             | passing | 15    | `tests/languages/rust.test.ts`       |
| SCSS             | passing | 7     | `tests/languages/scss.test.ts`       |
| SQL              | passing | 7     | `tests/languages/sql.test.ts`        |
| Svelte           | passing | 10    | `tests/languages/svelte.test.ts`     |
| Swift            | passing | 5     | `tests/languages/swift.test.ts`      |
| TSX              | passing | 6     | `tests/languages/tsx.test.ts`        |
| TypeScript       | passing | 6     | `tests/languages/typescript.test.ts` |
| Vue              | passing | 11    | `tests/languages/vue.test.ts`        |
| Zig              | passing | 8     | `tests/languages/zig.test.ts`        |

This is fixture pass/fail, not a claimed-capability matrix. For claimed capability support per language, see [Language coverage parity matrix](../language-parity.md). For the fixture behind each named scenario, see [Scenario catalog](../scenario-catalog.md).
