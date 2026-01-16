# Change concentration (clusters) plan

## Goal
Identify tightly coupled clusters of changed and impacted files to help reviewers focus on high-coordination areas.

## Output schema
Add `report.clusters`:
- `clusters: Array<{ id: number; files: string[]; changedFiles: string[]; totalSeverity: number }>`

## Step-by-step
1. Build an undirected graph using `report.graph.fileEdges` where both endpoints are in `changedFiles` or `impacted`.
2. Compute connected components (DFS or BFS).
3. For each component:
   - `files`: all files in the component.
   - `changedFiles`: intersection with `report.changedFiles`.
   - `totalSeverity`: sum of `impact.severity` for impacted items in that component.
4. Sort clusters by `totalSeverity` descending.

## Acceptance criteria
- If there are no file edges between changed files, each file becomes its own cluster.
- `totalSeverity` is 0 when the cluster has no impacted items.

## Implementation notes
- Keep it file-only for v1 (no symbol graph) to reduce complexity.
