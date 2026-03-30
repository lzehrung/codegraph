---
name: codegraph
description: Static code analysis and dependency graph tool for deep codebase understanding, architecture mapping, go-to-definition, find-references, and PR impact analysis across many languages. Use to quickly map dependencies, find symbol usages, trace API boundaries, or understand PR impact.
---

# Codegraph

## Overview

Codegraph is a lightweight multi-language code analysis tool that builds dependency graphs, symbol indexes, go-to-definition maps, and PR impact reports. It uses one shared Tree-sitter model across languages. Native runtime mode defaults to `auto`: Codegraph resolves parse/query work through `@lzehrung/codegraph-native`, using the native addon when available and the separate opt-in `@lzehrung/codegraph-js-fallback` package when native is unavailable or explicitly disabled.

## Installation Notes

- Package name: `@lzehrung/codegraph`
- CLI command: `codegraph`
- Native backend package: `@lzehrung/codegraph-native`
- Optional JS fallback package: `@lzehrung/codegraph-js-fallback`
- Published installs of `@lzehrung/codegraph` depend on `@lzehrung/codegraph-native` as an optional dependency; that package resolves the matching native artifact automatically when one exists for the current platform.
- For source checkouts, build the native addon locally with:
  `npm run build:native`
- Install the optional fallback package only when you explicitly need JS Tree-sitter fallback:
  `npm install @lzehrung/codegraph-js-fallback --legacy-peer-deps`
- Global default override: `CODEGRAPH_DISABLE_NATIVE=1`
- Explicit CLI/library/tool `native` options take precedence over `CODEGRAPH_DISABLE_NATIVE`

## Command-Line Usage

Assuming the tool is available as `codegraph` (or via `npx codegraph` inside a project that depends on `@lzehrung/codegraph`), use the following commands.

### 1. Dependency graphs

- Whole-repo graph:
  `codegraph graph ./`
- Fast overview:
  `codegraph graph ./src --fast-graph`
- Full AST-based graph:
  `codegraph graph ./src`
- Mermaid output:
  `codegraph graph ./src --mermaid`
- Detailed symbol graph:
  `codegraph graph ./src --symbols-detailed --compact-json`
- For monorepos, prefer explicit roots such as `./src ./packages/app ./packages/lib` when you want product code only; use `./` when you intentionally want the whole repo.
- SQLite export:
  `codegraph graph --sqlite ./codegraph.sqlite`
- Raw SQL on exported SQLite:
  `codegraph sql --db ./codegraph.sqlite --query "SELECT name, file FROM symbols WHERE kind = 'function' LIMIT 5;"`
- Build/report diagnostics:
  `codegraph graph --report`
  `codegraph index --report`
  `codegraph review --report --report-file review.report.json`
  Graph, index, and review reports include `backend.native.byLanguage` so native usage and fallback are visible per language.
- Explicit native runtime control:
  `codegraph graph --native off`
  `codegraph index --native on --report`
- Worker threads for parallel native extraction:
  `codegraph index --workers --threads 8`
  Uses Piscina worker pool to offload per-file Rust extraction across CPU cores. Only applies to `index` and build commands (not `graph`). Falls back silently if the native addon or Piscina is unavailable.

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
const index = await buildProjectIndex(root, { native: "auto" });
const jsOnlyIndex = await buildProjectIndex(root, { native: "off" });
const workerIndex = await buildProjectIndex(root, { useNativeWorkers: true });
```

There is no separate native import. Use `native: "auto" | "on" | "off"` in public API calls to control native usage explicitly. `native: "off"` means the opt-in JS fallback path and requires `@lzehrung/codegraph-js-fallback`.

Agent-tool wrappers accept the same control as a trailing runtime option, for example:

```ts
import { tool_getGraph, tool_goToDefinition } from "@lzehrung/codegraph";

const graph = await tool_getGraph(root, { native: "off" });
const definition = await tool_goToDefinition(
  root,
  "src/main.ts",
  10,
  5,
  undefined,
  { native: "on" },
);
```

## Best Practices

- Use `--json` when you need machine-readable output.
- Use `--fast-graph` for first-pass exploration on large repos, then rerun without it when accuracy matters.
- Prefer `refs` over plain text search when you want semantic usages.
- If running from a source checkout, `npm run build:native` is the simplest way to enable the native path locally.
- If a release publish is interrupted after version files are bumped, use `npm run publish:resume` to finish that version instead of cutting another patch release.
