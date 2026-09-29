# codegraph

<p align="center">
  <img src="./assets/codegraph-logo.png" alt="codegraph" width="300">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@lzehrung/codegraph"><img src="https://img.shields.io/npm/v/%40lzehrung%2Fcodegraph?logo=npm&amp;label=npm" alt="npm version"></a>
  <a href="https://github.com/lzehrung/codegraph/releases/latest"><img src="https://img.shields.io/github/v/release/lzehrung/codegraph?display_name=tag&amp;sort=semver" alt="Release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/node-%3E%3D22.16-brightgreen.svg" alt="Node.js"></a>
  <a href="./docs/mcp.md"><img src="https://img.shields.io/badge/MCP-server-purple.svg" alt="MCP"></a>
  <a href="./CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-Keep%20a%20Changelog-orange.svg" alt="Changelog"></a>
</p>

**Give your coding agent a map of the repository, not a pile of search results.**

codegraph is a local CLI **and TypeScript library** that turns a source tree into a resolved map of files, symbols, references, and dependencies. Ask where an implementation lives, how components connect, what a change can break, or which tests are relevant, then get bounded source evidence and copyable next steps.

codegraph is not an AST, a compiler, or a linter. People can use `codegraph review` and `codegraph deps` to inspect changes and dependencies without an agent.

Without structural context, an agent burns early turns listing directories, guessing search terms, opening candidate files, and reconstructing relationships. codegraph does that discovery once so the context window can stay focused on the problem.

With Node.js 22.16 or newer, install from npm:

```bash
npm install -g @lzehrung/codegraph
codegraph doctor
codegraph install
codegraph explore "build review report" --root .
```

No Node.js or npm? The standalone installers download a self-contained bundle with Node.js, the CLI, and the matching native runtime:

```powershell
irm https://github.com/lzehrung/codegraph/releases/latest/download/install.ps1 | iex
```

```bash
curl -fsSL https://github.com/lzehrung/codegraph/releases/latest/download/install.sh | sh
```

Use codegraph alongside text search and compilers: text search finds exact strings, compilers prove language behavior, and codegraph fills in the cross-file repository map between them. See [Installation](./docs/installation.md) for npm, standalone, and source-checkout paths.

## Table of contents

