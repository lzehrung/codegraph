export const CLI_HELP_TEXT = `codegraph - Code analysis and dependency graph tool

Usage: codegraph <command> [options] [path]

Commands:
  graph         Build dependency graph (default)
  inspect       Summarize repo structure and recommend next commands
  search        Ranked agent search across files, symbols, chunks, SQL, and graph context
  explain       Explain a file, symbol, SQL object, or search handle
  artifact      Build an agent-ready SQLite/graph/report/question bundle
  impact        Analyze PR impact
  review        Generate code review report
  goto          Go to definition
  refs          Find references
  deps          List dependencies
  rdeps         List reverse dependencies
  cycles        Detect dependency cycles (use --sort priority|size|fanin)
  hotspots      Find high-complexity files
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
  --cache-strict            Use content hashes instead of mtime
  --progress                Show progress tracking during indexing

Output Options:
  --json                    Output as JSON (default)
  --mermaid                 Output as Mermaid diagram
  --dot                     Output as DOT graph
  --sqlite <path>           Write to SQLite database
  --sql-artifacts           Include isolated SQL artifact facts in JSON graph output
  --output <path>           Write to file instead of stdout

Examples:
  codegraph graph ./src
  codegraph graph --fast-graph --mermaid ./src
  codegraph version
  codegraph doctor
  codegraph inspect ./src --limit 20
  codegraph search "auth user" --json
  codegraph explain src/auth.ts --json
  codegraph artifact build --root . --out codegraph-out --json
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
