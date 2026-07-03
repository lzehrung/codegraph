# Source language expansion vertical slice

## Goal

Add one new source language end to end using the existing language-support conventions, including graph extraction, symbols, navigation where feasible, docs, and tests.

## Recommended first candidate

Use Lua as the first expansion candidate unless product priorities choose another language.

Reasons:

- compact syntax surface
- common in plugin/config ecosystems
- useful for repo understanding
- reasonable first target for functions, method-like calls, `require` imports, and local variables

Do not add multiple languages in one PR.

## Design

### Capability target

For the first PR, target:

- dependency graph: yes
- symbol extraction: yes
- go-to-definition: basic local/imported symbols where supported by existing navigation machinery
- find references: basic same-name/call references where supported
- chunking: yes
- PR impact mapping: yes through file/symbol graph
- call compatibility: no unless parameter extraction is reliable

## Implementation steps

1. Add native parser dependency in `packages/codegraph-native/Cargo.toml` if available and license-compatible.
2. Register language id in `packages/codegraph-native/src/languages.rs`.
3. Add `src/languages/definitions/lua.ts`.
4. Register language in the source language registry.
5. Add queries for:
   - function declarations
   - local function declarations
   - assignment-style function definitions
   - method definitions using `:`
   - `require(...)` imports with string literals
   - call expressions
6. Add chunking support through existing language config generation.
7. Add docs and parity matrix entry.

## Tests

Add fixtures under `tests/languages/samples/` and tests in `tests/languages/lua.test.ts`:

- file import via `require("mod")`
- local function extraction
- table method extraction
- method call references
- exported module table pattern if feasible
- unsupported dynamic require skipped cleanly

Add shared tests where behavior is claimed:

- `tests/goto.test.ts`
- `tests/references.test.ts`
- `tests/native-semantic-parity.test.ts` if native runtime supports it

## Documentation

Update:

- `docs/language-parity.md`
- `docs/scenario-catalog.md`
- `README.md` supported language list if public-facing claim changes
- `codegraph-skill/codegraph/SKILL.md` only if agent-facing capabilities change

## Non-goals

- No runtime module path execution.
- No metatable/data-flow inference.
- No language family pack in one PR.

## Acceptance

- The new language appears in doctor/native supported language output when native is available.
- Graph, symbols, search, chunking, and impact work for the documented subset.
- Unsupported dynamic cases are documented and covered by negative tests.

## Review pass

Checked scope: this plan turns language expansion into one complete vertical slice. It follows this repo's parity and documentation rules instead of making a broad unsupported language claim.
