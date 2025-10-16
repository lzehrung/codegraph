# Task: Re-exports and Namespace Navigation (Monorepo)

## Goal
Support go-to-definition through re-exports across workspace packages and namespace member resolution.

## Requirements
- In `pkg-b`, re-export from `@acme/pkg-a` (e.g., `export { aHelper as bHelper } from '@acme/pkg-a'`).
- Goto on `bHelper` in a local usage should resolve to `aHelper` definition in `pkg-a`.
- Namespace usage: `import * as a from '@acme/pkg-a'` and goto on `a.AClass`.

## Expected Examples
- `export { AClass as ExportedAClass } from '@acme/pkg-a'` → goto on `ExportedAClass` usage resolves to class in `pkg-a`.

## Edge Cases
- `export * from '@acme/pkg-a'` combined with direct local exports.
- Ensure recursion in `resolveExport` produces correct targets without cycles.

## Deliverables
- Tests validating goto through re-exports and namespace member resolution.
