# Core Command Performance and Cache Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve `search`, `inspect`, and MCP warm-session performance by adding timing reports, making expensive duplicate inspection opt-in, adding a safe text-search Bloom prefilter, and adding opt-in automatic MCP cache sync.

**Architecture:** Keep the existing project index, agent session, and MCP handler boundaries. Add small hooks around them: command timing reports at CLI boundaries, duplicate detection behind `inspect --duplicates`, a conservative search prefilter that cannot hide valid results, and a cache sync controller that invalidates and warms one shared `AgentSession`.

**Tech Stack:** TypeScript, Node.js, Vitest, existing Codegraph disk cache, existing Bloom filters, existing `AgentSession`, existing MCP server.

---

## Current Baseline

Measured from the local `dist` CLI on 2026-07-03:

- `node ./dist/cli.js search search --root . --mode path --json`: about `0.505s`.
- `node ./dist/cli.js search search --root . --mode text --no-snippets --json`: about `8.862s`.
- `node ./dist/cli.js search search --root . --mode hybrid --no-snippets --json`: about `12.473s`.
- `node ./dist/cli.js inspect --root . ./src --limit 20 --json`: about `19.499s`.
- Repeated search through one `AgentSession` is much faster: text search dropped from about `2.203s` to `0.029s`, and hybrid search dropped from about `4.203s` to `0.329s`.

## Decisions

- Keep `search --mode path` fast path as-is.
- Add timing reports before more engine work.
- Change `inspect` so duplicate detection runs only with `--duplicates`.
- Add a safe Bloom prefilter only for exact identifier-like text queries.
- Improve MCP as the primary repeated-agent path with opt-in automatic cache sync.
- Do not rewrite search scoring in Rust until timing reports prove the JS loop is the bottleneck.

## File Structure

- Modify `src/cli/search.ts` for search timing report support.
- Modify `src/cli/inspect.ts` for inspect timing reports and `--duplicates`.
- Modify `src/cli.ts` to pass report wiring into `search`, `inspect`, and `hotspots` only where needed.
- Modify `src/cli/help.ts` and `docs/cli.md` for new `inspect --duplicates` and cache-sync flags.
- Modify `codegraph-skill/codegraph/SKILL.md` only if command flags or agent workflow guidance changes.
- Modify `src/agent/search.ts` for safe Bloom-filter text prefiltering.
- Modify `src/agent/session.ts` to expose fresh file-list fingerprinting for cache sync.
- Create `src/mcp/cacheSync.ts` for MCP cache sync policy and scheduling.
- Modify `src/mcp/server.ts` and `src/cli/mcp.ts` to wire cache sync into MCP handlers and serve options.
- Modify `tests/cli-command-modules.test.ts`, `tests/agent-search.test.ts`, `tests/mcp-server.test.ts`, and `tests/cache-invalidation.test.ts`.

---

### Task 1: Add Timing Reports for `search`

**Files:**

- Modify: `src/cli/search.ts`
- Modify: `src/cli.ts`
- Test: `tests/cli-command-modules.test.ts`

- [ ] **Step 1: Write the failing CLI report test**

Add a test near the existing search command tests in `tests/cli-command-modules.test.ts`:

```ts
test("writes search command timing reports", async () => {
  const root = await mkTmpDir("codegraph-search-report-");
  await fsp.writeFile(path.join(root, "auth.ts"), "export const authToken = 1;\n", "utf8");
  const reportPath = path.join(root, "search-report.json");

  const result = await captureCli([
    "search",
    "authToken",
    "--root",
    root,
    "--mode",
    "symbol",
    "--json",
    "--report-file",
    reportPath,
  ]);

  expect(result.exitCode).toBeUndefined();
  const report = readJsonRecord(JSON.parse(await fsp.readFile(reportPath, "utf8")));
  expect(report.command).toBe("search");
  const timings = readJsonRecord(report.timings);
  expect(timings.commandMs).toEqual(expect.any(Number));
  expect(timings.totalMs).toEqual(expect.any(Number));
  expect(readJsonRecord(report.index).timings).toBeDefined();
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
npx vitest run tests/cli-command-modules.test.ts -t "writes search command timing reports"
```

