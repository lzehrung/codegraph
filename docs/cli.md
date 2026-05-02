# CLI Reference

Assume the CLI is available as `codegraph`.

For a source checkout of this repo, replace `codegraph` with `node ./dist/cli.js`.

If the CLI is not installed yet, use the install paths in [docs/installation.md](./installation.md). Do not use the unscoped `codegraph` package name.

## Runtime selection

The CLI defaults to `--native auto`, which uses the native Tree-sitter path when a compatible native artifact is available and falls back automatically otherwise.

- `--native on`: require native explicitly and fail if it is unavailable
- `--native off`: force the opt-in JS Tree-sitter fallback path for comparison and debugging when `@lzehrung/codegraph-js-fallback` is installed

## Core commands

### Dependency graphs

```bash
# First-pass repo summary and next-step suggestions
codegraph inspect ./src --limit 20

# Whole-repo graph
codegraph graph ./

# Fast graph-only overview
codegraph graph ./src --fast-graph

# Full AST-based graph
codegraph graph ./src

# Build a dependency graph from multiple roots
codegraph graph ./src ./packages/app ./packages/lib --mermaid > graph.mmd

# Graph-first document and template edges also participate for HTML, Astro,
# Handlebars, Markdown, MDX, reStructuredText, and AsciiDoc local links,
# plus MDX and Astro static imports

# Narrow scanned files and exclude generated files while preserving .gitignore
codegraph graph --root . ./src --include-glob "**/*.ts" --ignore-glob "**/*.spec.ts" --json

# Disable .gitignore filtering when ignored or generated files are intentionally in scope
codegraph graph --root . ./src --no-gitignore --json

# Mermaid output
codegraph graph ./src --mermaid

# Detailed symbol graph
codegraph graph ./src --symbols-detailed --compact-json

# SQLite export
codegraph graph --sqlite ./codegraph.sqlite

# Build and report diagnostics
codegraph graph --report
codegraph index --report
codegraph review --report --report-file review.report.json
```

Graph, index, and review reports include `backend.native.byLanguage` so native usage and fallback remain visible per language. Build reports also include `backend.parser` when syntax-tree backend degradation leaves files without parser context. Reports also include `graph.fallbackImportExtraction.byLanguage` and `byReason` when regex import extraction is used. Review JSON reports `diagnostics.symbolMappingParseFailures`, `diagnostics.missingFiles`, and `changedFiles[].status` as `updated`, `deleted`, or `missing`.

### Symbols, navigation, grep, and chunking

```bash
# Build the full project index
codegraph index

# Print full JSON index including locals, imports, and exports
codegraph index --json

# Use concurrency and incremental cache
codegraph index --threads 8 --cache disk

# Enable worker threads for parallel native extraction
codegraph index --workers --threads 8 --cache disk

# Chunk a file for LLM processing
codegraph chunk src/utils.js

# Output text chunks as JSON
codegraph chunk package.json --text --max-tokens 200

# Override language detection and token limits
codegraph chunk config.yaml --language yaml --min-tokens 100 --max-tokens 300

# Go to definition
codegraph goto <file> <line> <column>

# Find references
codegraph refs --file <file> --line <line> --col <column>
codegraph refs --file <file> --line <line> --col <column> --pretty

# Run a Tree-sitter query across the repo
codegraph grep --query '(function_declaration name: (identifier) @name)'

# Run a plain-text regex grep across the repo
codegraph grep --pattern 'eval\(' --ignore-case
```

### Dependency analysis and diagnostics

```bash
# Dependencies of a file
codegraph deps src/main.ts

# Reverse dependencies
codegraph rdeps src/utils.ts

# Shortest dependency path
codegraph path src/main.ts src/utils.ts

# Cycle detection
codegraph cycles --sort priority

# Public API surface
codegraph apisurface

# Unresolved imports
codegraph unresolved

# Hotspots
codegraph hotspots ./src --limit 20
```

### Impact, review, and graph delta

