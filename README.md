# Dep Graph & Symbols

A tiny tool to **understand a repo**, **navigate code**, and **answer questions** fast.

It builds:

* a **module dependency graph** (imports / re-exports / `require()` / dynamic `import()`),
* a per-file **symbol index** (locals + exports),
* **go to definition** and **find references**,
* plus a minimal **AST grep** (Tree-sitter query runner).

It’s deliberately **elegant**, **robust**, and **easy to extend** to new grammars.

Sample graph: [sample-graph.md](./sample-graph.md)

---

## Features

* **Dependency graph**
  * JS/TS: `import`, `export ... from`, `export * from`, `require()`, `import()`, CommonJS destructuring
  * Python: `import`, `from ... import`, relative imports with package resolution
  * Unresolved targets are represented as **external** nodes
* **Symbol index**
  * Extracts functions, classes, variables, interfaces, types, and exports
  * Cross-language scope indexing with proper import binding resolution
* **Go to definition**
  * Cross-file navigation for all supported languages
  * TS/JS: Re-exports, namespace imports, CommonJS destructuring
  * Python: Module imports, `__all__` exports, relative imports
* **Find references**
  * Project-wide scanning with lexical scope awareness
  * TS/JS: Namespace members, re-exports, CommonJS patterns
  * Python: Module imports, `__all__` exports, relative imports
* **AST grep**
  * Run arbitrary Tree-sitter queries across the repo
* **Monorepo support**
  * Workspace detection (npm/yarn/pnpm/lerna)
  * Per-file TypeScript config resolution
  * Package-relative import resolution

> **Cross-language parity**: All supported languages (TS/JS/Python) provide equivalent go-to-definition and find-references capabilities with full cross-file symbol navigation.

---

## Supported languages

* **JavaScript / TypeScript** (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`)
* **Python** (`.py`)

Both languages support full cross-file navigation with equivalent capabilities.

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
# Build a dependency graph (prints nodes + edges as JSON)
npx codegraph graph

# Build a dependency graph from multiple roots
npx codegraph graph ./src ./packages/app ./packages/lib --mermaid > graph.mmd

# Build a dependency graph in Mermaid format
npx codegraph graph --mermaid > graph.mmd
# Fast graph-only mode (JS/TS specifiers via regex, skips parsing for specifiers)
npx codegraph graph --mermaid --fast-graph > graph.fast.mmd

# Include symbol-level nodes/edges (imports/exports) combined with file graph
npx codegraph graph ./src --mermaid --symbols > graph.symbols.mmd
# Symbols only (no file nodes/edges)
npx codegraph graph ./src --mermaid --symbols-only > graph.symbols.only.mmd
# Detailed symbol usage graph (adds symbol -> symbol "uses" edges)
npx codegraph graph ./src --mermaid --symbols-detailed > graph.symbols.detailed.mmd
# Detailed + files hybrid
npx codegraph graph ./src --mermaid --symbols --symbols-detailed > graph.symbols.hybrid.detailed.mmd
# Pruned detailed graph for very large repos
npx codegraph graph ./src --mermaid --symbols-detailed \
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

# Go to definition of symbol at file:line:column
npx codegraph goto <file> <line> <column>

# Find references of symbol at a location
npx codegraph refs --file <file> --line <line> --col <column>
# Pretty-print only the file:line:col
npx codegraph refs --file <file> --line <line> --col <column> --pretty

# Run a Tree-sitter query across the repo
npx codegraph grep --query '(function_declaration name: (identifier) @name)'
```

### For Local Development

If you're working on the package itself, use `tsx` to run directly:

```bash
npx tsx src/cli.ts graph
npx tsx src/cli.ts graph --fast-graph
npx tsx src/cli.ts goto <file> <line> <column>
```

### Output formats

* `graph` prints JSON by default:

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
    npx codegraph graph ./src --symbols-detailed --compact-json > graph.json
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
  - Detailed symbols (pruned): `codegraph graph ./src --symbols-detailed --symbols-detailed-scope imported --symbols-detailed-members-only --symbols-detailed-max-edges 5000 --mermaid > graph.symbols.pruned.mmd`

- Fast graph:
  - Regex-based specifier extraction for JS/TS only. Accurate for common patterns (`import`, `export ... from`, `require()`, `import()`), ignores commented imports.
  - If output looks off, re-run without `--fast-graph`.

- Caching:
  - Modes: `off` (default), `memory` (per-process), `disk` (persist across runs, stored under `.codegraph-cache/index-v1`).
  - `--cache-strict` uses a content hash; without it, cache key uses mtime+size.
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

Add a new `LanguageSupport` entry:

* Provide the grammar (e.g., `tree-sitter-ruby`) and file extensions.
* Fill **queries**:

  * `imports`: enough to discover module specifiers for edges.
  * `locals`: function/class/var definitions for symbol index.
  * `exports`: whatever the language uses (if any).
  * `importBindings`: captures to seed the module scope (default/named/namespace-like).
* Implement `classifyDefinition`, `isDeclarationName`, and simple scope rules.

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

## Roadmap

* **More grammars**: Ruby, C#, Rust, Java, Go…
  * The adapter API is stable enough to add these incrementally

### Recently completed

* ✅ **Python cross-file symbol navigation** - Full go-to-definition and find-references with module resolution, package anchors, and `__all__` exports
* ✅ **CommonJS destructuring support** - `const { helperFunction: alias } = require('./module')`
* ✅ **Monorepo workspace detection** - npm/yarn/pnpm/lerna workspace support with per-file TypeScript config resolution
* ✅ **Cross-language parity** - Equivalent capabilities across TS/JS and Python

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