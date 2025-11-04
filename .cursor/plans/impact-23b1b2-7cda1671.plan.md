<!-- 7cda1671-0bef-47aa-bae2-fd711cc6ba58 5ba313c0-bf11-4467-9839-da9ddd58d3c4 -->
# Add enclosing block snippets to Impact Analysis

### Goal

Provide optional context snippets for references found during impact analysis. Support two modes: line and enclosing block. Keep defaults unchanged to avoid payload bloat; add type-safe options; update tests and docs.

### Key Changes

- Update `src/impact/types.ts`:
  - Extend `ImpactOptions` with:
    - `refContext?: 'line' | 'block'`
    - `refContextLines?: number` (for line mode)
    - `refBlockMaxLines?: number` (for block mode)
  - Extend `ImpactItem` with:
    - `refs?: Array<{ range: Range; context?: string }>`
  - Compact format: omit `refs` (no change to `CompactImpactReport`).

- Update `src/indexer.ts` (findReferences):
  - Add an optional third parameter `opts?: { context?: 'line' | 'block'; lines?: number; blockMaxLines?: number }`.
  - If provided, populate `Reference.context` for each returned reference.
    - line: ±N lines around `range.start.line` (default N=2).
    - block: climb to nearest function/method/class/block (TS/JS) or function/class/suite (Python); cap to `blockMaxLines` (default 60); fallback to line mode if not found.
  - Implement helpers: `extractLineContext`, `extractEnclosingBlock` using existing `supportForFile`/`languageForFile` and Tree-sitter. Cache per-file `src`/`tree` during enrichment to avoid repeated parsing.
  - Do not introduce any new `as any` casts; type all new code precisely.

- Update `src/impact/analyzer.ts`:
  - Pass reference-context options from `ImpactOptions` to `findReferences`.
  - Aggregate per-file `refs` on `ImpactItem` from the returned references (respect `maxRefs`). Store `{ range, context }` only.

- Optional (nice-to-have): `src/cli.ts` pretty output can display first 1–2 contexts when present.

- Update `README.md` (Options section): document new `impact` flags and programmatic options.

### Notes

- Defaults: context disabled; no change to report size/shape unless options are provided.
- Performance: block context parsing occurs only when requested; reuse `index.parsed` if available; otherwise parse once per file for all refs in that file.
- Backward compatibility: all API changes are additive and optional.

### Essential Snippets (illustrative)

- Extend ImpactOptions:
  ```ts
  export type ImpactOptions = DiffProviderOptions & {
    scope?: 'all' | 'imported';
    maxRefs?: number;
    depth?: number;
    includeTests?: boolean;
    membersOnly?: boolean;
    compact?: boolean;
    refContext?: 'line' | 'block';
    refContextLines?: number;
    refBlockMaxLines?: number;
  };
  ```

- Extend ImpactItem:
  ```ts
  export type ImpactItem = {
    file: FileId;
    symbols: string[];
    reasons: ImpactReason[];
    severity: number;
    depth?: number;
    typeOnly?: boolean;
    explain?: { /* existing fields */ };
    refs?: Array<{ range: Range; context?: string }>;
  };
  ```


### Testing

- Add `tests/impact-context-snippets.test.ts`:
  - Default: context disabled → `refs` is undefined.
  - Line mode: `refContext: 'line', refContextLines: 1` → each ref has ≤3 lines in `context`.
  - Block mode: `refContext: 'block', refBlockMaxLines: 10` → each `context` present, ≤10 lines, includes function/class signature where applicable.
  - Ensure `maxRefs` still respected and no type-only casts introduced.

### Out of Scope

- Changing `CompactImpactReport` shape (keep compact lean, no `refs`).
- Broad refactors to remove existing `as any` in legacy code; we will not add new ones.

### To-dos

- [ ] Extend ImpactOptions and ImpactItem with ref context fields
- [ ] Add opts param to findReferences and populate Reference.context
- [ ] Implement extractLineContext and extractEnclosingBlock helpers
- [ ] Pass options to findReferences and attach refs to ImpactItem
- [ ] Add tests for line/block contexts and defaults
- [ ] Document new impact options and usage examples
- [ ] Optional: pretty-print first few contexts in impact CLI