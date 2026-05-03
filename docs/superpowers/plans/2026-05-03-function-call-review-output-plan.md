# Function Call Review Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codegraph's exported TypeScript APIs optimal for deterministic code-review agents that build their own file packs from diff, graph, symbol, impact, and test-candidate data.

**Architecture:** Keep CLI summaries as presentation-only output and improve programmatic output by enriching structured impact streaming and documenting the intended library contracts. Extract one shared impact analysis core so batch and streaming paths expose the same final extras, diagnostics, and path-normalized data without duplicating impact logic.

**Tech Stack:** TypeScript, Vitest, Node.js ESM, Codegraph impact/review APIs, Markdown docs.

---

## File Structure

- Modify `src/impact/types.ts`
  - Add exported summary types for streaming consumers.
  - Extend `ImpactStreamChunk` through imported types rather than ad hoc object shapes.
- Create `src/impact/collect.ts`
  - Own shared impact analysis collection for batch and streaming consumers.
- Modify `src/impact/index.ts`
  - Use `collectImpactAnalysis()` from `src/impact/collect.ts`.
  - Keep `analyzeImpactFromDiff()` behavior unchanged by building the same `ImpactReport | CompactImpactReport`.
- Modify `src/impact/streaming.ts`
  - Use `collectImpactAnalysis()` for the final result.
  - Continue yielding progressive chunks, then emit a final structured report summary before or as part of `complete`.
- Modify `tests/impact-streaming.test.ts`
  - Add regression coverage for the new final structured payload.
- Modify `tests/impact-streaming.test.ts`
  - Add parity coverage proving batch and streaming final summaries agree on changed files, changed symbols, impacted count, diagnostics, top impacts, surface area, clusters, and cycles when present.
- Modify `docs/library-api.md`
  - Add a "Programmatic Review Output" section focused on `buildReviewReport()`, `analyzeImpactFromDiff()`, and `analyzeImpactStreaming()`.
- Modify `docs/agent-workflows.md`
  - Update "High-level agent tools" and "Review bundles for agents" to clarify when to use exported TypeScript APIs instead of CLI output.
- Modify `docs/cli.md`
  - Clarify that `--pretty` and `--summary` are presentation modes, not the recommended source for deterministic pack builders.
- Modify `codegraph-skill/codegraph/SKILL.md`
  - Add concise guidance that skill/CLI output is for agent operators, while TypeScript consumers should use structured exports.
- Modify `README.md`
  - Keep the docs index pointing to library and agent-workflow guidance for programmatic consumers.

---

### Task 1: Add Streaming Summary Types

**Files:**
- Modify: `src/impact/types.ts`
- Test: `tests/impact-streaming.test.ts`

- [ ] **Step 1: Write the failing type/behavior test**

Add this test to `tests/impact-streaming.test.ts` near the existing completion tests:

```ts
it("streams a final structured report summary for deterministic review-pack consumers", async () => {
  const chunks = [];
  for await (const chunk of analyzeImpactStreaming(sampleRoot, index, { provider: "raw", diffText })) {
    chunks.push(chunk);
  }

  const complete = chunks.find((chunk) => chunk.type === "complete");
  expect(complete).toBeDefined();
  if (complete?.type === "complete") {
    expect(complete.report).toBeDefined();
    expect(complete.report.schemaVersion).toBe(1);
    expect(complete.report.format).toBe("stream-summary");
    expect(complete.report.changedFiles.length).toBeGreaterThan(0);
    expect(complete.report.changedSymbols.length).toBeGreaterThan(0);
    expect(complete.report.impacted.length).toBeGreaterThan(0);
    expect(complete.report.diagnostics.changedFilesTotal).toBeGreaterThan(0);
    expect(Array.isArray(complete.report.topImpacts)).toBe(true);
    expect(Array.isArray(complete.report.surfaceArea.files)).toBe(true);
    expect(Array.isArray(complete.report.clusters)).toBe(true);
  }
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npx vitest run tests/impact-streaming.test.ts --testNamePattern "streams a final structured report summary"
```

Expected: FAIL because the `complete` chunk has no `report` property.

- [ ] **Step 3: Add exported summary types**

Add these types to `src/impact/types.ts` after `ImpactDiagnostics`:

```ts
export type ImpactStreamSummaryReport = {
  schemaVersion: number;
  format: "stream-summary";
  changedFiles: ImpactReport["changedFiles"];
  changedSymbols: ChangedSymbol[];
  impacted: ImpactItem[];
  topImpacts: ImpactTopItem[];
  surfaceArea: ImpactSurfaceArea;
  clusters: ImpactCluster[];
  cycles: ImpactCycle[];
  diagnostics: ImpactDiagnostics;
  warning?: string | undefined;
};
```

Do not add rendered text. This payload is for deterministic pack builders and should stay structured.

- [ ] **Step 4: Update `ImpactStreamChunk`**

In `src/impact/streaming.ts`, import the new type:

```ts
import type { ImpactOptions, ChangedSymbol, ImpactItem, ImpactStreamSummaryReport } from "./types.js";
```

Change the complete variant:

```ts
| {
    type: "complete";
    summary: { totalChanged: number; totalImpacted: number };
    report: ImpactStreamSummaryReport;
  }
```

- [ ] **Step 5: Run the focused test and verify it still fails**

Run:

```powershell
npx vitest run tests/impact-streaming.test.ts --testNamePattern "streams a final structured report summary"
```

Expected: FAIL with runtime absence of `report`. Type changes alone should not make the test pass.

- [ ] **Step 6: Commit**

Commit only if the worker policy allows red-test commits. Otherwise leave this task uncommitted and continue to Task 2.

```powershell
git add src/impact/types.ts src/impact/streaming.ts tests/impact-streaming.test.ts
git commit -m "test: specify streaming impact summary payload"
```

---

### Task 2: Extract Shared Impact Analysis Core

**Files:**
- Create: `src/impact/collect.ts`
- Modify: `src/impact/index.ts`
- Modify: `src/impact/streaming.ts`
- Test: `tests/impact-streaming.test.ts`

- [ ] **Step 1: Add the internal result type**

Create `src/impact/collect.ts` with imports copied from `src/impact/index.ts` for the functions used by impact collection:

```ts
import { type ProjectIndex } from "../indexer.js";
import type { ImpactOptions, ChangedSymbol, FileChange, ImpactSuggestion, ImpactDiagnostics } from "./types.js";
import { getDiff } from "./providers/base.js";
import { locateChangedSymbolsWithLines } from "./map.js";
import { analyzeImpact } from "./analyzer.js";
import { collectImpactSuggestions } from "./suggestions.js";
import { listCandidateTestFiles } from "./context.js";
import { mapLimit } from "../util.js";
import { createImpactIgnoreMatcher, normalizeImpactDiffFiles } from "./path.js";

type CollectedImpactAnalysis = {
  normalizedChanges: FileChange[];
  changedSymbols: ChangedSymbol[];
  impactedItems: Awaited<ReturnType<typeof analyzeImpact>>;
  suggestions: ImpactSuggestion[];
  diagnostics: ImpactDiagnostics;
  warning?: string | undefined;
};
```

- [ ] **Step 2: Move collection dependencies into `collect.ts`**

Move these helpers from `src/impact/index.ts` to `src/impact/collect.ts` because they are needed by `collectImpactAnalysis()`:

```ts
collectConfigAndBreakingSuggestions
collectUntestedChangeSuggestions
```

Move their private helper functions with them, including config-impact helpers, coverage helpers, signature-change helpers, and local constants used only by those functions. Keep their behavior unchanged.

- [ ] **Step 3: Extract `collectImpactAnalysis()`**

Add this exported helper to `src/impact/collect.ts`:

```ts
export async function collectImpactAnalysis(
  projectRoot: string,
  index: ProjectIndex,
  options: ImpactOptions,
): Promise<CollectedImpactAnalysis> {
  const diff = await getDiff(options);
  const { ignoreGlobs = [] } = options;
  const isIgnored = createImpactIgnoreMatcher(projectRoot, ignoreGlobs);
  const normalizedDiff = normalizeImpactDiffFiles(projectRoot, diff.files, isIgnored);
  const diagnostics: ImpactDiagnostics = {
    changedFilesTotal: diff.files.length,
    changedFilesIgnored: normalizedDiff.ignoredCount,
    changedFilesWithoutSymbols: 0,
    symbolMappingParseFailures: 0,
    refsScanned: 0,
    refsFilteredTests: 0,
    refsFilteredIgnored: 0,
    refsDroppedByMaxRefs: 0,
    fallbackSeededFiles: 0,
    fallbackSeededDependents: 0,
  };

  const normalizedChanges = normalizedDiff.files;
  const changedByFile = await mapLimit(
    normalizedChanges.map((fileChange, idx) => ({ fileChange, idx })),
    8,
    async ({ fileChange, idx }) => {
      const mapped = await locateChangedSymbolsWithLines(index, fileChange.path, fileChange.hunks);
      return {
        idx,
        path: fileChange.path,
        kind: fileChange.kind,
        symbols: mapped.changedSymbols,
        parseFailed: mapped.parseFailed,
      };
    },
  );

  changedByFile.sort((a, b) => a.idx - b.idx);
  let changedSymbols: ChangedSymbol[] = [];
  const filesWithSymbols = new Set<string>();
  for (const entry of changedByFile) {
    if (entry.symbols.length > 0) filesWithSymbols.add(entry.path);
    if (entry.symbols.length === 0) {
      diagnostics.changedFilesWithoutSymbols += 1;
      if (entry.parseFailed && entry.kind !== "deleted") {
        diagnostics.symbolMappingParseFailures += 1;
      }
    }
    changedSymbols.push(...entry.symbols);
  }

  if (options.scope === "imported") {
    changedSymbols = changedSymbols.filter((symbol) => symbol.exported);
  }

  const fileLevelFallback = options.fileLevelFallback ?? true;
  const fileLevelFallbackPaths = normalizedChanges
    .filter((change) => change.kind !== "deleted" && !filesWithSymbols.has(change.path))
    .map((change) => change.path);

  let fanInByFile: Map<string, number> | undefined;
  if (options.testCoverageSuggestions) {
    fanInByFile = new Map<string, number>();
    for (const edge of index.graph.edges) {
      if (edge.to.type !== "file") continue;
      const current = fanInByFile.get(edge.to.path) ?? 0;
      fanInByFile.set(edge.to.path, current + 1);
    }
  }

  const impactedItems = await analyzeImpact(index, changedSymbols, normalizedChanges, {
    ...options,
    projectRoot,
    fileLevelFallback,
    fileLevelFallbackPaths,
    diagnostics,
  });

  const suggestions = options.verifyReferences
    ? await collectImpactSuggestions(index, projectRoot, normalizedChanges, options)
    : [];

  const configAndBreaking =
    options.configImpactRules || options.detectBreakingChanges
      ? collectConfigAndBreakingSuggestions(index, projectRoot, normalizedChanges, changedSymbols, {
          configImpactRules: !!options.configImpactRules,
          detectBreakingChanges: !!options.detectBreakingChanges,
        })
      : [];

  const coverageSuggestions = options.testCoverageSuggestions
    ? await collectUntestedChangeSuggestions(index, changedSymbols, projectRoot, fanInByFile, {
        ...(options.lcovPaths ? { lcovPaths: options.lcovPaths } : {}),
        ...(options.coveragePaths ? { coveragePaths: options.coveragePaths } : {}),
        ...(options.testCommandTemplate ? { testCommandTemplate: options.testCommandTemplate } : {}),
        ...(options.testPatterns ? { testPatterns: options.testPatterns } : {}),
      })
    : [];

  return {
    normalizedChanges,
    changedSymbols,
    impactedItems,
    suggestions: [...suggestions, ...configAndBreaking, ...coverageSuggestions],
    diagnostics,
    warning: diff.warning,
  };
}
```

- [ ] **Step 4: Rebuild `analyzeImpactFromDiff()` from the helper**

In `src/impact/index.ts`, import:

```ts
import { collectImpactAnalysis } from "./collect.js";
```

Replace `analyzeImpactFromDiff()` with:

```ts
export async function analyzeImpactFromDiff(
  projectRoot: string,
  index: ProjectIndex,
  options: ImpactOptions,
): Promise<ImpactReport | CompactImpactReport> {
  const analysis = await collectImpactAnalysis(projectRoot, index, options);
  return await buildImpactReport(
    projectRoot,
    index,
    analysis.normalizedChanges,
    analysis.changedSymbols,
    analysis.impactedItems,
    analysis.suggestions,
    { ...options, warning: analysis.warning },
    analysis.diagnostics,
  );
}
```

- [ ] **Step 5: Run existing impact tests**

Run:

```powershell
npx vitest run tests/impact.test.ts tests/impact-cli.test.ts
```

