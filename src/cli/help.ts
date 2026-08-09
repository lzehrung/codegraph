import { renderCliCommandList } from "./commandCatalog.js";

export { isKnownCliCommand } from "./commandCatalog.js";

export const CLI_TASK_HELP_TEXT = `codegraph - Ask structural questions about a repository

Start here:
  Configure every supported agent  codegraph install --all --dry-run
  Understand a repository          codegraph explore "how does auth reach the database?" --root .
  Review local changes             codegraph review
  Find a symbol or file            codegraph search "SessionManager" --json
  Check runtime health             codegraph doctor

Run codegraph --help for all commands.`;

export const CLI_HELP_TEXT = `codegraph - Code analysis and dependency graph tool

Start here:
  Configure every supported agent  codegraph install --all --dry-run
  Understand a repository          codegraph explore "how does auth reach the database?" --root .
  Review local changes             codegraph review
  Find a symbol or file            codegraph search "SessionManager" --json
  Check runtime health             codegraph doctor

Usage: codegraph <command> [options] [path]

Commands:
${renderCliCommandList()}

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
  --workers                 Force Piscina native-extraction workers (auto above 250 files)
  --cache <mode>            Cache mode: disk, memory, off
  --limit N                 Result limit for hotspots/inspect summaries
  --cache-strict            Force strict content-hash cache validation
  --cache-verify            Re-stat cached files before trusting disk cache entries
  --progress                Force progress output when stderr is redirected
  --no-progress             Suppress automatic index progress feedback

Analysis Output Options:
  --pretty                  Human-readable output (default)
  --json                    Structured JSON output for automation
  --duplicates              Include duplicate summary in inspect (off by default)
  --mermaid                 Output as Mermaid diagram
  --dot                     Output as DOT graph
  --sqlite <path>           Write to SQLite database
  --sql-artifacts           Include isolated SQL artifact facts in JSON graph output
  --output <path>           Write to file instead of stdout
  --stdout                  Write graph output to stdout (default)

Forgiving inputs:
  File arguments accept file:line[:column] locations from search output.
  Symbol commands accept a portable handle, qualified file::symbol path, unique exact name, file, or file:line[:column].
  refs accepts a file alone and returns references for every symbol defined in that file.
  impact and drift default to HEAD..WORKTREE; artifact, packet, and mcp infer their only subcommand.
  Read-only project commands accept an existing project-root positional where unambiguous.

Recommended review commands:
  codegraph review
  codegraph impact (defaults to HEAD..WORKTREE)
  codegraph search "auth user" --json
  codegraph explain src/auth.ts --json
  codegraph affected --base HEAD --head WORKTREE --quiet

Unfamiliar repo:
  codegraph explore "how does auth reach db?" --root .
  codegraph orient --root . --budget small

Examples:
  codegraph review
  codegraph orient ./src --budget small
  codegraph search "auth user" --json
  codegraph explore "how does auth reach db?"
  codegraph file src/auth.ts
  codegraph explain src/auth.ts --json
  codegraph affected src/auth.ts --quiet
  codegraph impact --provider git --base HEAD --head WORKTREE
  codegraph init --root .
  codegraph status --root . --json
  codegraph sync --root .
  codegraph uninit --root . --force
  codegraph packet file:src%2Fcli.ts --json
  codegraph artifact --root . --out codegraph-out --json
  codegraph mcp --root . --stdio
  codegraph viewer --root . --graph codegraph.json --open
  codegraph install --all --dry-run
  codegraph install --all --yes
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
  codegraph skill install --agent omp
  codegraph skill install --agent kilo
  codegraph skill install --target ~/.codex/skills/codegraph --force
  codegraph skill doctor
  codegraph impact --provider git --base main --head HEAD --duplicates off
  codegraph refs src/index.ts:42:10
  codegraph doctor
  codegraph symbols "CodeReviewSession" --root .
  codegraph rename-preview Service RenamedService --include-filenames --json
  codegraph refactor-plan Service --rename RenamedService
  codegraph version
  codegraph -v
`;

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
  Lifecycle commands own only .codegraph/manifest.json metadata. In a Git worktree, init and sync --init ensure it is effectively ignored, appending .codegraph/ and .codegraph-cache/ to the resolved root's .gitignore only when needed; opt out with --no-update-gitignore.
  A tracked manifest is left tracked with a warning. Uninit removes lifecycle state but leaves the root .gitignore rule; ordinary sync never changes ignore policy.
  Init and sync may warm or update the disk cache under .codegraph-cache/index-v1/. Other commands do not depend on the manifest.
  Positional paths and --root are alternatives for lifecycle commands; do not combine them.
