export const CLI_HELP_TEXT = `codegraph - Code analysis and dependency graph tool

Usage: codegraph <command> [options] [path]

Commands:
  orient        Build a compact first-turn packet for agent repo context
  explore       Answer a broad repo question with search, packets, paths, and blast radius
  file          Read a live project file with bounded line pagination
  review        Generate code review report
  packet        Retrieve bounded evidence packets by file path or stable target
  search        Ranked agent search across files, symbols, chunks, SQL, and graph context
  symbols       Deterministic workspace-symbol lookup with exact locations
  supertypes    Find proven direct or transitive supertypes by symbol handle
  subtypes      Find proven direct or transitive subtypes by symbol handle
  implementations Find proven type or interface-member implementations
  explain       Explain a file, symbol, SQL object, or search handle
  impact        Analyze PR impact
  inspect       Summarize repo structure and recommend next commands
  graph         Build dependency graph (default)
  artifact      Build an agent-ready SQLite/graph/report/question bundle
  drift        Compare architecture health between refs or artifacts
  mcp           Serve MCP tools for agent graph navigation
  index         Build the project symbol index
  init          Initialize project-local Codegraph lifecycle metadata
  status        Inspect project-local Codegraph lifecycle metadata
  sync          Refresh project-local Codegraph lifecycle metadata
  uninit        Remove project-local Codegraph lifecycle metadata
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
  install       Configure Codegraph MCP and skill integration for agent clients
  uninstall     Remove Codegraph-owned installer configuration
  skill         Install or inspect the bundled agent skill
  version       Print the installed codegraph version

Graph Options:
  --fast-graph                Use text import extraction for plain .js and .ts
                              files. May miss multiline or complex patterns;
                              TSX and other languages keep normal extraction.
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
  --cache-verify            Re-stat cached files before trusting disk cache entries
  --progress                Show progress tracking during indexing

Analysis Output Options:
  --json                    Output analysis commands as JSON (default where supported)
  --duplicates              Include duplicate summary in inspect (off by default)
  --mermaid                 Output as Mermaid diagram
  --dot                     Output as DOT graph
  --sqlite <path>           Write to SQLite database
  --sql-artifacts           Include isolated SQL artifact facts in JSON graph output
  --output <path>           Write to file instead of stdout
  --stdout                  Write default graph output to stdout

Recommended review commands:
  codegraph review --base HEAD --head WORKTREE --summary
  codegraph impact --base HEAD --head WORKTREE --pretty  (optional blast-radius follow-up)
  codegraph search "auth user" --json
  codegraph explain src/auth.ts --json

Unfamiliar repo:
  codegraph explore "how does auth reach db?" --root . --pretty
  codegraph orient --root . --budget small --pretty

Examples:
  codegraph review --base HEAD --head WORKTREE --summary
  codegraph orient ./src --budget small --pretty
  codegraph search "auth user" --json
  codegraph explore "how does auth reach db?" --pretty
  codegraph file src/auth.ts --pretty
  codegraph explain src/auth.ts --json
  codegraph impact --provider git --base HEAD --head WORKTREE
  codegraph init --root .
  codegraph status --root . --json
  codegraph sync --root .
  codegraph uninit --root . --force
  codegraph packet get file:src%2Fcli.ts --json
  codegraph artifact build --root . --out codegraph-out --json
  codegraph mcp serve --root . --stdio
  codegraph install --target codex,claude --yes
  codegraph install --print-config codex
  codegraph uninstall --target codex --yes
  codegraph inspect ./src --limit 20
  codegraph inspect ./src --limit 20 --duplicates
  codegraph duplicates ./src --min-confidence medium
  codegraph graph ./src
  codegraph graph --fast-graph --mermaid ./src
  codegraph graph --root . ./src --include-glob "**/*.ts" --ignore-glob "**/*.spec.ts"
  codegraph skill install --agent agents
  codegraph skill install --agent codex
  codegraph skill install --agent claude
  codegraph skill install --agent cursor
  codegraph skill install --agent gemini
  codegraph skill install --agent opencode
  codegraph skill install --target ~/.codex/skills/codegraph --force
  codegraph skill doctor
  codegraph impact --provider git --base main --head HEAD --pretty --duplicates off
  codegraph refs --file src/index.ts --line 42 --col 10
  codegraph doctor
  codegraph symbols "CodeReviewSession" --root . --pretty
  codegraph version
  codegraph -v
`;

