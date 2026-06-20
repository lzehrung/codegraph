# Remove JS Fallback Shim Plan

This plan removes `@lzehrung/codegraph-js-fallback` as a published compatibility package. The package no longer provides parser recovery, is not a runtime dependency of the root package, and only preserves an old import path with throwing stubs.

Do not remove internal reduced-mode behavior. Codegraph should continue to degrade to graph-only and regex-backed recovery when the native backend is unavailable.

## Current State

Observed package facts:

- `@lzehrung/codegraph` does not depend on `@lzehrung/codegraph-js-fallback`.
- The root package does not export `./js-fallback`.
- `packages/codegraph-js-fallback` ships only `js-fallback.cjs`, `js-fallback.d.ts`, and no grammar dependencies.
- `src/jsFallback.ts` is still used internally for type-compatible parser stubs and unavailable-error detection.
- Release tooling still treats `js-fallback` as a third publishable package.

Decision:

- Remove the standalone compatibility package.
- Keep internal `src/jsFallback.ts` for now unless the implementation pass proves every internal type/use can be deleted safely.
- Keep reduced-mode regex recovery and native fallback reporting intact.

## Phase 1: Package Boundary Cleanup

Implementation checklist:

- [x] Delete `packages/codegraph-js-fallback/`.
- [x] Remove package-specific release metadata for `js-fallback` from `scripts/release-lib.mjs`.
- [x] Remove `js-fallback` version planning, manifest normalization, package selection, and publish handling from `scripts/release.mjs`.
- [x] Remove `js-fallback` from `.github/workflows/release.yml` publish commands and release notes.
- [x] Remove package-specific checks from `tests/package-metadata.test.ts`.
- [x] Confirm root `package.json` workspaces remain correct after deleting the package.

Acceptance:

- Release package selection accepts only `root`, `native`, `@lzehrung/codegraph`, and `@lzehrung/codegraph-native`.
- No publish path references `@lzehrung/codegraph-js-fallback`.
- No workspace package remains under `packages/codegraph-js-fallback`.

## Phase 2: Internal Shim Review

Implementation checklist:

- [x] Audit every import from `src/jsFallback.ts`.
- [x] Keep `JsSyntaxTree`, `JsSyntaxNode`, and related structural types only if native query/result adapters still need them.
- [x] Rename internal-only concepts if useful so `jsFallback` does not imply an external parser backend.
- [x] Preserve `isJsFallbackUnavailableError()` behavior if build/index fallback diagnostics still depend on it.
- [x] Do not reintroduce any JS Tree-sitter grammar dependency.

Acceptance:

- Internal names no longer suggest users can install a parser fallback package.
- Native-unavailable behavior still reports reduced mode, not a missing package instruction.
- TypeScript build proves no stale external shim imports remain.

## Phase 3: Documentation Cleanup

Implementation checklist:

- [x] Remove `@lzehrung/codegraph-js-fallback` from `README.md` install/release guidance.
- [x] Remove fallback shim package role from `docs/installation.md`.
- [x] Remove fallback shim release guidance from `PUBLISHING.md`.
- [x] Remove fallback shim mention from `codegraph-skill/codegraph/SKILL.md`.
- [x] Update any release examples that mention `--package js-fallback`.
- [x] Keep reduced-mode documentation explicit: without native, Codegraph has graph-only and regex recovery, not parser recovery.

Acceptance:

- User-facing docs list only root and native packages.
- Docs do not imply installing another package can restore non-native Tree-sitter parsing.
- Skill guidance matches current CLI/package surface.

## Phase 4: Test Updates

Implementation checklist:

- [x] Replace package metadata tests that assert shim properties with tests asserting the shim package is absent.
- [x] Update release-script tests to cover the two-package release model.
- [x] Keep native fallback contract tests focused on reduced mode and native package absence.
- [x] Add a regression test that release commands reject `--package js-fallback` with a clear unknown-selector error.

Acceptance:

- Tests prove `js-fallback` is not publishable.
- Tests prove root/native release flow still works.
- Tests prove reduced-mode fallback still works without the deleted package.

## Phase 5: Validation

Run focused checks during implementation:

- [x] `npx vitest run tests/package-metadata.test.ts tests/release-script.test.ts tests/native-fallback-contract.test.ts tests/native-fallback-reporting.test.ts`
- [x] `npx vitest run tests/js-fallback-loader.test.ts` if the file still exists; otherwise delete or replace it with reduced-mode coverage.
- [x] `npm run check`

Manual verification:

- [x] `node ./dist/cli.js doctor` reports native status without mentioning a JS fallback package.
- [x] `node ./dist/cli.js orient --root . --budget small --json` still works with native available.

## Risks and Non-Goals

Risks:

- Existing external consumers importing `@lzehrung/codegraph-js-fallback` will break after removal.
- Release automation has several references to all publishable packages; partial cleanup can leave CI publishing stale package notes or invalid selectors.

Non-goals:

- Do not remove reduced-mode regex recovery.
- Do not add a new JS parser fallback.
- Do not change native package loading or native target publication except where release package enumeration currently includes `js-fallback`.