`;

export const AFFECTED_HELP_TEXT = `codegraph affected - List tests likely affected by changed files

Usage:
  codegraph affected [file...] [--stdin] [--base <ref> --head <ref>] [--root <path>] [--depth <n>] [--filter <glob>] [--json | --quiet]

Options:
  --depth <n>       Reverse dependency traversal depth (default: 1)
  --filter <glob>   Restrict returned test files by project-root-relative glob
  --stdin           Read newline-delimited changed files from stdin
  --quiet           Print affected test paths only
`;

export const INSTALL_HELP_TEXT = `codegraph install - Configure Codegraph for supported agent clients

Usage: codegraph install [target] [--target <codex,claude,cursor,gemini,opencode,omp,kilo,agents> | --all] [--yes | --dry-run] [--print-config <target>] [--detect]

Targets:
  codex, claude, cursor, gemini, opencode, omp, kilo, agents
  --all selects the full catalog in the listed order without detection.

Safety:
  Interactive terminals preview changes and ask for confirmation. Noninteractive writes require --yes; use --dry-run to preview changed files or --print-config <target> to print the MCP snippet.
  --all cannot be combined with a target, --detect, or --print-config.
`;

export const UNINSTALL_HELP_TEXT = `codegraph uninstall - Remove Codegraph-owned installer configuration

Usage: codegraph uninstall [target] [--target <codex,claude,cursor,gemini,opencode,omp,kilo,agents>] [--yes | --dry-run] [--detect]

Safety:
  Removes only Codegraph-owned marker blocks, marker files, exact bundled skill payloads, or exact installer-owned MCP entries.
`;

const SHARED_INDEX_OPTIONS_HELP = `Index options:
  Supports shared --cache, --cache-strict, --cache-verify, --threads, --native, --workers, --include-glob, --ignore-glob, and --no-gitignore options.
  Index builds report progress automatically on an interactive stderr terminal. Use --progress to force redirected progress logs or --no-progress to suppress feedback.`;

export const EXPLORE_HELP_TEXT = `codegraph explore - Answer a broad repo question with bounded repo context

Usage: codegraph explore "<query>" [--root <path>] [--limit <n>] [--max-packets <n>] [--max-paths <n>] [--no-source] [--include-graph-context] [--allow-sensitive] [--json | --pretty]

Output:
  Explore orchestrates search, packet retrieval, dependency paths, reverse dependencies, candidate tests, and follow-up commands. An exact file-path query also includes the live bounded file view.
  Pretty model-readable sections are the default. Use --json for structured fields. Graph context and raw sensitive values require explicit flags.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const FILE_HELP_TEXT = `codegraph file - Read a live project file with bounded line pagination

Usage: codegraph file <path> [--root <path>] [--offset <line>] [--limit <lines>] [--max-bytes <bytes>] [--include-graph-context] [--allow-sensitive] [--json | --pretty]

Output:
  Pretty output is the default and uses exact number<TAB>line source lines plus bounded graph context when requested. Use --json for structured fields.
  A file-ending newline is represented as a final numbered empty line. Follow page.nextOffset or the pretty next-page command for more lines.

Safety:
  Paths are confined to --root after realpath resolution. Binary files are rejected. Known sensitive text configs return structural key summaries; key material returns metadata only. Use --allow-sensitive for raw access subject to binary and UTF-8 guards.
`;

export const SEARCH_HELP_TEXT = `codegraph search - Ranked agent search across project context

Usage: codegraph search "<query>" [--root <path>] [--mode hybrid|symbol|path|text|graph|sql] [--limit <n>] [--from <file|handle>] [--depth <n>] [--no-snippets] [--report [--report-file <path>]] [--json | --pretty]

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
  --report writes command and index timings to stderr; --report-file writes the same JSON report to a file without changing search output.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const GOTO_HELP_TEXT = `codegraph goto - Go to a definition

Usage: codegraph goto <file>::<symbol> [--root <path>] [--json | --pretty]
       codegraph goto <file>[:line[:column]] [line] [column] [--root <path>] [--json | --pretty]

