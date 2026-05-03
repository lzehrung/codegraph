# Agent Workflows

Guidance for sessions, streaming queries, tool wrappers, and review-oriented agent loops.

Use Codegraph for structural repo questions: architecture, dependency direction, symbol definitions, semantic references, hotspots, cycles, public API surface, and PR impact. Use plain text search alongside it for raw strings, logs, config keys, and non-symbol patterns.

## Start here

For an unfamiliar repo, the shortest useful loop is:

```bash
codegraph doctor
codegraph inspect ./src --limit 20
```

Then use the recommended commands from `inspect` to narrow the next graph, navigation, or impact pass.

For the raw CLI command reference, see [docs/cli.md](./cli.md).

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
- For streaming review packs, keep the default `streamSummary: "full"` when the final pack needs suggestions, export summaries, re-export chains, ranked top impacts, graph edges, cycles, clusters, and surface area. Streaming always returns `format: "stream-summary"` and does not accept the batch-only `compact` option. Use `streamSummary: "light"` when the agent only needs progressive chunks plus final changed/impacted counts and details.
- Build one shared index per agent pass when you will call multiple wrappers in sequence. `tool_getFileOverview()`, `tool_getGraph()`, and `tool_impactJSON()` now accept `index` through their runtime-options argument, while the bounded graph wrappers already accept it in their options object.
- Native runtime control is not passed uniformly across all wrappers: `tool_goToDefinition` and `tool_findReferences` accept trailing runtime options, while `tool_findSymbol`, `tool_getDependencies`, `tool_getReverseDependencies`, and `tool_getHotspots` take `native` inside their options object.
- `tool_getFileOverview` returns structured `ok`, `not_found`, and `error` variants so agents can distinguish missing files from invalid inputs cleanly.
- `tool_findSymbol` returns stable `id` handles plus `range`, `exported`, `exactMatch`, and `matchKind`.
- `tool_goToDefinition` and `tool_findReferences` include additive `provenance` metadata when resolution is not just a local binding lookup.
- Prefer `tool_getDependencies`, `tool_getReverseDependencies`, and `tool_getHotspots` before `tool_getGraph` when the agent only needs a bounded graph slice.
- Batch impact wrappers return `schemaVersion` and `format: "full" | "compact"` so downstream prompts can branch on payload shape directly; streaming `complete.report` uses `format: "stream-summary"`.

## Review bundles for agents

The `codegraph review` CLI produces JSON bundles that are intended to be fed directly to agents or downstream scripts:

```bash
codegraph review --base origin/main --head HEAD > review.json
codegraph review --base origin/main --head HEAD --include-symbol-details --max-callsites 5 > review.json
codegraph review --base origin/main --head HEAD --review-depth standard > review.json
```

For current local edits, start with a ranked human map, then hand off the compact review summary:

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
- risk summaries and review tasks

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
