# Library API

Programmatic APIs for indexing, graph building, agent search/explain/artifacts, MCP handlers, chunking, SQL artifact facts, read-only SQLite inspection, and impact analysis.

For sessions, streaming workflows, tool wrappers, and review-oriented recipes, see [docs/agent-workflows.md](./agent-workflows.md).

## Runtime model

Import only from `@lzehrung/codegraph` and call the API directly.

The library defaults to `native: "auto"`, which uses the native Tree-sitter path when `@lzehrung/codegraph-native` is installed for the current platform and falls back automatically otherwise.

Override that per call with `native: "on"` or `native: "off"`.

- `native: "on"` requires the native addon and raises an error if it cannot be loaded.
- `native: "off"` means the opt-in JS fallback path and requires `@lzehrung/codegraph-js-fallback`.

```ts
import { buildProjectIndex } from "@lzehrung/codegraph";

const index = await buildProjectIndex(process.cwd(), { native: "auto" });
const jsOnlyIndex = await buildProjectIndex(process.cwd(), { native: "off" });
```

CLI commands and agent sessions read `codegraph.config.json` from the project root when it exists. Core indexing APIs keep discovery explicit, so pass `discovery` options directly when you want the same scan scope in custom code:

```ts
import { buildProjectIndex, loadCodegraphConfig } from "@lzehrung/codegraph";

const root = process.cwd();
const config = await loadCodegraphConfig(root);
const index = await buildProjectIndex(root, {
  ...(config.discovery ? { discovery: config.discovery } : {}),
});
```

## Public API Boundary

The npm package exposes one supported entry point: `@lzehrung/codegraph`.
Do not import from generated paths such as `@lzehrung/codegraph/dist/...` or
repo-internal source paths. Those modules are implementation details and can
move during refactors.

The root entry point is intentionally broad today for compatibility. Treat it
as three groups:

- Public-stable APIs are the documented integration surface: indexing and
  navigation (`buildProjectIndex`, `buildProjectIndexIncremental`,
  `goToDefinition`, `findReferences`, symbol handles, graph builders and
  renderers), impact and review reports, sessions, agent search/explain/artifact
  helpers, MCP handlers, SQLite helpers, SQL artifact APIs, chunking, config,
  language metadata, and native runtime capability checks.
- Public-legacy APIs remain exported for existing callers but are lower-level
  building blocks. This includes parser-facing helpers such as `parseFile`,
  `collectImportsForFile`, `collectLocalsAndExportsFromSource`,
  `buildScopeIndexFromSource`, selected shared utilities, lazy symbol wrappers,
  symbol hashing helpers, and partial-result helpers. New integrations should
  prefer the documented higher-level APIs unless they specifically need these
  shapes.
- Internal-only modules are anything outside the root package export. They are
  not covered by semver, even when their generated declaration files exist in
  `dist/`.

Future API narrowing should happen by first documenting replacements, then
adding explicit subpath exports or deprecation notes before removing root
compatibility exports.

## Agent packets

`orientCodegraph()` returns a compact first-turn packet for an agent, and `getCodegraphPacket()` retrieves bounded evidence by stable handle:

```ts
import { getCodegraphPacket, orientCodegraph } from "@lzehrung/codegraph";

const orientation = await orientCodegraph({
  root: process.cwd(),
  includeRoots: ["src"],
  budget: "small",
});

const handle = orientation.handles[0]?.handle;
if (handle) {
  const packet = await getCodegraphPacket({
    root: process.cwd(),
    handle,
    maxSymbols: 25,
  });
  console.log(packet.kind, packet.followUps);
}
```

Use orientation before broad search when a caller needs repo context but has no query yet. Packet handles cover files, symbols, chunks, SQL objects, graph neighborhoods, and review ranges.
Small orientation budgets skip deeper health analysis and set health fields to `null` while recording the omission. Use `budget: "medium"` or `budget: "large"` when health counts are needed.

## Agent search

`searchCodegraph()` builds a project snapshot and returns deterministic, agent-ready anchors across files, symbols, chunks, SQL objects, and optional graph neighborhoods. Handles are project-relative and explainable; large result packets include `resultCount`, `totalCandidates`, `limits`, and `omittedCounts`.

