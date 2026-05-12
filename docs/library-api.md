# Library API

Programmatic APIs for indexing, graph building, chunking, read-only SQL inspection, and impact analysis.

For sessions, streaming workflows, tool wrappers, and review-oriented recipes, see [docs/agent-workflows.md](./agent-workflows.md).

## Runtime model

Import graph, indexing, navigation, review, CLI-wrapper, and session APIs from `@lzehrung/codegraph` and call them directly. Import direct refactor/edit helpers from `@lzehrung/codegraph-refactor` when your SDK integration intentionally emits source edits.

The library defaults to `native: "auto"`, which uses the native Tree-sitter path when `@lzehrung/codegraph-native` is installed for the current platform and falls back automatically otherwise.

Shared source helpers such as `stripJsLikeComments()` and `maskJsLikeCommentsAndStrings()` are exported for integrations that need length-preserving scans over JavaScript-like code.

Override that per call with `native: "on"` or `native: "off"`.

- `native: "on"` requires the native addon and raises an error if it cannot be loaded.
- `native: "off"` means the opt-in JS fallback path and requires `@lzehrung/codegraph-js-fallback`.

```ts
import { buildProjectIndex } from "@lzehrung/codegraph";

const index = await buildProjectIndex(process.cwd(), { native: "auto" });
const jsOnlyIndex = await buildProjectIndex(process.cwd(), { native: "off" });
```

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

```ts
import { listProjectFiles, discoverProjectFiles, collectGraph } from "@lzehrung/codegraph";

const root = process.cwd();
const files = await listProjectFiles(root);
const tsFilesOnly = await listProjectFiles(root, undefined, {
  includeGlobs: ["src/**/*.ts"],
  ignoreGlobs: ["src/**/*.spec.ts"],
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

Build an index from an explicit multi-root file list:

```ts
import { listProjectFiles, buildProjectIndexFromFiles } from "@lzehrung/codegraph";

const root = process.cwd();
const tsRoot = `${root}/tests/samples/typescript`;
const jsRoot = `${root}/tests/samples/javascript`;
const files = [...(await listProjectFiles(tsRoot)), ...(await listProjectFiles(jsRoot))];

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

`queryGraphSqliteRaw()` is intentionally read-only. It accepts result-producing statements such as `SELECT` and `PRAGMA` and rejects mutating SQL.

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

Pass `trivia: "leading-doc"` or `trivia: "leading-all"` to `listSymbols()` when a caller needs ranges that include attached docs or docs plus decorators/attributes. The cached symbol definition is not mutated; the expanded range is derived for that call. Direct `getSymbolRange()` callers that are about to emit edits against disk can pass `source: "disk"` to avoid using a stale cached parse.

## Refactor edits

Use stable definition handles with `renameSymbol()` to build deterministic edits without writing files. Use `applyEdits()` as a separate step when the caller is ready to modify the worktree. Direct-code integrations import these helpers from `@lzehrung/codegraph-refactor`.

```ts
import { buildProjectIndex, listSymbols } from "@lzehrung/codegraph";
import {
  applyEdits,
  extractFunction,
  moveSymbol,
  renameSymbol,
} from "@lzehrung/codegraph-refactor";

const root = process.cwd();
const index = await buildProjectIndex(root);
const handle = listSymbols(index).find((item) => item.name === "greet")?.id;

if (handle) {
  const result = await renameSymbol(index, handle, "salute");
  if (result.status === "ok") {
    const applied = await applyEdits(result.edits, { useGit: true, gitCwd: root });
    for (const warning of applied.warnings) console.warn(warning);
  }
}
```

`renameSymbol()` currently supports semantic definition renames and rejects import-alias handles plus obvious target-name collisions in the declaring file. The returned edit list includes declaration, reference, and named-import specifier edits, including aliased specifiers, when those locations can be resolved safely.

`moveSymbol(index, handle, targetFile)` moves TypeScript and JavaScript top-level declarations with leading trivia, carries imports used by the moved declaration into the target file, rewrites named ES importers, and imports the moved declaration back into the source file when remaining siblings still reference it. Unsupported languages or unsafe target collisions return `{ status: "unsupported" }`.

