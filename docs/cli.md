# CLI Reference

Assume the CLI is available as `codegraph`.

For a source checkout of this repo, replace `codegraph` with `node ./dist/cli.js`.

If the CLI is not installed yet, use the install paths in [docs/installation.md](./installation.md). Do not use the unscoped `codegraph` package name.

Bare `codegraph graph` writes `codegraph.json` and `codegraph.err` in the current directory. Use `--stdout`, `--output <path>`, or an explicit format flag such as `--json` when scripting.

Numeric options such as `--limit`, `--threads`, `--depth`, `--max-refs`, and token bounds must be integers in their documented ranges; invalid numeric values fail instead of being silently clamped or ignored.

Default workflow:

- code review: `codegraph review --base HEAD --head WORKTREE --summary`
- blast-radius follow-up: `codegraph impact --base HEAD --head WORKTREE --pretty`
- unfamiliar repo: `codegraph orient --root . --budget small --pretty`
- targeted follow-up: `codegraph search "<query>" --json` then `codegraph explain <handle|file|symbol>`

## Runtime selection

The CLI defaults to `--native auto`, which uses the native Tree-sitter path when a compatible native artifact is available and falls back automatically otherwise.

- `--native on`: require native explicitly and fail if it is unavailable
- `--native off`: disable native explicitly and run reduced graph-only and regex recovery mode

## Project config

Commands that scan a project read `codegraph.config.json` from `--root` when it exists. The current config surface is intentionally small:

```json
{
  "discovery": {
    "includeGlobs": ["src/**/*.ts"],
    "ignoreGlobs": ["tests/samples/**", "tests/languages/samples/**"],
    "useGitignore": true
  }
}
```

- `discovery.includeGlobs` and `discovery.ignoreGlobs` are project-root-relative, even when a command scans child include roots.
- `discovery.ignoreGlobs` is for large fixture, generated, or vendored folders that should not be indexed.
- CLI `--include-glob` and `--ignore-glob` values are one-off additions relative to each scanned root.
- `inspect` follow-up commands preserve the selected `--root` and include roots.
- `--no-gitignore` overrides `useGitignore`.

Config globs and one-off CLI globs apply at different layers. `codegraph.config.json` globs are durable and project-root-relative. CLI scan-root globs are additive for a single command and are evaluated relative to each active scan root. `--no-gitignore` disables `.gitignore` filtering for that command only; it does not change config.
Cache and manifest reuse is rooted at `--root`. Reusing a project root lets commands share compatible index and graph entries when the file signatures, config, graph options, and relevant build options still match. Changing `--root`, changing discovery config, or changing graph options creates a different reuse boundary. Child include-root scans can reuse project-root cache entries, but command summaries and follow-up commands stay scoped to the selected include roots.

## Core commands

### Dependency graphs

```bash
# Fast code-review handoff for current local edits
codegraph review --base HEAD --head WORKTREE --summary
codegraph impact --base HEAD --head WORKTREE --pretty

# First-pass repo summary and next-step suggestions
codegraph orient --root . --budget small --pretty
codegraph inspect ./src --limit 20

# Whole-repo graph
codegraph graph ./

# Default graph output to stdout
codegraph graph ./ --stdout

# Fast graph-only overview
codegraph graph ./src --fast-graph

# Full AST-based graph
codegraph graph ./src

# Build a dependency graph from multiple roots
codegraph graph ./src ./packages/app ./packages/lib --mermaid > graph.mmd

# Parent folder containing separate child git repositories
codegraph graph --root ~/work billing-service shared-ui --json

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

# Include detailed SQL statement facts in JSON graph output
codegraph graph --root . --sql-artifacts --json

# SQLite export
codegraph graph --sqlite ./codegraph.sqlite

# Build and report diagnostics
codegraph graph --report
codegraph index --report
codegraph review --report --report-file review.report.json
```

`inspect` emits bounded hotspots, unresolved imports, cycles, and high-confidence duplicate opportunities from a bounded duplicate-analysis pass. Duplicate opportunities are intentionally compact and include file ranges, confidence, clone type, score, token counts, and raw pair counts; run the recommended `duplicates` command for full grouped JSON.

