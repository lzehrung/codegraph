# Drift Enhancements Plan

**Goal:** Improve `codegraph drift` signal-to-noise and CI usefulness for real review workflows without widening the core snapshot model more than necessary.

**Status:** Planning only. This document is the implementation checklist for the next drift enhancement batch.

## Why this batch exists

The first drift implementation works, but real branch usage exposed three practical problems:

- `graph-edge-added` and `graph-edge-removed` findings are too verbose for normal review output.
- Duplicate drift is measurable but not very actionable yet.
- JSON and pretty output do not clearly separate human review, CI gating, and machine-consumption use cases.

The improvements below focus on the highest-value workflow: compare a branch against `main`, surface only meaningful architectural changes, and make CI gating predictable.

## Scope decisions after plan review

Included in this batch:

- Graph-edge noise controls.
- Richer duplicate drift summaries.
- Logical ref reporting instead of temp checkout roots.
- Public API severity controls.
- Compact drift output mode for CI and agents.

Explicitly deferred from this batch:

- Hotspot rank movement and fan-in/fan-out delta reporting.
  - Useful, but not currently the biggest source of review noise.
- Full artifact parity for unresolved/API/duplicate signals.
  - Higher cost than this batch and needs a separate artifact-schema decision.
- New persistence formats or storage changes.
  - This batch should remain stateless and derivable from current snapshots.

## Design constraints

- Keep `ArchitectureDriftReport` deterministic for identical inputs.
- Preserve existing finding kinds; add fields and modes rather than replacing the contract.
- Do not make CI output depend on pretty rendering.
- Keep policy evaluation independent from display truncation.
- Prefer bounded summaries over dumping many raw findings.
- Avoid adding new expensive repo-wide passes when existing snapshot data is sufficient.

## Proposed product changes

### 1) Graph-edge noise controls

Add a drift option to control graph-edge findings in reports:

- `graphEdges: "full" | "summary" | "off"`
- Default: `"summary"` for pretty and compact output, `"full"` for full JSON

Behavior:

- `full`: keep per-edge findings as today.
- `summary`: omit per-edge findings and instead emit bounded summary entries with counts by changed file.
- `off`: suppress graph-edge findings entirely.

Why:

- Graph-edge churn is structurally correct but often overwhelms more important findings.
- Summary mode preserves architectural signal while making reviews readable.

### 2) Richer duplicate drift reporting

Extend duplicate drift beyond total group count:

- Keep total group delta.
- Add bounded stable top-group diff details:
  - `newTopGroupKeys`
  - `resolvedTopGroupKeys`
- Pretty output should show a small number of representative new/resolved keys.

Why:

- Reviewers need to know whether duplicate growth is concentrated in meaningful new groups or just count churn.

### 3) Logical ref reporting

Change report metadata so git-mode reports logical refs instead of temp checkout paths.

Proposed shape refinement:

- Keep `root` as the real project root.
- Add logical source fields:
  - `base.ref`
  - `head.ref`
- Keep temp materialization roots internal, not public contract data.

Why:

- Current temp paths are implementation details and make machine output noisier than necessary.

### 4) Public API severity controls

Add public API filtering/severity policy controls:

- `publicApi: "all" | "removals" | "off"`
- Default behavior:
  - removals remain high-signal
  - additions stay visible in full JSON, but may be suppressed from compact/pretty unless explicitly requested

Why:

- Feature branches often add many exports; surfacing all additions by default makes drift noisy.

### 5) Compact output mode

Add a bounded machine-friendly compact drift mode:

- CLI: `--compact-json`
- Library: `format?: "full" | "compact"`

Compact payload should include:

- `schemaVersion`
- `root`
- logical base/head refs when available
- counts by kind and severity
- policy result
- bounded example findings for each reported kind
- omitted counts

Why:

- CI and agent workflows usually need counts, policy state, and a few examples, not the full finding list.

## Report shape changes

These changes are intentionally additive.

### Full report additions

```ts
interface ArchitectureDriftReport {
  schemaVersion: 1;
  format?: "full" | "compact";
  root: string;
  base: ArchitectureSnapshotSummary & { ref?: string };
  head: ArchitectureSnapshotSummary & { ref?: string };
  findings: ArchitectureDriftFinding[];
  summary?: {
    byKind: Record<string, number>;
    bySeverity: Record<string, number>;
  };
  policy: {
    failed: boolean;
    failOn: ArchitectureDriftFindingKind[];
    failedKinds: ArchitectureDriftFindingKind[];
  };
  omittedCounts: {
    findings: number;
  };
}
```

