# Architecture Drift Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `codegraph drift` command and library API that compare two repository graph states and report architecture health changes over time.

**Architecture:** Reuse existing graph, inspect, apisurface, cycles, unresolved, duplicate, artifact, and review primitives to build comparable snapshots. Start descriptive with stable JSON and pretty output, then add simple `--fail-on` gates for obvious CI checks.

**Tech Stack:** TypeScript, Vitest, existing Git provider helpers, graph/index builders, duplicate detection, public API surface reporting, CLI command modules.

---

## Context

Codegraph already answers point-in-time questions: inspect, cycles, unresolved imports, hotspots, duplicates, apisurface, review, and impact. Drift check turns those into a baseline-vs-head comparison that can run in CI and review workflows.

Important current files:

- `src/cli.ts`: top-level command dispatch.
- `src/cli/help.ts`: command help text.
- `src/cli/inspect.ts`, `src/cli/graphDelta.ts`, `src/cli/impact.ts`: nearest CLI command patterns.
- `src/graphs/*`: dependency graph and external classification.
- `src/duplicates/*` and `src/cli/duplicates.ts`: duplicate detection and presentation.
- `src/impact/*`, `src/review.ts`: existing git diff and graph delta machinery.
- `src/apiSurface.ts` or nearest apisurface implementation file found by `rg "apisurface|api surface" src`.
- `src/index.ts`: public API exports.
- `tests/cli-regressions.test.ts`, `tests/impact-git-provider.test.ts`, `tests/review.test.ts`, `tests/duplicates.test.ts`: nearby test patterns.
- `docs/cli.md`, `docs/library-api.md`, `docs/agent-workflows.md`, `README.md`, `codegraph-skill/codegraph/SKILL.md`: docs to update because this adds a CLI command and API surface.

Current repo facts worth preserving:

- `inspect ./src` reports one existing review cycle. Drift should distinguish pre-existing cycles from new cycles.
- `unresolved` can legitimately be zero and should be compared by stable import/file identity.
- Duplicate output has grouped JSON with omission counts. Drift should compare counts and top stable group keys, not assume group ordering is permanent.

## Agentic Coding Use Case

Drift should be the architecture-regression primitive for agents. Instead of asking an agent to manually compare `inspect`, `cycles`, `unresolved`, `apisurface`, `duplicates`, and `graph-delta` outputs, this command should produce one deterministic report that says what got structurally worse and what got better.

High-value agent outputs:

- Review focus: new cycles, public API removals, unresolved imports, hotspot jumps, duplicate increases, and graph-edge changes.
- CI policy: `--fail-on` gates for selected finding kinds while leaving informational findings in JSON.
- Fix planning: stable file/symbol/chunk handles for each finding so a follow-up `packet get` can retrieve bounded evidence.
- Human handoff: short pretty output grouped by severity and kind.

This should not become runtime validation, compiler diagnostics, or a style linter. It compares repository structure over time.

## Deliverable

Add:

```bash
codegraph drift --base origin/main --head HEAD --pretty
codegraph drift --base HEAD --head WORKTREE --json
codegraph drift --base-artifact ./baseline/codegraph-out --head . --json
codegraph drift --base origin/main --head HEAD --fail-on new-cycle,unresolved-import,public-api-removal
```

Add library API:

```ts
export async function analyzeArchitectureDrift(
  root: string,
  options: ArchitectureDriftOptions,
): Promise<ArchitectureDriftReport>;
```

Initial signal set:

- new and resolved source dependency cycles.
- hotspot score increases and decreases.
- new and resolved unresolved imports.
- public API additions and removals.
- duplicate group count deltas.
- graph edge additions/removals from review graph delta when git refs are supplied.

## Report Shape

```ts
export interface ArchitectureDriftReport {
  schemaVersion: 1;
  root: string;
  base: ArchitectureSnapshotSummary;
  head: ArchitectureSnapshotSummary;
  findings: ArchitectureDriftFinding[];
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

Finding kinds:

```ts
export type ArchitectureDriftFindingKind =
  | "new-cycle"
  | "resolved-cycle"
  | "hotspot-jump"
  | "hotspot-drop"
  | "unresolved-import"
  | "resolved-unresolved-import"
  | "public-api-addition"
  | "public-api-removal"
  | "duplicate-increase"
  | "duplicate-decrease"
  | "graph-edge-added"
  | "graph-edge-removed";
