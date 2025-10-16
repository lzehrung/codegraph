# Task: Package Resolution Cases

## Goal
Exercise and test workspace package resolution variants when importing `@acme/pkg-a`.

## Cases to Cover
1. main field present (current)
2. no main but index.* fallback (rename main to absent and verify fallback)
3. exports field: root "." and subpaths (e.g., `{"exports": {".": "./src/index.ts", "./sub": "./src/index.ts"}}`)
4. Subpath imports from `pkg-b` (e.g., `@acme/pkg-a/sub`)

## Expected Behavior
- Graph edges: `to` resolves to concrete file when possible; otherwise external fallback.
- Go-to-definition works when resolution succeeds.

## Edge Cases
- Missing files should not crash; treat as external.
- Windows/POSIX path normalization.

## Deliverables
- Tests adjusting `pkg-a/package.json` within fixtures for each case.
- Assertions on edges and goto outcomes.
