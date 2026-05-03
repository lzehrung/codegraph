# Codegraph Output Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codegraph output easier to reach for during real review work by improving human summaries, reducing noisy triage signals, clarifying impact reasons, and normalizing compact-output flags.

**Architecture:** Keep existing JSON contracts stable by adding opt-in human-summary and alias behavior instead of changing default machine output. Centralize presentation logic in focused CLI/report formatter helpers, keep analysis data structures as the source of truth, and add regression tests that compare actual CLI output shape rather than only internal helper behavior.

**Tech Stack:** TypeScript, Node.js CLI, Vitest, Git fixture repositories, existing Codegraph impact/review/index/graph APIs.

---

## Current Rough Points To Address

- `review --base HEAD --head WORKTREE` works, but default JSON starts with a large `projectFiles` block before the review-relevant summary.
- Human output for review is missing; agents and humans need a short summary that leads with changed files, symbols, candidate tests, diagnostics, and risk.
- `inspect` reports Node builtins such as `node:path` as unresolved imports, which dilutes triage value.
- `impact --pretty` is useful but too terse: it ranks files without explaining why each item is ranked.
- Compact-output flag naming is inconsistent; users naturally try `--compact-json` for impact because graph uses that wording.

## File Structure

- Modify `src/cli.ts`
  - Add review summary rendering.
  - Add `--summary` and `--pretty` handling for `review`.
  - Add `--compact-json` alias for `impact`.
  - Update help text examples.
- Modify `src/review.ts`
  - Keep existing `ReviewReport` contract unchanged.
  - Add no new analysis behavior unless a small type/export is needed for formatting.
- Modify `src/graphs.ts` or the current unresolved-import helper file found by search
  - Classify Node builtins as external runtime modules rather than unresolved project imports.
- Modify `src/types.ts` only if a graph/report type needs a new optional field.
- Modify `docs/cli.md`
  - Document `review --summary` / `review --pretty`.
  - Document `impact --compact-json` alias.
  - Clarify `inspect` unresolved behavior for Node builtins.
- Modify `docs/agent-workflows.md`
  - Recommend `impact --pretty` for first-pass triage and `review --summary` for agent handoff.
- Modify `docs/library-api.md`
  - Document that machine JSON remains default and human summaries are CLI-only.
- Modify `codegraph-skill/codegraph/SKILL.md`
  - Teach agents when to use `impact --pretty`, `review --summary`, and compact JSON.
- Add or modify `tests/impact-cli.test.ts`
  - Cover `--compact-json` alias.
  - Cover reason labels in pretty output.
- Add or modify `tests/cli-regressions.test.ts`
  - Cover review summary output.
- Add or modify the nearest unresolved/inspect tests, likely `tests/cli-regressions.test.ts`, `tests/index.test.ts`, or `tests/resolution.test.ts`
  - Cover Node builtins not inflating unresolved triage.
- Modify `tests/package-metadata.test.ts`
  - Ensure docs and skill remain aligned and ASCII-clean if new public docs are changed.

---

## Phase 1: Lock Output Baselines Before Changing Formatting

### Task 1: Add CLI Regression Tests For Current Review Summary Need

**Files:**

- Modify: `tests/cli-regressions.test.ts`
- Reference: `src/cli.ts`

- [ ] **Step 1: Add a failing test for review summary mode**

Add this test near the existing review/impact CLI flow tests:

```ts
it("review CLI prints a compact human summary with --summary", async () => {
  const root = await mkTmpDir("dg-review-summary-");
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "core.autocrlf", "false"]);
  await fsp.writeFile(path.join(root, "main.ts"), "export function value() { return 1; }\n", "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);

  await fsp.writeFile(path.join(root, "main.ts"), "export function value() { return 2; }\n", "utf8");

  const stdout = await runCliCommand(["review", "--root", root, "--base", "HEAD", "--head", "WORKTREE", "--summary"]);

  expect(stdout).toContain("Review Summary");
  expect(stdout).toContain("Files changed: 1");
  expect(stdout).toContain("Symbols changed:");
  expect(stdout).toContain("Risk:");
  expect(stdout).toContain("Changed files:");
  expect(stdout).toContain("main.ts");
  expect(stdout).not.toContain('"projectFiles"');
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npm run test:ci -- tests/cli-regressions.test.ts
```

Expected: FAIL because `review --summary` is not implemented or is treated as an unknown/no-op flag.

- [ ] **Step 3: Commit the failing test only if working in a TDD checkpoint branch**

Run:

```powershell
git add tests/cli-regressions.test.ts
git commit -m "test: cover review summary output"
```

