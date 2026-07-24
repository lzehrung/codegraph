# Bounded Impact/Review Fixes and Candidate-Test Accuracy Plan

**Status: Implemented.** Evidence and source references below were verified against `main` at `3c09f572` (`v1.8.99`) and the current `../gunship` branch on 2026-07-21.

## Scope decision

Original feedback ("build a review packet with two reviewer lanes, execution paths, and a
finding ledger") was intended for `../review-until-clean-odw`, not this repository. That tool
already owns orientation, reviewer grouping, and correction-loop state:

- `review-until-clean-odw`'s Orient phase builds its own shared context (diff summary,
  callers/callees, doc excerpts, risk hunks) as a markdown blob inlined into its own prompts.
  Its only codegraph touchpoint is one CLI call: `codegraph impact --provider git --base <base>
--head <head> --pretty` (or `refs`/`callers`/`callees`), explicitly documented as an
  "OPTIONAL accelerant, never a requirement" (`../review-until-clean-odw/workflows/review-and-correct.js:265-271`,
  `README.md:19-21`). It never asks codegraph for a structured packet, lanes, or ledger schema.
- `../code-review-agent` tried the opposite: `OpencodeReviewPacket`
  (`agent/src/review/opencode/types.ts`) fuses graph evidence with workflow policy — `mode`,
  `checklist`, `outputContract`, `candidateGenerationPolicy`, `scope`, `packetFingerprint` — into
  one object threaded through `backend.ts` (1500+ lines), `reviewPacket.ts`, `validation.ts`,
  `contextLayerDiagnostics.ts`, `exploratorySession.ts`, and `pipeline.ts` (2900+ lines). That
  coupling between structural evidence and orchestration policy is the fragmentation this
  plan avoids repeating.

Codegraph's job stays narrow: correct, deterministic, bounded structural evidence behind
`impact`, `review`, `refs`, `callers`, `callees`. Reviewer grouping, risk-hunk narrative,
context packets, and finding ledgers are consumer-owned (ODW today, any other orchestrator
tomorrow). This plan only fixes defects that block that narrow contract: wrong data, unbounded
compute, and weak candidate-test evidence in valid C/C++ layouts.

## Goals

- `codegraph impact --provider git --pretty` and `codegraph review --summary` return correct,
  complete-or-honestly-partial results within a bounded time on realistic diffs, so an
  orchestrator's single accelerant call is actually fast enough to be worth making.
- Existing tracked, non-indexed files that changed are never misreported as deleted.
- MCP `impact` returns impact data, not a review report.
- Candidate-test ranking reflects proven graph edges when they exist, including for C/C++
  projects with repo-local include roots.

## Non-goals

- No new packet/context schema, reviewer-lane taxonomy, execution-path grouping, or finding
  ledger. Those are workflow concerns owned outside this repository.
- No change to how `review`/`impact` results are consumed, grouped, or narrated by callers.
- No general workflow engine or reviewer scheduler.

## Verified baseline defects

### F1: Minimal review is not computationally minimal

On `../gunship`, this command reviewed 40 changed files and 1,043 changed symbols:

```bash
node ../codegraph/dist/cli.js review --root . --base main --head HEAD \
  --summary --review-depth minimal --duplicates off --report
```

Two consecutive runs took 52.69s and 53.57s. The reports attributed 16.24s and 16.70s to
indexing, leaving about 36.45s and 36.87s in unreported work.

`buildReviewReport()` always calls `collectReviewDuplicateTasks()` (`src/review.ts:349-356`).
`--duplicates off` is parsed only after the report has been built (`src/cli/review.ts:326-339`),
so it suppresses the second human-summary duplicate pass but not the expensive duplicate task
pass underneath it.

### F2: Impact bounds are per symbol, not per request

This Gunship command took 291.27s even with `--max-refs 200` and `--depth 2`:

```bash
node ../codegraph/dist/cli.js impact --root . --base main --head HEAD \
  --pretty --duplicates off --compact --max-refs 200 --depth 2
```

`analyzeDirectReferences()` schedules one lookup for every changed symbol
(`src/impact/direct.ts:36-47`). `maxRefs` is applied independently inside every lookup
(`src/impact/direct.ts:61-75`), so 1,043 changed symbols can still trigger 1,043 reference
queries and retain up to 208,600 references before any request-wide cap applies.

This is the exact command shape `review-until-clean-odw`'s Orient phase runs as its accelerant
call. An unbounded 291s run defeats the purpose of the call being an accelerant at all.

### F3: MCP `impact` does not run impact analysis

The MCP `impact` handler calls `buildReviewReport(..., reviewDepth: "minimal")`
(`src/mcp/server.ts:759-768`). Its tool description says it builds compact impact context
(`src/mcp/tools.ts:293-295`), but it returns a `ReviewReport`, not an `ImpactReport`. Any MCP
caller selecting or reasoning about impact limits gets review data instead.

### F4: Changed non-indexed files are falsely reported as deleted

