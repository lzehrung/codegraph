export const CLI_HELP_TEXT = `codegraph - Code analysis and dependency graph tool

Usage: codegraph <command> [options] [path]

Commands:
  graph         Build dependency graph (default)
  inspect       Summarize repo structure and recommend next commands
  search        Ranked agent search across files, symbols, chunks, SQL, and graph context
  explain       Explain a file, symbol, SQL object, or search handle
  artifact      Build an agent-ready SQLite/graph/report/question bundle
  mcp           Serve MCP tools for agent graph navigation
  index         Build the project symbol index
  impact        Analyze PR impact
  review        Generate code review report
  goto          Go to definition
  refs          Find references
  deps          List dependencies
  rdeps         List reverse dependencies
  path          Find the shortest dependency path between files
  cycles        Detect dependency cycles (use --sort priority|size|fanin)
  hotspots      Find high-complexity files
  duplicates    Detect duplicate and near-duplicate code units
  unresolved    List unresolved project imports
  apisurface    Summarize exported API symbols
  grep          Run Tree-sitter query or text regex search
  graph-delta   Report file-level graph changes
  sql           Query a SQLite graph export read-only
  chunk         Chunk file for embeddings
  doctor        Inspect backend/runtime state and local graph artifacts
  skill         Install or inspect the bundled agent skill
  version       Print the installed codegraph version

Graph Options:
  --fast-graph                Skip AST parsing, use regex for imports.
                              5-10x faster but may miss dynamic imports,
                              re-exports, and complex patterns. Best for
                              quick overviews of large codebases.
  --resolve-node-modules      Include node_modules in resolution
  --dynamic-import-heuristics Attempt to resolve dynamic imports
  --resolution-hint <hint>    Custom resolution hint (e.g., tsconfig:path)
  --include-glob <glob>       Restrict discovered files to extra glob(s), relative to each scan root
  --ignore-glob <glob>        Exclude extra discovered files by glob, relative to each scan root
  --no-gitignore              Do not apply .gitignore files during file discovery

Build Options:
  --threads N               Number of worker threads (default: auto)
  --native <mode>           Native runtime mode: auto, on, off
  --workers                 Use Piscina worker threads for native extraction
  --cache <mode>            Cache mode: disk, memory, off
  --limit N                 Result limit for hotspots/inspect summaries
  --cache-strict            Force strict content-hash cache validation
  --progress                Show progress tracking during indexing

Output Options:
  --json                    Output as JSON (default)
  --mermaid                 Output as Mermaid diagram
  --dot                     Output as DOT graph
  --sqlite <path>           Write to SQLite database
  --sql-artifacts           Include isolated SQL artifact facts in JSON graph output
  --output <path>           Write to file instead of stdout
  --stdout                  Write default graph output to stdout

Examples:
  codegraph graph ./src
  codegraph graph --fast-graph --mermaid ./src
  codegraph version
  codegraph doctor
  codegraph inspect ./src --limit 20
  codegraph duplicates ./src --min-confidence medium
  codegraph search "auth user" --json
  codegraph explain src/auth.ts --json
  codegraph artifact build --root . --out codegraph-out --json
  codegraph mcp serve --root . --stdio
  codegraph graph --root . ./src --include-glob "**/*.ts" --ignore-glob "**/*.spec.ts"
  codegraph skill install --agent agents
  codegraph skill install --agent codex
  codegraph skill install --agent claude
  codegraph skill install --agent cursor
  codegraph skill install --agent gemini
  codegraph skill install --agent opencode
  codegraph skill install --target ~/.codex/skills/codegraph --force
  codegraph skill doctor
  codegraph impact --provider git --base main --head HEAD
  codegraph impact --provider git --base HEAD --head WORKTREE
  codegraph refs --file src/index.ts --line 42 --col 10
`;

const knownCliCommands = new Set([
  "apisurface",
  "artifact",
  "chunk",
  "cycles",
  "deps",
  "doctor",
  "duplicates",
  "dumpmod",
  "explain",
  "goto",
  "graph",
  "graph-delta",
  "grep",
  "hotspots",
  "impact",
  "index",
  "inspect",
  "mcp",
  "path",
  "rdeps",
  "refs",
  "review",
  "search",
  "skill",
  "sql",
  "unresolved",
  "version",
]);

export function isKnownCliCommand(command: string): boolean {
  return knownCliCommands.has(command);
}

export const SEARCH_HELP_TEXT = `codegraph search - Ranked agent search across project context

Usage: codegraph search "<query>" [--root <path>] [--mode hybrid|symbol|path|text|graph|sql] [--limit <n>] [--from <file|handle>] [--depth <n>] [--no-snippets] [--json]

Search Modes:
  hybrid   Rank across files, symbols, chunks, SQL, and graph context
  symbol   Prefer indexed symbols and stable symbol handles
  path     Prefer file paths
  text     Prefer text/snippet matches
  graph    Prefer graph neighborhoods
  sql      Prefer SQL object context

Output:
  Results include stable handles, rank reasons, evidence, graph neighbors, follow-up commands, limits, and omission counts.
`;