Expected: FAIL because `search` ignores `--report-file`.

- [ ] **Step 3: Implement minimal report plumbing**

In `src/cli/search.ts`, extend `SearchCommandContext` with optional report fields:

```ts
import { performance } from "node:perf_hooks";
import type { CommandReport } from "./context.js";

export type SearchCommandContext = CliAgentCommandContext & {
  commandReport?: CommandReport;
  reportFile?: string;
  writeCommandReport?: (report: CommandReport, reportFile: string | undefined) => Promise<void>;
};
```

Wrap the command body with timing:

```ts
const commandStart = performance.now();
const response = await searchCodegraph({
  root: context.root,
  query,
  mode: parseAgentSearchMode(context.getOpt("--mode")),
  ...(context.buildOptions ? { buildOptions: context.buildOptions } : {}),
  limit: parsePositiveIntegerOption(context.getOpt("--limit"), "--limit", 20),
  includeSnippets: !context.hasFlag("--no-snippets"),
  ...(from !== undefined ? { from } : {}),
  ...(depthRaw !== undefined ? { depth: parsePositiveIntegerOption(depthRaw, "--depth", 1) } : {}),
});

if (context.commandReport) {
  context.commandReport.timings.commandMs = Math.round(performance.now() - commandStart);
  context.commandReport.timings.totalMs = context.commandReport.timings.commandMs;
  await context.writeCommandReport?.(context.commandReport, context.reportFile);
}
```

In `src/cli.ts`, create a `BuildReport` when report output is enabled and pass it through `buildOptions.report` for `search`:

```ts
if (cmd === "search") {
  const indexReport: BuildReport | undefined = reportEnabled ? { timings: {} } : undefined;
  const commandReport: CommandReport | undefined = reportEnabled
    ? { command: "search", timings: {}, ...(indexReport ? { index: indexReport } : {}) }
    : undefined;
  const buildOptions = {
    ...buildAgentOptions(),
    ...(indexReport ? { report: indexReport } : {}),
  };
  await handleSearchCommand({
    positionals: parsed.positionals,
    root: projectRootFs,
    buildOptions,
    commandReport,
    reportFile,
    writeCommandReport,
    getOpt,
    hasFlag,
    writeJSONLine,
    writeStdoutLine,
    writeStderrLine,
    exit: exitCli,
  });
  return;
}
```

- [ ] **Step 4: Verify search report passes**

Run:

```powershell
npx vitest run tests/cli-command-modules.test.ts -t "writes search command timing reports"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/cli/search.ts src/cli.ts tests/cli-command-modules.test.ts
git commit -m "feat: add search timing report"
```

---

### Task 2: Add Timing Reports for `inspect`

**Files:**

- Modify: `src/cli/inspect.ts`
- Modify: `src/cli.ts`
- Test: `tests/cli-command-modules.test.ts`

- [ ] **Step 1: Write the failing inspect report test**

Add this test near existing CLI report tests:

```ts
test("writes inspect command timing reports", async () => {
  const root = await mkTmpDir("codegraph-inspect-report-");
  await fsp.mkdir(path.join(root, "src"));
  await fsp.writeFile(path.join(root, "src", "entry.ts"), "export const entry = 1;\n", "utf8");
  const reportPath = path.join(root, "inspect-report.json");

  const result = await captureCli(["inspect", "--root", root, "src", "--report-file", reportPath]);

  expect(result.exitCode).toBeUndefined();
  const report = readJsonRecord(JSON.parse(await fsp.readFile(reportPath, "utf8")));
  expect(report.command).toBe("inspect");
  expect(readJsonRecord(report.timings).resolveFilesMs).toEqual(expect.any(Number));
  expect(readJsonRecord(report.timings).commandMs).toEqual(expect.any(Number));
  expect(readJsonRecord(report.index).timings).toBeDefined();
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
npx vitest run tests/cli-command-modules.test.ts -t "writes inspect command timing reports"
```

Expected: FAIL because `inspect` has no report plumbing.

- [ ] **Step 3: Implement minimal report plumbing**

In `src/cli/inspect.ts`, import `performance`, `CommandReport`, and `BuildReport`.

Extend `InspectCommandContext`:

```ts
  reportEnabled: boolean;
  reportFile?: string;
  writeCommandReport: (report: CommandReport, reportFile: string | undefined) => Promise<void>;
```

Pass a report into `buildInspectReport`:

```ts
const commandReport: CommandReport | undefined = context.reportEnabled
  ? { command: "inspect", timings: {}, index: { timings: {} } }
  : undefined;
const resolveStart = performance.now();
const files = await context.resolveFilesFromRoots();
if (commandReport) {
  commandReport.timings.resolveFilesMs = Math.round(performance.now() - resolveStart);
}
const commandStart = performance.now();
const report = await buildInspectReport(
  context.projectRootFs,
  context.includeRootsAbs,
  files,
  context.discoveryOptions,
  context.graphOptions,
  cache,
  context.nativeMode,
  context.workerOpts,
  context.progressHandler,
  limit,
  context.writeStderrLine,
  commandReport?.index,
  context.hasFlag("--duplicates"),
);
if (commandReport) {
  commandReport.timings.commandMs = Math.round(performance.now() - commandStart);
  commandReport.timings.totalMs = commandReport.timings.commandMs;
  await context.writeCommandReport(commandReport, context.reportFile);
}
```

In `src/cli.ts`, pass `reportEnabled`, `reportFile`, and `writeCommandReport` into `handleInspectCommand`.

- [ ] **Step 4: Verify inspect report passes**

Run:

```powershell
npx vitest run tests/cli-command-modules.test.ts -t "writes inspect command timing reports"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/cli/inspect.ts src/cli.ts tests/cli-command-modules.test.ts
git commit -m "feat: add inspect timing report"
```

---

### Task 3: Make `inspect` Duplicate Detection Opt-In

**Files:**

- Modify: `src/cli/inspect.ts`
- Modify: `src/cli/help.ts`
- Modify: `docs/cli.md`
- Modify: `codegraph-skill/codegraph/SKILL.md` if inspect guidance mentions duplicate output
- Test: `tests/cli-command-modules.test.ts`

- [ ] **Step 1: Write failing tests for default and opt-in behavior**

Add tests:

```ts
test("inspect skips duplicate detection by default", async () => {
  const root = await mkTmpDir("codegraph-inspect-no-dupes-");
  await fsp.writeFile(path.join(root, "entry.ts"), "export const entry = 1;\n", "utf8");

  const result = await captureCli(["inspect", "--root", root, "--json"]);

  expect(result.exitCode).toBeUndefined();
  const report = readJsonRecord(JSON.parse(result.stdout));
  expect(report.duplicates).toEqual({ enabled: false });
});

test("inspect runs duplicate detection with --duplicates", async () => {
  const root = await mkTmpDir("codegraph-inspect-dupes-");
  await fsp.writeFile(
    path.join(root, "one.ts"),
    "export function one() { const value = 1; return value + value + value; }\n",
    "utf8",
  );
  await fsp.writeFile(
    path.join(root, "two.ts"),
    "export function two() { const value = 1; return value + value + value; }\n",
    "utf8",
  );

  const result = await captureCli(["inspect", "--root", root, "--duplicates", "--json"]);

  expect(result.exitCode).toBeUndefined();
  const report = readJsonRecord(JSON.parse(result.stdout));
  const duplicates = readJsonRecord(report.duplicates);
  expect(duplicates.enabled).toBe(true);
  expect(duplicates.total).toEqual(expect.any(Number));
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
npx vitest run tests/cli-command-modules.test.ts -t "inspect .*duplicate"
```

Expected: FAIL because `inspect` always runs duplicate detection and does not expose `enabled`.

- [ ] **Step 3: Change the inspect report shape**

In `src/cli/inspect.ts`, change `InspectReport["duplicates"]` to a union:

```ts
  duplicates:
    | { enabled: false }
    | {
        enabled: true;
        total: number;
        omitted: number;
        minConfidence: DuplicateConfidence;
        top: DuplicateOpportunitySummary[];
      };
```

In `buildInspectReport`, add `includeDuplicates: boolean` and wrap duplicate detection:

```ts
const duplicates: InspectReport["duplicates"] = includeDuplicates
  ? {
      enabled: true,
      total:
        duplicateResult.groups.length +
        duplicateResult.omittedCounts.groups +
        duplicateResult.omittedCounts.candidatePairs,
      omitted: duplicateResult.omittedCounts.groups + duplicateResult.omittedCounts.candidatePairs,
      minConfidence: duplicateMinConfidence,
      top: duplicateResult.groups.map(summarizeDuplicateGroup),
    }
  : { enabled: false };
```

Use `if` blocks instead of a nested ternary if the expression grows.

- [ ] **Step 4: Update help and docs**

Add `--duplicates` to `INSPECT_HELP_TEXT` in `src/cli/help.ts`.

Update `docs/cli.md` to state:

```markdown
`inspect` skips duplicate detection by default. Pass `--duplicates` when you want duplicate opportunities in the inspect report.
```

If `codegraph-skill/codegraph/SKILL.md` says `inspect` always returns duplicates, update it to the same short wording.

- [ ] **Step 5: Verify tests**

Run:

```powershell
npx vitest run tests/cli-command-modules.test.ts -t "inspect .*duplicate"
npx vitest run tests/cli-command-modules.test.ts -t "documents"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/cli/inspect.ts src/cli/help.ts docs/cli.md codegraph-skill/codegraph/SKILL.md tests/cli-command-modules.test.ts
git commit -m "perf: make inspect duplicates opt-in"
```

---

### Task 4: Add Safe Bloom Prefilter for Text Search

**Files:**

- Modify: `src/agent/search.ts`
- Test: `tests/agent-search.test.ts`

- [ ] **Step 1: Write failing tests for safe skip behavior**

Add tests:

```ts
it("uses Bloom filters to skip text reads for exact identifier text search", async () => {
  const root = await mkRepo();
  const authFile = path.join(root, "src", "auth.ts");
  const docsFile = path.join(root, "docs", "agent-search.md");
  const response = await searchCodegraph({ root, query: "validateUser", mode: "text", limit: 10 });

  expect(response.results.some((result) => result.file === "src/auth.ts")).toBe(true);

  const readSpy = vi.spyOn(fs, "readFile");
  await searchCodegraph({ root, query: "validateUser", mode: "text", limit: 10 });
  const docsReads = readSpy.mock.calls.filter((call) => call[0] === docsFile);
  const authReads = readSpy.mock.calls.filter((call) => call[0] === authFile);

  expect(authReads.length).toBeGreaterThan(0);
  expect(docsReads).toHaveLength(0);
});

it("does not use Bloom filters for natural language text search", async () => {
  const root = await mkRepo();
  const response = await searchCodegraph({
    root,
    query: "natural language search",
    mode: "text",
    limit: 10,
  });

  expect(response.results.some((result) => result.file === "docs/agent-search.md")).toBe(true);
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
npx vitest run tests/agent-search.test.ts -t "Bloom filters|natural language"
```

Expected: FAIL because text search reads all searchable files before filtering.

- [ ] **Step 3: Add exact identifier query tracking**

In `SearchQueryTerms`, add:

```ts
  exactIdentifier?: string;
```

In `buildQueryTerms`, set it only when the original query is one identifier:

```ts
const trimmed = input.trim();
const exactIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed) ? trimmed : undefined;
return {
  tokens: Array.from(new Set(tokens)),
  normalizedPhrase: normalized,
  identifierLike: isIdentifierLikeQuery(input),
  ...(exactIdentifier ? { exactIdentifier } : {}),
};
```

- [ ] **Step 4: Filter files before text reads**

In `addTextResults`, compute files once:

```ts
const files = textSearchCandidateFiles(snapshot, query);
for (const file of files) {
  const normalizedText = await getCachedNormalizedText(cache, file);
  if (!normalizedText) continue;
  if (!textCouldMatchNormalized(normalizedText, query.tokens)) continue;
  const relFile = normalizeAgentFilePath(snapshot.root, file);
  const documentationFile = isDocumentationFile(relFile);
  const chunks = await getCachedTextChunks(cache, file);
  for (const chunk of chunks) {
    const match = matchTokenScoreFromNormalized(chunk.normalizedText, query);
    if (match.score <= 0) continue;
    // Keep the existing result construction block unchanged below this point.
  }
}
```

Add:

```ts
function textSearchCandidateFiles(snapshot: AgentProjectSnapshot, query: SearchQueryTerms): string[] {
  if (!query.exactIdentifier || !snapshot.index.bloomFilters) return snapshot.files;
  return snapshot.index.bloomFilters.filterFiles(query.exactIdentifier, snapshot.files);
}
```

This is intentionally narrow. It avoids false negatives from camel-case normalization and case-sensitive Bloom entries.

- [ ] **Step 5: Verify search tests**

Run:

```powershell
npx vitest run tests/agent-search.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/agent/search.ts tests/agent-search.test.ts
git commit -m "perf: prefilter identifier text search"
```

---

### Task 5: Add Agent Session File Fingerprints

**Files:**

- Modify: `src/agent/session.ts`
- Test: `tests/agent-session.test.ts`

- [ ] **Step 1: Write failing session fingerprint tests**

Add tests:

```ts
it("computes a fresh file fingerprint without reusing cached file lists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-session-fingerprint-"));
  await fs.writeFile(path.join(root, "one.ts"), "export const one = 1;\n", "utf8");
  const session = createAgentSession({ root });

  const first = await session.fileFingerprint();
  await session.listFiles?.();
  await fs.writeFile(path.join(root, "two.ts"), "export const two = 2;\n", "utf8");
  const second = await session.fileFingerprint();

  expect(second).not.toBe(first);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
npx vitest run tests/agent-session.test.ts -t "fresh file fingerprint"
```

Expected: FAIL because `AgentSession` has no `fileFingerprint`.

- [ ] **Step 3: Export shared discovery helpers from session**

In `src/agent/session.ts`, extract the repeated config/discovery logic into a private helper:

```ts
async function resolveAgentDiscovery(options: AgentSessionOptions): Promise<ProjectFileDiscoveryOptions | undefined> {
  const useConfig = options.useConfig ?? true;
  const config = useConfig ? await loadCodegraphConfig(options.root) : {};
  const optionDiscovery = mergeDiscoveryOptions(options.buildOptions?.discovery, options.discovery);
  const discovery = mergeDiscoveryOptions(config.discovery, optionDiscovery);
  if (!hasDiscoveryOptions(discovery)) return undefined;
  return { ...discovery, globRoot: discovery.globRoot ?? options.root };
}
```

Use this helper in both `loadFiles` and `loadBase`.

- [ ] **Step 4: Add `fileFingerprint` to `AgentSession`**

Extend the type:

```ts
fileFingerprint: () => Promise<string>;
```

Implement it with fresh discovery:

```ts
const fileFingerprint = async (): Promise<string> => {
  const discoveryOptions = await resolveAgentDiscovery(options);
  const files = await listProjectFiles(options.root, undefined, discoveryOptions);
  return files
    .map((file) => normalizePath(file))
    .sort()
    .join("\n");
};
```

Import `normalizePath` from `../util/paths.js`.

- [ ] **Step 5: Verify session tests**

Run:

```powershell
npx vitest run tests/agent-session.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/agent/session.ts tests/agent-session.test.ts
git commit -m "feat: expose agent session file fingerprint"
```

---

### Task 6: Add MCP Cache Sync Controller

**Files:**

- Create: `src/mcp/cacheSync.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/mcp-server.test.ts`

- [ ] **Step 1: Write failing MCP sync tests**

Add tests:

```ts
it("auto-syncs MCP session on interval when file globs change", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-cache-sync-"));
  await fs.writeFile(path.join(root, "one.ts"), "export const oneSymbol = 1;\n", "utf8");
  const handlers = createCodegraphMcpHandlers({
    root,
    cacheSync: { mode: "interval", intervalMs: 1, warmup: "base" },
  });

  await handlers.search({ query: "oneSymbol", mode: "symbol", limit: 5 });
  await fs.writeFile(path.join(root, "two.ts"), "export const twoSymbol = 2;\n", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const result = await handlers.search({ query: "twoSymbol", mode: "symbol", limit: 5 });

  expect(result.results.some((entry) => entry.label === "twoSymbol")).toBe(true);
});

it("does not auto-sync MCP sessions when cache sync is off", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-cache-sync-off-"));
  await fs.writeFile(path.join(root, "one.ts"), "export const oneSymbol = 1;\n", "utf8");
  const handlers = createCodegraphMcpHandlers({ root });

  await handlers.search({ query: "oneSymbol", mode: "symbol", limit: 5 });
  await fs.writeFile(path.join(root, "two.ts"), "export const twoSymbol = 2;\n", "utf8");
  const result = await handlers.search({ query: "twoSymbol", mode: "symbol", limit: 5 });

  expect(result.results.some((entry) => entry.label === "twoSymbol")).toBe(false);
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
npx vitest run tests/mcp-server.test.ts -t "cache sync"
```