Gunship's modified PowerShell scripts and `justfile` exist on disk and are `M` in
`git diff --name-status main...HEAD`. The review summary reported them as `deleted`.

When a changed file has no indexed module, `summarizeChangedFiles()` maps it to `deleted`
unless it is a missing explicit input (`src/review/summaries.ts:402-415`). Status must come
from the diff kind and disk existence, not from whether the language produced a `ModuleIndex`.

### F5: Candidate tests degrade to pattern-only hints in valid C++ layouts

Gunship review returned 10 low-confidence pattern matches and no high- or medium-confidence
candidates. `deps Source/Gunship/Private/Damage/Tests/DamageModelTests.cpp` returned an empty
list even though the file includes `"Damage/Simulation/GunshipDamageModel.h"`.

Codegraph already supports `graph.resolutionHints` and CLI `--resolution-hint`, but
`codegraph.config.json` persists only discovery settings (`src/config.ts:10-27`). MCP and
library sessions therefore cannot inherit repo-local C/C++ include roots without host-specific
startup configuration on every call.

## Priority 0: Repair correctness and MCP semantics

- [x] In `src/review/summaries.ts`, classify `deleted` only when the diff says deleted or the
      file is absent for a non-explicit diff entry. Existing non-indexed files become `updated`
      with `symbols: []`.
- [x] Add a regression with modified tracked PowerShell, Markdown, and extensionless files.
      Assert that language support does not control change status.
- [x] Change MCP `impact` to load one session snapshot and call `analyzeImpactFromDiff()` with
      `provider: "git"`, `compact: true`, and bounded MCP defaults.
- [x] Keep MCP `review` returning `ReviewReport`; no schema change there.
- [x] Add MCP tests that distinguish impact and review by schema: impact has
      `format: "compact"` and `impacted`; review has `riskSummary` and `reviewTasks`.

Likely files: `src/review/summaries.ts`, `src/mcp/server.ts`, `src/mcp/tools.ts`,
`tests/review.test.ts`, `tests/mcp-server.test.ts`, `tests/git-diff-semantics.test.ts`.

Acceptance:

- Gunship's changed Build scripts and `justfile` report `updated`.
- MCP `impact` returns actual impacted items and never returns a `ReviewReport` under the
  impact tool name.

## Priority 1: Add hard work, time, and byte budgets

Count limits must constrain computation before work is scheduled, not just truncate output
after the fact.

### Impact work budgets

Add these optional `ImpactOptions` fields alongside existing per-symbol `maxRefs`:

- `maxChangedSymbols`: maximum changed symbols that receive precise reference analysis.
- `maxReferenceLookups`: maximum calls to `findReferences()` and call-compatibility analysis.
- `maxTotalReferences`: request-wide retained reference budget.
- `timeBudgetMs`: soft post-index analysis deadline.

Rank changed symbols deterministically before applying limits:

1. signature changed;
2. exported/public contract;
3. proven incoming call or reference edge;
4. callable/type declaration before local variable;
5. higher file fan-in;
6. stable file, range, and handle ordering.

Process bounded batches of at most eight symbols. Check the deadline before launching each
batch, finish already-started work, and return a valid partial report with exact skipped
counts (`changedSymbolsTotal/Analyzed/Omitted`, `referenceLookupsStarted/Omitted`,
`referencesRetained/Omitted`, `deadlineExceeded`).

Do not make timing the only bound. The hard symbol and lookup limits guarantee finite work
even on a fast machine or a client with no timeout.

### Review stage budgets

Add review options for `duplicateTasks`, `maxChangedFiles`, `maxChangedSymbols`, and
`maxGraphDeltaEdges`. Parse `--duplicates off` before building the report so it prevents
`prepareDuplicateAnalysis()` entirely, not just the human-summary pass. `changed|impacted|all`
remains explicit opt-in work.

### MCP/CLI pretty and JSON output budgets

Apply a request-wide `maxOutputBytes` to MCP `impact` and `review` responses (defaults tuned to
MCP context budgets), dropping whole lowest-ranked entries and recording exact omitted counts
rather than truncating serialized JSON mid-field. This is defensive sizing for the existing
count-bounded surfaces (`--max-refs`, `--limit`), not a new packet format.

Likely files: `src/impact/types.ts`, `src/impact/collect.ts`, `src/impact/analyzer.ts`,
`src/impact/direct.ts`, `src/impact/callCompatibility.ts`, `src/review.ts`,
`src/review/types.ts`, `src/cli/review.ts`, `src/mcp/server.ts`, `src/presentation/bounds.ts`,
`tests/impact-analyzer.test.ts`, `tests/review.test.ts`, `tests/mcp-server.test.ts`.

Acceptance:

- A synthetic 1,000-symbol diff starts no more than the configured reference lookup count.
- The same input and limits produce the same selected symbols and omissions across repeated
  runs.
- Deadline exhaustion returns partial evidence with exact omitted counts rather than throwing
  or returning an empty success.
