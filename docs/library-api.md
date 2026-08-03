# Library API

Programmatic APIs for indexing, graph building, live file views, agent search/explain/artifacts, MCP handlers, chunking, SQL artifact facts, read-only SQLite inspection, and impact analysis.

For sessions, streaming workflows, tool wrappers, and review-oriented recipes, see [docs/agent-workflows.md](./agent-workflows.md).

## Runtime model

Import from `@lzehrung/codegraph` or one of its documented subpath facades and
call the API directly.

The library defaults to `native: "auto"`, which uses the native Tree-sitter path when `@lzehrung/codegraph-native` is installed for the current platform and falls back automatically otherwise.

Override that per call with `native: "on"` or `native: "off"`.

- `native: "on"` requires the native addon and raises an error if it cannot be loaded.
- `native: "off"` disables native explicitly and runs reduced graph-only and regex recovery mode.

```ts
import { buildProjectIndex } from "@lzehrung/codegraph";

const index = await buildProjectIndex(process.cwd(), { native: "auto" });
const reducedIndex = await buildProjectIndex(process.cwd(), { native: "off" });
```

For repeated calls, prefer one warm session instead of rebuilding indexes ad hoc:

- `createCodeReviewSession()` for repeated navigation and impact work in library code
- `createAgentSession()` or MCP for repeated orient/search/explain/packet work in agent hosts

CLI commands and agent sessions read `codegraph.config.json` from the project root when it exists. Core indexing APIs keep discovery and language mappings explicit, so pass both options directly when you want the same behavior in custom code:

```ts
import { buildProjectIndex, loadCodegraphConfig } from "@lzehrung/codegraph";

const root = process.cwd();
const config = await loadCodegraphConfig(root);
const index = await buildProjectIndex(root, {
  ...(config.discovery ? { discovery: config.discovery } : {}),
  ...(config.graph ? { graph: config.graph } : {}),
  ...(config.languages?.extensions ? { languageExtensions: config.languages.extensions } : {}),
});
```

`languageExtensions` uses normalized literal suffixes beginning with `.`, supported language IDs, and longest-suffix matching. Suffixes may contain letters, digits, `.`, `_`, `+`, and `-`; `.vue` and `.svelte` remain single-file components and cannot be remapped.

## Public API Boundary

The npm package exposes these supported entry points:

- `@lzehrung/codegraph` for the compatibility root surface.
- `@lzehrung/codegraph/agent` for agent sessions, live file views,
  workspace-symbol lookup, orient/search/explain, artifacts, and MCP handler helpers.
- `@lzehrung/codegraph/graphs` for graph builders, graph queries, renderers,
  symbol graphs, grep, hotspots, cycles, and unresolved-import helpers.
- `@lzehrung/codegraph/indexer` for project indexing, workspace-symbol lookup,
  navigation, references, symbols, and API-surface analysis.
- `@lzehrung/codegraph/impact` for diff impact analysis, streaming impact
  reports, impact context, and candidate test helpers.
- `@lzehrung/codegraph/languages` for language-support metadata.

Do not import from generated paths such as `@lzehrung/codegraph/dist/...` or
repo-internal source paths. Those modules are implementation details and can
move during refactors.

The root entry point is intentionally broad today for compatibility. Treat it
as three groups:

- Public-stable APIs are the documented integration surface: indexing and
  navigation (`buildProjectIndex`, `buildProjectIndexIncremental`,
  `goToDefinition`, `findReferences`, symbol handles, graph builders and
  renderers), impact and review reports, sessions, agent search/explain/artifact
  and file-view helpers, MCP handlers, SQLite helpers, SQL artifact APIs, chunking, config,
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

Future API narrowing should happen by first documenting replacements on these
subpath facades, then adding deprecation notes before removing root
compatibility exports.

## Workspace-symbol lookup

The root package exports agent-level `workspaceSymbols(request)` and `workspaceSymbolsWithSession(session, request)`. It aliases the index-level function as `queryWorkspaceSymbols(index, request)` to avoid ambiguity; `@lzehrung/codegraph/indexer` exports that core function as `workspaceSymbols`.