Expected: FAIL because MCP has only manual `refresh_index`.

- [ ] **Step 3: Create `src/mcp/cacheSync.ts`**

Add:

```ts
import type { AgentSession } from "../agent/session.js";
import type { CodegraphMcpWarmupMode } from "./server.js";

export type CodegraphMcpCacheSyncMode = "off" | "lifecycle" | "interval" | "auto";

export type CodegraphMcpCacheSyncOptions = {
  mode?: CodegraphMcpCacheSyncMode;
  intervalMs?: number;
  warmup?: CodegraphMcpWarmupMode;
};

export type CodegraphMcpCacheSyncController = {
  beforeToolCall: () => Promise<void>;
  onLifecycle: () => Promise<void>;
};
```

Implement:

```ts
const DEFAULT_INTERVAL_MS = 30_000;

export function createCodegraphMcpCacheSyncController(
  session: AgentSession,
  options: CodegraphMcpCacheSyncOptions | undefined,
  warmProject: (warmup: CodegraphMcpWarmupMode | undefined) => Promise<void>,
): CodegraphMcpCacheSyncController {
  const mode = options?.mode ?? "off";
  const intervalMs = Math.max(1, Math.floor(options?.intervalMs ?? DEFAULT_INTERVAL_MS));
  const warmup = options?.warmup ?? "base";
  let lastChecked = 0;
  let lastFingerprint: string | undefined;
  let running: Promise<void> | undefined;

  const syncIfChanged = async (): Promise<void> => {
    if (running) return await running;
    running = (async () => {
      const fingerprint = await session.fileFingerprint();
      if (lastFingerprint === undefined) {
        lastFingerprint = fingerprint;
        return;
      }
      if (fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      session.invalidate();
      await warmProject(warmup);
    })();
    try {
      await running;
    } finally {
      running = undefined;
    }
  };

  return {
    beforeToolCall: async () => {
      if (mode !== "interval" && mode !== "auto") return;
      const now = Date.now();
      if (now - lastChecked < intervalMs) return;
      lastChecked = now;
      await syncIfChanged();
    },
    onLifecycle: async () => {
      if (mode !== "lifecycle" && mode !== "auto") return;
      await syncIfChanged();
    },
  };
}
```

- [ ] **Step 4: Wire controller into handlers**

In `src/mcp/server.ts`, add `cacheSync?: CodegraphMcpCacheSyncOptions` to handler and server options.

Create the controller inside `createCodegraphMcpHandlersForSession`.

Wrap indexed handlers with:

```ts
const beforeIndexedTool = async (): Promise<void> => {
  await cacheSync.beforeToolCall();
};
```

Call it before `search`, `orient`, `packet_get`, `get_symbol`, `goto`, `refs`, `deps`, `rdeps`, `path`, `impact`, `review`, `query_sqlite`, and `artifact_build`.

Do not call it before `get_file`; that tool reads directly from disk.

- [ ] **Step 5: Verify MCP sync tests**

Run:

```powershell
npx vitest run tests/mcp-server.test.ts -t "cache sync|refresh_index"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/mcp/cacheSync.ts src/mcp/server.ts tests/mcp-server.test.ts
git commit -m "feat: add mcp cache sync controller"
```

---

### Task 7: Add MCP Cache Sync CLI Flags and Docs

**Files:**

- Modify: `src/cli/mcp.ts`
- Modify: `src/cli/help.ts`
- Modify: `docs/cli.md`
- Modify: `docs/mcp.md`
- Modify: `codegraph-skill/codegraph/SKILL.md`
- Test: `tests/cli-command-modules.test.ts`