Expected: PASS. This proves the batch API stayed compatible.

- [ ] **Step 6: Commit**

```powershell
git add src/impact/collect.ts src/impact/index.ts
git commit -m "refactor: share impact analysis collection"
```

---

### Task 3: Emit Final Structured Summary From Streaming

**Files:**
- Modify: `src/impact/streaming.ts`
- Test: `tests/impact-streaming.test.ts`

- [ ] **Step 1: Import shared helpers**

In `src/impact/streaming.ts`, import:

```ts
import { collectImpactAnalysis } from "./collect.js";
import { buildImpactReport } from "./report.js";
```

- [ ] **Step 2: Build a summary report from the final full report**

After the queued impact items finish, call:

```ts
const analysis = await collectImpactAnalysis(projectRoot, index, options);
const fullReport = await buildImpactReport(
  projectRoot,
  index,
  analysis.normalizedChanges,
  analysis.changedSymbols,
  analysis.impactedItems,
  analysis.suggestions,
  { ...options, compact: false, warning: analysis.warning },
  analysis.diagnostics,
);
```

Then create:

```ts
const report: ImpactStreamSummaryReport = {
  schemaVersion: fullReport.schemaVersion,
  format: "stream-summary",
  changedFiles: fullReport.changedFiles,
  changedSymbols: fullReport.changedSymbols,
  impacted: fullReport.impacted,
  topImpacts: fullReport.topImpacts ?? [],
  surfaceArea: fullReport.surfaceArea,
  clusters: fullReport.clusters,
  cycles: fullReport.cycles ?? [],
  diagnostics: fullReport.diagnostics ?? analysis.diagnostics,
  ...(fullReport.warning ? { warning: fullReport.warning } : {}),
};
```

Yield the complete chunk as:

```ts
yield {
  type: "complete",
  summary: {
    totalChanged: report.changedSymbols.length,
    totalImpacted: report.impacted.length,
  },
  report,
};
```

- [ ] **Step 3: Keep progressive streaming behavior intact**

Do not remove existing `progress`, `projectFiles`, `changedSymbol`, or `impactItem` chunks. The final report is additive.

- [ ] **Step 4: Run the focused streaming test**

Run:

```powershell
npx vitest run tests/impact-streaming.test.ts --testNamePattern "streams a final structured report summary"
```

Expected: PASS.

- [ ] **Step 5: Run full streaming tests**

Run:

```powershell
npx vitest run tests/impact-streaming.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/impact/streaming.ts tests/impact-streaming.test.ts
git commit -m "feat: stream structured impact summary"
```

---

### Task 4: Add Batch/Streaming Parity Coverage

**Files:**
- Modify: `tests/impact-streaming.test.ts`

- [ ] **Step 1: Write the parity test**

Add:

```ts
it("keeps streaming final summary aligned with batch impact reports", async () => {
  const batch = await analyzeImpactFromDiff(sampleRoot, index, { provider: "raw", diffText });
  expect(batch.format).toBe("full");

  let streamed;
  for await (const chunk of analyzeImpactStreaming(sampleRoot, index, { provider: "raw", diffText })) {
    if (chunk.type === "complete") streamed = chunk.report;
  }

  expect(streamed).toBeDefined();
  if (batch.format === "full" && streamed) {
    expect(streamed.changedFiles).toEqual(batch.changedFiles);
    expect(streamed.changedSymbols).toEqual(batch.changedSymbols);
    expect(streamed.impacted).toEqual(batch.impacted);
    expect(streamed.topImpacts).toEqual(batch.topImpacts ?? []);
    expect(streamed.surfaceArea).toEqual(batch.surfaceArea);
    expect(streamed.clusters).toEqual(batch.clusters);
    expect(streamed.cycles).toEqual(batch.cycles ?? []);
    expect(streamed.diagnostics).toEqual(batch.diagnostics);
  }
});
```

- [ ] **Step 2: Run the parity test**

Run:

```powershell
npx vitest run tests/impact-streaming.test.ts --testNamePattern "keeps streaming final summary aligned"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```powershell
git add tests/impact-streaming.test.ts
git commit -m "test: cover streaming impact parity"
```

---

### Task 5: Document Programmatic Review Output

**Files:**
- Modify: `docs/library-api.md`
- Modify: `docs/agent-workflows.md`
- Modify: `docs/cli.md`
- Modify: `codegraph-skill/codegraph/SKILL.md`
- Modify: `README.md`

- [ ] **Step 1: Update `docs/library-api.md`**

Add a section after the high-level agent wrapper example:

```md
### Programmatic review and impact output

