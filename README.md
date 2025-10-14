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

  * JS/TS: `import`, `export ... from`, `export * from`, `require()`, `import()`.
  * Unresolved targets are represented as **external** nodes.
* **Symbol index**

  * Extracts functions, classes, variables, interfaces, types, and exports.
* **Go to definition**

  * Respects local declarations, default/named/namespace imports, and re-exports.
* **Find references**

  * Scans the project, respects lexical scope, and counts refs through imports/namespace members.
* **AST grep**

  * Run arbitrary Tree-sitter queries across the repo.
* **Extensible language adapters (80/20)**

  * JS/TS (first-class), Python (starter).
  * Clear adapter interface so you can plug in Ruby, C#, Rust, Java, etc.

> Note: The current Python support indexes locals and imports and emits graph edges, but treats targets as **external** (no file-level module resolution yet). This is enough for graphing and basic references; cross-file Python navigation is intentionally scoped for a later pass.

---

## Supported languages

* **JavaScript / TypeScript** (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`)
* **Python** (early support, `.py`)

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

Place `dep-graph-and-symbols.ts` at your **repo root** and run with `tsx`:

```bash
# Build a dependency graph (prints nodes + edges)
npx tsx dep-graph-and-symbols.ts graph

# Build the full project index (graph + per-file symbol indexes)
npx tsx dep-graph-and-symbols.ts index

# Go to definition of symbol at file:line:column
npx tsx dep-graph-and-symbols.ts goto --file src/foo.ts --line 42 --col 17

# Find references of symbol at a location
npx tsx dep-graph-and-symbols.ts refs --file src/foo.ts --line 42 --col 17
# Pretty-print only the file:line:col
npx tsx dep-graph-and-symbols.ts refs --file src/foo.ts --line 42 --col 17 --pretty

# Run a Tree-sitter query across the repo
npx tsx dep-graph-and-symbols.ts grep --query '(function_declaration name: (identifier) @name)'
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

This is intentionally minimal and pragmatic; here’s what’s next:

* **Python module resolution** to real files (now recorded as external nodes).
  *Planned*: relative/absolute resolution using package anchors and simple project-root probing; handle `__all__` and `from x import *` expansion.
* **Multiple `tsconfig.json`** (monorepos).
  *Planned*: nearest-tsconfig lookup per file with cached `paths` alias resolution.
* **Mark TS type-only imports/edges** (e.g., `import type { T } from "x"`).
  *Planned*: tag edges and optionally filter in graph views.
* **Namespace packages in Python (PEP 420)**.
  *Planned*: treat directories without `__init__.py` as namespace packages during resolution.
* **More grammars**: Ruby, C#, Rust, Java, Go… The adapter API is stable enough to add these incrementally.

If you want me to prioritize any of the above, say the word and I’ll wire it in next.

---

## FAQ

**Q: Can I drop this into a mixed repo (multiple Node/Python projects)?**
Yes. It walks the tree, ignores `node_modules`, virtualenv caches, builds a **single** repo-wide graph, and marks unknown modules as **external**.

**Q: Does it follow re-exports for definition jumps?**
Yes, for JS/TS. `resolveExport` recursively follows `export * from` and `export { name } from`.

**Q: How “accurate” is find-references?**
It uses a **lexical scope index** (module → function → block) and recorded bindings. It’s resilient for common patterns and avoids many false positives, but avoids heavy type-checking: perfect for an agent loop foundation.

---