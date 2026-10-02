# Call-form coverage matrix

Generated from the cell tables in `tests/call-form-matrix/languages/` by `tests/call-form-matrix.report.test.ts`. Regenerate with `UPDATE_CALL_FORM_REPORT=1 npx vitest run tests/call-form-matrix.report.test.ts`.

Each cell is one language and one call form: a small project, a use site, the declaration it must resolve to (or `not_found`), and a same-named decoy declaration it must not resolve to. A cell passes when `goToDefinition`, `findReferences`, and the detailed call graph agree on the use site, the decoy is excluded, and three metamorphic checks hold: an unrelated same-named file elsewhere changes nothing, a warm disk-cache build matches a cold build after each of a sequence of file mutations, and, where the cell gives one, moving the declaration moves the answer with it. A language/call-form pair can carry more than one cell; the table below shows the worst status among them. `docs/plans/2026-09-28-unified-name-resolution.md` Step 1 is the design source.

Status key:

- Covered = the cell passes today.
- Known gap = the cell fails today; tracked with `it.fails` so it flips visibly once fixed.
- Omitted = the language has no idiomatic form for this call shape.

| Language   | Bare call | Qualified/namespace call | This/self member call | Typed-local receiver | Static/type receiver | Construction | Imported/aliased name | Overload by argument count | Inherited member | Super/base call |
| ---------- | --------- | ------------------------ | --------------------- | -------------------- | -------------------- | ------------ | --------------------- | -------------------------- | ---------------- | --------------- |
| TypeScript | Covered   | Covered                  | Covered               | Covered              | Covered              | Covered      | Covered               | Covered                    | Covered          | Covered         |
| TSX        | Covered   | Covered                  | Covered               | Covered              | Covered              | Covered      | Covered               | Covered                    | Covered          | Covered         |
| JavaScript | Covered   | Covered                  | Covered               | Covered              | Covered              | Covered      | Covered               | Omitted                    | Covered          | Covered         |
| Python     | Covered   | Covered                  | Covered               | Covered              | Covered              | Covered      | Covered               | Omitted                    | Covered          | Covered         |
| PHP        | Covered   | Covered                  | Covered               | Covered              | Covered              | Covered      | Covered               | Omitted                    | Covered          | Covered         |
| Go         | Covered   | Covered                  | Omitted               | Covered              | Omitted              | Covered      | Covered               | Omitted                    | Covered          | Covered         |
| Java       | Covered   | Covered                  | Covered               | Covered              | Covered              | Covered      | Covered               | Covered                    | Covered          | Covered         |
| C          | Covered   | Omitted                  | Omitted               | Omitted              | Omitted              | Omitted      | Omitted               | Omitted                    | Omitted          | Omitted         |
| C++        | Covered   | Covered                  | Covered               | Covered              | Covered              | Covered      | Covered               | Covered                    | Covered          | Covered         |
| C#         | Covered   | Covered                  | Covered               | Covered              | Covered              | Covered      | Covered               | Covered                    | Covered          | Covered         |
| Kotlin     | Covered   | Covered                  | Covered               | Covered              | Covered              | Covered      | Covered               | Covered                    | Covered          | Covered         |
| Ruby       | Covered   | Covered                  | Covered               | Covered              | Covered              | Covered      | Omitted               | Omitted                    | Covered          | Covered         |
| Rust       | Covered   | Covered                  | Covered               | Covered              | Covered              | Covered      | Covered               | Omitted                    | Covered          | Omitted         |
| Swift      | Covered   | Covered                  | Covered               | Covered              | Covered              | Covered      | Covered               | Covered                    | Covered          | Covered         |
| Zig        | Covered   | Covered                  | Covered               | Covered              | Covered              | Covered      | Covered               | Omitted                    | Omitted          | Omitted         |

## Cell counts

| Language   | Cells | Known gaps |
| ---------- | ----- | ---------- |
| TypeScript | 11    | 0          |
| TSX        | 10    | 0          |
| JavaScript | 10    | 0          |
| Python     | 9     | 0          |
| PHP        | 9     | 0          |
| Go         | 7     | 0          |
| Java       | 11    | 0          |
| C          | 1     | 0          |
| C++        | 11    | 0          |
| C#         | 11    | 0          |
| Kotlin     | 10    | 0          |
| Ruby       | 8     | 0          |
| Rust       | 8     | 0          |
| Swift      | 10    | 0          |
| Zig        | 7     | 0          |

Total: 133 cells across 15 languages, 0 known gaps.

## Moved-declaration coverage

The moved-declaration metamorphic check only runs for a cell that sets a `moved` variant. One cell per language sets one where the language's import model allows it cheaply (see each language's cell table for languages that cannot, and why).

| Language   | Cell running the moved check  |
| ---------- | ----------------------------- |
| TypeScript | `ts/bare-call`                |
| TSX        | `tsx/bare-call`               |
| JavaScript | `js/bare-call`                |
| Python     | `python/bare-call`            |
| PHP        | `php/qualified-call`          |
| Go         | `go/qualified-call`           |
| Java       | `java/typed-local-receiver`   |
| C          | none                          |
| C++        | `cpp/bare-call`               |
| C#         | `csharp/qualified-call`       |
| Kotlin     | `kotlin/typed-local-receiver` |
| Ruby       | `ruby/typed-local-receiver`   |
| Rust       | `rust/bare-call`              |
| Swift      | `swift/typed-local-receiver`  |
| Zig        | `zig/qualified-call`          |

14 of 15 languages run the moved-declaration check.

## Known gaps

No known gaps.
