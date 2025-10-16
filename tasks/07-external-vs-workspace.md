# Task: External vs Workspace Resolution

## Goal
Validate that imports for unknown packages remain external while workspace packages resolve to files.

## Requirements
- From `pkg-b/src/index.js`, add an import for a non-existent package (e.g., `not-a-package`).
- Ensure graph edge `to` is `{ external: 'not-a-package' }`.
- Ensure existing `@acme/pkg-a` edge resolves as per other tasks.

## Expected Examples
- `import x from 'not-a-package'` → edge external; goto-definition returns not_found.

## Edge Cases
- Package name resembling a workspace subpath should still be external if not declared.

## Deliverables
- Tests asserting edge external and not_found navigation for unknown package.