`extractFunction(index, { file, range }, { newName })` extracts contiguous TypeScript and JavaScript statement ranges inside one function body. Library ranges follow the normal half-open `Range` contract; CLI and agent tool `startLine:endLine` ranges are inclusive. v1 preserves simple TypeScript parameter annotations in generated helpers and rejects early `return`, unsupported control flow, context-sensitive bindings, and selected declarations used after the range.

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
  tool_refactorExtract,
  tool_refactorMove,
  tool_refactorRename,
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
const extract = await tool_refactorExtract(root, {
  file: "src/main.ts",
  range: { startLine: 10, endLine: 14 },
  to: "helper",
  index,
});
const move = await tool_refactorMove(root, { symbol: "src/main.ts::greet::10", toFile: "src/target.ts", index });
const rename = await tool_refactorRename(root, { symbol: "src/main.ts::greet::10", to: "salute", index });
const impact = await tool_impactJSON(root, { provider: "git", base: "HEAD", head: "WORKTREE" }, { index });
```

### Programmatic review and impact output

Use the exported TypeScript APIs when another program is composing deterministic review packets, file packs, or model prompts. CLI `--pretty` and `--summary` output is optimized for humans reading a terminal; it is not the stable integration contract.

- `buildReviewReport()` returns a review bundle with `schemaVersion`, changed files, changed symbols, `graphDelta`, candidate tests, `riskSummary`, `reviewTasks`, and diagnostics.
- `analyzeImpactFromDiff()` returns the full or compact impact report shape for batch consumers.
- `analyzeImpactStreaming()` emits progress and incremental chunks, then a final `complete.report` summary. Streaming always returns `format: "stream-summary"`; forwarded `compact` is accepted only for compatibility and is ignored. By default this includes the same key structured fields needed by pack builders: changed files, changed symbols, impacted items, suggestions, export summaries, re-export chains, ranked top impacts, surface area, clusters, cycles, graph edges, diagnostics, and warning text. Set `streamSummary: "light"` when an incremental-only caller wants changed/impacted details and stable terminal counts without paying for terminal suggestions, export summaries, re-export chains, ranked top impacts, graph metadata, cycles, clusters, or surface-area analysis.

Review-pack builders should preserve symbol handles, diff snippets, callsites, diagnostics, candidate-test confidence, impact reasons, and graph edge metadata. Render prose only at the final UI or prompt boundary.

Human-readable summaries such as `codegraph review --summary` and `codegraph impact --pretty` are CLI presentation modes. Library callers should use `buildReviewReport()`, `analyzeImpactFromDiff()`, `analyzeImpactStreaming()`, or `tool_impactJSON()` and format only the selected fields they need.

Useful wrapper details:

- Build a shared index once and pass it through when an agent will call several wrappers in one pass; otherwise each wrapper may rebuild the same project view.
- `tool_findSymbol()` returns stable `id` handles plus `range`, `exported`, `exactMatch`, and `matchKind`.
- `tool_findSymbol()` and `tool_getFileOverview()` accept `trivia: "leading-doc" | "leading-all"` when agents need selection ranges that include attached documentation or attributes.
- `tool_refactorExtract()` requires `@lzehrung/codegraph-refactor` at runtime, then returns canonical extract edits plus a compact `diff` string. It does not write files.
- `tool_refactorMove()` requires `@lzehrung/codegraph-refactor` at runtime, then returns canonical move edits plus a compact `diff` string. It does not write files.
- `tool_refactorRename()` requires `@lzehrung/codegraph-refactor` at runtime, then returns the same canonical edits as `renameSymbol()` plus a compact `diff` string for agent logs. It does not write files.
- `tool_goToDefinition()` and `tool_findReferences()` surface additive `provenance` metadata when the resolver used imports, namespaces, or other non-local paths.
- `tool_getDependencies()`, `tool_getReverseDependencies()`, and `tool_getHotspots()` ignore non-finite `limit` values and clamp non-positive finite values to empty bounded results instead of returning malformed slices.
- The batch impact wrappers include `schemaVersion` and `format: "full" | "compact"` so downstream agents do not have to infer payload shape; streaming `complete.report` uses `format: "stream-summary"`.

## Related docs

- [docs/installation.md](./installation.md)
- [docs/cli.md](./cli.md)
- [docs/agent-workflows.md](./agent-workflows.md)
- [docs/how-it-works.md](./how-it-works.md)
