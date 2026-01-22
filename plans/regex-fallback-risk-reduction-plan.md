# Plan: Reduce correctness risk from regex fallbacks

## Goal
Minimize reliance on regex-based import extraction and improve correctness when Tree-sitter parsing fails or is bypassed by fast mode.

## Why this matters
- `collectModuleSpecifiersFromSource` uses regex extractors for JS/TS and Python in fast mode or as a fallback when Tree-sitter query parsing fails. This can miss valid import forms and reduce accuracy of dependency graphs and downstream navigation features.

## Constraints
- Stay Tree-sitter based; do not add language servers.
- Keep runtime simple and lightweight.

## Requirements
- Fallback usage MUST be observable in build output or reports.
- Tree-sitter extraction MUST be the default path unless explicitly overridden.
- New tests MUST include at least one case that previously triggered regex fallback.

## Step-by-step plan (junior-friendly)

### 1) Add instrumentation for fallback usage
**Owner:** Junior engineer
**Tasks:**
1. Add a build report field (e.g., `graph.fallbackImportExtraction`) to track when regex fallback is used per file.
2. Log a structured warning or increment a counter when regex fallback occurs.
3. Surface aggregated stats in `BuildReport`.

### 2) Expand Tree-sitter query coverage
**Owner:** Junior engineer
**Tasks:**
1. For each supported language, review `src/languages/definitions/<language>.ts` import queries.
2. Add coverage for missing import forms identified in tests and real-world repos.
3. Validate that queries return module nodes with consistent capture names.

### 3) Add regression tests for fallback triggers
**Owner:** Junior engineer
**Tasks:**
1. Add test samples designed to break regex extraction but succeed in Tree-sitter (e.g., multiline imports, unusual whitespace, comments between tokens).
2. Assert that Tree-sitter extraction finds expected modules.
3. Assert the fallback counter remains zero for these samples.

### 4) Make fast mode safer
**Owner:** Junior engineer
**Tasks:**
1. Add a configuration option to disable fast regex extraction per language.
2. Document when fast mode is appropriate and how it affects accuracy.

## How we’ll measure success
- Fallback usage drops to near-zero in the test suite.
- New syntax cases are covered by queries, not regex.
- A build report clearly indicates if fallback extraction was used.