Graph, index, and review reports include `backend.native.byLanguage` so native usage and fallback remain visible per language. Build reports also include `backend.parser` when syntax-tree backend degradation leaves files without parser context. Reports also include `graph.fallbackImportExtraction.byLanguage` and `byReason` when regex import extraction is used. Review JSON reports `diagnostics.symbolMappingParseFailures`, `diagnostics.missingFiles`, `changedFiles[].status` as `updated`, `deleted`, or `missing`, and `sqlContext` when changed SQL files or changed SQL literals make SQL artifact facts relevant.

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

# Search for agent-ready anchors across symbols, paths, chunks, SQL objects, and graph context
codegraph orient --root . --budget small --pretty
codegraph orient --root . ./src --budget medium --json
codegraph search "build review report" --json
codegraph explain src/review.ts --json
codegraph packet get src/cli.ts --pretty
codegraph search "public users" --mode sql --json
codegraph search "handle login" --from src/auth.ts --mode graph --depth 1 --json
codegraph search --help

# Explain a file, symbol, SQL object, or search result handle
codegraph explain src/auth.ts --json
codegraph explain validateUser --json
codegraph explain public.users --json
codegraph explain src/large-file.ts --max-symbols 25 --json
codegraph explain --help

# Build an agent-ready artifact bundle
codegraph artifact build --root . --out codegraph-out --json
codegraph artifact build --root . --out codegraph-out --sqlite --graph-json --report --questions --force --json
codegraph artifact --help

# Serve MCP tools over the same search, navigation, artifact, and review layer
codegraph mcp serve --root . --stdio
codegraph mcp serve --root . --artifact codegraph-out --stdio
codegraph mcp serve --root . --stdio --allow-build
codegraph mcp serve --root . --port 7331
codegraph mcp serve --root . --stdio --warmup
codegraph mcp serve --root . --port 7331 --warmup-symbols
codegraph mcp --help

# Chunk a file for LLM processing
codegraph chunk src/utils.js

# Output text chunks as JSON
codegraph chunk package.json --text --max-tokens 200

# Override language detection and token limits
codegraph chunk config.yaml --language yaml --min-tokens 100 --max-tokens 300

# Detect duplicate and near-duplicate code units
codegraph duplicates --root . ./src --profile cleanup
codegraph duplicates --root . ./src ./packages/app --include-same-file
codegraph duplicates --root . ./src --ignore-glob "tests/**" --ignore-glob "docs/**"
codegraph duplicates --root . ./tests --ignore-root-glob "tests/languages/**"
codegraph duplicates ./src --json --sort reduced-lines
codegraph duplicates ./src --json --raw-pairs
codegraph duplicates --help

# Compare architecture drift between git refs
codegraph drift ./src --base origin/main --head HEAD --pretty --graph-edges summary --public-api removals
codegraph drift ./src --base origin/main --head HEAD --json
codegraph drift ./src --base origin/main --head HEAD --compact-json
codegraph drift ./src --base origin/main --head HEAD --fail-on new-cycle,public-api-removal
codegraph drift --base-artifact ./baseline/codegraph-out --head . --json

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

`duplicates` emits one-line triage summaries by default, or grouped exact, renamed, near, and weak clone candidates as JSON with `--json`.

