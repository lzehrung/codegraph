# Change concentration (clusters) plan

## Goal
Identify tightly coupled clusters of changed and impacted files/symbols to help reviewers focus on high-coordination areas.

## Potential approach
- Build connected components over `report.graph.fileEdges` restricted to changed + impacted files.
- Compute per-cluster summaries: file count, total impact severity, and list of changed files.

## Open questions
- Should clustering be file-only or include symbol graph?
- How should clusters be ranked or limited?