```ts
import { buildCodegraphArtifact, explainCodegraphTarget, searchCodegraph } from "@lzehrung/codegraph";

const response = await searchCodegraph({
  root: process.cwd(),
  query: "validate user",
  mode: "hybrid",
  limit: 10,
});

const first = response.results[0];
console.log(first?.handle, first?.rankReasons, first?.omittedCounts, first?.followUps);
```

Use `mode: "sql"` for SQL objects, or pass `from` plus `depth` with `mode: "graph"` to boost matches near a file path, file/chunk/graph handle, symbol handle, SQL handle, or symbol name.

`explainCodegraphTarget()` resolves a file path, symbol name, SQL object name, or search handle into a bounded packet for follow-up agent work. SQL object names resolve by exact name first; unqualified basenames resolve only when unique. SQL related objects include a `relation` such as `incoming:reads_from`, `outgoing:writes_to`, or `same_file`. With changed context enabled, the packet includes compact review tasks and candidate tests:

```ts
const explanation = await explainCodegraphTarget({
  root: process.cwd(),
  target: first?.handle ?? "src/auth.ts",
  maxSymbols: 25,
  maxDependencies: 10,
  maxReferences: 10,
  maxRelatedSqlObjects: 10,
  maxSnippets: 5,
});

console.log(explanation.summary, explanation.followUps);
```

Reference and snippet omission counts are lower bounds once the bounded navigation scan reaches the requested cap. This keeps small packets cheap for symbols with many references while still signaling that more context exists.

`buildCodegraphArtifact()` writes the same core artifacts agents usually need for offline navigation. Artifact contents exclude the output directory itself when it is inside the repo; hosts that write through a resolved path while indexing through a symlinked root can pass `filterOutDir` with the lexical project-relative output path:

```ts
const artifact = await buildCodegraphArtifact({
  root: process.cwd(),
  outDir: "codegraph-out",
});

console.log(artifact.manifestPath, artifact.artifacts);
```

The `graph.json` artifact is self-describing (`schemaVersion: 1`, `format: "codegraph.graph-json"`) and uses project-relative file paths and portable symbol handles. `questions.json` uses the same stable handles for follow-up commands. With `force: true`, stale known Codegraph artifact files are removed before the selected outputs are written; unrelated files in the directory are preserved.

`createAgentSession()` keeps one in-process project snapshot warm for repeated orient, search, explain, packet, artifact, and MCP calls. Use `buildCodegraphArtifactWithSession()` when a host already has a session and wants SQLite, graph JSON, report, questions, and manifest outputs from the same snapshot. `createCodegraphMcpHandlers()` exposes the same primitives without starting stdio, which is useful for tests or host applications:

```ts
import { createCodegraphMcpHandlers } from "@lzehrung/codegraph";

const handlers = createCodegraphMcpHandlers({
  root: process.cwd(),
  artifactPath: "codegraph-out",
  readOnly: true,
});

const search = await handlers.search({ query: "auth user", limit: 5 });
const orient = await handlers.orient({ includeRoots: ["src"], budget: "small" });
const packet = await handlers.packet_get({ handle: orient.handles[0]!.handle });
const refs = await handlers.refs({ handle: search.results[0]!.handle });
const rows = await handlers.query_sqlite({ query: "select path from files", limit: 5 });
console.log(packet.kind, refs.references, rows.rows);
```

`serveCodegraphMcp()` starts the stdio server used by `codegraph mcp serve`. MCP is an agent ergonomics and cache layer over the same analysis engine, not a separate indexer. MCP file and artifact paths are confined after realpath resolution. `query_sqlite` is read-only and row- and byte-bounded; `artifact_build` is disabled by default and requires `readOnly: false` or CLI `--allow-build`.
MCP `orient` and `packet_get` calls use the server-configured root; they do not accept per-request root overrides.

## Semantic chunking

The library provides semantic code chunking utilities for preparing codebases for LLM processing and vector embeddings. It uses Tree-sitter to split code into meaningful units while respecting token budgets.

### APIs