- It combines indexed symbols, semantic chunks, text chunks, token fingerprints, and AST shape hashes when parser context is available.
- Pretty output is the default.
- `--profile cleanup` and `--profile refactor-roi` are aliases for cleanup triage defaults. In pretty mode they default to `--sort reduced-lines`; in JSON mode they keep similarity order unless `--sort` is explicit. Both profiles also default `--min-confidence medium` and `--min-tokens 80`, and they suppress groups labeled `import-list-noise` or `barrel-export-noise`.
- Pretty output includes reduced lines, estimated reducible lines, cleanup labels, cluster counts, and a compact summary footer. Use `--no-summary` to suppress the footer.
- `--sort actionability` remains the default in pretty mode outside the cleanup profile.
- JSON output emits `schemaVersion: 3`.
- JSON reports project-relative paths, confidence, clone type, metrics, `reducedLines`, `estimatedLinesSaved`, local `locations`, optional transitive `cluster`, omission counts, and pair stats.
- JSON defaults to similarity ordering unless `--sort` is explicit.
- Groups collapse overlapping symbol/chunk variants so one underlying clone appears as one finding.
- A single positional directory becomes the project root unless `--root` is set. `orient` is the exception: its positionals are always include roots.
- Use `--root . ./src` for scoped scans with repository-relative paths.
- Positional paths are scan roots, not glob patterns.
- `--include-glob` and `--ignore-glob` are relative to each active scan root.
- `--include-root-glob` and `--ignore-root-glob` are duplicates-only project-root-relative one-off filters.
- Zero-match scan-root glob warnings explain the scan-root-relative interpretation and suggest likely replacements when a root-prefixed pattern misses under an include root.
- Use `--include-small` for tiny helpers.
- Use `--include-same-file` for non-overlapping clones inside one file.
- Use `--json` for stable machine consumption.
- Use `--raw-pairs` when debugging low-level pair evidence. `--pretty --raw-pairs`, `--sort actionability --raw-pairs`, `--sort reduced-lines --raw-pairs`, and `--profile cleanup --raw-pairs` are rejected.

Short JSON shape:

```json
{
  "schemaVersion": 3,
  "groups": [
    {
      "primaryLeft": { "file": "src/a.ts", "startLine": 10, "endLine": 24 },
      "primaryRight": { "file": "src/b.ts", "startLine": 12, "endLine": 26 },
      "locations": [
        { "file": "src/a.ts", "startLine": 10, "endLine": 24 },
        { "file": "src/b.ts", "startLine": 12, "endLine": 26 }
      ],
      "reducedLines": 15,
      "estimatedLinesSaved": 15,
      "cleanupLabels": ["production-helper-extraction"]
    }
  ]
}
```

#### Agent orientation and packets

- Use `orient --pretty` as the compact first-turn reading surface for people or models; it prints the ranked `focus` targets and their follow-up commands before the scope sketch.
- Use `orient --json` when follow-up tools need exact focus reasons, limits, and omitted counts. Orient suppresses index rebuild warnings so stdout stays parseable.
- Small orientation budgets default to `--health skip`. Medium and large default to `--health summary`, which counts cycles and unresolved imports while omitting duplicate health; use `--health full` when exhaustive duplicate counts matter.
- Use `packet get` with file paths, symbol names, SQL object names, file/symbol/chunk/SQL/graph handles, or review handles to retrieve bounded evidence plus follow-up commands.
- Agent commands reuse the incremental index path and default to disk cache. Use shared index flags such as `--cache`, `--cache-strict`, `--cache-verify`, `--threads`, `--native`, `--workers`, `--include-glob`, `--ignore-glob`, and `--no-gitignore` when the packet should match a specific scan mode.

`search` is deterministic and vectorless. Hybrid search is code-first by default: source symbols and implementation files outrank docs unless `--mode text` is explicit or docs are the strongest remaining evidence. Search JSON now includes top-level `analysis` metadata plus per-result `provenance` so mixed or reduced runs stay visible. `explain` resolves file paths, symbol names, SQL object names, and search handles into bounded packets with symbols, graph context, references, snippets, duplicate context, SQL facts, review tasks, candidate tests, analysis metadata, limits, omissions, and follow-ups. Use `--max-duplicates` to tune duplicate context in `explain` and `packet get`; duplicate context also uses an internal pair budget and reports skipped duplicate work through omission counts.

For SQL, prefer handles or schema-qualified names when basenames may be ambiguous. Reference and snippet omission counts are lower bounds after bounded navigation reaches its cap.

#### Artifact bundles

