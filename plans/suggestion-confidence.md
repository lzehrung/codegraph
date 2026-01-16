# Suggestion confidence plan

## Goal
Provide a confidence score for missing import/export/declaration suggestions.

## Potential approach
- Score based on uniqueness of export candidates, distance in graph, and resolution hints.
- Surface confidence as a numeric field or enum (high/medium/low).

## Open questions
- Should confidence be included in the core suggestion type or optional metadata?
- How should confidence be calibrated across languages?
