---
name: codegraph
description: Static code analysis and dependency graph tool for deep codebase understanding, architecture mapping, go-to-definition, find-references, and PR impact analysis across many languages. Use to quickly map dependencies, find symbol usages, trace API boundaries, or understand PR impact.
---

# Codegraph

## Overview

Codegraph is a lightweight multi-language code analysis tool that builds dependency graphs, symbol indexes, go-to-definition maps, and PR impact reports. It uses one shared Tree-sitter model across languages. When the optional native package is installed, Codegraph runs supported Tree-sitter parse/query work in Rust automatically; otherwise it falls back to the JS Tree-sitter path automatically.

## Installation Notes

- Package name: `@lzehrung/codegraph`
- CLI command: `codegraph`
- Optional native package: `@lzehrung/codegraph-native`
- For published installs, the native package is pulled in automatically when a compatible binary package exists for the current platform.
- For source checkouts, build the native addon locally with:
  `npm run build:native`

## Command-Line Usage

Assuming the tool is available as `codegraph` (or via `npx codegraph` inside a project that depends on `@lzehrung/codegraph`), use the following commands.

### 1. Dependency graphs

- Fast overview:
  `codegraph graph ./src --fast-graph`
- Full AST-based graph:
  `codegraph graph ./src`
- Mermaid output:
  `codegraph graph ./src --mermaid`
- Detailed symbol graph:
  `codegraph graph ./src --symbols-detailed --compact-json`
- SQLite export:
  `codegraph graph --sqlite ./codegraph.sqlite`
- Raw SQL on exported SQLite:
  `codegraph sql --db ./codegraph.sqlite --query "SELECT name, file FROM symbols WHERE kind = 'function' LIMIT 5;"`

### 2. Definitions and references

- Go to definition:
  `codegraph goto <file-path> <line> <column>`
- Find references:
  `codegraph refs <file-path> <line> <column> --pretty`

### 3. PR and diff impact

- Git diff impact:
  `codegraph impact --provider git --base main --head HEAD`
- Exported-only scope:
  `codegraph impact --base main --head HEAD --scope imported`
- Ignore noisy files:
  `codegraph impact --base main --head HEAD --ignore-glob "**/package-lock.json" "**/dist/**"`
- Include line context:
  `codegraph impact --base main --head HEAD --ref-context line`

### 4. Architecture and metrics

- Dependencies of a file:
  `codegraph deps <file>`
- Reverse dependencies:
  `codegraph rdeps <file>`
- Dependency path:
  `codegraph path <from> <to>`
- Cycles:
  `codegraph cycles --sort priority`
- Public API surface:
  `codegraph apisurface`
- Hotspots:
  `codegraph hotspots`
- Semantic chunking:
  `codegraph chunk <file>`

## Library Usage

Use the scoped package name:

```ts
import { buildProjectIndex, goToDefinition, findReferences } from "@lzehrung/codegraph";

const root = process.cwd();
const index = await buildProjectIndex(root);
```

There is no separate native import. If the native package is installed and compatible, the library uses it automatically.

## Best Practices

- Use `--json` when you need machine-readable output.
- Use `--fast-graph` for first-pass exploration on large repos, then rerun without it when accuracy matters.
- Prefer `refs` over plain text search when you want semantic usages.
- If running from a source checkout, `npm run build:native` is the simplest way to enable the native path locally.
