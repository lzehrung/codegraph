---
name: codegraph
description: Static code analysis and dependency graph tool for deep codebase understanding, architecture mapping, go-to-definition, find-references, and PR impact analysis across many languages. Use to quickly map dependencies, find symbol usages, trace API boundaries, or understand PR impact.
---

# Codegraph

## Overview

Codegraph is a lightweight multi-language code analysis tool that builds dependency graphs, symbol indexes, go-to-definition maps, and PR impact reports. It uses one shared Tree-sitter model across languages, plus graph-first text extraction for document and template formats like Markdown, MDX, Astro, Handlebars, reStructuredText, and AsciiDoc. Native runtime mode defaults to `auto`: Codegraph resolves parse/query work through `@lzehrung/codegraph-native`, using the native addon when available and the separate opt-in `@lzehrung/codegraph-js-fallback` package only when native is unavailable or explicitly disabled.

## Installation Notes

- Package name: `@lzehrung/codegraph`
- CLI command: `codegraph`
- Native backend package: `@lzehrung/codegraph-native`
- Optional JS fallback package: `@lzehrung/codegraph-js-fallback`
- Registry: `@lzehrung` packages are published to GitHub Packages, not the public npm registry. Configure:
  `npm config set "@lzehrung:registry" "https://npm.pkg.github.com"`
- Published installs of `@lzehrung/codegraph` depend on `@lzehrung/codegraph-native` as an optional dependency; that package resolves the matching native artifact automatically when one exists for the current platform.
- For source checkouts, `npm run build` always rebuilds `dist/` and attempts the local native addon when Cargo is available, but it falls back to the JavaScript build output with a warning if the native workspace build is unavailable or fails. Use `npm run build:native` when you want a native-only rebuild or a hard failure if Rust is missing.
- Install the optional fallback package only when you explicitly need JS Tree-sitter fallback:
  `npm install @lzehrung/codegraph-js-fallback --legacy-peer-deps`
- Native-only installs do not need the JS fallback package for normal JS, TS, TSX, or Kotlin import extraction, symbol indexing, chunking, or AST grep. If JS-family query recovery degrades, Codegraph reports that once per language/reason in diagnostics and stays on native-owned recovery paths where supported.
- Global default override: `CODEGRAPH_DISABLE_NATIVE=1`
- Explicit CLI/library/tool `native` options take precedence over `CODEGRAPH_DISABLE_NATIVE`

## Command-Line Usage

Assuming the tool is available as `codegraph`, use the following commands.

If the CLI is missing, do not suggest the unscoped `codegraph` package. Use one of these exact installation paths instead:

- Global install:
  `npm config set "@lzehrung:registry" "https://npm.pkg.github.com"`
  `npm install -g @lzehrung/codegraph`
- Repo-local install:
  `npm config set "@lzehrung:registry" "https://npm.pkg.github.com"`
  `npm install --save-dev @lzehrung/codegraph`
- Source checkout of this repo:
  `npm install`
  `npm run build`
  `node ./dist/cli.js graph --root . --json`

Avoid suggesting `npm install -g codegraph`, `npm install --save-dev codegraph`, or unscoped `npx codegraph` when the package is not already installed locally.

The CLI also ships a bundled skill installer:

- Install into the default Codex-style target:
  `codegraph skill install`
- Install into an explicit target:
  `codegraph skill install --target ~/.codex/skills/codegraph --force`
- Inspect backend/runtime state plus local graph/cache artifacts:
  `codegraph doctor`
- Inspect packaged skill paths and target health:
  `codegraph skill doctor`

### 1. Dependency graphs

- First-pass repo summary and next-step suggestions:
  `codegraph inspect ./src --limit 20`
- Whole-repo graph:
  `codegraph graph ./`
- Fast overview:
  `codegraph graph ./src --fast-graph`
- Full AST-based graph:
  `codegraph graph ./src`
- Graphs also include graph-first document/template edges for HTML, Astro, Handlebars, Markdown, MDX, reStructuredText, and AsciiDoc local links, plus MDX/Astro static imports.
- Narrow scan scope and exclude generated/tests while preserving `.gitignore`:
  `codegraph graph --root . ./src --include-glob "**/*.ts" --ignore-glob "**/*.spec.ts" --json`
- Disable `.gitignore` filtering when ignored/generated files are intentionally in scope:
  `codegraph graph --root . ./src --no-gitignore --json`
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
  Graph, index, and review reports include `backend.native.byLanguage` so native usage and fallback are visible per language. Build reports also include `backend.parser` when syntax-tree backend degradation leaves files without parser context. Reports also include `graph.fallbackImportExtraction.byLanguage` and `byReason` when regex import extraction is used. Review JSON also reports `diagnostics.symbolMappingParseFailures`, `diagnostics.missingFiles`, and distinguishes `changedFiles[].status` as `updated`, `deleted`, or `missing`.
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

- Start here when you need an architecture summary:
  `codegraph inspect ./src --limit 20`
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
  `codegraph hotspots ./src --limit 20`
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

There is no separate native import. Use `native: "auto" | "on" | "off"` in public API calls to control native usage explicitly. `native: "on"` fails if the native addon cannot be loaded. `native: "off"` means the opt-in JS fallback path and requires `@lzehrung/codegraph-js-fallback`.

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

- If you are asked to understand an unfamiliar repo, run `codegraph doctor`, then `codegraph inspect ./src --limit 20`, then use the returned recommended commands to narrow the next graph/query pass.
- If you are asked to assess architectural risk in a subdirectory, run `codegraph hotspots <dir> --limit 20 --json` and `codegraph cycles <dir> --sort priority --json`.
- Use `--include-glob`, `--ignore-glob`, and `--no-gitignore` to control which files are scanned. Use `--resolve-node-modules` only when you want JS/TS bare imports resolved into `node_modules`; it does not change scan roots.
- Use `--json` when you need machine-readable output.
- Use `--fast-graph` for first-pass exploration on large repos, then rerun without it when accuracy matters.
- Prefer `refs` over plain text search when you want semantic usages.
