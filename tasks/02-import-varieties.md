# Task: Cross-Package Import Varieties

## Goal
Support and test diverse cross-package import styles (default, named, namespace, CommonJS require/destructuring) from `@acme/pkg-b` into `@acme/pkg-a`.

## Requirements
- Add usages in `pkg-b/src/index.js` for:
  - default import (if applicable)
  - named imports (existing)
  - namespace import `import * as a from '@acme/pkg-a'`
  - CommonJS `require('@acme/pkg-a')` and destructuring
- Ensure go-to-definition and find-references work for each import style.

## Expected Examples
- `const { aHelper: alias } = require('@acme/pkg-a')` → goto/refs for `alias` resolve to `aHelper` in `pkg-a`.
- `a.AClass` via namespace import → goto to class in `pkg-a`.

## Edge Cases
- Mixed ESM/CJS usage in the same file.
- Ensure no duplicate references (dedupe by file+position).

## Deliverables
- Tests asserting navigation and references for each import style.
