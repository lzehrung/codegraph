---
name: codegraph
description: "Use for codebase navigation and repo impact analysis: understand an unfamiliar repo, trace dependencies, answer where this is defined or used, find hotspots or cycles, inspect public APIs, and assess what a PR or diff could break."
---

# Codegraph

## When to use this skill

Use Codegraph when the user asks structural questions about a repository and plain text search would be too shallow. Codegraph builds dependency graphs, symbol indexes, go-to-definition maps, find-references results, semantic chunks, and PR impact reports across many source languages plus graph-first document and template formats.

Strong triggers for this skill:

- "Understand this repo", "map this codebase", "show me the architecture", or "where should I start?"
- "What depends on this file?", "what imports this?", "what is the dependency path?", or "are there cycles?"
- "Where is this symbol defined?", "where is this used?", or "find references to this function/class/type."
- "What changed in this PR?", "what could this diff break?", or "which tests are likely relevant?"
- "Find hotspots", "inspect the public API surface", or "chunk this file for agent context."

Prefer Codegraph over `rg` when import edges, exported symbols, lexical scope, dependency direction, or PR impact matter. Use `rg` alongside Codegraph for raw text patterns, logs, configuration keys, or strings that are not code symbols.

Do not use Codegraph as the only evidence source for secrets, literal strings, log text, generated artifacts, or runtime behavior. Pair it with text search, tests, or execution evidence for those questions.

## First move for agents

For an unfamiliar repo, start with a health check and a bounded orientation packet. Use `./src` when it exists; otherwise use the product-code directory or `.` for a whole-repo fallback.

```bash
codegraph doctor
codegraph orient --root . --budget small --json
```

Then choose the narrowest follow-up command:

- Architecture summary: `codegraph inspect ./src --limit 20`
- Packet follow-up: `codegraph packet get <handle-from-orient> --json`
- Hot files: `codegraph hotspots ./src --limit 20 --json`
- Search anchors: `codegraph search "auth user" --json`
- Explain an anchor: `codegraph explain <file|symbol|sql-object|search-handle> --json`
- Smaller large-file packet: `codegraph explain <file> --max-symbols 25 --json`
- Dependencies: `codegraph deps <file>`
- Reverse dependencies: `codegraph rdeps <file>`
- Dependency path: `codegraph path <from> <to>`
- Cycles: `codegraph cycles --sort priority --json`
- Go to definition: `codegraph goto <file> <line> <column>`
- Find references: `codegraph refs --file <file> --line <line> --col <column> --pretty`
- PR impact: `codegraph impact --provider git --base main --head HEAD --pretty`
- Worktree impact: `codegraph impact --provider git --base HEAD --head WORKTREE --pretty`
- Review handoff: `codegraph review --base HEAD --head WORKTREE --summary`
- Full review JSON: `codegraph review --base origin/main --head HEAD`
- Public API: `codegraph apisurface`
- Duplicate cleanup: `codegraph duplicates --root . ./src --min-confidence medium`
- Chunks: `codegraph chunk <file>`
- Artifact bundle: `codegraph artifact build --root . --out codegraph-out --json`
- MCP server: `codegraph mcp serve --root . --stdio` or `codegraph mcp serve --root . --port 7331`

For `orient`, positional paths are include roots even when there is only one positional. Use `--root /path/to/repo` when targeting a different project root.

