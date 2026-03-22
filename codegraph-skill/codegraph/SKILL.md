---
name: codegraph
description: Static code analysis and dependency graph tool for deep codebase understanding, architecture mapping, go-to-definition, find-references, and PR impact analysis across many languages. Use to quickly map out dependencies, find symbol usages, trace API boundaries, or understand PR impact.
---

# Codegraph

## Overview

Codegraph is a lightweight code analysis tool that builds dependency graphs, parses ASTs to resolve imports/exports, and helps navigate codebases (JS/TS, Python, Go, Java, C#, Ruby, Rust, etc.). Use this skill when you need to understand project structure, track down where symbols are defined or used, or measure the impact of changes.

## Command-Line Usage

Assuming the tool is available as `codegraph` (or via `npx codegraph` or `npx tsx src/cli.ts` if inside its repository), you can use the following capabilities to deeply understand the workspace.

### 1. Generating a Dependency Graph
To see how files import each other, generate a dependency graph.
- **Fast overview (Regex-based, very fast):**
  `codegraph graph ./src --fast-graph`
- **Full AST-based graph (more accurate, slower):**
  `codegraph graph ./src`
- **Visualizing:**
  `codegraph graph ./src --mermaid`
- **Detailed symbol graph (includes `uses` edges between symbols):**
  `codegraph graph ./src --symbols-detailed --compact-json`
- **Exporting full project graph to SQLite (queryable):**
  `codegraph graph --sqlite ./codegraph.sqlite`
- **Raw SQL queries on exported SQLite DB:**
  `codegraph sql --db ./codegraph.sqlite --query "SELECT name, file FROM symbols WHERE kind = 'function' LIMIT 5;"`

### 2. Finding Symbol Definitions & References
To trace logic without guessing, use exact semantic lookups instead of regular text search.
- **Go to Definition:**
  `codegraph goto <file-path> <line> <column>`
- **Find References:**
  `codegraph refs <file-path> <line> <column> --pretty`
  *(Note: line and column are 1-based integers)*

### 3. Analyzing PR/Change Impact
To see how modified code affects the rest of the project (direct and transitive dependencies).
- **Git diff impact:**
  `codegraph impact --provider git --base main --head HEAD`
- **Filter for exported symbol changes only:**
  `codegraph impact --base main --head HEAD --scope imported`
- **Ignore noise files (like lockfiles or dist):**
  `codegraph impact --base main --head HEAD --ignore-glob "**/package-lock.json" "**/dist/**"`
- **Include line context snippets for references:**
  `codegraph impact --base main --head HEAD --ref-context line`

### 4. Codebase Architecture & Metrics
- **Find all dependencies of a file:** `codegraph deps <file>`
- **Find all files that depend on a file:** `codegraph rdeps <file>`
- **Find dependency cycles:** `codegraph cycles --sort priority`
- **Find public API surface (all exported symbols):** `codegraph apisurface`
- **Find high-complexity hotspots:** `codegraph hotspots`
- **Semantic Code Chunking (for embeddings):**
  `codegraph chunk <file>`

## Best Practices

- **Structured Output**: Append `--json` to commands when you want to parse the output programmatically or write it to a file.
- **Speed vs. Accuracy**: Use `--fast-graph` when exploring massive codebases for the first time. Drop it when you need exact AST-level resolution (e.g., dynamic imports or re-exports).
- **Precise Navigation**: For finding usages across the codebase, always prefer `refs` over full-text `grep` for accuracy. It is semantically aware and follows re-exports.
- **Local Execution**: If `codegraph` isn't globally available but you are in a repo that has it, run it via `npx tsx <path-to-codegraph-cli.ts>` or `npm run start -- <command>`.
