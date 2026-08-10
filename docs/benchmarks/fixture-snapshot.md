# Fixture test matrix

This table is generated directly from running `tests/languages/*.test.ts` with Vitest. There is no hand-curated corpus behind it: every row is a real test file, and every count is a real pass/fail result from the run that produced this file.

Scope: this counts only the dedicated per-language smoke files, not a language's total coverage. Every native-runtime language is also exercised by shared cross-language suites (for example `tests/goto.test.ts`, `tests/references.test.ts`, `tests/native-semantic-parity.test.ts`, `tests/type-hierarchy-language-parity.test.ts`, `tests/call-hierarchy-language-parity.test.ts`, `tests/impact-call-compatibility/cross-language.test.ts`) that are not reflected in the counts below. TypeScript/JavaScript are undercounted the most: they are codegraph's own implementation language and default fixture, so most of the non-language-specific tests in this repo exercise them too.

Regenerate with `npm run bench:fixtures`. Verify it is current with `npm run bench:fixtures:check`.

Generated: 2026-08-10T15:25:50.763Z (Node v22.16.0)

Total: 237 tests, 0 failed.

| Language         | Status  | Tests | Test file(s)                         |
| ---------------- | ------- | ----- | ------------------------------------ |
| AsciiDoc         | passing | 3     | `tests/languages/adoc.test.ts`       |
| Astro            | passing | 3     | `tests/languages/astro.test.ts`      |
| C                | passing | 5     | `tests/languages/c.test.ts`          |
| C#               | passing | 5     | `tests/languages/csharp.test.ts`     |
| C++              | passing | 6     | `tests/languages/cpp.test.ts`        |
| CSS              | passing | 2     | `tests/languages/css.test.ts`        |
| Go               | passing | 8     | `tests/languages/go.test.ts`         |
| Handlebars       | passing | 3     | `tests/languages/hbs.test.ts`        |
| HTML             | passing | 2     | `tests/languages/html.test.ts`       |
| Java             | passing | 13    | `tests/languages/java.test.ts`       |
| JavaScript       | passing | 2     | `tests/languages/javascript.test.ts` |
| Kotlin           | passing | 8     | `tests/languages/kotlin.test.ts`     |
| Less             | passing | 2     | `tests/languages/less.test.ts`       |
| Markdown         | passing | 3     | `tests/languages/markdown.test.ts`   |
| MDX              | passing | 3     | `tests/languages/mdx.test.ts`        |
| PHP              | passing | 44    | `tests/languages/php.test.ts`        |
| Python           | passing | 5     | `tests/languages/python.test.ts`     |
| reStructuredText | passing | 3     | `tests/languages/rst.test.ts`        |
| Ruby             | passing | 5     | `tests/languages/ruby.test.ts`       |
| Rust             | passing | 10    | `tests/languages/rust.test.ts`       |
| SCSS             | passing | 5     | `tests/languages/scss.test.ts`       |
| SQL              | passing | 6     | `tests/languages/sql.test.ts`        |
| Svelte           | passing | 4     | `tests/languages/svelte.test.ts`     |
| Swift            | passing | 4     | `tests/languages/swift.test.ts`      |
| TSX              | passing | 2     | `tests/languages/tsx.test.ts`        |
| TypeScript       | passing | 3     | `tests/languages/typescript.test.ts` |
| Vue              | passing | 4     | `tests/languages/vue.test.ts`        |
| Zig              | passing | 7     | `tests/languages/zig.test.ts`        |

This is fixture pass/fail, not a claimed-capability matrix. For claimed capability support per language, see [Language coverage parity matrix](../language-parity.md). For the fixture behind each named scenario, see [Scenario catalog](../scenario-catalog.md).