const knownCliCommands = new Set([
  "apisurface",
  "artifact",
  "chunk",
  "drift",
  "cycles",
  "deps",
  "doctor",
  "duplicates",
  "dumpmod",
  "explain",
  "explore",
  "file",
  "goto",
  "graph",
  "graph-delta",
  "grep",
  "hotspots",
  "impact",
  "index",
  "init",
  "install",
  "inspect",
  "mcp",
  "implementations",
  "orient",
  "packet",
  "path",
  "rdeps",
  "refs",
  "review",
  "search",
  "symbols",
  "subtypes",
  "supertypes",
  "skill",
  "status",
  "sync",
  "sql",
  "unresolved",
  "uninit",
  "version",
  "uninstall",
]);

export function isKnownCliCommand(command: string): boolean {
  return knownCliCommands.has(command);
}

export const LIFECYCLE_HELP_TEXT = `codegraph init/status/sync/uninit - Initialize, inspect, refresh, or remove project-local Codegraph state

Usage:
  codegraph init [path] [--force] [--no-update-gitignore] [--json]
  codegraph init --root <path> [--force] [--no-update-gitignore] [--json]
  codegraph status [path] [--json]
  codegraph status --root <path> [--json]
  codegraph sync [path] [--init] [--no-update-gitignore] [--json]
  codegraph sync --root <path> [--init] [--no-update-gitignore] [--json]
  codegraph uninit [path] [--force] [--json]
  codegraph uninit --root <path> [--force] [--json]

State:
  Lifecycle commands own only .codegraph/manifest.json metadata. In a Git worktree, init and sync --init ensure it is effectively ignored, appending .codegraph/ to the resolved root's .gitignore only when needed; opt out with --no-update-gitignore.
  A tracked manifest is left tracked with a warning. Uninit removes lifecycle state but leaves the root .gitignore rule; ordinary sync never changes ignore policy.
  Init and sync may warm or update the disk cache under .codegraph-cache/index-v1/. Other commands do not depend on the manifest.
  Positional paths and --root are alternatives for lifecycle commands; do not combine them.
`;

export const INSTALL_HELP_TEXT = `codegraph install - Configure Codegraph for supported agent clients

Usage: codegraph install [target] [--target <codex,claude,cursor,gemini,opencode,agents>] [--yes | --dry-run] [--print-config <target>] [--detect]

Targets:
  codex, claude, cursor, gemini, opencode, agents

Safety:
  Writes require --yes. Use --dry-run to preview changed files or --print-config <target> to print the MCP snippet.
`;

export const UNINSTALL_HELP_TEXT = `codegraph uninstall - Remove Codegraph-owned installer configuration

Usage: codegraph uninstall [target] [--target <codex,claude,cursor,gemini,opencode,agents>] [--yes | --dry-run] [--detect]

Safety:
  Removes only Codegraph-owned marker blocks, marker files, exact bundled skill payloads, or exact installer-owned MCP entries.
`;

export const EXPLORE_HELP_TEXT = `codegraph explore - Answer a broad repo question with bounded repo context

Usage: codegraph explore "<query>" [--root <path>] [--limit <n>] [--max-packets <n>] [--max-paths <n>] [--no-source] [--include-graph-context] [--allow-sensitive] [--json | --pretty]

Output:
  Explore orchestrates search, packet retrieval, dependency paths, reverse dependencies, candidate tests, and follow-up commands. An exact file-path query also includes the live bounded file view.
  JSON is the default. Use --pretty for concise model-readable sections. Graph context and raw sensitive values require explicit flags.

Index options:
  Supports shared --cache, --cache-strict, --cache-verify, --threads, --native, --workers, --include-glob, --ignore-glob, and --no-gitignore options.
`;

export const FILE_HELP_TEXT = `codegraph file - Read a live project file with bounded line pagination

Usage: codegraph file <path> [--root <path>] [--offset <line>] [--limit <lines>] [--max-bytes <bytes>] [--include-graph-context] [--allow-sensitive] [--json | --pretty]

Output:
  JSON is the default. Pretty output uses exact number<TAB>line source lines plus bounded graph context when requested.
  A file-ending newline is represented as a final numbered empty line. Follow page.nextOffset or the pretty next-page command for more lines.

Safety:
  Paths are confined to --root after realpath resolution. Binary files are rejected. Known sensitive text configs return structural key summaries; key material returns metadata only. Use --allow-sensitive for raw access subject to binary and UTF-8 guards.
`;

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
  Results include top-level analysis metadata plus stable handles, rank reasons, provenance, evidence, graph neighbors, follow-up commands, limits, and omission counts.
  Hybrid search is code-first by default: source files and symbols outrank docs unless you use text mode or the docs are the strongest remaining evidence.

