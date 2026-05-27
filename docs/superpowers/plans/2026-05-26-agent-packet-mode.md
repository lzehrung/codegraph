# Agent Packet Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class orientation and packet retrieval workflow so agents receive compact repo context upfront and request bounded evidence packets by stable handle.

**Architecture:** Build a thin layer over existing `search`, `explain`, `artifact`, `review`, session, and MCP primitives. Add `orient` for the first-turn packet and `packet get` for handle-based follow-up without duplicating analysis logic.

**Tech Stack:** TypeScript, Vitest, existing agent session/search/explain/artifact modules, MCP server tooling, CLI command modules.

---

## Context

Codegraph already has the core primitives for agent work:

- `src/agent/search.ts`: deterministic search across files, symbols, chunks, SQL objects, and graph neighborhoods.
- `src/agent/explain.ts`: bounded explanation packets for file/symbol/SQL/search handles.
- `src/agent/session.ts`: warm project snapshot for repeated operations.
- `src/agent/handles.ts`: stable project-relative handles.
- `src/agent/artifact.ts`: durable bundle generation.
- `src/mcp/server.ts`, `src/mcp/tools.ts`: MCP tools over the same primitives.
- `src/cli/search.ts`, `src/cli/explain.ts`, `src/cli/artifact.ts`, `src/cli/mcp.ts`: current CLI wrappers.
- `docs/agent-workflows.md`, `docs/library-api.md`, `docs/cli.md`, `codegraph-skill/codegraph/SKILL.md`: agent-facing docs.

The product goal is to provide the model with less upfront but keep Codegraph packets ready when it asks for them. Do not create a separate indexer or a parallel packet schema that drifts from `search` and `explain`.

## Deliverable

Add:

```bash
codegraph orient --root . --budget small --json
codegraph orient ./src --budget medium --pretty
codegraph packet get file:src%2Fcli.ts --json
codegraph packet get symbol:src%2Fcli.ts%23runCli --json
codegraph packet get search:... --json
```

Add library API:

```ts
export async function orientCodegraph(request: AgentOrientRequest): Promise<AgentOrientResponse>;
export async function getCodegraphPacket(request: AgentPacketRequest): Promise<AgentPacketResponse>;
```

Add MCP tools:

- `orient`
- `packet_get`

## Packet Model

Orientation response:

```ts
export interface AgentOrientResponse {
  schemaVersion: 1;
  root: string;
  budget: "small" | "medium" | "large";
  summary: string[];
  tree: AgentTreeEntry[];
  modules: AgentModuleSummary[];
  health: {
    cycles: number | null;
    unresolved: number | null;
    duplicateGroups: number | null;
  };
  handles: AgentPacketHandle[];
  recommendedNext: AgentPacketCommand[];
  omittedCounts: {
    treeEntries: number;
    hotspots: number;
    handles: number;
    healthAnalyses: number;
  };
}
```

Packet response:

```ts
export interface AgentPacketResponse {
  schemaVersion: 1;
  root: string;
  handle: string;
  kind: "file" | "symbol" | "chunk" | "sql_object" | "graph" | "review";
  packet: unknown;
  limits: Record<string, number>;
  omittedCounts: Record<string, number>;
  followUps: string[];
}
```

During implementation, replace `unknown` with a discriminated union when the concrete packet kinds are wired. Do not ship a public `unknown` field if a precise union is practical by then.

## Acceptance Criteria

- `orient` returns a compact first-turn packet with stable handles and follow-up commands.
- `packet get` accepts handles emitted by `orient`, `search`, and `explain`.
- Packet retrieval delegates to existing explain/review/artifact/session helpers.
- MCP exposes equivalent tools with the same bounds and path confinement rules as existing MCP tools.
- Docs teach agents to start with `orient` when they need repo context and then ask for packets.
- Existing `search`, `explain`, `artifact`, `mcp`, `review`, and `impact` behavior stays compatible.
- No `any`, no `as unknown as`, no nested ternaries, no boolean `=== true` or `=== false`.

## Task 1: Add Orientation Types and Tree Budgeting

**Files:**