- `artifact build` writes `codegraph.sqlite`, `graph.json`, `CODEGRAPH_REPORT.md`, `questions.json`, and `manifest.json` by default.
- Artifact suggested questions use unique IDs backed by stable handles when possible.
- Use artifact flags to select a subset.
- Use `--force` to replace recognizable stale Codegraph artifacts while preserving unrelated files.
- Artifact contents exclude their own output directory and linked outside-root files.

#### MCP server

- `mcp serve` exposes navigation, search, impact, review, SQLite query, session refresh, and artifact-build tools.
- MCP uses stdio by default or Streamable HTTP with `--port <number>`.
- Startup is lazy by default; `--warmup` builds the base session cache before serving requests, and `--warmup-symbols` also builds the detailed symbol graph.
- Index-backed responses include `freshness`; small file changes auto-refresh, while stale responses include a reason, total changed-file count, and a bounded changed-file sample.
- Use `refresh_index` to force a rebuild, reset SQLite artifact state, or recover after stale change bursts.
- HTTP serves `/mcp`, validates Host headers, and binds to `127.0.0.1` unless `--host <host>` is passed.
- MCP file and artifact paths are confined to `--root` after realpath resolution.
- MCP tools are read-only by default; `--allow-build` enables artifact output only.
- `query_sqlite` is row- and byte-bounded, returns freshness metadata, rejects synthetic payload functions, and refuses stale artifact rows it cannot refresh safely.

See [docs/mcp.md](./mcp.md) for client configuration examples.

#### Chunking

`chunk` uses semantic Tree-sitter chunking for registered source and stylesheet languages, Vue and Svelte block-aware chunking for single-file components, and text chunking for JSON, YAML, and unsupported extensions. Use `--text` to force text chunking.

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

Cycle detection reports source dependency cycles. Document-only link loops, such as Markdown files linking to each other, remain in the graph for navigation but are not reported as dependency cycles.

Dependency read commands keep the same output contracts while using the indexed graph path and derived adjacency maps internally when available. This makes repeated `deps`, `rdeps`, and `path` reads cheaper on warm manifest-backed projects.

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

# Control duplicate leads in pretty summaries
codegraph impact --base main --head feature --pretty --duplicates changed
codegraph impact --base main --head feature --pretty --duplicates off

# Compact JSON using impact's graph-style alias
codegraph impact --base main --head feature --compact-json

# Limit analysis depth and reference count
codegraph impact --base main --head feature --depth 2 --max-refs 1000

# Exported-only scope
codegraph impact --base main --head feature --scope imported

# Ignore noisy files
codegraph impact --base main --head feature --ignore-glob "**/package-lock.json" --ignore-glob "**/dist/**"

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
codegraph review --base origin/main --head HEAD --summary --duplicates impacted

