# Refactor Language Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand `@lzehrung/codegraph-refactor` beyond TypeScript/JavaScript where source-edit semantics can be made safe and tested.

**Architecture:** Keep graph, symbol, navigation, and trivia primitives in `@lzehrung/codegraph`; keep edit builders, import editors, capability discovery, and refactor operation tests in `@lzehrung/codegraph-refactor`. Every operation must declare per-language capability data and return `unsupported` for unimplemented or unsafe language shapes.

**Tech Stack:** TypeScript, Vitest, Tree-sitter-backed `ProjectIndex`, Codegraph symbol/reference APIs, deterministic `TextEdit[]` results.

---

## Support Tiers

| Operation | Realistic first expansion | Later expansion | Keep unsupported until compiler/type-aware support exists |
| --- | --- | --- | --- |
| Rename | Python, Go, Rust, PHP, Ruby, Java, C#, Kotlin, Swift, Zig, C, C++ | Vue/Svelte script blocks | dynamic dispatch, generated symbols, macro-expanded identifiers, template/component tags |
| Move | Python top-level functions/classes, Go package-level funcs/types, Rust module-level free items, PHP namespace functions/classes, Ruby module/class constants | Java/Kotlin/C#/Swift file/type moves with package/namespace updates | methods between classes, trait/impl members, overloaded members, C/C++ declarations split across header/source pairs |
| Extract | Python function-body statement ranges, Go function-body statement ranges | Rust/PHP/Ruby simple function-body ranges | Java/C#/Kotlin/Swift/C/C++ until statement parsing, return-flow, and local declaration emission are language-specific and tested |

## Shared Contracts

- All operations return `{ status: "unsupported", edits: [], warnings, reason }` when a language or shape is not explicitly supported.
- All operation outputs remain deterministic `TextEdit[]`; writing stays isolated in `applyEdits()`.
- All language claims must be reflected in `docs/language-parity.md`, `docs/scenario-catalog.md`, `docs/library-api.md`, `docs/cli.md`, and `codegraph-skill/codegraph/SKILL.md`.
- Every supported language/operation cell needs direct package tests under `tests/refactor/*.test.ts` plus CLI or agent coverage for at least one representative non-TS language.
- Capability data is the source of truth; docs and tests should assert it instead of duplicating unsupported-language lists in prose only.

## Task 1: Capability Discovery

**Files:**
- Create: `packages/codegraph-refactor/src/capabilities.ts`
- Modify: `packages/codegraph-refactor/src/index.ts`
- Test: `tests/refactor/capabilities.test.ts`
- Docs: `docs/library-api.md`, `docs/cli.md`, `codegraph-skill/codegraph/SKILL.md`

- [ ] Write a failing test that calls `getRefactorCapabilities()` and asserts TS/JS support for rename/move/extract and Python support for rename only.
- [ ] Implement a typed capability table keyed by Codegraph language id.
- [ ] Export `getRefactorCapabilities(languageId?: string)` and `isRefactorSupported(languageId, operation)`.
- [ ] Add `codegraph refactor capabilities --json` that prints the package capability table.
- [ ] Verify with `npx vitest run tests/refactor/capabilities.test.ts tests/cli-regressions.test.ts -t "refactor capabilities"`.
- [ ] Commit: `Add refactor capability discovery`.

## Task 2: Rename Across Source Languages

**Files:**
- Modify: `packages/codegraph-refactor/src/rename.ts`
- Modify: `packages/codegraph-refactor/src/identifier.ts`
- Test: `tests/refactor/rename.test.ts`
- Docs: `docs/language-parity.md`, `docs/scenario-catalog.md`, `docs/library-api.md`

- [ ] Add failing tests for Python, Go, Rust, PHP, Ruby, Java, C#, Kotlin, Swift, Zig, C, and C++ renames using real cross-file references from `buildProjectIndexFromFiles()`.
- [ ] Add per-language identifier rules and reserved-word checks for every newly supported language.
- [ ] Add collision preflight against local definitions in the target scope where Codegraph can see the scope; return `unsupported` when scope ownership is ambiguous.
- [ ] Keep import-alias handles unsupported unless renaming the declaration can safely rewrite the imported name.
- [ ] Verify with `npx vitest run tests/refactor/rename.test.ts tests/goto.test.ts tests/references.test.ts`.
- [ ] Commit: `Expand semantic rename language support`.

## Task 3: Import Editor Abstraction

**Files:**
- Create: `packages/codegraph-refactor/src/import-editors/types.ts`
- Create: `packages/codegraph-refactor/src/import-editors/jsLike.ts`
- Create: `packages/codegraph-refactor/src/import-editors/python.ts`
- Create: `packages/codegraph-refactor/src/import-editors/go.ts`
- Create: `packages/codegraph-refactor/src/import-editors/rust.ts`
- Test: `tests/refactor/import-editors.test.ts`