Use `--json` when the output will feed later reasoning, scripts, or another agent step. `orient` returns compact first-turn context with stable packet handles, recommended next commands, budgeted health counts, and omission counts. Small orientation budgets skip deeper health analysis and record that omission; use `--budget medium` or `--budget large` when health counts matter. `packet get` retrieves bounded evidence for handles from `orient`, `search`, and `explain`; review handles are produced by library orientation calls that include a review range. `inspect` includes compact high-confidence duplicate opportunities plus a recommended `duplicates` command for full grouped JSON. `search` is deterministic and returns project-relative explainable handles, evidence, neighbors, follow-up commands, result counts, limits, and omission counts. `explain` accepts those handles plus file paths, symbol names, and SQL object names, then returns bounded symbols, dependencies, reverse dependencies, references, snippets, SQL relation facts, changed-context review tasks/candidate tests, explicit limits, omission counts, and next commands. Generated command strings POSIX-shell-quote dynamic arguments when needed. For SQL objects, use search handles or schema-qualified names when basenames may be ambiguous. Reference and snippet omission counts are lower bounds after bounded navigation hits its cap. `artifact build` writes a durable SQLite, self-describing project-relative graph JSON, report, questions with unique stable-handle command IDs, and manifest bundle for handoff while excluding its own in-repo output directory and linked outside-root files. With `--force`, recognizable stale artifact files are removed, unrelated operator files are preserved, and unrecognized reserved-name collisions are refused. `codegraph doctor <artifact-dir>` recognizes manifest-backed artifact bundle directories and reports expected artifact presence. `mcp serve` exposes the same primitives as read-only MCP tools by default over stdio, or over Streamable HTTP with `--port <number>` at `/mcp`; HTTP binds to `127.0.0.1` unless `--host <host>` is passed, validates Host headers, and allows loopback Host headers for wildcard binds. File/artifact paths are confined after realpath resolution, MCP tool calls do not accept per-request root overrides, SQLite query results are row- and byte-bounded, synthetic payload functions are rejected, and `--allow-build` is required before an agent may write artifact output.

Numeric options such as `--limit`, `--threads`, `--depth`, `--max-refs`, and token bounds must be integers in their documented ranges; invalid numeric values fail instead of being silently clamped or ignored.

Project scans read `codegraph.config.json` from `--root` when present. `--root` is the project boundary for config lookup, manifests, path confinement, output paths, and cache/manifest storage. Positional paths after the command are include roots inside that project; for example, `codegraph inspect --root . ./src` scans `src` while keeping `.` as the project root. Config `discovery.includeGlobs` and `discovery.ignoreGlobs` are project-root-relative, even for child include-root scans. Use `discovery.ignoreGlobs` for durable repo-local excludes such as large fixtures, generated output, or vendored trees; CLI `--include-glob` and `--ignore-glob` remain additive one-off filters relative to each active scan root. `--no-gitignore` opts out of gitignore filtering for a single command. Cache and manifest reuse is scoped to `--root` and compatible config/build/graph options; child include-root scans can reuse project-root entries while command summaries and follow-up commands stay scoped to the selected include roots.

## Tool purpose

Codegraph is a lightweight multi-language code analysis tool for fast repo understanding without requiring an editor, language server, or per-language setup. It uses one shared Tree-sitter model across supported source languages including Zig and SQL, plus graph-first text extraction for document and template formats like Markdown, MDX, Astro, Handlebars, reStructuredText, and AsciiDoc. SQL uses SQL-specific object symbols and SQL-to-SQL graph edges without claiming a current schema or globally linking application-code strings to SQL objects.

Native runtime mode defaults to `auto`: Codegraph resolves parse/query work through `@lzehrung/codegraph-native`, using the native addon when available and the separate opt-in `@lzehrung/codegraph-js-fallback` package only when native is unavailable or explicitly disabled.

## Installation and availability

- Package name: `@lzehrung/codegraph`
- CLI command: `codegraph`
- Native backend package: `@lzehrung/codegraph-native`
- Optional JS fallback package: `@lzehrung/codegraph-js-fallback`
- Registry: `@lzehrung` packages are published to GitHub Packages, not the public npm registry. Configure:
  `npm config set "@lzehrung:registry" "https://npm.pkg.github.com"`

If the CLI is missing, do not suggest the unscoped `codegraph` package. Use one of these exact installation paths instead:

- Global install:
  `npm config set "@lzehrung:registry" "https://npm.pkg.github.com"`
  `npm install -g @lzehrung/codegraph`
- Repo-local install:
  `npm config set "@lzehrung:registry" "https://npm.pkg.github.com"`
  `npm install --save-dev @lzehrung/codegraph`

Avoid suggesting `npm install -g codegraph`, `npm install --save-dev codegraph`, or unscoped `npx codegraph` when the package is not already installed locally.

The CLI ships a bundled skill installer. It uses safe per-agent defaults and creates the target skills directory as needed:

- Install into the universal skills directory:
  `codegraph skill install --agent agents`
