# Re-export chain insights plan

## Goal
Surface re-export chains for changed symbols to expose public API propagation.

## Potential approach
- Use export metadata to trace re-export paths for changed symbols.
- Attach export-chain summaries to impacted items and/or report-level summaries.

## Open questions
- What depth limit is reasonable for chains?
- How should re-export paths be represented compactly?
