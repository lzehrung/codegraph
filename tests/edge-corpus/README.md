# Tree-sitter edge corpus

Edge fixtures live in `tests/edge-corpus/<language>/<scenario>/` as small multi-file projects. The shared `tests/edge-corpus.test.ts` indexes each scenario separately and reads markers only from Tree-sitter comment nodes for that language. The only language-specific marker parsing is the line-comment prefix (`//` for TypeScript and `#` for Python).

A marker goes in a line comment immediately above its code site or at the end of that site. IDs are unique within one scenario and are linked to a definition by `@def`.

- `@def <id>` identifies the definition site for later assertions.
- `@ref <id>` requires a reference to that definition on this line.
- `@not-ref <id>` requires that this line is not a reference to that definition.
- `@goto <id>` requires go-to-definition from this line to land on the marked definition.
- `@coverage <id> complete|partial` checks `findReferences` coverage for the marked definition.
- `@known-gap <reason>` pairs with an assertion whose expected result is currently missed (including an off-target goto or unavailable reference result). The test checks that the mismatch remains and lists the input, observed result, and expected result for handoff.

Multiple markers may share a comment. Example: `// @def value @coverage value complete`.
