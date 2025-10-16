# Task: Cross-Package Navigation (Monorepo)

## Goal
Implement and test go-to-definition and find-references that traverse workspace packages (e.g., from `@acme/pkg-b` into `@acme/pkg-a`).

## Context
Workspace detection exists. We have a monorepo fixture under `tests/samples/monorepo` with `@acme/pkg-a` (TS) and `@acme/pkg-b` (JS). Ensure navigation works across package boundaries.

## Requirements
- Go-to-definition from `pkg-b/src/index.js` to symbols in `pkg-a/src/index.ts`.
- Find-references collects references in both packages for a symbol defined in `pkg-a`.
- Works when imports are via package name (e.g., `@acme/pkg-a`).

## Expected Examples
- Goto: cursor on `AClass` usage in `pkg-b/src/index.js` jumps to `pkg-a/src/index.ts` class definition.
- Refs: querying references for `aHelper` (defined in `pkg-a`) returns usages in `pkg-b`.

## Edge Cases
- Unknown packages remain external; navigation returns not_found, references exclude them.
- Path normalization across Windows/POSIX.

## Deliverables
- Tests in `tests/workspace.test.ts` or a new `tests/monorepo-navigation.test.ts`.
- No regressions to existing tests.