Index options:
  Supports shared --cache, --cache-strict, --cache-verify, --threads, --native, --workers, --include-glob, --ignore-glob, and --no-gitignore options.
`;

export const SYMBOLS_HELP_TEXT = `codegraph symbols - Deterministic workspace-symbol lookup

Usage: codegraph symbols [query] [--root <path>] [--kind <kind,...>] [--exported] [--include-imports] [--file-glob <glob>] [--limit <0-500>] [--json | --pretty]

Matching:
  Exact and qualified symbol identities rank ahead of prefix, token, and substring matches. Imports are excluded by default; use --include-imports to include aliases.
  A query is required unless --kind or --file-glob narrows the lookup. --kind accepts function, class, variable, interface, type, default, table, view, index, constraint, or routine.

Output:
  JSON includes portable handles, exact declaration ranges, provenance, limits, and omission counts. Pretty output is concise and intended for direct reading.

Index options:
  Supports shared --cache, --cache-strict, --cache-verify, --threads, --native, --workers, --include-glob, --ignore-glob, and --no-gitignore options.
`;

export const SUPERTYPES_HELP_TEXT = `codegraph supertypes - Find proven supertypes

Usage: codegraph supertypes <symbol-handle> [--root <path>] [--depth <1-10>] [--limit <0-500>] [--json | --pretty]

Returns only currently extracted extends and implements relationships. Results include exact locations, relation depth, provenance, limits, and omissions.

Index options:
  Supports shared --cache, --cache-strict, --cache-verify, --threads, --native, --workers, --include-glob, --ignore-glob, and --no-gitignore options.
`;

export const SUBTYPES_HELP_TEXT = `codegraph subtypes - Find proven subtypes

Usage: codegraph subtypes <symbol-handle> [--root <path>] [--depth <1-10>] [--limit <0-500>] [--json | --pretty]

Returns only currently extracted extends and implements relationships. Results include exact locations, relation depth, provenance, limits, and omissions.

Index options:
  Supports shared --cache, --cache-strict, --cache-verify, --threads, --native, --workers, --include-glob, --ignore-glob, and --no-gitignore options.
`;

export const IMPLEMENTATIONS_HELP_TEXT = `codegraph implementations - Find proven implementations

Usage: codegraph implementations <symbol-handle> [--root <path>] [--limit <0-500>] [--json | --pretty]

Type lookup follows extracted hierarchy relationships. Member lookup is supported only for members owned by an interface or trait with proven implementers; unrelated same-name members are never inferred.

Index options:
  Supports shared --cache, --cache-strict, --cache-verify, --threads, --native, --workers, --include-glob, --ignore-glob, and --no-gitignore options.
`;

export const ORIENT_HELP_TEXT = `codegraph orient - Build a compact first-turn packet for agent repo context

Usage: codegraph orient [roots...] [--root <path>] [--budget small|medium|large] [--health skip|summary|full] [--json | --pretty]

Output:
  Orientation includes summary bullets, ranked focus targets with follow-up commands, a bounded project tree, budgeted health counts, and omission counts.
  Use --pretty for model-readable triage and --json when tooling needs exact focus reasons, limits, or omissions. Small budget defaults to --health skip. Medium and large default to --health summary, which counts cycles and unresolved imports without duplicate detection.

Index options:
  Supports shared --cache, --cache-strict, --cache-verify, --threads, --native, --workers, --include-glob, --ignore-glob, and --no-gitignore options.
`;

export const PACKET_HELP_TEXT = `codegraph packet - Retrieve bounded evidence packets by file path or stable target

Usage: codegraph packet get <target> [--root <path>] [--json | --pretty] [--max-symbols <n>] [--max-snippets <n>] [--max-duplicates <n>]

Targets:
  Accepts file paths, symbol names, SQL object names, file:/symbol:/chunk:/sql:/graph: handles from search or explain output, and quoted review packet targets like 'review:base=<encoded-ref>;head=<encoded-ref>'.

Index options:
  Supports shared --cache, --cache-strict, --cache-verify, --threads, --native, --workers, --include-glob, --ignore-glob, and --no-gitignore options.
`;

export const EXPLAIN_HELP_TEXT = `codegraph explain - Explain a file, symbol, SQL object, or search handle

