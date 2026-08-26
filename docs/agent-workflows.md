# Agent Workflows

Guidance for sessions, streaming queries, tool wrappers, and review-oriented agent loops.

Use codegraph for structural repo questions: architecture, dependency direction, symbol definitions, semantic references, hotspots, cycles, public API surface, and PR impact. Use plain text search alongside it for raw strings, logs, config keys, and non-symbol patterns.

## Start here

At a terminal, bare `codegraph` shows the five task-first routes without scanning the project. Use `codegraph --help` for the full catalog.

For code reviews, start with `review`; it is the compact handoff with changed files, changed symbols, candidate tests, risks, duplicate leads, and analysis labels.

```bash
codegraph review
```

Add `impact` only when you need a wider blast-radius map:

```bash
codegraph impact --base HEAD --head WORKTREE
```

For an unfamiliar repo, keep the first loop bounded and actionable:

```bash
codegraph explore "how does auth reach db?" --root .
codegraph orient --root . --budget small
codegraph search "auth user" --json
codegraph explain <file-from-search-or-orient> --json
```

For PR, worktree, or sweeping review tasks, prefer `review` first; use `impact` when you need the broader blast radius map instead of the reviewer handoff.

Use `doctor` only when package/runtime state or an existing artifact path is the question.
Use `explore` when the agent has a broad question and needs search anchors, packets, paths, blast radius, candidate tests, and follow-ups in one bounded response. Use `search` when it only needs anchors, `explain` when it already knows a file/symbol/SQL object/handle, and `inspect` for a human-readable architecture summary.
Use `artifact` for durable handoff directories and `mcp` when repeated follow-up calls should share one warm repo session; `build` and `serve` remain accepted but are optional. If an MCP transport or startup call fails, do not retry the same broken server: run `codegraph doctor`, use the equivalent CLI command for the current session, and restart the agent client after package upgrades. Search locations can be pasted directly into `goto`, `refs`, `file`, `packet`, or `explain`, and semantic commands accept unique exact names when an agent does not yet have a portable handle.

Choose output by the next consumer:

- The CLI defaults to compact human-readable output for `review` and readable output elsewhere; `--pretty` remains an explicit equivalent.
- Use `--json`, MCP tools, or library APIs when the next step needs exact fields, ranges, schema fields, or filtering. If `--json` and `--pretty` are both present, `--json` wins.
- Do not parse pretty text to recover fields already present in structured output.

For durable repo-local scan scope, add `codegraph.config.json` at the project root. `discovery.ignoreGlobs` keeps large fixture, generated, or vendored folders out of agent search, MCP sessions, graphing, unresolved-import checks, impact, and review unless a command explicitly changes scan scope.

For raw command flags and output contracts, see [docs/cli.md](./cli.md). For library types and wrappers, see [docs/library-api.md](./library-api.md).

### Human graph viewing

`viewer` is for a human inspecting a graph, not an agent interface; agents should use graph JSON, SQLite, MCP, or `--json`. Its contract is `codegraph viewer [--root <root>] [--graph <root-confined-json>] [--host <host>] [--port <0-65535>] [--open] [--print-url]`, with the current directory, `127.0.0.1`, and `4173` as the default root, host, and port.

```bash
codegraph viewer --root . --open
codegraph viewer --root . --graph codegraph-out/graph.json --open
codegraph viewer --root . --port 4173 --print-url
```

`--print-url` is preview-only: it prints the deterministic URL and exits without starting a server, rejects `--open`, and rejects port `0`. Without `--graph`, each load or reload builds the current project graph through the automatically validated disk cache; lifecycle initialization and exported JSON are not prerequisites. An explicit `--graph` is served through the same `/graph.json` route; manual upload remains available, and the viewer loads Sigma, Graphology, and ForceAtlas2 from bundled local vendor assets (no CDN).

## Explore facade

Start with `explore` when an agent can ask a concrete repo question:

```bash
codegraph explore "how does auth reach db?" --root .
codegraph explore src/auth.ts --json --limit 5 --max-packets 3
```