- Create: `src/agent/orient.ts`
- Modify: `src/agent/index.ts` if an agent barrel exists; otherwise modify `src/index.ts`.
- Test: `tests/agent-orient.test.ts`

- [ ] **Step 1: Add failing orient tests**

```ts
import { orientCodegraph } from "../src/index.js";
import { mkTmpDir, writeFile } from "./helpers/files.js";

it("returns compact orientation with stable packet handles", async () => {
  const root = await mkTmpDir("cg-agent-orient-");
  await writeFile(root, "src/index.ts", "export { run } from './run';\n");
  await writeFile(root, "src/run.ts", "export function run() { return 1; }\n");

  const response = await orientCodegraph({ root, includeRoots: ["src"], budget: "small" });

  expect(response.schemaVersion).toBe(1);
  expect(response.summary.length).toBeGreaterThan(0);
  expect(response.tree.some((entry) => entry.path === "src/index.ts")).toBe(true);
  expect(response.handles.some((handle) => handle.handle.startsWith("file:"))).toBe(true);
  expect(response.recommendedNext.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx vitest run tests/agent-orient.test.ts
```

Expected: FAIL because `orientCodegraph` does not exist.

- [ ] **Step 3: Implement `orientCodegraph()`**

Use existing helpers:

- `createAgentSession()` for one warm snapshot.
- `searchCodegraphWithSession()` only for optional default anchor queries if needed.
- Project file listing from `src/util/projectFiles.ts`.
- Hotspots/cycles/unresolved from existing graph helpers.
- Stable file handles from `src/agent/handles.ts`.

Budget rules:

```ts
const ORIENT_BUDGETS = {
  small: { treeDepth: 2, maxTreeEntries: 80, maxHandles: 20, maxHotspots: 8 },
  medium: { treeDepth: 3, maxTreeEntries: 160, maxHandles: 40, maxHotspots: 15 },
  large: { treeDepth: 4, maxTreeEntries: 320, maxHandles: 80, maxHotspots: 25 },
} as const;
```

Tree entries should be project-relative and sorted directories before files. Do not include `.git`, `.codegraph-cache`, `node_modules`, or ignored files already excluded by project discovery.

- [ ] **Step 4: Export the API**

Export `orientCodegraph` and its request/response types from `src/index.ts`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run tests/agent-orient.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/orient.ts src/index.ts tests/agent-orient.test.ts
git commit -m "Add agent orientation packets"
```

## Task 2: Add Packet Retrieval API

**Files:**

- Create: `src/agent/packet.ts`
- Modify: `src/index.ts`
- Test: `tests/agent-packet.test.ts`

- [ ] **Step 1: Add failing packet tests**

```ts
import { getCodegraphPacket, orientCodegraph } from "../src/index.js";
import { mkTmpDir, writeFile } from "./helpers/files.js";