A qualified symbol path resolves one definition without a location. A file-only target succeeds when the file defines one symbol; otherwise JSON returns bounded candidates. Search-result locations and portable symbol handles can be pasted directly.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const REFS_HELP_TEXT = `codegraph refs - Find semantic references

Usage: codegraph refs <file>::<symbol> [--root <path>] [--json | --pretty]
       codegraph refs <file>[:line[:column]] [line] [column] [--root <path>] [--json | --pretty]
       codegraph refs --file <file> [--line <line> --col <column>] [--root <path>] [--json | --pretty]

A qualified symbol path finds references for one declaration without a location. A file-only target finds references for every symbol defined in that file. Search-result locations and portable symbol handles can be pasted directly.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const GREP_HELP_TEXT = `codegraph grep - Search source text or syntax trees

Usage: codegraph grep <regex> [--root <path>] [--ignore-case] [--max-hits <n>]
       codegraph grep --query <tree-sitter-query> [--root <path>]

A bare positional is a text regex. Use --query explicitly for Tree-sitter queries.
`;

export const SQL_HELP_TEXT = `codegraph sql - Query a graph SQLite export read-only

Usage: codegraph sql <sqlite-path> "SELECT ..."
       codegraph sql --db <sqlite-path> --query "SELECT ..."
`;

export const SYMBOLS_HELP_TEXT = `codegraph symbols - Deterministic workspace-symbol lookup

Usage: codegraph symbols [query] [--root <path>] [--kind <kind,...>] [--exported] [--include-imports] [--file-glob <glob>] [--limit <0-500>] [--json | --pretty]

Matching:
  Exact and qualified symbol identities rank ahead of prefix, token, and substring matches. Imports are excluded by default; use --include-imports to include aliases.
  A query is required unless --kind or --file-glob narrows the lookup. --kind accepts function, class, variable, interface, type, default, table, view, index, constraint, or routine.

Output:
  JSON includes portable handles, exact declaration ranges, provenance, limits, and omission counts. Pretty output is concise and intended for direct reading.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const CALLERS_HELP_TEXT = `codegraph callers - Find proven semantic callers

Usage: codegraph callers <symbol-target> [--root <path>] [--depth <1-5>] [--limit <0-500>] [--include-heuristic] [--json | --pretty]

Returns grouped caller symbols and exact project-relative callsites from resolved calls edges. --include-heuristic is accepted for forward compatibility, but current results remain limited to proven semantic edges.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const CALLEES_HELP_TEXT = `codegraph callees - Find proven semantic callees

Usage: codegraph callees <symbol-target> [--root <path>] [--depth <1-5>] [--limit <0-500>] [--include-heuristic] [--json | --pretty]

Returns grouped callee symbols and exact project-relative callsites from resolved calls edges. --include-heuristic is accepted for forward compatibility, but current results remain limited to proven semantic edges.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const SUPERTYPES_HELP_TEXT = `codegraph supertypes - Find proven supertypes

Usage: codegraph supertypes <symbol-target> [--root <path>] [--depth <1-10>] [--limit <0-500>] [--json | --pretty]

Returns only currently extracted extends and implements relationships. Results include exact locations, relation depth, provenance, limits, and omissions.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const SUBTYPES_HELP_TEXT = `codegraph subtypes - Find proven subtypes

Usage: codegraph subtypes <symbol-target> [--root <path>] [--depth <1-10>] [--limit <0-500>] [--json | --pretty]

Returns only currently extracted extends and implements relationships. Results include exact locations, relation depth, provenance, limits, and omissions.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const IMPLEMENTATIONS_HELP_TEXT = `codegraph implementations - Find proven implementations

Usage: codegraph implementations <symbol-target> [--root <path>] [--limit <0-500>] [--json | --pretty]

Type lookup follows extracted hierarchy relationships. Member lookup is supported only for members owned by an interface or trait with proven implementers; unrelated same-name members are never inferred.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const RENAME_PREVIEW_HELP_TEXT = `codegraph rename-preview - Preview a semantic rename without changing files

Usage: codegraph rename-preview <symbol-target> <new-name> [--include-comments] [--include-strings] [--include-filenames] [--max-edits N] [--json | --pretty]

