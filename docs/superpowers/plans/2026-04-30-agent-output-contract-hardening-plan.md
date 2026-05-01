# Agent Output Contract Hardening Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Codegraph outputs intended for agents so they are more structured, lower-ambiguity, more provenance-aware, and better optimized for accurate follow-up reasoning.

**Problem Statement:** Current agent-facing surfaces are useful but not optimal. Some outputs remain prose-first instead of schema-first, some navigation/reference results omit confidence or provenance, graph outputs are too raw for bounded agent consumption, and impact payloads are not versioned like review payloads.

**Architecture:** Preserve existing public CLI and library behavior while strengthening agent-facing contracts behind stable wrappers. Prefer additive schema evolution over breaking changes, and keep human-readable output as an optional rendered layer on top of structured data instead of the primary contract.

**Tech Stack:** TypeScript, Vitest, existing CLI/library facade, bundled Codex skill contract

---

## Objectives

- Make agent tool outputs schema-first and machine-optimized.
- Preserve existing human-facing convenience where it still adds value.
- Add provenance, confidence, and backend/fallback signals where resolution is not exact.
- Introduce explicit schema versioning for agent-consumed payloads.
- Keep outputs bounded and ranked so models spend tokens on the highest-signal data first.

## Non-Goals

- Rewriting the core index/navigation/impact algorithms.
- Expanding supported language semantics in this plan.
- Replacing the human CLI with agent-only commands.

## Current Gaps

- `tool_getFileOverview()` returns markdown prose instead of structured sections.
- `tool_findSymbol()` omits stable handles, full ranges, exported status, and exact-match metadata.
- `tool_getGraph()` returns a broad raw graph instead of bounded/ranked graph slices.
- `tool_goToDefinition()` and `tool_findReferences()` do not expose confidence/provenance/backends in a first-class way.
- `ImpactReport` and `CompactImpactReport` are not schema-versioned like `ReviewReport`.
- The bundled skill still nudges agents toward prose-first workflows instead of structured-first workflows.

---

## File Structure

**Create:**

- `docs/superpowers/plans/2026-04-30-agent-output-contract-hardening-plan.md`

**Likely Modify During Implementation:**

- `src/agent-tools.ts`
- `src/impact/types.ts`
- `src/review.ts` only if report-shape conventions need alignment
- `src/cli.ts` only if new structured agent-focused commands or JSON modes are added
- `src/indexer/types.ts`
- `src/indexer/navigation.ts` only if navigation provenance must be surfaced from the core result
- `codegraph-skill/codegraph/SKILL.md`
- `docs/agent-workflows.md`
- `docs/cli.md`
- `docs/library-api.md`

**Tests To Add Or Update:**

- `tests/agent-tools.test.ts`
- `tests/cli-regressions.test.ts`
- `tests/review.test.ts`
- `tests/impact-options-and-explain.test.ts`
- `tests/impact-context.test.ts`
- `tests/handles.test.ts`
- `tests/opencode-plugin.test.ts` if plugin output contracts change

---

## Contract Design Rules

- Every agent-facing result must have an explicit status discriminant.
- Structured data must come first; human-readable summaries should be derived, optional fields.
- Paths returned to agents should remain normalized and repo-relative when possible.
- Results that rely on heuristic, fallback, or backend-sensitive behavior should surface provenance.
- Schema expansions should be additive unless a migration path is explicitly planned.
- Versioned payloads must include `schemaVersion`.
- Avoid forcing the model to re-parse markdown blobs when structured arrays or objects can carry the same information.

---

## Task 1: Lock The Existing Agent Contract Baseline

**Files:**

- Modify: `tests/agent-tools.test.ts`
- Modify: `tests/cli-regressions.test.ts`
- Modify: `tests/review.test.ts`
- Modify: `tests/impact-options-and-explain.test.ts`

- [ ] **Step 1: Inventory current agent-facing shapes**

Capture the exact returned shape for:

```text
tool_getFileOverview
tool_findSymbol
tool_getGraph
tool_goToDefinition
tool_findReferences
ReviewReport
ImpactReport
CompactImpactReport
```

- [ ] **Step 2: Add characterization assertions before changing production code**

Rules:

```text
Lock current status discriminants and existing required fields first.
Do not overfit to incidental formatting.
Prefer assertions on field presence, types, normalization, and key semantics.
```

- [ ] **Step 3: Verify the characterization layer**

Run:

```powershell
npm run test:ci -- tests/agent-tools.test.ts tests/cli-regressions.test.ts tests/review.test.ts tests/impact-options-and-explain.test.ts
```

Expected: current behavior is captured cleanly before any contract changes.

- [ ] **Step 4: Commit the baseline**