- Install into a known agent target:
  `codegraph skill install --agent codex`
  `codegraph skill install --agent claude`
  `codegraph skill install --agent cursor`
  `codegraph skill install --agent gemini`
  `codegraph skill install --agent opencode`
- Install into an explicit target:
  Target must end with `/skills/codegraph`; the installer creates it as needed.
  `codegraph skill install --target ~/.codex/skills/codegraph --force`
- Inspect package identity, backend/runtime state, plus local graph/cache artifacts:
  `codegraph doctor`
  `codegraph doctor ./codegraph-out`
- Inspect packaged skill paths and target health:
  `codegraph skill doctor`

Published installs of `@lzehrung/codegraph` depend on `@lzehrung/codegraph-native` as an optional dependency; that package resolves the matching native artifact automatically when one exists for the current platform.

Codegraph requires Node.js 24.10 or newer.

Install the optional fallback package only when you explicitly need JS Tree-sitter fallback:

```bash
npm install @lzehrung/codegraph-js-fallback --legacy-peer-deps
```

That fallback package is also published to the `@lzehrung` GitHub Packages registry, so tarball installs still need the same scoped registry configuration before the fallback package can be added.

Native-only installs do not need the JS fallback package for normal supported source-language graph extraction, symbol indexing, chunking, or AST grep. If query recovery degrades, Codegraph reports that once per language/reason in diagnostics and stays on native-owned recovery paths where supported.

Runtime controls:

- Global default override: `CODEGRAPH_DISABLE_NATIVE=1`
- Explicit CLI/library/tool `native` options take precedence over `CODEGRAPH_DISABLE_NATIVE`
- CLI examples: `codegraph graph --native off`, `codegraph index --native on --report`

## Command recipes

### Dependency graphs

- Whole-repo graph:
  `codegraph graph ./`
  Bare `graph` writes `codegraph.json`; add `--stdout` when piping.
- Fast overview:
  `codegraph graph ./src --fast-graph`
- Full AST-based graph:
  `codegraph graph ./src`
- Graph-first document/template edges:
  HTML, Astro, Handlebars, Markdown, MDX, reStructuredText, and AsciiDoc local links, plus MDX/Astro static imports, Vue/Svelte script imports including external `script src`, and stylesheet imports for CSS, SCSS, and Less.
- SQL support:
  `.sql` files are discovered by default, chunked into statements, indexed as SQL object symbols, and linked through SQL-to-SQL object edges from common DDL/DML and CTE read/write facts. SQL-to-SQL edges are precise for exact object-name matches, heuristic for unambiguous qualified-to-basename fallback matches, and skipped for ambiguous basename guesses. SQL `goto` and `refs` resolve object names plus object-level alias/table-qualified uses like `t.id` or `schema.table.id` to table/view definitions, but do not claim column-definition resolution. SQL indexing, graphing, and navigation work in native-only installs without the optional JS fallback package. SQL facts can appear in review context when SQL files or changed SQL literals are relevant, but application-code strings are not globally treated as SQL dependencies.
- Narrow scan scope and exclude generated/tests while preserving `.gitignore`:
  `codegraph graph --root . ./src --include-glob "**/*.ts" --ignore-glob "**/*.spec.ts" --json`
- Durable repo-local scan excludes:
  add `codegraph.config.json` with `{ "discovery": { "ignoreGlobs": ["tests/samples/**"] } }`
- Disable `.gitignore` filtering when ignored/generated files are intentionally in scope:
  `codegraph graph --root . ./src --no-gitignore --json`
- Mermaid output:
  `codegraph graph ./src --mermaid`
- Detailed symbol graph:
  `codegraph graph ./src --symbols-detailed --compact-json`
- SQL artifact facts in JSON graph output:
  `codegraph graph --root . --sql-artifacts --json`
- SQLite export:
  `codegraph graph --sqlite ./codegraph.sqlite`
- Read-only SQL on exported SQLite:
  `codegraph sql --db ./codegraph.sqlite --query "SELECT name, file FROM symbols WHERE kind = 'function' LIMIT 5;"`

For monorepos, prefer explicit roots such as `./src ./packages/app ./packages/lib` when you want product code only. Use `./` when you intentionally want the whole repo.

