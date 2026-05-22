# Duplicate Refactor Checklist

## Context

Generated from local duplicate detection runs on 2026-05-22:

```bash
node ./dist/cli.js duplicates --root . . --min-confidence medium --limit 1000
node ./dist/cli.js duplicates --root . ./src ./packages ./scripts --min-confidence medium --limit 500
node ./dist/cli.js duplicates --root . ./src ./packages ./scripts --min-confidence medium --include-same-file --limit 500
```

The product-source pass scanned 5,000 units and returned 500 capped suggestions, with 1,151 additional raw suggestions omitted. Later implementation changed the default output to grouped findings.

## Goals

- Reduce maintenance duplication where shared helpers have the same behavior.
- Preserve intentional language parity and generated-package boundaries.
- Improve duplicate detector output so users review canonical duplicate groups by default.

## Refactor Checklist

### Phase 1: Small Shared Helpers

- [x] Consolidate `findFirstExistingResolutionCandidate` across `src/util/resolution.ts`, `src/util/resolution/node.ts`, `src/util/resolution/php.ts`, and `src/util/resolution/phpComposer.ts`.
- [x] Consolidate `getResolutionExtensions` between `src/util/resolution.ts` and `src/util/resolutionCandidates.ts`.
- [x] Extract or share CLI project-file helpers duplicated in `src/cli/graphQueries.ts` and `src/cli/navigation.ts`.
- [x] Review `isRecord` / `isPlainObject` / `isPlainRecord` helpers in `src/agent/artifact.ts`, `src/cli/doctor.ts`, `src/presets.ts`, and `src/util/projectFiles/parsers.ts`.
- [x] Review `edgeKey`, `toRelativeEdge`, and `compareEdges` duplication across `src/indexer/shared.ts`, `src/review/deleted.ts`, and `src/review/report.ts`.

### Phase 2: Same-File Duplicates

- [x] Factor common logic between `tool_getDependencies` and `tool_getReverseDependencies` in `src/agent-tools.ts`.
- [x] Factor common traversal logic between `getDependencies` and `getReverseDependencies` in `src/graphs/traversal.ts`.
- [x] Unify integer option parser variants in `src/cli/options.ts`.
- [x] Unify duplicate detector numeric option normalization in `src/duplicates.ts`.
- [x] Factor Java/Kotlin statement override logic in `src/indexer/imports/languageSpecific.ts`.
- [x] Factor unavailable native execution helpers in `src/native/execution.ts`.
- [x] Review `fileExists` and `directoryExists` in `src/util/workspace.ts` for a tiny shared helper.

### Phase 3: Larger Design Duplicates

- [x] Review C and C++ definition modules in `src/languages/definitions/c.ts` and `src/languages/definitions/cpp.ts`; decide whether to extract shared declarator helpers or document the intentional duplication.
- [x] Review full and compact impact report builders in `src/impact/reportFull.ts` and `src/impact/reportCompact.ts`; extract shared summary builders only if output differences stay explicit.
- [x] Review JS fallback type duplication across `packages/codegraph-js-fallback/js-fallback.d.ts`, `src/jsFallback.ts`, and `src/languages/types.ts`; decide whether generated package types should remain mirrored.
- [x] Review SQL helper duplication between `src/sql/navigation.ts` and `src/sql/sourceGraph.ts`.
- [x] Review SQL object key helper duplication between `src/sql/extractFacts.ts` and `src/sql/review.ts`.

### Phase 4: Test Utilities

- [x] Move repeated `countingSession` helpers from agent, artifact, and MCP tests into a shared test helper.
- [x] Move repeated `runGit` / `git` helpers from git-impact tests into a shared test helper.
- [x] Move repeated `isSymlinkUnavailable` helpers into a shared test helper.
- [x] Review language parity test duplication separately; repeated fixture shape is likely intentional and should not be refactored unless it improves scenario clarity.

## Duplicate Output Improvements

Before this work, the detector reported unit pairs. Because a symbol can also appear as a chunk, one real clone could produce several raw suggestions such as symbol-symbol, symbol-chunk, chunk-symbol, and chunk-chunk.

### Desired Default Output

- [x] Add a canonical `groups` array to duplicate JSON output.
- [x] Keep raw `suggestions` only behind a compatibility flag such as `--raw-pairs`, or include it as a secondary field after grouped output stabilizes.
- [x] Give each group a stable `id`, `score`, `confidence`, `cloneType`, `primaryLeft`, `primaryRight`, `variants`, `metrics`, and `reasons`.
- [x] Prefer symbol-symbol evidence as the primary pair when available.
- [x] Fall back to symbol-chunk or chunk-chunk only when no symbol-symbol pair exists.
- [x] Collapse overlapping unit pairs when they refer to the same file ranges or one range fully contains the other.
- [x] Preserve counts for hidden evidence, such as `variantCount`, `rawPairCount`, and `omittedVariantCount`.
- [x] Sort groups by score, confidence, clone type severity, token span, and stable file/range tie breakers.

### Grouping Rules

- [x] Build a canonical unit key from file, normalized range, language, unit kind, symbol name, and symbol kind.
- [x] Treat units as equivalent when they are in the same file and their ranges overlap substantially.
- [x] Prefer the narrowest semantic unit that still carries a useful name.
- [x] Merge pair variants when both sides map to the same canonical left/right unit group.
- [x] Do not merge unrelated same-file duplicates just because they share a helper name.
- [x] Report cross-file and same-file groups consistently, with same-file groups requiring non-overlapping primary ranges.

### CLI And Docs Follow-Up

- [x] Add tests in `tests/duplicates.test.ts` for grouped symbol/chunk collapse.
- [x] Add tests for grouped output with `--include-same-file`.
- [x] Add tests proving `--raw-pairs` can still expose all low-level evidence.
- [x] Update `docs/cli.md` if command flags or output contracts change.
- [x] Update `docs/library-api.md` if `findDuplicates()` returns grouped results.
- [x] Update `codegraph-skill/codegraph/SKILL.md` if duplicate command flags or output shape change.

## Notes

- C/C++ definition duplication may be intentional language parity. Prefer a small shared helper module over a generic abstraction if refactoring it.
- Full and compact impact report duplication should stay readable. Do not hide output-specific behavior inside ambiguous shared builders.
- Test fixture duplication is lower priority than production helper duplication.
