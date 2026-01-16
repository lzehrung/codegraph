# Suggestion confidence plan

## Goal
Provide a confidence score for missing import/export/declaration suggestions to help reviewers prioritize.

## Output schema
Add `confidence` to suggestions:
- `confidence: "high" | "medium" | "low"`

## Step-by-step
1. Start every suggestion at `medium`.
2. Promote to `high` if:
   - There is exactly one export candidate for the symbol, and
   - The candidate file is already imported elsewhere in the file.
3. Demote to `low` if:
   - There are 3+ export candidates, or
   - The symbol is common (e.g., `default`, `index`, `utils`).
4. Add `confidence` field to the suggestion output.

## Acceptance criteria
- Suggestions with a single export candidate and existing imports are `high`.
- Suggestions with 3+ candidates are `low`.

## Implementation notes
- Keep the scoring rule deterministic and language-agnostic.
