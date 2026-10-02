# Call-form coverage matrix

Generated from the cell tables in `tests/call-form-matrix/languages/` by `tests/call-form-matrix.report.test.ts`. Regenerate with `UPDATE_CALL_FORM_REPORT=1 npx vitest run tests/call-form-matrix.report.test.ts`.

Each cell is one language and one call form: a small project, a use site, the declaration it must resolve to (or `not_found`), and a same-named decoy declaration it must not resolve to. A cell passes when `goToDefinition`, `findReferences`, and the detailed call graph agree on the use site, the decoy is excluded, and three metamorphic checks hold: an unrelated same-named file elsewhere changes nothing, a warm disk-cache build matches a cold build across a sequence of file mutations, and, where the cell gives one, moving the declaration moves the answer with it. `docs/plans/2026-09-28-unified-name-resolution.md` Step 1 is the design source.

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
| Java       | Covered   | Covered                  | Covered               | Covered              | Covered              | Covered      | Omitted               | Covered                    | Covered          | Covered         |
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
| TypeScript | 10    | 0          |
| TSX        | 10    | 0          |
| JavaScript | 9     | 0          |
| Python     | 9     | 0          |
| PHP        | 9     | 0          |
| Go         | 7     | 0          |
| Java       | 9     | 0          |
| C          | 1     | 0          |
| C++        | 10    | 0          |
| C#         | 10    | 0          |
| Kotlin     | 10    | 0          |
| Ruby       | 8     | 0          |
| Rust       | 8     | 0          |
| Swift      | 10    | 0          |
| Zig        | 7     | 0          |

Total: 127 cells across 15 languages, 0 known gaps.

## Known gaps

No known gaps.