```ts
import { chunkFile, chunkTextFile, LANG_CONFIGS } from "@lzehrung/codegraph";

const source = `function hello(name) { return "Hello " + name; }`;
const chunks = chunkFile({
  language: LANG_CONFIGS.javascript,
  source,
  filePath: "utils.js",
  minTokens: 150,
  maxTokens: 400,
});

const jsonText = `{"config": {"port": 3000, "host": "localhost"}}`;
const textChunks = chunkTextFile({
  source: jsonText,
  languageId: "json",
  minTokens: 100,
  maxTokens: 200,
});
```

### Chunk format

```ts
interface Chunk {
  id: string;
  languageId: string;
  filePath?: string;
  type: string;
  name?: string;
  startLine: number;
  endLine: number;
  text: string;
  tokenCount: number;
}
```

### Options

- `minTokens`: minimum tokens per chunk, default `150`
- `maxTokens`: maximum tokens per chunk, default `400`
- `tokenizer`: custom token-counting function, default whitespace-based

### Example output

```json
[
  {
    "id": "javascript:utils.js:0",
    "languageId": "javascript",
    "filePath": "utils.js",
    "type": "function",
    "name": "hello",
    "startLine": 1,
    "endLine": 1,
    "text": "function hello(name) { return \"Hello \" + name; }",
    "tokenCount": 8
  }
]
```

### Testing and reference

See the test suites for concrete examples:

- `tests/languages/*.test.ts`
- `tests/chunkFile.behavior.test.ts`
- `tests/languages/chunkSFC.test.ts`
- `tests/samples/chunking/integration-example.test.ts`

The integration examples demonstrate semantic chunking with type-based filtering, text-file chunking for configuration processing, intelligent splitting of large blocks, and metadata useful for embeddings or retrieval pipelines.

## Duplicate detection

`findDuplicates()` scans a built `ProjectIndex` for exact, renamed, near, and weak clone candidates.

- It uses indexed symbols, semantic chunks, and text chunks.
- Grouped duplicate output uses `schemaVersion: 2`.
- Results include grouped findings, confidence, score, clone type, metrics, omission counts, and pair stats.
- Group `variants` are bounded by default and expose hidden evidence through `rawPairCount` and `omittedVariantCount`.
- Raw unit-pair suggestions and full group variants are available when `includeRawPairs` is enabled.
- Paths are project-relative when the index has a project root.

```ts
import { buildProjectIndex, findDuplicates } from "@lzehrung/codegraph";

const root = process.cwd();
const index = await buildProjectIndex(root);
const duplicates = await findDuplicates(index, {
  minConfidence: "medium",
  limit: 20,
});

console.log(duplicates.groups);
```

Useful options:

- `minConfidence`: `high`, `medium`, or `low`; default `medium`.
- `includeSameFile`: report non-overlapping clones in the same file.
- `includeSmall`: include units below the default token floor.
- `includeRawPairs`: include low-level symbol/chunk pair evidence as `suggestions`.
- `minTokens` and `maxTokens`: tune unit and fallback chunk bounds.

Tests:

- `tests/duplicates.test.ts`

## Basic index building

Build a full project index and use go-to-definition:

```ts
import { buildProjectIndex, goToDefinition } from "@lzehrung/codegraph";

const root = process.cwd();
const index = await buildProjectIndex(root);

const file = `${root}/tests/samples/monorepo/packages/pkg-b/src/index.js`.replace(/\\/g, "/");
const res = await goToDefinition(index, { file, line: 21, column: 18 });
if (res.status === "ok") {
  console.log("Def:", res.definition.file, res.definition.localName, res.definition.range);
}
```

Find references with the same index:

```ts
import { findReferences } from "@lzehrung/codegraph";

const refs = await findReferences(index, { file, line: 21, column: 18 });
if (refs.status === "ok") {
  console.log(
    "Refs:",
    refs.references.map((ref) => `${ref.file}:${ref.range.start.line}:${ref.range.start.column}`),
  );
}
```

## Incremental indexing

```ts
import { buildProjectIndexIncremental } from "@lzehrung/codegraph";

const root = process.cwd();
const incremental = await buildProjectIndexIncremental(root, {
  gitBase: "origin/main",
  gitHead: "HEAD",
});
```

`buildProjectIndexIncremental` loads the cached manifest, reuses unchanged modules and edges, and reparses only the files reported as changed by Git flags or an explicit `files` list.

