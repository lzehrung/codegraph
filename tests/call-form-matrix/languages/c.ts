/**
 * C call-form cells (docs/plans/2026-09-28-unified-name-resolution.md, Step 1).
 * C expresses only "bare-call"; the other nine forms are omitted because C has no construct for
 * them:
 * - "qualified-call" and "imported-alias": C has no namespaces and no renaming import syntax --
 *   `#include` never binds or renames a name.
 * - "self-member-call", "typed-local-receiver", "static-receiver", "inherited-member", and
 *   "super-call": C has no receiver-based member dispatch. `docs/language-parity.md` names C as
 *   the one language excluded from `receiverAwareLanguages`: "C has no methods on types, so a
 *   struct function-pointer call emits no receiver edge."
 * - "construction": C has no construction syntax distinct from an ordinary function call; a
 *   struct is stack-declared or zero-initialized, never "constructed" through a named form this
 *   matrix can address.
 * - "overload-arity": C rejects two function declarations with the same name, so argument-count
 *   overloading is not expressible.
 *
 * No cell sets a `moved` variant: C's only covered form, "bare-call", resolves purely by
 * same-file source order within one translation unit (the decoy proves this -- a same-named
 * function in an unrelated file is never a candidate). `import-resolution-tables.ts` confirms C
 * has neither declaration-resolved imports nor an implicit compilation unit: `#include` names a
 * header file, not a declaration, so there is no mechanism to move a declaration to another file
 * while keeping the existing call site resolvable without inventing a header/prototype split this
 * matrix's C coverage does not otherwise test.
 */
import type { MatrixCell } from "../types.js";

export const cCells: MatrixCell[] = [
  {
    id: "c/bare-call",
    language: "c",
    callForm: "bare-call",
    files: {
      "calc.c": [
        "int add(int a, int b) {",
        "    return a + b;",
        "}",
        "",
        "int sum_pair(void) {",
        "    return add(1, 2);",
        "}",
        "",
      ].join("\n"),
      "decoy.c": ["int add(int a, int b) {", "    return -1;", "}", ""].join("\n"),
    },
    use: { file: "calc.c", line: 6, token: "add" },
    expected: { file: "calc.c", line: 1, token: "add" },
    decoy: { file: "decoy.c", line: 1, token: "add" },
    decoyKind: "callable",
    edge: { label: "calls", fromFile: "calc.c", fromName: "sum_pair" },
  },
];