Returns exact project-relative edits, conflicts, unsafe sites, candidate tests, provenance, limits, and omissions. Comment and string matches are low-confidence opt-in edits; --max-edits accepts integers from 1 to 10000.

--include-filenames requests suggestions for eligible exported class, interface, or type filenames only. Rename preview is read-only and no apply command exists.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const REFACTOR_PLAN_HELP_TEXT = `codegraph refactor-plan - Build a read-only refactor evidence packet

Usage: codegraph refactor-plan <symbol-target> [--rename <new-name>] [--max-references <0-500>] [--max-callers <0-500>] [--max-hierarchy <0-500>] [--include-source] [--json | --pretty]

Returns a target definition, references, callers, callees, type hierarchy, implementations, candidate tests, omissions, and copyable follow-ups from one semantic snapshot. Each max option accepts an independent integer from 0 to 500; --include-source opts reference context into the response.

--rename adds the authoritative read-only rename preview. Nested rename.safe is the safety decision; Codegraph does not expose an apply command and never changes source files.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const ORIENT_HELP_TEXT = `codegraph orient - Build a compact first-turn packet for agent repo context

Usage: codegraph orient [roots...] [--root <path>] [--budget small|medium|large] [--health skip|summary|full] [--json | --pretty]

Output:
  Orientation includes summary bullets, ranked focus targets with follow-up commands, a bounded project tree, budgeted health counts, and omission counts.
  Model-readable triage is the default; --pretty remains accepted explicitly. Use --json when tooling needs exact focus reasons, limits, or omissions. Small budget defaults to --health skip. Medium and large default to --health summary, which counts cycles and unresolved imports without duplicate detection.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const PACKET_HELP_TEXT = `codegraph packet - Retrieve bounded evidence packets by file path or stable target

Usage: codegraph packet [get] <target> [--root <path>] [--json | --pretty] [--max-symbols <n>] [--max-snippets <n>] [--max-duplicates <n>]

Targets:
  Accepts file paths, symbol names, SQL object names, file:/symbol:/chunk:/sql:/graph: handles from search or explain output, and quoted review packet targets like 'review:base=<encoded-ref>;head=<encoded-ref>'.

Portable handle grammar:
  file:<url-encoded project-relative path>
  symbol:<url-encoded path>:<url-encoded local-name>:<line>:<column>
  chunk:<url-encoded path>:<line>
  sql:<url-encoded object-name>:<url-encoded path>:<line>
  graph:<url-encoded project-relative path>
  Positions use 1-based lines and 0-based UTF-16 columns.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const EXPLAIN_HELP_TEXT = `codegraph explain - Explain a file, symbol, SQL object, or search handle

Usage: codegraph explain <file|symbol|sql-object|handle> [--root <path>] [--max-symbols <n>] [--max-dependencies <n>] [--max-snippets <n>] [--max-duplicates <n>] [--changed-context --base <rev> --head <rev>] [--json | --pretty]

Targets:
  File paths, symbol names, SQL object names, and handles returned by search are accepted. Portable handles use the same grammar documented under \`codegraph packet\`. Stale-handle recovery for humans is \`codegraph symbols "<query>"\` / \`codegraph search "<query>"\`; MCP callers should use \`workspace_symbols\` / \`search\`.

Output:
  Explanations include bounded symbols, dependencies, reverse dependencies, references, snippets, duplicate context, SQL facts, follow-up commands, limits, and omission counts.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const ARTIFACT_HELP_TEXT = `codegraph artifact - Build an agent-ready handoff bundle

Usage: codegraph artifact [build] [--root <path>] [--out <dir>] [--sqlite] [--graph-json] [--report] [--questions] [--force] [--json | --pretty]

Artifacts:
  codegraph.sqlite       Read-only SQLite graph artifact
  graph.json             Portable graph JSON with stable project-relative handles
  CODEGRAPH_REPORT.md    Concise report for humans and agents
  questions.json         Suggested follow-up questions with runnable commands
  manifest.json          Bundle manifest