```ts
import { createAgentSession, SymbolKind, workspaceSymbolsWithSession } from "@lzehrung/codegraph";

const root = process.cwd();
const session = createAgentSession({ root });
const result = await workspaceSymbolsWithSession(session, {
  root,
  query: "CodeReviewSession",
  kinds: [SymbolKind.Class],
  exportedOnly: true,
  fileGlob: "src/**/*.ts",
  limit: 50,
});
```

Requests accept `query`, `kinds`, `exportedOnly`, `includeImports`, `fileGlob`, and `limit`; standalone agent calls also require `root` and accept `buildOptions`. Imports default off, limits default to 50 and cap at 500, and an empty query requires a kind or file-glob filter.

`WorkspaceSymbolsResponse` includes the shared semantic envelope, query, symbols, and total candidates. Symbols are deterministic and project-relative; resolvable named/default import aliases keep their binding location but use a portable handle for the declaration, while namespace/star aliases, unresolved aliases, and failed import scans contribute explicit omission counts.

For tool hosts, `tool_workspaceSymbols(root, request, runtimeOptions)` accepts an optional warm `AgentSession` or build options, but not both. Shared semantic location, provenance, omission, symbol, and response-envelope types are exported from the root and agent entry points.

## Call hierarchy

The root and `@lzehrung/codegraph/agent` entry points export `findCallers`, `findCallees`, and their `WithSession` variants. Requests use `root`, a portable callable `handle`, optional `depth` from 1 to 5, optional `limit` from 0 to 500, optional `includeHeuristic`, and optional standalone `buildOptions`.

```ts
import { createAgentSession, findCallersWithSession } from "@lzehrung/codegraph";

const root = process.cwd();
const session = createAgentSession({ root });
const result = await findCallersWithSession(session, {
  root,
  handle: "symbol:src/service.ts:run:5:3",
  depth: 2,
  limit: 100,
});
```

Responses group exact project-relative callsites under deterministic related symbols and report freshness, provenance, effective limits, and separate symbol, callsite, and unresolved-site omissions. Current extraction returns resolved semantic `calls` edges only; `includeHeuristic` is accepted but does not infer dynamic dispatch or promote imports, references, or file dependencies into calls.

The root exposes the index-core operation as `queryCallHierarchy(graph, id, direction, options)`; `@lzehrung/codegraph/indexer` exports it as `findCallHierarchy`. Tool hosts can use `tool_findCallers` and `tool_findCallees` with either a warm session or build options, but not both.

## Type hierarchy and implementations

The root and `@lzehrung/codegraph/agent` entry points export `findSupertypes`, `findSubtypes`, `findImplementations`, and their `WithSession` variants. Requests use `root`, a portable symbol `handle`, optional `limit`, optional hierarchy `depth`, and optional standalone `buildOptions`.

```ts
import { createAgentSession, findSubtypesWithSession, workspaceSymbolsWithSession } from "@lzehrung/codegraph";

const root = process.cwd();
const session = createAgentSession({ root });
const matches = await workspaceSymbolsWithSession(session, { root, query: "Service" });
const service = matches.symbols[0];
if (service) {
  const result = await findSubtypesWithSession(session, {
    root,
    handle: service.handle,
    depth: 3,
    limit: 100,
  });
  console.log(result.relations);
}
```

Hierarchy depth defaults to 1 and caps at 10; hierarchy and implementation results default to 100 and cap at 500. Responses use the shared semantic envelope with exact project-relative symbols, declaration or relation sites when extraction provides them, provenance, effective limits, and omission counts.

The root aliases index-core functions as `queryTypeHierarchy(graph, id, direction, options)` and `queryImplementations(index, graph, id, options)`; `@lzehrung/codegraph/indexer` exports them as `findTypeHierarchy` and `findImplementations`. Tool hosts can use `tool_findSupertypes`, `tool_findSubtypes`, and `tool_findImplementations` with either a warm session or build options, but not both.

