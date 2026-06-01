# Agent Workflows

Guidance for sessions, streaming queries, tool wrappers, and review-oriented agent loops.

Use Codegraph for structural repo questions: architecture, dependency direction, symbol definitions, semantic references, hotspots, cycles, public API surface, and PR impact. Use plain text search alongside it for raw strings, logs, config keys, and non-symbol patterns.

## Start here

For an unfamiliar repo, the shortest useful loop is:

```bash
codegraph doctor
codegraph orient --root . --budget small --json
codegraph packet get <handle-from-orient> --json
codegraph search "auth user" --json
codegraph explain src/auth.ts --json
codegraph inspect ./src --limit 20
codegraph artifact build --root . --out codegraph-out --json
codegraph doctor codegraph-out
codegraph mcp serve --root . --stdio
codegraph mcp serve --root . --port 7331
```

Use `orient` for first-turn repo context, then use `packet get` for bounded follow-up evidence by handle. Use `search` when the agent has a query but no handle, and use `explain` when it already knows a file, symbol, SQL object, or search handle. `inspect` remains useful for human-readable architecture summaries and older installs.

Choose output by the next consumer:

- Use `--pretty` or `--summary` when the next consumer is a person or language model reading the result.
- Use `--json`, MCP tools, or library APIs when the next step needs exact handles, ranges, schema fields, or filtering.
- Do not parse pretty text to recover fields already present in structured output.

For durable repo-local scan scope, add `codegraph.config.json` at the project root. `discovery.ignoreGlobs` keeps large fixture, generated, or vendored folders out of agent search, MCP sessions, graphing, unresolved-import checks, impact, and review unless a command explicitly changes scan scope.

For the raw CLI command reference, see [docs/cli.md](./cli.md).

## Orientation packets

Start with `orient` when an agent needs compact repo context without flooding the first prompt:

```bash
codegraph orient --root . --budget small --json
codegraph orient --root . ./src --budget medium --pretty
codegraph packet get file:src%2Fcli.ts --json
codegraph packet get <handle-from-orient> --max-symbols 25 --json
```

Orientation returns summary bullets, a bounded tree, hotspot modules, budgeted health counts, stable packet handles, omitted counts, and recommended next commands. Use `orient --pretty` for compact model-readable triage and `orient --json` when follow-up tools need exact handles or omission counts. Small orientation packets skip deeper health analysis and report that omission explicitly; use `--budget medium` or `--budget large` when health counts matter. Packet retrieval accepts file, symbol, chunk, SQL, graph, and review handles and delegates to the same bounded explain/review helpers used by existing commands. Review handles are available when orientation is invoked programmatically with a review range.

## Search anchors

Use `search` when an agent has a query but no packet handle and needs a compact starting point before calling `goto`, `refs`, `deps`, `rdeps`, `chunk`, or later explanation tooling:

```bash
codegraph search "validate user" --json
codegraph search "public users" --mode sql --json
codegraph search "handle login" --mode graph --from src/auth.ts --depth 1 --json
codegraph explain "<handle-from-search>" --json
```

Search results include project-relative `handle`, `rankReasons`, `evidence`, `neighbors`, `followUps`, `resultCount`, `totalCandidates`, `limits`, and `omittedCounts`. `explain` accepts those handles plus file paths, symbol names, and SQL object names, then returns bounded symbols, dependencies, reverse dependencies, references, snippets, duplicate context, SQL relation facts, optional changed-context review tasks/candidate tests, explicit limits, omission counts, and follow-ups. Generated command strings POSIX-shell-quote dynamic arguments when needed. SQL object handles or schema-qualified names avoid ambiguous unqualified basenames. Reference and snippet omission counts are bounded lower bounds once navigation limits are reached, so small explain packets stay cheap on high-fan-in symbols.

Use `artifact build` when the agent needs a durable handoff directory. The default bundle writes SQLite, self-describing project-relative graph JSON with symbols, a concise Markdown report, suggested questions, and a manifest. Suggested questions command stable handles, not ambiguous bare names, and use unique IDs even when display labels collide. In-repo artifact output directories and linked outside-root files are excluded from the emitted artifacts so stale handoff files do not feed back into the graph. With `--force`, Codegraph removes recognizable stale artifact files while preserving unrelated operator files and refusing unrecognized reserved-name collisions. `codegraph doctor <artifact-dir>` recognizes manifest-backed bundle directories and reports which expected artifacts are present.