Explore orchestrates existing search, packet, path, reverse-dependency, and candidate-test surfaces. It returns `schemaVersion: 1`, the query, analysis metadata, summary bullets, anchors, bounded packets, dependency paths, blast radius, candidate tests, follow-ups, flat limits, and omission counts.

Human-readable output ends with one `Recommended next:` command selected from the first bounded follow-up. Use `--no-source` when the caller only needs anchors, paths, and follow-up commands.

## Live file reads

Use `file` when the target path is known and the agent needs current source rather than an indexed explanation packet. Its default keeps the exact `number<TAB>line` source format with a readable header and next-page command; use `--json` for tool chaining.

```bash
codegraph file src/auth.ts --offset 1 --limit 200
codegraph file src/auth.ts --offset 201 --limit 200 --max-bytes 80000
codegraph file src/auth.ts --include-graph-context --json
```

The live bytes, exact whole-file `totalLines`, and `page.nextOffset` do not depend on a fresh index. Graph context is never automatic: opt in with `--include-graph-context`, then treat `freshness` as the state of that indexed context rather than the file content.

The 16 MiB hard input-size limit is separate from the `--max-bytes` output-page cap. It rejects larger raw reads and structural text-config summaries before unbounded I/O, bounding complete-stream binary/UTF-8 validation and total-line counting. At an offset beyond EOF, JSON `content` and `text` are empty; pretty output says `Lines: none at offset <offset> of <totalLines>`.

If the `explore` query is only an exact indexed file path, JSON adds `fileView` with the same file-read contract and pretty output renders a `File view` section. An agent can continue from `fileView.page.nextOffset`; `--no-source` disables it.

```bash
codegraph explore src/auth.ts --json
codegraph explore src/auth.ts --include-graph-context
```

