# Agent Test Plan Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn candidate test files from impact and review into bounded, copyable test plans for agents.

**Architecture:** Reuse existing candidate-test detection, coverage-aware suggestions, review bundles, and impact reports. Add a small command-template expansion layer and expose the resulting commands consistently in CLI JSON, review summaries, MCP, and packet outputs.

**Tech Stack:** TypeScript, Vitest, existing impact/review candidate-test modules, CLI review and impact renderers, MCP handlers, agent packet/explain helpers.

---

## Context

Codegraph already identifies likely tests through impact and review workflows:

```bash
codegraph impact --base main --head feature --lcov coverage/lcov.info --coverage-report coverage/coverage-final.json
codegraph impact --base main --head feature --coverage-report coverage/coverage-final.json --test-command-template "pnpm vitest {files}"
codegraph review --base HEAD --head WORKTREE --summary
```

Agents still have to translate candidate files into exact commands in many paths. This plan makes test execution guidance a first-class structured output without inventing new test discovery logic.

Relevant files:

- `src/impact/context.ts`: candidate test detection.
- `src/impact/report-suggestions.ts`: coverage-aware suggestions.
- `src/impact/types.ts`: impact report contracts.
- `src/review.ts`, `src/review/summaries.ts`: review bundle and summaries.
- `src/cli/impact.ts`, `src/cli/review.ts`: CLI presentation.
- `src/agent/explain.ts`, `src/agent/packet.ts`: packet follow-up context.
- `src/mcp/server.ts`, `src/mcp/tools.ts`: MCP review and impact handlers.
- `docs/cli.md`, `docs/library-api.md`, `docs/agent-workflows.md`, `codegraph-skill/codegraph/SKILL.md`: public docs and skill guidance.

## Deliverable

Add a shared test-plan output shape:

```ts
export interface AgentTestPlan {
  schemaVersion: 1;
  commands: AgentTestCommand[];
  candidateTests: CandidateTestFile[];
  omittedCounts: {
    commands: number;
    candidateTests: number;
  };
}

export interface AgentTestCommand {
  command: string;
  files: string[];
  confidence: "high" | "medium" | "low";
  reason: string;
}
```

Integrate it into:

- `impact` JSON when candidate tests exist and a command template is available.
- `review` JSON and `review --summary`.
- `packet get <review-handle>` and changed-context explain packets.
- MCP `impact` and `review` responses through the same structured fields.

## Command Template Rules

Start with the existing `--test-command-template` behavior and make it reusable.

Rules:

- `{files}` expands to shell-quoted test files joined by spaces.
- `{file}` expands only when a command contains exactly one file; reject or omit otherwise.
- Preserve candidate-test confidence in each command.
- Bound emitted commands; do not emit one command per low-confidence candidate in large repos.
- Do not infer a test runner when no template is configured.
- Do not execute tests. Codegraph only suggests commands.

## Task 1: Extract Test Command Planning Helper

**Files:**

- Create: `src/impact/testPlan.ts`
- Modify: `src/impact/index.ts`
- Test: `tests/impact-test-plan.test.ts`

- [ ] Add tests for `{files}` expansion, shell quoting, confidence grouping, omitted counts, empty candidates, and missing template.
- [ ] Extract the helper without changing current `impact --test-command-template` behavior.
- [ ] Run:

```bash
npx vitest run tests/impact-test-plan.test.ts tests/impact-analyzer.test.ts
```

## Task 2: Add Impact JSON Test Plans

**Files:**

- Modify: `src/impact/types.ts`
- Modify: nearest impact report builder modules
- Modify: `src/cli/impact.ts` if presentation needs wiring
- Test: `tests/impact-cli.test.ts`

- [ ] Add optional `testPlan` to full and compact impact outputs when a template and candidate tests are available.
- [ ] Keep `schemaVersion` and `format` stable.
- [ ] Ensure pretty output remains compact and only lists high/medium confidence commands.
- [ ] Run:

```bash
npx vitest run tests/impact-cli.test.ts tests/impact-analyzer.test.ts
```

## Task 3: Add Review Summary Test Plans

**Files:**

- Modify: `src/review.ts`
- Modify: `src/review/summaries.ts`
- Modify: `src/cli/review.ts`
- Test: `tests/review.test.ts`

- [ ] Add optional `testPlan` to review JSON.
- [ ] Add a short `Suggested test commands` section to `review --summary` when commands exist.
- [ ] Preserve existing candidate-test fields for compatibility.
- [ ] Run:

```bash
npx vitest run tests/review.test.ts tests/cli-regressions.test.ts
```

## Task 4: Surface Test Plans in Agent Packets and MCP

**Files:**

- Modify: `src/agent/explain.ts`
- Modify: `src/agent/packet.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/agent-packet.test.ts`
- Test: `tests/mcp-server.test.ts`

- [ ] Include test plans in review packets.
- [ ] Include changed-context test plans in explain packets when the caller supplies a review range or changed context.
- [ ] Ensure MCP `review` and `impact` return the same structured fields as library calls.
- [ ] Run:

```bash
npx vitest run tests/agent-packet.test.ts tests/mcp-server.test.ts
```

## Task 5: Update Docs and Skill

**Files:**

- Modify: `docs/cli.md`
- Modify: `docs/library-api.md`
- Modify: `docs/agent-workflows.md`
- Modify: `codegraph-skill/codegraph/SKILL.md`
- Test: `tests/package-metadata.test.ts`

- [ ] Document that Codegraph suggests test commands but does not execute them.
- [ ] Show a review workflow that uses `--test-command-template` and then runs selected commands externally.
- [ ] Update the skill guidance so agents prefer structured `testPlan` fields over parsing summary prose.
- [ ] Run:

```bash
npx vitest run tests/package-metadata.test.ts
git diff --check
```

## Acceptance Criteria

- Test command suggestions are deterministic and bounded.
- Missing command templates produce candidate tests without invented commands.
- Review, impact, MCP, and packet outputs preserve candidate-test confidence and reasons.
- CLI summaries remain short and omit low-confidence command spam.
- Existing candidate-test output remains backward compatible.
- No tests are executed by Codegraph.

## Final Verification

- [ ] Run:

```bash
npm run lint
npm run build
npm run test:ci
git diff --check
```
