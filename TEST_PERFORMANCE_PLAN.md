# Test Performance Plan

Goal: review every test or test file with cases over 2 seconds. Optimize product code first when the slow test exposes repeated work, then simplify the harness when the cost is mostly process startup or integration setup.

## Current Slow Areas

- `tests/cli-regressions.test.ts`
  - Full file has taken about 204s.
  - Slow cases include skill install/doctor matrix checks and CLI import startup checks.
- `tests/impact-cli.test.ts`
  - Full file has taken about 62s after parsed-tree reuse, and about 132s before.
  - Individual cases still take about 5s to 11s because each case starts `tsx`.
- `tests/native-semantic-parity.test.ts`
  - Full file has taken about 52s.
  - This appears to be true native/runtime parity coverage.
- `tests/detailed-symbol-native-only.test.ts`
  - Full file has taken about 46s.
  - Several cases rebuild native-only indexes or reload fallback-sensitive modules.
- `tests/native-parser-ownership.test.ts`
  - Full file has taken about 43s.
  - Coverage is integration-heavy and validates runtime ownership boundaries.
- `tests/native-worker-parity.test.ts`
  - Full file has taken about 28s.
  - The mixed fixture case is the main slow path.
- `tests/native-fallback-reporting.test.ts`
  - One case timed out at 30s under full-suite load but passed alone in about 10s.
  - The cost appears tied to module reset/import and public barrel loading.
- `tests/goto.test.ts`
  - Full file has taken about 68s.
  - Repeated per-case index builds and navigation setup are likely major contributors.
- `tests/references.test.ts`
  - Full file has taken about 50s.
  - Repeated candidate scans and fixture index builds are likely major contributors.
- `tests/session.test.ts`
  - Full file has taken about 47s.
  - Several cases intentionally exercise initialization, warmup, and disposal races.

## Checklist

- [x] Add a slow-test reporting workflow.
  - Emit per-test and per-file timings from Vitest in CI.
  - Flag any individual test over 2s as review-required.
  - Flag any individual test over 10s as integration-only unless it has a documented reason.
  - Added `scripts/report-slow-tests.mjs` and wired `npm run test:ci` to emit `.vitest/slow-tests.json`.

- [x] Reuse parsed files during impact CLI analysis.
  - `src/cli/impact.ts` now passes `keepParsed: true` when building the impact index.
  - This avoids reparsing during reference collection and symbol graph work.
  - Commit: `89f4da9`.

- [x] Avoid duplicate project-file discovery during index finalization.
  - `buildProjectIndex()` discovers project files up front, then `finalizeProjectIndex()` calls `discoverProjectFiles()` again.
  - Thread already-discovered project file metadata into `finalizeProjectIndex()` when available.
  - Preserve current `projectFiles` output shape and symlink safety checks.
  - Verify with `tests/project-file-discovery.test.ts`, `tests/index.test.ts`, and impact/report tests.
  - Added a finalize regression so provided project-file metadata is reused without rediscovery.

- [x] Scope `buildSymbolGraph()` inside `buildSymbolGraphDetailed()`.
  - `buildSymbolGraphDetailed(index, { files })` still builds the base symbol graph for the full index.
  - Add a scoped base graph path or optional file filter to `buildSymbolGraph()`.
  - Impact report calls detailed graph with `files: relevantFiles`, so this should reduce impact CLI and review work.
  - Verify with `tests/symbol-graph.test.ts`, `tests/symbols-detailed-prune.test.ts`, and `tests/impact-cli.test.ts`.
  - Added a `buildSymbolGraph()` file filter and a regression that detailed graph scoping excludes unrelated base import edges.

- [x] Add reverse import/export lookup indexes for navigation.
  - `findReferences()` still scans candidate modules per call.
  - Build or lazily cache reverse lookup structures keyed by target file and exported name.
  - Use these lookups to narrow candidate files before parsing scopes.
  - Verify with `tests/references.test.ts`, `tests/goto.test.ts`, `tests/impact.test.ts`, and `tests/review.test.ts`.
  - Added a weakly cached candidate-file selector that preserves re-export and wildcard import resolution.

- [ ] Reuse indexes in `goto` and `references` tests.
  - Many cases rebuild identical fixture indexes.
  - Group cases by fixture root and build shared indexes in `beforeAll`.
  - Keep mutation-heavy temp-project cases isolated.
  - This is test-harness cleanup, but it will make product-code profiling easier.

- [x] Reduce `impact-cli` process startup overhead.
  - Most cases spawn `node tsx src/cli.ts`.
  - Use in-process `runCli()` for cases that do not need real process semantics.
  - Keep one subprocess smoke test for CLI entrypoint behavior.
  - Verify that stdin, cwd, env, and exit-code behavior remain covered.
  - Added injectable CLI stdin and converted impact CLI cases to `runCli()`, leaving one subprocess smoke.

- [x] Split skill install matrix coverage.
  - `skill install supports all agent defaults` loops through six agents and can take about 54s.
  - Move target resolution into exported or testable helpers where possible.
  - Unit-test the matrix in-process and keep one end-to-end install test.
  - Verify with `tests/cli-regressions.test.ts` skill install and doctor cases.
  - Exported default target resolution, moved the six-agent matrix in-process, and kept subprocess smoke coverage.

- [ ] Reduce `native-fallback-reporting` module reload cost.
  - The slow ast-grep case uses `vi.resetModules()` and imports the public barrel.
  - Import the narrow module under test when possible.
  - Keep one public-barrel smoke test for export wiring.
  - Verify the test still proves unified query execution is used and legacy single-query execution is not called.

- [ ] Review native parity fixture size.
  - `native-semantic-parity`, `native-worker-parity`, and `detailed-symbol-native-only` are valid integration coverage.
  - Identify whether each slow case needs full representative fixtures.
  - Split broad runtime smoke coverage from focused regression assertions.
  - Keep one full mixed-language parity test in an integration job if needed.

- [ ] Cache or share session test setup where behavior allows.
  - `tests/session.test.ts` intentionally covers lifecycle and race behavior.
  - Shared roots or fixture writes can still reduce setup cost for non-mutating cases.
  - Do not weaken tests that validate disposal, expiration, or concurrent warmup semantics.

- [ ] Make integration tiers explicit.
  - Add scripts for fast PR tests and slower integration tests.
  - Suggested split: unit, navigation, impact/review, cli, native.
  - Keep the default developer loop under a predictable budget.
  - Document the split in `README.md` or contributor docs if scripts change.

## Verification Pattern

- Run focused tests for each touched area first.
- Run `npm run lint`, `npx tsc -p tsconfig.json --noEmit`, and `git diff --check`.
- Run `npx tsx src/cli.ts review --base HEAD --head STAGED --summary` before committing.
- Run full integration CI after batching slow-test changes, but track timeout failures separately from functional failures.