Defaults:
  With no artifact selector flags, all artifacts are written.
  --force removes recognizable stale artifact files while preserving unrelated operator files.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const MCP_HELP_TEXT = `codegraph mcp - Serve MCP tools for agent graph navigation

Usage: codegraph mcp [serve] [--root <path>] [--artifact <path>] [--stdio | --port <number>] [--host <host>] [--idle-timeout-ms <ms>] [--allow-build] [--warmup | --warmup-symbols]

Transports:
  --stdio          Serve MCP over stdio (default)
  --port <number> Serve Streamable HTTP at /mcp
  --warmup        Build the base session cache at startup
  --warmup-symbols Build the base cache and detailed symbol graph at startup

Index Options:
  --cache <mode>     Session cache mode: disk, memory, off
  --cache-strict     Force strict content-hash cache validation
  --cache-verify     Re-stat cached files before trusting disk cache entries
  --progress         Force progress output when stderr is redirected
  --no-progress      Suppress automatic index progress feedback
  --threads N        Number of worker threads (default: auto)
  --native <mode>    Native runtime mode: auto, on, off
  --workers          Force Piscina native-extraction workers (auto above 250 files)
  --include-glob <glob> Restrict discovered files to extra glob(s), relative to each scan root
  --ignore-glob <glob>  Exclude extra discovered files by glob, relative to each scan root
  --no-gitignore        Do not apply .gitignore files during discovery

Tools are read-only unless --allow-build is passed.
`;

export const MCP_SERVE_HELP_TEXT = `codegraph mcp serve - MCP server for agent graph navigation

Usage: codegraph mcp [serve] [--root <path>] [--artifact <path>] [--stdio | --port <number>] [--host <host>] [--idle-timeout-ms <ms>] [--allow-build] [--warmup | --warmup-symbols]

Tools:
  orient          Build a compact first-turn repo packet
  packet_get      Retrieve bounded evidence by file path or stable target
  search          Deterministic ranked search with stable handles
  get_file        Bounded project file reads inside the root
  get_symbol      Resolve a search/explain handle
  goto            Go to definition by handle, qualified symbol path, or file position
  refs            Find references by handle, qualified symbol path, or file position
  deps            List file dependencies by file, qualified symbol path, or handle
  rdeps           List reverse file dependencies by file, qualified symbol path, or handle
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
  --progress         Force progress output when stderr is redirected
  --no-progress      Suppress automatic index progress feedback
  --threads N        Number of worker threads (default: auto)
  --native <mode>    Native runtime mode: auto, on, off
  --workers          Force Piscina native-extraction workers (auto above 250 files)
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

Usage: codegraph drift [roots...] [--root <path>] (--base <ref> | --base-artifact <dir>) [--head <ref>] [--json | --pretty] [--fail-on <kind[,kind...]>] [--hotspot-jump-threshold <n>] [--limit <n>] [--graph-edges <full|summary|off>] [--public-api <all|removals|off>]

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
`;

export const VIEWER_HELP_TEXT = `codegraph viewer - Serve the bundled graph visualization viewer

Usage: codegraph viewer [--root <path>] [--graph <root-confined-json>] [--host <host>] [--port <0-65535>] [--open] [--print-url]

Without --graph, the viewer builds a fresh graph projection from the current project and its automatically validated disk cache whenever the UI loads or reloads /graph.json.
With --graph, it serves the root-confined exported snapshot at the same route instead.
Graph paths must stay inside the selected root (the current directory by default) both lexically and after symlink resolution.

Options:
  --graph <path>    Root-confined exported graph JSON to inspect instead of the current project.
  --host <host>     Listener host. Defaults to 127.0.0.1.
  --port <port>     Listener port. Defaults to 4173; 0 selects an available port.
  --open            Open the server URL in the platform browser.
  --print-url       Print the deterministic URL and exit without starting a server. Cannot use --open or --port 0.
`;

export const INDEX_HELP_TEXT = `codegraph index - Build the project symbol index

Usage: codegraph index [roots...] [--root <path>] [--json | --pretty | --full] [--verbose] [--cache <mode>] [--cache-strict] [--cache-verify] [--threads N] [--native <mode>] [--workers]

Output:
  Builds or refreshes the project symbol index and graph. Default output is a compact file/edge count; --json/--full includes module details.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const GRAPH_HELP_TEXT = `codegraph graph - Build a dependency graph

Usage: codegraph graph [roots...] [--root <path>] [--json | --mermaid | --dot] [--sqlite <path>] [--output <path> | --stdout] [--sql-artifacts] [--fast-graph] [--resolve-node-modules] [--dynamic-import-heuristics]