```powershell
git add tests/agent-tools.test.ts tests/cli-regressions.test.ts tests/review.test.ts tests/impact-options-and-explain.test.ts
git commit -m "test: lock agent output baselines"
```

## Task 2: Make File Overview Structured-First

**Files:**

- Modify: `src/agent-tools.ts`
- Modify: `tests/agent-tools.test.ts`
- Modify: `docs/library-api.md` if exported wrapper behavior changes

- [ ] **Step 1: Replace prose-only overview shape with structured sections**

Target shape:

```ts
type ToolFileOverviewResult =
  | {
      status: "ok";
      file: string;
      hasSymbols: boolean;
      overview: {
        imports: Array<{ name: string }>;
        definitions: Array<{
          id?: string;
          name: string;
          kind: string;
          line?: number;
          exported?: boolean;
          docstring?: string;
        }>;
        summary?: string;
      };
      renderedOverview?: string;
    }
  | ...
```

Rules:

```text
Keep a rendered markdown summary only as a convenience field.
Do not require agents to parse markdown to access imports/definitions.
```

- [ ] **Step 2: Update tests for structured overview semantics**

Assert:

```text
imports and definitions are directly accessible
renderedOverview is optional convenience output
empty files remain explicitly distinguishable
```

- [ ] **Step 3: Verify**

Run:

```powershell
npm run test:ci -- tests/agent-tools.test.ts
```

- [ ] **Step 4: Commit**

```powershell
git add src/agent-tools.ts tests/agent-tools.test.ts docs/library-api.md
git commit -m "feat: structure file overview output"
```

## Task 3: Strengthen Symbol Search Results

**Files:**

- Modify: `src/agent-tools.ts`
- Modify: `tests/agent-tools.test.ts`
- Modify: `tests/handles.test.ts`

- [ ] **Step 1: Expand `tool_findSymbol()` results**

Add:

```text
stable handle/id
full normalized file path
full range
exported boolean
exactMatch boolean
matchKind or score
```

Recommended result shape:

```ts
matches?: Array<{
  id: string;
  name: string;
  kind: string;
  file: string;
  range?: Range;
  line: number;
  exported?: boolean;
  exactMatch: boolean;
}>
```

- [ ] **Step 2: Keep sorting explicit and deterministic**

Rules:

```text
Exact match before substring match.
Then stable ordering by name, file, range.
```

- [ ] **Step 3: Verify**

Run:

```powershell
npm run test:ci -- tests/agent-tools.test.ts tests/handles.test.ts
```

- [ ] **Step 4: Commit**

```powershell
git add src/agent-tools.ts tests/agent-tools.test.ts tests/handles.test.ts
git commit -m "feat: enrich symbol search output"
```

## Task 4: Add Provenance To Navigation And Reference Results

**Files:**

- Modify: `src/indexer/types.ts`
- Modify: `src/indexer/navigation.ts`
- Modify: `src/agent-tools.ts`
- Modify: `tests/goto.test.ts`
- Modify: `tests/references.test.ts`
- Modify: `tests/agent-tools.test.ts`
- Modify: `tests/native-semantic-parity.test.ts`

- [ ] **Step 1: Define additive provenance fields**

Candidate fields:

```ts
provenance?: {
  backend?: "native" | "js-fallback" | "graph-only" | "heuristic";
  resolution?: "exact" | "reexport" | "namespace" | "import-fallback" | "php-qualified" | "sibling-package";
  confidence?: "high" | "medium" | "low";
}
```

Rules:

```text
Only add confidence where there is real ambiguity or fallback behavior.
Do not fabricate low-confidence on exact local bindings.
```

- [ ] **Step 2: Thread provenance through tool wrappers**

Rules:

```text
Keep existing top-level fields stable.
Add provenance additively.
Normalize any file-bearing provenance fields.
```

- [ ] **Step 3: Verify navigation/reference behavior remains identical while metadata improves**

Run:

```powershell
npm run test:ci -- tests/goto.test.ts tests/references.test.ts tests/agent-tools.test.ts tests/native-semantic-parity.test.ts
```

- [ ] **Step 4: Commit**

```powershell
git add src/indexer/types.ts src/indexer/navigation.ts src/agent-tools.ts tests/goto.test.ts tests/references.test.ts tests/agent-tools.test.ts tests/native-semantic-parity.test.ts
git commit -m "feat: add navigation provenance metadata"
```

## Task 5: Version Impact Payloads And Distinguish Shapes Explicitly

**Files:**

- Modify: `src/impact/types.ts`
- Modify: `src/agent-tools.ts`
- Modify: `src/cli.ts`
- Modify: `tests/impact-options-and-explain.test.ts`
- Modify: `tests/cli-regressions.test.ts`
- Modify: `tests/opencode-plugin.test.ts` if needed
- Modify: `docs/cli.md`
- Modify: `docs/library-api.md`

