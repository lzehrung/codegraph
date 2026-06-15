# Repository Deep Review - 2026-06-14

This review covers implementation, tests, docs, generated artifacts, and the repo's own Codegraph output.

Baseline commands run:

- `node ./dist/cli.js doctor`
- `node ./dist/cli.js orient --root . --budget small --json`
- `node ./dist/cli.js inspect --root . ./src --limit 40`
- `node ./dist/cli.js hotspots --root . ./src --limit 40`
- `node ./dist/cli.js cycles --root . --sort priority`
- `node ./dist/cli.js unresolved --root .`
- `node ./dist/cli.js duplicates --root . ./src --profile cleanup`
- `npm run check`

Baseline result:

- Native backend is available for 22 language IDs: C, C++, C#, CSS, Go, HTML, Java, JavaScript, Kotlin, Less, PHP, Python, Ruby, Rust, SCSS, SQL, Svelte, Swift, TypeScript, TSX, Vue, and Zig.
- `unresolved --root .` found no unresolved external imports.
- `npm run check` passed: lint, format, build, and `test:fast`.
- `test:fast` passed 164 test files and 1871 tests, with 5 skipped tests.

## Findings

### 1. CLI typos can be accepted silently

Examples verified locally:

- `graph --root . ./src --json --nonesuch` exits 0 and produces graph JSON.
- `duplicates --root . ./src --nonesuch --limit 0` exits 0 and produces duplicate output.
- `impact --provider raw stray-position --pretty` exits 0 and ignores the stray positional.
- `inspect --root . ./src --limt 1 --json` treats `1` as an include root and fails with a misleading project-root error.

Why it matters:

- Agent and CI usage needs fail-fast option handling.
- Silent typos produce trustworthy-looking output from the wrong input contract.

### 2. A docs command silently drops one ignore glob

`docs/cli.md` previously showed:

```bash
codegraph impact --base main --head feature --ignore-glob "**/package-lock.json" --ignore-glob "**/dist/**"
```

The second glob was a bare positional for a command that does not use include roots, so it was ignored. The documented command now repeats `--ignore-glob` for the second pattern.

### 3. Current cycle output has one real TypeScript architecture cycle and one Rust analyzer false positive

Current `cycles --root . --sort priority --json` reports:

- A 6-file TypeScript cycle across `src/indexer/types.ts`, `src/indexer/reference-candidates.ts`, and `src/indexer/build-cache/*`.
- A Rust cycle involving `packages/codegraph-native/src/lib.rs`, `tests.rs`, and `duplicate_tokens.rs`.

The TypeScript cycle is mostly type-oriented but includes runtime edges through cache modules. The Rust cycle appears to be an analyzer issue around `#[cfg(test)] mod tests` and local test modules being modeled as production graph edges.

### 4. Persistent cache SQLite tables do not have explicit migration paths

The graph export schema has a version and an older-schema regression test. The module cache and duplicate-unit cache create tables with `CREATE TABLE IF NOT EXISTS` but do not record schema versions or migrate older cache files.

Affected areas:

- `src/indexer/build-cache/module-cache.ts`
- `src/duplicates.ts`
- `tests/disk-cache-sqlite.test.ts`
- `tests/cache-invalidation.test.ts`

Why it matters:

- Cache files are persistent on disk.
- Future columns or indexes can leave existing users with stale or incompatible cache DBs.

### 5. GitHub PR diff provider is less bounded than the git provider

The git provider streams `git diff` into the parser. The GitHub provider fetches the whole PR diff with `fetch(...).text()` and has no timeout, abort signal, response byte cap, or streaming parse path.

Why it matters:

- Large PRs or slow network calls can hang or allocate too much memory.
- Local git analysis already has stronger behavior than remote PR analysis.

### 6. Native JS test coverage can be skipped without failing the default check

Native-specific JS suites use runtime-dependent `describe.skip`, and `test:fast` excludes several native suites. That is reasonable for local reduced-mode workflows, but there is no single JS command that both requires native availability and fails when native semantic suites are skipped.

Why it matters:

- The shipped package is native-first.
- CI should have one explicit "native must be present" lane for native semantic and ownership coverage.

### 7. Lint and type-safety enforcement can be tightened for tests and helpers

The configured lint script covers `src/**/*.ts` and `tests/**/*.test.ts`. Test helpers and graph-visualization TypeScript support files are outside the package script, even though a broader lint probe over `tests/**/*.ts` passes today.

Also, the test rule override disables several type-safety rules. There are existing loose test casts and double assertions that would be worth replacing with typed fixtures, parser helpers, or narrow runtime guards.

### 8. Coverage summaries mix actionable files with type-only noise

`docs/coverage/js.md` reports 89.33 percent line coverage and 83.24 percent branch coverage. The least-covered table includes type-only modules at 0 percent alongside actionable modules such as:

- `src/cli/navigation.ts`
- `src/util/packageExports.ts`
- `src/util/resolution/node.ts`
- `src/cli/search.ts`
- `src/sqlite/common.ts`
- `src/cli/packet.ts`
- `src/cli/graph.ts`
- `src/cli/context.ts`