```

## Acceptance Criteria

- Drift can compare two git refs without dirtying the worktree.
- Drift can compare a manifest-backed artifact directory to the current checkout.
- JSON output is deterministic for the same inputs.
- Pretty output is short and grouped by severity/kind.
- `--fail-on` exits with code `1` only when a selected finding kind is present.
- Existing inspect, impact, review, duplicate, and graph commands are unchanged.
- No persistent storage schema changes are required.
- No `any`, no `as unknown as`, no nested ternaries, no boolean `=== true` or `=== false`.

## Task 1: Add Drift Types and Snapshot Builder

**Files:**

- Create: `src/drift/types.ts`
- Create: `src/drift/snapshot.ts`
- Create: `src/drift/index.ts`
- Modify: `src/index.ts`
- Test: `tests/drift.test.ts`

- [ ] **Step 1: Write failing snapshot tests**

```ts
import { buildArchitectureSnapshot } from "../src/drift/index.js";
import { mkTmpDir, writeFile } from "./helpers/files.js";

it("builds a deterministic architecture snapshot", async () => {
  const root = await mkTmpDir("cg-drift-snapshot-");
  await writeFile(root, "src/a.ts", "import { b } from './b'; export function a() { return b(); }\n");
  await writeFile(root, "src/b.ts", "export function b() { return 1; }\n");

  const snapshot = await buildArchitectureSnapshot(root, { includeRoots: ["src"] });

  expect(snapshot.files.total).toBe(2);
  expect(snapshot.unresolved.total).toBe(0);
  expect(snapshot.hotspots.length).toBeGreaterThan(0);
  expect(snapshot.cycles).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx vitest run tests/drift.test.ts
```

Expected: FAIL because drift files do not exist.

- [ ] **Step 3: Implement snapshot types**

Define snapshot data that is intentionally smaller than full graph JSON:

```ts
export interface ArchitectureSnapshot {
  root: string;
  files: { total: number; byLanguage: Record<string, number> };
  hotspots: ArchitectureHotspot[];
  cycles: ArchitectureCycle[];
  unresolved: ArchitectureUnresolvedImport[];
  publicApi: ArchitecturePublicApiSymbol[];
  duplicates: ArchitectureDuplicateSummary;
}
```

Use existing project index, graph, cycles, unresolved, API surface, and duplicate helpers. If a helper is CLI-only, extract a library helper first instead of parsing CLI text.

- [ ] **Step 4: Export the API**

In `src/drift/index.ts`, export snapshot and later analyzer functions. In `src/index.ts`, export from `./drift/index.js`.

- [ ] **Step 5: Run focused test**

Run:

```bash
npx vitest run tests/drift.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/drift/types.ts src/drift/snapshot.ts src/drift/index.ts src/index.ts tests/drift.test.ts
git commit -m "Add architecture drift snapshots"
```

## Task 2: Compare Snapshots

**Files:**

- Create: `src/drift/compare.ts`
- Modify: `src/drift/index.ts`
- Test: `tests/drift.test.ts`

- [ ] **Step 1: Add failing comparison tests**

```ts
import { compareArchitectureSnapshots } from "../src/drift/index.js";

it("reports new cycles without reporting pre-existing cycles", () => {
  const base = makeSnapshot({ cycles: [] });
  const head = makeSnapshot({
    cycles: [{ key: "src/a.ts->src/b.ts", files: ["src/a.ts", "src/b.ts"], priorityScore: 20, size: 2 }],
  });

  const report = compareArchitectureSnapshots(base, head, { failOn: [] });

  expect(report.findings).toContainEqual(expect.objectContaining({ kind: "new-cycle", severity: "error" }));
});

it("reports public API removals", () => {
  const base = makeSnapshot({ publicApi: [{ id: "src/api.ts#oldName", file: "src/api.ts", name: "oldName" }] });
  const head = makeSnapshot({ publicApi: [] });

  const report = compareArchitectureSnapshots(base, head, { failOn: [] });

  expect(report.findings).toContainEqual(expect.objectContaining({ kind: "public-api-removal", severity: "error" }));
});
```

Define a local `makeSnapshot()` helper in the test with complete default fields so the test remains readable.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx vitest run tests/drift.test.ts
```

Expected: FAIL because comparison is missing.

- [ ] **Step 3: Implement comparison**

Comparison keys:

- cycles: sorted normalized file list joined with `->`.
- unresolved imports: `file + specifier`.
- public API: `file + name + kind`.
- hotspots: `file`; report jump/drop when absolute score delta is at least the threshold.
- duplicates: compare `groups.total` or summary total only for v1.
- graph edges: compare `from + label + to` when graph delta data is available.

Default thresholds:

```ts
export const DEFAULT_DRIFT_THRESHOLDS = {
  hotspotJump: 20,
  maxFindings: 100,
} as const;
```

- [ ] **Step 4: Run tests**

Run:

```bash
npx vitest run tests/drift.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/drift/compare.ts src/drift/index.ts tests/drift.test.ts
git commit -m "Compare architecture drift snapshots"
```

## Task 3: Support Git Ref Comparisons

**Files:**

- Create: `src/drift/git.ts`
- Modify: `src/drift/index.ts`
- Test: `tests/drift-git-provider.test.ts`

- [ ] **Step 1: Add failing git fixture test**

Use the existing git fixture style from `tests/impact-git-provider.test.ts`.

Scenario:

- Commit base with `src/a.ts` importing `src/b.ts`.
- Commit head with `src/b.ts` importing `src/a.ts`.
- Run `analyzeArchitectureDrift(root, { provider: "git", base: "HEAD~1", head: "HEAD" })`.
- Assert a `new-cycle` finding exists.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx vitest run tests/drift-git-provider.test.ts
```

Expected: FAIL because git drift is missing.

- [ ] **Step 3: Implement git comparison**

Implementation constraints:

- Reuse existing git worktree/index helpers from impact/review where possible.
- Do not mutate the user's worktree.
- If temporary checkouts are required, create them under `os.tmpdir()` and remove them in `finally`.
- Respect `--root` and include roots.
- Handle `WORKTREE` and `STAGED` only if existing repo helpers already provide that sentinel safely. If not, document v1 as real git refs only plus current checkout.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx vitest run tests/drift.test.ts tests/drift-git-provider.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/drift/git.ts src/drift/index.ts tests/drift-git-provider.test.ts
git commit -m "Compare architecture drift across git refs"
```

## Task 4: Add Artifact Baseline Support

**Files:**

- Create: `src/drift/artifact.ts`
- Modify: `src/drift/index.ts`
- Test: `tests/drift-artifact.test.ts`

- [ ] **Step 1: Add failing artifact test**

Build an artifact with `buildCodegraphArtifact()` or the existing artifact test helper. Compare that artifact to a modified current checkout.

Assert:

- manifest-backed directories are accepted.
- missing required artifact files produce a clear error.
- unrelated files in the artifact directory are ignored.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx vitest run tests/drift-artifact.test.ts
```

Expected: FAIL because artifact baseline loading is missing.

- [ ] **Step 3: Implement artifact loader**

Rules:

- Accept only manifest-backed Codegraph artifact directories.
- Prefer `graph.json` plus report metadata when present.
- If a full drift snapshot is not present in old artifacts, derive the v1 snapshot from graph JSON and available files.
- Do not read arbitrary paths from the artifact manifest without root confinement checks already used by artifact/MCP code.

- [ ] **Step 4: Run tests**

Run:

```bash
npx vitest run tests/drift-artifact.test.ts tests/artifact-build.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/drift/artifact.ts src/drift/index.ts tests/drift-artifact.test.ts
git commit -m "Load drift baselines from artifacts"
```

## Task 5: Add CLI Command

**Files:**

- Create: `src/cli/drift.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli/help.ts`
- Test: `tests/cli-command-modules.test.ts`
- Test: `tests/cli-regressions.test.ts`

- [ ] **Step 1: Add failing CLI tests**

Assert:

- `codegraph drift --help` prints usage.
- `codegraph drift --base HEAD~1 --head HEAD --json` prints `schemaVersion`.
- `--fail-on new-cycle` exits `1` when a new cycle exists.
- `--fail-on public-api-removal` exits `0` when no API removal exists.

- [ ] **Step 2: Run CLI tests to verify failure**

Run:

```bash
npx vitest run tests/cli-command-modules.test.ts tests/cli-regressions.test.ts
```

Expected: FAIL because the command is not wired.

- [ ] **Step 3: Implement command**

Support flags:

```text
codegraph drift [roots...]
  --root <path>
  --base <ref>
  --head <ref>
  --base-artifact <dir>
  --json
  --pretty
  --fail-on <kind[,kind...]>
  --hotspot-jump-threshold <number>
  --limit <number>
```

Validation:

- Require either `--base` or `--base-artifact`.
- Default `--head` to current checkout when `--base-artifact` is used.
- Reject unknown `--fail-on` values with a non-zero exit and a list of valid kinds.

- [ ] **Step 4: Run focused CLI tests**

Run:

```bash
npx vitest run tests/cli-command-modules.test.ts tests/cli-regressions.test.ts tests/drift.test.ts tests/drift-git-provider.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/drift.ts src/cli.ts src/cli/help.ts tests/cli-command-modules.test.ts tests/cli-regressions.test.ts
git commit -m "Add architecture drift CLI"
```

## Task 6: Add Pretty Renderer

**Files:**

- Create: `src/drift/report.ts`
- Modify: `src/cli/drift.ts`
- Test: `tests/drift.test.ts`
- Test: `tests/cli-regressions.test.ts`

- [ ] **Step 1: Add failing renderer test**

Expected pretty output:

```text
Architecture drift

Errors
- new-cycle: src/a.ts -> src/b.ts
- public-api-removal: src/api.ts#oldName

Warnings
- hotspot-jump: src/core.ts score 35 -> 72
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx vitest run tests/drift.test.ts tests/cli-regressions.test.ts
```

Expected: FAIL because pretty rendering is missing.

- [ ] **Step 3: Implement renderer**

Rules:

- Group by severity, then kind.
- Bound output by `--limit`.
- Include omitted count when findings exceed the limit.
- Keep lines path-first and suitable for CI logs.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx vitest run tests/drift.test.ts tests/cli-regressions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/drift/report.ts src/cli/drift.ts tests/drift.test.ts tests/cli-regressions.test.ts
git commit -m "Render architecture drift summaries"
```

## Task 7: Update Docs and Skill

**Files:**

- Modify: `README.md`
- Modify: `docs/cli.md`
- Modify: `docs/library-api.md`
- Modify: `docs/agent-workflows.md`
- Modify: `codegraph-skill/codegraph/SKILL.md`
- Test: `tests/package-metadata.test.ts`

- [ ] **Step 1: Document command and API**

Add concise examples:

```bash
codegraph drift --base origin/main --head HEAD --pretty
codegraph drift --base-artifact ./baseline/codegraph-out --head . --json
codegraph drift --base origin/main --head HEAD --fail-on new-cycle,public-api-removal
```

Docs must explain that drift compares architecture signals, not runtime behavior or compiler diagnostics.

- [ ] **Step 2: Update skill command list**

Add `drift` to the PR/repo health command area in `codegraph-skill/codegraph/SKILL.md`.

- [ ] **Step 3: Run docs checks**

Run:

```bash
npx vitest run tests/package-metadata.test.ts
git diff --check
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/cli.md docs/library-api.md docs/agent-workflows.md codegraph-skill/codegraph/SKILL.md tests/package-metadata.test.ts
git commit -m "Document architecture drift checks"
```

## Final Verification

- [ ] Run:

```bash
npm run lint
npm run build
npm run test:ci
git diff --check
```

- [ ] Expected:

```text
lint passes
build passes
test:ci passes
git diff --check prints no errors
```