Usage: codegraph explain <file|symbol|sql-object|handle> [--root <path>] [--max-symbols <n>] [--max-dependencies <n>] [--max-snippets <n>] [--max-duplicates <n>] [--changed-context --base <rev> --head <rev>] [--json]

Targets:
  File paths, symbol names, SQL object names, and handles returned by codegraph search are accepted.

Output:
  Explanations include bounded symbols, dependencies, reverse dependencies, references, snippets, duplicate context, SQL facts, follow-up commands, limits, and omission counts.

Index options:
  Supports shared --cache, --cache-strict, --cache-verify, --threads, --native, --workers, --include-glob, --ignore-glob, and --no-gitignore options.
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

Index options:
  Supports shared --cache, --cache-strict, --cache-verify, --threads, --native, --workers, --include-glob, --ignore-glob, and --no-gitignore options.
`;

export const MCP_HELP_TEXT = `codegraph mcp - Serve MCP tools for agent graph navigation

Usage: codegraph mcp serve [--root <path>] [--artifact <path>] [--stdio | --port <number>] [--host <host>] [--allow-build] [--warmup | --warmup-symbols]

Transports:
  --stdio          Serve MCP over stdio (default)
  --port <number> Serve Streamable HTTP at /mcp
  --warmup        Build the base session cache at startup
  --warmup-symbols Build the base cache and detailed symbol graph at startup

Index Options:
  --cache <mode>     Session cache mode: disk, memory, off
  --cache-strict     Force strict content-hash cache validation
  --cache-verify     Re-stat cached files before trusting disk cache entries
  --threads N        Number of worker threads (default: auto)
  --native <mode>    Native runtime mode: auto, on, off
  --workers          Use Piscina worker threads for native extraction
  --include-glob <glob> Restrict discovered files to extra glob(s), relative to each scan root
  --ignore-glob <glob>  Exclude extra discovered files by glob, relative to each scan root
  --no-gitignore        Do not apply .gitignore files during discovery

Tools are read-only unless --allow-build is passed.
`;

export const MCP_SERVE_HELP_TEXT = `codegraph mcp serve - MCP server for agent graph navigation

Usage: codegraph mcp serve [--root <path>] [--artifact <path>] [--stdio | --port <number>] [--host <host>] [--allow-build] [--warmup | --warmup-symbols]

Tools:
  orient          Build a compact first-turn repo packet
  packet_get      Retrieve bounded evidence by file path or stable target
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
  refresh_index   Invalidate and optionally rebuild the MCP session snapshot
  artifact_build  Build artifacts only with --allow-build

Index Options:
  --cache <mode>     Session cache mode: disk, memory, off
  --cache-strict     Force strict content-hash cache validation
  --cache-verify     Re-stat cached files before trusting disk cache entries
  --threads N        Number of worker threads (default: auto)
  --native <mode>    Native runtime mode: auto, on, off
  --workers          Use Piscina worker threads for native extraction
  --include-glob <glob> Restrict discovered files to extra glob(s), relative to each scan root
  --ignore-glob <glob>  Exclude extra discovered files by glob, relative to each scan root
  --no-gitignore        Do not apply .gitignore files during discovery

Defaults:
  Transport defaults to stdio.
  HTTP transport binds to 127.0.0.1 unless --host is passed and serves /mcp.
  Startup is lazy unless --warmup or --warmup-symbols is passed.
  Warmup uses the configured session cache and shared index flags.
  Tools are read-only unless --allow-build is passed.
`;

export const DUPLICATES_HELP_TEXT = `codegraph duplicates - Detect duplicate and near-duplicate code units

Usage: codegraph duplicates [path ...] [--root <path>] [--json | --pretty] [--profile cleanup|refactor-roi] [--sort similarity|actionability|reduced-lines] [--min-confidence high|medium|low] [--limit <n>] [--include-same-file] [--include-small] [--raw-pairs] [--no-summary]

Path behavior:
  A single positional directory becomes the project root when --root is omitted.
  Use --root . ./src to scan a subtree while keeping repository-relative paths.
  Positional paths are scan roots, not glob patterns.

Discovery filters:
  --include-glob and --ignore-glob are relative to each active scan root.
  --include-root-glob and --ignore-root-glob are project-root-relative.
  --no-gitignore disables .gitignore filtering for the current command.
  Repeat each glob flag once per pattern:
    codegraph duplicates --root . ./src --ignore-glob "tests/**" --ignore-glob "docs/**"
    codegraph duplicates --root . ./tests --ignore-root-glob "tests/languages/**"