`changedSince` follows `git diff <rev>` semantics, while `gitBase` and `gitHead` use an explicit `<base>..<head>` range for normal revisions. `gitHead` also accepts `WORKTREE` for staged and unstaged tracked-file changes, or `STAGED`/`INDEX` for the current index.

## Project file discovery and graph building

`listProjectFiles` defaults to source files plus common project manifests and lockfiles across supported languages, for example `package.json`, `requirements.txt`, `pyproject.toml`, and `Cargo.toml`.
When scanning a child directory with project-root-relative include or ignore globs, pass `globRoot`.

```ts
import { listProjectFiles, discoverProjectFiles, collectGraph } from "@lzehrung/codegraph";

const root = process.cwd();
const files = await listProjectFiles(root);
const tsFilesOnly = await listProjectFiles(root, undefined, {
  includeGlobs: ["src/**/*.ts"],
  ignoreGlobs: ["src/**/*.spec.ts"],
});
const scopedTests = await listProjectFiles(`${root}/tests`, undefined, {
  globRoot: root,
  ignoreGlobs: ["tests/samples/**"],
});
const includeIgnoredFiles = await listProjectFiles(root, undefined, {
  useGitignore: false,
});

const manifests = files.filter((file) => /(?:package\.json|pyproject\.toml|Cargo\.toml)$/.test(file));
console.log(manifests);

const projectFiles = await discoverProjectFiles(root);
const named = projectFiles.filter((file) => file.name);
console.log(named);

const graph = await collectGraph(root, files);
for (const edge of graph.edges) {
  const target = edge.to.type === "file" ? edge.to.path : edge.to.name;
  console.log(`${edge.from} -> ${target} (${edge.raw})`);
}
```

`getUnresolvedImports(graph, { projectRoot })` reports unresolved source imports. It excludes graph-only document/template link edges by default; pass `{ includeGraphOnly: true }` when a custom caller intentionally wants those links included in the same report.

Build an index from an explicit multi-root file list:

```ts
import { listProjectFiles, buildProjectIndexFromFiles } from "@lzehrung/codegraph";

const root = process.cwd();
const tsRoot = `${root}/tests/samples/typescript`;
const jsRoot = `${root}/tests/samples/javascript`;
const files = [
  ...(await listProjectFiles(tsRoot, undefined, { globRoot: root })),
  ...(await listProjectFiles(jsRoot, undefined, { globRoot: root })),
];

const index = await buildProjectIndexFromFiles(root, Array.from(new Set(files)));
console.log({ files: index.byFile.size, edges: index.graph.edges.length });
```

Produce a Mermaid diagram string from an in-memory graph:

```ts
import { graphToMermaid } from "@lzehrung/codegraph";

const mermaid = graphToMermaid(graph);
console.log(mermaid);
```

## Read-only SQL from code

```ts
import { queryGraphSqliteRaw } from "@lzehrung/codegraph";

const result = await queryGraphSqliteRaw(
  "./codegraph.sqlite",
  `
  SELECT name, file FROM symbols WHERE kind = 'class' LIMIT 10;
`,
);
console.log(result.columns, result.rows);
```

`queryGraphSqliteRaw()` is intentionally read-only. It accepts result-producing statements such as `SELECT` and `PRAGMA` and rejects mutating SQL. Pass `{ maxRows }` to bound raw result rows.

## SQL artifact facts

SQL source files participate in normal project indexing through SQL-specific symbols, SQL-to-SQL object edges, and SQL navigation. SQL-to-SQL edges are precise for exact object-name matches, heuristic for unambiguous qualified-to-basename fallback matches, and skipped for ambiguous basename guesses. Navigation is object-level: alias-qualified and table-qualified column uses can resolve to table/view definitions, but not to specific column declarations. These APIs expose the lower-level statement facts and candidate graph for common DDL/DML definitions, reads, writes, constraints, CTEs, renames, truncates, and merges. They do not infer a current schema, and application-code string literals are bridged to SQL only through explicit review-context rules.

```ts
import { extractSqlFactsFromSource, projectSqlFactsToGraph, collectSqlReviewContext } from "@lzehrung/codegraph";

const filePath = `${process.cwd()}/db/schema.sql`;
const source = "CREATE TABLE users (id integer);";
const facts = extractSqlFactsFromSource(filePath, source);
const sqlGraph = projectSqlFactsToGraph(facts);

const sqlContext = await collectSqlReviewContext(process.cwd(), {
  changedFiles: [filePath],
});
```

