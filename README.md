# codegraph

A tiny tool to **understand a repo**, **navigate code**, and **answer questions** fast. It supports JavaScript/TypeScript, Python, Go, Java, C#, Ruby, Rust, Kotlin, Swift, C, C++, and the script blocks inside Vue/Svelte files. Built-in **code review** and **impact analysis** utilities map PR diffs to changed symbols and affected code, with streaming, ignore patterns, and optional reference verification.

It builds:

* a **module dependency graph** (imports / re-exports / `require()` / dynamic `import()`),
* a per-file **symbol index** (locals + exports),
* **go to definition** and **find references**,
* plus a minimal **AST grep** (Tree-sitter query runner).

It stays small on purpose and is built to be easy to extend to new grammars.

Sample graph: [sample-graph.md](./sample-graph.md)

## Table of contents

* [Features](#features)
* [Supported languages](#supported-languages)
* [Semantic Chunking](#semantic-chunking)
* [Installation](#installation)
* [Requirements](#requirements)
* [Usage](#usage)
* [Performance](#performance)
* [Programmatic usage (from code)](#programmatic-usage-from-code)
* [How it works (high level)](#how-it-works-high-level)
* [Extending to other languages](#extending-to-other-languages)
* [Unit testing](#unit-testing)
* [FAQ](#faq)
* [Contributing & Releases](#contributing--releases)

---

## Features

* **Dependency graph**
  * JS/TS: `import`, `export ... from`, `export * from`, `require()`, `import()`, CommonJS destructuring
  * JSON modules referenced from JS/TS (including `assert { type: "json" }`) are treated as default-only dependencies
  * Python: `import`, `from ... import`, relative imports with package resolution
  * Go/Java/C#/Ruby/Rust: Tree-sitter queries capture module imports/usings and resolve them to files or packages
  * Unresolved targets are represented as **external** nodes
* **Symbol index**
  * Extracts functions, classes, variables, interfaces, types, and exports
  * Captures docstrings (leading comments), line spans, and a lightweight complexity heuristic for symbols
  * Works across JS/TS, Python, Go, Java, C#, Ruby, Rust, and Vue/Svelte script blocks with consistent scope handling
* **Go to definition**
  * Cross-file navigation for all supported languages
  * TS/JS: Re-exports, namespace imports, CommonJS destructuring
  * Python: Module imports, `__all__` exports, relative imports
  * Go/Java/C#/Ruby/Rust: Package members and namespace lookups flow through the same resolver
* **Find references**
  * Project-wide scanning with lexical scope awareness
  * TS/JS: Namespace members, re-exports, CommonJS patterns
  * Python: Module imports, `__all__` exports, relative imports
  * Go/Java/C#/Ruby/Rust: Collects import bindings and usages within packages
* **AST grep**
  * Run arbitrary Tree-sitter queries across the repo
* **Agent query helpers**
  * Parse simple text queries and retrieve matching symbols or neighbor subgraphs
  * Export graphs as triples for downstream knowledge-graph storage
  * Detailed symbol graphs include semantic edges like `calls`, `instantiates`, `extends`, `implements`, and `decorates`
* **SQLite graph output**
  * Export file and symbol graphs into a queryable SQLite database with indexed tables
  * Supports incremental updates by re-writing changed files, deleting removed files, patching affected symbol/file edges, and recording temporal snapshots in SQLite
* **Dependency Analysis**
  * `deps <file>`: List all dependencies of a file
  * `rdeps <file>`: List all files that depend on a file
  * `path <from> <to>`: Find the shortest dependency path between two files
  * `cycles`: Detect circular dependencies with SCC priority, entry edges, remediation hints, and sort modes (`--sort priority|size|fanin`)
* **Diagnostics & Reports**
  * `unresolved`: List external/unresolved imports and their importers
  * `hotspots`: Identify files with high complexity (fan-in/fan-out)
  * `apisurface`: Summarize public API (exported symbols) across the repo
* **PR impact analysis**
  * Map git diffs to changed symbols and affected code
  * Analyze direct and transitive dependencies with severity scoring
  * **Ignore patterns**: Exclude specific files (e.g. generated code, locks) via `ignoreGlobs` to reduce noise.
  * **Large diff support**: Handles 50k+ line PRs via asynchronous streaming (no 1MB buffer limit)
  * **Circuit breaker**: Detects extremely large diffs and provides a warning if analysis might be partial
  * Git/GitHub integration with configurable depth and scope
  * Missing import/export/declaration suggestions include a high/medium/low confidence score for quick triage
* **Why not use an LSP?**
  * **Latency & "Cold Start"**: LSPs are designed for long-running editor sessions. They take minutes to initialize and type-check a large repo. `codegraph` parses and indexes in seconds, making it suitable for ephemeral agent environments.
  * **Multi-Language Complexity**: An agent environment would need to manage separate heavy LSP processes for TS, Python, Go, Java, etc. `codegraph` is a single lightweight library that handles all of them uniformly.
  * **"Global" vs. "Local" Context**: LSPs answer "what is under my cursor?". `codegraph` answers "what is the structure of this module?" or "what depends on this file?". It provides the high-level graph view that agents need to plan their exploration.
  * **Robustness to Broken Code**: LSPs often fail or degrade when code doesn't compile or dependencies are missing. `codegraph` uses robust parsing (Tree-sitter) to extract structure even from broken or incomplete projects, which is critical when agents are tasked with fixing builds.
* **Monorepo support**
  * Workspace detection (npm/yarn/pnpm/lerna)
  * Per-file TypeScript config resolution
  * Package-relative import resolution
* **Project file discovery**
  * Finds common manifests (package.json, pyproject.toml, pom.xml, build.gradle, .csproj, .sln, .idea)
  * Extracts lightweight project names when metadata is available
* **Semantic chunking**
  * Tree-sitter-based code splitting for JS/TS/Python into embedding-ready chunks
  * Text file chunking for JSON/YAML/config files
  * Configurable token budgets (150-400 tokens per chunk)
  * Semantic awareness: classes, functions, methods, interfaces, namespaces, imports
* **Cross-language parity**: All supported languages share the same go-to-definition and find-references pipeline, so navigation works the same way everywhere.

---

## Supported languages

* **JavaScript / TypeScript** (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`)
* **Python** (`.py`)
* **Go** (`.go`)
* **Java** (`.java`)
* **C#** (`.cs`)
* **Ruby** (`.rb`)
* **Rust** (`.rs`)
* **Kotlin** (`.kt`)
* **Swift** (`.swift`)
* **C** (`.c`)
* **C++** (`.cpp`)
* **Vue / Svelte SFCs** (`.vue`, `.svelte`) — script blocks are parsed with the JS/TS pipeline, so dependency graphs and go-to-definition work across components.

Each listed language (including Vue/Svelte script sections) has the same dependency-graph, go-to-definition, and find-references support.
When the optional native addon is available, all listed source languages use the same native Tree-sitter runtime and query model; unsupported capabilities still fall back through the shared JS path where needed.
The regression suite covers deeper syntax variants too, including aliased and static imports, nested types, traits and protocols, typedefs and aliases, and Vue/Svelte script variants.
See the coverage matrix in [docs/language-parity.md](./docs/language-parity.md).

**Project files**: project manifests like package.json, pyproject.toml, pom.xml, build.gradle, requirements.txt, .sln, .idea, etc. See [docs/language-parity.md](./docs/language-parity.md) for more details.

**Text files**: JSON, YAML, configuration files, documentation

**Single File Components**: Vue (`.vue`) and Svelte (`.svelte`) files are split into their `<template>`, `<script>`, and `<style>` regions, then chunked with the appropriate HTML/JS/TS/CSS grammars. Each block falls back to token-based chunking if semantic parsing fails, so hybrid files always produce chunks.

---

## Semantic Chunking

The library provides semantic code chunking utilities for preparing codebases for LLM processing and vector embeddings. It uses Tree-sitter to split code into meaningful units while respecting token budgets.

### APIs

```ts
import { chunkFile, chunkTextFile, LANG_CONFIGS } from '@lzehrung/codegraph';

// Chunk a code file semantically
const source = `function hello(name) { return "Hello " + name; }`;
const chunks = chunkFile({
  language: LANG_CONFIGS.javascript,
  source,
  filePath: "utils.js",
  minTokens: 150,  // Merge small chunks
  maxTokens: 400,  // Split large chunks
});

// Chunk text files by token budget
const jsonText = `{"config": {"port": 3000, "host": "localhost"}}`;
const textChunks = chunkTextFile({
  source: jsonText,
  languageId: "json",
  minTokens: 100,
  maxTokens: 200,
});
```

### Chunk Format

Each chunk includes:

```ts
interface Chunk {
  id: string;           // Unique identifier
  languageId: string;   // "javascript", "typescript", "python", etc.
  filePath?: string;    // Optional source file path
  type: string;         // "function", "class", "method", "import", "misc", etc.
  name?: string;        // Symbol name if applicable
  startLine: number;     // 1-based start line
  endLine: number;       // 1-based end line
  text: string;         // The chunk content
  tokenCount: number;   // Token count estimate
}
```

### Configuration Options

* **`minTokens`**: Minimum tokens per chunk (default: 150). Smaller chunks are merged.
* **`maxTokens`**: Maximum tokens per chunk (default: 400). Larger chunks are split.
* **`tokenizer`**: Custom token counting function (default: whitespace-based).

### Example Output

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

### Testing & Reference

See the test suites for comprehensive examples:
- `tests/languages/*.test.ts`: Data-driven tests for each supported language
- `tests/chunkFile.behavior.test.ts`: Detailed behavior and edge case tests
- `docs/chunking-test-plan.md`: Living checklist for enum/docstring/CLI regression guards
- `tests/chunk-cli.test.ts`: CLI `chunk` command smoke tests for language overrides and token limits
- `tests/samples/chunking/integration-example.test.ts`: Agent-focused integration examples showing how to filter chunks by type, prepare them for embeddings, and implement decision-making logic

The integration examples demonstrate:
- Semantic chunking of code files with type-based filtering
- Text file chunking for configuration processing
- Intelligent splitting of large code blocks
- Agent-friendly metadata for prioritizing and processing chunks

---

## Installation

### Option 1: Install from the `@lzehrung` registry

Configure the scoped registry if you have not already:

```bash
npm config set @lzehrung:registry https://npm.pkg.github.com
```

Install the package:

```bash
npm install @lzehrung/codegraph
```

That is the simplest way to use the native Tree-sitter path. `@lzehrung/codegraph` automatically pulls in the matching optional native package when a published binary exists for the current platform, and the library and CLI use it automatically.

### Option 2: Local source checkout

Clone the repository and build both the TypeScript package and optional native addon:

```bash
git clone https://github.com/lzehrung/codegraph.git
cd codegraph
npm install
npm run build
npm run build:native
```

Use this path when you are developing on codegraph itself or want to build the native addon locally.

## Requirements

* **Node.js 18+**
* Published installs do not require Rust or a manual native setup step
* Local native builds require a working Rust toolchain plus `npm run build:native`
* If no compatible native package is available, Codegraph falls back to the JS Tree-sitter path automatically

---

## Usage

### CLI Commands

After installing the package, use the `codegraph` CLI:

The CLI automatically uses the native Tree-sitter path when a compatible native package is installed. If not, it falls back to the JS Tree-sitter path automatically.

```bash
# File dependency graph only (default; no symbols)
npx codegraph graph

# Build a dependency graph from multiple roots
npx codegraph graph ./src ./packages/app ./packages/lib --mermaid > graph.mmd

# Build a dependency graph in Mermaid format
npx codegraph graph --mermaid > graph.mmd
# Fast graph-only mode (JS/TS specifiers via regex, skips parsing for specifiers)
npx codegraph graph --mermaid --fast-graph > graph.fast.mmd

# File + symbols graph (imports/exports)
npx codegraph graph --root . ./src --mermaid --symbols > graph.symbols.mmd
# Symbols only (no file nodes/edges)
npx codegraph graph --root . ./src --mermaid --symbols-only > graph.symbols.only.mmd
# Detailed symbol usage graph (adds symbol -> symbol "uses" edges)
npx codegraph graph --root . ./src --mermaid --symbols-detailed > graph.symbols.detailed.mmd
# Detailed + files hybrid
npx codegraph graph --root . ./src --mermaid --symbols --symbols-detailed > graph.symbols.hybrid.detailed.mmd
# Pruned detailed graph for very large repos
npx codegraph graph --root . ./src --mermaid --symbols-detailed \
  --symbols-detailed-scope imported \
  --symbols-detailed-max-edges 5000 \
  --symbols-detailed-members-only > graph.symbols.pruned.mmd

# Build a dependency graph in Graphviz DOT format
npx codegraph graph --dot > graph.dot
# Render to SVG (requires Graphviz)
dot -Tsvg graph.dot -o graph.svg

# Specify a different root directory (optional, defaults to current directory)
npx codegraph graph /path/to/project --mermaid > graph.mmd

# Build the full project index (graph + per-file symbol indexes)
npx codegraph index
# Print full JSON index including locals/imports/exports
npx codegraph index --json
# Use concurrency and incremental cache
npx codegraph index --threads 8 --cache disk

# Build the project index from multiple roots
npx codegraph index ./src ./packages/app ./packages/lib

# Chunk a file for LLM processing (semantic for code, token-based for text)
npx codegraph chunk src/utils.js
# Output chunks as JSON array with metadata
npx codegraph chunk package.json --text --max-tokens 200
# Override language detection and token limits
npx codegraph chunk config.yaml --language yaml --min-tokens 100 --max-tokens 300

# Go to definition of symbol at file:line:column
npx codegraph goto <file> <line> <column>

# Find references of symbol at a location
npx codegraph refs --file <file> --line <line> --col <column>
# Pretty-print only the file:line:col
npx codegraph refs --file <file> --line <line> --col <column> --pretty

# Run a Tree-sitter query across the repo
npx codegraph grep --query '(function_declaration name: (identifier) @name)'
# Run a plain text regex grep across the repo
npx codegraph grep --pattern 'eval\\(' --ignore-case

# Dependency analysis
npx codegraph deps src/main.ts
npx codegraph rdeps src/utils.ts
npx codegraph path src/main.ts src/utils.ts
npx codegraph cycles

# Diagnostics and reports
npx codegraph unresolved
npx codegraph hotspots
npx codegraph apisurface
# Emit a JSON timing/cache report to stderr (or a file)
npx codegraph index --report
npx codegraph review --report --report-file review.report.json
# Reports include graph.fallbackImportExtraction when regex fallback import extraction is used.
# Index build reports also include backend.native with byLanguage counters so you can see where native Tree-sitter was used, where it fell back, and which query kinds were normalized or skipped.

# Analyze PR impact: map diffs to symbols and find affected code
npx codegraph impact --base <commit-sha> --head <commit-sha>
# Analyze GitHub PR impact
npx codegraph impact --provider github --repo owner/name --pr 123
# Analyze raw diff text (from stdin)
cat diff.txt | npx codegraph impact --provider raw
# Pretty-printed summary with severity scores
npx codegraph impact --base main --head feature --pretty
# Limit analysis depth and reference count
npx codegraph impact --base main --head feature --depth 2 --max-refs 1000
# Focus on exported symbol changes only (ignore internal changes)
npx codegraph impact --base main --head feature --scope imported
# Ignore large/costly files in impact analysis
npx codegraph impact --base main --head feature --ignore-glob "**/package-lock.json" "**/dist/**"
# Skip transitive file dependencies (symbol references only)
npx codegraph impact --base main --head feature --members-only
# Include line context snippets for references (±5 lines by default)
npx codegraph impact --base main --head feature --ref-context line
# Include block context snippets for references (enclosing function/class, max 60 lines)
npx codegraph impact --base main --head feature --ref-context block --ref-block-max-lines 30
# Verify missing imports/exports/declarations in changed lines
npx codegraph impact --base main --head feature --verify-refs
# Add LCOV/Istanbul-aware untested-change suggestions and confidence calibration
npx codegraph impact --base main --head feature --lcov coverage/lcov.info --coverage-report coverage/coverage-final.json
# Use a repository-specific test command template for untested suggestions
npx codegraph impact --base main --head feature --coverage-report coverage/coverage-final.json --test-command-template "pnpm vitest {files}"
# Programmatic API equivalent
await analyzeImpactFromDiff(root, index, { provider: "git", base: "main", head: "feature", verifyReferences: true });

Impact JSON responses can include `exportSummary` (exported changed symbols by file), `reexportChains` (file-level re-export chains for exported changes), `topImpacts` (top 10 impacted items with reasons), `surfaceArea` (fan-in/fan-out summary with top 10 lists), and `clusters` (connected change/impact groups with aggregated severity) when applicable.

# Generate a PR review bundle (incremental graph + symbol summary)
npx codegraph review --base origin/main --head HEAD > review.json
# Include definition snippets + callsites (top-N) for changed symbols
npx codegraph review --base origin/main --head HEAD --include-symbol-details --max-callsites 5 > review.json
# Use review presets for common depth/quality tradeoffs
npx codegraph review --base origin/main --head HEAD --review-depth standard > review.json
# Export graph deltas between revisions (requires manifest cache)
npx codegraph graph-delta --git-base origin/main --git-head HEAD > graph-delta.json

# Export full graphs to SQLite (queryable by agents/tools)
npx codegraph graph --sqlite ./codegraph.sqlite
# Incrementally update SQLite for a Git range (changed + deleted files reconciled; snapshots recorded)
npx codegraph graph --git-base origin/main --git-head HEAD --sqlite ./codegraph.sqlite
# Run raw SQL against the SQLite DB and return JSON
npx codegraph sql --db ./codegraph.sqlite --query "SELECT name, file FROM symbols WHERE kind = 'function' LIMIT 5;"
```

Use `--changed-since <ref>` or `--git-base <ref> [--git-head <ref>]` with `graph` and `index`
to limit processing to the files reported by `git diff`. The CLI pipes that list into
`buildProjectIndexFromFiles`, so unchanged files are skipped entirely when you’re
reviewing a PR.

### SQLite schema & raw SQL access

The SQLite export is a **first-class query interface** for agent workflows. The schema is:

**Tables**
- `files(path TEXT PRIMARY KEY, is_external INTEGER)`
- `symbols(id TEXT PRIMARY KEY, file TEXT, name TEXT, kind TEXT, docstring TEXT, line_span INTEGER, complexity INTEGER, visibility TEXT)`
- `file_edges(from_path TEXT, to_path TEXT, to_type TEXT, raw TEXT, type_only INTEGER)`
- `symbol_edges(from_id TEXT, to_id TEXT, label TEXT)`
- `graph_metadata(key TEXT PRIMARY KEY, value TEXT)`
- `graph_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER, mode TEXT, changed_files INTEGER, deleted_files INTEGER, file_nodes INTEGER, file_edges INTEGER, symbol_nodes INTEGER, symbol_edges INTEGER)`
- `graph_snapshot_files(snapshot_id INTEGER, file_path TEXT, change_kind TEXT)`

**Indexes (most relevant)**
- `idx_symbols_name`, `idx_symbols_kind`, `idx_symbols_name_kind`, `idx_symbols_file_kind`, `idx_symbols_kind_complexity`
- `idx_file_edges_from`, `idx_file_edges_to`, `idx_file_edges_type`
- `idx_symbol_edges_from`, `idx_symbol_edges_to`, `idx_symbol_edges_label`, `idx_symbol_edges_label_to`, `idx_symbol_edges_label_from`, `idx_symbol_edges_label_from_to`

**Example SQL**
```sql
-- Most-called functions
SELECT s.name, s.file, COUNT(*) AS calls
FROM symbol_edges e
JOIN symbols s ON s.id = e.to_id
WHERE e.label = 'calls' AND s.kind = 'function'
GROUP BY s.id
ORDER BY calls DESC
LIMIT 20;

-- Files that depend on a module
SELECT from_path
FROM file_edges
WHERE to_path = 'src/auth.ts' AND to_type = 'file';
```

### PR review workflow

`codegraph review` reuses the incremental manifest and produces a JSON bundle optimized for LLM-driven reviews:

```jsonc
{
  "schemaVersion": 1,
  "status": "ok",
  "summary": {
    "filesChanged": 3,
    "symbolsChanged": 12,
    "candidateTests": 5
  },
  "riskSummary": {
    "level": "medium",
    "score": 60,
    "signals": ["exported-symbols-changed"]
  },
  "reviewTasks": [
    {
      "id": "review-summary",
      "title": "Review changed symbols",
      "description": "Scan the changed symbols and confirm behavioral changes align with intent.",
      "priority": "medium",
      "reason": "baseline-review"
    }
  ],
  "changedFiles": [
    {
      "file": "src/foo.ts",
      "status": "updated",
      "symbols": [
        {
          "name": "doThing",
          "kind": "function",
          "exported": true,
          "definitionSnippet": "export function doThing() {\\n  ...\\n}",
          "diffSnippets": [
            "export function doThing() {\\n  return updatedValue;\\n}"
          ],
          "callsites": [
            { "file": "src/bar.ts", "range": { "start": { "line": 10, "column": 3 }, "end": { "line": 10, "column": 10 } } }
          ]
        }
      ]
    }
  ],
  "graphDelta": [
    { "from": "src/foo.ts", "to": { "type": "file", "path": "src/bar.ts" }, "raw": "./bar" }
  ],
  "candidateTests": [
    { "file": "tests/foo.test.ts", "confidence": "high", "reason": "importsChanged" }
  ]
}
```

Feed this JSON directly to an agent (or your own scripts) to highlight symbol-level changes, updated dependency edges, and likely regression tests.

`schemaVersion` identifies the review JSON schema for CI validation and compatibility checks.

`riskSummary` and `reviewTasks` provide agent-ready guidance on review focus areas and likely risk hotspots.

Graph delta exports (`graph-delta`) report file-level edge additions/removals for changed files and are intended for lightweight CI artifacts.

Use `--include-symbol-details` to attach definition snippets and callsite ranges for changed symbols. When diff data is available (from Git or `diffText`), review reports focus on symbols touched by diff hunks and include `diffSnippets` with the changed line context. Tune `--max-callsites` to keep the payload bounded.

`--review-depth minimal|standard|deep` applies preset bundles:

- `minimal`: fast graph, no symbol snippets, `maxCallsites=0`, `maxCandidates=10`
- `standard`: symbol snippets + up to 2 callsites, `maxCandidates=25`
- `deep`: symbol snippets + up to 10 callsites, `maxCandidates=50`

Explicit flags like `--include-symbol-details`, `--max-callsites`, `--max-tests`, or `--fast-graph` override the preset defaults.

For review accuracy, keep full parsing enabled (the default). Only use `--fast-graph` when you are willing to trade off completeness for speed; it can miss edges that full parsing captures.

Use `--incremental-strict` to disable fast graph extraction for changed files while still using incremental file selection. Use `--cache-verify` to validate the manifest before reuse and fall back to a full rebuild if mismatches are detected.

### For Local Development

If you're working on the package itself, use `tsx` to run directly:

```bash
npx tsx src/cli.ts graph
npx tsx src/cli.ts graph --fast-graph
npx tsx src/cli.ts goto <file> <line> <column>
```

### Output formats

* Plain `graph` outputs **file dependency graph only**:

  ```json
  {
    "nodes": ["/abs/path/a.ts", "..."],
    "edges": [
      { "from": "/abs/path/a.ts", "to": { "type": "external", "name": "react" }, "raw": "react" },
      { "from": "/abs/path/a.ts", "to": { "type": "file", "path": "/abs/path/b.ts" }, "raw": "./b" }
    ]
  }
  ```

  - Use `--mermaid` for a Mermaid flowchart, or `--dot` for Graphviz DOT.
  - In DOT output, type-only edges are dotted; external nodes are dashed ellipses.
  - Use `--fast-graph` for faster JS/TS specifier extraction.

  When using `--symbols`:

  - Mermaid/DOT output includes:
    - File nodes and file-to-file edges (dependency graph)
    - Symbol nodes (definitions and import aliases)
    - File-to-symbol containment edges
    - Symbol-to-symbol edges (import alias -> exported definition), labeled by the exported name
  - Use `--symbols-only` to omit file nodes/edges and render only symbols.

  When using `--symbols-detailed`:

  - Adds symbol -> symbol edges labeled `uses` when a symbol’s body references another symbol (via local references, named/default imports, and namespace members).
  - Can be combined with `--symbols` to include both usage edges and import edges alongside file nodes.
  - Pruning options for large repos:
    - `--symbols-detailed-scope {all|imported}`
    - `--symbols-detailed-max-edges N`
    - `--symbols-detailed-members-only`

- Compact JSON output:
  - Use `--compact-json` to replace repeated file and symbol IDs with numeric indices.
  - Example:
    ```bash
    npx codegraph graph --root . ./src --symbols-detailed --compact-json > graph.json
    ```
  - Shape (simplified):
    ```json
    {
      "files": ["/abs/path/a.ts", "..."],
      "fileEdges": [{ "from": 0, "to": { "type": "file", "path": 1 }, "raw": "./b" }],
      "symbols": [{ "id": 0, "file": 0, "name": "foo", "kind": "function" }],
      "symbolEdges": [{ "from": 0, "to": 1, "label": "uses" }],
      "symbolIdIndex": ["/abs/path/a.ts::foo::123", "..."]
    }
    ```

### Sigma.js graph viewer (web)

Use the Sigma-based viewer to interactively explore `graph --json` or `graph --compact-json` output:

```bash
# 1) Produce graph data
npx codegraph graph --root . ./src --compact-json > codegraph.json

# 2) Serve the repo root and open the viewer
python3 -m http.server 4173
# open http://localhost:4173/docs/graph-visualization/

# optional (requires `http-server` installed):
npm run visualizer:start
```

Viewer features:
- Renders file dependency graphs with Sigma.js.
- Supports both default JSON and compact JSON graph payloads.
- Optional symbol node rendering for compact JSON payloads.

---

## Performance

- Quick start (large monorepos):
  - Graph only: `codegraph graph --fast-graph --threads 8 --mermaid > graph.mmd`
  - Full index: `codegraph index --threads 8 --cache disk`
  - Detailed symbols (pruned): `codegraph graph --root . ./src --symbols-detailed --symbols-detailed-scope imported --symbols-detailed-members-only --symbols-detailed-max-edges 5000 --mermaid > graph.symbols.pruned.mmd`

- Fast graph:
  - Regex-based specifier extraction for JS/TS only. Accurate for common patterns (`import`, `export ... from`, `require()`, `import()`), ignores commented imports.
  - If output looks off, re-run without `--fast-graph`.
  - Programmatic: set `graph.fastRegexDisabledLanguages` to opt specific languages out of regex fast paths.

- Caching:
  - Modes: `off` (default), `memory` (per-process), `disk` (persist across runs, stored under `.codegraph-cache/index-v1`).
  - **Content-hash caching** (default): Parsed-module cache keys use content SHA1 for reliability. Set `cacheStrict: false` to use mtime+size for manifest signatures (faster but less reliable with git operations).
  - Per-file parsed caches are versioned; version mismatches trigger a rebuild of that file’s cached outputs.
  - **Bloom filters** (default): Automatically built during indexing for 2-3x faster reference scanning. Disable with `useBloomFilters: false` if needed.
  - `.codegraph-cache/index-v1/manifest.json` stores the last indexed commit, graph options, and per-file signatures plus resolved edges. When you re-run `codegraph index` with the same options, unchanged files reuse the manifest entries and skip dependency extraction entirely.
  - Incremental runs treat the manifest as a cached base graph: unchanged files keep their edges, while changed files are re-parsed and their edges replaced. When no explicit Git range is provided, the manifest `lastCommit` is compared to `HEAD` to decide which files to refresh.
  - Remove the manifest (or rerun with different graph flags) to force a full graph rebuild.
  - Clear disk cache: delete `.codegraph-cache/index-v1`.

- Threads:
  - Use `--threads` to increase concurrency; typical sweet spot is CPU cores or cores*2.
  - Very high values may become I/O bound; 8–32 is a good range on SSDs.

- Native Tree-sitter acceleration:
  - Build the optional Rust addon with `npm run build:native`.
  - When the addon is present, Codegraph runs supported Tree-sitter parse/query work in Rust and falls back to the JS path automatically if the addon or a query is unavailable.

- Monorepo resolution:
  - Workspace detection precedence: `package.json` workspaces > `pnpm-workspace.yaml` > `lerna.json`.
  - `pnpm-workspace.yaml` supports `packages:` include globs and `!` exclude globs.
  - Resolution precedence for bare specifiers:
    - TypeScript `paths`/`baseUrl` (nearest `tsconfig.json`)
    - Workspace packages (npm/yarn/pnpm/lerna)
    - `node_modules` (only when `--resolve-node-modules` is enabled)
  - Package subpaths are resolved via `exports` / `main` heuristics.

- Troubleshooting:
  - Missing edges in JS/TS graph: disable `--fast-graph`.
  - Dynamic JS/TS specifiers (e.g. `require(path.join(__dirname, ...))`) or bare imports from custom roots:
    use `--dynamic-import-heuristics` and/or `--resolution-hint <dir>`. These heuristics can
    introduce false positives or resolve to unexpected files, so enable them only when needed.
  - Stale results: use `--cache-strict` or clear `.codegraph-cache`.
  - Windows path separators: outputs normalize to `/` where relevant.

---

## Programmatic usage (from code)

Minimal TypeScript/ESM examples. Import only from `@lzehrung/codegraph` and call the API directly.

The library automatically uses the native Tree-sitter path when `@lzehrung/codegraph-native` is installed for the current platform. There is no second import, feature flag, or alternate API surface for the native path.

```ts
import { buildProjectIndex } from "@lzehrung/codegraph";

const index = await buildProjectIndex(process.cwd());
```

### Session Management (Recommended for Agents)

For agents performing code reviews or making multiple queries, use sessions to maintain warm caches:

```ts
import { createCodeReviewSession } from '@lzehrung/codegraph';

// Create a session for a PR review
const session = await createCodeReviewSession({
  root: '/path/to/repo',
  buildOptions: {
    cache: 'disk',
    useBloomFilters: true, // Default: faster reference scanning
  },
  timeout: 30 * 60 * 1000, // 30 minutes
});

// All operations share the same warm index
const impact = await session.analyzeImpact({
  provider: 'git',
  base: 'main',
  head: 'feature-branch',
});

const refs = await session.findReferences({
  file: '/path/to/file.ts',
  line: 10,
  column: 5,
});

const def = await session.goToDefinition({
  file: '/path/to/file.ts',
  line: 15,
  column: 8,
});

// Refresh the index after external changes
await session.refresh();

// Get session statistics
const stats = session.getStats();
console.log(`Files: ${stats.fileCount}, Symbols: ${stats.symbolCount}`);

// Clean up when done
session.dispose();
```

**Using presets for simpler configuration:**

```ts
import { createCodeReviewSession } from '@lzehrung/codegraph';

// Use a preset for automatic configuration
const session = await createCodeReviewSession({
  root: '/path/to/repo',
  preset: 'code-review', // Auto-configures all options
});

// Or combine preset with custom options
const customSession = await createCodeReviewSession({
  root: '/path/to/repo',
  preset: 'ci-fast',
  buildOptions: {
    threads: 16, // Override preset's thread count
  },
});

// Available presets:
// - 'code-review': Balanced speed/accuracy for PR reviews (default: disk cache, content-hash, 8 threads)
// - 'ci-fast': Maximum speed for CI/CD (memory cache, fast mode, 4 threads)
// - 'development': Fast feedback for local dev (memory cache, 8 threads)
// - 'production': Maximum accuracy (disk cache, strict mode, 16 threads)
```

**Managing multiple sessions:**

```ts
import { SessionManager } from '@lzehrung/codegraph';

const manager = new SessionManager();

// Create sessions for different PRs or repos
const pr1Session = await manager.getOrCreateSession('pr-123', {
  root: '/path/to/repo',
});

const pr2Session = await manager.getOrCreateSession('pr-456', {
  root: '/path/to/repo',
});

// Sessions are automatically reused if already initialized
const sameSession = await manager.getOrCreateSession('pr-123', {
  root: '/path/to/repo',
});
// pr1Session === sameSession

// Clean up expired sessions
manager.cleanupExpired();

// Get statistics for all sessions
const allStats = manager.getAllStats();
```

### Streaming API (Better Agent UX)

Stream impact analysis results as they're discovered, allowing agents to start reasoning immediately:

```ts
import { buildProjectIndex, analyzeImpactStreaming } from '@lzehrung/codegraph';

const root = process.cwd();
const index = await buildProjectIndex(root);

// Stream results
for await (const chunk of analyzeImpactStreaming(root, index, {
  provider: 'git',
  base: 'main',
  head: 'feature-branch',
})) {
  if (chunk.type === 'progress') {
    console.log(`${chunk.message}: ${chunk.current}/${chunk.total}`);
  } else if (chunk.type === 'changedSymbol') {
    console.log(`Changed: ${chunk.symbol.name} in ${chunk.symbol.file}`);
    // Start reasoning about this symbol immediately
  } else if (chunk.type === 'impactItem') {
    console.log(`Impacted: ${chunk.item.file} (severity: ${chunk.item.severity})`);
    // Process impact as it arrives
  } else if (chunk.type === 'complete') {
    console.log(`Analysis complete: ${chunk.summary.totalImpacted} files impacted`);
  } else if (chunk.type === 'error') {
    console.error(`Error: ${chunk.error}`);
  }
}
```

**Using streaming with sessions:**

```ts
const session = await createCodeReviewSession({ root: '/path/to/repo' });

for await (const chunk of session.analyzeImpactStream({
  provider: 'git',
  base: 'main',
  head: 'feature-branch',
})) {
  // Process chunks as they arrive
  if (chunk.type === 'impactItem') {
    // Agent can start analyzing this file immediately
    await analyzeImpactedFile(chunk.item);
  }
}
```

### Partial Results for Reliability

Operations return partial results when some items fail, allowing agents to work with incomplete data:

```ts
import { withPartialResults, summarizePartialResult } from '@lzehrung/codegraph';

// Process files with automatic error handling
const files = ['file1.ts', 'file2.ts', 'file3.ts'];
const result = await withPartialResults(files, async (file) => {
  // Process file (may throw)
  return await analyzeFile(file);
}, {
  continueOnError: true, // Keep going even if some fail
  concurrency: 8,
});

// Check result status
if (result.status === 'complete') {
  console.log('✓ All files processed successfully');
} else if (result.status === 'partial') {
  console.log(`⚠ Partial success: ${result.coverage * 100}% complete`);
  console.log(`Succeeded: ${result.metadata?.succeeded}, Failed: ${result.metadata?.failed}`);

  // Still use partial data
  processResults(result.data);

  // Log errors for debugging
  for (const error of result.errors) {
    console.error(`${error.target}: ${error.message}`);
  }
} else {
  console.error('✗ Operation failed completely');
}

// Get a human-readable summary
console.log(summarizePartialResult(result));
```

### Basic Index Building

Build full project index and go to definition:

```ts
import { buildProjectIndex, goToDefinition } from '@lzehrung/codegraph';

const root = process.cwd();
const index = await buildProjectIndex(root);

const file = `${root}/tests/samples/monorepo/packages/pkg-b/src/index.js`.replace(/\\/g, '/');
const res = await goToDefinition(index, { file, line: 21, column: 18 });
if (res.status === 'ok') {
  console.log('Def:', res.definition.file, res.definition.localName, res.definition.range);
}
```

### Incremental indexing

```ts
import { buildProjectIndexIncremental } from '@lzehrung/codegraph';

const root = process.cwd();
const incremental = await buildProjectIndexIncremental(root, {
  gitBase: 'origin/main',
  gitHead: 'HEAD',
});
```

`buildProjectIndexIncremental` loads the cached manifest, reuses unchanged modules/edges, and only reparses the files reported as changed (via Git flags or an explicit `files` list). The manifest is rewritten after each run so repeated PR reviews stay incremental.

`changedSince` follows `git diff <rev>` semantics (that revision compared to the current working tree and index), while `gitBase`/`gitHead` use an explicit commit range (`<base>..<head>`).

### Agent query helpers (symbol graph)

Symbol query syntax is a compact `key:value` format with optional free-text:

```
kind:function name:handler file:src/api
docstring:"rate limit" auth
```

Supported keys:
- `kind` or `kinds` (comma-separated)
- `name`
- `file`
- `doc` or `docstring`

Programmatic helpers:

```ts
import { querySymbols, querySymbolNeighbors } from '@lzehrung/codegraph';

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
```

### High-level Agent Tools

These functions are designed to be imported and used directly by agent codebases to explore the codebase and discover symbols.

```ts
import {
  tool_getFileOverview,
  tool_findSymbol,
  tool_impactJSON
} from '@lzehrung/codegraph';

// 1. Get a Markdown summary of a file (Imports, Definitions with signatures/docstrings)
// Useful for "reading" a file's structure before deciding to read the full content.
const overview = await tool_getFileOverview(process.cwd(), 'src/utils.ts');
console.log(overview);
// Output:
// # Overview of src/utils.ts
// ## Imports
// Imported symbols: fs, path
// ## Definitions
// ### function `readFile` (line 10)
// > Reads a file safely...

// 2. Find symbols by name (fuzzy search)
// Useful for locating relevant code when the file path is unknown.
const matches = await tool_findSymbol(process.cwd(), 'collectGraph');
console.log(matches);
// Output:
// [{ name: 'collectGraph', kind: 'function', file: 'src/graphs.ts', line: 150 }, ...]

// 3. Analyze PR impact programmatically
// Returns a JSON report suitable for LLM consumption.
const impact = await tool_impactJSON(process.cwd(), {
  provider: 'git',
  base: 'main',
  head: 'feature-branch'
});
if (impact.status === 'ok') {
  console.log('Impacted files:', impact.report.impacted.map(i => i.file));
}
```

### Raw SQL from code (advanced)

```ts
import { queryGraphSqliteRaw } from '@lzehrung/codegraph';

const result = await queryGraphSqliteRaw('./codegraph.sqlite', `
  SELECT name, file FROM symbols WHERE kind = 'class' LIMIT 10;
`);
console.log(result.columns, result.rows);
```

Find references:

```ts
import { findReferences } from '@lzehrung/codegraph';

const refs = await findReferences(index, { file, line: 21, column: 18 });
if (refs.status === 'ok') {
  console.log('Refs:', refs.references.map(r => `${r.file}:${r.range.start.line}:${r.range.start.column}`));
}
```

Get dependency graph in-memory and iterate edges:

`listProjectFiles` defaults to source files plus common project manifests and lockfiles across supported languages (for example `package.json`, `requirements.txt`, `pyproject.toml`, and `Cargo.toml`). Pass custom glob patterns if you need different coverage.

```ts
import { listProjectFiles } from '@lzehrung/codegraph';

const files = await listProjectFiles(root);
const manifests = files.filter((file) => /(?:package\.json|pyproject\.toml|Cargo\.toml)$/.test(file));
console.log(manifests);
```

Discover project files with metadata (type, role, project root, optional name):

```ts
import { discoverProjectFiles } from '@lzehrung/codegraph';

const projectFiles = await discoverProjectFiles(root);
const named = projectFiles.filter((file) => file.name);
console.log(named);
```

```ts
import { listProjectFiles, collectGraph } from '@lzehrung/codegraph';

const files = await listProjectFiles(root);
const graph = await collectGraph(root, files);

type EdgeTo = { type: 'file'; path: string } | { type: 'external'; name: string };
const toRef = (t: EdgeTo) => (t.type === 'file' ? t.path : t.name);

for (const e of graph.edges) {
  console.log(`${e.from} -> ${toRef(e.to)}  (${e.raw})`);
}
```

Build project index from explicit file list (multi-root):

```ts
import { listProjectFiles, buildProjectIndexFromFiles } from '@lzehrung/codegraph';

const tsRoot = `${root}/tests/samples/typescript`;
const jsRoot = `${root}/tests/samples/javascript`;
const files = [
  ...(await listProjectFiles(tsRoot)),
  ...(await listProjectFiles(jsRoot)),
];

const index = await buildProjectIndexFromFiles(root, Array.from(new Set(files)));
console.log({ files: index.byFile.size, edges: index.graph.edges.length });
```

Produce a Mermaid diagram string (for UI or chat rendering):

```ts
import { graphToMermaid } from '@lzehrung/codegraph';

const mermaid = graphToMermaid(graph);
console.log(mermaid);
```

Simple wrappers as "LLM tools" (no HTTP/MCP), returning JSONable payloads:

```ts
import { listProjectFiles, collectGraph, buildProjectIndex, goToDefinition, findReferences } from '@lzehrung/codegraph';

export async function tool_graphJSON(root: string) {
  const files = await listProjectFiles(root);
  const g = await collectGraph(root, files);
  return { nodes: [...g.nodes], edges: g.edges };
}

export async function tool_goto(root: string, file: string, line: number, column: number) {
  const index = await buildProjectIndex(root);
  return await goToDefinition(index, { file: file.replace(/\\/g, '/'), line, column });
}

export async function tool_refs(root: string, file: string, line: number, column: number) {
  const index = await buildProjectIndex(root);
  return await findReferences(index, { file: file.replace(/\\/g, '/'), line, column });
}
```

### Agent-friendly symbol handles (no line/column)

Use stable handles instead of cursor positions. A handle is either:
- `${file}::${localName}::${startIndex}` for a definition, or
- `${file}::${alias}::import` for an import alias (named/default/namespace).

```ts
import {
  buildProjectIndex,
  listSymbols,
  goToDefinitionById,
  findReferencesById,
  symbolId,
} from '@lzehrung/codegraph';

const root = process.cwd();
const index = await buildProjectIndex(root);

// Enumerate symbols in a file, including import aliases
const file = `${root}/tests/samples/monorepo/packages/pkg-b/src/index.js`.replace(/\\/g, '/');
const items = listSymbols(index, { file, includeImports: true });
// Items include: { id, file, name, kind, range, docstring }

// Pick a handle (e.g., for alias "aHelper" or a local def)
const handle = items.find(i => i.name === 'aHelper')?.id!;

// Go to definition from the handle
const defRes = await goToDefinitionById(index, handle);

// Find references from the handle
const refsRes = await findReferencesById(index, handle);

// If you already have a SymbolDef, create a handle directly
// const id = symbolId(def);
```

Analyze PR impact from git diff:

```ts
import { buildProjectIndex, analyzeImpactFromDiff } from '@lzehrung/codegraph';

const root = process.cwd();
const index = await buildProjectIndex(root);

// Analyze impact from git commits
const report = await analyzeImpactFromDiff(root, index, {
  provider: 'git',
  base: 'main',
  head: 'feature-branch',
  ignoreGlobs: ['**/package-lock.json']
});

if (report.warning) {
  console.warn(`⚠️ Impact Warning: ${report.warning}`);
}

console.log(`Changed symbols: ${report.changedSymbols.length}`);
console.log(`Impacted files: ${report.impacted.length}`);
for (const item of report.impacted.slice(0, 5)) {
  console.log(`${item.file}: ${item.symbols.join(', ')} (${(item.severity * 100).toFixed(1)}% severity)`);
  // Access reference contexts if requested
  if (item.refs) {
    for (const ref of item.refs.slice(0, 2)) {
      console.log(`  Reference at ${ref.range.start.line}:${ref.range.start.column}:`);
      console.log(`    ${ref.context}`);
    }
  }
}
```

Analyze PR impact with reference contexts:

```ts
// Include line context snippets for references
const reportWithLineContext = await analyzeImpactFromDiff(root, index, {
  provider: 'git',
  base: 'main',
  head: 'feature-branch',
  refContext: 'line',  // Include ±5 lines around each reference
  refContextLines: 3    // Override default of 5 lines
});

// Include block context snippets for references
const reportWithBlockContext = await analyzeImpactFromDiff(root, index, {
  provider: 'git',
  base: 'main',
  head: 'feature-branch',
  refContext: 'block',      // Include enclosing function/class
  refBlockMaxLines: 30      // Limit to 30 lines (default: 60)
});
```

Agent-friendly tool wrapper (returns JSON-serializable results):

```ts
import { tool_impactJSON, tool_impactFromDiffText } from '@lzehrung/codegraph';

// Direct API call
const result = await tool_impactJSON(root, {
  provider: 'raw',
  diffText: `diff --git a/utils.ts b/utils.ts\n...`
});

if (result.status === 'ok') {
  // Use result.report for analysis
  console.log(result.report);
}
```

### Backend-Focused Agent Recipes

For backend development teams, here are common patterns for LLM agents reviewing PRs:

#### 1. **API Route Impact Assessment**
```ts
import { analyzeImpactFromDiff, collectImpactContext, listCandidateTestFiles } from '@lzehrung/codegraph';

const root = process.cwd();
const index = await buildProjectIndex(root);

// Get impact report with enhanced context
const impact = await analyzeImpactFromDiff(root, index, {
  provider: 'git',
  base: 'main',
  head: 'feature-branch',
  depth: 2,  // Include transitive dependencies
  compact: true  // Use compact format for efficiency
});

// Focus on API routes and controllers
const apiRoutes = impact.impacted.filter(item =>
  item.file.includes('routes') ||
  item.file.includes('controllers') ||
  item.file.includes('api')
);

// Check for breaking changes
const breakingChanges = impact.changedSymbols.filter(symbol =>
  symbol.exported && symbol.explain?.hints?.includes('signatureChanged')
);

console.log(`API routes impacted: ${apiRoutes.length}`);
console.log(`Breaking changes: ${breakingChanges.length}`);
```

#### 2. **Database Schema Impact Analysis**
```ts
// Analyze schema/model changes
const schemaChanges = impact.changedSymbols.filter(symbol =>
  symbol.file.includes('models') ||
  symbol.file.includes('schema') ||
  symbol.file.includes('migrations')
);

// Get broader context for schema changes
if (schemaChanges.length > 0) {
  const context = await collectImpactContext(
    index,
    impact.impacted.map(i => i.file),
    impact.changedSymbols.map(s => s.id),
    3  // 3-hop context for data layer changes
  );

  // Find services that might need migration logic
  const affectedServices = context.symbolNeighbors.filter(n =>
    n.file.includes('services') || n.file.includes('repositories')
  );

  console.log(`Services needing migration review: ${affectedServices.length}`);
}
```

#### 3. **Test Coverage Validation**
```ts
// Find candidate tests that might need updates
const candidateTests = listCandidateTestFiles(
  index,
  impact.changedFiles.map(f => f.file),
  impact.changedSymbols.map(s => s.id),
  {
    testPatterns: ['test', 'spec', '__tests__', '.test.'],  // Custom patterns
    maxCandidates: 20
  }
);

// Prioritize high-confidence test candidates
const highPriorityTests = candidateTests.filter(t => t.confidence === 'high');
const mediumPriorityTests = candidateTests.filter(t => t.confidence === 'medium');

console.log(`High-priority tests to review: ${highPriorityTests.length}`);
console.log(`Medium-priority tests to check: ${mediumPriorityTests.length}`);
```

#### 4. **Security-Focused Review**
```ts
import { textGrep } from '@lzehrung/codegraph';

// Scan changed files for security patterns
const securityPatterns = [
  'exec\\(|eval\\(|spawn\\(',  // Command execution
  'password|secret|key.*=',   // Credential storage
  'sql.*\\+|\\$\\{.*\\}',      // SQL injection risks
  'innerHTML|outerHTML',      // XSS risks
];

const securityFindings: Array<{file: string, pattern: string, line: number}> = [];

for (const changedFile of impact.changedFiles) {
  for (const pattern of securityPatterns) {
    try {
      const matches = await textGrep(root, pattern, [changedFile.file], { maxHits: 200 });
      for (const match of matches) {
        securityFindings.push({
          file: match.file,
          pattern,
          line: match.line
        });
      }
    } catch (e) {
      // Pattern might not be a valid regex, skip
    }
  }
}

if (securityFindings.length > 0) {
  console.log(`⚠️ Security findings: ${securityFindings.length}`);
  // Flag for human security review
}
```

#### 5. **Configuration and Environment Impact**
```ts
// Check for configuration changes
const configChanges = impact.impacted.filter(item =>
  item.file.includes('config') ||
  item.file.includes('env') ||
  item.file.includes('settings')
);

// Validate environment variable usage
const envUsage = impact.changedSymbols.filter(symbol =>
  symbol.name.toLowerCase().includes('env') ||
  symbol.name.toLowerCase().includes('config')
);

if (configChanges.length > 0 || envUsage.length > 0) {
  console.log(`⚠️ Configuration changes detected - validate deployment impact`);
}
```

#### 6. **Performance Regression Detection**
```ts
// Look for algorithm changes in performance-critical code
const performanceCritical = impact.changedSymbols.filter(symbol =>
  symbol.file.includes('utils') ||
  symbol.file.includes('algorithms') ||
  symbol.kind === 'function' && symbol.explain?.hints?.includes('signatureChanged')
);

// Check for new database queries
const queryPatterns = [
  'SELECT|INSERT|UPDATE|DELETE',  // SQL queries
  'find\\(|findOne\\(|aggregate\\(', // MongoDB queries
  'query\\(|execute\\('              // General query patterns
];

for (const pattern of queryPatterns) {
  const matches = await textGrep(root, pattern, undefined, { maxHits: 1, ignoreCase: true });
  if (matches.length > 0) {
    console.log(`Database queries modified - review performance impact`);
    break;
  }
}
```

These recipes combine the library's core capabilities (dependency graphs, symbol navigation, AST queries) with domain-specific logic to provide comprehensive PR review assistance for backend systems.

---

## How it works (high level)

1. **Language adapters** expose:

   * file extensions,
   * Tree-sitter grammar,
   * a few node-type helpers,
   * 4 small **queries** (imports, exports, locals, importBindings),
   * definition classification and scope behavior.

2. **Indexing**

   * TypeScript owns the shared indexing pipeline, resolution logic, and output shapes.
   * The parser/query hot path stays on Tree-sitter for every supported language.
   * When available, the optional Rust addon runs those Tree-sitter parses and queries natively, then returns plain capture data to TypeScript.

3. **Graph**

   * For each file, collect module specifiers and resolve:

     * path-like specifiers -> best-effort file resolution (JS/TS).
     * otherwise, **external** nodes.

4. **Navigation**

   * **goToDefinition** checks local scope first, then imported bindings; understands `ns.member` for namespace imports.
   * **findReferences** builds per-file scope (module -> function -> block), seeds imports as bindings, and records occurrences. It also resolves through imports and namespace members.

5. **AST grep**

   * Runs any Tree-sitter query across matched files and prints hits as `file:line:col: @capture: snippet`.

---

## Extending to other languages

We use a **unified language definition** system that powers both the dependency graph and semantic chunking.

To add a new language (e.g., Go):

1.  **Create a definition file**:
    *   Add `src/languages/definitions/go.ts`.
    *   Implement the `LanguageDefinition` interface (grammar, extensions, structure, graph queries).
    *   This single definition auto-generates the Tree-sitter queries for chunking.

2.  **Register the language**:
    *   Add it to `src/languages.ts` (for the graph).
    *   Add it to `src/bootstrap/treeSitterLanguages.ts` (for chunking).

3.  **Add tests**:
    *   Add a sample file: `tests/languages/samples/go.sample.go`.
    *   Add a test definition: `tests/languages/go.test.ts`.

You can keep it **80/20** first; the core system degrades gracefully (unresolvable edges become `external`).

---

## Unit testing

The core is intentionally **pure** and **test-friendly**:

* `collectLocalsAndExportsFromSource(file, source, support, lang)`
* `collectModuleSpecifiersFromSource(support, lang, source)`
* `buildScopeIndexFromSource(file, source, support, lang, imports)`
* `resolveExport(index, file, exportedName)`
* `goToDefinition(index, req)`
* `findReferences(index, req)`

Strategy:

* Feed **inline strings** as source and assert on returned JSONable structures.
* For end-to-end tests, create a small temp directory with a few files and run the CLI with `tsx`.

---

## FAQ

**Q: Can I drop this into a mixed repo (multiple Node/Python projects)?**
Yes. It walks the tree, ignores `node_modules`, virtualenv caches, builds a **single** repo-wide graph, and marks unknown modules as **external**.

**Q: Does it follow re-exports for definition jumps?**
Yes, for JS/TS. `resolveExport` recursively follows `export * from` and `export { name } from`.

**Q: How "accurate" is find-references?**
It uses a **lexical scope index** (module → function → block) and recorded bindings. It's resilient for common patterns and avoids many false positives, but avoids heavy type-checking: perfect for an agent loop foundation.

**Q: Does it support CommonJS destructuring?**
Yes. Both `const { helperFunction } = require('./module')` and `const { helperFunction: alias } = require('./module')` are fully supported.

**Q: Does it work with monorepos?**
Yes. It detects npm/yarn/pnpm/lerna workspaces and resolves package-relative imports correctly.

---

## Contributing & Releases

The old release ergonomics are back. Use the root scripts to cut synchronized releases for both the JS package and the optional native package:

```bash
# Version, test, build, commit, tag, and push
npm run release:patch
npm run release:minor
npm run release:major

# Same flow, plus stage/publish the local native target, publish the native meta package, and publish the root package
npm run publish:patch
npm run publish:minor
npm run publish:major
```

The release scripts:
- Keep `@lzehrung/codegraph` and `@lzehrung/codegraph-native` on the same version
- Run tests plus JS/native builds before tagging
- Keep staged native metadata as publish-time state instead of committed source state
- Stage the current platform's native package automatically for local publish flows
- Create the git commit and tag, then push both

For multi-platform releases, stage additional native target artifacts before publish. See [PUBLISHING.md](./PUBLISHING.md) for the detailed release flow.