Only proven indexed `extends` and `implements` relationships participate. Implementation targets are limited to interfaces, traits, abstract types, and members with proven implementation or override relationships; results identify exact implementing declarations, deduplicate inherited declarations, and reject unresolved overload identity instead of inferring same-name matches.

## Rename preview

The root and `@lzehrung/codegraph/agent` entry points export `previewRename`, `previewRenameWithSession`, and `previewRenameInSnapshot`. `RenamePreviewRequest` uses `root`, a portable symbol `handle`, `newName`, optional comment, string, and filename inclusion flags, optional `maxEdits`, and optional standalone `buildOptions`.

```ts
import { createAgentSession, previewRenameWithSession } from "@lzehrung/codegraph";

const root = process.cwd();
const session = createAgentSession({ root });
const preview = await previewRenameWithSession(session, {
  root,
  handle: "symbol:src/Service.ts:Service:1:14",
  newName: "RenamedService",
  includeFilenames: true,
});
```

`RenamePreviewResponse` returns the target, proposed name, `safe`, exact project-relative edits, conflicts, unsafe sites, filename suggestions, candidate tests, provenance, freshness, limits, and omissions. Exported concrete types include `RenameEdit`, `RenameEditKind`, `RenameConflict`, `RenameUnsafeSite`, `RenameFilenameSuggestion`, and `RenameCandidateTest`.

`tool_previewRename(root, request, runtimeOptions)` accepts either a shared `AgentSession` or build options, but not both, and returns the shared response unchanged. All rename-preview entry points are read-only: eligible exported class, interface, and type filenames produce suggestions only, project files are never changed, and no apply API exists.

## Refactor evidence plans

The root and `@lzehrung/codegraph/agent` entry points export `buildRefactorPlan`, `buildRefactorPlanWithSession`, and `buildRefactorPlanInSnapshot`, plus `RefactorPlanRequest`, `RefactorPlanResponse`, and `RefactorPlanSectionIssue`. A request accepts `root`, a portable search or workspace-symbol handle or exact internal review/impact symbol handle, optional `renameTo`, independent `maxReferences`, `maxCallers`, and `maxHierarchy` bounds from 0 to 500, optional `includeSource`, and optional standalone `buildOptions`.

```ts
import { buildRefactorPlanWithSession, createAgentSession } from "@lzehrung/codegraph";

const root = process.cwd();
const session = createAgentSession({ root });
const plan = await buildRefactorPlanWithSession(session, {
  root,
  handle: "symbol:src/Service.ts:Service:1:14",
  renameTo: "RenamedService",
  maxReferences: 200,
  maxCallers: 100,
  maxHierarchy: 100,
});
```

One session load and freshness decision feed the target, definition, references, callers, callees, supertypes, subtypes, implementations, candidate tests, and follow-ups. Unsupported implementation sections appear in `plan.sectionIssues` and contribute an omission instead of silently looking complete; internal input handles are normalized to a portable target handle, and nested `plan.rename.safe` remains authoritative when present.

`tool_buildRefactorPlan(root, request, runtimeOptions)` accepts either a shared `AgentSession` or build options, but not both. Every entry point returns evidence only, never writes source, and exposes no apply API.

## Live file views

`getCodegraphFileView()` reads a confined project file directly from disk. `getCodegraphFileViewWithSession()` accepts an existing `AgentSession` for optional graph reuse, and `formatAgentFileViewResponse()` renders the same response as stable pretty text.

```ts
import {
  createAgentSession,
  formatAgentFileViewResponse,
  getCodegraphFileView,
  getCodegraphFileViewWithSession,
} from "@lzehrung/codegraph";

const page = await getCodegraphFileView({
  root: process.cwd(),
  file: "src/auth.ts",
  offset: 1,
  limit: 200,
  maxBytes: 80_000,
});

if (page.page?.nextOffset) {
  const next = await getCodegraphFileView({
    root: process.cwd(),
    file: page.file,
    offset: page.page.nextOffset,
    limit: page.limit,
  });
  console.log(next.content);
}

const session = createAgentSession({ root: process.cwd() });
const contextual = await getCodegraphFileViewWithSession(session, {
  root: process.cwd(),
  file: "src/auth.ts",
  includeGraphContext: true,
});
console.log(formatAgentFileViewResponse(contextual));
```