```bash
# Analyze PR impact from git history
codegraph impact --provider git --base main --head HEAD

# Analyze current staged and unstaged worktree changes against HEAD
codegraph impact --provider git --base HEAD --head WORKTREE

# Analyze the current index against HEAD
codegraph impact --provider git --base HEAD --head STAGED

# Analyze GitHub PR impact
codegraph impact --provider github --repo owner/name --pr 123

# Analyze raw diff text from stdin
cat diff.txt | codegraph impact --provider raw

# Pretty summary with severity scores
codegraph impact --base main --head feature --pretty

# Compact JSON using impact's graph-style alias
codegraph impact --base main --head feature --compact-json

# Limit analysis depth and reference count
codegraph impact --base main --head feature --depth 2 --max-refs 1000

# Exported-only scope
codegraph impact --base main --head feature --scope imported

# Ignore noisy files
codegraph impact --base main --head feature --ignore-glob "**/package-lock.json" "**/dist/**"

# Symbol references only
codegraph impact --base main --head feature --members-only

# Line context snippets for references
codegraph impact --base main --head feature --ref-context line

# Block context snippets for references
codegraph impact --base main --head feature --ref-context block --ref-block-max-lines 30

# Verify missing imports, exports, and declarations in changed lines
codegraph impact --base main --head feature --verify-refs

# Add LCOV and coverage-aware suggestions
codegraph impact --base main --head feature --lcov coverage/lcov.info --coverage-report coverage/coverage-final.json

# Use a repository-specific test command template
codegraph impact --base main --head feature --coverage-report coverage/coverage-final.json --test-command-template "pnpm vitest {files}"

# Review bundle for LLM-driven code review
codegraph review --base origin/main --head HEAD > review.json
codegraph review --base origin/main --head HEAD --include-symbol-details --max-callsites 5 > review.json
codegraph review --base origin/main --head HEAD --review-depth standard > review.json

# Compact human-readable review handoff
codegraph review --base origin/main --head HEAD --summary
codegraph review --base HEAD --head WORKTREE --summary

# File-level graph delta between revisions
codegraph graph-delta --git-base origin/main --git-head HEAD > graph-delta.json
```

For git-provider impact, `--head` accepts normal revisions plus worktree sentinels. Use `WORKTREE` to compare the base revision against the current working tree, including staged and unstaged tracked-file changes. Use `STAGED` or `INDEX` to compare the base revision against the current index; with `--base HEAD`, that is staged changes only. Untracked files are not included until they are staged or otherwise tracked by Git.

Impact JSON responses include `schemaVersion` plus `format: "full" | "compact"` so downstream tools can branch on payload shape without inferring it from missing fields. Use `--compact` or `--compact-json` for compact impact JSON. Impact JSON can also include `exportSummary`, `reexportChains`, `topImpacts`, `surfaceArea`, and `clusters` when applicable. File paths in impact reports are project-relative, and raw diffs that point outside the project root are rejected.

`codegraph review --summary` prints the changed-file count, changed-symbol count, graph delta, risk summary, review tasks, and suggested tests without emitting the full `projectFiles` and symbol-detail JSON payload. Use plain `review` output when a downstream tool needs the complete structured bundle.

`inspect` and `unresolved` exclude Node builtins such as `node:path` and `fs` from unresolved-import counts so the diagnostics stay focused on project and package resolution gaps.

### Doctor and skill commands

```bash
# Print the installed CLI version
codegraph version

# Inspect package identity plus backend and runtime state
codegraph doctor

# Inspect one explicit graph or index artifact path
codegraph doctor ./.codegraph-cache/index-v1

# Install the bundled Codex-style skill into the default skill directory
codegraph skill install

# Install the bundled skill into an explicit target directory
# The target must end with /skills/codegraph
codegraph skill install --target ~/.codex/skills/codegraph --force

# Inspect bundled skill paths and target health
codegraph skill doctor
```

`codegraph doctor` includes the installed package name, version, and package root so local tarball or source-checkout installs can confirm which build the `codegraph` command is actually running.

## Incremental git-scoped runs

Use `--changed-since <ref>` or `--git-base <ref> [--git-head <ref>]` with `graph` and `index` to limit processing to the files reported by `git diff`.