Secret-prone text configs return structural keys instead of raw values unless `--allow-sensitive` is passed intentionally; key material defaults to metadata, may report file size, and does not read raw secret bytes. Intentional raw access remains subject to the 16 MiB input limit and still rejects known binary extensions, NUL bytes, and malformed or incomplete UTF-8, so `.p12` and `.pfx` bundles remain metadata-only in practice. See [CLI reference](./cli.md#live-file-views) for exact fields, limits, trailing-newline behavior, and sensitive kinds.

## Orientation packets

Start with `orient` when an agent needs compact repo context without flooding the first prompt:

```bash
codegraph orient --root . --budget small
codegraph orient --root . ./src --budget medium --json
codegraph packet get src/cli.ts
codegraph packet get <file-from-orient> --max-symbols 25 --json
```

Orientation returns summary bullets, ranked `focus` targets, a bounded tree, budgeted health counts, omitted counts, and recommended next commands.
Bare CLI or MCP `orient` provide compact model-readable triage; use `orient --json` when follow-up tools need exact focus reasons, limits, or omission counts.
Small orientation packets default to cheap health analysis; use larger budgets only when cycle, unresolved-import, or duplicate counts matter.

## Workspace-symbol identities

Use `symbols` when the question is "which declaration has this identity?" and follow with the returned portable handle. It is deterministic and filterable; use hybrid `search` instead when paths, prose, SQL, snippets, or graph evidence should participate.

```bash
codegraph symbols "CodeReviewSession" --root .
codegraph symbols "src/session.ts::CodeReviewSession" --json
codegraph explain "<handle-from-symbols>" --json
```

Imports are excluded unless `--include-imports` is explicit. Compose `--kind`, `--exported`, and project-relative `--file-glob` filters to narrow large workspaces; the limit defaults to 50 and caps at 500.

## Read-only rename planning

Resolve the declaration with `symbols`, then pass its portable handle to rename preview:

```bash
codegraph rename-preview "<type-handle-from-symbols>" RenamedService --include-filenames --json
```

Treat `safe: false`, conflicts, unsafe sites, and omitted edits as blockers rather than silently applying a partial plan. Comment and string edits are opt-in low-confidence candidates; eligible exported type filename results are suggestions only, codegraph never changes files, and no apply command or tool exists.

Repeated library calls should use `previewRenameWithSession` or `tool_previewRename` with one caller-owned `AgentSession`. MCP hosts should use `rename_preview`, which stays available in read-only mode and reuses the server session.

## Search or review handoff to a refactor plan

Keep the exact symbol handle returned by search or the changed-symbol handle returned by review or impact, then pass it directly to `refactor-plan`:

```bash
codegraph search "service dispatch" --mode symbol --json
codegraph refactor-plan "<exact-handle-from-search>" --max-references 200

codegraph review --json
codegraph refactor-plan "<exact-changed-symbol-handle-from-review>" --rename RenamedService --json
```

The packet reuses one snapshot and freshness decision for references, direct calls, hierarchy, implementations, candidate tests, and follow-ups. Review and impact may expose internal symbol handles, but the packet returns a portable target handle and uses it in copyable commands.

Treat nested `rename.safe` as authoritative when `--rename` is present. Limits are independent, omissions remain explicit, source context is opt-in with `--include-source`, and refactor planning never writes or exposes an apply action.

## Search anchors

Use `search` when an agent has a query but no file target or search handle and needs a compact starting point before calling `goto`, `refs`, `deps`, `rdeps`, `chunk`, or later explanation tooling:

```bash
codegraph search "validate user" --json
codegraph search "public users" --mode sql --json
codegraph search "handle login" --mode graph --from src/auth.ts --depth 1 --json
codegraph explain "<handle-from-search>" --json
```

Search results include top-level `analysis` metadata plus stable handles, per-result `provenance`, evidence, rank reasons, neighbors, follow-ups, limits, and omitted counts.
`explain` accepts those handles plus file paths, symbol names, and SQL object names, then returns bounded dependencies, references, snippets, duplicate context, SQL relation facts, review context, and follow-ups.
Generated command strings quote dynamic arguments, SQL handles avoid ambiguous basenames, and omission counts stay explicit when packets hit limits.

Agent CLI commands, `goto`, `refs`, `impact`, and whole-project `graph` or `index` runs use the incremental index path and default to disk cache. The first query may build the index and report progress on stderr; later queries with the same root and compatible options reuse it.

Hybrid search is code-first by default. Use `mode: "text"` when documentation or prose-heavy matches should outrank implementation symbols.
Pure path/text searches skip detailed symbol graph construction; hybrid, symbol, SQL, and graph searches keep symbol-aware ranking and neighbors.

Disk cache speeds repeated text and hybrid searches. MCP reuses prepared state until it refreshes a changed repository. See [How it works](./how-it-works.md#cache-and-session-behavior) for cache mechanics and [MCP](./mcp.md#session-lifecycle) for server lifecycle.

Pass shared index flags only when an agent pass must mirror a specific scan mode; see [docs/cli.md](./cli.md#agent-orientation-and-packets) for the canonical flag list.
For the retrieval model, ranking signals, search modes, and vectorless tradeoffs, see [Vectorless search](./search.md).

Use `drift` when the agent needs one architecture-regression report for a base/head range:

```bash
codegraph drift ./src --base origin/main --head HEAD --graph-edges summary --public-api removals
codegraph drift ./src --base origin/main --head HEAD --json
```

Drift compares structural signals over time: dependency cycles, hotspots, unresolved imports, API surface changes, duplicate group counts, and graph edges. It is review and CI evidence, not runtime validation or compiler diagnostics. Use JSON for CI or agent handoff, and use graph-edge/API filters to keep human review output bounded.

## Agent client installer

Run `codegraph install` interactively to detect local clients, preview exact proposed actions and paths, and confirm once:

```bash
codegraph install
codegraph install --target codex,claude --dry-run
codegraph install --target codex,claude --yes
codegraph uninstall --target codex --yes
```

Interactive confirmation accepts only `y` or `yes` and defaults to no. Noninteractive writes require `--yes`; `--print-config <target>` prints an MCP snippet without touching disk, and uninstall removes only codegraph-owned content.

## MCP server

Use `codegraph mcp serve --root . --stdio` when an agent can spawn and own a stdio MCP subprocess.
Use `codegraph server start --root /path/to/repo --warmup` for one shared repo-local Streamable HTTP server, then point clients at `http://127.0.0.1:7331/mcp`. Add `--startup-timeout-ms <milliseconds>` when warmup exceeds the 15-second default. Use `--json` to receive `status: "started"`, the registry fields, and update state.

Check it with `codegraph server status --root /path/to/repo --json`, and stop it explicitly with `codegraph server stop --root /path/to/repo`. The wrapper verifies its process with a per-user credential in the Codegraph state directory, outside the project and separate from package files and compiler cache data; an unreachable or identity-mismatched server requires verification and keeps its registry.
MCP is an ergonomics and performance layer over the same analysis engine; it keeps warm session state, returns bounded resources, confines paths to the project root, and keeps tools read-only unless the server is started with `--allow-build`.

Restart or reload the owning client after `codegraph install` or a codegraph update. A running MCP server keeps the version and tool catalog captured at startup; `codegraph doctor --json` diagnoses package/native identity, while MCP `refresh_index` only refreshes repository analysis state.

See [MCP server](./mcp.md) for client configuration and troubleshooting.

## Session management

For agents performing code reviews or making multiple queries, use sessions to maintain warm caches. Use one of these canonical reuse models:

- library callers: one shared `createCodeReviewSession()` per repo snapshot
- agent hosts: one shared `createAgentSession()` or MCP server per repo snapshot

Per-invocation CLI freshness and long-lived in-memory freshness are different problems. Each CLI process validates the persisted index automatically before a current-state query, so no `codegraph index` or `codegraph sync` step is required first. An agent session or MCP server instead holds a snapshot in memory, and its `manual`, `check`, and `auto` freshness policies decide whether that snapshot is re-checked or refreshed.

The local review session refreshes manually with `refresh()` and records stale-snapshot metadata in `getStats()`. Navigation checks the requested file immediately and checks config or added/removed-file drift on the stale-check interval; impact calls add an interval-throttled tracked-file scan before computing the report.

For library callers performing repeated navigation or impact work, use sessions like this:

```ts
import { createCodeReviewSession } from "@lzehrung/codegraph-core";

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
import { createCodeReviewSession } from "@lzehrung/codegraph-core";

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

Session presets are a library-session convenience only. There is no CLI `--preset` flag or config key.

Available presets:

- `code-review`: balanced speed and accuracy for PR reviews
- `ci-fast`: maximum speed for CI and CD
- `development`: fast feedback for local development
- `production`: maximum accuracy

### Managing multiple sessions

```ts
import { SessionManager, type SessionManagerOptions } from "@lzehrung/codegraph-core";

const options: SessionManagerOptions = { maxSessions: 32 };
const manager = new SessionManager(options);
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

manager.dispose();
```

`SessionManager` defaults to 32 live or initializing sessions and scans for expired sessions every 60 seconds. Set `{ maxSessions, evictionIntervalMs }` to tune those bounds; `maxSessions` also applies to net-new `warmup()` sessions.

- Capacity frees immediately after a ready session is disposed or expires, or after a canceled or failed initialization settles.
- Set `evictionIntervalMs: 0` to disable periodic cleanup.
- Call `manager.dispose()` when the manager is no longer needed; it disposes all sessions, stops the interval, and is terminal. `disposeAll()` remains reusable.

## Streaming impact analysis

Stream impact results as they are discovered so the agent can start reasoning before the full pass completes:

```ts
import { buildProjectIndex, analyzeImpactStreaming } from "@lzehrung/codegraph-core";

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

Handle `error` as terminal: an overfull bounded queue does not emit `complete`. Breaking iteration or calling `.return()` cancels background work at its next analysis boundary; a synchronous lookup already in progress cannot be interrupted.

Use the same pattern through a warm session when repeated review passes matter:

```ts
import { createCodeReviewSession } from "@lzehrung/codegraph-core";

const session = await createCodeReviewSession({ root: "/path/to/repo" });

for await (const chunk of session.analyzeImpactStream({
  provider: "git",
  base: "main",
  head: "feature-branch",
})) {
  if (chunk.type === "impactItem") {
    console.log(`Impacted: ${chunk.item.file}`);
  }
}
```

## Partial results

Use partial-result helpers when the agent should keep going even if a subset of files fails:

```ts
import { withPartialResults, summarizePartialResult } from "@lzehrung/codegraph-core";

const files = ["file1.ts", "file2.ts", "file3.ts"];
const analyzeFile = async (file: string) => ({ file, analyzed: true });
const processResults = (results: Array<{ file: string; analyzed: boolean }>) => console.log(results);
const result = await withPartialResults(files, analyzeFile, {
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
import { buildProjectIndex, buildSymbolGraph, querySymbols, querySymbolNeighbors } from "@lzehrung/codegraph-core";

const index = await buildProjectIndex(process.cwd());
const symbolGraph = await buildSymbolGraph(index);
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

console.log(neighbors);
```

## High-level agent tools

These wrappers are designed to be imported directly into agent runtimes:

```ts
import { buildProjectIndex } from "@lzehrung/codegraph-core";
import {
  tool_getFileOverview,
  tool_findSymbol,
  tool_impactJSON,
  tool_getDependencies,
  tool_getReverseDependencies,
  tool_getHotspots,
  tool_goToDefinition,
  tool_findReferences,
} from "@lzehrung/codegraph-core/agent";

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

- Import index and analysis APIs from `@lzehrung/codegraph-core`, and agent wrappers from `@lzehrung/codegraph-core/agent`.
- When the agent runtime calls codegraph as a TypeScript library, prefer structured fields over rendered CLI text. A deterministic review agent should usually call `buildReviewReport()` for changed-file and task metadata, then `analyzeImpactFromDiff()` or `analyzeImpactStreaming()` for impact and graph context. Use CLI output only when the agent is operating through a shell tool.
- Treat `callCompatibility` as a deterministic review lead, not compiler-grade type checking. Likely-mismatch support covers provider-backed source-language callsite arity when callee resolution, signature parsing, and argument counting are all high confidence.
- For streaming review packs, keep the default `streamSummary: "full"` when the final pack needs suggestions, export summaries, re-export chains, ranked top impacts, graph edges, cycles, clusters, and surface area. Streaming always returns `format: "stream-summary"`. Use `streamSummary: "light"` when the agent only needs progressive chunks plus final changed/impacted counts and details.
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
codegraph review --base origin/main --head HEAD --json > review.json
codegraph review --base origin/main --head HEAD --include-symbol-details --max-callsites 5 --json > review.json
codegraph review --base origin/main --head HEAD --review-depth standard --json > review.json
```

For current local edits, start with the compact review summary:

```bash
codegraph review
```

Add a ranked blast-radius map only when needed:

```bash
codegraph impact --base HEAD --head WORKTREE
```

Use `--head STAGED` instead of `WORKTREE` when the review should cover only the index. Keep the full JSON review bundle for scripts or agent steps that need `projectFiles`, `graphDelta`, or detailed symbol handles.

For function-call integrations, keep the JSON object as the handoff. Do not parse human-readable `review` or `impact` text to recover fields that are already present in the TypeScript return values.

In summary mode, high-confidence direct import matches are the first regression targets and medium matches are likely file-level coverage. Low-confidence pattern matches are summarized as breadth hints; use the full JSON bundle only when you need to inspect those fallback candidates.

These bundles highlight:

- symbol-level changes
- updated dependency edges
- likely regression tests
- Provider-backed call-arity compatibility leads after signature changes
- risk summaries and review tasks

When `callCompatibility` is present, start with hints where `status` is `likely_mismatch`, inspect `callsiteFile` and `callsiteRange`, and compare `expected` against `actual` before proposing a fix. Missing hints do not prove all callers are valid; codegraph skips unsupported, ambiguous, overloaded, spread, or unresolved callsites.

`impacted[]` items separate `severity` (rank/impact if the finding is real) from `confidence` (certainty the finding is real). A lower `confidence` with `explain.resolutionConfidence` set to `"medium"` or `"low"` means the reference was matched through receiver/instance member-call resolution rather than an exact scope or import binding; treat it as a real finding worth checking, not noise, since it does not change severity or drop the item's rank. When `diagnostics.memberResolutionCoverage.limitedLanguages` is non-empty, treat the changed symbol's consumer list for those languages as a lower bound: codegraph has no receiver-call resolution for them, so callers reached only through `obj.method()` can be entirely absent from `impacted[]`, not just lower-confidence. Prefer `refs`/`grep` for a manual sweep of those files before concluding a symbol is safe to change.

Pretty impact and review summaries include scoped duplicate leads by default:

- human-readable `impact`: high-confidence exact or renamed clones within changed files.
- human-readable `review`: high-confidence exact or renamed clones within changed plus graph-impacted files.
- Identical import-list and barrel-file boilerplate is omitted from leads by default and counted under `omittedCounts.byBoilerplate`; it remains fully visible in `codegraph duplicates --json`.
- `--duplicates off|changed|impacted|all`: override the human-summary scope.
- Git copy or rename similarity metadata can boost duplicate leads when both source and destination are present in the indexed snapshot.
- Full duplicate groups, variants, raw pair counts, and omission counts remain in `codegraph duplicates --json`.
- Structured review packets add bounded `duplicate-sibling` tasks when changed ranges overlap high-confidence duplicate groups.

For copied-code or refactor-risk questions, add duplicate detection after the impact pass:

```bash
codegraph duplicates --root . ./src --json --min-confidence medium --limit 20
codegraph duplicates --root . ./src ./packages/app --json --include-same-file
```

- Treat duplicate groups as review or refactor leads, not automatic defects.
- Start with high-confidence exact or renamed clones.
- Use full JSON when an agent needs clone variants, omission counts, and raw pair counts.

For the exact JSON shape and CLI flags, see [docs/cli.md](./cli.md).

## Backend-focused review recipes

These patterns combine codegraph's core capabilities with backend-review heuristics.

### 1. API route impact assessment

```ts
import { analyzeImpactFromDiff, buildProjectIndex } from "@lzehrung/codegraph-core";

const root = process.cwd();
const index = await buildProjectIndex(root);
const impact = await analyzeImpactFromDiff(root, index, {
  provider: "git",
  base: "main",
  head: "feature-branch",
  depth: 2,
});

const apiRoutes = impact.impacted.filter(
  (item) => item.file.includes("routes") || item.file.includes("controllers") || item.file.includes("api"),
);

const breakingChanges = impact.changedSymbols.filter((symbol) => symbol.exported && symbol.signatureChanged);

console.log(`API routes impacted: ${apiRoutes.length}`);
console.log(`Breaking changes: ${breakingChanges.length}`);
```

### 2. Database schema impact analysis

```ts
import { analyzeImpactFromDiff, buildProjectIndex, collectImpactContext } from "@lzehrung/codegraph-core";

const root = process.cwd();
const index = await buildProjectIndex(root);
const impact = await analyzeImpactFromDiff(root, index, {
  provider: "git",
  base: "main",
  head: "feature-branch",
});
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
import { analyzeImpactFromDiff, buildProjectIndex, listCandidateTestFiles } from "@lzehrung/codegraph-core";

const root = process.cwd();
const index = await buildProjectIndex(root);
const impact = await analyzeImpactFromDiff(root, index, {
  provider: "git",
  base: "main",
  head: "feature-branch",
});
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
import { analyzeImpactFromDiff, buildProjectIndex, textGrep } from "@lzehrung/codegraph-core";

const root = process.cwd();
const index = await buildProjectIndex(root);
const impact = await analyzeImpactFromDiff(root, index, {
  provider: "git",
  base: "main",
  head: "feature-branch",
});
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
import { analyzeImpactFromDiff, buildProjectIndex } from "@lzehrung/codegraph-core";

const root = process.cwd();
const index = await buildProjectIndex(root);
const impact = await analyzeImpactFromDiff(root, index, {
  provider: "git",
  base: "main",
  head: "feature-branch",
});
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
import { analyzeImpactFromDiff, buildProjectIndex } from "@lzehrung/codegraph-core";

const root = process.cwd();
const index = await buildProjectIndex(root);
const impact = await analyzeImpactFromDiff(root, index, {
  provider: "git",
  base: "main",
  head: "feature-branch",
});
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
