# codegraph

Codegraph is a small multi-language code analysis library and CLI for understanding repos quickly. It builds dependency graphs, symbol indexes, go-to-definition results, find-references results, semantic chunks, and PR review and impact artifacts across source languages plus graph-first document, stylesheet, and template formats.

It is built for agent and human workflows that need repo structure fast without standing up a full editor or LSP stack.

## Table of contents

- [Why Codegraph](#why-codegraph)
- [Features](#features)
- [Quick start](#quick-start)
- [Agent setup](#agent-setup)
- [Using as a library](#using-as-a-library)
- [Common workflows](#common-workflows)
- [Supported languages](#supported-languages)
- [Documentation](#documentation)
- [Installation options](#installation-options)
- [FAQ](#faq)
- [Contributing and releases](#contributing-and-releases)

## Why Codegraph

Use Codegraph when you need fast structural answers about a repo without relying on a full editor session or language-server setup.

- Triage an unfamiliar codebase with one pass that highlights hotspots, unresolved imports, cycles, and next commands to run.
- Review diffs with changed symbols, graph deltas, likely regression tests, and risk signals that agents or humans can consume directly.
- Export graph data as JSON, Mermaid, DOT, or SQLite, then inspect it from scripts or the browser graph viewer app.
- Keep one workflow across source languages, monorepos, and graph-first document and template formats instead of stitching together separate tools.

Real `inspect ./src --limit 10` output against this repo looks like:

```json
{
  "backend": {
    "native": {
      "available": true
    }
  },
  "files": {
    "total": 80,
    "byLanguage": {
      "ts": 80
    }
  },
  "hotspots": [
    {
      "file": "E:/git repos/codegraph/src/languages/types.ts",
      "fanIn": 35,
      "fanOut": 1,
      "score": 71
    },
    {
      "file": "E:/git repos/codegraph/src/indexer.ts",
      "fanIn": 16,
      "fanOut": 27,
      "score": 59
    }
  ],
  "recommendedCommands": [
    "codegraph hotspots --root \"E:/git repos/codegraph/src\" --limit 20 --json",
    "codegraph graph --root \"E:/git repos/codegraph/src\" --json --symbols-detailed --compact-json"
  ]
}
```

## Features

- Multi-language dependency graphs, including imports, re-exports, `require()`, dynamic imports, workspace resolution, document links, stylesheet imports, and SFC script dependencies.
- Per-file symbol indexes with locals, exports, docstrings, line spans, and lightweight complexity metadata.
- Cross-file go-to-definition and find-references support across the shared source-language pipeline.
- Deterministic agent search and explanation packets across files, symbols, chunks, SQL objects, and graph neighborhoods with stable follow-up handles.
- Semantic chunking for code and text files, including Vue and Svelte single-file component block splitting.
- AST grep, public API summaries, unresolved import reports, hotspot analysis, cycle detection, and shortest dependency paths.
- PR impact analysis and review bundles that map diffs to changed symbols, impacted code, likely tests, and graph deltas.
- SQL language support for `.sql` files, including statement chunks, object symbols, SQL-to-SQL graph edges, SQL navigation, and statement facts.
- SQLite export plus read-only SQL access for downstream tools and agent workflows.
- A browser graph viewer app for interactive exploration of generated graph JSON artifacts.
- Native Tree-sitter acceleration by default when a compatible artifact is available, with an opt-in JS fallback path when you need it.

Sample graph output can be generated with `npm run graph:mermaid` or `npm run graph:json`, and the repo also ships a browser viewer app in `docs/graph-visualization` for inspecting graph JSON interactively.

## Quick start

Requirements: Node.js 20+.

For contributors and first-time evaluation, start from a local source checkout:

```bash
git clone https://github.com/lzehrung/codegraph.git
cd codegraph
npm install
npm run build
```

`npm run build` always rebuilds `dist/`. If Cargo is available, it also requires the local native workspace build to succeed; if Cargo is unavailable, it still completes with the JavaScript build output and a warning.

Then run a few concrete first-pass commands:

```bash
# confirm runtime and artifact state
node ./dist/cli.js doctor

# get a repo summary and next-step suggestions
node ./dist/cli.js inspect ./src --limit 20

# build a graph for product code
node ./dist/cli.js graph --root . ./src --json > codegraph.json

# inspect public API surface
node ./dist/cli.js apisurface
```

If you install the published CLI instead of using a source checkout, replace `node ./dist/cli.js` with `codegraph`.

## Agent setup

Using a skill-aware agent? Install the bundled skill so repo navigation, semantic references, dependency tracing, and PR impact questions route to Codegraph automatically. The installer uses safe per-agent defaults and refuses to create a missing parent skills directory, so create the agent's `skills` folder first:

```bash
# Codex CLI: ${CODEX_HOME:-~/.codex}/skills/codegraph
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
codegraph skill install --agent codex

# Claude Code: ~/.claude/skills/codegraph
mkdir -p ~/.claude/skills
codegraph skill install --agent claude

# Universal agent skills: ~/.agents/skills/codegraph
mkdir -p ~/.agents/skills
codegraph skill install --agent agents

# Cursor CLI: ~/.cursor/skills/codegraph
mkdir -p ~/.cursor/skills
codegraph skill install --agent cursor

# Gemini CLI: ~/.gemini/skills/codegraph
mkdir -p ~/.gemini/skills
codegraph skill install --agent gemini

# OpenCode: ~/.config/opencode/skills/codegraph
mkdir -p ~/.config/opencode/skills
codegraph skill install --agent opencode
```

For a custom location, use `codegraph skill install --target <path>/skills/codegraph`; the target must end with `skills/codegraph` and the parent `skills` directory must already exist. Cursor CLI now supports native skills directories too, so `.cursor/skills/codegraph` works alongside the universal `~/.agents/skills/codegraph` location. To inspect the packaged skill paths and target health, run `codegraph skill doctor`.

On PowerShell, use `New-Item -ItemType Directory -Force <path>` instead of `mkdir -p <path>`.

## Using as a library

Use the TypeScript API when another program needs deterministic file packs, review packets, or model prompts. CLI `--pretty` and `--summary` output is for humans; library callers should keep structured fields until the final UI or prompt boundary.

```ts
import {
  buildProjectIndex,
  buildReviewReport,
  analyzeImpactFromDiff,
  analyzeImpactStreaming,
  tool_impactJSON,
} from "@lzehrung/codegraph";

const root = process.cwd();
const index = await buildProjectIndex(root, { native: "auto" });

const review = await buildReviewReport(root, {
  gitBase: "origin/main",
  gitHead: "HEAD",
  reviewDepth: "standard",
});

const impact = await analyzeImpactFromDiff(root, index, {
  provider: "git",
  base: "origin/main",
  head: "HEAD",
  detectBreakingChanges: true,
});

for await (const chunk of analyzeImpactStreaming(root, index, {
  provider: "git",
  base: "origin/main",
  head: "HEAD",
})) {
  if (chunk.type === "complete") {
    console.log(chunk.report.changedSymbols, chunk.report.impacted);
  }
}

const wrapped = await tool_impactJSON(root, { provider: "git", base: "HEAD", head: "WORKTREE" }, { index });
```

Good downstream packs preserve structured fields such as symbol handles, ranges, diff snippets, callsites, graph edges, candidate-test confidence, impact reasons, diagnostics, and `schemaVersion`/`format`. Streaming callers that only need incremental chunks can set `streamSummary: "light"` to skip terminal suggestions, export summaries, re-export chains, ranked top impacts, graph metadata, cycles, clusters, and surface-area work. Use [docs/library-api.md](./docs/library-api.md) for the full API reference and [docs/agent-workflows.md](./docs/agent-workflows.md) for session and streaming recipes.

## Common workflows

- Repo triage: run `codegraph inspect ./src --limit 20`, then follow with `codegraph hotspots ./src --limit 20` or `codegraph unresolved` to focus the next pass.
- Symbol navigation: use `codegraph goto <file> <line> <column>` and `codegraph refs --file <file> --line <line> --col <column> --pretty` when a question is about definitions or semantic usages rather than matching strings.
- PR review: run `codegraph impact --base origin/main --head HEAD --pretty` for a ranked map, `codegraph review --base origin/main --head HEAD --summary` for a compact reviewer handoff with actionable candidate tests, or redirect plain `review` output when a downstream tool needs the full JSON bundle.
- Worktree review: run `codegraph impact --base HEAD --head WORKTREE --pretty` for current staged and unstaged tracked-file changes, then `codegraph review --base HEAD --head WORKTREE --summary` for a compact handoff. Use `--head STAGED` to compare `HEAD` against the current index.
- Visual graph exploration: run `codegraph graph --root . ./src --compact-json --output codegraph.json`, then open `docs/graph-visualization/` to inspect the graph in the browser viewer app.
- Public API inspection: run `codegraph apisurface` to summarize exported symbols before refactors, reviews, or release checks.

## Supported languages

### Source languages

JavaScript, TypeScript, Python, PHP, Go, Java, C#, Ruby, Rust, Kotlin, Swift, Zig, C, and C++ all participate in the shared source-language indexing and navigation pipeline.

### Graph-first formats

HTML, Astro, Handlebars, Markdown, MDX, reStructuredText, AsciiDoc, CSS, SCSS, and Less participate in graph or chunking workflows with narrower capability claims than the full source-language pipeline. CSS-family graphing covers stylesheet imports; SCSS also resolves Sass partials, including extensionless and explicit `.scss` specifiers.

### SQL

SQL files participate in normal repository indexing. Codegraph discovers every `.sql` file by default, chunks SQL statements, extracts table/view/index/routine symbols, records common DDL/DML and CTE read/write facts, adds SQL-to-SQL object edges, and supports go-to-definition and find-references within SQL files. SQL navigation resolves schema-qualified names plus object-level `alias.column` and `schema.table.column` references to table/view definitions, but it does not claim column-definition resolution. SQL-to-SQL edges are precise for exact object-name matches, heuristic for unambiguous qualified-to-basename fallback matches, and skipped for ambiguous basename guesses. SQL indexing, graphing, and navigation work in native-only installs without the optional JS fallback package. SQL is still intentionally scoped to SQL semantics: Codegraph does not infer a current schema from migrations, fixtures, dumps, or seeds, and it does not globally link arbitrary application-code strings to SQL objects.

### Single-file components

Vue and Svelte script blocks are parsed with the JS and TS pipeline for dependency graphs and chunking, including external `<script src="...">` dependencies. Semantic navigation remains intentionally narrower.

For the full capability matrix, limitations, and fixture coverage, see [docs/language-parity.md](./docs/language-parity.md) and [docs/scenario-catalog.md](./docs/scenario-catalog.md).

## Documentation

- [docs/installation.md](./docs/installation.md): source checkout, scoped registry, release tarball, native runtime modes, and JS fallback details
- [docs/cli.md](./docs/cli.md): command reference, output formats, SQLite schema, review bundles, and graph viewer usage
- [docs/library-api.md](./docs/library-api.md): agent search/explain, semantic chunking, indexing, graph APIs, read-only SQL, impact examples, and programmatic review output
- [docs/agent-workflows.md](./docs/agent-workflows.md): search anchors, sessions, streaming, tool wrappers, review bundles, and agent-oriented review recipes
- [docs/how-it-works.md](./docs/how-it-works.md): performance, caching, native runtime behavior, architecture, and testing guidance
- [docs/language-parity.md](./docs/language-parity.md): per-language capability matrix
- [docs/scenario-catalog.md](./docs/scenario-catalog.md): scenario and fixture coverage
- [docs/adding-language-support.md](./docs/adding-language-support.md): checklist for new language support
- [PUBLISHING.md](./PUBLISHING.md): release and native artifact workflow
- [docs/graph-visualization/index.html](./docs/graph-visualization/index.html): browser graph viewer app for interactive exploration of graph JSON

## Installation options

The full install details now live in [docs/installation.md](./docs/installation.md). The short version:

### Source checkout

See the [Quick start](#quick-start) section for the recommended first-run path.

For a local global install from the source checkout, run `npm run build` first and then `npm install -g .`.

### Scoped registry install

```bash
npm config set "@lzehrung:registry" "https://npm.pkg.github.com"
npm install @lzehrung/codegraph
```

### Release tarball install

```bash
npm install https://github.com/lzehrung/codegraph/releases/download/vVERSION/lzehrung-codegraph-VERSION.tgz
```

Important runtime note: the root tarball does not bundle the native addon or the optional JS fallback grammars. For source-language parsing after a tarball install, you still need either the scoped native package path or the separate `@lzehrung/codegraph-js-fallback` package, and both runtime packages still require the `@lzehrung` GitHub Packages registry configuration.

## FAQ

**Can I drop this into a mixed repo?**
Yes. Codegraph walks the tree, ignores usual generated directories, builds one repo-wide graph, and marks unresolved third-party modules as external. It also detects common project files for Node, Python, Rust, Go, Ruby, Java/Kotlin, .NET, PHP, Swift, C/C++, Nx, and Turborepo so inspection and review output can point at likely project boundaries.

**Does it follow re-exports for definition jumps?**
Yes, when the language extractor records the re-export. Covered examples include JS/TS `export * from`, `export { name } from`, namespace re-exports, and Rust re-export modules. Go, Java, and Kotlin use language-specific package export rules rather than JS-style barrels.

**How accurate is find-references?**
It answers: after this name resolves to this definition, where do recorded imports, aliases, local bindings, and common member uses point back to it? It does not run each language's compiler or type checker, so dynamic dispatch, reflection, generated code, and macro-expanded references can be missed.

**Does it support CommonJS destructuring?**
Yes. Both `const { helperFunction } = require("./module")` and aliased destructuring patterns are supported.

**Does it work with monorepos?**
Yes, with two layers. Node workspace package imports resolve through `package.json` workspaces, `pnpm-workspace.yaml`, and `lerna.json`; pnpm exclude globs are honored. Broader monorepo and project metadata such as `nx.json`, `turbo.json`, `go.work`, `Cargo.toml`, `composer.json`, Maven/Gradle files, .NET projects, Swift packages, and C/C++ build files are detected for project discovery, inspection, and review risk signals.

## Contributing and releases

The contributor baseline is:

```bash
npm run build
npm run test:ci
```

If you are touching the native workspace directly, also run `npm run build:native` and `npm run test:native`.

Use the root release scripts to cut independent releases for the packages that actually changed:

```bash
npm run release:patch
npm run release:minor
npm run release:major
npm run release:resume

npm run publish:patch
npm run publish:minor
npm run publish:major
npm run publish:resume
```

Use `--package root`, `--package native`, `--package js-fallback`, or a full package name when you need to force a specific package.

For GitHub-driven root releases, use the manual `release-root` Actions workflow with `patch`, `minor`, or `major`. It publishes the root package, then creates or updates the matching `vX.Y.Z` GitHub Release with the packed root tarball asset. The workflow refuses reruns on an already-tagged release commit because fresh Actions runners cannot reconstruct the local `publish:resume` state.

For the detailed release flow, native artifact staging, and tag behavior, see [PUBLISHING.md](./PUBLISHING.md).
