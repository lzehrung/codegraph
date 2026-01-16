# Impact surface area plan

## Goal
Summarize blast radius via fan-in/fan-out and highlight highly connected files so reviewers can prioritize risky changes.

## Output schema
Add `report.surfaceArea`:
- `files: Array<{ file: string; fanIn: number; fanOut: number; changed: boolean; impacted: boolean }>`
- `topFanIn: string[]` (file paths, top 10)
- `topFanOut: string[]` (file paths, top 10)

## Step-by-step
1. Build a map of `fanIn` and `fanOut` per file using `index.graph.edges` where `edge.to.type === "file"`.
2. Mark `changed` if file is in `report.changedFiles`.
3. Mark `impacted` if file is in `report.impacted`.
4. Sort by `fanIn`/`fanOut` and emit `topFanIn`/`topFanOut` (cap at 10).
5. Attach `surfaceArea` to the impact report (full + compact).

## Acceptance criteria
- When a changed file is imported by 3 other files, its `fanIn` is 3.
- `topFanIn` and `topFanOut` never exceed 10 entries.

## Implementation notes
- Use `file` paths normalized to the same format as `changedFiles`.