Output:
  Emits a file dependency graph for the selected roots. Use --json/--mermaid/--dot/--sqlite for machine-readable formats.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const REVIEW_HELP_TEXT = `codegraph review - Generate a code review report for a git range

Usage: codegraph review [project-root] [--root <path>] [--base <ref>] [--head <ref>] [--changed-since <ref>] [--json | --pretty] [--max-tests <n>] [--max-callsites <n>]

Defaults:
  Git-backed review defaults to HEAD..WORKTREE when --base/--head/--changed-since are omitted.

Options:
  --base <ref>         Base revision. Defaults to HEAD unless --changed-since is used.
  --head <ref>         Head revision or WORKTREE for local changes. Defaults to WORKTREE unless --changed-since is used.
  --changed-since <ref>  Compare the current worktree against a single revision without inventing a head ref.
  --max-tests <n>      Cap candidate tests included in the report.
  --max-callsites <n>  Cap call sites included in the report.
  --json               Structured review report for automation.
  --pretty             Human-readable review summary (default when --json is absent).

${SHARED_INDEX_OPTIONS_HELP}
`;

export const IMPACT_HELP_TEXT = `codegraph impact - Analyze PR impact between two revisions

Usage: codegraph impact [project-root] [--provider git|github|raw] [--base <ref>] [--head <ref>] [--json | --pretty] [--duplicates <mode>]

Defaults:
  Git provider defaults to HEAD..WORKTREE when --base/--head are omitted.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const INSPECT_HELP_TEXT = `codegraph inspect - Summarize repo structure and recommend next commands

Usage: codegraph inspect [roots...] [--root <path>] [--limit <n>] [--duplicates] [--json | --pretty]

${SHARED_INDEX_OPTIONS_HELP}
`;

export const DEPS_HELP_TEXT = `codegraph deps - List file dependencies

Usage: codegraph deps <file|file::symbol|symbol:...> [--root <path>] [--depth <n>] [--json | --pretty]

A qualified symbol path or portable symbol handle uses its declaring file for file-graph traversal. Use callees for symbol-level call relationships.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const RDEPS_HELP_TEXT = `codegraph rdeps - List reverse file dependencies

Usage: codegraph rdeps <file|file::symbol|symbol:...> [--root <path>] [--depth <n>] [--json | --pretty]

A qualified symbol path or portable symbol handle uses its declaring file for file-graph traversal. Use callers for symbol-level call relationships.

${SHARED_INDEX_OPTIONS_HELP}
`;

export const PATH_HELP_TEXT = `codegraph path - Find the shortest dependency path between files

Usage: codegraph path <from-file> <to-file> [--root <path>] [--json | --pretty]

${SHARED_INDEX_OPTIONS_HELP}
`;

export const CYCLES_HELP_TEXT = `codegraph cycles - Detect dependency cycles

Usage: codegraph cycles [roots...] [--root <path>] [--sort priority|size|fanin] [--json | --pretty]

${SHARED_INDEX_OPTIONS_HELP}
`;

export const HOTSPOTS_HELP_TEXT = `codegraph hotspots - Find high-complexity files

Usage: codegraph hotspots [roots...] [--root <path>] [--limit <n>] [--json | --pretty]

${SHARED_INDEX_OPTIONS_HELP}
`;

export const UNRESOLVED_HELP_TEXT = `codegraph unresolved - List unresolved project imports

Usage: codegraph unresolved [project-root] [--root <path>] [--json | --pretty]

${SHARED_INDEX_OPTIONS_HELP}
`;

export const APISURFACE_HELP_TEXT = `codegraph apisurface - Summarize exported API symbols

Usage: codegraph apisurface [project-root] [--root <path>] [--json | --pretty]

${SHARED_INDEX_OPTIONS_HELP}
`;

export const GRAPH_DELTA_HELP_TEXT = `codegraph graph-delta - Report file-level graph changes

Usage: codegraph graph-delta [project-root] [--root <path>] [--git-base <ref> | --changed-since <ref>] [--json | --pretty]

${SHARED_INDEX_OPTIONS_HELP}
`;

export const DOCTOR_HELP_TEXT = `codegraph doctor - Inspect backend/runtime state and local graph artifacts

Usage: codegraph doctor [artifact-path] [--json | --pretty]

Output:
  Reports Node/runtime health, optional native backend status, and local artifact presence.
`;

