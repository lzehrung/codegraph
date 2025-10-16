# Dep Graph & Symbols

A tiny, senior-engineer–grade foundation for a **developer agent loop** that can **understand a repo**, **navigate code**, and **answer questions** fast.

It builds:

* a **module dependency graph** (imports / re-exports / `require()` / dynamic `import()`),
* a per-file **symbol index** (locals + exports),
* **go to definition** and **find references**,
* plus a minimal **AST grep** (Tree-sitter query runner).

It’s deliberately **elegant**, **robust**, and **easy to extend** to new grammars.

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

## Requirements

* **Node.js 18+**
* **tree-sitter** and grammars:

  * `tree-sitter`
  * `tree-sitter-typescript`
  * `tree-sitter-javascript`
  * `tree-sitter-python`
* TypeScript is recommended for editing, but the script can be run via `tsx` or ts-node.

Install (example):

```bash
npm i -D tsx typescript
npm i tree-sitter tree-sitter-typescript tree-sitter-javascript tree-sitter-python fast-glob tsconfig-paths
```

---

## Usage

```bash
# Build a dependency graph (prints nodes + edges)
npx tsx src/index.ts graph

# Build the full project index (graph + per-file symbol indexes)
npx tsx src/index.ts index

# Go to definition of symbol at file:line:column
npx tsx src/index.ts goto <file> <line> <column>

# Find references of symbol at a location
npx tsx src/index.ts refs --file <file> --line <line> --col <column>
# Pretty-print only the file:line:col
npx tsx src/index.ts refs --file <file> --line <line> --col <column> --pretty

# Run a Tree-sitter query across the repo
npx tsx src/index.ts grep --query '(function_declaration name: (identifier) @name)'
```

### Output formats

* `graph` prints:

  ```json
  { "nodes": ["/abs/path/a.ts", "..."], "edges": [{ "from": "/abs/path/a.ts", "to": { "external": "react" }, "raw": "react" }, ...] }
  ```
* `index` prints a small summary:

  ```json
  { "files": 128, "edges": 367 }
  ```
* `goto` prints either:

  ```json
  { "status": "ok", "definition": { "file": "...", "localName": "Foo", "kind": "class", "range": { "start": {...}, "end": {...} } } }
  ```

  or:

  ```json
  { "status": "not_found", "reason": "..." }
  ```
* `refs` prints either the JSON response (default) or a list of `file:line:column` with `--pretty`.

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

## Current limitations & roadmap

This is intentionally minimal and pragmatic; here's what's next:

* **Type-only imports/edges** (e.g., `import type { T } from "x"`)
  * *Planned*: tag edges and optionally filter in graph views
* **Namespace packages in Python (PEP 420)**
  * *Planned*: treat directories without `__init__.py` as namespace packages during resolution
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