### New drift options

```ts
interface ArchitectureDriftCompareOptions {
  failOn?: ArchitectureDriftFindingKind[];
  thresholds?: Partial<ArchitectureDriftThresholds>;
  graphEdges?: "full" | "summary" | "off";
  publicApi?: "all" | "removals" | "off";
  format?: "full" | "compact";
}
```

## CLI changes

Add:

```text
--graph-edges <full|summary|off>
--public-api <all|removals|off>
--compact-json
```

Rules:

- `--json` => full JSON unless `--compact-json` is passed.
- `--pretty` => human summary using summary graph-edge mode by default.
- `--compact-json` implies JSON output and compact format.
- Reject invalid enum values with usage error and valid choices.

## Implementation checklist

### Task 1: Finalize refined contract

- [x] Update the plan if implementation reveals a smaller, cleaner contract.
- [x] Add option/type tests first for new compare options and output format metadata.
- [x] Keep all new fields additive and backwards-compatible.

### Task 2: Add failing tests for graph-edge controls

- [x] Add unit tests for `graphEdges: "full" | "summary" | "off"`.
- [x] Add CLI tests for `--graph-edges summary` and `--graph-edges off`.
- [x] Assert summary mode reduces per-edge output while preserving counts.

### Task 3: Implement graph-edge controls

- [x] Add compare/report support for graph-edge summary suppression.
- [x] Add compact summary entries grouped by source file.
- [x] Keep full JSON behavior unchanged unless caller requests summary/off.

### Task 4: Add failing tests for duplicate drift details

- [x] Add unit tests that verify top-group diff details are reported deterministically.
- [x] Add pretty/compact output tests for bounded duplicate examples.

### Task 5: Implement richer duplicate drift reporting

- [x] Extend duplicate findings/details with bounded stable top-group diffs.
- [x] Keep total duplicate delta as the primary policy signal.
- [x] Bound output carefully to avoid dumping large duplicate key lists.

### Task 6: Add failing tests for logical ref reporting

- [x] Add git-mode tests asserting `base.ref` and `head.ref` use logical refs, not temp paths.
- [x] Add artifact-mode tests asserting artifact baselines report artifact identity sensibly.

### Task 7: Implement logical ref reporting

- [x] Store logical base/head identifiers in reports.
- [x] Remove temp checkout paths from the public drift contract.
- [x] Keep actual project root stable across modes.

### Task 8: Add failing tests for public API controls

- [x] Add unit tests for `publicApi: "all" | "removals" | "off"`.
- [x] Add CLI tests for `--public-api removals` and `--public-api off`.
- [x] Verify removals still participate in fail-on policy when enabled.

### Task 9: Implement public API controls

- [x] Filter or suppress API-addition findings according to mode.
- [x] Preserve full data for callers that explicitly request `all`.

### Task 10: Add failing tests for compact output

- [x] Add unit tests for `format: "compact"`.
- [x] Add CLI regression tests for `--compact-json`.
- [x] Verify compact output includes counts, policy state, omitted counts, and bounded examples.

### Task 11: Implement compact output mode

- [x] Add compact formatter/builder without weakening the full report.
- [x] Reuse one comparison pipeline; derive compact output from full findings rather than re-running analysis.

### Task 12: Update docs and skill

- [x] Update `README.md` examples if default review recommendations change.
- [x] Update `docs/cli.md` for new drift flags and compact mode.
- [x] Update `docs/library-api.md` for new compare options and logical ref metadata.
- [x] Update `docs/agent-workflows.md` and `codegraph-skill/codegraph/SKILL.md` for CI/review usage.

### Task 13: Final verification

- [x] Run targeted drift tests first.
- [x] Run CLI drift regressions.
- [x] Run `npm run lint`.
- [x] Run `npm run build`.
- [x] Run `npm run test:ci`.
- [x] Run `git diff --check`.

## Plan review notes

This plan was pruned and refined before implementation:

- Dropped hotspot rank movement from this batch because it adds complexity without solving the main noise problem.
- Dropped artifact-signal parity expansion because it likely needs new artifact data, which is a separate design track.
- Chose additive contract changes to avoid destabilizing the just-shipped drift API.
- Chose summary controls over new raw finding kinds where the use case is presentation, not deeper semantic analysis.
