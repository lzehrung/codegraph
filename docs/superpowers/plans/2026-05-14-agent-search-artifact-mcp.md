# Agent Search, Artifact, and MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified agent-facing workflow around Codegraph's existing graph, index, SQLite, review, and SQL support: `codegraph search`, `codegraph explain`, `codegraph artifact build`, and an MCP server exposing the same primitives.

**Architecture:** Build one shared service layer over existing deterministic artifacts, then attach CLI and MCP frontends to that layer. The first pass must not introduce embeddings, LLM calls, new persistent SQLite schema, or a second analysis engine; it should compose `buildProjectIndex`, `collectGraph`, symbol graphs, chunking, review/impact, and `writeGraphSqlite`.

**Tech Stack:** TypeScript, Vitest, current Codegraph CLI runtime, `better-sqlite3`, existing native Tree-sitter runtime, existing `@modelcontextprotocol/sdk` only if added explicitly as a dependency for MCP.

---

## Product Contract

The four additions are deliberately layered:

1. `codegraph search`: deterministic ranked search across files, symbols, chunks, SQL objects, and graph neighborhoods.
2. `codegraph explain`: compact architecture packet for one file, symbol, or SQL object, with optional changed-context.
3. `codegraph artifact build`: one command that writes `codegraph.sqlite`, graph JSON, optional `CODEGRAPH_REPORT.md`, suggested questions, and a manifest.
4. MCP server: typed tools over the same services: `search`, `get_file`, `get_symbol`, `goto`, `refs`, `deps`, `rdeps`, `path`, `impact`, `review`, and `query_sqlite`.

SQL extraction is not a gap in this plan. SQL must participate in search, explain, artifact build, and MCP from the existing SQL language support: `.sql` discovery, statement chunks, SQL object symbols, SQL-to-SQL graph edges, SQL navigation, SQL review context, and native-only operation. The remaining SQL limitation is current-schema reconstruction.

## Files And Boundaries

- Create `src/agent/search.ts`: search request/result types, deterministic scoring, result evidence, graph-neighborhood expansion.
- Create `src/agent/explain.ts`: file/symbol/SQL target explanation packets built from search/index/graph/review data.
- Create `src/agent/artifact.ts`: artifact build orchestration and manifest/report/question writers.
- Create `src/agent/session.ts`: shared in-process project session and cache used by CLI and MCP.
- Create `src/mcp/server.ts`: MCP tool registration and tool handlers over `src/agent/session.ts`.
- Modify `src/cli.ts`: dispatch `search`, `explain`, `artifact build`, and `mcp serve` commands.
- Modify `src/cli/help.ts`: include the new commands and examples.
- Modify `src/index.ts`: export library APIs and types for search, explain, artifact, and MCP/session helpers where public.
- Modify `docs/cli.md`: document new commands, flags, output contracts, and examples.
- Modify `docs/library-api.md`: document new TypeScript APIs.
- Modify `docs/agent-workflows.md`: document search-to-explain-to-impact workflows.
- Modify `codegraph-skill/codegraph/SKILL.md`: expose the new agent-facing commands.
- Modify `README.md`: add concise feature bullets and docs links only.
- Test `tests/agent-search.test.ts`: real fixture coverage for search behavior.
- Test `tests/agent-explain.test.ts`: real fixture coverage for explain packets.
- Test `tests/artifact-build.test.ts`: artifact outputs and manifest/report/question behavior.
- Test `tests/mcp-server.test.ts`: MCP handlers using a real temp repo and in-process session.
- Modify `tests/cli-regressions.test.ts`: command-level coverage for CLI output and errors.

## Shared Types

Define these in `src/agent/search.ts` and reuse them everywhere:

```ts
export type AgentSearchMode = "hybrid" | "symbol" | "path" | "text" | "graph" | "sql";

export type AgentSearchRequest = {
  root: string;
  query: string;
  mode?: AgentSearchMode;
  from?: string;
  depth?: number;
  limit?: number;
  includeSnippets?: boolean;
  includeChangedContext?: boolean;
  base?: string;
  head?: string;
};

export type AgentSearchResultKind = "file" | "symbol" | "chunk" | "sql_object" | "graph_node";

export type AgentSearchEvidence = {
  source: "path" | "symbol" | "chunk" | "graph" | "sql" | "review";
  label: string;
  file?: string;
  line?: number;
  snippet?: string;
};

export type AgentSearchResult = {
  handle: string;
  kind: AgentSearchResultKind;
  label: string;
  file: string;
  range?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  score: number;
  rankReasons: string[];
  evidence: AgentSearchEvidence[];
  neighbors: Array<{ relation: string; target: string; file?: string }>;
  followUps: string[];
};

export type AgentSearchResponse = {
  schemaVersion: 1;
  query: string;
  mode: AgentSearchMode;
  root: string;
  results: AgentSearchResult[];
};
```

Define these in `src/agent/explain.ts`:

```ts
export type AgentExplainTarget = {
  root: string;
  target: string;
  base?: string;
  head?: string;
  includeChangedContext?: boolean;
  maxDependencies?: number;
  maxSnippets?: number;
};

export type AgentExplanation = {
  schemaVersion: 1;
  target: {
    handle: string;
    kind: "file" | "symbol" | "sql_object";
    label: string;
    file: string;
  };
  summary: string[];
  symbols: Array<{ name: string; kind: string; handle: string; line?: number }>;
  dependencies: Array<{ file: string; reason: string }>;
  reverseDependencies: Array<{ file: string; reason: string }>;
  relatedSqlObjects: Array<{ name: string; file: string; relation: string }>;
  changedContext?: {
    changedFiles: string[];
    reviewTasks: Array<{ id: string; reason: string; summary: string }>;
    candidateTests: Array<{ file: string; confidence: string; reason: string }>;
  };
  followUps: string[];
};
```

## Task 1: Shared Agent Session

**Files:**
- Create: `src/agent/session.ts`
- Test: `tests/agent-session.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing session cache test**

Add `tests/agent-session.test.ts`:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../src/agent/session.js";

async function mkRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-session-"));
  await fs.writeFile(path.join(root, "util.ts"), "export function add(a: number, b: number) { return a + b; }\n");
  await fs.writeFile(path.join(root, "main.ts"), "import { add } from './util';\nexport const total = add(1, 2);\n");
  await fs.writeFile(path.join(root, "schema.sql"), "CREATE TABLE public.users (id int primary key);\n");
  return root;
}

describe("agent session", () => {
  it("loads index, graph, symbol graph, and SQL facts once for repeated agent operations", async () => {
    const root = await mkRepo();
    const session = createAgentSession({ root });

    const first = await session.loadProject();
    const second = await session.loadProject();

    expect(second).toBe(first);
    expect(first.files.some((file) => file.endsWith("schema.sql"))).toBeTruthy();
    expect(first.symbolGraph.nodes.size).toBeGreaterThan(0);
    expect(first.fileGraph.nodes.size).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run tests/agent-session.test.ts`

Expected: FAIL because `src/agent/session.ts` does not exist.

- [ ] **Step 3: Implement the session**

Create `src/agent/session.ts` with:

```ts
import { buildProjectIndex } from "../indexer.js";
import { collectGraph, buildSymbolGraphDetailed } from "../graphs.js";
import { listProjectFiles } from "../util.js";
import type { Graph } from "../types.js";
import type { ProjectIndex } from "../indexer/types.js";
import type { SymbolGraph } from "../graphs.js";

export type AgentProjectSnapshot = {
  root: string;
  files: string[];
  index: ProjectIndex;
  fileGraph: Graph;
  symbolGraph: SymbolGraph;
};

export type AgentSessionOptions = {
  root: string;
};

export type AgentSession = {
  loadProject: () => Promise<AgentProjectSnapshot>;
  invalidate: () => void;
};

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  let cached: Promise<AgentProjectSnapshot> | undefined;

  const loadProject = async (): Promise<AgentProjectSnapshot> => {
    if (cached) return cached;
    cached = (async () => {
      const files = await listProjectFiles(options.root);
      const index = await buildProjectIndex(options.root);
      const fileGraph = await collectGraph(options.root, files, { allFiles: files });
      const symbolGraph = buildSymbolGraphDetailed(index);
      return {
        root: options.root,
        files,
        index,
        fileGraph,
        symbolGraph,
      };
    })();
    return cached;
  };

  return {
    loadProject,
    invalidate: () => {
      cached = undefined;
    },
  };
}
```

