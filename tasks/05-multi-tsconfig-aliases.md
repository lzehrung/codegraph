# Task: Multi-tsconfig Path Aliases

## Goal
Verify nearest-tsconfig lookup and `paths` alias resolution per package in a monorepo.

## Requirements
- Add `tsconfig.json` to `pkg-a` and a different one to a TS consumer (new `pkg-ts-consumer`).
- Use aliases like `@utils/*` inside `pkg-a` and ensure internal imports resolve.
- From `pkg-ts-consumer`, import via a workspace alias to `pkg-a` (e.g., `@acme/pkg-a`), while `pkg-ts-consumer` has its own `paths` configured for locals.

## Expected Examples
- Internal `import { X } from '@utils/foo'` within `pkg-a` resolves to `pkg-a/src/foo.ts`.
- Cross-package imports still resolve via workspace package detection.

## Edge Cases
- Conflicting aliases between packages (ensure per-file nearest tsconfig is used).

## Deliverables
- Fixture tsconfigs and tests exercising alias resolution and definitions.