- [ ] **Step 1: Write failing help and validation tests**

Add tests:

```ts
test("documents MCP cache sync flags", () => {
  expect(MCP_SERVE_HELP_TEXT).toContain("--cache-sync <mode>");
  expect(MCP_SERVE_HELP_TEXT).toContain("--cache-sync-interval <seconds>");
});

test("rejects invalid MCP cache sync mode", async () => {
  const result = await captureCli(["mcp", "serve", "--cache-sync", "sometimes"]);

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Invalid --cache-sync value");
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
npx vitest run tests/cli-command-modules.test.ts -t "cache sync"
```

Expected: FAIL because flags do not exist.

- [ ] **Step 3: Parse flags in `src/cli/mcp.ts`**

Add:

```ts
import type { CodegraphMcpCacheSyncMode, CodegraphMcpCacheSyncOptions } from "../mcp/cacheSync.js";
```

Add parser:

```ts
function parseMcpCacheSyncMode(rawValue: string | undefined): CodegraphMcpCacheSyncMode | undefined {
  if (rawValue === undefined) return undefined;
  if (rawValue === "off" || rawValue === "lifecycle" || rawValue === "interval" || rawValue === "auto") {
    return rawValue;
  }
  throw new Error(`Invalid --cache-sync value "${rawValue}". Expected off|lifecycle|interval|auto.`);
}
```

Build options:

```ts
const cacheSyncMode = parseMcpCacheSyncMode(context.getOpt("--cache-sync"));
const cacheSyncIntervalSeconds = parseOptionalBoundedIntegerOption(
  context.getOpt("--cache-sync-interval"),
  "--cache-sync-interval",
  1,
  86400,
);
const cacheSync: CodegraphMcpCacheSyncOptions | undefined =
  cacheSyncMode !== undefined || cacheSyncIntervalSeconds !== undefined
    ? {
        mode: cacheSyncMode ?? "interval",
        ...(cacheSyncIntervalSeconds !== undefined ? { intervalMs: cacheSyncIntervalSeconds * 1000 } : {}),
        warmup: warmup ?? "base",
      }
    : undefined;
```

Pass `cacheSync` to `serveCodegraphMcp`.

- [ ] **Step 4: Update CLI validation and help**

In `src/cli/options.ts`, add `--cache-sync` and `--cache-sync-interval` to MCP value options.

In `src/cli/help.ts`, document:

```text
  --cache-sync <mode>              Auto-sync MCP cache: off, lifecycle, interval, or auto.
  --cache-sync-interval <seconds>  Minimum seconds between interval sync checks. Defaults to 30.
```

Update `docs/cli.md`, `docs/mcp.md`, and `codegraph-skill/codegraph/SKILL.md` with concise guidance:

```markdown
Use `--cache-sync auto` for long-running MCP servers when files may change during the session. Use `refresh_index` for explicit manual refresh.
```

- [ ] **Step 5: Verify help tests**

Run:

```powershell
npx vitest run tests/cli-command-modules.test.ts -t "MCP|cache sync"
node ./dist/cli.js mcp serve --help
```

Expected: tests pass after build; help includes both cache sync flags.

- [ ] **Step 6: Commit**

```powershell
git add src/cli/mcp.ts src/cli/options.ts src/cli/help.ts docs/cli.md docs/mcp.md codegraph-skill/codegraph/SKILL.md tests/cli-command-modules.test.ts
git commit -m "feat: expose mcp cache sync flags"
```

---

### Task 8: Add Lifecycle Sync for HTTP Session Initialize

**Files:**

- Modify: `src/mcp/server.ts`
- Test: `tests/mcp-server.test.ts`

- [ ] **Step 1: Write failing HTTP lifecycle test**

Add:

