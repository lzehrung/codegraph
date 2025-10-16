# Task: Workspace Detection Modes

## Goal
Ensure workspace discovery works with:
- package.json workspaces (existing)
- pnpm-workspace.yaml
- lerna.json

## Requirements
- Add alternate root configs to the monorepo fixture and tests that run discovery starting at `tests/samples/monorepo`.
- Verify that the same packages are detected for each mode.

## Expected Examples
- With pnpm-workspace.yaml present, `buildProjectIndex` indexes both packages.
- With lerna.json present (and no package.json workspaces), detection still indexes packages.

## Edge Cases
- Presence of multiple config files—prefer package.json workspaces when present.

## Deliverables
- Tests toggling presence of configs (can be temporary copies within a test temp dir).