The `sql` command accepts read-only result-producing statements such as `SELECT` and `PRAGMA`, and rejects mutating SQL.

### Definitions and references

- Go to definition:
  `codegraph goto <file> <line> <column>`
- Find references:
  `codegraph refs --file <file> --line <line> --col <column> --pretty`

Prefer `refs` over plain text search when you want semantic usages rather than every matching string.

### PR and diff impact

- Git diff impact:
  `codegraph impact --provider git --base main --head HEAD --pretty`
- Current worktree impact:
  `codegraph impact --provider git --base HEAD --head WORKTREE --pretty`
- Current index impact:
  `codegraph impact --provider git --base HEAD --head STAGED --pretty`
- Compact impact JSON:
  `codegraph impact --provider git --base HEAD --head WORKTREE --compact-json`
- Exported-only scope:
  `codegraph impact --base main --head HEAD --scope imported`
- Ignore noisy files:
  `codegraph impact --base main --head HEAD --ignore-glob "**/package-lock.json" "**/dist/**"`
- Include line context:
  `codegraph impact --base main --head HEAD --ref-context line`
- Compact review handoff:
  `codegraph review --base HEAD --head WORKTREE --summary`
- Agent-ready full review bundle:
  `codegraph review --base origin/main --head HEAD`
- Agent-ready full current worktree bundle:
  `codegraph review --base HEAD --head WORKTREE`

Prefer impact `--pretty` first when the user asks what a change can break, what to test, or where a reviewer should focus. Use `review --summary` for compact human handoffs, and use full review JSON only when a script or another agent needs `projectFiles`, `graphDelta`, complete changed-symbol handles, or low-confidence fallback test candidates. Impact and review JSON may include `callCompatibility` for high-confidence provider-backed callsite arity mismatches after signature changes. Treat it as a deterministic review lead, not compiler-grade type checking, and check the language parity matrix before assuming coverage. In summary output, treat high-confidence candidate tests as first regression targets and medium-confidence tests as likely file-level coverage; low-confidence pattern matches are breadth hints only.

For git-provider impact and git-scoped review/index/graph commands, `WORKTREE` compares the base revision to current staged and unstaged tracked-file changes. Use `STAGED` or `INDEX` to compare the base revision to the current index; with `--base HEAD`, that is staged changes only. Untracked files are outside Git diff output until they are staged or tracked.

### Architecture and metrics

- Start here when you need an architecture summary:
  `codegraph inspect ./src --limit 20`
  Includes compact high-confidence duplicate opportunities and follow-up commands.
- Dependencies of a file:
  `codegraph deps <file>`
- Reverse dependencies:
  `codegraph rdeps <file>`
- Dependency path:
  `codegraph path <from> <to>`
- Cycles:
  `codegraph cycles --sort priority`
  Reports source dependency cycles; document-only link loops remain graph edges but are filtered from cycle warnings.
- Public API surface:
  `codegraph apisurface`
- Duplicate and near-duplicate code:
  `codegraph duplicates --root . ./src --min-confidence medium`
  Covers indexed symbols, semantic chunks, and text chunks.
  Reports grouped findings by default so overlapping symbol/chunk variants collapse into one clone.
  Uses duplicate JSON `schemaVersion: 2`.
  Bounds per-group variants by default and reports hidden evidence with counts.
  A single positional directory becomes the project root unless `--root` is set.
  Use `--include-small` for tiny helpers.
  Use `--include-same-file` for local clone cleanup.
  Use `--raw-pairs` to include low-level scored unit-pair suggestions.
- Unresolved project imports:
  `codegraph unresolved`
  Excludes graph-only document/template link edges plus known runtime/package externals: supported-language standard libraries, URL imports, and dependencies declared in nearby manifests such as `package.json`, Python, PHP, Rust, Go, Zig, Ruby, Java/Kotlin, .NET, C/C++, and Swift package manifests.
- Hotspots:
  `codegraph hotspots ./src --limit 20`
- Semantic chunking:
  `codegraph chunk <file>`
  Uses semantic Tree-sitter chunks for registered source and stylesheet languages, block-aware chunks for Vue and Svelte single-file components, and text chunks for JSON, YAML, or unsupported extensions.

