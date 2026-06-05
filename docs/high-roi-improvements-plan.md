# High-ROI Improvements Plan

This plan captures new improvement candidates from a repo review using the docs, Codegraph CLI, tests, and implementation. It intentionally ignores existing `docs/superpowers/plans/**` material.

Use the checklists to track progress. Keep behavior changes paired with focused tests and the relevant docs updates.

## Priority 1: Agent Command Performance

Agent-facing commands currently rebuild a full session index instead of taking the faster incremental cache path used by other CLI flows. Local measurements on this repo were roughly 20s for `search`, 22s for `inspect ./src`, and 33s with 1.9GB RSS for `orient --budget medium`.

Why this matters:

- Agent commands are the first-run experience for repo understanding.
- Slow orientation and search make the tool feel less deterministic than the underlying cache model should allow.
- The JSON outputs are small, so the cost is mostly analysis work, not serialization.

Implementation outline:

- [ ] Teach `createAgentSession` to accept index/build options.
- [ ] Use the incremental disk-cache path for `search`, `orient`, `explain`, `packet`, and library equivalents where safe.
- [ ] Thread worker/native/cache options through the matching CLI commands.
- [ ] Avoid building the full symbol graph for path-only or text-only query modes.
- [ ] Add a regression test or benchmark fixture for warm-cache agent command latency.

## Priority 2: Cheaper Orientation Health

`orient --budget medium` currently pays for duplicate analysis as part of health reporting. Duplicate detection is valuable, but full candidate generation is too expensive for a default orientation pass.

Why this matters:

- Orientation should answer "where should I look next?" quickly.
- Full duplicate health is useful as a follow-up, not necessarily as default context.
- Expensive health checks hide the value of the small/medium budget distinction.

Implementation outline:

- [ ] Split cheap health summaries from exhaustive duplicate analysis.
- [ ] Make duplicate health opt-in or bounded for medium orientation.
- [ ] Preserve full duplicate counts in `duplicates` and any explicit full-health mode.
- [ ] Include omitted or partial-analysis metadata in JSON output.
- [ ] Add tests for budget behavior and stable omitted fields.

## Priority 3: Reduce Unresolved Import Noise

Whole-root scans report unresolved imports from language fixtures and Rust native dependencies. Scanning `./src` reports zero unresolved imports, so the signal issue is mostly scope and external classification.

Why this matters:

- False unresolved imports reduce trust in orientation health.
- Declared Rust crates such as `napi` and `tree-sitter` should not look like local resolution failures.
- Fixture directories should be clearly included or clearly ignored by default.

Implementation outline:

- [ ] Improve Rust external detection for `crate::module` and grouped-use specifiers such as `tree_sitter::{Language, Parser}`.
- [ ] Add regression coverage using declared dependencies from `Cargo.toml`.
- [ ] Decide whether `tests/languages/samples/**` should be ignored by the repo config for default scans.
- [ ] If fixture scans remain in scope, classify fixture unresolved groups separately in orientation health.
- [ ] Update `README.md` or CLI docs only if default scan guidance changes.

## Priority 4: Cross-Language Receiver-Aware References

Receiver-aware `goto` support already covers more languages than JS/TS, but verified whole-project method reference scans are still JS/TS-only. The result is an uneven user experience for languages where local method symbols and receiver navigation already work.

Why this matters:

- Cross-language consistency is one of the product claims.
- Users expect `findReferences` and `goto` to agree when the same receiver proof is available.
- This is an accuracy improvement with clear fixture-test boundaries.

Implementation outline:

- [ ] Start with languages already supported by receiver-aware `goto`.
- [ ] Extend verified method reference scans conservatively, using receiver proof only.
- [ ] Add cases to `tests/references.test.ts` for at least Java, C#, Ruby, and Rust where supported.
- [ ] Update `docs/language-parity.md` and `docs/scenario-catalog.md` with the exact support boundary.
- [ ] Keep intentional limitations explicit rather than silently falling back to broad name matching.

## Priority 5: Agent Search Ranking

Natural-language searches can rank symbol/tool hits above exact documentation matches. For example, an exact docs phrase can appear behind broader symbol results.

Why this matters:

- Agents use search for both code anchors and conceptual lookup.
- Exact phrase matches in docs are often the best answer for "what is this capability?" queries.
- Better ranking improves existing behavior without adding a new tool surface.