`AgentFileViewRequest` has `root`, `file`, optional 1-based `offset`, `limit`, `maxBytes`, `includeGraphContext`, `allowSensitive`, and `buildOptions`. Line and output-page byte defaults are `2000` and `80000`, capped at `10000` and `500000`; the page byte budget applies to unnumbered raw text, including line separators. A separate 16 MiB hard input-size limit rejects larger raw reads and structural text-config summaries before unbounded I/O, bounding complete-stream binary/UTF-8 validation and total-line counting.

`AgentFileViewResponse` always has `schemaVersion`, normalized project-relative `file`, effective `offset` and `limit`, exact whole-file `totalLines`, numbered `content`, `lineFormat: "number-tab-line"`, unnumbered `text`, `truncated`, and `freshness`. Optional `page.nextOffset`, `graphContext`, and `sensitive` fields describe remaining lines, requested indexed context, and sensitive-file handling respectively.

The numbered format is exactly unpadded decimal line number, tab, source line. A trailing newline contributes a final empty line, and pagination should resume from `page.nextOffset`; for raw pages, `maxBytes` may return fewer than `limit` lines and sets `truncated` when it cuts a selected line. An offset beyond EOF returns empty `content` and `text`, while `formatAgentFileViewResponse()` says `Lines: none at offset <offset> of <totalLines>`.

Graph context defaults off, so a plain call neither creates nor consults an index and its live bytes are independent of session freshness. Set `includeGraphContext: true` to request at most 100 direct `usedBy` files, imports, and `{ name, kind, line }` symbols; only this indexed context is governed by `freshness`.

Within the 16 MiB input limit, ordinary reads and structural summaries for recognized environment, authentication, and credential text configs validate the full raw stream before returning bounded content or extracting bounded keys; known binary extensions, NUL bytes, and malformed or incomplete UTF-8 are rejected. Default key-material summaries use file metadata, may report size, and do not read raw secret bytes; `allowSensitive: true` requests raw values but does not bypass the input-size, binary, NUL, or UTF-8 guards, so `.p12` and `.pfx` bundles summarize by default and reject raw access. For text-config summaries, `truncated` reports an incomplete bounded structural scan.

The root package and `@lzehrung/codegraph/agent` export these functions, constants, `AgentFileViewRequest`, `AgentFileViewResponse`, `AgentFileGraphContext`, `AgentFileViewSensitiveInfo`, and `AgentFileViewSensitiveKind`.

## Agent packets

`orientCodegraph()` returns compact first-turn context for an agent, and `getCodegraphPacket()` retrieves bounded evidence by file path, symbol name, SQL object name, or stable target:

```ts
import { getCodegraphPacket, orientCodegraph } from "@lzehrung/codegraph";

const orientation = await orientCodegraph({
  root: process.cwd(),
  includeRoots: ["src"],
  budget: "small",
});

const target = orientation.focus.find((entry) => entry.file);
if (target?.file) {
  const packet = await getCodegraphPacket({
    root: process.cwd(),
    target: target.file,
    maxSymbols: 25,
  });
  console.log(target.why, packet.kind, packet.followUps);
}
```

Use orientation before broad search when a caller needs repo context but has no query yet. `focus` ranks file targets that should be tried first, with graph-central hotspots ahead of shallow root files. Search and explain still expose stable handles for symbols, chunks, SQL objects, graph neighborhoods, and review ranges.
Small orientation budgets default to `health: "skip"` and set health fields to `null` while recording the omission. Medium and large default to `health: "summary"`, which counts cycles and unresolved imports while omitting duplicate health. Use `health: "full"` when exhaustive duplicate counts are needed.

## Agent search

