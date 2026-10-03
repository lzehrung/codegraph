# Call-form coverage matrix

Generated from the cell tables in `tests/call-form-matrix/languages/` by `tests/call-form-matrix.report.test.ts`. Regenerate with `UPDATE_CALL_FORM_REPORT=1 npx vitest run tests/call-form-matrix.report.test.ts`.

Each cell is one language and one call form: a small project, a use site, the declaration it must resolve to (or `not_found`), and a same-named decoy declaration it must not resolve to. A cell passes when `goToDefinition`, `findReferences`, and the detailed call graph agree on the use site, the decoy is excluded, and three metamorphic checks hold: an unrelated same-named file elsewhere changes nothing, a warm disk-cache build matches a cold build after each of a sequence of file mutations, and, where the cell gives one, moving the declaration moves the answer with it. A language/call-form pair can carry more than one cell; the table below shows the worst status among them. `docs/plans/2026-09-28-unified-name-resolution.md` Step 1 is the design source.

Status key:

- Covered = the cell passes today.
- Known gap = the cell fails today; tracked with `it.fails` so it flips visibly once fixed.
- Omitted = the language has no idiomatic form for this call shape; see "Omitted call forms" below for the reason.

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

## Omitted call forms

Each entry is a language/call-form pair the table above marks "Omitted", with the reason the language has no idiomatic form for it. Every pair in the matrix has exactly one of a cell or an entry here, never neither or both -- enforced by a dedicated test in `tests/call-form-matrix.report.test.ts`.

- **JavaScript / Overload by argument count**: JavaScript has no declared-signature overloading, so a second same-name function declaration simply replaces the first rather than adding an arity variant.
- **Python / Overload by argument count**: Python has no argument-count-based overload dispatch, so the call form cannot be expressed (a later `def` of the same name simply replaces the earlier one).
- **PHP / Overload by argument count**: PHP rejects two declarations of the same name in one namespace, so argument-count overloading is not expressible as several declarations.
- **Go / This/self member call**: Go has no `this`/`self` keyword. A method's own receiver is an explicitly named, arbitrarily spelled parameter -- the exact mechanism "typed-local-receiver" already exercises -- so the two forms are not distinct in Go.
- **Go / Static/type receiver**: Go has no type-scoped static method distinct from an ordinary package-level function (covered by "qualified-call") or a value-receiver method (covered by "typed-local-receiver"); there is no third form.
- **Go / Overload by argument count**: Go rejects two function or method declarations with the same name in the same scope, so argument-count overloading is not expressible.
- **C / Qualified/namespace call**: C has no namespaces and no renaming import syntax -- `#include` never binds or renames a name.
- **C / This/self member call**: C has no receiver-based member dispatch. `docs/language-parity.md` names C as the one language excluded from `receiverAwareLanguages`: "C has no methods on types, so a struct function-pointer call emits no receiver edge."
- **C / Typed-local receiver**: C has no receiver-based member dispatch. `docs/language-parity.md` names C as the one language excluded from `receiverAwareLanguages`: "C has no methods on types, so a struct function-pointer call emits no receiver edge."
- **C / Static/type receiver**: C has no receiver-based member dispatch. `docs/language-parity.md` names C as the one language excluded from `receiverAwareLanguages`: "C has no methods on types, so a struct function-pointer call emits no receiver edge."
- **C / Construction**: C has no construction syntax distinct from an ordinary function call; a struct is stack-declared or zero-initialized, never "constructed" through a named form this matrix can address.
- **C / Imported/aliased name**: C has no namespaces and no renaming import syntax -- `#include` never binds or renames a name.
- **C / Overload by argument count**: C rejects two function declarations with the same name, so argument-count overloading is not expressible.
- **C / Inherited member**: C has no receiver-based member dispatch. `docs/language-parity.md` names C as the one language excluded from `receiverAwareLanguages`: "C has no methods on types, so a struct function-pointer call emits no receiver edge."
- **C / Super/base call**: C has no receiver-based member dispatch. `docs/language-parity.md` names C as the one language excluded from `receiverAwareLanguages`: "C has no methods on types, so a struct function-pointer call emits no receiver edge."
- **Ruby / Imported/aliased name**: `require`/`require_relative` bind no local name, so there is no import-renaming syntax. The closest approximation, reassigning a constant to another module (`CircleArea = Shapes`), does not resolve a member call through the alias at all (confirmed: `CircleArea.area(2)` returns not_found even though `Shapes.area(2)` resolves), so it is not a reliable ordinary-code form to test.
- **Ruby / Overload by argument count**: A later `def` of the same name replaces the earlier one (the same reason as Python), so argument-count overloading is not expressible.
- **Rust / Overload by argument count**: Rust rejects two functions, inherent methods, or trait implementations with the same name in one scope, so argument-count overloading is not expressible.
- **Rust / Super/base call**: A Rust trait has no mechanism for an overriding impl to call the trait's own default implementation of the same method; there is no super/base keyword or equivalent.
- **Zig / Overload by argument count**: Zig rejects two declarations with the same name in one container, so argument-count overloading is not expressible.
- **Zig / Inherited member**: Zig has no inheritance or struct-embedding promotion mechanism; a struct that merely contains a field of another struct type does not gain its methods, and there is no base-type keyword.
- **Zig / Super/base call**: Zig has no inheritance or struct-embedding promotion mechanism; a struct that merely contains a field of another struct type does not gain its methods, and there is no base-type keyword.

## Cell counts

| Language   | Cells | Known gaps |
| ---------- | ----- | ---------- |
| TypeScript | 12    | 0          |
| TSX        | 10    | 0          |
| JavaScript | 10    | 0          |
| Python     | 9     | 0          |
| PHP        | 9     | 0          |
| Go         | 7     | 0          |
| Java       | 11    | 0          |
| C          | 1     | 0          |
| C++        | 12    | 0          |
| C#         | 12    | 0          |
| Kotlin     | 11    | 0          |
| Ruby       | 8     | 0          |
| Rust       | 8     | 0          |
| Swift      | 10    | 0          |
| Zig        | 7     | 0          |

Total: 137 cells across 15 languages, 0 known gaps.

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
