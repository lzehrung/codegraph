# Native Query Ownership Plan

Goal: make the native backend the default and complete query owner for supported source-language workflows so users only need the JS fallback package when the native addon itself cannot be installed or loaded.

## Exit Criteria

- [x] Supported source languages do not require `@lzehrung/codegraph-js-fallback` for normal graph extraction, symbol indexing, go-to-definition prerequisites, references prerequisites, semantic chunking, or AST grep when the native addon is available.
- [x] Native degradation is observable through structured reports and concise CLI diagnostics rather than silent data loss.
- [x] The remaining JS fallback surface is deliberate, documented, and limited to explicit native-unavailable scenarios or unsupported graph-first formats.
- [x] The regression suite proves native-only install behavior and native-vs-JS parity for supported workflows.

## Phase 1: Tracking And Diagnostics

- [x] Add a structured tracker for parser-backend degradation during index builds.
  Acceptance criteria:
  Build reports distinguish native-query fallback from missing syntax-tree context so incomplete symbol indexes are observable.
- [x] Surface parser-backend degradation in CLI/report output without adding noisy per-file warnings on healthy runs.
  Acceptance criteria:
  `--report` and verbose flows expose aggregate missing-backend counts and bounded examples.
- [x] Keep the plan updated as work lands.
  Acceptance criteria:
  Completed tasks are checked off in this file in the same commits that land the work.

## Phase 2: Native Ad Hoc Query Ownership

- [x] Normalize ad hoc/native single-query execution through the same compatibility hooks used by built-in native queries.
  Acceptance criteria:
  `astGrep` and chunking use a native query text that is compatibility-adjusted per language before execution.
- [x] Remove redundant native query execution on AST grep fallback paths.
  Acceptance criteria:
  `astGrep` performs at most one native single-query attempt per file before deciding whether fallback is needed.
- [x] Add regression tests for normalized ad hoc native queries and AST grep parity.
  Acceptance criteria:
  Tests fail if native ad hoc queries regress for languages with normalization-sensitive grammars.

## Phase 3: Eliminate JS Query Dependencies In Hot Paths

- [x] Inventory every remaining `executeJsQueryAsNativeMatches` hot path and classify whether it is required for native-unavailable mode only or still needed in native-available mode.
  Acceptance criteria:
  The inventory is reflected in this plan and no hot path is left unclassified.
  Current inventory:
  - `src/graphs.ts`: graph/specifier extraction fallback. Now limited to native-unavailable mode or graph-first/text-recovery paths; native-loaded supported source languages return native/text-owned results without JS query execution.
  - `src/indexer.ts` locals path: query-driven locals fallback. Now limited to native-unavailable mode for the JS Tree-sitter path; native-loaded supported source languages do not execute JS queries.
  - `src/indexer.ts` exports path: export extraction fallback. Now limited to native-unavailable mode for the JS Tree-sitter path; native-loaded supported source languages keep export recovery native/text-owned.
  - `src/indexer.ts` import-bindings path: native-owned for supported source languages when native is available; fallback remains for explicit native-off or native-unavailable mode.
  - `src/chunking/chunkFile.ts`: semantic chunk query fallback. Now limited to native-unavailable mode; native-loaded supported source languages either use native chunk queries or return no native chunk matches.
- [x] Move Kotlin import/specifier extraction off JS query fallback in native-loaded mode.
  Acceptance criteria:
  Native-loaded Kotlin import and wildcard/alias specifier extraction stay authoritative without requiring `@lzehrung/codegraph-js-fallback`.
- [x] Remove native-available JS query fallback for supported source-language import/specifier extraction.
  Acceptance criteria:
  Native-loaded runs do not require JS query fallback for supported source languages; recovery stays native-owned or fails explicitly as unsupported.
- [x] Remove native-available JS query fallback for supported source-language locals/exports extraction.
  Acceptance criteria:
  Native-loaded runs build locals/exports without JS query execution for supported source languages.
- [x] Reduce or eliminate query normalization gaps that currently force non-authoritative native empties.
  Acceptance criteria:
  Language-specific native compatibility hooks no longer blank or weaken core query kinds for supported source-language workflows without a documented follow-up item.

## Phase 4: Syntax Tree Ownership And Degradation Behavior

- [ ] Audit syntax-tree consumers that still require JS parser reconstruction when native queries succeed.
  Acceptance criteria:
  The remaining native syntax-tree gaps are enumerated and linked to concrete consumers.
- [ ] Decide per consumer whether to use projected native trees, explicit capability limits, or native-side expansion.
  Acceptance criteria:
  Each syntax-tree-dependent workflow has one chosen ownership path instead of ad hoc fallback.
- [ ] Prevent silent imports-only module indexes when no syntax-tree backend is available.
  Acceptance criteria:
  Index builds either surface the degradation clearly in reports or fail explicitly when the requested workflow requires unavailable parser context.

## Phase 5: Decompose And Reuse

- [ ] Collapse duplicated full-build and incremental-build file processing paths behind one shared per-file pipeline.
  Acceptance criteria:
  Native preparation, parser reconstruction, report bookkeeping, and module assembly logic live in one shared implementation.
- [ ] Consolidate native report bookkeeping helpers so graph/index paths record outcomes consistently.
  Acceptance criteria:
  There is one obvious path for recording native usage, fallback reasons, and parser-backend degradation.

## Phase 6: Test And Docs Hardening

- [x] Add native-only install coverage across graph, index, AST grep, chunking, and semantic parity for representative source languages.
  Acceptance criteria:
  The suite proves behavior when the native addon is available and the JS fallback package is absent.
- [x] Extend docs to explain the native-first contract, remaining limits, and when JS fallback is actually required.
  Acceptance criteria:
  `README.md`, `docs/language-parity.md`, `docs/scenario-catalog.md`, and `codegraph-skill/codegraph/SKILL.md` match the real behavior.
- [x] Run a final full verification pass before closing the plan.
  Acceptance criteria:
  `npm run build` and the relevant targeted/native parity suites are green, and any residual non-green areas are documented here.

## Remaining Follow-Up Work

- [ ] Audit syntax-tree consumers that still require JS parser reconstruction when native queries succeed.
- [ ] Decide per consumer whether to use projected native trees, explicit capability limits, or native-side expansion.
- [ ] Prevent silent imports-only module indexes when no syntax-tree backend is available.
- [ ] Collapse duplicated full-build and incremental-build file processing paths behind one shared per-file pipeline.
- [ ] Consolidate native report bookkeeping helpers so graph/index paths record outcomes consistently.