`searchCodegraph()` builds a project snapshot and returns deterministic, agent-ready anchors across files, symbols, chunks, SQL objects, and optional graph neighborhoods. Hybrid search is code-first by default, so implementation files and symbols outrank docs unless `mode: "text"` is explicit or docs are the strongest remaining evidence. Identifier-like queries stay symbol-first. Pure `path` and `text` searches skip detailed symbol graph construction; hybrid, symbol, SQL, and graph searches keep symbol-aware ranking and neighbors. Handles are project-relative and explainable; result packets include top-level `analysis`, per-result `provenance`, `resultCount`, `totalCandidates`, `limits`, and `omittedCounts`.

```ts
import { buildCodegraphArtifact, explainCodegraphTarget, exploreCodegraph, searchCodegraph } from "@lzehrung/codegraph";

const response = await searchCodegraph({
  root: process.cwd(),
  query: "validate user",
  mode: "hybrid",
  limit: 10,
});

const first = response.results[0];
console.log(first?.handle, first?.rankReasons, first?.omittedCounts, first?.followUps);

const explored = await exploreCodegraph({
  root: process.cwd(),
  query: "how does auth reach db?",
  limit: 5,
  maxPackets: 3,
  maxPaths: 3,
});

console.log(explored.summary, explored.paths, explored.followUps);

const exactFile = await exploreCodegraph({
  root: process.cwd(),
  query: "src/auth.ts",
  includeGraphContext: false,
});
console.log(exactFile.fileView?.content, exactFile.fileView?.page?.nextOffset);
```

Use `exploreCodegraph()` when the caller has a broad question and needs one bounded response over the existing search, packet, path, reverse-dependency, and candidate-test surfaces. The response has `schemaVersion: 1`, the original query, `analysis`, summary bullets, anchors, packets, paths, blast radius with per-entry omitted lower bounds, candidate tests, follow-ups, flat limits, and omission counts. Path and blast-radius omissions may be lower bounds after bounded scans reach their caps.
When the entire query resolves to an indexed project-relative file path, or to one uniquely matching basename, the response also includes the live `fileView` described above. `includeSource: false` suppresses it; `includeGraphContext` and `allowSensitive` remain explicit request options and are never enabled automatically.

Use `mode: "sql"` for SQL objects, or pass `from` plus `depth` with `mode: "graph"` to boost matches near a file path, file/chunk/graph handle, symbol handle, SQL handle, or symbol name.

`explainCodegraphTarget()` resolves a file path, symbol name, SQL object name, or search handle into a bounded packet for follow-up agent work. Explanations include the same top-level `analysis` label as search so reduced or mixed runs stay visible. SQL object names resolve by exact name first; unqualified basenames resolve only when unique. File and symbol explanations also include bounded medium-or-higher duplicate context that touches the target, with stable handles and conservative repair hints. SQL related objects include a `relation` such as `incoming:reads_from`, `outgoing:writes_to`, or `same_file`. With changed context enabled, the packet includes compact review tasks and candidate tests:

```ts
const explanation = await explainCodegraphTarget({
  root: process.cwd(),
  target: first?.handle ?? "src/auth.ts",
  maxSymbols: 25,
  maxDependencies: 10,
  maxReferences: 10,
  maxRelatedSqlObjects: 10,
  maxSnippets: 5,
  maxDuplicates: 5,
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

`createAgentSession()` keeps one in-process project snapshot warm for repeated explore, orient, search, explain, packet, artifact, and MCP calls. It uses incremental indexing with disk cache by default, auto-enables native workers for large cold builds, and carries forward top-level analysis metadata from the build report.
Session callers can use `freshness: { policy: "check" | "auto" | "manual" }` plus `checkFreshness()` to detect file edits before reusing a warm snapshot. `check` reports stale state without invalidating, `auto` invalidates for bounded changes, and stale results include `changedFileCount`, `omittedChangedFileCount`, `reason`, and a bounded changed-file sample.
Set `buildOptions.useNativeWorkers` to `false` to opt out. Use `buildCodegraphArtifactWithSession()` when a host already has a session and wants SQLite, graph JSON, report, questions, and manifest outputs from the same snapshot. `createCodegraphMcpHandlers()` exposes the same primitives without starting stdio, which is useful for tests or host applications:

```ts
import { createCodegraphMcpHandlers } from "@lzehrung/codegraph";