Expected: commit succeeds only if the team is using red/green commits. If not, keep the failing test uncommitted until Task 2 passes.

### Task 2: Add CLI Regression Tests For Impact Pretty Reasons And Compact Alias

**Files:**

- Modify: `tests/impact-cli.test.ts`
- Reference: `src/cli.ts`
- Reference: `src/impact/report.ts`

- [ ] **Step 1: Add a failing test for `--compact-json` impact alias**

Add this test in `describe("impact CLI output", ...)`:

```ts
it("accepts --compact-json as an alias for compact impact JSON", async () => {
  const stdout = await runImpactCli(["impact", sampleRoot, "--provider", "raw", "--compact-json"]);
  const report = JSON.parse(stdout) as { schemaVersion?: number; format?: string; files?: string[] };

  expect(report.schemaVersion).toBe(1);
  expect(report.format).toBe("compact");
  expect(Array.isArray(report.files)).toBe(true);
});
```

- [ ] **Step 2: Add a failing test for reason labels in pretty impact output**

Add this test in the same `describe` block:

```ts
it("prints reason labels in pretty impact output", async () => {
  const stdout = await runImpactCli(["impact", sampleRoot, "--provider", "raw", "--pretty"]);

  expect(stdout).toContain("Impact Analysis Report");
  expect(stdout).toContain("Changed files: 1");
  expect(stdout).toMatch(/utils\.ts: .*reason:/);
});
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run:

```powershell
npm run test:ci -- tests/impact-cli.test.ts
```

Expected: FAIL because `--compact-json` is not yet accepted and pretty output does not print reason labels.

---

## Phase 2: Implement Review Summary Output

### Task 3: Add Review Summary Formatter

**Files:**

- Modify: `src/cli.ts`
- Test: `tests/cli-regressions.test.ts`

- [ ] **Step 1: Add a `formatReviewSummary` helper in `src/cli.ts`**

Place it near the existing CLI formatting helpers, before `main()`:

```ts
function formatReviewSummary(report: Awaited<ReturnType<typeof buildReviewReport>>): string {
  const lines: string[] = [];
  lines.push("Review Summary");
  lines.push("==============");
  lines.push(`Status: ${report.status}`);
  lines.push(`Files changed: ${report.summary.filesChanged}`);
  lines.push(`Symbols changed: ${report.summary.symbolsChanged}`);
  lines.push(`Candidate tests: ${report.summary.candidateTests}`);
  lines.push(`Risk: ${report.riskSummary.level} (${report.riskSummary.score})`);
  if (report.riskSummary.signals.length > 0) {
    lines.push(`Signals: ${report.riskSummary.signals.join(", ")}`);
  }
  lines.push("");
  lines.push("Changed files:");
  if (report.changedFiles.length === 0) {
    lines.push("- none");
  } else {
    for (const file of report.changedFiles.slice(0, 20)) {
      const symbolNames = file.symbols.slice(0, 5).map((symbol) => symbol.name);
      const symbolSummary = symbolNames.length > 0 ? ` (${symbolNames.join(", ")})` : "";
      lines.push(`- ${file.file}: ${file.status}${symbolSummary}`);
    }
    if (report.changedFiles.length > 20) {
      lines.push(`- ... and ${report.changedFiles.length - 20} more`);
    }
  }
  lines.push("");
  lines.push("Candidate tests:");
  if (report.candidateTests.length === 0) {
    lines.push("- none");
  } else {
    for (const candidate of report.candidateTests.slice(0, 10)) {
      lines.push(`- ${candidate.file}: ${candidate.confidence} (${candidate.reason})`);
    }
    if (report.candidateTests.length > 10) {
      lines.push(`- ... and ${report.candidateTests.length - 10} more`);
    }
  }
  if (report.diagnostics) {
    lines.push("");
    lines.push("Diagnostics:");
    lines.push(`- missing files: ${report.diagnostics.missingFiles.length}`);
    lines.push(`- symbol mapping parse failures: ${report.diagnostics.symbolMappingParseFailures.length}`);
  }
  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 2: Wire `review --summary` and `review --pretty` to the formatter**

In the `cmd === "review"` block, after `const report = await buildReviewReport(...)`, write:

```ts
const wantsSummary = hasFlag("--summary") || hasFlag("--pretty");
if (wantsSummary) {
  writeStdoutLine(formatReviewSummary(report).trimEnd());
} else {
  writeJSONLine(report);
}
```

Make sure the previous unconditional JSON write is replaced, not duplicated.

- [ ] **Step 3: Run the review summary regression**

Run:

```powershell
npm run test:ci -- tests/cli-regressions.test.ts
```

Expected: PASS for `review CLI prints a compact human summary with --summary`.

- [ ] **Step 4: Smoke test real worktree output**

Run:

```powershell
node .\dist\cli.js review --base HEAD --head WORKTREE --summary
```

Expected: Output begins with `Review Summary`, includes changed-file counts, and does not print the `projectFiles` JSON array.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/cli.ts tests/cli-regressions.test.ts
git commit -m "feat: add review summary output"
```

Expected: Commit contains only review summary implementation and tests.

---

## Phase 3: Improve Impact Pretty Output And Compact Flag Consistency

### Task 4: Add Impact Reason Labels To Pretty Output

**Files:**

- Modify: `src/cli.ts`
- Test: `tests/impact-cli.test.ts`

- [ ] **Step 1: Add a helper that converts impact reasons to short labels**

Place near existing impact formatting helpers:

```ts
function formatImpactReasonLabel(item: { reasons?: string[]; explain?: { reason?: string } }): string {
  const primary = item.explain?.reason ?? item.reasons?.[0];
  if (!primary) return "reason: impact";
  const labels: Record<string, string> = {
    directRef: "reason: direct reference",
    namespaceMember: "reason: namespace member",
    importAlias: "reason: import alias",
    transitive: "reason: transitive dependency",
    exportChain: "reason: export chain",
    fileLevelChange: "reason: file-level change",
  };
  return labels[primary] ?? `reason: ${primary}`;
}
```

- [ ] **Step 2: Update `formatImpactPretty` item lines**

Where pretty output currently prints:

```ts
lines.push(`${item.file}: ${symbols} (severity: ${severity})`);
```

Change it to:

```ts
const reasonLabel = formatImpactReasonLabel(item);
lines.push(`${item.file}: ${symbols} (${reasonLabel}, severity: ${severity})`);
```

Keep the existing severity format and truncation behavior.

- [ ] **Step 3: Run impact CLI tests**

Run:

```powershell
npm run test:ci -- tests/impact-cli.test.ts
```

Expected: PASS, including the reason-label test.

### Task 5: Add `--compact-json` Alias For Impact

**Files:**

- Modify: `src/cli.ts`
- Test: `tests/impact-cli.test.ts`
- Docs: `docs/cli.md`

- [ ] **Step 1: Wire the alias**

Find impact option parsing for compact reports. Change:

```ts
if (hasFlag("--compact")) options.compact = true;
```

to:

```ts
if (hasFlag("--compact") || hasFlag("--compact-json")) options.compact = true;
```

If the existing code uses a different variable, keep the same behavior and add `hasFlag("--compact-json")` as an alias only.

- [ ] **Step 2: Document both names**

In `docs/cli.md`, under impact examples, add:

```md
# Compact impact JSON with indexed file arrays

codegraph impact --base main --head HEAD --compact-json
```

Also add one sentence:

```md
`--compact-json` is an alias for the existing compact impact payload and matches the graph command naming style.
```

- [ ] **Step 3: Run tests**

Run:

```powershell
npm run test:ci -- tests/impact-cli.test.ts tests/package-metadata.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```powershell
git add src/cli.ts tests/impact-cli.test.ts docs/cli.md
git commit -m "feat: improve impact pretty output"
```

Expected: Commit contains reason labels, compact alias, and docs.

---

## Phase 4: Reduce `inspect` Unresolved Noise

### Task 6: Classify Node Builtins Outside Unresolved Import Triage

**Files:**

- Modify: `src/graphs.ts` or the file containing `getUnresolvedImports`
- Test: nearest existing unresolved/inspect test file
- Docs: `docs/cli.md`

- [ ] **Step 1: Locate unresolved import implementation**

Run:

```powershell
rg -n "function getUnresolvedImports|export function getUnresolvedImports|unresolved" src tests
```

Expected: Identify the exact helper that builds unresolved import results.

- [ ] **Step 2: Add a failing unit test for Node builtins**

If `tests/cli-regressions.test.ts` remains the nearest CLI coverage, add:

```ts
it("inspect does not count Node builtins as unresolved imports", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-inspect-builtins-"));
  await fsp.writeFile(
    path.join(tmpDir, "main.ts"),
    "import path from 'node:path';\nimport fs from 'node:fs';\nexport const value = path.sep + String(!!fs);\n",
    "utf8",
  );

  const stdout = await runCliCommand(["inspect", "--root", tmpDir, tmpDir, "--limit", "5"]);
  const report = JSON.parse(stdout) as {
    unresolved: { total: number; top: Array<{ name: string }> };
  };

  expect(report.unresolved.total).toBe(0);
  expect(report.unresolved.top.map((entry) => entry.name)).not.toContain("node:path");
  expect(report.unresolved.top.map((entry) => entry.name)).not.toContain("node:fs");
});
```

- [ ] **Step 3: Implement builtin classification**

Add a small helper in the unresolved implementation module:

```ts
import { builtinModules } from "node:module";

const NODE_BUILTIN_MODULES = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

function isNodeBuiltinSpecifier(specifier: string): boolean {
  return NODE_BUILTIN_MODULES.has(specifier);
}
```

When collecting unresolved imports, skip entries where `isNodeBuiltinSpecifier(edge.raw)` or the unresolved name is true. Do not remove other external package names unless they are already handled elsewhere.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npm run test:ci -- tests/cli-regressions.test.ts
```

Expected: PASS. The new inspect test should report zero unresolved imports for `node:path` and `node:fs`.

- [ ] **Step 5: Smoke test current repo inspect**

Run:

```powershell
node .\dist\cli.js inspect .\src --limit 8
```

Expected: `unresolved.top` no longer leads with `node:path`, `node:fs`, or `node:fs/promises`.

- [ ] **Step 6: Document behavior**

In `docs/cli.md`, add:

```md
`inspect` unresolved import counts exclude Node builtins such as `node:path` so the unresolved list stays focused on project and package resolution gaps.
```

- [ ] **Step 7: Commit**

Run:

```powershell
git add src tests docs/cli.md
git commit -m "fix: exclude node builtins from unresolved triage"
```

Expected: Commit contains builtin filtering, tests, and docs.

---

## Phase 5: Improve Agent Workflow Guidance

### Task 7: Update Canonical Docs And Skill Guidance

**Files:**

- Modify: `README.md`
- Modify: `docs/agent-workflows.md`
- Modify: `docs/library-api.md`
- Modify: `codegraph-skill/codegraph/SKILL.md`
- Test: `tests/package-metadata.test.ts`

- [ ] **Step 1: Update README recommended workflows**

In the workflow bullets, make the recommendation explicit:

```md
- Worktree review: run `codegraph impact --base HEAD --head WORKTREE --pretty` for a quick ranked map, then `codegraph review --base HEAD --head WORKTREE --summary` for a compact review handoff.
```

- [ ] **Step 2: Update agent workflow docs**

In `docs/agent-workflows.md`, add:

```md
For active local edits, start with `codegraph impact --base HEAD --head WORKTREE --pretty`. Use `codegraph review --base HEAD --head WORKTREE --summary` when you need a compact handoff with changed files, changed symbols, candidate tests, diagnostics, and risk signals. Use full JSON only when another tool will consume the complete schema.
```

- [ ] **Step 3: Update library API docs**

In `docs/library-api.md`, add:

```md
Human summaries are CLI presentation features. Library callers should continue to use `buildReviewReport()` and `tool_impactJSON()` for structured data, then format only the fields their workflow needs.
```

- [ ] **Step 4: Update bundled skill**

In `codegraph-skill/codegraph/SKILL.md`, update the first-move command list:

```md
- Current worktree impact: `codegraph impact --provider git --base HEAD --head WORKTREE --pretty`
- Compact review handoff: `codegraph review --base HEAD --head WORKTREE --summary`
```

Add guidance:

```md
Prefer `impact --pretty` for the first triage pass. Prefer `review --summary` for a compact handoff. Use full JSON only when you need schema-complete data such as graphDelta, projectFiles, or full changed-symbol handles.
```

- [ ] **Step 5: Run docs/package tests**

Run:

```powershell
npm run test:ci -- tests/package-metadata.test.ts
```

Expected: PASS. ASCII and skill-frontmatter checks remain green.

- [ ] **Step 6: Reinstall local skill**

Run:

```powershell
npm run build
node .\dist\cli.js skill install --force
Select-String -Path C:\Users\lzehr\.codex\skills\codegraph\SKILL.md -Pattern "review --base HEAD --head WORKTREE --summary"
```

Expected: Installed skill contains the new summary command.

- [ ] **Step 7: Commit**

Run:

```powershell
git add README.md docs/agent-workflows.md docs/library-api.md codegraph-skill/codegraph/SKILL.md tests/package-metadata.test.ts
git commit -m "docs: clarify agent output workflows"
```

Expected: Commit contains docs and skill updates only.

---

## Phase 6: End-To-End Validation And Final Review

### Task 8: Run Real Output Smoke Checks

**Files:**

- No code edits expected.

- [ ] **Step 1: Build**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 2: Run impact pretty on current worktree**

Run:

```powershell
node .\dist\cli.js impact --provider git --base HEAD --head WORKTREE --pretty --ignore-glob "**/dist/**"
```

Expected:

- Starts with `Impact Analysis Report`.
- Shows changed file/symbol/impact counts.
- Top impacted entries include reason labels.
- Does not include raw JSON.

- [ ] **Step 3: Run review summary on current worktree**

Run:

```powershell
node .\dist\cli.js review --base HEAD --head WORKTREE --summary
```

Expected:

- Starts with `Review Summary`.
- Shows files changed, symbols changed, candidate tests, risk.
- Lists changed files before any project-file metadata.
- Does not include `"projectFiles"`.

- [ ] **Step 4: Run inspect on source**

Run:

```powershell
node .\dist\cli.js inspect .\src --limit 8
```

Expected:

- Hotspots still appear.
- `unresolved.top` does not include Node builtins such as `node:path`.
- Recommended commands remain valid.

- [ ] **Step 5: Run compact alias**

Run:

```powershell
node .\dist\cli.js impact --provider git --base HEAD --head WORKTREE --compact-json --ignore-glob "**/dist/**"
```

Expected:

- JSON parses.
- `format` is `"compact"`.
- File arrays use compact indexed form.

### Task 9: Run Full Verification

**Files:**

- No code edits expected.

- [ ] **Step 1: Run lint**

Run:

```powershell
npm run lint
```

Expected: PASS.

- [ ] **Step 2: Run full build**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```powershell
npm run test:ci
```

Expected: PASS. Treat this as the real completion gate if any focused Windows native-addon run has lock/copy noise.

- [ ] **Step 4: Check whitespace**

Run:

```powershell
git diff --check
```

Expected: no output and exit code 0.

### Task 10: Final Self-Review

**Files:**

- Review changed files only.

- [ ] **Step 1: Inspect final diff stat**

Run:

```powershell
git diff --stat
```

Expected: changes are limited to CLI formatting, unresolved filtering, tests, docs, and skill guidance.

- [ ] **Step 2: Inspect public docs for command accuracy**

Run:

```powershell
rg -n "review --base HEAD --head WORKTREE --summary|impact --base HEAD --head WORKTREE --pretty|compact-json|node:path" README.md docs codegraph-skill
```

Expected:

- README, CLI docs, agent workflow docs, and skill mention the new recommended commands.
- `compact-json` is documented for impact.
- Node builtin unresolved behavior is documented once in CLI reference.

- [ ] **Step 3: Inspect final git status**

Run:

```powershell
git status --short
```

Expected:

- Only intentional files are modified.
- Ignore unrelated user/workspace files such as `.idea/` unless the user explicitly asks to manage them.

- [ ] **Step 4: Commit final verification/doc cleanup if needed**

Run:

```powershell
git add README.md docs codegraph-skill src tests
git commit -m "chore: polish codegraph output ergonomics"
```

Expected: Use this only if prior tasks were not already committed in logical pieces. Prefer the phase-level commits above.

---

## Acceptance Criteria

- [ ] `impact --provider git --base HEAD --head WORKTREE --pretty` remains fast enough for first-pass review and prints reason labels for ranked items.
- [ ] `review --base HEAD --head WORKTREE --summary` provides a compact human handoff without the large `projectFiles` array.
- [ ] Existing `review` default JSON output remains schema-compatible.
- [ ] `impact --compact-json` works as an alias for the compact impact payload.
- [ ] `inspect` unresolved import output excludes Node builtins by default.
- [ ] Docs and bundled skill recommend the practical command sequence: impact pretty first, review summary second, full JSON only for tool consumption.
- [ ] Installed local skill is refreshed and contains the new guidance.
- [ ] `npm run lint`, `npm run build`, `npm run test:ci`, and `git diff --check` pass.

## Self-Review Notes

- Spec coverage: The plan covers all five rough points: review verbosity, human review output, Node builtin unresolved noise, impact reason labels, and compact flag consistency.
- Placeholder scan: No implementation step depends on a placeholder or unspecified file search except Task 6 Step 1, where the command is explicit and the target helper is intentionally discovered before editing.
- Type consistency: The plan preserves existing `ReviewReport`, `ImpactReport`, and compact impact output contracts; new behavior is CLI presentation or aliasing unless the unresolved helper requires a narrow internal helper.
- Scope control: The plan avoids changing analysis algorithms except for Node builtin unresolved classification. It does not redesign review JSON, graph schemas, or impact scoring.