`SqlStatementFact` records the source file, statement line/column/index range, file role, fact kind, object name, related object name, statement text, and truth tier. Review context uses explicit bridge reasons such as `changed_sql_file` and `changed_sql_literal`.

## Stable symbol handles

Use stable handles instead of cursor positions.

A handle is either:

- `${file}::${localName}::${startIndex}` for a definition
- `${file}::${alias}::import` for an import alias

```ts
import { buildProjectIndex, listSymbols, goToDefinitionById, findReferencesById } from "@lzehrung/codegraph";

const root = process.cwd();
const index = await buildProjectIndex(root);
const file = `${root}/tests/samples/monorepo/packages/pkg-b/src/index.js`.replace(/\\/g, "/");
const items = listSymbols(index, { file, includeImports: true });
const handle = items.find((item) => item.name === "aHelper")?.id;

if (handle) {
  const defRes = await goToDefinitionById(index, handle);
  const refsRes = await findReferencesById(index, handle);
  console.log(defRes.status, refsRes.status);
}
```

## Impact analysis from code

```ts
import { buildProjectIndex, analyzeImpactFromDiff } from "@lzehrung/codegraph";

const root = process.cwd();
const index = await buildProjectIndex(root);

const report = await analyzeImpactFromDiff(root, index, {
  provider: "git",
  base: "main",
  head: "feature-branch",
  ignoreGlobs: ["**/package-lock.json"],
});

if (report.warning) {
  console.warn(`Impact warning: ${report.warning}`);
}

console.log(`Changed symbols: ${report.changedSymbols.length}`);
console.log(`Impacted files: ${report.impacted.length}`);
for (const item of report.impacted.slice(0, 5)) {
  console.log(`${item.file}: ${item.symbols.join(", ")} (${(item.severity * 100).toFixed(1)}% severity)`);
}
```

### Call Compatibility Hints

Changed symbols can include `callCompatibility` when a provider-backed callable signature changed and Codegraph resolved high-confidence callsites. These hints compare argument counts only; they are deterministic review leads, not type checking or overload analysis.

Use them to prioritize follow-up review:

- `status: "likely_mismatch"` means a resolved callsite now appears to pass too few or too many arguments.
- `reason` explains the direction, such as `argument_count_below_minimum` or `argument_count_above_maximum`.
- `expected` is the changed callable arity after the diff.
- `actual` is the resolved callsite argument count.
- `callsiteFile` and `callsiteRange` identify the location to inspect.

```ts
const likelyMismatches = report.changedSymbols.flatMap((symbol) =>
  (symbol.callCompatibility ?? []).filter((hint) => hint.status === "likely_mismatch"),
);

for (const hint of likelyMismatches) {
  console.log(`${hint.callsiteFile}:${hint.callsiteRange.start.line} ${hint.reason}`);
}
```

Coverage is intentionally conservative:

- Compatible callsites may be present in structured data but are omitted from human summaries.
- Unsupported languages, unknown signatures, spread calls, ambiguous callsites, overload sets, and JS/TS method-level call compatibility are skipped until Codegraph can prove the call target.

Include reference context snippets when needed:

```ts
const reportWithLineContext = await analyzeImpactFromDiff(root, index, {
  provider: "git",
  base: "main",
  head: "feature-branch",
  refContext: "line",
  refContextLines: 3,
});

const reportWithBlockContext = await analyzeImpactFromDiff(root, index, {
  provider: "git",
  base: "main",
  head: "feature-branch",
  refContext: "block",
  refBlockMaxLines: 30,
});
```

## Agent tool wrappers

The library also exports agent-oriented wrappers with explicit status discriminants.

`tool_getFileOverview()` is structured-first. Its `ok` result exposes `overview.imports` and `overview.definitions` directly for agent consumption, while `renderedOverview` remains an optional convenience string for logging or debugging.

```ts
import { buildProjectIndex, tool_getFileOverview } from "@lzehrung/codegraph";

const root = process.cwd();
const index = await buildProjectIndex(root);
const overview = await tool_getFileOverview(root, "src/main.ts", { index });
if (overview.status === "ok") {
  console.log(overview.overview.imports);
  console.log(overview.overview.definitions);
}
```