const handlers = createCodegraphMcpHandlers({
  root: process.cwd(),
  artifactPath: "codegraph-out",
  readOnly: true,
});

const search = await handlers.search({ query: "auth user", limit: 5 });
const orient = await handlers.orient({ includeRoots: ["src"], budget: "small" });
const packet = await handlers.packet_get({ target: orient.focus.find((entry) => entry.file)!.file! });
const refs = await handlers.refs({ handle: search.results[0]!.handle });
const rows = await handlers.query_sqlite({ query: "select path from files", limit: 5 });
console.log(search.freshness.state);
console.log(packet.kind, refs.references, rows.rows, rows.freshness.state);
```

`serveCodegraphMcp()` starts the stdio server used by `codegraph mcp serve`. MCP is an agent ergonomics and cache layer over the same analysis engine, not a separate indexer. MCP file and artifact paths are confined after realpath resolution.
`query_sqlite` is read-only and row- and byte-bounded. It returns freshness metadata for fresh artifact reads, refreshes Codegraph-owned SQLite artifacts after small edits when write access is enabled, and rejects stale artifact queries it cannot refresh safely.
`artifact_build` is disabled by default and requires `readOnly: false` or CLI `--allow-build`; it refuses to write outputs from a stale MCP index until `refresh_index` succeeds. MCP `orient` and `packet_get` calls use the server-configured root; they do not accept per-request root overrides.

See [MCP server](./mcp.md) for CLI server setup and client configuration examples.

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
- It uses AST shape hashes when parser context is available, while keeping normal token and hash fallback behavior.
- Grouped duplicate output uses `schemaVersion: 2`.
- Results include grouped findings, confidence, score, clone type, metrics, omission counts, and pair stats.
- Group `variants` are bounded by default and expose hidden evidence through `rawPairCount` and `omittedVariantCount`.
- Raw unit-pair suggestions and full group variants are available when `includeRawPairs` is enabled.
- Paths are project-relative when the index has a project root.

```ts
import { buildProjectIndex, findDuplicateContext, findDuplicates } from "@lzehrung/codegraph";

const root = process.cwd();
const index = await buildProjectIndex(root);
const duplicates = await findDuplicates(index, {
  minConfidence: "medium",
  limit: 20,
  similarityHints: [{ leftFile: "src/source.ts", rightFile: "src/copied.ts", similarityIndex: 92 }],
});

console.log(duplicates.groups);

const duplicateContext = await findDuplicateContext(
  index,
  { file: "src/auth.ts" },
  {
    minConfidence: "medium",
    limit: 5,
  },
);
```

Useful options:

- `minConfidence`: `high`, `medium`, or `low`; default `medium`.
- `includeSameFile`: report non-overlapping clones in the same file. Agent explain, packet, and review duplicate context enable this so sibling implementations in one file are still visible.
- `includeSmall`: include units below the default token floor.
- `includeRawPairs`: include low-level symbol/chunk pair evidence as `suggestions`.
- `minTokens` and `maxTokens`: tune unit and fallback chunk bounds.
- `similarityHints`: optional file-pair hints, usually from git copy or rename metadata, that boost matching unit pairs with `gitSimilarity` metrics when the finite similarity index is at least 80.
- `findDuplicateContext`: filters duplicate groups to a target file or line range before applying the result limit.

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

`BuildOptions.onProgress` reports index lifecycle and file progress. A rebuild emits `phase: "start"` with `mode: "build"` or `"update"`, zero or more `phase: "update"` events, and `phase: "complete"` with `elapsedMs`; a reusable snapshot emits no progress events.

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
  ignoreGlobs: ["tests/samples/**", "tests/languages/samples/**"],
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

Optional request-wide budgets on `ImpactOptions` constrain computation before work is scheduled:

- `maxChangedSymbols`, `maxReferenceLookups`, `maxTotalReferences`, `timeBudgetMs`
- Diagnostics report `changedSymbolsTotal/Analyzed/Omitted`, `referenceLookupsStarted/Omitted`, `referencesRetained/Omitted`, and `deadlineExceeded`
- Leaving budgets unset preserves unlimited library behavior

`ReviewOptions.duplicateTasks: false` skips duplicate analysis entirely.

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
- Unsupported languages, unknown signatures, spread calls, ambiguous callsites, and overload sets are skipped until Codegraph can prove the call target. JS/TS method-level call compatibility is included only for verified receivers such as `new Service().run()` and `const service = new Service(); service.run()`.

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

### Architecture drift

Use `analyzeArchitectureDrift()` when a caller needs one deterministic architecture-regression report instead of separately comparing cycles, unresolved imports, API surface, duplicates, hotspots, and graph edges.

```ts
import { analyzeArchitectureDrift } from "@lzehrung/codegraph";