# File-level graph delta between revisions
codegraph graph-delta --git-base origin/main --git-head HEAD > graph-delta.json
```

```bash
# Architecture drift with CI policy gates
codegraph drift ./src --base origin/main --head HEAD --pretty --graph-edges summary --public-api removals
codegraph drift ./src --base origin/main --head HEAD --compact-json
codegraph drift ./src --base origin/main --head HEAD --fail-on new-cycle,unresolved-import,public-api-removal
codegraph drift --base-artifact ./baseline/codegraph-out --head . --json
```

`drift` compares architecture signals, not runtime behavior, compiler diagnostics, or style.

- `--graph-edges full|summary|off` controls whether graph-edge churn is emitted per edge, summarized by source file, or suppressed.
- `--public-api all|removals|off` controls whether API additions are shown; removals stay the main review signal.
- `--compact-json` emits bounded machine-friendly JSON with summary counts and example findings.
- Duplicate drift compares group counts plus stable top-group deltas; duplicate increases are review or CI findings and only fail the process when selected by `--fail-on`.

For git-provider impact, `--head` accepts normal revisions plus worktree sentinels. Use `WORKTREE` to compare the base revision against the current working tree, including staged and unstaged tracked-file changes. Use `STAGED` or `INDEX` to compare the base revision against the current index; with `--base HEAD`, that is staged changes only. Untracked files are not included until they are staged or otherwise tracked by Git.

Impact JSON responses include `schemaVersion` plus `format: "full" | "compact"` so downstream tools can branch on payload shape without inferring it from missing fields. Use `--compact` or `--compact-json` for compact impact JSON. Impact JSON can also include `exportSummary`, `reexportChains`, `topImpacts`, `surfaceArea`, `clusters`, and `changedSymbols[].callCompatibility` when applicable. `changedFiles[]` entries preserve git copy or rename metadata as `oldFile` and `similarityIndex` when present. File paths in impact reports are project-relative, and raw diffs that point outside the project root are rejected.

`callCompatibility` is a conservative review hint, not type checking. Likely-mismatch support is provider-backed for source languages where Codegraph resolves the callee and can count arguments with high confidence. Overload sets are skipped unless Codegraph can prove the exact overload target. Pretty impact and review summaries show only `likely_mismatch` findings; compatible, unsupported, or ambiguous callsites are omitted from human output and appear in structured data only when useful.

Pretty impact and review summaries also show high-confidence exact or renamed duplicate leads by default:

- `impact --pretty` defaults to `--duplicates changed`.
- `review --summary` defaults to `--duplicates impacted`.
- Use `--duplicates off|changed|impacted|all` to control duplicate-lead scope.
- Git copy or rename `similarityIndex` metadata of 80 or higher can boost scoped duplicate leads when both old and new files exist in the indexed snapshot.
- Structured review JSON also adds bounded `duplicate-sibling` review tasks when changed files or symbols overlap high-confidence duplicate groups. Treat these as "check the sibling implementation" prompts, not semantic-equivalence claims.
- JSON output keeps the existing impact and review contracts; use `codegraph duplicates --json` for full grouped duplicate JSON.

### Call Compatibility Output

Run impact or review normally; no extra flag is required:

```bash
codegraph impact --base main --head feature --pretty
codegraph impact --base main --head feature --json
codegraph review --base main --head feature --summary
codegraph review --base main --head feature > review.json
```

Call compatibility appears only after Codegraph detects a changed callable signature. Human output lists likely argument-count mismatches as review leads; JSON output attaches full hint objects under `changedSymbols[].callCompatibility`.

- Inspect `callsiteFile`, `callsiteRange`, `expected`, and `actual` before treating a hint as a defect.
- Expect skipped output for overload sets, spread arguments, dynamic dispatch, unresolved callsites, and unsupported syntax.
- Use `docs/language-parity.md` for the current language support matrix and known limitations.

`codegraph review --summary` prints the changed-file count, changed-symbol count, risk summary, review tasks, and suggested tests without emitting the full `projectFiles` and symbol-detail JSON payload. High- and medium-confidence candidate tests are listed directly; low-confidence pattern matches are summarized as breadth hints and remain available in the full JSON bundle. Use plain `review` output when a downstream tool needs the complete structured bundle.

SQL review context is emitted only as `sqlContext.entries[]` in structured review JSON. Entries carry a `reason` such as `changed_sql_file` or `changed_sql_literal`, the matched `objectName`, and the original SQL statement fact. They are review hints, not source dependency edges.

`inspect` and `unresolved` exclude graph-only document/template link edges plus known runtime and package externals from unresolved-import counts so diagnostics stay focused on source import resolution gaps. Runtime and package filtering includes Node builtins such as `node:path` and `fs`, supported-language standard library imports, URL imports, and dependencies declared in nearby manifests such as `package.json`, `requirements.txt`, `requirements.in`, `pyproject.toml`, `setup.cfg`, `Pipfile`, `composer.json`, `Cargo.toml`, `go.mod`, `build.zig.zon`, `Gemfile`, `*.gemspec`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `*.csproj`, `*.fsproj`, `*.vbproj`, `vcpkg.json`, and `Package.swift`.

### Doctor and skill commands

```bash
# Print the installed CLI version
codegraph version
codegraph -v

# Print package identity as JSON
codegraph version --json

# Inspect package identity plus backend and runtime state
codegraph doctor

