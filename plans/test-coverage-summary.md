# Test coverage relevance plan

## Goal
Summarize test files directly coupled to changed symbols and highlight likely test impacts.

## Potential approach
- Reuse `collectImpactContext` / `listCandidateTestFiles` to list test files and reasons.
- Provide top candidate tests with reasons and file paths.

## Open questions
- Should tests be filtered by changed files only or include transitive impacts?
- How to display confidence or ranking?