Use the exact current exported type names from `src/indexer/types.ts`, `src/graphs.ts`, and `src/types.ts`. Do not use `any`.

- [ ] **Step 4: Export the session API**

Modify `src/index.ts`:

```ts
export { createAgentSession } from "./agent/session.js";
export type { AgentProjectSnapshot, AgentSession, AgentSessionOptions } from "./agent/session.js";
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx vitest run tests/agent-session.test.ts
npm run build
npm run lint
```

Expected: PASS.

Commit:

```bash
git add src/agent/session.ts src/index.ts tests/agent-session.test.ts
git commit -m "feat: add agent project session"
```

## Task 2: `codegraph search`

**Files:**
- Create: `src/agent/search.ts`
- Test: `tests/agent-search.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli/help.ts`
- Modify: `src/index.ts`
- Modify: `tests/cli-regressions.test.ts`

- [ ] **Step 1: Write failing library tests**

Add `tests/agent-search.test.ts`:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { searchCodegraph } from "../src/agent/search.js";

async function mkRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-search-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "auth.ts"), "export function validateUser(token: string) { return token.length > 0; }\n");
  await fs.writeFile(path.join(root, "src", "api.ts"), "import { validateUser } from './auth';\nexport function handleLogin(token: string) { return validateUser(token); }\n");
  await fs.writeFile(path.join(root, "schema.sql"), "CREATE TABLE public.users (id int primary key, email text);\nCREATE VIEW active_users AS SELECT id FROM public.users;\n");
  return root;
}

