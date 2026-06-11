# Duplicate Cleanup Backlog

This backlog records duplicate groups from the 2026-06-11 audit after excluding tests, docs, skill files, `.d.ts` mirrors, and per-language definition parity where repetition is expected.

## Working Rules

- Prefer local shared helpers over broad abstractions.
- Fix exact or near-exact utility duplication first.
- Leave acceptable boilerplate and language-parity definitions alone unless they block active work.

## Completed in PR #125

- [x] Shared line-start offset collection via `src/util/lines.ts` across:
  - `src/duplicates.ts`
  - `src/sql/extractFacts.ts`
- [x] Shared drift language counting via `src/drift/languages.ts` across:
  - `src/drift/artifact.ts`
  - `src/drift/snapshot.ts`
- [x] Shared keyed array-bucket insertion via `src/util/collections.ts` across:
  - `src/duplicates.ts`
  - `src/sql/lookup.ts`
- [x] Shared dedupe-by-derived-key utility via `src/util/collections.ts` across:
  - `src/documentLinks/shared.ts`
  - `src/sql/sourceGraph.ts`
- [x] Reduced duplicate impact report part shapes via `src/impact/reportParts.ts` in:
  - `src/impact/reportCompact.ts`
  - `src/impact/reportFull.ts`
- [x] Shared native target suffix mapping via `packages/codegraph-native/platform.js` across:
  - `packages/codegraph-native/index.js`
  - `scripts/stage-native-package.mjs`

## Remaining Lower ROI or Acceptable Repetition

These should stay explicit unless a nearby change makes consolidation clearly cheaper than the current duplication.

- [ ] Agent session wrapper boilerplate in `src/agent/artifact.ts`, `src/agent/explain.ts`, `src/agent/orient.ts`, `src/agent/packet.ts`, and `src/agent/search.ts`
- [ ] Tiny CLI enum or mode parsers in `src/cli.ts`, `src/cli/orient.ts`, `src/cli/search.ts`, and `src/cli/options.ts`
- [ ] Command-context shape aliases in `src/cli/context.ts`, `src/cli/mcp.ts`, `src/cli/chunk.ts`, and `src/cli/skill.ts`
- [ ] Language definition parity under `src/languages/**`

## Completion Criteria

- [x] Each accepted refactor removes duplication without weakening type clarity.
- [x] Targeted tests cover every touched subsystem.
- [x] `npm run check` passes after the cleanup series.
