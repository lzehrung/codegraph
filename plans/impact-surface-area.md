# Impact surface area plan

## Goal
Summarize blast radius via fan-in/fan-out and highlight highly connected files.

## Potential approach
- Compute per-file fan-in/fan-out from `index.graph.edges`.
- Attach counts to changed files and impacted files.

## Open questions
- Where should thresholds live (top-N vs full map)?
- Should we include symbol-level fan-in/fan-out?