Use `drift` when the agent needs one architecture-regression report for a base/head range:

```bash
codegraph drift ./src --base origin/main --head HEAD --pretty --graph-edges summary --public-api removals
codegraph drift ./src --base origin/main --head HEAD --compact-json
```

Drift compares structural signals over time: dependency cycles, hotspots, unresolved imports, API surface changes, duplicate group counts, and graph edges. It is review and CI evidence, not runtime validation or compiler diagnostics. Use compact JSON for CI or agent handoff, and use graph-edge/API filters to keep human review output bounded.

## MCP server

Use `codegraph mcp serve --root . --stdio` when an agent can spawn a stdio MCP server, or `codegraph mcp serve --root . --port 7331` for Streamable HTTP at `/mcp`. HTTP binds to `127.0.0.1` by default; pass `--host <host>` only when the server must be reachable elsewhere. MCP reuses one in-process Codegraph session and exposes the same deterministic primitives as compact tools: `orient`, `packet_get`, `search`, `get_file`, `get_symbol`, `goto`, `refs`, `deps`, `rdeps`, `path`, `impact`, `review`, `query_sqlite`, and `artifact_build`.

MCP is an ergonomics and performance layer, not a separate analysis engine. It gives agents stable handles from orientation, `search`, and `explain`, avoids rebuilding the project for each follow-up call, and returns bounded snippets/resources. File and artifact paths are confined to the project root after realpath resolution; tool calls do not accept per-request root overrides. Tools are read-only by default; `query_sqlite` rejects mutating SQL, recursive queries, and synthetic payload functions while capping returned rows and bytes. `artifact_build` is available only when the server is started with `--allow-build`.

See [MCP server](./mcp.md) for client configuration examples.

## Session management

For agents performing code reviews or making multiple queries, use sessions to maintain warm caches:

```ts
import { createCodeReviewSession } from "@lzehrung/codegraph";

const session = await createCodeReviewSession({
  root: "/path/to/repo",
  buildOptions: {
    cache: "disk",
    useBloomFilters: true,
  },
  timeout: 30 * 60 * 1000,
});

const impact = await session.analyzeImpact({
  provider: "git",
  base: "main",
  head: "feature-branch",
});

const refs = await session.findReferences({
  file: "/path/to/file.ts",
  line: 10,
  column: 5,
});

const def = await session.goToDefinition({
  file: "/path/to/file.ts",
  line: 15,
  column: 8,
});

await session.refresh();
const stats = session.getStats();
console.log(`Files: ${stats.fileCount}, Symbols: ${stats.symbolCount}`);
session.dispose();
```

Important session contracts:

- Session impact calls use the same required provider contract as `analyzeImpactFromDiff()`.
- Session navigation rejects files outside the session root with `{ status: "error", reason: "outside_project_root" }`.

### Session presets

```ts
import { createCodeReviewSession } from "@lzehrung/codegraph";

const session = await createCodeReviewSession({
  root: "/path/to/repo",
  preset: "code-review",
});

const customSession = await createCodeReviewSession({
  root: "/path/to/repo",
  preset: "ci-fast",
  buildOptions: {
    threads: 16,
  },
});
```

Available presets:

- `code-review`: balanced speed and accuracy for PR reviews
- `ci-fast`: maximum speed for CI and CD
- `development`: fast feedback for local development
- `production`: maximum accuracy

### Managing multiple sessions

```ts
import { SessionManager } from "@lzehrung/codegraph";

const manager = new SessionManager();
const pr1Session = await manager.getOrCreateSession("pr-123", {
  root: "/path/to/repo",
});
const pr2Session = await manager.getOrCreateSession("pr-456", {
  root: "/path/to/repo",
});
const sameSession = await manager.getOrCreateSession("pr-123", {
  root: "/path/to/repo",
});

manager.cleanupExpired();
const allStats = manager.getAllStats();
console.log(Boolean(pr1Session), Boolean(pr2Session), Boolean(sameSession), allStats);
```

## Streaming impact analysis

Stream impact results as they are discovered so the agent can start reasoning before the full pass completes:

```ts
import { buildProjectIndex, analyzeImpactStreaming } from "@lzehrung/codegraph";

const root = process.cwd();
const index = await buildProjectIndex(root);

for await (const chunk of analyzeImpactStreaming(root, index, {
  provider: "git",
  base: "main",
  head: "feature-branch",
})) {
  if (chunk.type === "progress") {
    console.log(`${chunk.message}: ${chunk.current}/${chunk.total}`);
  } else if (chunk.type === "changedSymbol") {
    console.log(`Changed: ${chunk.symbol.name} in ${chunk.symbol.file}`);
  } else if (chunk.type === "impactItem") {
    console.log(`Impacted: ${chunk.item.file} (${chunk.item.severity})`);
  } else if (chunk.type === "complete") {
    console.log(`Analysis complete: ${chunk.summary.totalImpacted} files impacted`);
  } else if (chunk.type === "error") {
    console.error(`Error: ${chunk.error}`);
  }
}
```

Use the same pattern through a warm session when repeated review passes matter:

```ts
import { createCodeReviewSession } from "@lzehrung/codegraph";

const session = await createCodeReviewSession({ root: "/path/to/repo" });

for await (const chunk of session.analyzeImpactStream({
  provider: "git",
  base: "main",
  head: "feature-branch",
})) {
  if (chunk.type === "impactItem") {
    await analyzeImpactedFile(chunk.item);
  }
}
```

## Partial results

Use partial-result helpers when the agent should keep going even if a subset of files fails:

```ts
import { withPartialResults, summarizePartialResult } from "@lzehrung/codegraph";

const files = ["file1.ts", "file2.ts", "file3.ts"];
const result = await withPartialResults(files, async (file) => await analyzeFile(file), {
  continueOnError: true,
  concurrency: 8,
});

if (result.status === "complete") {
  console.log("All files processed successfully");
} else if (result.status === "partial") {
  console.log(`Partial success: ${result.coverage * 100}% complete`);
  console.log(`Succeeded: ${result.metadata?.succeeded}, Failed: ${result.metadata?.failed}`);
  processResults(result.data);
  for (const error of result.errors) {
    console.error(`${error.target}: ${error.message}`);
  }
} else {
  console.error("Operation failed completely");
}

console.log(summarizePartialResult(result));
```

## Agent query helpers

Symbol query syntax is a compact `key:value` format with optional free text:

```text
kind:function name:handler file:src/api
docstring:"rate limit" auth
```

Supported keys:

- `kind` or `kinds`
- `name`
- `file`
- `doc` or `docstring`

Programmatic helpers:

```ts
import { querySymbols, querySymbolNeighbors } from "@lzehrung/codegraph";

const hits = querySymbols(symbolGraph, {
  kinds: ["function"],
  nameIncludes: "handler",
  fileIncludes: "src/api",
});

const neighbors = querySymbolNeighbors(symbolGraph, {
  symbolId: hits[0]?.id ?? "",
  direction: "both",
  maxDepth: 2,
  edgeLabels: ["calls", "instantiates"],
});
```

## High-level agent tools

These wrappers are designed to be imported directly into agent runtimes:

```ts
import {
  buildProjectIndex,
  tool_getFileOverview,
  tool_findSymbol,
  tool_impactJSON,
  tool_getDependencies,
  tool_getReverseDependencies,
  tool_getHotspots,
  tool_goToDefinition,
  tool_findReferences,
} from "@lzehrung/codegraph";

const root = process.cwd();
const index = await buildProjectIndex(root);
const overview = await tool_getFileOverview(root, "src/utils.ts", { index });
const matches = await tool_findSymbol(root, "collectGraph", { index });
const deps = await tool_getDependencies(root, "src/main.ts", { depth: 2, limit: 20, index });
const reverseDeps = await tool_getReverseDependencies(root, "src/index.ts", { depth: 2, limit: 20, index });
const hotspots = await tool_getHotspots(root, { limit: 20, index });
const impact = await tool_impactJSON(
  root,
  {
    provider: "git",
    base: "HEAD",
    head: "WORKTREE",
  },
  { index },
);
const definition = await tool_goToDefinition(root, "src/main.ts", 10, 5, index, { native: "on" });
const references = await tool_findReferences(root, "src/main.ts", 10, 5, index);
```

Wrapper notes:

- Import only from `@lzehrung/codegraph`.
- When the agent runtime calls Codegraph as a TypeScript library, prefer structured fields over rendered CLI text. A deterministic review agent should usually call `buildReviewReport()` for changed-file and task metadata, then `analyzeImpactFromDiff()` or `analyzeImpactStreaming()` for impact and graph context. Use CLI output only when the agent is operating through a shell tool.
- Treat `callCompatibility` as a deterministic review lead, not compiler-grade type checking. Likely-mismatch support covers provider-backed source-language callsite arity when callee resolution, signature parsing, and argument counting are all high confidence.
- For streaming review packs, keep the default `streamSummary: "full"` when the final pack needs suggestions, export summaries, re-export chains, ranked top impacts, graph edges, cycles, clusters, and surface area. Streaming always returns `format: "stream-summary"`; forwarded `compact` is accepted only for compatibility and is ignored. Use `streamSummary: "light"` when the agent only needs progressive chunks plus final changed/impacted counts and details.
- Build one shared index per agent pass when you will call multiple wrappers in sequence. `tool_getFileOverview()`, `tool_getGraph()`, and `tool_impactJSON()` now accept `index` through their runtime-options argument, while the bounded graph wrappers already accept it in their options object.
- Native runtime control is not passed uniformly across all wrappers: `tool_goToDefinition` and `tool_findReferences` accept trailing runtime options, while `tool_findSymbol`, `tool_getDependencies`, `tool_getReverseDependencies`, and `tool_getHotspots` take `native` inside their options object.
- `tool_getFileOverview` returns structured `ok`, `not_found`, and `error` variants so agents can distinguish missing files from invalid inputs cleanly.
- `tool_findSymbol` returns stable `id` handles plus `range`, `exported`, `exactMatch`, and `matchKind`.
- `tool_goToDefinition` and `tool_findReferences` include additive `provenance` metadata when resolution is not just a local binding lookup.
- Prefer `tool_getDependencies`, `tool_getReverseDependencies`, and `tool_getHotspots` before `tool_getGraph` when the agent only needs a bounded graph slice.
- Batch impact wrappers return `schemaVersion` and `format: "full" | "compact"` so downstream prompts can branch on payload shape directly; streaming `complete.report` uses `format: "stream-summary"`.

## Review bundles for agents

The `codegraph review` CLI produces JSON bundles for downstream scripts and tool integrations:

```bash
codegraph review --base origin/main --head HEAD > review.json
codegraph review --base origin/main --head HEAD --include-symbol-details --max-callsites 5 > review.json
codegraph review --base origin/main --head HEAD --review-depth standard > review.json
```

For current local edits, start with a ranked model-readable map, then hand off the compact review summary:

```bash
codegraph impact --base HEAD --head WORKTREE --pretty
codegraph review --base HEAD --head WORKTREE --summary
```

Use `--head STAGED` instead of `WORKTREE` when the review should cover only the index. Keep the full JSON review bundle for scripts or agent steps that need `projectFiles`, `graphDelta`, or detailed symbol handles.

For function-call integrations, keep the JSON object as the handoff. Do not parse `review --summary` or `impact --pretty` text to recover fields that are already present in the TypeScript return values.

In summary mode, high-confidence direct import matches are the first regression targets and medium matches are likely file-level coverage. Low-confidence pattern matches are summarized as breadth hints; use the full JSON bundle only when you need to inspect those fallback candidates.

These bundles highlight:

- symbol-level changes
- updated dependency edges
- likely regression tests
- Provider-backed call-arity compatibility leads after signature changes
- risk summaries and review tasks

When `callCompatibility` is present, start with hints where `status` is `likely_mismatch`, inspect `callsiteFile` and `callsiteRange`, and compare `expected` against `actual` before proposing a fix. Missing hints do not prove all callers are valid; Codegraph skips unsupported, ambiguous, overloaded, spread, or unresolved callsites.

Pretty impact and review summaries include scoped duplicate leads by default:

- `impact --pretty`: high-confidence exact or renamed clones within changed files.
- `review --summary`: high-confidence exact or renamed clones within changed plus graph-impacted files.
- `--duplicates off|changed|impacted|all`: override the human-summary scope.
- Full duplicate groups, variants, raw pair counts, and omission counts remain in `codegraph duplicates` JSON.
- Structured review packets add bounded `duplicate-sibling` tasks when changed ranges overlap high-confidence duplicate groups.

For copied-code or refactor-risk questions, add duplicate detection after the impact pass:

```bash
codegraph duplicates --root . ./src --min-confidence medium --limit 20
codegraph duplicates --root . ./src ./packages/app --include-same-file
```

- Treat duplicate groups as review or refactor leads, not automatic defects.
- Start with high-confidence exact or renamed clones.
- Use full JSON when an agent needs clone variants, omission counts, and raw pair counts.

