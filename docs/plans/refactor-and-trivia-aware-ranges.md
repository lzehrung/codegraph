# Refactor Operations + Trivia-Aware Symbol Ranges

Status: historical implementation plan. This file records the original design and the current bounded v1 behavior; it is not the active source of truth for CLI or API usage. Current behavior is documented in `docs/cli.md`, `docs/library-api.md`, `docs/agent-workflows.md`, `docs/language-parity.md`, and `codegraph-skill/codegraph/SKILL.md`.

## Implemented v1 Shape

Codegraph exposes conservative refactor helpers as deterministic text-edit builders. They do not write files by default.

- `listSymbols(..., { trivia })` can return bare ranges, leading-doc ranges, or leading-all ranges.
- `renameSymbol(index, handle, newName)` builds declaration/reference/import-specifier edits for supported resolver results.
- `moveSymbol(index, handle, targetFile)` moves TypeScript/JavaScript top-level declarations, preserves leading trivia, creates target-file edits, rewrites named ES importers, and returns `unsupported` outside TS/JS files.
- `extractFunction(index, region, { newName })` extracts contiguous TS/JS statement ranges inside one function body.
- `applyEdits(edits, opts)` applies text edits atomically per file, preserves EOL style, reports conflicts/skips/warnings, and can stage newly created files with `useGit` plus `gitCwd`.
- CLI and agent wrappers preview edits by default; callers opt into writes with `--apply` or direct `applyEdits()` use.

## Intentional Bounds

These bounds are product constraints, not hidden TODOs:

- Refactor operations prefer `unsupported` over guessing.
- Move/extract are TS/JS-only in v1.
- Rename is bounded by the existing semantic reference resolver.
- String/comment rewrites, broad style formatting, scope-collision repair, and LSP workspace-edit packaging are future extensions.

## Follow-Up Candidates

Useful next steps if this surface grows:

- Add a reusable `WorkspaceEdit`/LSP adapter over `TextEdit[]`.
- Add explicit per-operation capability discovery for agents and editors.
- Add deeper scope-collision checks before broadening rename claims.
- Add editor-oriented code-action metadata: title, kind, safety level, and required post-apply verification hints.