- `--duplicates off` records zero duplicate-analysis time and creates no duplicate tasks.
- `codegraph impact --provider git --base main --head HEAD --pretty` completes in well under
  30s cold and 10s warm on the Gunship baseline (down from 291.27s), and
  `codegraph review --summary --review-depth minimal --duplicates off` completes in well under
  15s cold and 5s warm (down from ~53s).

## Priority 2: Fix candidate-test ranking and persist C/C++ resolution hints

- [x] Add `changedTest` and `symbolReference` candidate reasons.
- [x] Always include changed test files as high-confidence focused-test inputs.
- [x] Rank a test high when a proven symbol or file edge reaches a changed contract, and medium
      when a bounded co-location/name heuristic matches.
- [x] Keep pattern-only matches low confidence and expose why higher-confidence linkage was
      unavailable.
- [x] Extend `codegraph.config.json` with `graph.resolutionHints: string[]`; merge config
      values with explicit build options and CLI/MCP overrides using the existing
      `normalizeResolutionHints()` path.
- [x] Include normalized resolution hints in manifest and snapshot identity exactly as current
      graph options do.
- [x] Add a Gunship-shaped C++ fixture where `Private/Damage/Tests/DamageModelTests.cpp`
      includes `"Damage/Simulation/GunshipDamageModel.h"` and a configured
      `Source/Gunship/Private` hint resolves it.

Likely files: `src/review/candidates.ts`, `src/impact/context.ts`, `src/impact/testPatterns.ts`,
`src/config.ts`, `src/agent/session.ts`, `src/cli.ts`, `src/indexer/build-cache/options.ts`,
`tests/review.test.ts`, `tests/config.test.ts`, `tests/languages/cpp.test.ts`,
`tests/goto.test.ts`, `tests/references.test.ts`, `tests/native-semantic-parity.test.ts`.

Acceptance:

- Gunship's changed `DamageModelTests.cpp` is high confidence because it changed.
- With `graph.resolutionHints`, the test-to-model edge resolves and an unchanged test can be
  selected from a changed model.
- Invalid or escaping hints fail root confinement or remain unresolved; they never create
  off-root graph edges.

## Priority 3: Documentation

Update docs to describe `impact --provider git --pretty` and `review --summary` as the
intended fast, bounded entry points for external orchestrators (ODW-style tools) to call as
an accelerant — not as a definition of any review workflow, packet, or protocol codegraph owns.

Required updates per repository policy:

- `docs/cli.md`: new budget flags, corrected MCP `impact` behavior.
- `docs/library-api.md`: new `ImpactOptions`/review options fields.
- `docs/mcp.md`: real impact semantics.
- `docs/how-it-works.md`: bounds and partial-result behavior.
- `codegraph-skill/codegraph/SKILL.md`: note that `impact`/`review` are safe to call as a
  bounded accelerant from another agent's own review workflow.
- `docs/language-parity.md` and `docs/scenario-catalog.md`: configured C/C++ resolution hints.

## Implementation order

1. Priority 0: correctness and MCP semantic repairs.
2. Priority 1: hard computation and payload bounds.
3. Priority 2: candidate-test and C++ resolution improvements.
4. Priority 3: documentation, after behavior is proven.

## Validation checklist

### Focused automated checks

- [x] `npx vitest run tests/review.test.ts tests/impact-analyzer.test.ts tests/mcp-server.test.ts`
- [x] `npx vitest run tests/config.test.ts tests/git-diff-semantics.test.ts`
- [x] `npx vitest run tests/languages/cpp.test.ts tests/goto.test.ts tests/references.test.ts tests/native-semantic-parity.test.ts`
- [x] CLI regression coverage for every new flag and incompatible combination.

### Gunship acceptance scenario

Run from the current Gunship branch with the built CLI from this checkout:

- [x] Cold and warm `impact --provider git --base main --head HEAD --pretty` complete well
      under 30s/10s (from 291.27s).
- [x] Cold and warm `review --summary --review-depth minimal --duplicates off` complete well
      under 15s/5s (from ~53s).
- [x] Build scripts and `justfile` are `updated`, not `deleted`.
- [x] MCP `impact` returns real impacted items, distinct from MCP `review` output.
- [x] Configured `Source/Gunship/Private` resolution links `DamageModelTests.cpp` to
      `GunshipDamageModel.h`, raising it out of pattern-only confidence.
- [x] A bounded impact request completes inside the configured budget and reports skipped
      changed symbols instead of timing out.

### Repository qualification

- [x] `node ./dist/cli.js doctor`
- [x] `npm run check`

## Success criteria

`codegraph impact --provider git --pretty` and `codegraph review --summary` are fast, correct,
and bounded enough that an external review orchestrator (`review-until-clean-odw` or similar)
can call them as a one-line accelerant exactly as already designed, without codegraph taking on
any reviewer-grouping, packet, or ledger responsibility that belongs to that orchestrator.