# Inspect one explicit graph or index artifact path
codegraph doctor ./.codegraph-cache/index-v1

# Inspect an artifact bundle directory or one artifact file
codegraph doctor ./codegraph-out
codegraph doctor ./codegraph-out/codegraph.sqlite

# Install the bundled skill into a known agent location.
# The installer creates the target skills directory as needed.
codegraph skill install --agent codex

codegraph skill install --agent claude

codegraph skill install --agent agents

codegraph skill install --agent cursor

codegraph skill install --agent gemini

codegraph skill install --agent opencode

# Install the bundled skill into an explicit target directory
# The target must end with /skills/codegraph.
codegraph skill install --target ~/.codex/skills/codegraph --force

# Inspect bundled skill paths and target health
codegraph skill doctor
```

`codegraph skill install --agent <name>` supports `agents`, `codex`, `claude`, `cursor`, `gemini`, and `opencode`. Skill install targets must end with `skills/codegraph`; when that safe target shape is satisfied, the installer creates the directory as needed. Cursor CLI now supports native skills directories too, so `.cursor/skills/codegraph` works alongside the universal `~/.agents/skills/codegraph` location. `codegraph -v`, `codegraph version --json`, and `codegraph doctor` include or identify the installed package version so local tarball or source-checkout installs can confirm which build the `codegraph` command is actually running. `doctor` also reports backend/runtime state and optional artifact details, including `artifactBundle` details for directories with a Codegraph `manifest.json`.

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
- `diagnostics.symbolMappingParseFailures` reports files where symbol-level diff mapping degraded. Source-language failures affect `symbol-mapping-degraded` risk; graph-first document files remain diagnostics without becoming high-priority source review tasks.
- `diagnostics.missingFiles` reports explicit paths that were not present on disk.
- `graph-delta` reports file-level edge additions and removals for changed files and is intended for lightweight CI artifacts.
- `--include-symbol-details` attaches definition snippets and callsite ranges for changed symbols.
- Changed symbol details may include `callCompatibility` for high-confidence provider-backed callsite arity mismatches after signature changes. Agents should inspect the code before treating these leads as defects.
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

`--pretty` and `--summary` are presentation modes for compact reading by people or models. They may omit low-confidence or verbose context that remains available in structured JSON and TypeScript return values. Integrators that compose deterministic review packs should use the exported TypeScript functions or JSON output.

Plain `graph` output is a file dependency graph only. In default graph mode, output goes to `codegraph.json` unless `--stdout` or `--output <path>` is passed.

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

SQL files are part of normal graph output: `.sql` files are discovered by default, SQL-to-SQL object references appear as file edges, and SQL object symbols work with `goto` and `refs` inside SQL files. SQL-to-SQL edges are precise for exact object-name matches, heuristic for unambiguous qualified-to-basename fallback matches, and skipped for ambiguous basename guesses. SQL `goto` and `refs` resolve schema-qualified names plus object-level alias/table-qualified references such as `t.id` or `schema.table.id` to table/view definitions, not to column declarations. With `--sql-artifacts`, JSON graph output also includes detailed SQL statement facts and object-candidate metadata. SQL artifact nodes use `sql_statement_fact` and `sql_schema_candidate` truth tiers; they do not assert a current schema and do not globally link application-code strings to SQL objects.

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

## Graph export inspection

Codegraph currently ships graph data formats, not a packaged interactive viewer. Use the exported artifacts directly with scripts or existing graph tools:

```bash
# Compact JSON for scripts and downstream tooling
codegraph graph --root . ./src --compact-json --output codegraph.json

# Mermaid for Markdown renderers that support Mermaid diagrams
codegraph graph --root . ./src --mermaid --output graph.mmd

# DOT for Graphviz
codegraph graph --root . ./src --dot --output graph.dot
```

## Related docs

- [docs/installation.md](./installation.md)
- [docs/library-api.md](./library-api.md)
- [docs/agent-workflows.md](./agent-workflows.md)
- [docs/how-it-works.md](./how-it-works.md)