- [ ] Write failing tests for add/remove/split import edits in JS/TS, Python, Go, and Rust.
- [ ] Define a shared `ImportEditor` interface that emits edits and never writes files.
- [ ] Move existing JS/TS import split logic from `move.ts` into `jsLike.ts`.
- [ ] Implement Python relative/absolute import add/remove for module-level moves.
- [ ] Implement Go import block edits with grouped import preservation.
- [ ] Implement Rust `use` item edits for simple module paths and aliases.
- [ ] Verify with `npx vitest run tests/refactor/import-editors.test.ts tests/refactor/move.test.ts`.
- [ ] Commit: `Add language import editors for refactors`.

## Task 4: Move Top-Level Declarations

**Files:**
- Modify: `packages/codegraph-refactor/src/move.ts`
- Modify: `packages/codegraph-refactor/src/capabilities.ts`
- Test: `tests/refactor/move.test.ts`
- Docs: `docs/language-parity.md`, `docs/scenario-catalog.md`, `docs/library-api.md`, `docs/cli.md`

- [ ] Add failing tests for Python top-level function/class moves, Go package-level function moves, Rust module-level free function moves, PHP namespace function/class moves, and Ruby module-level constant/class moves.
- [ ] Add declaration extraction guards per language: top-level only, single declaration per edit range, attached trivia preserved, target collision rejected.
- [ ] Route importer rewrites through the import editor for that language.
- [ ] Add same-file reference import/qualification behavior per language or return `unsupported` when no safe rewrite exists.
- [ ] Verify with `npx vitest run tests/refactor/move.test.ts tests/cli-regressions.test.ts -t "refactor move"`.
- [ ] Commit: `Expand top-level move support`.

## Task 5: Extract Simple Function-Body Ranges

**Files:**
- Modify: `packages/codegraph-refactor/src/extract.ts`
- Create: `packages/codegraph-refactor/src/extractors/python.ts`
- Create: `packages/codegraph-refactor/src/extractors/go.ts`
- Test: `tests/refactor/extract.test.ts`
- Docs: `docs/language-parity.md`, `docs/scenario-catalog.md`, `docs/library-api.md`, `docs/cli.md`

- [ ] Add failing tests for Python and Go contiguous statement extraction with no outputs, one output, and rejected early returns.
- [ ] Split TS/JS extraction into a language extractor interface before adding new languages.
- [ ] Implement Python helper emission with indentation preservation and parameter/output analysis.
- [ ] Implement Go helper emission with package-level function insertion and conservative output handling.
- [ ] Keep languages without a statement extractor marked unsupported in capabilities.
- [ ] Verify with `npx vitest run tests/refactor/extract.test.ts tests/cli-regressions.test.ts -t "refactor extract"`.
- [ ] Commit: `Add Python and Go extract support`.

## Task 6: SDK and Agent Usability Hardening

**Files:**
- Modify: `packages/codegraph-refactor/src/index.ts`
- Create: `packages/codegraph-refactor/src/workspaceEdit.ts`
- Test: `tests/refactor/workspace-edit.test.ts`, `tests/agent-tools.test.ts`
- Docs: `docs/agent-workflows.md`, `docs/library-api.md`, `codegraph-skill/codegraph/SKILL.md`

- [ ] Add failing tests for converting `TextEdit[]` to LSP-style workspace edits.
- [ ] Export `toWorkspaceEdit(edits)` and `summarizeRefactorResult(result)`.
- [ ] Ensure agent wrappers include capability hints when returning `unsupported`.
- [ ] Document the recommended agent loop: discover capabilities, preview edits, inspect diff, apply, run language-native tests/builds.
- [ ] Verify with `npx vitest run tests/refactor/workspace-edit.test.ts tests/agent-tools.test.ts -t "refactor"`.
- [ ] Commit: `Improve refactor SDK and agent ergonomics`.

## Release Gate

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run test:ci`
- [ ] `npm pack --dry-run --workspace=@lzehrung/codegraph-refactor`
- [ ] `node dist/cli.js review --root . --base origin/main --head HEAD --summary`
- [ ] `node dist/cli.js impact --provider git --base origin/main --head HEAD --pretty`

## Non-Goals

- Do not claim all graph languages support all refactors.
- Do not move class methods, overloaded methods, trait/impl members, or C/C++ header/source declarations until a language-specific design and tests exist.
- Do not add formatting engines in v1; emit minimal deterministic edits and rely on caller formatting after apply.