Use the exported TypeScript APIs when another program is composing deterministic review packets, file packs, or model prompts. CLI `--pretty` and `--summary` output is optimized for humans reading a terminal; it is not the stable integration contract.

- `buildReviewReport()` returns a review bundle with `schemaVersion`, changed files, changed symbols, `graphDelta`, candidate tests, `riskSummary`, `reviewTasks`, and diagnostics.
- `analyzeImpactFromDiff()` returns the full or compact impact report shape for batch consumers.
- `analyzeImpactStreaming()` emits progress and incremental chunks, then a final `complete.report` summary with the same key structured fields needed by pack builders: changed files, changed symbols, impacted items, top impacts, surface area, clusters, cycles, diagnostics, and warning text.

Review-pack builders should preserve symbol handles, diff snippets, callsites, diagnostics, candidate-test confidence, impact reasons, and graph edge metadata. Render prose only at the final UI or prompt boundary.
```

- [ ] **Step 2: Update `docs/agent-workflows.md`**

In "High-level agent tools", add:

```md
When the agent runtime calls Codegraph as a TypeScript library, prefer structured fields over rendered CLI text. A deterministic review agent should usually call `buildReviewReport()` for changed-file and task metadata, then `analyzeImpactFromDiff()` or `analyzeImpactStreaming()` for impact and graph context. Use CLI output only when the agent is operating through a shell tool.
```

In "Review bundles for agents", add:

```md
For function-call integrations, keep the JSON object as the handoff. Do not parse `review --summary` or `impact --pretty` text to recover fields that are already present in the TypeScript return values.
```

- [ ] **Step 3: Update `docs/cli.md`**

Add this note near "Output formats":

```md
`--pretty` and `--summary` are presentation modes. They are intentionally compact and may omit low-confidence or verbose context that remains available in structured JSON and TypeScript return values. Integrators that compose deterministic review packs should use the exported TypeScript functions or JSON output.
```

- [ ] **Step 4: Update `codegraph-skill/codegraph/SKILL.md`**

Add this to the library usage section:

```md
When integrating Codegraph into another TypeScript program, do not treat CLI prose as the contract. Use `buildReviewReport()`, `analyzeImpactFromDiff()`, or `analyzeImpactStreaming()` and preserve structured fields until the final prompt or UI rendering step.
```

- [ ] **Step 5: Run docs checks through tests**

Run:

```powershell
npx vitest run tests/package-metadata.test.ts
```

Expected: PASS.

- [ ] **Step 6: Update README docs index**

In `README.md`, ensure the documentation index includes both:

```md
- [Library API](./docs/library-api.md)
- [Agent workflows](./docs/agent-workflows.md)
```

Do not add a new top-level section unless one is needed for the index to remain accurate.

- [ ] **Step 7: Commit**

```powershell
git add docs/library-api.md docs/agent-workflows.md docs/cli.md codegraph-skill/codegraph/SKILL.md README.md tests/package-metadata.test.ts
git commit -m "docs: clarify programmatic review output"
```

If `README.md` and `tests/package-metadata.test.ts` did not change, remove them from the `git add` command.

---

### Task 6: Full Verification

**Files:**
- No source edits.

- [ ] **Step 1: Run typecheck/build/lint**

Run:

```powershell
npm run build
npm run lint
```

Expected: both PASS.

- [ ] **Step 2: Run full tests**

Run:

```powershell
npm run test:ci
npm run test:native
```

Expected: both PASS. If native is unavailable in the local environment, record the exact failure and verify the TypeScript suite still passes.

- [ ] **Step 3: Check formatting and status**

Run:

```powershell
git diff --check
git status --short --branch
```

Expected: `git diff --check` exits 0 and the branch only contains intended commits.

---

## Self-Review

- Spec coverage: The plan covers the streaming output gap, batch/streaming parity, and docs guidance that prevents future consumers from confusing CLI summaries with TypeScript integration contracts.
- Placeholder scan: No placeholders remain. Every task has files, code shape, commands, and expected results.
- Type consistency: `ImpactStreamSummaryReport` is the single new public type. `complete.report` is additive and does not replace existing `complete.summary`.