it("retrieves a file packet from an orientation handle", async () => {
  const root = await mkTmpDir("cg-agent-packet-");
  await writeFile(root, "src/run.ts", "export function run() { return 1; }\n");

  const orient = await orientCodegraph({ root, includeRoots: ["src"], budget: "small" });
  const fileHandle = orient.handles.find((handle) => handle.kind === "file");
  if (!fileHandle) {
    throw new Error("expected file handle");
  }

  const packet = await getCodegraphPacket({ root, handle: fileHandle.handle });

  expect(packet.schemaVersion).toBe(1);
  expect(packet.kind).toBe("file");
  expect(packet.followUps.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx vitest run tests/agent-packet.test.ts
```

Expected: FAIL because `getCodegraphPacket` does not exist.

- [ ] **Step 3: Implement `getCodegraphPacket()`**

Rules:

- Accept handles already supported by `explainCodegraphTarget()`.
- Delegate file/symbol/chunk/sql-object/search-handle packets to `explainCodegraphTarget()`.
- Return the existing explain packet inside `packet`.
- Preserve `limits`, `omittedCounts`, and `followUps`.
- Reject unsupported handles with a typed error that names the accepted handle prefixes.

- [ ] **Step 4: Export the API**

Export `getCodegraphPacket` and types from `src/index.ts`.

- [ ] **Step 5: Run tests**

Run:

```bash
npx vitest run tests/agent-orient.test.ts tests/agent-packet.test.ts tests/agent-explain.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/packet.ts src/index.ts tests/agent-packet.test.ts
git commit -m "Add agent packet retrieval API"
```

## Task 3: Add `orient` CLI

**Files:**

- Create: `src/cli/orient.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli/help.ts`
- Test: `tests/cli-command-modules.test.ts`
- Test: `tests/cli-regressions.test.ts`

- [ ] **Step 1: Add failing CLI tests**

Assert:

- `codegraph orient --help` prints usage.
- `codegraph orient ./src --budget small --json` prints valid JSON with `schemaVersion: 1`.
- Pretty output includes sections `Summary`, `Tree`, and `Recommended next`.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx vitest run tests/cli-command-modules.test.ts tests/cli-regressions.test.ts
```

Expected: FAIL because `orient` is not wired.

- [ ] **Step 3: Implement command**

Support:

```text
codegraph orient [roots...]
  --root <path>
  --budget small|medium|large
  --json
  --pretty
  --native auto|on|off
  --workers
  --threads <number>
```

Default budget: `small`.

Pretty output must stay compact and include copyable follow-up commands:

```text
Recommended next
- codegraph packet get file:src%2Fcli.ts --json
- codegraph hotspots ./src --limit 20 --json
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx vitest run tests/cli-command-modules.test.ts tests/cli-regressions.test.ts tests/agent-orient.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/orient.ts src/cli.ts src/cli/help.ts tests/cli-command-modules.test.ts tests/cli-regressions.test.ts
git commit -m "Add orient CLI command"
```

## Task 4: Add `packet get` CLI

**Files:**

- Create: `src/cli/packet.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli/help.ts`
- Test: `tests/cli-command-modules.test.ts`
- Test: `tests/cli-regressions.test.ts`

- [ ] **Step 1: Add failing CLI tests**

Assert:

- `codegraph packet --help` prints usage.
- `codegraph packet get file:src%2Frun.ts --json` prints valid JSON with `kind: "file"`.
- Invalid handles exit non-zero with accepted handle prefixes.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npx vitest run tests/cli-command-modules.test.ts tests/cli-regressions.test.ts
```

Expected: FAIL because `packet` is missing.

- [ ] **Step 3: Implement command**

Support:

```text
codegraph packet get <handle>
  --root <path>
  --json
  --pretty
  --max-symbols <number>
  --max-snippets <number>
  --native auto|on|off
```

Pretty output can reuse the existing explain formatter. JSON must return the packet response wrapper.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx vitest run tests/cli-command-modules.test.ts tests/cli-regressions.test.ts tests/agent-packet.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/packet.ts src/cli.ts src/cli/help.ts tests/cli-command-modules.test.ts tests/cli-regressions.test.ts
git commit -m "Add packet retrieval CLI"
```

## Task 5: Add MCP Tools

**Files:**

- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/mcp-server.test.ts`

- [ ] **Step 1: Add failing MCP tests**

Assert the MCP tool list includes:

- `orient`
- `packet_get`

Then call each tool against a temp project and assert bounded JSON output.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx vitest run tests/mcp-server.test.ts
```

Expected: FAIL because tools are not registered.

- [ ] **Step 3: Register tools**

Tool input schemas:

```ts
orient: {
  includeRoots?: string[];
  budget?: "small" | "medium" | "large";
}

packet_get: {
  handle: string;
  maxSymbols?: number;
  maxSnippets?: number;
}
```

Rules:

- Reuse the session if MCP already has one.
- Use the server-configured root for confinement; do not accept per-request root overrides.
- Enforce the same root/path confinement as `get_file`, `get_symbol`, and `artifact_build`.
- Keep tools read-only.

- [ ] **Step 4: Run MCP tests**

Run:

```bash
npx vitest run tests/mcp-server.test.ts tests/agent-orient.test.ts tests/agent-packet.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/mcp/server.ts tests/mcp-server.test.ts
git commit -m "Expose agent packets over MCP"
```

## Task 6: Add Review Packet Handles

**Files:**

- Modify: `src/agent/orient.ts`
- Modify: `src/agent/packet.ts`
- Test: `tests/agent-packet.test.ts`

- [ ] **Step 1: Add failing review packet test**

Create a git fixture with a changed file. Run:

```ts
const orient = await orientCodegraph({
  root,
  includeRoots: ["src"],
  budget: "small",
  review: { base: "HEAD~1", head: "HEAD" },
});
```

Assert:

- orientation includes a `review:` handle.
- `getCodegraphPacket({ root, handle })` returns changed symbols and candidate tests.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx vitest run tests/agent-packet.test.ts
```

Expected: FAIL because review handles are not supported.

- [ ] **Step 3: Implement review packet handles**

Handle format:

```text
review:base=<encoded-ref>;head=<encoded-ref>
```

Rules:

- Encode refs safely.
- Reject handles missing base or head.
- Delegate to `buildReviewReport()` with bounded defaults equivalent to `review --summary`.
- Include follow-ups for `impact --pretty` and `review --summary`.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx vitest run tests/agent-packet.test.ts tests/review.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/orient.ts src/agent/packet.ts tests/agent-packet.test.ts
git commit -m "Add review packet handles"
```

## Task 7: Update Docs and Skill

**Files:**

- Modify: `README.md`
- Modify: `docs/cli.md`
- Modify: `docs/library-api.md`
- Modify: `docs/agent-workflows.md`
- Modify: `codegraph-skill/codegraph/SKILL.md`
- Test: `tests/package-metadata.test.ts`

- [ ] **Step 1: Update agent docs**

Add an agent workflow:

```bash
codegraph orient --root . --budget small --json
codegraph packet get <handle-from-orient> --json
```

Explain:

- Use `orient` for first-turn repo context.
- Use `packet get` for bounded follow-up evidence.
- Use `search` when the agent has a query but no handle.
- Use `explain` when the agent has a known file/symbol/SQL object and wants the existing direct command.

- [ ] **Step 2: Update skill first move**

In `codegraph-skill/codegraph/SKILL.md`, change the first move guidance to prefer:

```bash
codegraph doctor
codegraph orient --root . --budget small --json
```

Keep `inspect ./src --limit 20` as the fallback for humans or older installs.

- [ ] **Step 3: Run metadata and docs checks**

Run:

```bash
npx vitest run tests/package-metadata.test.ts
git diff --check
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/cli.md docs/library-api.md docs/agent-workflows.md codegraph-skill/codegraph/SKILL.md tests/package-metadata.test.ts
git commit -m "Document agent packet mode"
```

## Future Agentic Extensions

These are intentionally follow-on features after the base `orient` and `packet get` surfaces are stable.

### Edit packets

Add an optional packet shape for agent implementation planning. Given a review handle, impact item, file handle, or symbol handle, Codegraph should return:

- files to inspect first
- symbols to update
- direct references to verify
- candidate tests and copyable test commands when available
- risk reasons and omitted-count signals

This should package existing review, impact, dependency, and candidate-test fields. Do not create a separate analysis engine.

Implementation surface:

- `src/agent/packet.ts`
- `src/agent/explain.ts`
- `src/impact/types.ts`
- `src/review.ts`
- `src/mcp/server.ts`

### Stable-handle repo memory

Make stable handles useful as durable agent memory across sessions and artifact bundles:

- preserve file/symbol/chunk/SQL/graph/review handles in artifacts
- expose handle refresh diagnostics when a target moved, disappeared, or became ambiguous
- prefer handles over cursor positions in generated artifact questions
- allow MCP callers to refresh a packet after edits without rebuilding unrelated context

This extends the existing handle model; it should not require writable project state.

### Artifact question expansion

Expand `artifact build --questions` so generated questions cover:

- hotspots
- unresolved imports
- cycles
- duplicate groups
- public API surface
- SQL objects and SQL review context
- review-range findings when base/head are provided

Questions should include stable handles and copyable follow-up commands, not ambiguous bare names.

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