describe("agent search", () => {
  it("ranks exact symbol, path, chunk, and graph evidence with follow-up commands", async () => {
    const root = await mkRepo();
    const response = await searchCodegraph({ root, query: "validate user auth", mode: "hybrid", limit: 5 });

    expect(response.schemaVersion).toBe(1);
    expect(response.results[0]?.label).toContain("validateUser");
    expect(response.results[0]?.rankReasons.length).toBeGreaterThan(0);
    expect(response.results[0]?.followUps.some((cmd) => cmd.includes("codegraph refs"))).toBeTruthy();
    expect(response.results.some((result) => result.file.endsWith("src/auth.ts"))).toBeTruthy();
  });

  it("includes SQL object results from .sql language support", async () => {
    const root = await mkRepo();
    const response = await searchCodegraph({ root, query: "public users", mode: "sql", limit: 5 });

    expect(response.results.some((result) => result.kind === "sql_object" && result.label.includes("public.users"))).toBeTruthy();
    expect(response.results.every((result) => result.score > 0)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run tests/agent-search.test.ts`

Expected: FAIL because `searchCodegraph` does not exist.

- [ ] **Step 3: Implement deterministic search**

Create `src/agent/search.ts` using the shared types above.

Implementation requirements:

- Build through `createAgentSession({ root }).loadProject()` for this task.
- Score path matches, symbol-name matches, docstring/chunk matches, graph-neighborhood matches, and SQL object matches.
- Keep scoring deterministic: no random values, no timing-sensitive ordering.
- Sort by score descending, then label ascending, then file ascending.
- Generate stable handles:
  - File: `file:<relative path>`
  - Symbol: `symbol:<symbol id>`
  - SQL object: `sql:<object name>:<relative path>:<line>`
- Include `rankReasons`, `evidence`, `neighbors`, and `followUps`.
- Do not add a SQLite schema change in this task.

The public function signature must be:

```ts
export async function searchCodegraph(request: AgentSearchRequest): Promise<AgentSearchResponse>;
```

- [ ] **Step 4: Add CLI command**

Modify `src/cli.ts` command dispatch:

```ts
if (cmd === "search") {
  const query = args.find((arg) => !arg.startsWith("--"));
  if (!query) {
    writeStderrLine('Usage: search "<query>" [--root <path>] [--mode hybrid|symbol|path|text|graph|sql] [--limit <n>] [--json]');
    return exitCli(1);
  }
  const response = await searchCodegraph({
    root: projectRootFs,
    query,
    mode,
    limit,
    includeSnippets,
  });
  if (json) writeJSONLine(response);
  else writeStdoutLine(formatAgentSearchResponse(response));
  return;
}
```

Implement the command with the same option parsing style used by neighboring commands in `src/cli.ts`. The required behavior is exactly the usage string, request fields, JSON output, and text output described above.

- [ ] **Step 5: Add CLI regression coverage**

Append to `tests/cli-regressions.test.ts`:

```ts
it("search returns ranked agent-ready results", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cli-search-"));
  await fsp.writeFile(path.join(root, "auth.ts"), "export function validateUser(token: string) { return token.length > 0; }\n");
  await fsp.writeFile(path.join(root, "main.ts"), "import { validateUser } from './auth';\nexport const ok = validateUser('token');\n");

  const stdout = await runCliCommand(["search", "validate user", "--root", root, "--json"]);
  const response = JSON.parse(stdout) as { results: Array<{ label: string; rankReasons: string[]; followUps: string[] }> };

  expect(response.results[0]?.label).toContain("validateUser");
  expect(response.results[0]?.rankReasons.length).toBeGreaterThan(0);
  expect(response.results[0]?.followUps.some((cmd) => cmd.includes("codegraph refs"))).toBeTruthy();
});
```

- [ ] **Step 6: Update exports, help, docs, and skill**

Export from `src/index.ts`:

```ts
export { searchCodegraph } from "./agent/search.js";
export type {
  AgentSearchEvidence,
  AgentSearchMode,
  AgentSearchRequest,
  AgentSearchResponse,
  AgentSearchResult,
  AgentSearchResultKind,
} from "./agent/search.js";
```

Update `src/cli/help.ts`, `docs/cli.md`, `docs/library-api.md`, `docs/agent-workflows.md`, `README.md`, and `codegraph-skill/codegraph/SKILL.md` with concise examples.

- [ ] **Step 7: Verify and commit**

Run:

```bash
npx vitest run tests/agent-search.test.ts tests/cli-regressions.test.ts
npm run build
npm run lint
npm run test:ci
```

Expected: PASS.

Commit:

```bash
git add src/agent/search.ts src/cli.ts src/cli/help.ts src/index.ts tests/agent-search.test.ts tests/cli-regressions.test.ts README.md docs/cli.md docs/library-api.md docs/agent-workflows.md codegraph-skill/codegraph/SKILL.md
git commit -m "feat: add agent search"
```

## Task 3: `codegraph explain`

**Files:**
- Create: `src/agent/explain.ts`
- Test: `tests/agent-explain.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli/help.ts`
- Modify: `src/index.ts`
- Modify: `tests/cli-regressions.test.ts`

- [ ] **Step 1: Write failing explain tests**

Add `tests/agent-explain.test.ts`:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { explainCodegraphTarget } from "../src/agent/explain.js";

async function mkRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-explain-"));
  await fs.writeFile(path.join(root, "users.sql"), "CREATE TABLE public.users (id int primary key);\n");
  await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
  await fs.writeFile(path.join(root, "api.ts"), "import { validateUser } from './auth';\nexport function handler(id: number) { return validateUser(id); }\n");
  return root;
}

describe("agent explain", () => {
  it("explains a file with symbols, dependencies, reverse dependencies, and follow-ups", async () => {
    const root = await mkRepo();
    const explanation = await explainCodegraphTarget({ root, target: "auth.ts" });

    expect(explanation.schemaVersion).toBe(1);
    expect(explanation.target.file).toBe("auth.ts");
    expect(explanation.symbols.some((symbol) => symbol.name === "validateUser")).toBeTruthy();
    expect(explanation.reverseDependencies.some((entry) => entry.file === "api.ts")).toBeTruthy();
    expect(explanation.followUps.some((cmd) => cmd.includes("codegraph refs"))).toBeTruthy();
  });

  it("explains SQL objects without claiming current-schema reconstruction", async () => {
    const root = await mkRepo();
    const explanation = await explainCodegraphTarget({ root, target: "public.users" });

    expect(explanation.target.kind).toBe("sql_object");
    expect(explanation.relatedSqlObjects.some((entry) => entry.name === "public.users")).toBeTruthy();
    expect(explanation.summary.join(" ")).not.toContain("current schema");
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run tests/agent-explain.test.ts`

Expected: FAIL because `explainCodegraphTarget` does not exist.

- [ ] **Step 3: Implement explain packets**

Create `src/agent/explain.ts`.

Implementation requirements:

- Resolve `target` using search handles, file paths, symbol names, and SQL object names.
- For files, include local symbols, dependencies, reverse dependencies, hotspots when relevant, and follow-ups.
- For symbols, include defining file, references, dependencies around the file, and follow-ups.
- For SQL objects, use existing SQL object symbols/facts and explicitly avoid current-schema reconstruction claims.
- If `includeChangedContext` plus `base`/`head` are provided, call existing review/impact code and include compact changed context.
- Keep payload bounded by `maxDependencies` and `maxSnippets`.

The public function signature must be:

```ts
export async function explainCodegraphTarget(request: AgentExplainTarget): Promise<AgentExplanation>;
```

- [ ] **Step 4: Add CLI command and tests**

Add `codegraph explain <file|symbol|sql-object> [--root <path>] [--changed-context --base <rev> --head <rev>] [--json]`.

Append CLI regression:

```ts
it("explain returns compact architecture context", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cli-explain-"));
  await fsp.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
  await fsp.writeFile(path.join(root, "api.ts"), "import { validateUser } from './auth';\nexport const ok = validateUser(1);\n");

  const stdout = await runCliCommand(["explain", "auth.ts", "--root", root, "--json"]);
  const response = JSON.parse(stdout) as { target: { file: string }; symbols: Array<{ name: string }>; reverseDependencies: Array<{ file: string }> };

  expect(response.target.file).toBe("auth.ts");
  expect(response.symbols.some((symbol) => symbol.name === "validateUser")).toBeTruthy();
  expect(response.reverseDependencies.some((entry) => entry.file === "api.ts")).toBeTruthy();
});
```

- [ ] **Step 5: Update exports, help, docs, and skill**

Export from `src/index.ts`:

```ts
export { explainCodegraphTarget } from "./agent/explain.js";
export type { AgentExplanation, AgentExplainTarget } from "./agent/explain.js";
```

Update `src/cli/help.ts`, `docs/cli.md`, `docs/library-api.md`, `docs/agent-workflows.md`, `README.md`, and `codegraph-skill/codegraph/SKILL.md`.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npx vitest run tests/agent-explain.test.ts tests/cli-regressions.test.ts tests/review.test.ts
npm run build
npm run lint
npm run test:ci
```

Expected: PASS.

Commit:

```bash
git add src/agent/explain.ts src/cli.ts src/cli/help.ts src/index.ts tests/agent-explain.test.ts tests/cli-regressions.test.ts README.md docs/cli.md docs/library-api.md docs/agent-workflows.md codegraph-skill/codegraph/SKILL.md
git commit -m "feat: add agent explain"
```

## Task 4: `codegraph artifact build`

**Files:**
- Create: `src/agent/artifact.ts`
- Test: `tests/artifact-build.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli/help.ts`
- Modify: `src/index.ts`
- Modify: `tests/cli-regressions.test.ts`

- [ ] **Step 1: Write failing artifact tests**

Add `tests/artifact-build.test.ts`:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodegraphArtifact } from "../src/agent/artifact.js";

describe("artifact build", () => {
  it("writes sqlite, graph JSON, optional report, questions, and manifest from real project logic", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-"));
    const outDir = path.join(root, "codegraph-out");
    await fs.writeFile(path.join(root, "users.sql"), "CREATE TABLE public.users (id int primary key);\n");
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    await fs.writeFile(path.join(root, "api.ts"), "import { validateUser } from './auth';\nexport const ok = validateUser(1);\n");

    const artifact = await buildCodegraphArtifact({ root, outDir, sqlite: true, graphJson: true, report: true, questions: true });

    expect(artifact.manifestPath.endsWith("manifest.json")).toBeTruthy();
    expect(await fs.stat(path.join(outDir, "codegraph.sqlite"))).toBeTruthy();
    expect(await fs.stat(path.join(outDir, "graph.json"))).toBeTruthy();
    expect(await fs.stat(path.join(outDir, "CODEGRAPH_REPORT.md"))).toBeTruthy();
    expect(await fs.stat(path.join(outDir, "questions.json"))).toBeTruthy();

    const manifest = JSON.parse(await fs.readFile(artifact.manifestPath, "utf8")) as {
      schemaVersion: number;
      artifacts: Record<string, string>;
      sql: { supported: boolean; limitation: string };
    };

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.artifacts.sqlite).toBe("codegraph.sqlite");
    expect(manifest.sql.supported).toBeTruthy();
    expect(manifest.sql.limitation).toContain("current-schema reconstruction");
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run tests/artifact-build.test.ts`

Expected: FAIL because `buildCodegraphArtifact` does not exist.

- [ ] **Step 3: Implement artifact build**

Create `src/agent/artifact.ts`.

Implementation requirements:

- Default output directory: `codegraph-out`.
- Default artifact names:
  - `codegraph.sqlite`
  - `graph.json`
  - `CODEGRAPH_REPORT.md`
  - `questions.json`
  - `manifest.json`
- Use existing `writeGraphSqlite` for SQLite output.
- Use the existing graph JSON shape emitted by the current `graph --json` path; do not invent a second graph schema unless the manifest clearly identifies it.
- Generate `CODEGRAPH_REPORT.md` deterministically from existing graph/index/search/explain data.
- Generate suggested questions from deterministic templates, such as:
  - "Which files depend on <hotspot>?"
  - "Where is <exported symbol> referenced?"
  - "What SQL objects are related to <sql object>?"
- Do not change SQLite schema. If implementation needs new SQLite tables, add explicit migration code and a regression test in `tests/sqlite.test.ts` starting from an older schema.

The public function signature must be:

```ts
export type CodegraphArtifactBuildRequest = {
  root: string;
  outDir?: string;
  sqlite?: boolean;
  graphJson?: boolean;
  report?: boolean;
  questions?: boolean;
  force?: boolean;
};

export type CodegraphArtifactBuildResult = {
  schemaVersion: 1;
  root: string;
  outDir: string;
  manifestPath: string;
  artifacts: Record<string, string>;
};

export async function buildCodegraphArtifact(request: CodegraphArtifactBuildRequest): Promise<CodegraphArtifactBuildResult>;
```

- [ ] **Step 4: Add CLI command and tests**

Add:

```bash
codegraph artifact build --root . --out codegraph-out --sqlite --json --report --questions
```

CLI behavior:

- `--sqlite`, `--json`, `--report`, and `--questions` enable artifacts.
- If no artifact flags are provided, default to SQLite, graph JSON, questions, and report.
- Refuse to overwrite a non-empty output directory unless `--force` is passed.
- Print the manifest path in text mode and the full result in JSON mode.

Append CLI regression:

```ts
it("artifact build writes an agent-ready artifact bundle", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-cli-artifact-"));
  const outDir = path.join(root, "out");
  await fsp.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");

  const stdout = await runCliCommand(["artifact", "build", "--root", root, "--out", outDir, "--json"]);
  const result = JSON.parse(stdout) as { manifestPath: string; artifacts: Record<string, string> };

  expect(result.manifestPath.endsWith("manifest.json")).toBeTruthy();
  expect(result.artifacts.sqlite).toBe("codegraph.sqlite");
  expect(await fsp.stat(path.join(outDir, "manifest.json"))).toBeTruthy();
});
```

- [ ] **Step 5: Update exports, help, docs, and skill**

Export from `src/index.ts`:

```ts
export { buildCodegraphArtifact } from "./agent/artifact.js";
export type { CodegraphArtifactBuildRequest, CodegraphArtifactBuildResult } from "./agent/artifact.js";
```

Update `src/cli/help.ts`, `docs/cli.md`, `docs/library-api.md`, `docs/agent-workflows.md`, `README.md`, and `codegraph-skill/codegraph/SKILL.md`.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npx vitest run tests/artifact-build.test.ts tests/sqlite.test.ts tests/cli-regressions.test.ts
npm run build
npm run lint
npm run test:ci
```

Expected: PASS.

Commit:

```bash
git add src/agent/artifact.ts src/cli.ts src/cli/help.ts src/index.ts tests/artifact-build.test.ts tests/cli-regressions.test.ts README.md docs/cli.md docs/library-api.md docs/agent-workflows.md codegraph-skill/codegraph/SKILL.md
git commit -m "feat: add artifact build"
```

## Task 5: MCP Server

**Files:**
- Create: `src/mcp/server.ts`
- Test: `tests/mcp-server.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/cli.ts`
- Modify: `src/cli/help.ts`
- Modify: `src/index.ts`
- Modify: `tests/cli-regressions.test.ts`

- [ ] **Step 1: Decide dependency boundary**

Use `@modelcontextprotocol/sdk` only if the repo does not already expose an MCP helper. Add it as a normal runtime dependency because the published CLI command needs it.

Run:

```bash
npm install @modelcontextprotocol/sdk
```

Expected: `package.json` and `package-lock.json` are updated. Do not hand-edit lockfile dependency entries.

- [ ] **Step 2: Write failing MCP handler tests**

Add `tests/mcp-server.test.ts`:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCodegraphMcpHandlers } from "../src/mcp/server.js";

describe("codegraph MCP handlers", () => {
  it("reuses one session across search, get_symbol, refs, and query_sqlite handlers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    await fs.writeFile(path.join(root, "api.ts"), "import { validateUser } from './auth';\nexport const ok = validateUser(1);\n");

    const handlers = createCodegraphMcpHandlers({ root });
    const search = await handlers.search({ query: "validate user", limit: 5 });
    const first = search.results[0];

    expect(first?.handle).toBeTruthy();

    const symbol = await handlers.get_symbol({ handle: first.handle });
    expect(symbol.label).toContain("validateUser");

    const refs = await handlers.refs({ handle: first.handle });
    expect(refs.references.some((ref) => ref.file === "api.ts")).toBeTruthy();
  });

  it("keeps query_sqlite read-only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");

    const handlers = createCodegraphMcpHandlers({ root });
    await handlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true, graphJson: true });

    await expect(handlers.query_sqlite({ query: "DELETE FROM symbols RETURNING name;" })).rejects.toThrow(/read-only/i);
  });
});
```

- [ ] **Step 3: Run the failing tests**

Run: `npx vitest run tests/mcp-server.test.ts`

Expected: FAIL because `src/mcp/server.ts` does not exist.

- [ ] **Step 4: Implement MCP handlers independent of transport**

Create `src/mcp/server.ts`.

Implementation requirements:

- Export `createCodegraphMcpHandlers(options)` for direct tests.
- Export `serveCodegraphMcp(options)` for stdio transport.
- Use `createAgentSession` internally so multiple tool calls reuse the same in-process snapshot.
- Expose these handlers:
  - `search`
  - `get_file`
  - `get_symbol`
  - `goto`
  - `refs`
  - `deps`
  - `rdeps`
  - `path`
  - `impact`
  - `review`
  - `query_sqlite`
  - `artifact_build`
- Return bounded, agent-ready responses by default. Include `limit` options for large lists.
- Ensure `query_sqlite` uses existing read-only SQL validation.
- Ensure `get_file` rejects paths outside `root`.

Use this exported shape:

```ts
export type CodegraphMcpServerOptions = {
  root: string;
  artifactPath?: string;
  readOnly?: boolean;
};

export function createCodegraphMcpHandlers(options: CodegraphMcpServerOptions): CodegraphMcpHandlers;

export async function serveCodegraphMcp(options: CodegraphMcpServerOptions): Promise<void>;
```

- [ ] **Step 5: Add CLI command**

Add:

```bash
codegraph mcp serve --root . --artifact codegraph-out --stdio
```

CLI behavior:

- Default to stdio.
- Default to read-only tools, except `artifact_build` is allowed only when explicitly enabled by `--allow-build`.
- Never expose arbitrary shell execution.
- Use stable handles returned by `search` and `explain` for follow-up tools.

- [ ] **Step 6: Add CLI smoke test**

Append to `tests/cli-regressions.test.ts`:

```ts
it("mcp serve help documents read-only agent tools", async () => {
  const stdout = await runCliCommand(["mcp", "serve", "--help"]);

  expect(stdout).toContain("search");
  expect(stdout).toContain("query_sqlite");
  expect(stdout).toContain("read-only");
});
```

- [ ] **Step 7: Update exports, help, docs, and skill**

Export from `src/index.ts`:

```ts
export { createCodegraphMcpHandlers, serveCodegraphMcp } from "./mcp/server.js";
export type { CodegraphMcpServerOptions } from "./mcp/server.js";
```

Update `src/cli/help.ts`, `docs/cli.md`, `docs/library-api.md`, `docs/agent-workflows.md`, `README.md`, and `codegraph-skill/codegraph/SKILL.md`.

- [ ] **Step 8: Verify and commit**

Run:

```bash
npx vitest run tests/mcp-server.test.ts tests/agent-search.test.ts tests/agent-explain.test.ts tests/artifact-build.test.ts tests/cli-regressions.test.ts
npm run build
npm run lint
npm run test:ci
```

Expected: PASS.

Commit:

```bash
git add package.json package-lock.json src/mcp/server.ts src/cli.ts src/cli/help.ts src/index.ts tests/mcp-server.test.ts tests/cli-regressions.test.ts README.md docs/cli.md docs/library-api.md docs/agent-workflows.md codegraph-skill/codegraph/SKILL.md
git commit -m "feat: add MCP server"
```

## Task 6: Review, Performance, And Documentation Tightening

**Files:**
- Modify: `graphify-comparison.md`
- Modify: `docs/agent-workflows.md`
- Modify: `docs/cli.md`
- Modify: `docs/library-api.md`
- Modify: `README.md`
- Modify: `codegraph-skill/codegraph/SKILL.md`
- Test: existing feature tests from Tasks 1-5

- [ ] **Step 1: Run self-review against Graphify gap**

Check these claims manually:

- `codegraph search` returns ranked, explainable results with follow-ups.
- `codegraph explain` returns compact architecture context and changed-context when requested.
- `codegraph artifact build` writes the one-command useful artifact bundle.
- MCP tools reuse the same service layer and support stable handles.
- SQL extraction is not described as a remaining gap.

- [ ] **Step 2: Run performance guard tests**

Add assertions to the existing tests rather than introducing synthetic benchmarks:

- Search should build/load the project once per call.
- MCP search followed by refs should reuse one session.
- Artifact build should call graph/index construction once and reuse outputs for SQLite/report/questions.

Use Vitest spies only around Codegraph-owned functions. Do not mock away indexing, graph collection, SQL facts, or CLI behavior in the primary business-logic tests.

- [ ] **Step 3: Verify public docs are concise and accurate**

Docs must say:

- Search is deterministic and vectorless.
- RAG integration remains optional/future unless implemented separately.
- MCP is an agent ergonomics and performance layer, not a separate analysis engine.
- SQL is supported as language input, but current-schema reconstruction is not claimed.
- SQLite query tools are read-only.

- [ ] **Step 4: Full verification**

Run:

```bash
npm run build
npm run lint
npm run test:ci
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Final commit**

Commit any review/doc/performance fixes:

```bash
git add graphify-comparison.md README.md docs/cli.md docs/library-api.md docs/agent-workflows.md codegraph-skill/codegraph/SKILL.md tests src
git commit -m "docs: tighten agent workflow documentation"
```

## Final Acceptance Criteria

- `codegraph search "auth user" --json` works on a real repo without a prebuilt artifact.
- `codegraph search "public users" --mode sql --json` returns SQL object evidence when `.sql` files define the object.
- `codegraph explain <file|symbol|sql-object> --json` returns bounded context with follow-up commands.
- `codegraph explain <target> --changed-context --base HEAD --head WORKTREE --json` includes compact review/impact context.
- `codegraph artifact build --root . --out codegraph-out --json` writes `manifest.json`, `codegraph.sqlite`, `graph.json`, `questions.json`, and optionally `CODEGRAPH_REPORT.md`.
- `codegraph mcp serve --root . --stdio` exposes typed tools for search, file/symbol inspection, navigation, dependencies, impact/review, and read-only SQLite querying.
- MCP follow-up calls can use stable handles from search/explain results.
- No SQL extraction gap remains in docs.
- No new SQLite schema is introduced unless migration code and older-schema regression tests are included.
- `npm run build`, `npm run lint`, and `npm run test:ci` pass.
