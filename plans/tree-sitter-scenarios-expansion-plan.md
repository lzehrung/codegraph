# Plan: Expand Tree-sitter scenario coverage (no language servers)

## Goal
Strengthen accuracy by adding more Tree-sitter-driven test scenarios and query coverage, without introducing language servers.

## Key premise
Tree-sitter can go far if we:
- increase query coverage for real-world syntax,
- add targeted regression tests, and
- continuously validate against representative repos.

## Requirements
- New scenarios MUST map to a documented test sample.
- Each scenario MUST specify expected behavior (import resolution, symbol extraction, or navigation).
- Scenario catalog entries SHOULD include a source reference (repo URL or grammar fixture).

## How to find scenarios (junior-friendly)

### 1) Use existing open-source repos as inputs
**Tasks:**
1. Pick 2–3 popular repos per language (small to medium size).
2. Run the indexer in graph-only mode.
3. Capture:
   - unresolved imports
   - parse failures
   - mismatched imports vs. expected resolution
4. Extract the minimal code snippet that causes the issue.

### 2) Mine language grammar tests
**Tasks:**
1. Pull Tree-sitter grammar test corpora (if already vendored or available via submodules).
2. Identify constructs related to imports/exports and declarations.
3. Convert them into minimal sample files in `tests/samples/<language>/`.

### 3) Gather internal bug reports
**Tasks:**
1. Ask maintainers for known edge cases (import styles, module patterns).
2. Add each reported case as a regression test with a short description.

### 4) Create a “scenario catalog”
**Tasks:**
1. Add a Markdown file listing syntax patterns per language.
2. Track:
   - sample filename
   - feature under test
   - expected behavior
   - date added

## Step-by-step plan to implement

### 1) Create scenario inventory
**Owner:** Junior engineer
**Tasks:**
1. Add `docs/scenario-catalog.md` with a list of syntax patterns by language.
2. Start with imports/exports, then expand to declarations and references.

### 2) Add test samples per scenario
**Owner:** Junior engineer
**Tasks:**
1. For each pattern, add a minimal sample file under `tests/samples/<language>/`.
2. Include a short comment explaining what the scenario covers.

### 3) Extend query coverage
**Owner:** Junior engineer
**Tasks:**
1. Update language definitions in `src/languages/definitions/<language>.ts` to match new patterns.
2. Ensure queries use consistent capture names so downstream logic works.

### 4) Add regression tests
**Owner:** Junior engineer
**Tasks:**
1. Add tests to the language harness validating the scenario.
2. If it affects imports, add a graph test.
3. If it affects symbols, add a symbol test.
4. If it affects navigation, add go-to-definition/reference tests.

## How we’ll measure success
- Fewer unresolved imports in real-world repos.
- Reduced fallback usage in dependency extraction.
- Expanded test suite covering documented syntax patterns per language.