export const CHUNK_HELP_TEXT = `codegraph chunk - Chunk a file for embeddings

Usage: codegraph chunk <file-path> [--language <id>] [--min-tokens <n>] [--max-tokens <n>] [--text] [--json | --pretty]
`;

export const SKILL_HELP_TEXT = `codegraph skill - Install or inspect the bundled agent skill

Usage:
  codegraph skill install [--agent <name> | --target <dir>] [--force]
  codegraph skill print-path [--agent <name> | --target <dir>]
  codegraph skill doctor [--agent <name> | --target <dir>]
`;

export const DUMPMOD_HELP_TEXT = `codegraph dumpmod - Dump one indexed module

Usage: codegraph dumpmod <file> [--root <path>] [--json | --pretty]

${SHARED_INDEX_OPTIONS_HELP}
`;

export const VERSION_HELP_TEXT = `codegraph version - Print the installed Codegraph version

Usage: codegraph version [--json | --pretty]
`;

export function helpTextForCommand(command: string, positionals: readonly string[]): string | undefined {
  if (command === "explore") return EXPLORE_HELP_TEXT;
  if (command === "file") return FILE_HELP_TEXT;
  if (command === "search") return SEARCH_HELP_TEXT;
  if (command === "goto") return GOTO_HELP_TEXT;
  if (command === "refs") return REFS_HELP_TEXT;
  if (command === "grep") return GREP_HELP_TEXT;
  if (command === "sql") return SQL_HELP_TEXT;
  if (command === "symbols") return SYMBOLS_HELP_TEXT;
  if (command === "callers") return CALLERS_HELP_TEXT;
  if (command === "callees") return CALLEES_HELP_TEXT;
  if (command === "supertypes") return SUPERTYPES_HELP_TEXT;
  if (command === "subtypes") return SUBTYPES_HELP_TEXT;
  if (command === "implementations") return IMPLEMENTATIONS_HELP_TEXT;
  if (command === "rename-preview") return RENAME_PREVIEW_HELP_TEXT;
  if (command === "refactor-plan") return REFACTOR_PLAN_HELP_TEXT;
  if (command === "orient") return ORIENT_HELP_TEXT;
  if (command === "packet") return PACKET_HELP_TEXT;
  if (command === "explain") return EXPLAIN_HELP_TEXT;
  if (command === "affected") return AFFECTED_HELP_TEXT;
  if (command === "install") return INSTALL_HELP_TEXT;
  if (command === "uninstall") return UNINSTALL_HELP_TEXT;
  if (command === "init" || command === "status" || command === "sync" || command === "uninit")
    return LIFECYCLE_HELP_TEXT;
  if (command === "drift") return DRIFT_HELP_TEXT;
  if (command === "duplicates") return DUPLICATES_HELP_TEXT;
  if (command === "artifact") return ARTIFACT_HELP_TEXT;
  if (command === "viewer") return VIEWER_HELP_TEXT;
  if (command === "index") return INDEX_HELP_TEXT;
  if (command === "graph") return GRAPH_HELP_TEXT;
  if (command === "review") return REVIEW_HELP_TEXT;
  if (command === "impact") return IMPACT_HELP_TEXT;
  if (command === "inspect") return INSPECT_HELP_TEXT;
  if (command === "deps") return DEPS_HELP_TEXT;
  if (command === "rdeps") return RDEPS_HELP_TEXT;
  if (command === "path") return PATH_HELP_TEXT;
  if (command === "cycles") return CYCLES_HELP_TEXT;
  if (command === "hotspots") return HOTSPOTS_HELP_TEXT;
  if (command === "unresolved") return UNRESOLVED_HELP_TEXT;
  if (command === "apisurface") return APISURFACE_HELP_TEXT;
  if (command === "graph-delta") return GRAPH_DELTA_HELP_TEXT;
  if (command === "doctor") return DOCTOR_HELP_TEXT;
  if (command === "chunk") return CHUNK_HELP_TEXT;
  if (command === "skill") return SKILL_HELP_TEXT;
  if (command === "dumpmod") return DUMPMOD_HELP_TEXT;
  if (command === "version") return VERSION_HELP_TEXT;
  if (command === "mcp") {
    return positionals[0] === undefined || positionals[0] === "serve" ? MCP_SERVE_HELP_TEXT : MCP_HELP_TEXT;
  }
  return undefined;
}