```ts
it("runs lifecycle cache sync after HTTP MCP initialize", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-lifecycle-sync-"));
  await fs.writeFile(path.join(root, "one.ts"), "export const oneSymbol = 1;\n", "utf8");
  const httpServer = await startCodegraphMcpHttpServer({
    root,
    port: 0,
    cacheSync: { mode: "lifecycle", warmup: "base" },
  });

  try {
    await fs.writeFile(path.join(root, "two.ts"), "export const twoSymbol = 2;\n", "utf8");
    const initialize = await postMcpJson(httpServer.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "codegraph-test", version: "1.0.0" },
      },
    });
    const sessionId = initialize.response.headers.get("mcp-session-id") ?? undefined;
    const search = await postMcpJson(
      httpServer.url,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search", arguments: { query: "twoSymbol", mode: "symbol" } },
      },
      sessionId,
    );

    expect(JSON.stringify(search.payload.result)).toContain("twoSymbol");
  } finally {
    await httpServer.close();
  }
});
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
npx vitest run tests/mcp-server.test.ts -t "lifecycle cache sync"
```

Expected: FAIL because lifecycle sync is not called on HTTP initialize.

- [ ] **Step 3: Wire lifecycle hook**

In `startCodegraphMcpHttpServer`, pass a lifecycle callback into `handleMcpHttpRequest`.

In `handleMcpHttpPost`, after `onsessioninitialized`, call the controller:

```ts
onsessioninitialized: (newSessionId) => {
  initializedSessionId = newSessionId;
  sessions.set(newSessionId, { server: protocolServer, transport });
  void lifecycleSync();
},
```

For stdio, call lifecycle sync once in `serveCodegraphMcp` after connecting handlers and before `server.connect`.

- [ ] **Step 4: Verify lifecycle tests**

Run:

```powershell
npx vitest run tests/mcp-server.test.ts -t "lifecycle cache sync|HTTP MCP"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/mcp/server.ts tests/mcp-server.test.ts
git commit -m "feat: sync mcp cache on lifecycle"
```

---

### Task 9: Final Verification and Timing Evidence

**Files:**

- Modify: `docs/plans/2026-06-06-performance-and-cache-opportunities.md` only if status boxes need updating.
- No production code changes.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
npx vitest run tests/cli-command-modules.test.ts tests/agent-search.test.ts tests/agent-session.test.ts tests/mcp-server.test.ts tests/cache-invalidation.test.ts
```

Expected: PASS.

- [ ] **Step 2: Build local dist**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 3: Capture command timings from local dist**

Run:

```powershell
node ./dist/cli.js search search --root . --mode path --json --report-file .codegraph-cache/search-path-report.json | Out-Null
node ./dist/cli.js search search --root . --mode text --no-snippets --json --report-file .codegraph-cache/search-text-report.json | Out-Null
node ./dist/cli.js search search --root . --mode hybrid --no-snippets --json --report-file .codegraph-cache/search-hybrid-report.json | Out-Null
node ./dist/cli.js inspect --root . ./src --limit 20 --json --report-file .codegraph-cache/inspect-fast-report.json | Out-Null
node ./dist/cli.js inspect --root . ./src --limit 20 --duplicates --json --report-file .codegraph-cache/inspect-duplicates-report.json | Out-Null
```

Expected:

- Path search remains fast.
- Text or hybrid identifier searches show fewer file reads when Bloom filters apply.
- `inspect` without `--duplicates` is materially faster than `inspect --duplicates`.

- [ ] **Step 4: Verify MCP help from local dist**

Run:

```powershell
node ./dist/cli.js mcp serve --help
```

Expected: output includes `--warmup`, `--warmup-symbols`, `--cache-sync`, and `--cache-sync-interval`.

- [ ] **Step 5: Run full check before final commit**

Run:

```powershell
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit status updates**

If only status docs changed:

```powershell
git add docs/plans/2026-06-06-performance-and-cache-opportunities.md
git commit -m "docs: update performance plan status"
```

If no docs changed, skip this commit.

## Deferred Work

- Do not move text scoring to Rust in this pass.
- Do not make automatic MCP cache sync default-on yet.
- Do not add a filesystem watcher yet; interval plus lifecycle plus file-list fingerprinting covers the requested behavior with less platform-specific code.
- Do not change `get_file`; it reads disk directly and does not need index sync.

## Self-Review Notes

- Requirements covered: timing reports, opt-in duplicates, Bloom prefilter, warm MCP session path, interval sync, lifecycle sync, and glob/file-list change detection.
- No persistent storage schema changes are planned.
- No new runtime dependency is planned.
- Documentation updates are included because CLI flags and agent workflow guidance change.
