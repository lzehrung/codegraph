# Language coverage & feature parity plan

## Goal
Build comprehensive, repeatable tests that validate feature parity across all supported languages (dependency graph, symbol index, go-to-definition, find-references, chunking, PR impact mapping) using Tree-sitter-based parsing and resolution.

## Scope (current codebase)
- Language support is defined in `src/languages.ts` and per-language definitions in `src/languages/definitions/*`.【F:src/languages.ts†L1-L121】
- Chunking tests exist for multiple languages via `tests/languages/runner.ts`, but cross-file navigation tests are currently deepest for JS/TS/Python (`tests/goto.test.ts`).【F:tests/languages/runner.ts†L1-L44】【F:tests/goto.test.ts†L1-L200】

## Deliverables
- A parity matrix documenting feature coverage per language.
- Standardized sample repos per language in `tests/samples/<language>/`.
- Consistent tests for:
  - dependency graph
  - symbol extraction
  - go-to-definition
  - find-references
  - chunking edge cases
  - SFC integration (Vue/Svelte)
  - PR impact mapping (optional tier)

## Requirements
- Parity matrix MUST list each supported language and each core feature with status (Covered/Partial/Missing).
- Each language MUST have tests for: dependency graph, symbol extraction, go-to-definition, find-references, chunking.
- Tests SHOULD reuse the same samples across features to keep maintenance low.
- Samples MUST be deterministic and small enough to keep total test runtime stable.

## Step-by-step plan (junior-friendly)

### 1) Create a parity matrix document
**Owner:** Junior engineer
**Tasks:**
1. Create `docs/language-parity.md` with a table: languages x features.
2. Mark current coverage based on existing tests.
3. Add target state “Required for parity” per feature/language.

### 2) Standardize a multi-feature test harness
**Owner:** Junior engineer
**Tasks:**
1. Extend `tests/languages/runner.ts` to optionally run:
   - dependency graph assertions
   - symbol list assertions
   - go-to-definition assertions
   - references assertions
2. Add a small helper in `tests/test-utils.ts` to build an index from a sample path and query symbols by name.
3. Document the new test input schema in `tests/languages/types.ts`.

### 3) Build per-language sample repos
**Owner:** Junior engineer
**Tasks:**
1. For each language, create `tests/samples/<language>/` with 3–6 files.
2. Include patterns for:
   - default/named/alias imports
   - cross-file usage
   - export or re-export patterns (or language equivalent)
3. Keep samples small, but ensure each has at least one cross-file symbol.

### 4) Add dependency graph tests per language
**Owner:** Junior engineer
**Tasks:**
1. For each language sample repo, use the indexer/graph API to build the graph.
2. Assert at least:
   - expected file-to-file edges exist
   - unresolved imports are marked external
3. Add one negative case per language (e.g., missing file) to ensure external resolution is captured.

### 5) Add symbol extraction tests per language
**Owner:** Junior engineer
**Tasks:**
1. Build index for the sample repo and list symbols in key files.
2. Assert symbols include functions, classes, types, variables for that language.
3. Validate ranges or line spans for at least one symbol per language.

### 6) Add go-to-definition tests per language
**Owner:** Junior engineer
**Tasks:**
1. Create `tests/goto.<language>.test.ts` or expand `tests/goto.test.ts` with per-language suites.
2. Validate resolution across files for:
   - imported function
   - imported class/type
   - namespace/module member access
   - alias usage

### 7) Add find-references tests per language
**Owner:** Junior engineer
**Tasks:**
1. Use the index to find references for a symbol in another file.
2. Assert:
   - number of references >= expected
   - reference locations match line numbers and files

### 8) Expand chunking tests for syntax diversity
**Owner:** Junior engineer
**Tasks:**
1. Add additional samples for each language (generics, decorators, nested types).
2. Assert chunk types and names match expected symbol kinds.

### 9) SFC integration tests (Vue/Svelte)
**Owner:** Junior engineer
**Tasks:**
1. Add `.vue` and `.svelte` samples importing local JS/TS modules.
2. Validate graph edges and go-to-definition from script blocks.

### 10) Optional PR-impact mapping validation
**Owner:** Junior engineer
**Tasks:**
1. Use small diffs for each language in `tests/samples`.
2. Validate changed symbols are found and impact analysis returns impacted items.

## Quality gates
- Each language must have tests for: dependency graph, symbol extraction, go-to-definition, find-references, chunking.
- CI should fail if a language is missing a parity test category.

## Notes
- This plan explicitly uses Tree-sitter as the parser and avoids language servers.
- Keep new tests minimal and deterministic to preserve speed and maintainability.