### Diagnostics and performance

- Build/report diagnostics:
  `codegraph graph --report`
  `codegraph index --report`
  `codegraph review --report --report-file review.report.json`
- Worker threads for parallel native extraction:
  `codegraph index --workers --threads 8`

Graph, index, and review reports include `backend.native.byLanguage` so native usage and fallback are visible per language. Build reports also include `backend.parser` when syntax-tree backend degradation leaves files without parser context. Reports include `graph.fallbackImportExtraction.byLanguage` and `byReason` when regex import extraction is used. Review JSON also reports `diagnostics.symbolMappingParseFailures`, `diagnostics.missingFiles`, distinguishes `changedFiles[].status` as `updated`, `deleted`, or `missing`, and includes `sqlContext` when changed SQL files or changed SQL literals make SQL artifact facts relevant.

`codegraph version --json` and `codegraph doctor` report package name, version, and package root. Use them when you need to confirm which installed package the `codegraph` command is running.

Worker threads use a Piscina worker pool to offload per-file Rust extraction across CPU cores. This only applies to `index` and build commands, not `graph`, and falls back silently if the native addon or Piscina is unavailable.

## Library usage

Use the scoped package name:

```ts
import { buildProjectIndex, goToDefinition, findReferences } from "@lzehrung/codegraph";

const root = process.cwd();
const index = await buildProjectIndex(root, { native: "auto" });
const jsOnlyIndex = await buildProjectIndex(root, { native: "off" });
const workerIndex = await buildProjectIndex(root, { useNativeWorkers: true });
```

There is no separate native import. Use `native: "auto" | "on" | "off"` in public API calls to control native usage explicitly. `native: "on"` fails if the native addon cannot be loaded. `native: "off"` means the opt-in JS fallback path and requires `@lzehrung/codegraph-js-fallback`.

Agent-tool wrappers support the same native runtime modes, but not all wrappers take runtime control in the same position:

```ts
import {
  tool_findSymbol,
  tool_getDependencies,
  tool_getReverseDependencies,
  tool_getHotspots,
  tool_goToDefinition,
  tool_findReferences,
  tool_impactJSON,
} from "@lzehrung/codegraph";

const matches = await tool_findSymbol(root, "collectGraph", { maxResults: 10, native: "auto" });
const deps = await tool_getDependencies(root, "src/main.ts", { depth: 2, limit: 20, native: "off" });
const reverseDeps = await tool_getReverseDependencies(root, "src/index.ts", { depth: 2, limit: 20, native: "auto" });
const hotspots = await tool_getHotspots(root, { limit: 20, native: "auto" });
const definition = await tool_goToDefinition(root, "src/main.ts", 10, 5, undefined, { native: "on" });
const references = await tool_findReferences(root, "src/main.ts", 10, 5, undefined, { native: "auto" });
const impact = await tool_impactJSON(root, { provider: "git", base: "main", head: "HEAD", compact: true });
```

When integrating Codegraph into another TypeScript program, do not treat CLI prose as the contract. Use `buildReviewReport()`, `analyzeImpactFromDiff()`, or `analyzeImpactStreaming()` and preserve structured fields until the final prompt or UI rendering step.

## Best practices

- Prefer bounded commands first: `inspect`, `deps`, `rdeps`, `hotspots`, `goto`, `refs`, and compact JSON impact/review payloads.
- Use `--fast-graph` for first-pass exploration on large repos, then rerun without it when accuracy matters.
- Use `--include-glob`, `--ignore-glob`, and `--no-gitignore` to control which files are scanned.
- Use `--resolve-node-modules` only when you want JS/TS bare imports resolved into `node_modules`; it does not change scan roots.
- Use `--json` when you need machine-readable output. Impact JSON includes `schemaVersion` and `format`, and review JSON includes `schemaVersion`.
- If you are assessing architectural risk in a subdirectory, run `codegraph hotspots <dir> --limit 20 --json`, then check repo-level cycles with `codegraph cycles --sort priority --json`.
- Do not treat Markdown or other document-only link loops as code cycles; `cycles` filters those to avoid noisy architecture warnings.
