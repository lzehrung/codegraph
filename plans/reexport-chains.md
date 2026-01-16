# Re-export chain insights plan

## Goal
Surface re-export chains for changed symbols so reviewers can spot public API propagation.

## Output schema
Add `report.reexportChains`:
- `chains: Array<{ symbol: string; file: string; paths: string[][] }>`
  - `paths` is a list of file-path chains like `["src/a.ts", "src/index.ts"]`.

## Step-by-step
1. For each exported changed symbol, find its defining file.
2. Traverse `index.byFile` export entries to find re-exports that reference that file/symbol.
3. Build paths up to depth 3 (configurable).
4. Stop when no further re-exports are found or depth limit reached.

## Acceptance criteria
- If a symbol is not re-exported, its `paths` array is empty.
- If `a.ts` re-exports to `index.ts`, the path contains both files in order.

## Implementation notes
- Start with file-level re-exports only; symbol-level chain detail can come later.
