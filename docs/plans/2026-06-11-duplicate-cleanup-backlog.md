# Duplicate Cleanup Backlog

This backlog records duplicate groups from the 2026-06-11 audit after excluding tests, docs, skill files, `.d.ts` mirrors, and per-language definition parity where repetition is expected.

## Working Rules

- Prefer local shared helpers over broad abstractions.
- Fix exact or near-exact utility duplication first.
- Leave acceptable boilerplate and language-parity definitions alone unless they block active work.

## Priority 1: High ROI, Low Difficulty

- [ ] Share line-start offset collection used by:
  - `src/duplicates.ts` `collectLineStartOffsets`
  - `src/sql/extractFacts.ts` `lineStartsFor`
- [ ] Share drift language counting used by:
  - `src/drift/artifact.ts` `languageCounts`
  - `src/drift/snapshot.ts` `languageCounts`
- [ ] Share keyed array-bucket insertion used by:
  - `src/duplicates.ts` `addToBucket`
  - `src/sql/lookup.ts` `pushSqlLookupValue`

## Priority 2: Medium ROI, Low to Medium Difficulty

- [ ] Share dedupe-by-derived-key utility pattern used by:
  - `src/documentLinks/shared.ts` `dedupeModuleSpecifiers`
  - `src/sql/sourceGraph.ts` `uniqueFacts`
- [ ] Reduce duplicate impact report part shapes used by:
  - `src/impact/reportCompact.ts` `CompactImpactReportParts`
  - `src/impact/reportFull.ts` `FullImpactReportParts`
- [ ] Share native target suffix mapping logic used by:
  - `packages/codegraph-native/index.js` `platformPackageSuffix`
  - `scripts/stage-native-package.mjs` `currentTargetSuffix`

## Priority 3: Lower ROI or Acceptable Repetition

These should stay explicit unless a nearby change makes consolidation clearly cheaper than the current duplication.

- [ ] Agent session wrapper boilerplate in `src/agent/artifact.ts`, `src/agent/explain.ts`, `src/agent/orient.ts`, `src/agent/packet.ts`, and `src/agent/search.ts`
- [ ] Tiny CLI enum or mode parsers in `src/cli.ts`, `src/cli/orient.ts`, `src/cli/search.ts`, and `src/cli/options.ts`
- [ ] Command-context shape aliases in `src/cli/context.ts`, `src/cli/mcp.ts`, `src/cli/chunk.ts`, and `src/cli/skill.ts`
- [ ] Language definition parity under `src/languages/**`

## Completion Criteria

- [ ] Each accepted refactor removes duplication without weakening type clarity.
- [ ] Targeted tests cover every touched subsystem.
- [ ] `npm run check` passes after the cleanup series.