The CLI pipes that file list into `buildProjectIndexFromFiles`, so unchanged files are skipped entirely when you are reviewing a PR.

`--git-head` accepts normal revisions plus the same worktree sentinels used by git-provider impact: `WORKTREE` compares the base revision to staged and unstaged tracked-file changes, while `STAGED` and `INDEX` compare the base revision to the current index.

## SQLite schema and raw SQL

The SQLite export is a first-class query interface for agent workflows.

### Tables

- `files(path TEXT PRIMARY KEY, is_external INTEGER)`
- `symbols(id TEXT PRIMARY KEY, file TEXT, name TEXT, kind TEXT, docstring TEXT, line_span INTEGER, complexity INTEGER, visibility TEXT)`
- `file_edges(from_path TEXT, to_path TEXT, to_type TEXT, raw TEXT, type_only INTEGER)`
- `symbol_edges(from_id TEXT, to_id TEXT, label TEXT)`
- `graph_metadata(key TEXT PRIMARY KEY, value TEXT)`
- `graph_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER, mode TEXT, changed_files INTEGER, deleted_files INTEGER, file_nodes INTEGER, file_edges INTEGER, symbol_nodes INTEGER, symbol_edges INTEGER)`
- `graph_snapshot_files(snapshot_id INTEGER, file_path TEXT, change_kind TEXT)`

### Indexes

- `idx_symbols_name`, `idx_symbols_kind`, `idx_symbols_name_kind`, `idx_symbols_file_kind`, `idx_symbols_kind_complexity`
- `idx_file_edges_from`, `idx_file_edges_to`, `idx_file_edges_type`
- `idx_symbol_edges_from`, `idx_symbol_edges_to`, `idx_symbol_edges_label`, `idx_symbol_edges_label_to`, `idx_symbol_edges_label_from`, `idx_symbol_edges_label_from_to`

### Example SQL

```sql
SELECT s.name, s.file, COUNT(*) AS calls
FROM symbol_edges e
JOIN symbols s ON s.id = e.to_id
WHERE e.label = 'calls' AND s.kind = 'function'
GROUP BY s.id
ORDER BY calls DESC
LIMIT 20;

SELECT from_path
FROM file_edges
WHERE to_path = 'src/auth.ts' AND to_type = 'file';
```

Raw SQL access is intentionally read-only:

```bash
codegraph sql --db ./codegraph.sqlite --query "SELECT name, file FROM symbols WHERE kind = 'function' LIMIT 5;"
```

It accepts result-producing statements such as `SELECT` and `PRAGMA` and rejects mutating SQL.

## Review bundle shape

`codegraph review` reuses the incremental manifest and produces a JSON bundle optimized for LLM-driven reviews.

```jsonc
{
  "schemaVersion": 2,
  "status": "ok",
  "summary": {
    "filesChanged": 3,
    "symbolsChanged": 12,
    "candidateTests": 5,
  },
  "riskSummary": {
    "level": "medium",
    "score": 60,
    "signals": ["exported-symbols-changed"],
  },
  "reviewTasks": [
    {
      "id": "review-summary",
      "title": "Review changed symbols",
      "description": "Scan the changed symbols and confirm behavioral changes align with intent.",
      "priority": "medium",
      "reason": "baseline-review",
    },
  ],
  "changedFiles": [
    {
      "file": "src/foo.ts",
      "status": "updated",
    },
  ],
  "graphDelta": [
    {
      "from": "src/foo.ts",
      "to": { "type": "file", "path": "src/bar.ts" },
      "raw": "./bar",
    },
  ],
  "candidateTests": [
    {
      "file": "tests/foo.test.ts",
      "confidence": "high",
      "reason": "importsChanged",
    },
  ],
  "diagnostics": {
    "missingFiles": [],
    "symbolMappingParseFailures": [],
  },
}
```

Important review-bundle details:

- `schemaVersion` identifies the review JSON schema for CI validation and compatibility checks.
- `riskSummary` and `reviewTasks` provide agent-ready review focus areas and likely risk hotspots.
- `changedFiles[].status` distinguishes normal updates from real Git deletions and explicit missing input files.
- `diagnostics.symbolMappingParseFailures` reports files where symbol-level diff mapping degraded.
- `diagnostics.missingFiles` reports explicit paths that were not present on disk.
- `graph-delta` reports file-level edge additions and removals for changed files and is intended for lightweight CI artifacts.
- `--include-symbol-details` attaches definition snippets and callsite ranges for changed symbols.
- When diff data is available, review reports focus on symbols touched by diff hunks and include `diffSnippets` with changed-line context.
- `--review-depth minimal|standard|deep` applies preset bundles:
  - `minimal`: fast graph, no symbol snippets, `maxCallsites=0`, `maxCandidates=10`
  - `standard`: symbol snippets plus up to 2 callsites, `maxCandidates=25`
  - `deep`: symbol snippets plus up to 10 callsites, `maxCandidates=50`
- Explicit flags like `--include-symbol-details`, `--max-callsites`, `--max-tests`, or `--fast-graph` override preset defaults.
- For review accuracy, keep full parsing enabled unless you intentionally want a faster, less complete pass.
- `--incremental-strict` disables fast graph extraction for changed files while still using incremental file selection.
- `--cache-verify` validates the manifest before reuse and falls back to a full rebuild if mismatches are detected.

## Local development

If you are working on this package itself, use `tsx` to run the source entrypoint directly:

```bash
npx tsx src/cli.ts graph
npx tsx src/cli.ts graph --fast-graph
npx tsx src/cli.ts goto <file> <line> <column>
```

## Output formats

Plain `graph` output is a file dependency graph only:

```json
{
  "nodes": ["/abs/path/a.ts", "..."],
  "edges": [
    {
      "from": "/abs/path/a.ts",
      "to": { "type": "external", "name": "react" },
      "raw": "react"
    },
    {
      "from": "/abs/path/a.ts",
      "to": { "type": "file", "path": "/abs/path/b.ts" },
      "raw": "./b"
    }
  ]
}
```

Format notes:

- Use `--mermaid` for a Mermaid flowchart.
- Use `--dot` for Graphviz DOT.
- In DOT output, type-only edges are dotted and external nodes are dashed ellipses.
- Use `--fast-graph` for faster JS and TS specifier extraction.

When using `--symbols`:

- Mermaid and DOT output include file nodes, file-to-file edges, symbol nodes, file-to-symbol containment edges, and symbol-to-symbol import edges.
- Use `--symbols-only` to omit file nodes and edges and render symbols only.

When using `--symbols-detailed`:

- Codegraph adds symbol-to-symbol `uses` edges when a symbol body references another symbol through local references, named or default imports, or namespace members.
- You can combine `--symbols-detailed` with `--symbols` to keep both usage and import edges alongside file nodes.
- Pruning options for large repos:
  - `--symbols-detailed-scope {all|imported}`
  - `--symbols-detailed-max-edges N`
  - `--symbols-detailed-members-only`

Compact JSON replaces repeated file and symbol IDs with numeric indices:

```bash
codegraph graph --root . ./src --symbols-detailed --compact-json --output graph.json
```

When targeting a different repo, pass it with `--root` rather than as an extra positional path:

```bash
codegraph graph --root /path/to/project --json --symbols-detailed --compact-json --output graph.json
```

## Graph viewer

Use the Sigma-based viewer to interactively explore `graph --json` or `graph --compact-json` output:

```bash
# 1) Produce graph data
codegraph graph --root . ./src --compact-json --output codegraph.json

# 2) Serve the repo root and open the viewer
python3 -m http.server 4173
# open http://localhost:4173/docs/graph-visualization/

# optional
npm run visualizer:start
```

Viewer features:

- renders file dependency graphs with Sigma.js
- supports both default JSON and compact JSON graph payloads
- supports optional symbol-node rendering for compact JSON payloads

## Related docs

- [docs/installation.md](./installation.md)
- [docs/library-api.md](./library-api.md)
- [docs/agent-workflows.md](./agent-workflows.md)
- [docs/how-it-works.md](./how-it-works.md)