Why it matters:

- The table is less useful when type-only files occupy the top rows.
- Low CLI and resolution coverage is more actionable for a trust-oriented tool.

### 9. Duplicate cleanup output points to useful extraction targets

Top cleanup candidates:

- C and C++ language definitions share a large C-family shape.
- Java, C#, Ruby, Rust, Kotlin, PHP, and Swift definitions repeat similar declaration and query patterns.
- `src/util/resolution/jvm.ts` duplicates Java and Kotlin symbol-index readers.
- CLI command context types repeat across command modules.
- `src/util/projectFiles/definitions.ts` has several repeated metadata-definition shapes.

Why it matters:

- Some duplication encodes language parity intentionally.
- A few table-driven helpers would reduce drift risk without hiding per-language differences.

### 10. Docs are accurate in many details but too spread out for maximum insight

Current word counts show substantial duplication of command guidance:

- `docs/scenario-catalog.md`: 4963 words
- `docs/cli.md`: 4550 words
- `docs/library-api.md`: 3453 words
- `README.md`: 3059 words
- `docs/agent-workflows.md`: 2899 words
- `codegraph-skill/codegraph/SKILL.md`: 1036 words

Why it matters:

- The README is still doing more than landing-page and docs-index work.
- CLI examples are repeated across README, CLI docs, agent workflows, and the skill, increasing sync risk.

## Phased Improvement Plan

## Phase 1: Make CLI Input Handling Strict

Changes:

- [x] Add per-command allowed flags, options, and positional arity validation.
- [x] Reject unknown long flags, unknown short flags, and unexpected positionals before command execution.
- [x] Preserve deliberate pass-through behavior only after a `--` separator where a command truly supports it.
- [x] Improve typo errors so `--limt 1` reports an unknown option instead of treating `1` as a scan root.
- [x] Fix `docs/cli.md` to repeat `--ignore-glob` for each `impact` ignore pattern.

Tests:

- [x] Add CLI regression tests for unknown flags on `graph`, `inspect`, `duplicates`, `impact`, `search`, `explain`, and `packet`.
- [x] Add tests for unexpected positionals on commands that do not use include roots.
- [x] Add a docs/package metadata test for the corrected `impact --ignore-glob` example.
- [x] Run `npm run test:integration` and `npm run check`.

Watch out:

- Some commands intentionally accept include roots.
- `artifact build --sqlite` is context-sensitive and already has special parsing.
- Do not break `--` handling for stdin or future pass-through use.

## Phase 2: Fix Graph Cycle Correctness and Break Current Production Cycles

Changes:

- [x] Filter or annotate Rust `#[cfg(test)]` module edges so test-only Rust modules do not appear as production dependency cycles.
- [x] Add a native Rust fixture with `#[cfg(test)] mod tests` and an inner local `mod tests` to lock the behavior.
- [x] Break the TypeScript indexer/cache SCC by moving shared cache manifest entry types out of `src/indexer/types.ts`.
- [x] Move reference-candidate index types into a neutral type-only module or inline the small shape where appropriate.
- [x] Keep runtime cache helpers out of broad shared type modules.

Tests:

- [x] Add Rust graph/cycle regression coverage for test-only modules.
- [x] Add a source-structure test that `cycles --root . ./src --sort priority --json` reports no TypeScript source cycles.
- [x] Run `node ./dist/cli.js cycles --root . --sort priority --json`.
- [x] Run focused graph, native, and source-structure tests, then `npm run check`.

Watch out:

- `src/indexer/types.ts` has high fan-in, so move only small neutral types at first.
- Type-only imports can still affect graph output; verify the analyzer behavior, not just TypeScript compilation.

## Phase 3: Version and Migrate Persistent Caches

Changes:

- [x] Add schema version metadata to `index-cache.sqlite`.
- [x] Add schema version metadata to `duplicate-unit-cache.sqlite`.
- [x] Add migration helpers that inspect existing columns and indexes before use.
- [x] Keep incompatible old cache handling safe: migrate when possible, otherwise invalidate and rebuild.
- [x] Document the persistent cache schema policy briefly in `docs/how-it-works.md` or `docs/cli.md`.

Tests:

- [x] Add an old `module_cache` DB fixture/test that lacks the newest expected schema and proves upgrade behavior.
- [x] Add an old `duplicate_unit_cache` DB fixture/test with the same upgrade proof.
- [x] Add corrupt metadata tests that fall back to rebuild without crashing user commands.
- [x] Run `tests/disk-cache-sqlite.test.ts`, `tests/cache-invalidation.test.ts`, `tests/duplicates.test.ts`, and `npm run check`.

Watch out:

- Cache DBs are best-effort performance artifacts, not user data.
- Do not make migration failures block successful indexing when a rebuild is enough.

## Phase 4: Bound Remote Diff and Long-Running Work

Changes:

- [x] Add timeout and `AbortController` support to GitHub PR diff fetches.
- [x] Stream GitHub diff response bodies into `parseUnifiedDiffStreaming` where possible.
- [x] Enforce a byte cap or line cap with an explicit warning for oversized remote diffs.
- [x] Validate `--repo owner/name` strictly before making a network request.
- [x] Consider moving the git-provider shortstat warning threshold into a named option or constant.

Tests:

- [x] Add GitHub provider tests for timeout, HTTP failure, malformed repo, oversized diff, and normal diff parsing.
- [x] Add parity tests showing local git and GitHub providers produce equivalent parsed diff shapes for the same fixture.
- [x] Run `tests/impact-provider-github.test.ts`, `tests/impact-git-provider.test.ts`, `tests/impact-cli.test.ts`, and `npm run check`.

Watch out:

- Node fetch streaming differs slightly by runtime version.
- Keep error messages short and actionable for CLI output.

## Phase 5: Strengthen Native and Cross-Language Verification

Changes:

- [x] Add a native-required JS test script that fails immediately if native is unavailable.
- [x] Use that script for native semantic, parser ownership, native query, and native worker suites.
- [x] Keep reduced-mode fallback tests separate so unsupported hosts can still validate graceful degradation.
- [x] Make skip counts visible in CI summaries.

Tests:

- [x] Run the new native-required JS script on a host with the native addon.
- [x] Run reduced-mode fallback tests with native disabled.
- [x] Run `npm run test:native`.
- [x] Run `npm run check`.

Watch out:

- Local contributors without native support still need a documented path to run useful tests.
- Native-required checks should be CI-gated, not silently skipped.

## Phase 6: Clean Up High-ROI Duplication Without Losing Parity

Changes:

- [x] Extract C-family language-definition builders for C and C++ shared query/block patterns.
- [x] Extract a JVM symbol-index reader helper for Java and Kotlin.
- [x] Introduce small command-context helpers only where they remove repeated shape definitions.
- [x] Consolidate project-file definition table boilerplate while keeping per-ecosystem metadata explicit.
- [x] Leave intentional language-specific differences visible in data, not hidden in control flow.

Tests:

- [x] Run `node ./dist/cli.js duplicates --root . ./src --profile cleanup` and confirm high-ROI groups shrink.
- [x] Run nearest language tests for every touched language definition.
- [x] Run shared `tests/goto.test.ts`, `tests/references.test.ts`, and `tests/native-semantic-parity.test.ts` when source-language behavior changes.
- [x] Update `docs/language-parity.md` and `docs/scenario-catalog.md` only if support claims change.

Watch out:

- Do not extract abstractions that make grammar-specific query differences harder to audit.
- Cross-language parity requires tests, not just shared helper reuse.

## Phase 7: Tighten Test Hygiene and Coverage Signals

Changes:

- [x] Change the lint script to cover `tests/**/*.ts`, not only test files.
- [x] Remove broad test type-safety disables incrementally, starting with helper files and new tests.
- [x] Replace loose test casts with typed helper return shapes or narrow runtime guards.
- [x] Exclude type-only modules from the coverage least-covered table, or show them in a separate section.
- [x] Add targeted tests for low-coverage CLI/resolution modules: `cli/navigation`, `cli/search`, `cli/packet`, `cli/graph`, `cli/context`, `util/packageExports`, `util/resolution/node`, and `sqlite/common`.

Tests:

- [x] Run broad lint over `src/**/*.ts` and `tests/**/*.ts`.
- [x] Run `npm run test:coverage` and refresh `docs/coverage/js.md`.
- [x] Run the narrow suites for each newly covered module.
- [x] Run `npm run check`.

Watch out:

- Tightening all test rules at once will create noisy churn.
- Coverage improvements should target behavior that can regress, not only uncovered lines.

## Phase 8: Compress and De-Duplicate Documentation

Changes:

- [x] Keep README as a landing page and docs index, with fewer long JSON examples.
- [x] Make `docs/cli.md` the canonical CLI contract page.
- [x] Make `docs/agent-workflows.md` recipe-oriented and link to CLI/API docs instead of repeating option contracts.
- [x] Keep `codegraph-skill/codegraph/SKILL.md` short and operational, with only agent-first command guidance.
- [x] Add a lightweight docs consistency test for shared CLI examples that appear in multiple files.

Tests:

- [x] Run package metadata/docs tests.
- [x] Run a docs grep for repeated stale commands.
- [x] Run `npm run check`.

Watch out:

- The docs are currently accurate in many nuanced places; compress without deleting support-boundary caveats.
- If CLI flags or output contracts change, update `docs/cli.md` and `codegraph-skill/codegraph/SKILL.md` in the same change.

## Suggested Order

1. CLI strictness and docs command fix.
2. Cycle correctness and source-cycle cleanup.
3. Cache schema versioning.
4. GitHub diff bounding.
5. Native-required test lane.
6. Duplication cleanup.
7. Coverage and test hygiene.
8. Documentation compression.

This order starts with user-trust failures, then removes analyzer correctness noise, then hardens persistent state and remote inputs before doing maintainability cleanup.
