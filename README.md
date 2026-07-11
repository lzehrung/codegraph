# Codegraph

**Give your coding agent a map of the repository, not a pile of search results.**

Codegraph is a local CLI **and TypeScript library** that turns a source tree into a resolved model of files, symbols, references, and dependencies. Agents and humans can ask where an implementation lives, how components connect, what a change can break, and which tests are likely relevant - then get bounded source evidence and copyable next steps.

Without structural context, an agent spends early turns listing directories, guessing search terms, opening candidate files, and reconstructing relationships in its prompt. Codegraph performs that deterministic discovery once so more of the context window can go toward understanding and changing the code.

```bash
codegraph explore "how does auth reach the database?" --root . --pretty
codegraph review --base HEAD --head WORKTREE --summary
```

Use Codegraph alongside text search and compilers: text search finds exact strings, compilers prove language behavior, and Codegraph supplies the cross-file repository map between them.

## Table of contents

- [What you can do](#what-you-can-do)
- [Try it](#try-it)
- [A useful first five minutes](#a-useful-first-five-minutes)
- [What the output looks like](#what-the-output-looks-like)
- [Why Codegraph](#why-codegraph)
- [Why not just grep or an LSP?](#why-not-just-grep-or-an-lsp)
- [Agent setup](#agent-setup)
- [Language support](#language-support)
- [Using as a library](#using-as-a-library)
- [How it works](#how-it-works)
- [Limits and tradeoffs](#limits-and-tradeoffs)
- [Documentation](#documentation)
- [Contributing](#contributing)

## What you can do

| Question                                | Start here                                                              | What comes back                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| "Where should I start in this repo?"    | `codegraph orient --root . --budget small --pretty`                     | Central modules, a bounded tree, and copyable follow-ups                          |
| "How does this feature work?"           | `codegraph explore "<question>" --root . --pretty`                      | Ranked anchors, source packets, dependency paths, blast radius, and likely tests  |
| "What could this change break?"         | `codegraph review --base HEAD --head WORKTREE --summary`                | Changed symbols, risk signals, candidate tests, duplicate leads, and review tasks |
| "What depends on this file?"            | `codegraph rdeps src/file.ts --json`                                    | Reverse dependencies from the resolved project graph                              |
| "Where is this symbol defined or used?" | `codegraph goto <file> <line> <column>` and `codegraph refs ...`        | Semantic definitions and references across supported languages                    |
| "Is the architecture drifting?"         | `codegraph drift ./src --base origin/main --head HEAD --pretty`         | New cycles, hotspot changes, unresolved imports, API changes, and graph deltas    |
| "Where is code duplicated?"             | `codegraph duplicates ./src --min-confidence medium`                    | Ranked exact and near-duplicate groups with locations and confidence              |
| "Can another tool consume the graph?"   | `codegraph graph --root . ./src --compact-json --output codegraph.json` | JSON, Mermaid, DOT, or SQLite output                                              |

Human-readable output uses `--pretty` or `--summary`. JSON, MCP tools, and library APIs preserve stable fields, ranges, handles, reasons, confidence, and omission counts for automation.

## Try it

**Requirement:** Node.js 24.10 or newer.

### From a source checkout

This is the least ambiguous way to evaluate the current repository:

```bash
git clone https://github.com/lzehrung/codegraph.git
cd codegraph
npm install
npm run build
node ./dist/cli.js doctor
node ./dist/cli.js orient --root . --budget small --pretty
```

Continue with `node ./dist/cli.js <command>` from the checkout. To use the bare `codegraph` examples below unchanged, run `npm install -g .` after the build.

### From GitHub Packages

If access to the `@lzehrung` GitHub Packages registry is configured:

```bash
npm config set "@lzehrung:registry" "https://npm.pkg.github.com"
npm install -g @lzehrung/codegraph
codegraph doctor
```

Published installs resolve the optional native runtime automatically when a compatible artifact exists. See [Installation](./docs/installation.md) for registry setup, release tarballs, local global installs, and native runtime modes.

## A useful first five minutes

Do not begin by generating every possible report. Start with the question you actually have.

### Understand an unfamiliar repo

```bash
# Ask one concrete architecture question
codegraph explore "how does the CLI reach review analysis?" --root . --pretty

# If you do not know the question yet, get a bounded map
codegraph orient --root . --budget small --pretty

# Follow an anchor returned by either command
codegraph explain src/review.ts
codegraph deps src/review.ts --json
codegraph refs --file src/review.ts --line 215 --col 23 --pretty
```

### Review local changes

```bash
# Compact reviewer handoff for staged and unstaged tracked changes
codegraph review --base HEAD --head WORKTREE --summary

# Broader blast-radius map when the summary needs expansion
codegraph impact --base HEAD --head WORKTREE --pretty
```

Use `--head STAGED` to compare `HEAD` with the index, or use refs such as `--base origin/main --head HEAD` for a branch review.

### Inspect repository health

```bash
codegraph inspect ./src --limit 20
codegraph cycles --sort priority
codegraph unresolved
codegraph apisurface
codegraph duplicates ./src --min-confidence medium --limit 20
codegraph drift ./src --base origin/main --head HEAD --pretty --graph-edges summary --public-api removals
```

### Export the model

```bash
codegraph graph --root . ./src --compact-json --output codegraph.json
codegraph graph --root . ./src --mermaid --output graph.mmd
codegraph graph --root . ./src --dot --output graph.dot
codegraph graph --root . ./src --sqlite codegraph.sqlite
```

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
- codegraph file src/review.ts --pretty
- codegraph refs --file src/review.ts --line 215 --col 23 --pretty

Limits
- anchors, packets, paths, blast radius, reverse dependencies, and candidate tests
```

Real output includes counts, copyable follow-ups, explicit limits, and omission counts. It does not pretend omitted context was analyzed.

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

Structured output carries the underlying changed files, symbols, graph edges, reasons, diagnostics, snippets, and candidate-test confidence instead of requiring a caller to parse this display text.

## Why Codegraph

### Spend context on the problem, not repository discovery

One bounded `explore` response can combine ranked anchors, relevant source, dependency paths, blast radius, candidate tests, and next commands. The agent gets an evidence-backed starting point without first dumping the tree or repeatedly guessing which files to open.

### Ground the next action

Results carry source paths, symbol ranges, stable handles, rank reasons, graph relationships, confidence, and omission counts. An agent can inspect why something ranked, jump to the definition or references, and continue from an exact target instead of treating a fuzzy match as an answer.

### Reuse one map from discovery through review

Search, navigation, dependency analysis, impact, and review share the same graph and semantic index. The target found during discovery can flow directly into `explain`, `refs`, `deps`, impact analysis, and candidate-test selection.

### Work across the repository an agent actually has

Source code, SQL, workspace packages, documentation links, stylesheets, templates, and single-file components can participate in one repository model. Capability claims remain language-specific, so graph support is not presented as full compiler or language-server parity.

### Keep the evidence local and reusable

Codegraph runs locally through a CLI, library, or MCP server. People can read pretty output; agents and programs can keep structured JSON, stable handles, warm sessions, SQLite data, or graph exports without parsing display text.

## Why not just grep or an LSP?

Codegraph complements both.

- Use text search for exact strings, logs, config keys, and prose.
- Use a compiler or language server when you need compiler-grade type analysis, overload resolution, dynamic dispatch, or editor refactors.
- Use Codegraph when the question crosses files, languages, dependency edges, a git diff, or an agent context boundary.

The useful distinction is evidence shape, not a claim that one tool replaces every other tool.

## Agent setup

The installer can configure Codegraph-owned MCP entries, bundled skills, and marker files while preserving unrelated client configuration:

```bash
codegraph install --target codex,claude --dry-run
codegraph install --target codex,claude --yes
codegraph install --print-config codex
```

Supported `--target` ids are `codex`, `claude`, `cursor`, `gemini`, `opencode`, and `agents` (universal agent skills). Writes require `--yes`; `--dry-run` previews every change, and uninstall removes only Codegraph-owned content.

For a skill without MCP configuration:

```bash
codegraph skill install --agent codex
codegraph skill install --agent claude
codegraph skill install --agent cursor
```

See [Agent workflows](./docs/agent-workflows.md) for exploration strategy, warm sessions, streaming, review loops, and tool wrappers. See [MCP](./docs/mcp.md) for server and client configuration.

## Language support

**Shared source-language indexing and navigation:** JavaScript, TypeScript, Python, PHP, Go, Java, C#, Ruby, Rust, Kotlin, Swift, Zig, C, and C++.

**SQL:** statement chunking, object symbols, common DDL/DML and CTE facts, SQL-to-SQL edges, and object-level navigation. Codegraph does not claim column-definition resolution.

**Graph-first formats:** HTML, Astro, Handlebars, Markdown, MDX, reStructuredText, AsciiDoc, CSS, SCSS, and Less have narrower graph or chunking support.

**Single-file components:** Vue and Svelte script blocks participate in dependency graphs and chunking; semantic navigation is narrower.

See [Language parity](./docs/language-parity.md) for the capability matrix and [Scenario catalog](./docs/scenario-catalog.md) for the fixtures behind those claims.

## Using as a library

Use the TypeScript API when another program needs structured results or a warm, reusable session:

```ts
import { buildProjectIndex, analyzeImpactFromDiff } from "@lzehrung/codegraph";

const root = process.cwd();
const index = await buildProjectIndex(root, { native: "auto" });

const impact = await analyzeImpactFromDiff(root, index, {
  provider: "git",
  base: "HEAD",
  head: "WORKTREE",
  detectBreakingChanges: true,
});

console.log(impact.changedSymbols, impact.impacted);
```

Keep structured fields until the final UI or prompt boundary. Repeated callers should prefer one warm `createCodeReviewSession()` or agent/MCP session; see the [Library API reference](./docs/library-api.md) for exports, session lifecycle, streaming, graph APIs, and review reports.

The public surface also includes `buildReviewReport`, `analyzeImpactStreaming`, and `tool_impactJSON` for specialized review and integration workflows. Batch output can retain ranked top impacts and full report metadata; streaming callers can choose a lighter terminal summary after consuming incremental chunks.

The root export includes compatibility APIs; documented subpath facades provide narrower imports. See the [public API boundary](./docs/library-api.md#public-api-boundary) before choosing an import path.

## How it works

Codegraph follows a single analysis pipeline:

1. Discover supported files under the selected project and include roots.
2. Parse source languages with Tree-sitter and extract imports, exports, definitions, bindings, and scopes.
3. Resolve module specifiers to project files or explicit external nodes.
4. Build forward and reverse dependency indexes plus a semantic symbol index.
5. Reuse those indexes for navigation, exploration, impact, review, and exports.

The native addon accelerates the normal Tree-sitter path; it is not a separate analysis model. Compatible disk caches and long-lived sessions avoid repeating unchanged work. [How it works](./docs/how-it-works.md) covers discovery, resolution, caching, recovery, and performance choices in detail.

## Limits and tradeoffs

The honest boundaries matter:

- Codegraph is not a compiler or type checker. Reflection, generated code, macros, overload behavior, and dynamic dispatch can be missed.
- Precise navigation depends on successful parsing and language queries. Without a compatible native runtime, Codegraph falls back to reduced graph-only and regex recovery rather than claiming equivalent semantics.
- Call-compatibility findings are conservative review leads, not compiler diagnostics.
- Duplicate matches and candidate tests are ranked leads that still require human or agent judgment.
- `--fast-graph` is an explicit speed/accuracy tradeoff for plain JavaScript and TypeScript import extraction.
- The checked benchmark fixtures demonstrate bounded evidence retrieval, not universal speed, cost, or quality advantages. See [Benchmark methodology](./docs/benchmarks/README.md).

Run `codegraph doctor` to confirm the active runtime. Use `--report` on graph, index, or review commands when backend and cache behavior need to be auditable.

## Documentation

README is the landing page. The detailed contracts live here:

- [Installation](./docs/installation.md): install paths, requirements, native artifacts, and reduced mode
- [CLI reference](./docs/cli.md): commands, flags, output formats, graph export, and SQLite schema
- [Vectorless search](./docs/search.md): lexical ranking, symbol and graph context, modes, strengths, and limits
- [Agent workflows](./docs/agent-workflows.md): explore, orient, packets, sessions, streaming, and review loops
- [MCP](./docs/mcp.md): server setup, clients, tools, and safety model
- [Library API](./docs/library-api.md): exports, types, sessions, streaming, and programmatic analysis
- [How it works](./docs/how-it-works.md): discovery, parsing, resolution, caching, and performance
- [Language parity](./docs/language-parity.md): per-language capability matrix and limitations
- [Scenario catalog](./docs/scenario-catalog.md): fixtures and regression coverage for language claims
- [Benchmarks](./docs/benchmarks/README.md): reproducible methodology, checked results, and limitations
- [Adding language support](./docs/adding-language-support.md): implementation and review checklist
- [Publishing](./PUBLISHING.md): release and native artifact workflow

## Contributing

```bash
npm install
npm run build
npm run check
```

Use the narrowest relevant test while iterating. `npm run check` is the pre-commit baseline for formatting, lint, build, and tests; native workspace changes also require `npm run build:native` and `npm run test:native`.

Codegraph is MIT licensed.