For the exact JSON shape and CLI flags, see [docs/cli.md](./cli.md).

## Backend-focused review recipes

These patterns combine Codegraph's core capabilities with backend-review heuristics.

### 1. API route impact assessment

```ts
import { analyzeImpactFromDiff, buildProjectIndex } from "@lzehrung/codegraph";

const root = process.cwd();
const index = await buildProjectIndex(root);
const impact = await analyzeImpactFromDiff(root, index, {
  provider: "git",
  base: "main",
  head: "feature-branch",
  depth: 2,
  compact: true,
});

const apiRoutes = impact.impacted.filter(
  (item) => item.file.includes("routes") || item.file.includes("controllers") || item.file.includes("api"),
);

const breakingChanges = impact.changedSymbols.filter(
  (symbol) => symbol.exported && symbol.explain?.hints?.includes("signatureChanged"),
);

console.log(`API routes impacted: ${apiRoutes.length}`);
console.log(`Breaking changes: ${breakingChanges.length}`);
```

### 2. Database schema impact analysis

```ts
import { collectImpactContext } from "@lzehrung/codegraph";

const schemaChanges = impact.changedSymbols.filter(
  (symbol) => symbol.file.includes("models") || symbol.file.includes("schema") || symbol.file.includes("migrations"),
);

if (schemaChanges.length > 0) {
  const context = await collectImpactContext(
    index,
    impact.impacted.map((item) => item.file),
    impact.changedSymbols.map((symbol) => symbol.id),
    3,
  );

  const affectedServices = context.symbolNeighbors.filter(
    (neighbor) => neighbor.file.includes("services") || neighbor.file.includes("repositories"),
  );

  console.log(`Services needing migration review: ${affectedServices.length}`);
}
```

### 3. Test coverage validation

```ts
import { listCandidateTestFiles } from "@lzehrung/codegraph";

const candidateTests = listCandidateTestFiles(
  index,
  impact.changedFiles.map((file) => file.file),
  impact.changedSymbols.map((symbol) => symbol.id),
  {
    testPatterns: ["test", "spec", "__tests__", ".test."],
    maxCandidates: 20,
  },
);

const highPriorityTests = candidateTests.filter((test) => test.confidence === "high");
const mediumPriorityTests = candidateTests.filter((test) => test.confidence === "medium");

console.log(`High-priority tests to review: ${highPriorityTests.length}`);
console.log(`Medium-priority tests to check: ${mediumPriorityTests.length}`);
```

### 4. Security-focused review

```ts
import { textGrep } from "@lzehrung/codegraph";

const securityPatterns = [
  "exec\\(|eval\\(|spawn\\(",
  "password|secret|key.*=",
  "sql.*\\+|\\$\\{.*\\}",
  "innerHTML|outerHTML",
];

const securityFindings: Array<{ file: string; pattern: string; line: number }> = [];

for (const changedFile of impact.changedFiles) {
  for (const pattern of securityPatterns) {
    try {
      const matches = await textGrep(root, pattern, [changedFile.file], {
        maxHits: 200,
      });
      for (const match of matches) {
        securityFindings.push({
          file: match.file,
          pattern,
          line: match.line,
        });
      }
    } catch {
      // Skip invalid regex patterns
    }
  }
}

if (securityFindings.length > 0) {
  console.log(`Security findings: ${securityFindings.length}`);
}
```

### 5. Configuration and environment impact

```ts
const configChanges = impact.changedFiles.filter(
  (file) =>
    file.file.includes("config") ||
    file.file.endsWith(".env") ||
    file.file.includes("docker") ||
    file.file.includes("terraform") ||
    file.file.includes("package.json"),
);

if (configChanges.length > 0) {
  console.log(`Configuration files changed: ${configChanges.length}`);
}
```

### 6. Performance regression detection

```ts
const perfHotspots = impact.impacted.filter(
  (item) =>
    item.file.includes("query") ||
    item.file.includes("cache") ||
    item.file.includes("index") ||
    item.file.includes("perf"),
);

if (perfHotspots.length > 0) {
  console.log(`Performance-sensitive files impacted: ${perfHotspots.length}`);
}
```

## Related docs

- [docs/cli.md](./cli.md)
- [docs/library-api.md](./library-api.md)
- [docs/how-it-works.md](./how-it-works.md)
