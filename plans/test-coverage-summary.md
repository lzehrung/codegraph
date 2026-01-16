# Test coverage relevance plan

## Goal
Summarize test files directly coupled to changed symbols and highlight likely test impacts.

## Output schema
Add `report.testCandidates`:
- `tests: Array<{ file: string; reason: "importsChanged" | "dependsOnChanged" | "pattern" }>`

## Step-by-step
1. Use `collectImpactContext` or `listCandidateTestFiles` to gather candidate tests.
2. Normalize file paths to match `report.changedFiles` format.
3. Sort tests by reason priority: `importsChanged` > `dependsOnChanged` > `pattern`.
4. Limit to top 20 to keep output small.

## Acceptance criteria
- If a test imports a changed symbol, it must appear with reason `importsChanged`.
- Output is empty when no tests match.

## Implementation notes
- Keep behavior consistent with existing `impact` test detection logic.