Options:
  --pretty            Emit one-line duplicate summaries for human triage. This is the default output.
  --json              Emit grouped duplicate findings as JSON for programmatic consumers.
  --profile <name>    Apply cleanup-oriented defaults. cleanup and refactor-roi are aliases.
  --sort <mode>       Order output by similarity, actionability, or reduced-lines.
                      Pretty output defaults to actionability. Cleanup profile defaults to reduced-lines.
                      JSON defaults to similarity unless --sort is explicit.
  --min-confidence    Minimum confidence to report. Defaults to medium.
  --limit             Maximum duplicate groups to return. Defaults to 50.
  --include-same-file Report non-overlapping clones in the same file.
  --include-small     Include units below the default token floor.
  --raw-pairs         Include low-level scored unit-pair suggestions in JSON output.
  --no-summary        Suppress the pretty summary footer.
  --min-tokens        Minimum unit tokens. Defaults to 40, or 80 under cleanup profile.
  --max-tokens        Maximum fallback chunk tokens. Defaults to 800.
  --max-bucket-size   Skip candidate buckets larger than this value. Defaults to 200.

Output:
  Pretty output is the default and emits one line per group with file spans, symbol or chunk labels, confidence, clone type, score, reduced lines, estimated reducible lines, token counts, heuristic family annotations, and cleanup labels.
  Pretty output also emits a compact summary footer unless --no-summary is passed.
  JSON output reports grouped duplicate findings, confidence, clone type, metrics, reduced-line fields, cleanup labels, clustered locations, omission counts including skipped candidate pairs, and pair stats.
  Grouped duplicate JSON uses schemaVersion 3.
  --raw-pairs is only supported with similarity-ranked JSON output and cannot be combined with the cleanup profile.
`;

export const DRIFT_HELP_TEXT = `codegraph drift - Compare architecture drift between graph states

Usage: codegraph drift [roots...] [--root <path>] (--base <ref> | --base-artifact <dir>) [--head <ref>] [--json | --pretty | --compact-json] [--fail-on <kind[,kind...]>] [--hotspot-jump-threshold <n>] [--limit <n>] [--graph-edges <full|summary|off>] [--public-api <all|removals|off>]

Signals:
  Compares dependency cycles, hotspots, unresolved imports, public API symbols, duplicate group counts, and graph edges.
  Drift is structural architecture comparison, not runtime validation, compiler diagnostics, or a style linter.

Options:
  --head <ref>                    Git ref for the head snapshot. Defaults to the current checkout; with --base-artifact, only the current checkout is supported (., WORKTREE).
  --fail-on <kind[,kind...]>      Exit 1 only when one of the selected finding kinds is present.
  --hotspot-jump-threshold <n>    Minimum absolute hotspot score delta to report.
  --limit <n>                     Maximum findings to emit in the report output.
  --graph-edges <mode>            Graph edge detail mode: full, summary, or off.
  --public-api <mode>             Public API finding mode: all, removals, or off.
  --compact-json                  Emit compact JSON with summary counts and bounded examples.
`;

export function helpTextForCommand(command: string, positionals: readonly string[]): string | undefined {
  if (command === "explore") return EXPLORE_HELP_TEXT;
  if (command === "file") return FILE_HELP_TEXT;
  if (command === "search") return SEARCH_HELP_TEXT;
  if (command === "symbols") return SYMBOLS_HELP_TEXT;
  if (command === "supertypes") return SUPERTYPES_HELP_TEXT;
  if (command === "subtypes") return SUBTYPES_HELP_TEXT;
  if (command === "implementations") return IMPLEMENTATIONS_HELP_TEXT;
  if (command === "orient") return ORIENT_HELP_TEXT;
  if (command === "packet") return PACKET_HELP_TEXT;
  if (command === "explain") return EXPLAIN_HELP_TEXT;
  if (command === "install") return INSTALL_HELP_TEXT;
  if (command === "uninstall") return UNINSTALL_HELP_TEXT;
  if (command === "init" || command === "status" || command === "sync" || command === "uninit")
    return LIFECYCLE_HELP_TEXT;
  if (command === "drift") return DRIFT_HELP_TEXT;
  if (command === "duplicates") return DUPLICATES_HELP_TEXT;
  if (command === "artifact") return ARTIFACT_HELP_TEXT;
  if (command === "mcp") {
    return positionals[0] === "serve" ? MCP_SERVE_HELP_TEXT : MCP_HELP_TEXT;
  }
  return undefined;
}