export const EXPLAIN_HELP_TEXT = `codegraph explain - Explain a file, symbol, SQL object, or search handle

Usage: codegraph explain <file|symbol|sql-object|handle> [--root <path>] [--max-symbols <n>] [--max-dependencies <n>] [--max-snippets <n>] [--changed-context --base <rev> --head <rev>] [--json]

Targets:
  File paths, symbol names, SQL object names, and handles returned by codegraph search are accepted.

Output:
  Explanations include bounded symbols, dependencies, reverse dependencies, references, snippets, SQL facts, follow-up commands, limits, and omission counts.
`;

export const ARTIFACT_HELP_TEXT = `codegraph artifact - Build an agent-ready handoff bundle

Usage: codegraph artifact build [--root <path>] [--out <dir>] [--sqlite] [--graph-json] [--report] [--questions] [--force] [--json]

Artifacts:
  codegraph.sqlite       Read-only SQLite graph artifact
  graph.json             Portable graph JSON with stable project-relative handles
  CODEGRAPH_REPORT.md    Concise report for humans and agents
  questions.json         Suggested follow-up questions with runnable commands
  manifest.json          Bundle manifest

Defaults:
  With no artifact selector flags, all artifacts are written.
  --force removes recognizable stale artifact files while preserving unrelated operator files.
`;

export const MCP_HELP_TEXT = `codegraph mcp - Serve MCP tools for agent graph navigation

Usage: codegraph mcp serve [--root <path>] [--artifact <path>] [--stdio | --port <number>] [--host <host>] [--allow-build]

Transports:
  --stdio          Serve MCP over stdio (default)
  --port <number> Serve Streamable HTTP at /mcp

Tools are read-only unless --allow-build is passed.
`;

export const MCP_SERVE_HELP_TEXT = `codegraph mcp serve - MCP server for agent graph navigation

Usage: codegraph mcp serve [--root <path>] [--artifact <path>] [--stdio | --port <number>] [--host <host>] [--allow-build]

Tools:
  search          Deterministic ranked search with stable handles
  get_file        Bounded project file reads inside the root
  get_symbol      Resolve a search/explain handle
  goto            Go to definition by file position
  refs            Find references by handle or file position
  deps            List dependencies
  rdeps           List reverse dependencies
  path            Find shortest dependency path
  impact          Build compact impact context for a git range
  review          Build review context for a git range
  query_sqlite    Read-only row- and byte-bounded SQLite artifact query
  artifact_build  Build artifacts only with --allow-build

Defaults:
  Transport defaults to stdio.
  HTTP transport binds to 127.0.0.1 unless --host is passed and serves /mcp.
  Tools are read-only unless --allow-build is passed.
`;

export const DUPLICATES_HELP_TEXT = `codegraph duplicates - Detect duplicate and near-duplicate code units

Usage: codegraph duplicates [path ...] [--root <path>] [--min-confidence high|medium|low] [--limit <n>] [--include-same-file] [--include-small] [--raw-pairs]

Path behavior:
  A single positional directory becomes the project root when --root is omitted.
  Use --root . ./src to scan a subtree while keeping repository-relative paths.

Options:
  --min-confidence  Minimum confidence to report. Defaults to medium.
  --limit           Maximum duplicate groups to return. Defaults to 50.
  --include-same-file Report non-overlapping clones in the same file.
  --include-small   Include units below the default token floor.
  --raw-pairs       Include low-level scored unit pairs as suggestions.
  --min-tokens      Minimum unit tokens. Defaults to 40.
  --max-tokens      Maximum fallback chunk tokens. Defaults to 800.
  --max-bucket-size Skip candidate buckets larger than this value. Defaults to 200.

Output:
  Always emits JSON with grouped duplicate findings, confidence, clone type, metrics, omission counts, and pair stats.
  Grouped duplicate output uses schemaVersion 2.
  Group variants are bounded by default and include rawPairCount/omittedVariantCount for hidden evidence.
  Use --raw-pairs to include the underlying scored unit-pair suggestions.
`;

export function helpTextForCommand(command: string, positionals: readonly string[]): string | undefined {
  if (command === "search") return SEARCH_HELP_TEXT;
  if (command === "explain") return EXPLAIN_HELP_TEXT;
  if (command === "duplicates") return DUPLICATES_HELP_TEXT;
  if (command === "artifact") return ARTIFACT_HELP_TEXT;
  if (command === "mcp") {
    return positionals[0] === "serve" ? MCP_SERVE_HELP_TEXT : MCP_HELP_TEXT;
  }
  return undefined;
}
