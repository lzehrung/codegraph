# Tree-sitter edge corpus

Edge fixtures live in `tests/edge-corpus/<language>/<scenario>/` as small multi-file projects. The shared `tests/edge-corpus.test.ts` indexes each scenario separately and reads markers only from Tree-sitter comment nodes for that language. The only language-specific marker parsing is the comment prefix list in `commentPrefixes` (for example `//` for TypeScript, `#` for Python and Ruby, and `/*` for C and SCSS). A block comment carries markers the same way as a line comment.

A marker goes in a line comment immediately above its code site or at the end of that site. IDs are unique within one scenario and are linked to a definition by `@def`.

- `@def <id>` identifies the definition site: the one identifier on that line spelled `<id>`. Use `@def <id>=<identifier>` when the id differs from the identifier or to pick one of several identifiers. When the declaring token is not an identifier, such as Ruby `:serial` in `attr_accessor :serial`, `@def <id>=<token>` binds to the one named leaf node spelled `<token>`. A line with zero or several matching identifiers fails.
- `@ref <id>` requires a reference to that definition on this line.
- `@not-ref <id>` requires no reference to that definition on this line. The checked source text must contain the definition spelling outside the marker comment.
- `@not-ref-block <id>` checks the full range of the outermost named syntax node (not the root) that starts on the site line. Put the marker in a comment above the opener of a multi-line string, heredoc, or nowdoc. The checked text must contain the definition spelling outside the marker comment.
- `@goto <id>` requires go-to-definition from the one identifier on this line spelled like the definition. Use `@goto <id>=<identifier>` when the site token has a different spelling, such as an import alias. Zero or multiple matching identifiers fail.
- `@coverage <id> complete|partial` checks `findReferences` coverage for the marked definition.
- `@known-gap <reason> observed=<value>` pairs with an assertion whose expected result is currently missed. Pin `not_found` for a missing result, `none` for an `@ref` with no reference, or the off-target definition ID for a wrong goto. For `@coverage`, pin the observed coverage state or status. A fixed or changed result fails until the fixture is updated.

The harness requires 25-80 assertions per selected language. The upper bound keeps each language small enough to review; past review findings take priority over new ordinary forms.

Multiple markers may share a comment. Example: `// @def value @coverage value complete`.