- [Changelog](./CHANGELOG.md)
- [What you can do](#what-you-can-do)
- [Try it](#try-it)
- [A useful first five minutes](#a-useful-first-five-minutes)
- [Visualize a graph](#visualize-a-graph)
- [What the output looks like](#what-the-output-looks-like)
- [Why codegraph](#why-codegraph)
- [Why not just grep or an LSP?](#why-not-just-grep-or-an-lsp)
- [Agent setup](#agent-setup)
- [Language support](#language-support)
- [Using as a library](#using-as-a-library)
- [How it works](#how-it-works)
- [Limits and tradeoffs](#limits-and-tradeoffs)
- [Documentation](./docs)
  - [CLI](./docs/cli.md)
  - [Publishing](./PUBLISHING.md)
- [Development](#development)

## What you can do

| Job | Question | Start here | What comes back |
| --- | --- | --- | --- |
| Review | What could this change break? | `codegraph review` | Changed symbols, risks, and candidate tests |
| Review | Which tests should I run? | `codegraph affected --base HEAD --head WORKTREE --quiet` | Test paths from changed files and reverse dependencies |
| Review | How does this feature work? | `codegraph explore "<question>" --root .` | Ranked anchors, source evidence, and dependency paths |
| Refactor | Where is this symbol used? | `codegraph refs src/file.ts:10:5` | Semantic references and coverage |
| Refactor | What depends on this file? | `codegraph rdeps src/file.ts --json` | Reverse dependencies |
| Refactor | What evidence supports a change? | `codegraph refactor-plan <symbol-target>` | Read-only evidence; no code changes |
| Refactor | Where would a rename apply? | `codegraph rename-preview <symbol-target> <new-name>` | Read-only edits and conflicts; no code changes |
| Quality | Which files have the most connections? | `codegraph hotspots ./src --limit 20` | Fan-in and fan-out ranking |
| Quality | Where is code duplicated? | `codegraph duplicates ./src --min-confidence medium` | Ranked duplicate groups |
| Docs | Which public symbols exist? | `codegraph apisurface` | Exported API symbols |
| Docs | Which exports have no indexed docstring? | `codegraph apisurface --undocumented` | File, name, kind, and range; see language limits |
| Docs | Are Markdown links broken? | `codegraph links --root .` | Broken local links with ranges; external URLs skipped |

CLI output is readable by default. Use `--json` for structured fields and omission counts.

## Try it

See [Installation](./docs/installation.md) for npm, standalone, and source-checkout steps.

## A useful first five minutes

Do not begin by generating every possible report. Start with the question you actually have.

### Understand an unfamiliar repo

```bash
# Map the repository before selecting a target
codegraph orient --root . --budget small

# Search a concrete term (the query is lexical: use the words that appear in code)
codegraph search "build review report" --json

# Use explore only when those results need packets and dependency paths
codegraph explore "build review report" --root .

# Follow a returned target
codegraph explain src/review.ts
codegraph deps src/review.ts --json
codegraph refs src/review.ts:215:23
```

### Review local changes

```bash
# Compact reviewer handoff for staged and unstaged tracked changes
codegraph review

# Broader blast-radius map when the summary needs expansion
codegraph impact --base HEAD --head WORKTREE

# Deterministic affected-test paths for focused validation
codegraph affected --base HEAD --head WORKTREE --quiet
```

Use `--head STAGED` to compare `HEAD` with the index, or use refs such as `--base origin/main --head HEAD` for a branch review.

### Inspect repository health

```bash
codegraph inspect ./src --limit 20
codegraph cycles --sort priority
codegraph unresolved
codegraph apisurface
codegraph duplicates ./src --min-confidence medium --limit 20
codegraph drift ./src --base origin/main --head HEAD --graph-edges summary --public-api removals

# Validate local Markdown links offline (exit 1 on broken links)
codegraph links --root .
```

### Export the model

```bash
codegraph graph --root . ./src --json --output codegraph.json
codegraph graph --root . ./src --mermaid --output graph.mmd
codegraph graph --root . ./src --dot --output graph.dot
codegraph graph --root . ./src --sqlite codegraph.sqlite
```

## Visualize a graph

The packaged viewer is a human-facing graph UI; agents should use graph JSON, SQLite, MCP, or `--json` instead. Its command is `codegraph viewer [--root <root>] [--graph <root-confined-json>] [--host <host>] [--port <0-65535>] [--open] [--print-url]`; the root defaults to the current directory.

![codegraph graph viewer with `src/cli.ts` selected and its immediate dependencies labeled](assets/viewer-selected-node.webp)

```bash
codegraph viewer --root . --open
codegraph viewer --root . --graph codegraph-out/graph.json --open
codegraph viewer --root . --port 4173 --print-url
```

The default host is `127.0.0.1` and the default port is `4173`. Without `--graph`, each UI load or reload builds a current graph projection through the automatically validated `.codegraph/cache/index-v1` index; `init`, `index`, and an exported JSON file are not prerequisites. An explicit `--graph` serves that root-confined snapshot through the same `/graph.json` route, while `--print-url` only prints the deterministic URL and exits.

The UI loads Sigma, Graphology, and ForceAtlas2 from bundled `src/viewer/vendor/` assets, so the viewer stays offline and self-contained once codegraph is installed.

## What the output looks like

Because ranking and counts change with the working tree, this abbreviated `explore` excerpt shows the stable response structure rather than snapshot-specific totals:

```text
Anchors
- buildReviewReport [symbol] src/review.ts
- src/cli/help.ts:1 [chunk] src/cli/help.ts
- ReviewPreset [symbol] src/review.ts

Relevant source
- buildReviewReport is defined in src/review.ts.
- References, dependencies, and dependents are summarized here.

Blast radius
- src/review.ts: src/index.ts, src/cli/review.ts, src/mcp/server.ts, ...

Candidate tests
- tests/agent-explain.test.ts
- tests/agent-explore.test.ts
- tests/agent-packet.test.ts

Follow-ups
- codegraph file src/review.ts
- codegraph refs src/review.ts:215:23

Limits
- anchors, packets, paths, blast radius, reverse dependencies, and candidate tests

Recommended next: codegraph file src/review.ts
```

Real output includes counts, copyable follow-ups, explicit limits, and omission counts.

A worktree review is optimized for a different job:

```text
Review Summary
==============
Status: ok
Files changed: 5
Symbols changed: 22
Candidate tests: 1 (high: 1, medium: 0, low: 0)
Risk: high (80)
Signals: exported-symbols-changed, many-symbols-changed
```

Structured output carries the underlying changed files, symbols, graph edges, reasons, diagnostics, snippets, and candidate-test confidence.

## Why codegraph

### Spend context on the problem, not repository discovery

One bounded CLI `explore` response can combine ranked anchors, relevant source, dependency paths, blast radius, candidate tests, and next commands. CLI `explore` includes source by default for a human reader, while MCP `explore` defaults `includeSource` to `false` so source-bearing packets do not dominate agent responses; its anchors and follow-ups identify the focused source request to make next. The agent gets an evidence-backed starting point without first dumping the tree or repeatedly guessing which files to open.

### Ground the next action

Results include source paths, symbol ranges, stable handles, rank reasons, graph relationships, confidence, and omission counts. An agent can inspect why something ranked, jump to the definition or references, and continue from an exact target instead of treating a fuzzy match as an answer.

### Trust the answer, or know why not

Definitions, references, and call edges come from scopes, imports, packages, and receivers proven from source, not from name matching alone. When codegraph cannot prove a target, it returns `not_found` or reports `referenceCoverage` as `partial` with a reason instead of guessing. An agent can act on a `complete` result and fall back to text search or a compiler for the rest; `complete` covers every candidate known to the index, not unknown dynamic loading. See the [`refs` coverage contract](./docs/cli.md#symbols-navigation-grep-and-chunking) and the [language parity matrix](./docs/language-parity.md) for per-language support and tested limits.

### Reuse one map from discovery through review

Search, navigation, dependency analysis, impact, and review reuse the same graph and semantic index. A target found during discovery can flow directly into `explain`, `refs`, `deps`, impact analysis, and candidate-test selection.

### Work across the repository an agent actually has

One repository model can include source code, SQL, workspace packages, documentation links, stylesheets, templates, and single-file components. Capability claims stay language-specific, so graph support is not presented as full compiler or language-server parity.

### Keep the evidence local and reusable

codegraph runs locally as a CLI, library, or MCP server. Humans get readable output; agents and programs can keep structured JSON, stable handles, warm sessions, SQLite data, or graph exports without parsing display text.

## Why not just grep or an LSP?

codegraph complements both.

- Use text search for exact strings, logs, config keys, and prose.
- Use a compiler or language server when you need compiler-grade type analysis, overload resolution, dynamic dispatch, or editor refactors.
- Use codegraph when the question crosses files, languages, dependency edges, a git diff, or an agent context boundary.

The distinction is evidence shape, not a claim that one tool replaces the others.

## Agent setup

Run `codegraph install` on an interactive terminal to detect supported clients, preview the changes, and confirm once. Use `--all` when you want the full current catalog without detection:

```bash
codegraph install
codegraph install --target codex,claude --dry-run
codegraph install --target codex,claude --yes
codegraph install --all --dry-run
codegraph install --all --yes
codegraph install --print-config codex
```

Supported target ids are `codex`, `claude`, `cursor`, `gemini`, `opencode`, `omp`, `kilo`, and `agents`. Interactive writes default to no; noninteractive writes require `--yes`.

For a skill without MCP configuration:

```bash
codegraph skill install --agent codex
codegraph skill install --agent claude
codegraph skill install --agent cursor
```

See [Agent workflows](./docs/agent-workflows.md) for exploration strategy, warm sessions, streaming, review loops, and tool wrappers. Use `codegraph server start --root .` to share one local MCP HTTP server, then inspect or stop it with `codegraph server status --root . --json` and `codegraph server stop --root .`; lifecycle verification keeps its secret outside the project. See [MCP](./docs/mcp.md) for server and client configuration.

## Language support

**Shared source-language indexing and navigation:** JavaScript, TypeScript, Python, PHP, Go, Java, C#, Ruby, Rust, Kotlin, Swift, Zig, C, and C++.

**SQL:** statement chunking, object symbols, common DDL/DML and CTE facts, SQL-to-SQL edges, and object-level navigation. codegraph does not claim column-definition resolution.

**Graph-first formats:** HTML, Astro, Handlebars, Markdown, MDX, reStructuredText, AsciiDoc, CSS, SCSS, and Less have narrower graph or chunking support.

**Single-file components:** Vue and Svelte script blocks participate in dependency graphs and chunking; semantic navigation is narrower.

See [Language parity](./docs/language-parity.md) for the capability matrix and [Scenario catalog](./docs/scenario-catalog.md) for the fixtures behind those claims.

## Using as a library

Install `@lzehrung/codegraph-core` when you need the library without the CLI, MCP server, installer, or viewer.

```ts
import { buildProjectIndex, getHotspots } from "@lzehrung/codegraph-core";

const index = await buildProjectIndex(process.cwd());
console.log(getHotspots(index.graph, { limit: 10 }));
```

See the [Library API reference](./docs/library-api.md) for navigation, review, agent sessions, and artifacts.

## How it works

codegraph follows a single analysis pipeline:

1. Discover supported files under the selected project and include roots.
2. Parse source languages with Tree-sitter and extract imports, exports, definitions, bindings, and scopes.
3. Resolve module specifiers to project files or explicit external nodes.
4. Build forward and reverse dependency indexes plus a semantic symbol index.
5. Reuse those indexes for navigation, exploration, impact, review, and exports.

Disk caching avoids repository-wide source reads on exact warm text-search hits. [How it works](./docs/how-it-works.md#cache-and-session-behavior) covers caching, recovery, and performance choices.

## Limits and tradeoffs

The honest boundaries matter:

- codegraph is not a compiler or type checker. Reflection, generated code, macros, overload behavior, and dynamic dispatch can be missed. When a result would need expression type inference, overload ranking beyond arity, or build-system membership, codegraph reports `not_found` or `partial` coverage rather than a guessed target.
- Precise navigation depends on successful parsing and language queries. Without a compatible native runtime, codegraph falls back to reduced graph-only and regex recovery rather than claiming equivalent semantics.
- Call-compatibility findings are conservative review leads, not compiler diagnostics.
- Duplicate matches and candidate tests are ranked leads that still require human or agent judgment.
- `--fast-graph` is an explicit speed/accuracy tradeoff for plain JavaScript and TypeScript import extraction.
- The checked `explore` benchmark is a bounded evidence-retrieval benchmark, not a universal performance claim.
- The fixture test matrix and language parity docs show what codegraph has actually been tested against by language and operation; absence there means untested, not guaranteed.

Mitigations are explicit too:

- The repository keeps real-language fixtures and parity suites for definitions, references, dependencies, chunking, MCP, and native-vs-reduced behavior.
- A generated [fixture test matrix](./docs/benchmarks/fixture-snapshot.md) shows real `tests/languages/*.test.ts` status and test counts per language, with no hand-authored goldens involved.
- Structured output keeps freshness, confidence, and omission counts visible instead of pretending unsupported cases were resolved.

Run `codegraph doctor` to confirm the active runtime. Use `--report` on graph, index, search, inspect, or review commands when backend and cache behavior need to be auditable.

## Development

```bash
npm install
npm run build
npm run check
```

Use the narrowest relevant test while iterating. `npm run check` is the pre-commit baseline for formatting, lint, build, and tests; native workspace changes also require `npm run build:native` and `npm run test:native`.

codegraph is MIT licensed.
