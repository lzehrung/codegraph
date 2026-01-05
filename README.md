# codegraph

A tiny tool to **understand a repo**, **navigate code**, and **answer questions** fast. It supports JavaScript/TypeScript, Python, Go, Java, C#, Ruby, Rust, and the script blocks inside Vue/Svelte files.

It builds:

* a **module dependency graph** (imports / re-exports / `require()` / dynamic `import()`),
* a per-file **symbol index** (locals + exports),
* **go to definition** and **find references**,
* plus a minimal **AST grep** (Tree-sitter query runner).

It stays small on purpose and is built to be easy to extend to new grammars.

Sample graph: [sample-graph.md](./sample-graph.md)

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
  * Supports incremental updates by re-writing only changed files and symbol edges
* **Dependency Analysis**
  * `deps <file>`: List all dependencies of a file
  * `rdeps <file>`: List all files that depend on a file
  * `path <from> <to>`: Find the shortest dependency path between two files
  * `cycles`: Detect circular dependencies
* **Diagnostics & Reports**
  * `unresolved`: List external/unresolved imports and their importers
  * `hotspots`: Identify files with high complexity (fan-in/fan-out)
  * `apisurface`: Summarize public API (exported symbols) across the repo
* **PR impact analysis**
  * Map git diffs to changed symbols and affected code
  * Analyze direct and transitive dependencies with severity scoring
  * Git/GitHub integration with configurable depth and scope
* **Monorepo support**
  * Workspace detection (npm/yarn/pnpm/lerna)
  * Per-file TypeScript config resolution
  * Package-relative import resolution
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
* **Vue / Svelte SFCs** (`.vue`, `.svelte`) — script blocks are parsed with the JS/TS pipeline, so dependency graphs and go-to-definition work across components.

Each listed language (including Vue/Svelte script sections) has the same dependency-graph, go-to-definition, and find-references support.

---

## Semantic Chunking

The library provides semantic code chunking utilities for preparing codebases for LLM processing and vector embeddings. It uses Tree-sitter to split code into meaningful units while respecting token budgets.

### Supported Languages & Formats

* **Code files**: JavaScript, TypeScript, TSX, Python
* **Text files**: JSON, YAML, configuration files, documentation
* **Single File Components**: Vue (`.vue`) and Svelte (`.svelte`) files are split into their `<template>`, `<script>`, and `<style>` regions, then chunked with the appropriate HTML/JS/TS/CSS grammars. Each block falls back to token-based chunking if semantic parsing fails, so hybrid files always produce chunks.

### APIs

```ts
import { chunkFile, chunkTextFile, LANG_CONFIGS } from 'codegraph';

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

### Option 1: Install from GitHub (Recommended)

Install directly from the GitHub repository:

```bash
# Install the latest from main branch
npm install github:lzehrung/codegraph

# Or pin to a specific version tag
npm install github:lzehrung/codegraph#v1.0.0

# Or pin to a specific commit
npm install github:lzehrung/codegraph#abc1234
```

Add to your `package.json`:

```json
{
  "dependencies": {
    "codegraph": "github:lzehrung/codegraph#v1.0.0"
  }
}
```

### Option 2: Local Development

Clone the repository and install dependencies:

```bash
git clone https://github.com/lzehrung/codegraph.git
cd codegraph
npm install
npm run build
```

---

## Requirements

* **Node.js 18+**
* Dependencies are automatically installed when you install the package

---

## Usage

### CLI Commands

After installing the package, use the `codegraph` CLI:

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
# Skip transitive file dependencies (symbol references only)
npx codegraph impact --base main --head feature --members-only
# Include line context snippets for references (±5 lines by default)
npx codegraph impact --base main --head feature --ref-context line
# Include block context snippets for references (enclosing function/class, max 60 lines)
npx codegraph impact --base main --head feature --ref-context block --ref-block-max-lines 30

# Generate a PR review bundle (incremental graph + symbol summary)
npx codegraph review --base origin/main --head HEAD > review.json
```

Use `--changed-since <ref>` or `--git-base <ref> [--git-head <ref>]` with `graph` and `index`
to limit processing to the files reported by `git diff`. The CLI pipes that list into
`buildProjectIndexFromFiles`, so unchanged files are skipped entirely when you’re
reviewing a PR.

### PR review workflow

`codegraph review` reuses the incremental manifest and produces a JSON bundle optimized for LLM-driven reviews:

```jsonc
{
  "status": "ok",
  "summary": {
    "filesChanged": 3,
    "symbolsChanged": 12,
    "candidateTests": 5
  },
  "changedFiles": [
    {
      "file": "src/foo.ts",
      "status": "updated",
      "symbols": [{ "name": "doThing", "kind": "function", "exported": true }]
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

---

## Performance

- Quick start (large monorepos):
  - Graph only: `codegraph graph --fast-graph --threads 8 --mermaid > graph.mmd`
  - Full index: `codegraph index --threads 8 --cache disk`
  - Detailed symbols (pruned): `codegraph graph --root . ./src --symbols-detailed --symbols-detailed-scope imported --symbols-detailed-members-only --symbols-detailed-max-edges 5000 --mermaid > graph.symbols.pruned.mmd`

- Fast graph:
  - Regex-based specifier extraction for JS/TS only. Accurate for common patterns (`import`, `export ... from`, `require()`, `import()`), ignores commented imports.
  - If output looks off, re-run without `--fast-graph`.

- Caching:
  - Modes: `off` (default), `memory` (per-process), `disk` (persist across runs, stored under `.codegraph-cache/index-v1`).
  - `--cache-strict` uses a content hash; without it, cache key uses mtime+size.
  - `.codegraph-cache/index-v1/manifest.json` stores the last indexed commit, graph options, and per-file signatures plus resolved edges. When you re-run `codegraph index` with the same options, unchanged files reuse the manifest entries and skip dependency extraction entirely.
  - Incremental runs treat the manifest as a cached base graph: unchanged files keep their edges, while changed files are re-parsed and their edges replaced. When no explicit Git range is provided, the manifest `lastCommit` is compared to `HEAD` to decide which files to refresh.
  - Remove the manifest (or rerun with different graph flags) to force a full graph rebuild.
  - Clear disk cache: delete `.codegraph-cache/index-v1`.

- Threads:
  - Use `--threads` to increase concurrency; typical sweet spot is CPU cores or cores*2.
  - Very high values may become I/O bound; 8–32 is a good range on SSDs.

- Monorepo resolution:
  - Workspace detection precedence: `package.json` workspaces > `pnpm-workspace.yaml` > `lerna.json`.
  - Package subpaths are resolved via `exports` / `main` heuristics and TS path mapping per package.

- Troubleshooting:
  - Missing edges in JS/TS graph: disable `--fast-graph`.
  - Stale results: use `--cache-strict` or clear `.codegraph-cache`.
  - Windows path separators: outputs normalize to `/` where relevant.

---

## Programmatic usage (from code)

Minimal TypeScript/ESM examples. Import from the package and call directly.

Build full project index and go to definition:

```ts
import { buildProjectIndex, goToDefinition } from 'codegraph';

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
import { buildProjectIndexIncremental } from 'codegraph';

const root = process.cwd();
const incremental = await buildProjectIndexIncremental(root, {
  gitBase: 'origin/main',
  gitHead: 'HEAD',
});
```

`buildProjectIndexIncremental` loads the cached manifest, reuses unchanged modules/edges, and only reparses the files reported as changed (via Git flags or an explicit `files` list). The manifest is rewritten after each run so repeated PR reviews stay incremental.

Find references:

```ts
import { findReferences } from 'codegraph';

const refs = await findReferences(index, { file, line: 21, column: 18 });
if (refs.status === 'ok') {
  console.log('Refs:', refs.references.map(r => `${r.file}:${r.range.start.line}:${r.range.start.column}`));
}
```

Get dependency graph in-memory and iterate edges:

```ts
import { listProjectFiles, collectGraph } from 'codegraph';
Build project index from explicit file list (multi-root):

```ts
import { listProjectFiles, buildProjectIndexFromFiles } from 'codegraph';

const tsRoot = `${root}/tests/samples/typescript`;
const jsRoot = `${root}/tests/samples/javascript`;
const files = [
  ...(await listProjectFiles(tsRoot)),
  ...(await listProjectFiles(jsRoot)),
];

const index = await buildProjectIndexFromFiles(root, Array.from(new Set(files)));
console.log({ files: index.byFile.size, edges: index.graph.edges.length });
```

const files = await listProjectFiles(root);
const graph = await collectGraph(root, files);

type EdgeTo = { type: 'file'; path: string } | { type: 'external'; name: string };
const toRef = (t: EdgeTo) => (t.type === 'file' ? t.path : t.name);

for (const e of graph.edges) {
  console.log(`${e.from} -> ${toRef(e.to)}  (${e.raw})`);
}
```

Produce a Mermaid diagram string (for UI or chat rendering):

```ts
import { graphToMermaid } from 'codegraph';

const mermaid = graphToMermaid(graph);
console.log(mermaid);
```

Simple wrappers as "LLM tools" (no HTTP/MCP), returning JSONable payloads:

```ts
import { listProjectFiles, collectGraph, buildProjectIndex, goToDefinition, findReferences } from 'codegraph';

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
} from 'codegraph';

const root = process.cwd();
const index = await buildProjectIndex(root);

// Enumerate symbols in a file, including import aliases
const file = `${root}/tests/samples/monorepo/packages/pkg-b/src/index.js`.replace(/\\/g, '/');
const items = listSymbols(index, { file, includeImports: true });

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
import { buildProjectIndex, analyzeImpactFromDiff } from 'codegraph';

const root = process.cwd();
const index = await buildProjectIndex(root);

// Analyze impact from git commits
const report = await analyzeImpactFromDiff(root, index, {
  provider: 'git',
  base: 'main',
  head: 'feature-branch'
});

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
import { tool_impactJSON, tool_impactFromDiffText } from 'codegraph';

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
import { analyzeImpactFromDiff, collectImpactContext, listCandidateTestFiles } from 'codegraph';

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
import { textGrep } from 'codegraph';

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

   * **Locals**: functions/classes/vars/types etc.
   * **Exports**: direct, default, named, re-exports, `export * from`.
   * **Imports**: default/named/namespace and (for TS) import-equals via `require()`.

3. **Graph**

   * For each file, collect module specifiers and resolve:

     * path-like specifiers → best-effort file resolution (JS/TS).
     * otherwise, **external** nodes.

4. **Navigation**

   * **goToDefinition** checks local scope first, then imported bindings; understands `ns.member` for namespace imports.
   * **findReferences** builds per-file scope (module → function → block), seeds imports as bindings, and records occurrences. It also resolves through imports and namespace members.

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

This package uses GitHub-based releases (no npm publish required). To create a new release:

```bash
# Make your changes, commit them, then:
npm run release:patch  # Bug fixes (1.0.0 → 1.0.1)
npm run release:minor  # New features (1.0.0 → 1.1.0)
npm run release:major  # Breaking changes (1.0.0 → 2.0.0)
```

Uses npm's built-in `version` command (zero dependencies):
- Runs tests and builds the package (`preversion` hook)
- Bumps the version in package.json
- Creates a git commit and tag
- Pushes everything to GitHub (`postversion` hook)

See [PUBLISHING.md](./PUBLISHING.md) for detailed instructions.

---