const report = await analyzeArchitectureDrift(process.cwd(), {
  provider: "git",
  base: "origin/main",
  head: "HEAD",
  includeRoots: ["src"],
  failOn: ["new-cycle", "public-api-removal"],
  graphEdges: "summary",
  publicApi: "removals",
  format: "compact",
});
```

Drift callers can tune noise and payload size without changing the core comparison:

- `graphEdges: "full" | "summary" | "off"` controls graph-edge churn detail.
- `publicApi: "all" | "removals" | "off"` controls whether API additions are emitted.
- `format: "compact"` emits bounded example findings plus `summary.byKind` and `summary.bySeverity`.
- Git-backed reports expose logical `base.ref` and `head.ref` values instead of temporary checkout paths.

The API returns `ArchitectureDriftReport` with `schemaVersion: 1`, base/head summaries, bounded findings, and policy state. Drift compares architecture signals only; it does not run code, typecheck, or lint.

### Programmatic review and impact output

Use the exported TypeScript APIs when another program is composing deterministic review packets, file packs, or model prompts. CLI human-readable and `--summary` output is optimized for compact reading by people or models; it is not the stable integration contract.

- `buildReviewReport()` returns a review bundle with `schemaVersion`, changed files, changed symbols, `graphDelta`, candidate tests, `riskSummary`, `reviewTasks`, optional duplicate sibling-check tasks, optional `sqlContext`, compatibility hints when available, and diagnostics.
- `analyzeImpactFromDiff()` returns the full or compact impact report shape for batch consumers, including changed-symbol `callCompatibility` hints when available.
- `analyzeImpactStreaming()` emits progress and incremental chunks, then a final `complete.report` summary. Streaming always returns `format: "stream-summary"`; forwarded `compact` is accepted only for compatibility and is ignored. By default this includes the same key structured fields needed by pack builders: changed files, changed symbols, impacted items, suggestions, export summaries, re-export chains, ranked top impacts, surface area, clusters, cycles, graph edges, diagnostics, and warning text. Set `streamSummary: "light"` when an incremental-only caller wants changed/impacted details and stable terminal counts without paying for terminal suggestions, export summaries, re-export chains, ranked top impacts, graph metadata, cycles, clusters, or surface-area analysis.

Review-pack builders should preserve symbol handles, diff snippets, callsites, `callCompatibility`, diagnostics, candidate-test confidence, impact reasons, and graph edge metadata. Render prose only at the final UI or prompt boundary.

Readable summaries such as `codegraph review --summary` and `codegraph impact` are CLI presentation modes. Library callers should use `buildReviewReport()`, `analyzeImpactFromDiff()`, `analyzeImpactStreaming()`, or `tool_impactJSON()` and format only the selected fields they need.

Duplicate leads in impact and review summaries are also presentation-only. Programmatic callers should use `findDuplicates()` when they need grouped clone data, variants, raw pair counts, or duplicate omission counts.

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