- [ ] **Step 1: Add explicit schema versioning**

Recommended:

```ts
type ImpactReport = {
  schemaVersion: number;
  format: "full";
  ...
}

type CompactImpactReport = {
  schemaVersion: number;
  format: "compact";
  ...
}
```

- [ ] **Step 2: Keep compact/full payload discrimination first-class**

Rules:

```text
Do not require downstream agents to infer compact-vs-full by missing fields.
Add an explicit format discriminator.
```

- [ ] **Step 3: Verify CLI and wrappers preserve current semantics**

Run:

```powershell
npm run test:ci -- tests/impact-options-and-explain.test.ts tests/cli-regressions.test.ts tests/opencode-plugin.test.ts
```

- [ ] **Step 4: Commit**

```powershell
git add src/impact/types.ts src/agent-tools.ts src/cli.ts tests/impact-options-and-explain.test.ts tests/cli-regressions.test.ts tests/opencode-plugin.test.ts docs/cli.md docs/library-api.md
git commit -m "feat: version impact payloads"
```

## Task 6: Add Bounded Agent Graph Queries

**Files:**

- Modify: `src/agent-tools.ts`
- Modify: `tests/agent-tools.test.ts`
- Modify: `docs/library-api.md`
- Modify: `codegraph-skill/codegraph/SKILL.md`
- Modify: `docs/agent-workflows.md`

- [ ] **Step 1: Add agent-oriented bounded graph helpers instead of relying on raw full graphs**

Candidate additions:

```text
tool_getDependencies(root, file, { depth, limit })
tool_getReverseDependencies(root, file, { depth, limit })
tool_getHotspots(root, { limit, includeRoots })
```

Rules:

```text
Prefer ranked, bounded outputs over full graph dumps.
Return concise structured lists with rationale fields where helpful.
```

- [ ] **Step 2: Keep `tool_getGraph()` but reposition it as lower-level**

Update docs/skill guidance so agents default to bounded queries first.

- [ ] **Step 3: Verify**

Run:

```powershell
npm run test:ci -- tests/agent-tools.test.ts tests/cli-regressions.test.ts
```

- [ ] **Step 4: Commit**

```powershell
git add src/agent-tools.ts tests/agent-tools.test.ts docs/library-api.md codegraph-skill/codegraph/SKILL.md docs/agent-workflows.md
git commit -m "feat: add bounded agent graph queries"
```

## Task 7: Rewrite Agent Guidance Around Structured-First Usage

**Files:**

- Modify: `codegraph-skill/codegraph/SKILL.md`
- Modify: `docs/agent-workflows.md`
- Modify: `docs/cli.md` if command/JSON guidance changed

- [ ] **Step 1: Update the recommended agent workflow**

New guidance should prefer:

```text
doctor
inspect or bounded graph query
JSON/structured output for follow-up reasoning
navigation/reference tools with provenance
impact/review payloads with schemaVersion awareness
```

- [ ] **Step 2: Remove prose-first ambiguity**

Rules:

```text
Do not bury machine-readable guidance behind generic human CLI examples.
Make the agent workflow explicitly structured-first.
```

- [ ] **Step 3: Verify docs stay aligned with actual command/tool surface**

Run:

```powershell
npm run test:ci -- tests/cli-regressions.test.ts tests/package-metadata.test.ts
```

- [ ] **Step 4: Commit**

```powershell
git add codegraph-skill/codegraph/SKILL.md docs/agent-workflows.md docs/cli.md
git commit -m "docs: prefer structured agent workflows"
```

---

## Final Verification

- [ ] **Step 1: Run the full repo gates**

```powershell
npm run format
npm run lint
npm run build
npm run test:ci
```

Expected: all green.

- [ ] **Step 2: Sanity-check the highest-value contracts manually**

Inspect:

```text
tool_getFileOverview shape
tool_findSymbol shape
tool_goToDefinition provenance
tool_findReferences provenance
ImpactReport / CompactImpactReport versioning
skill guidance for structured-first usage
```

- [ ] **Step 3: Final commit if needed**

```powershell
git status --short
git add ...
git commit -m "chore: finalize agent output contract hardening"
```

---

## Acceptance Criteria

- Agent-facing tool results are structured-first, not prose-first.
- Symbol search returns stable handles and richer metadata.
- Navigation/reference outputs surface provenance where ambiguity exists.
- Impact payloads are explicitly versioned and shape-discriminated.
- Agent workflow docs prefer bounded, machine-readable outputs.
- Full repo verification passes without behavior regressions.

## Suggested Branch

Use a dedicated implementation branch after this plan lands:

```text
codex/agent-output-contract-hardening
```