Implementation outline:

- [ ] Add phrase and proximity scoring for multi-token queries.
- [ ] Add a modest Markdown/text boost when exact phrases appear in docs.
- [ ] Consider a `--mode text` or `--mode docs` option if ranking alone is not enough.
- [ ] Add tests for exact docs phrase ranking and symbol-heavy query ranking.
- [ ] Keep symbol-first behavior for identifier-like queries.

## Priority 6: Break Type-Only Cycles

Current cycle reports highlight two low-risk cleanup targets: review modules depending back on `review.ts` for shared types, and call-compatibility provider modules depending back on the main compatibility module for types.

Why this matters:

- These cycles are small, but they make future refactors harder.
- Both look type-oriented and can likely be removed without behavior changes.

Implementation outline:

- [ ] Extract shared review types to `src/review/types.ts`.
- [ ] Import review shared types from the neutral module in `src/review.ts` and `src/review/*`.
- [ ] Move `CallableSignature` and `CallsiteArguments` into a neutral call-compatibility types module.
- [ ] Re-run `cycles --root . ./src --sort priority --json`.
- [ ] Run the focused review and impact call-compatibility tests.

## Priority 7: Duplicate Detection Budgets

Duplicate detection returns bounded output, but it can still perform large all-pairs work before producing a small result set. A top-20 source scan still compared more than 120k pairs locally.

Why this matters:

- Duplicate findings are useful, but they should not dominate agent-oriented commands.
- Budgeted commands need budgeted analysis, not only budgeted output.

Implementation outline:

- [ ] Add budget controls such as max units, max pairs, or max time for caller-selected quick modes.
- [ ] Report partial-analysis metadata in JSON.
- [ ] Keep exhaustive behavior available for the dedicated `duplicates` command.
- [ ] Use bounded duplicate checks in `inspect`, `orient`, and review hints.
- [ ] Add tests for omitted counts and deterministic partial results.

## Priority 8: Small Simplicity Cleanups

Duplicate analysis surfaced a few operational helpers that are worth consolidating. Avoid over-abstracting declarative language-definition boilerplate unless it blocks active work.

Candidates:

- [ ] Consolidate dependency and reverse-dependency helpers in `src/agent-tools.ts`.
- [ ] Share duplicate similarity hint formatting between impact and review CLI paths.
- [ ] Consolidate JVM symbol index readers.
- [ ] Review repeated SQLite write/delete helpers for a small shared helper.
- [ ] Leave language definition query repetition alone unless the same edit must be made repeatedly.

## Priority 9: Public API Boundary

The root export is intentionally broad today. That keeps compatibility simple, but it increases semver pressure when internals need to move.

Implementation outline:

- [ ] Sketch stable subpath exports for agent, graph, indexer, impact, and language support.
- [ ] Add an API surface snapshot or CI check before narrowing exports.
- [ ] Document replacement paths before any deprecation.
- [ ] Update `docs/library-api.md` only when an actual API contract changes.

## Priority 10: Test Type Hygiene

The source tree largely avoids forbidden casts, but tests still contain some `as any` and `as unknown as` usage.

Implementation outline:

- [ ] Replace casts with typed fixture builders as files are touched.
- [ ] Avoid a large mechanical cleanup unless it removes repeated friction.
- [ ] Keep test behavior realistic; do not weaken assertions to satisfy types.

## Suggested Execution Order

- [ ] Fix agent cache usage and cheap orientation health first.
- [ ] Fix unresolved import noise next, because it improves trust in health output.
- [ ] Expand receiver-aware references once the navigation/reference boundary is clear.
- [ ] Improve search ranking after adding tests that capture current desired behavior.
- [ ] Use cycle and duplicate-helper cleanups as low-risk follow-up work between feature changes.

## Validation Checklist

- [ ] Run focused tests for each touched subsystem during iteration.
- [ ] Run `node ./dist/cli.js doctor` after build changes.
- [ ] Run `node ./dist/cli.js orient --root . --budget small --json`.
- [ ] Run `node ./dist/cli.js orient --root . --budget medium --json` for health-related changes.
- [ ] Run `node ./dist/cli.js inspect --root . ./src --limit 20 --json` for graph/health changes.
- [ ] Run `npm run check` before concluding major implementation work.