For bounded graph exploration, prefer the smaller wrappers before requesting the full file graph:

```ts
import {
  buildProjectIndex,
  tool_findSymbol,
  tool_getDependencies,
  tool_getReverseDependencies,
  tool_getHotspots,
  tool_goToDefinition,
  tool_findReferences,
  tool_impactJSON,
} from "@lzehrung/codegraph";

const root = process.cwd();
const index = await buildProjectIndex(root);
const symbolHits = await tool_findSymbol(root, "collectGraph", { index });
const deps = await tool_getDependencies(root, "src/agent-tools.ts", { depth: 2, limit: 20, index });
const reverseDeps = await tool_getReverseDependencies(root, "src/index.ts", { depth: 2, limit: 20, index });
const hotspots = await tool_getHotspots(root, { limit: 20, index });
const definition = await tool_goToDefinition(root, "src/main.ts", 10, 5, index);
const references = await tool_findReferences(root, "src/main.ts", 10, 5, index);
const impact = await tool_impactJSON(root, { provider: "git", base: "HEAD", head: "WORKTREE" }, { index });
```

### Programmatic review and impact output

Use the exported TypeScript APIs when another program is composing deterministic review packets, file packs, or model prompts. CLI `--pretty` and `--summary` output is optimized for humans reading a terminal; it is not the stable integration contract.

- `buildReviewReport()` returns a review bundle with `schemaVersion`, changed files, changed symbols, `graphDelta`, candidate tests, `riskSummary`, `reviewTasks`, optional `sqlContext`, compatibility hints when available, and diagnostics.
- `analyzeImpactFromDiff()` returns the full or compact impact report shape for batch consumers, including changed-symbol `callCompatibility` hints when available.
- `analyzeImpactStreaming()` emits progress and incremental chunks, then a final `complete.report` summary. Streaming always returns `format: "stream-summary"`; forwarded `compact` is accepted only for compatibility and is ignored. By default this includes the same key structured fields needed by pack builders: changed files, changed symbols, impacted items, suggestions, export summaries, re-export chains, ranked top impacts, surface area, clusters, cycles, graph edges, diagnostics, and warning text. Set `streamSummary: "light"` when an incremental-only caller wants changed/impacted details and stable terminal counts without paying for terminal suggestions, export summaries, re-export chains, ranked top impacts, graph metadata, cycles, clusters, or surface-area analysis.

Review-pack builders should preserve symbol handles, diff snippets, callsites, `callCompatibility`, diagnostics, candidate-test confidence, impact reasons, and graph edge metadata. Render prose only at the final UI or prompt boundary.

Human-readable summaries such as `codegraph review --summary` and `codegraph impact --pretty` are CLI presentation modes. Library callers should use `buildReviewReport()`, `analyzeImpactFromDiff()`, `analyzeImpactStreaming()`, or `tool_impactJSON()` and format only the selected fields they need.

Duplicate leads in human impact and review summaries are also presentation-only. Programmatic callers should use `findDuplicates()` when they need grouped clone data, variants, raw pair counts, or duplicate omission counts.

Useful wrapper details:

- Build a shared index once and pass it through when an agent will call several wrappers in one pass; otherwise each wrapper may rebuild the same project view.
- `tool_findSymbol()` returns stable `id` handles plus `range`, `exported`, `exactMatch`, and `matchKind`.
- `tool_goToDefinition()` and `tool_findReferences()` surface additive `provenance` metadata when the resolver used imports, namespaces, or other non-local paths.
- `tool_getDependencies()`, `tool_getReverseDependencies()`, and `tool_getHotspots()` ignore non-finite `limit` values and clamp non-positive finite values to empty bounded results instead of returning malformed slices.
- The batch impact wrappers include `schemaVersion` and `format: "full" | "compact"` so downstream agents do not have to infer payload shape; streaming `complete.report` uses `format: "stream-summary"`.

## Related docs

- [docs/installation.md](./installation.md)
- [docs/cli.md](./cli.md)
- [docs/agent-workflows.md](./agent-workflows.md)
- [docs/how-it-works.md](./how-it-works.md)
