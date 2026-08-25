# CLI Reference

Assume the CLI is available as `codegraph`.

For a source checkout of this repo, replace `codegraph` with `node ./dist/cli.js` (or `node ./dist/bin/cli.js` for the published bundled bin entry).

If the CLI is not installed yet, use the install paths in [docs/installation.md](./installation.md). Do not use the unscoped `codegraph` package name.

## Entry and help

Bare `codegraph` prints concise task-oriented help and exits without reading project config or building an index. Use `codegraph --help` or `codegraph help` for the full command catalog, and `codegraph help <command>` or `codegraph <command> --help` for command help.

Unknown commands, invalid command arguments (including unknown flags/options and unresolvable positional roots), and noninteractive installer writes without `--yes` all exit with status 2. Unknown commands also print up to three deterministic suggestions and may print one task route. They never guess and execute a command.

CLI commands default to human-readable stdout; `--pretty` remains an explicit equivalent. Use `--json` for structured automation output, or a format-specific option such as `--compact`, `--mermaid`, `--dot`, or `--sqlite` where supported. If `--json` and `--pretty` are both present, `--json` wins. Commands that ignore structured output, including `viewer` and `mcp`, reject `--json`/`--pretty`. Global `--version --json` and `version --json` remain supported.

Unhandled failures print a concise error message by default. Set `CODEGRAPH_DEBUG=1` or pass `--debug` to include a stack trace.

The `graph` command without output-format flags writes Mermaid to stdout. Use `--json`, `--dot`, `--sqlite <path>`, or `--output <path>` for explicit graph artifacts.

Numeric options such as `--limit`, `--threads`, `--depth`, `--max-refs`, and token bounds must be integers in their documented ranges; invalid numeric values fail instead of being silently clamped or ignored.

## Exit codes

- `0`: the command completed and reported no failure condition. Commands that return an empty result normally, such as `search`, still use `0`.
- `1`: valid input produced a finding, no matching target, or a runtime or analysis failure. `links` uses `1` for broken local links; `drift` uses it when its selected policy fails; `goto`, `refs`, `deps`, `rdeps`, `path`, `dumpmod`, `file`, and `packet` use it when they cannot resolve the requested target; and `chunk` uses it for an unsupported language.
- `2`: invalid usage or input, including an unknown command or flag, invalid option values, incompatible flags, unresolvable positional roots, and installer writes without `--yes`.

Automation must treat `1` as a completed command with actionable output, and `2` as an invocation error.

Default workflow:

- code review: `codegraph review`
- blast-radius follow-up: `codegraph impact --base HEAD --head WORKTREE`
- unfamiliar repo: `codegraph explore "how does auth reach db?" --root .`
- first-turn map: `codegraph orient --root . --budget small`
- targeted follow-up: `codegraph search "<query>" --json` then `codegraph explain <handle|file|symbol>`

## Cache location

Index caches store project-relative paths, so a cache can be moved with its project. Cache selection precedence is `--cache-dir`, `CODEGRAPH_CACHE_DIR`, `cache.location` in project config (then user config), repository metadata, then the project root. `cache.location` accepts `project`, `repo`, `user`, or an absolute path; `--root` remains the project scope boundary. A configured anchor (`--cache-dir`, `CODEGRAPH_CACHE_DIR`, or an absolute `cache.location`) that resolves to the home directory or a filesystem root is rejected with an error instead of being used.

## Runtime selection

The CLI defaults to `--native auto`, which uses the native Tree-sitter path when a compatible native artifact is available and falls back automatically otherwise.

- `--native on`: require native explicitly and fail if it is unavailable
- `--native off`: disable native explicitly and run reduced graph-only and regex recovery mode

Reduced-accuracy runs are never silent: `graph` and `index` print a one-line `Backend:` warning on stderr whenever the native addon is unavailable or files fell back to regex extraction, independent of `--progress`, and `graph --json` / `index` structured output carries an `analysis` object (`mode`, `backend`, `label`, and fallback file counts) so automation can tell `semantic`, `mixed`, and `reduced` runs apart.

## Index and cache guidance

Current-state, index-backed commands validate freshness automatically and default to the on-disk cache. The first query for a project may build the index; interactive progress is written to stderr, leaving JSON stdout parseable. Later commands with the same `--root`, discovery configuration, graph options, and compatible build options reuse disk state under `.codegraph-cache/index-v1`, updating incrementally when files changed and rebuilding when compatibility cannot be established.

`codegraph index` and `codegraph sync` prewarm or repair that state; they are not prerequisites for `deps`, `refs`, `inspect`, `impact`, `review`, or any other current-state query. Artifact production (`graph`, `artifact`), lifecycle commands, and historical comparisons (`drift`, `graph-delta`) keep explicit build and range semantics instead.

Use `--cache disk` for reuse across CLI processes, `--cache memory` for reuse within one process, and `--cache off` for a deliberate cold run. `--cache-verify` validates manifest entries before reuse and `--cache-strict` adds content hashing plus full rediscovery; both trade speed for certainty. `codegraph init` is optional lifecycle metadata plus cache warmup; query commands do not require `.codegraph/manifest.json`.

Lifecycle exceptions (`src/cli/options.ts` `LIFECYCLE_BUILD_OPTIONS` / `STATUS_BUILD_*`): `init`/`status`/`sync` omit `--cache` because they always use the disk cache path. `status` also omits `--cache-verify`, `--progress`, `--no-progress`, `--workers`, and `--threads` because it only hashes config/build options and lists project files for signature hashing (no index build).

Keep `--root` stable for repeat queries. Use `--progress` to force redirected progress logs, `--no-progress` to suppress them, and `codegraph doctor` or `--report` when backend or cache behavior needs diagnosis.

## Project config

Commands that scan a project read `codegraph.config.json` from `--root` when it exists. The current config surface is intentionally small:

```json
{
  "discovery": {
    "includeGlobs": ["src/**/*.ts"],
    "ignoreGlobs": ["tests/samples/**", "tests/languages/samples/**"],
    "useGitignore": true
  },
  "languages": {
    "extensions": {
      ".tpl": "php",
      ".inc.php": "php",
      ".build.ts": "ts"
    }
  }
}
```

- `discovery.includeGlobs` and `discovery.ignoreGlobs` are project-root-relative, even when a command scans child include roots.
- Default discovery already ignores common dependency and build trees: `node_modules/`, `.git/`, `.codegraph/`, `.codegraph-cache/`, `dist/`, `build/`, `target/` (Java/Kotlin/Rust), Python `.venv/`/`venv/`/`site-packages/`/`__pycache__/`, Ruby `vendor/bundle/`, Swift `.build/`, and CocoaPods `Pods/`. Bare `vendor/`, `env/`, `bin/`, and `obj/` stay discoverable because they are ambiguous across ecosystems; add them through `discovery.ignoreGlobs` when needed.
- `discovery.ignoreGlobs` is for additional large fixture, generated, or vendored folders that should not be indexed.
- `discovery.includeGlobs` can re-include a default-ignored tree when you intentionally want that path indexed (for example `vendor/bundle/**`). User `ignoreGlobs` and `.gitignore` still apply.
- `languages.extensions` maps additional or built-in literal suffixes to supported language IDs; keys must start with `.` and may contain letters, digits, `.`, `_`, `+`, and `-`, values must name a supported language, and the longest suffix wins.
- Built-in suffixes remain active unless explicitly remapped by `languages.extensions`; `.vue` and `.svelte` are always handled as single-file components and cannot be remapped.
- CLI `--include-glob` and `--ignore-glob` values are one-off additions relative to each scanned root.
- `inspect` follow-up commands preserve the selected `--root` and include roots.
- `--no-gitignore` overrides `useGitignore`.

Config globs and one-off CLI globs apply at different layers. `codegraph.config.json` globs are durable and project-root-relative. CLI scan-root globs are additive for a single command and are evaluated relative to each active scan root. `--no-gitignore` disables `.gitignore` filtering for that command only; it does not change config.
Configured language extensions automatically extend discovery for matching files and participate in cache compatibility checks. Reusing a project root lets commands share compatible index and graph entries when the file signatures, config, graph options, and relevant build options still match. Changing `--root`, changing discovery or language-extension config, or changing graph options creates a different reuse boundary. Child include-root scans can reuse project-root cache entries, but command summaries and follow-up commands stay scoped to the selected include roots.

## Core commands

### Forgiving inputs and safe defaults

The CLI accepts the shortest unambiguous form across command families; explicit flags remain supported:

- Project commands default to the current directory. `apisurface`, `graph-delta`, `review`, and `unresolved` also accept an existing project directory positionally; scan commands already accept positional roots.
- File targets accept `file:line[:column]` locations copied from search output. `file` uses the line as its default offset; `chunk`, `deps`, `rdeps`, `path`, `dumpmod`, `packet`, and `explain` ignore the location suffix when they only need a file.
- `goto` and `refs` accept exactly one navigation form: `file:line:column`, separate positional coordinates, a portable symbol handle, or a coordinate-free qualified `file::symbol` path. Do not combine a qualified path with line or column inputs. With only a file, `refs` returns references for every definition; `goto` resolves a single-definition file or returns candidate locations instead of guessing.
- `callers`, `callees`, `supertypes`, `subtypes`, `implementations`, `rename-preview`, and `refactor-plan` accept a portable handle, a unique exact symbol name, a single-definition file, or `file:line[:column]`. Ambiguous names return copyable handle choices.
- `grep <regex>` defaults to text regex search; Tree-sitter queries remain explicit with `--query`. Equivalent aliases: `--pattern` / `--regex` for the search expression. Filter with `--glob`, `--include-glob`, `--ignore-glob`; bound text hits with `--max-hits` (default 5000, max 200000); case-insensitive with `-i` / `--ignore-case`. `sql <db> "SELECT ..."` is equivalent to `--db/--query`.
- `artifact`, `packet`, and `mcp` infer their only subcommand (`build`, `get`, and `serve`). `impact` and git-backed `drift` default to `HEAD..WORKTREE` while accepting explicit ranges.

These defaults never approve writes silently: interactive installer changes require a preview and confirmation, noninteractive changes require `--yes`, rename/refactor commands remain read-only, and ambiguous semantic targets are never selected automatically.

### Dependency graphs

```bash
# Fast code-review handoff for current local edits
codegraph review
codegraph impact --base HEAD --head WORKTREE

# First-pass repo summary and next-step suggestions
codegraph orient --root . --budget small
codegraph inspect ./src --limit 20

# Whole-repo Mermaid graph on stdout (the default)
codegraph graph ./

# Explicit structured graph output
codegraph graph ./ --json

# Opt-in text specifier shortcut for plain .js and .ts files
codegraph graph ./src --fast-graph

# Default extraction (Tree-sitter for supported source languages)
codegraph graph ./src

# Build a dependency graph from multiple roots
codegraph graph ./src ./packages/app ./packages/lib --mermaid > graph.mmd

# Parent folder containing separate child git repositories
codegraph graph --root ~/work billing-service shared-ui --json

# Graph-first document and template edges also participate for HTML, Astro,
# Handlebars, Markdown, MDX, reStructuredText, and AsciiDoc local links,
# plus MDX and Astro static imports

# Narrow scanned files and exclude generated files while preserving .gitignore
codegraph graph --root . ./src --include-glob "**/*.ts" --ignore-glob "**/*.spec.ts" --json

# Disable .gitignore filtering when ignored or generated files are intentionally in scope
codegraph graph --root . ./src --no-gitignore --json

# Mermaid output
codegraph graph ./src --mermaid

# Detailed symbol graph
codegraph graph ./src --symbols-detailed --json

# Include detailed SQL statement facts in JSON graph output
codegraph graph --root . --sql-artifacts --json

# SQLite export
codegraph graph --sqlite ./codegraph.sqlite

# Stable sorted JSON for golden tests / byte-identical diffs
codegraph graph --root . ./src --json --stable

# Capture graph stderr (backend warnings, progress) to a file
codegraph graph --root . ./src --json --stderr-file graph.stderr.log

# Project lifecycle marker and cache warmup
codegraph init --root .
codegraph status --root . --json
codegraph sync --root .
codegraph uninit --root . --force

# Build and report diagnostics
codegraph graph --report
codegraph index --report
codegraph review --report --report-file review.report.json
codegraph search "query" --report --report-file search.report.json
codegraph inspect ./src --report --report-file inspect.report.json
```

`inspect` emits bounded hotspots, unresolved imports, and cycles. Add `--duplicates` to include a bounded high-confidence duplicate summary; run the recommended `duplicates` command for full grouped JSON.

Graph, index, search, inspect, and review reports include `backend.native.byLanguage` so native usage and fallback remain visible per language. Build reports also include `backend.parser` when syntax-tree backend degradation leaves files without parser context. Reports also include `graph.fallbackImportExtraction.byLanguage` and `byReason` when regex import extraction is used. Search and inspect timing reports contain command totals and the underlying index build report without changing normal stdout. Review JSON reports `diagnostics.symbolMappingParseFailures`, `diagnostics.missingFiles`, `changedFiles[].status` as `updated`, `deleted`, or `missing`, and `sqlContext` when changed SQL files or changed SQL literals make SQL artifact facts relevant.

### Project lifecycle

- `init` creates `.codegraph/manifest.json`, warms the existing disk cache through the index build path, and is idempotent when the manifest is current. Use `--force` to rebuild and overwrite the manifest metadata.
- In a Git worktree, `init` first checks Git's effective ignore policy for `.codegraph/manifest.json` and `.codegraph-cache/`. If either is untracked and not already ignored by root/parent rules, negations, `.git/info/exclude`, or global excludes, it appends the missing `.codegraph/` and/or `.codegraph-cache/` rules to the resolved project root's `.gitignore`; use `--no-update-gitignore` to opt out.
- A tracked manifest is left tracked and the ignore policy is unchanged. Non-Git projects remain supported without creating `.gitignore`, and directory or symlink `.gitignore` paths fail before manifest creation with guidance to replace the path or opt out.
- `status` reports whether lifecycle metadata exists, last sync time, then/current file counts, per-file content drift (files changed even when counts match, e.g. edits in place or N files swapped for N others), config/build-option drift, analysis label, and the suggested next command. Use `--json` for `schemaVersion: 1`.
- `sync` refreshes the manifest after edits and requires an initialized project unless `--init` is passed. `sync --init` performs the same ignore preparation and accepts `--no-update-gitignore`; ordinary `sync` never changes ignore policy.
- Initializing JSON results add an optional `gitignore` object with `.gitignore` path and `added`, `already-ignored`, `tracked`, `not-git`, or `disabled` status. The lifecycle manifest schema remains unchanged.
- `uninit` removes only recognized lifecycle state by default and leaves any root `.gitignore` rule in place. It refuses unknown `.codegraph/` entries unless `--force` is passed.
- Lifecycle commands accept either a positional project path or `--root <path>`. They reject using both together because lifecycle manifests and automatic ignore updates always use one resolved project boundary, not include-root subsets.

### Affected tests

- `affected` maps changed source files to likely test files by traversing reverse dependencies through the project graph. It also includes directly changed test files at depth 0.
- Inputs can be positional files, newline-delimited `--stdin`, or a Git range with `--base <ref> --head <ref>`. Paths are normalized under `--root` and output as project-root-relative paths.
- Use `--depth <n>` to expand transitive reverse dependencies, `--filter <glob>` to restrict returned test paths, `--quiet` for path-only output, or `--json` for `schemaVersion: 1`, `changedFiles`, `affectedTests`, and `omittedCounts`.

```bash
codegraph affected src/auth.ts src/db.ts
codegraph affected --stdin --quiet
codegraph affected --base main --head HEAD --json
codegraph affected --base HEAD --head WORKTREE --filter "tests/**/*.test.ts" --quiet
```

### Symbols, navigation, grep, and chunking

```bash
# Build the full project index
codegraph index

# Print full JSON index including locals, imports, and exports
codegraph index --json

# Force a full rebuild instead of incremental reuse
codegraph index --full

# Emit verbose index build diagnostics on stderr
codegraph index --verbose

# Use concurrency and incremental cache
codegraph index --threads 8 --cache disk

# Enable worker threads for parallel native extraction
codegraph index --workers --threads 8 --cache disk

# Search for agent-ready anchors across symbols, paths, chunks, SQL objects, and graph context
codegraph orient --root . --budget small
codegraph orient --root . ./src --budget medium --json
codegraph explore "how does auth reach db?" --root .
codegraph explore src/auth.ts --json
codegraph search "build review report" --json
codegraph symbols "CodeReviewSession" --root .
codegraph symbols "review report" --kind class,function --exported --limit 50 --json
codegraph callers 'symbol:src/service.ts:run:5:3' --depth 2 --limit 100 --json
codegraph callees 'symbol:src/worker.ts:process:12:14' --depth 3
codegraph supertypes 'symbol:src/worker.ts:Worker:12:14' --depth 3
codegraph subtypes 'symbol:src/service.ts:Service:4:18' --depth 3 --limit 100 --json
codegraph implementations 'symbol:src/service.ts:run:5:3' --limit 100 --json
codegraph rename-preview 'symbol:src/Service.ts:Service:1:14' RenamedService --include-filenames --json
codegraph refactor-plan 'symbol:src/Service.ts:Service:1:14' --rename RenamedService --max-references 200
codegraph explain src/review.ts --json
codegraph packet get src/cli.ts
# Read a live file; readable numbered lines are the default
codegraph file src/cli.ts
codegraph file src/cli.ts --offset 201 --limit 100 --max-bytes 40000

# Add direct importers, imports, and symbols only when needed
codegraph file src/cli.ts --include-graph-context --json

codegraph search "public users" --mode sql --json
codegraph search "handle login" --from src/auth.ts --mode graph --depth 1 --json
codegraph search --help

`symbols` performs deterministic symbol-identity lookup, unlike hybrid `search`, which also ranks paths, prose, SQL, snippets, and graph evidence. Exact qualified names such as `src/session.ts::CodeReviewSession` rank before exact local/export names, prefixes, identifier tokens, and substrings.

Use `--kind <kind,...>`, `--exported`, `--include-imports`, `--file-glob <project-relative-glob>`, and `--limit <0-500>` to compose filters. Imports are excluded by default, the default limit is 50, and an empty query requires `--kind` or `--file-glob`; concise pretty output is the default and `--json` returns the structured envelope.

`search --no-snippets` keeps ranked matches and metadata while omitting source snippets from each result. This is useful when a caller needs handles and paths but will fetch bounded live source separately with `file`.

Structured results include `schemaVersion`, root and analysis metadata, freshness, effective limits, omission counts, the normalized query, total candidates, and deterministic project-relative symbols. Resolvable named/default import aliases keep their binding location but carry a handle for the declaration; namespace/star aliases, unresolved aliases, and failed import scans are reported under `omittedCounts`.

Line-and-column navigation remains primary: use `<file>:<line>:<column>` with `goto` or `refs` when the source location is known. An exact qualified path, `<project-relative-file>::<local-symbol>`, is the coordinate-free alternative for one declaration. `deps` and `rdeps` accept either file form, then traverse the defining file's dependency edges; use `callers` or `callees` for symbol-level call relationships. If one file defines multiple declarations with the same local name, codegraph returns candidates and requires the portable handle from `symbols` to avoid guessing.

`callers` and `callees` accept one portable function or callable-member handle from `symbols`. Depth defaults to 1 and caps at 5; the symbol limit defaults to 100 and caps at 500, while callsites are grouped under each related symbol and bounded separately.

Pretty symbol and callsite rows are the default. `--json` reports exact project-relative callsites, provenance, freshness, and separate symbol, callsite, and unresolved-site omissions; `--include-heuristic` is accepted, but current results remain limited to resolved semantic `calls` edges rather than guessed dynamic calls, file dependencies, imports, or references.

`supertypes` and `subtypes` accept one portable symbol handle from `symbols`, default to depth 1 and 100 results, cap depth at 10 and results at 500, and return only proven indexed `extends` and `implements` relationships. `implementations` uses the same 100/500 result bounds without `--depth`; supported targets are interfaces, traits, abstract types, and members with proven implementation or override relationships.

Implementation entries identify the exact implementing declaration, inherited declarations are deduplicated, and unresolved overload identity is reported as unsupported instead of guessed. JSON includes the shared semantic envelope, exact project-relative symbol and available relation-site locations, provenance, effective limits, and omission counts; `--pretty` prints concise relationship rows and actionable errors.

`rename-preview` accepts a portable symbol handle and new identifier. Optional `--include-comments` and `--include-strings` add low-confidence textual edits; `--include-filenames` requests a suggestion for an eligible exported class, interface, or type whose filename matches its name, and `--max-edits <1-10000>` bounds returned edits.

Pretty rename summaries are the default. `--json` reports exact project-relative edits, conflicts, unsafe sites, candidate tests, freshness, provenance, and omissions. A limited or conflicting result has `safe: false`; filename results are suggestions only, the command never changes files, and no apply command exists.

`refactor-plan` accepts a portable handle from `symbols` or `search`, or an exact internal changed-symbol handle from review or impact output. It composes the target definition, references, direct callers and callees, type relationships, implementations, section issues, candidate tests, omissions, and copyable follow-ups from one snapshot; `--include-source` opts reference context into JSON.

Use optional `--rename <new-name>` to include the authoritative nested rename preview. `--max-references`, `--max-callers`, and `--max-hierarchy` are independent `0-500` bounds; pretty output summarizes counts, safety, and section issues by default; `--json` returns the complete structured packet, and neither mode changes source or exposes an apply command.

# Explain a file, symbol, SQL object, or search result handle
codegraph explain src/auth.ts --json
codegraph explain validateUser --json
codegraph explain public.users --json
codegraph explain src/large-file.ts --max-symbols 25 --json
codegraph explain --help

Use `explain --changed-context` when the target comes from a changed-file or review workflow and you need bounded source context around changed ranges in the structured response.

# Build an agent-ready artifact bundle
codegraph artifact --root . --out codegraph-out --json
codegraph artifact --sqlite --root . --out codegraph-out --json
codegraph artifact --root . --out codegraph-out --sqlite --graph-json --report --questions --force --json


# Serve MCP tools over the same search, navigation, artifact, and review layer
codegraph mcp --root . --stdio
codegraph mcp --root . --artifact codegraph-out --stdio
codegraph mcp --root . --stdio --allow-build
codegraph mcp --root . --stdio --idle-timeout-ms 1800000
codegraph mcp --root . --port 7331
codegraph mcp --root . --stdio --warmup
codegraph mcp --root . --port 7331 --warmup-symbols

# Install or preview agent client integration
codegraph install --target codex,claude --dry-run
codegraph install --target codex,claude --yes
codegraph install --target codex --yes --force
codegraph install --all --dry-run
codegraph install --all --yes
codegraph install --print-config codex
codegraph uninstall --target codex --yes
codegraph install --help

# Chunk a file for LLM processing
codegraph chunk src/utils.js

# Output text chunks as JSON
codegraph chunk package.json --text --max-tokens 200

# Override language detection and token limits
codegraph chunk config.yaml --language yaml --min-tokens 100 --max-tokens 300

# Detect duplicate and near-duplicate code units
codegraph duplicates --root . ./src --profile cleanup
codegraph duplicates --root . ./src ./packages/app --include-same-file
codegraph duplicates --root . ./src --ignore-glob "tests/**" --ignore-glob "docs/**"
codegraph duplicates --root . ./tests --ignore-root-glob "tests/languages/**"
codegraph duplicates ./src --json --sort reduced-lines
codegraph duplicates ./src --json --raw-pairs
codegraph duplicates --help

# Compare architecture drift between git refs
codegraph drift ./src --base origin/main --head HEAD --graph-edges summary --public-api removals
codegraph drift ./src --base origin/main --head HEAD --json
codegraph drift ./src --base origin/main --head HEAD --fail-on new-cycle,public-api-removal
codegraph drift --base-artifact ./baseline/codegraph-out --head . --json

# Go to definition
codegraph goto <file>::<symbol>
codegraph goto <file>:<line>:<column>

# Find references
codegraph refs <file>::<symbol>
codegraph refs <file>  # all symbols in the file
codegraph refs <file>:<line>:<column>

# Run a Tree-sitter query across the repo
codegraph grep --query '(function_declaration name: (identifier) @name)'

# Run a plain-text regex grep across the repo
codegraph grep 'eval\(' --ignore-case
```

`grep --json` does not return a bare hit array; it returns an envelope `{ items, limit, totalSeen, truncated, omitted }` so callers can tell a complete result from a capped prefix. `limit` always means the effective cap that was applied: for text greps it is the effective `--max-hits` value (default 5000, capped at 200000), and for uncapped `--query` AST greps it is `null`. `truncated` is exact for text greps (the scan probes one hit past the effective limit, so a true count equal to the limit still reports `truncated: false`, including at the 200000 ceiling) and is always `false` for AST greps today. When text results are truncated, `totalSeen` and `omitted` are lower bounds from the bounded probe, not full corpus-wide counts. Human-readable grep output stays a plain streamed hit list.

### MCP protocol and network boundary

codegraph uses the official MCP SDK v2 to serve current 2026-07-28 clients while retaining compatibility with 2025-era clients. MCP protocol connections and HTTP protocol sessions keep separate transport state, but all share the server's one warm codegraph analysis session for the configured root.

If an MCP transport or startup call fails, run `codegraph doctor`, use the equivalent CLI command for that session, and restart the agent client after package upgrades instead of retrying a broken long-lived server. Published CLI bundles keep the MCP runtime self-contained so an in-place upgrade cannot remove a lazy chunk that a running server has not loaded yet.

HTTP enforces Host and Origin policies. A missing `Origin` is accepted for non-browser clients; unapproved, malformed, and opaque origins are rejected. This is not authentication: binding `--host` to a non-loopback address exposes an unauthenticated endpoint intended only for trusted networks or containers.

### Viewer

`viewer` is a human-only UI; use graph JSON, SQLite, MCP, or `--json` for agent and program interfaces. Its contract is `codegraph viewer [--root <root>] [--graph <root-confined-json>] [--host <host>] [--port <0-65535>] [--open] [--print-url]`, with the current directory, `127.0.0.1`, and `4173` as the default root, host, and port. `--print-url` is preview-only: it prints the deterministic URL and exits without starting a server, rejects `--open`, and rejects port `0`.

```bash
codegraph viewer --root . --open
codegraph viewer --root . --graph codegraph-out/graph.json --open
codegraph viewer --root . --port 4173 --print-url
```

Without `--graph`, each UI load or reload builds the current project graph through the automatically validated `.codegraph-cache` index; `init`, `index`, and exported JSON are not prerequisites. An explicit `--graph` is served through the same `/graph.json` route, and manual upload remains available. The viewer loads Sigma, Graphology, and ForceAtlas2 from bundled `docs/graph-visualization/vendor/` assets, so the UI stays offline and self-contained once codegraph is installed.

`review`, `goto`, `refs`, `dumpmod`, `deps`, `rdeps`, `path`, `cycles`, `unresolved`, `apisurface`, `inspect`, `hotspots`, `duplicates`, `impact`, and `affected` load current repository state through one shared policy: they validate the on-disk manifest, reuse it when inputs are unchanged, and update incrementally otherwise. Review and impact diff selectors (`--base`, `--head`, and `--changed-since`) choose changed files but do not narrow index freshness; pass `--cache off` for an exhaustive uncached rebuild, or `--cache memory|disk` to select a cache explicitly.

`duplicates` emits one-line triage summaries by default, or grouped exact, renamed, near, and weak clone candidates as JSON with `--json`.

- It combines indexed symbols, semantic chunks, text chunks, token fingerprints, and AST shape hashes when parser context is available.
- Pretty output is the default.
- `--profile cleanup` and `--profile refactor-roi` are aliases for cleanup triage defaults. In pretty mode they default to `--sort reduced-lines`; in JSON mode they keep similarity order unless `--sort` is explicit. Both profiles also default `--min-confidence medium` and `--min-tokens 80`, and they suppress groups labeled `import-list-noise` or `barrel-export-noise`.
- Pretty output includes reduced lines, estimated reducible lines, cleanup labels, cluster counts, and a compact summary footer. Use `--no-summary` to suppress the footer.
- `--sort actionability` remains the default in pretty mode outside the cleanup profile.
- JSON output emits `schemaVersion: 3`.
- JSON reports project-relative paths, confidence, clone type, metrics, `reducedLines`, `estimatedLinesSaved`, local `locations`, optional transitive `cluster`, omission counts, and pair stats.
- JSON defaults to similarity ordering unless `--sort` is explicit.
- Groups collapse overlapping symbol/chunk variants so one underlying clone appears as one finding.
- A single positional directory becomes the project root unless `--root` is set. `orient` is the exception: its positionals are always include roots.
- Use `--root . ./src` for scoped scans with repository-relative paths.
- Positional paths are scan roots, not glob patterns.
- `--include-glob` and `--ignore-glob` are relative to each active scan root.
- `--include-root-glob` and `--ignore-root-glob` are duplicates-only project-root-relative one-off filters.
- Zero-match scan-root glob warnings explain the scan-root-relative interpretation and suggest likely replacements when a root-prefixed pattern misses under an include root.
- Use `--include-small` for tiny helpers.
- Use `--include-same-file` for non-overlapping clones inside one file.
- Use `--json` for stable machine consumption.
- Use `--raw-pairs` when debugging low-level pair evidence. `--pretty --raw-pairs`, `--sort actionability --raw-pairs`, `--sort reduced-lines --raw-pairs`, and `--profile cleanup --raw-pairs` are rejected.

Short JSON shape:

```json
{
  "schemaVersion": 3,
  "groups": [
    {
      "primaryLeft": { "file": "src/a.ts", "startLine": 10, "endLine": 24 },
      "primaryRight": { "file": "src/b.ts", "startLine": 12, "endLine": 26 },
      "locations": [
        { "file": "src/a.ts", "startLine": 10, "endLine": 24 },
        { "file": "src/b.ts", "startLine": 12, "endLine": 26 }
      ],
      "reducedLines": 15,
      "estimatedLinesSaved": 15,
      "cleanupLabels": ["production-helper-extraction"]
    }
  ]
}
```

#### Agent orientation and packets

- Use `explore` first for a concrete repository question. It combines search anchors, bounded packets, dependency paths, reverse dependencies, candidate tests, limits, omissions, and follow-ups; use `--limit`, `--max-packets`, `--max-paths`, or `--no-source` to keep output small.
- Human-readable `explore` output ends with `Recommended next: <command>`, selected from the first bounded follow-up. JSON keeps the existing `schemaVersion: 1` response and `followUps` array without adding display prose.
- Use `orient` as the compact first-turn reading surface when no concrete question is available; it prints ranked `focus` targets and their follow-up commands before the scope sketch.
- Use `orient --json` when follow-up tools need exact focus reasons, limits, and omitted counts. Index feedback is stderr-only, so stdout remains parseable.
- Small orientation budgets default to `--health skip`. Medium and large default to `--health summary`, which counts cycles and unresolved imports while omitting duplicate health; use `--health full` when exhaustive duplicate counts matter.
- Use `packet get` with file paths, symbol names, SQL object names, file/symbol/chunk/SQL/graph handles, or review handles to retrieve bounded evidence plus follow-up commands.
- Agent commands and every current-state query default to disk cache and validate automatically; a whole-project `graph` or `index` run performs its explicit build. Use shared index flags such as `--cache`, `--cache-strict`, `--cache-verify`, `--threads`, `--native`, `--workers`, `--include-glob`, `--ignore-glob`, and `--no-gitignore` when the packet should match a specific scan mode.
- Commands that load the project index first report cache validation as `Checking project index`, then report build or update progress only when index work is required. Warm cache hits complete as `Checked project index` without claiming a rebuild. Use `--progress` for redirected progress logs or `--no-progress` to suppress feedback.

#### Live file views

`file <path>` reads the current file bytes from disk, independent of index freshness. The default human-readable view has a header, optional graph summary, exact numbered lines, and a copyable next-page command; pass `--json` for the structured pagination contract.

- `--offset <line>` is the 1-based first line and defaults to `1`. `--limit <lines>` is the maximum line count, defaults to `2000`, and is capped at `10000`.
- For raw file pages, `--max-bytes <bytes>` bounds unnumbered text including line separators before numbering; it defaults to `80000` and is capped at `500000`. A raw page can therefore end before `--limit`, and `truncated` is true when the boundary cuts a selected line.
- A separate 16 MiB hard input-size limit rejects larger raw reads and structural text-config summaries before unbounded I/O. It bounds complete-stream binary/UTF-8 validation and total-line counting, not the returned page size.
- `totalLines` counts the complete live file, not only the returned prefix. Follow `page.nextOffset` when present; an offset beyond the end returns empty `content` and `text` while retaining the exact total, and pretty output says `Lines: none at offset <offset> of <totalLines>`.
- `content` uses `lineFormat: "number-tab-line"`: an unpadded decimal line number, one tab, then the source line. `text` contains the same selected source lines without number prefixes.
- A trailing newline creates a final numbered empty line. For example, `alpha\nbeta\n` has `totalLines: 3`, and its last `content` line is `3\t`.
- `--include-graph-context` is explicit opt-in and adds up to 100 direct `usedBy` paths, imports, and symbols. Plain file reads do not build or consult the index; `freshness` describes indexed context separately and never changes the live bytes returned.
- Within the 16 MiB input limit, ordinary file reads and structural summaries for recognized environment, authentication, and credential text configs validate the full raw stream, rejecting known binary extensions, NUL bytes, and malformed or incomplete UTF-8 before returning bounded content or extracting bounded keys. Default key-material summaries instead use file metadata, may report size, and do not read raw secret bytes; `--allow-sensitive` requests raw values but does not bypass the input-size, binary, NUL, or UTF-8 guards, so `.p12` and `.pfx` bundles summarize by default and reject raw access. For text-config summaries, `truncated` reports an incomplete bounded structural scan.

The JSON response fields are `schemaVersion`, `file`, effective `offset` and `limit`, exact `totalLines`, numbered `content`, `lineFormat`, unnumbered `text`, `truncated`, and `freshness`. Optional fields are `page: { nextOffset }`, `graphContext: { usedBy, imports, symbols }`, and `sensitive: { kind, redacted, allowSensitiveRequired }`.

```json
{
  "schemaVersion": 1,
  "file": "src/cli.ts",
  "offset": 201,
  "limit": 2,
  "totalLines": 487,
  "content": "201\texport function run(): void {\n202\t  return;",
  "lineFormat": "number-tab-line",
  "text": "export function run(): void {\n  return;",
  "truncated": false,
  "freshness": { "state": "fresh" },
  "page": { "nextOffset": 203 }
}
```

An `explore` query that is only an indexed project-relative file path, such as `codegraph explore src/auth.ts --json`, adds this same live response as top-level `fileView`. A uniquely matching basename also resolves; `--no-source` suppresses the file view, while `--include-graph-context` and `--allow-sensitive` pass through explicitly.

`search` is deterministic and vectorless. Hybrid search is code-first by default: source symbols and implementation files outrank docs unless `--mode text` is explicit or docs are the strongest remaining evidence. Search JSON now includes top-level `analysis` metadata plus per-result `provenance` so mixed or reduced runs stay visible. `explain` resolves file paths, symbol names, SQL object names, and search handles into bounded packets with symbols, graph context, references, snippets, duplicate context, SQL facts, review tasks, candidate tests, analysis metadata, limits, omissions, and follow-ups. Use `--max-duplicates` to tune duplicate context in `explain` and `packet get`; duplicate context also uses an internal pair budget and reports skipped duplicate work through omission counts.

`explore` is a facade over existing primitives, not a second search engine. It returns `schemaVersion: 1`, the original query, `analysis`, summary bullets, anchors, packets, dependency paths, blast radius with per-entry omitted lower bounds, candidate tests, follow-ups, flat limits, and omission counts; path and blast-radius omissions may be lower bounds after bounded scans reach their caps.

For SQL, prefer handles or schema-qualified names when basenames may be ambiguous. Reference and snippet omission counts are lower bounds after bounded navigation reaches its cap.

#### Artifact bundles

- `artifact build` writes `codegraph.sqlite`, `graph.json`, `CODEGRAPH_REPORT.md`, `questions.json`, and `manifest.json` by default.
- Artifact suggested questions use unique IDs backed by stable handles when possible.
- Use artifact flags to select a subset.
- Use `--force` to replace recognizable stale codegraph artifacts while preserving unrelated files.
- Artifact contents exclude their own output directory and linked outside-root files.

#### Agent client installer

- `install` configures codegraph-owned MCP entries, bundled skill payloads, and marker files for supported local agent clients: `codex`, `claude`, `cursor`, `gemini`, `opencode`, `omp`, `kilo`, and `agents`.
- With neither `--yes` nor `--dry-run`, an interactive install detects targets, prints proposed actions and paths, and accepts only `y` or `yes`; blank input, EOF, interrupt, and every other answer decline without writing.
- `--all` selects the complete catalog in listed order without detection. It is install-only and conflicts with target selection, `--detect`, and `--print-config`.
- Noninteractive writes require `--yes`. Use `--detect` to list discovered targets, `--dry-run` to preview actions, or `--print-config <target>` to print a copyable MCP snippet without writing. JSON selection, confirmation, and collision failures return one structured stdout document without a stack trace. Pre-existing user-owned `SKILL.md` files are not overwritten unless the install ownership marker and known payload match, or `--force` is passed.
- Compatible canonical JSON MCP entries, the generic stdio form that omits only `type`, and equivalent unmarked Codex tables are preserved byte-for-byte. Kilo JSONC updates preserve comments and unrelated settings. Divergent codegraph entries are reported together as secret-free collisions without writing config; uninstall recognizes only strict installer-owned entries.
- If no target is detected, output lists supported targets, checked paths, and copyable `--all` preview/apply commands; JSON includes `installed: false` and `reason: "no-targets-detected"`.
- After a confirmed install, codegraph verifies owned state, reports bounded doctor health, and prints restart/reload plus first-query guidance. It does not claim the client connected.
- `uninstall` follows the same preview/confirmation rules and removes only codegraph-owned marker blocks, marker files, exact bundled skill payloads, or exact installer-owned MCP entries.
- `skill install` remains the lower-level primitive when you only want to copy the bundled skill directly without MCP config.

#### MCP server

- `mcp serve` exposes explore, navigation, search, read-only rename preview, impact, review, SQLite query, session refresh, and artifact-build tools.
- MCP uses stdio by default or Streamable HTTP with `--port <number>`. HTTP protocol sessions are activity-tracked, count-bounded, and idle-evicted; tool schemas reject unknown fields.
- `mcp` and `viewer` reject `--json`/`--pretty` because they do not emit structured command output.
- Startup is lazy by default; `--warmup` builds the base session cache before serving requests, and `--warmup-symbols` also builds the detailed symbol graph.
- Index-backed responses include `freshness`; small file changes auto-refresh, while stale responses include a reason, total changed-file count, and a bounded changed-file sample.
- Use `refresh_index` to force a rebuild, reset SQLite artifact state, or recover after stale change bursts.
- HTTP serves `/mcp`, validates Host headers, and binds to `127.0.0.1` unless `--host <host>` is passed.
- MCP file and artifact paths are confined to `--root` after realpath resolution.
- MCP tools are read-only by default; `--allow-build` enables artifact output only when the MCP index is fresh or auto-refreshed.
- `query_sqlite` is row- and byte-bounded, returns freshness metadata, rejects synthetic payload functions, and refuses stale artifact rows it cannot refresh safely.

- Restart or reload the owning MCP client after installation or a codegraph update. A running server keeps the version and tool surface captured at startup; use `codegraph doctor` from the same environment to diagnose running-versus-installed version and native state.
  See [docs/mcp.md](./mcp.md) for client configuration examples.

#### Chunking

`chunk` uses semantic Tree-sitter chunking for registered source and stylesheet languages, Vue and Svelte block-aware chunking for single-file components, and text chunking for JSON, YAML, and unsupported extensions. Use `--text` to force text chunking.

### Dependency analysis and diagnostics

```bash
# Dependencies of a file, defining symbol, or portable symbol handle
codegraph deps src/main.ts
codegraph deps src/main.ts::main
codegraph deps 'symbol:src/main.ts:main:12:1'

# Reverse dependencies of a file, defining symbol, or portable symbol handle
codegraph rdeps src/utils.ts
codegraph rdeps src/utils.ts::normalize
codegraph rdeps 'symbol:src/utils.ts:normalize:8:1'

# Shortest dependency path
codegraph path src/main.ts src/utils.ts

# Cycle detection
codegraph cycles --sort priority

# Public API surface
codegraph apisurface

# Unresolved imports
codegraph unresolved
codegraph unresolved --verbose

# Hotspots
codegraph hotspots ./src --limit 20
```

Cycle detection reports source dependency cycles. Document-only link loops, such as Markdown files linking to each other, remain in the graph for navigation but are not reported as dependency cycles.

Dependency read commands keep the same output contracts while using the indexed graph path and derived adjacency maps internally when available. This makes repeated `deps`, `rdeps`, and `path` reads cheaper on warm manifest-backed projects.

#### Markdown link validation

`links` validates links authored in Markdown files under the project root. It covers inline links, reference-style links and definitions, autolinks, and raw HTML `a[href]` links, resolving local targets relative to the source file; `/path` targets resolve from the project root. Discovery uses the same `codegraph.config.json` `discovery.ignoreGlobs` / `discovery.includeGlobs` settings and CLI `--include-glob` / `--ignore-glob` / `--no-gitignore` filters as other discovery-backed commands.

```bash
# Check Markdown links under the project root
node ./dist/cli.js links
node ./dist/cli.js links ./docs --json
node ./dist/cli.js links --verbose
```

- A target is valid when it exists as a file or directory; a fragment is validated against the GitHub-style heading anchors of a Markdown target.
- Local targets outside `--root` fail with reason `outside_root`; the checker never reads outside the project boundary.
- External URLs (`http:`, `https:`, other schemes, and protocol-relative) are skipped without any network request, so results are deterministic and offline.
- Failure reasons are `missing_file`, `missing_reference` (a reference-style usage with no matching definition), `missing_fragment`, and `outside_root`.
- Pretty output reports a count plus `file:line:column`, reason, and raw destination per failure; `--verbose` also lists skipped external links and scan counts.
- `--json` emits the stable `schemaVersion: 1` result with `summary` counts and `failures` sorted by source path and range. The exit status is `1` when any broken link is found and `0` otherwise; malformed arguments and discovery or read failures keep the standard command-error behavior.
- Images, MDX, and other document formats are not validated, and custom HTML or site-generator anchors are not recognized.
- `unresolved` remains a source-import diagnostic and intentionally excludes graph-only document edges; use `links` for Markdown link checking.

### Impact, review, and graph delta

`impact` loads current repository state automatically, like `search`/`orient`/`inspect`/`review`, so its `--base`/`--head` range never becomes index invalidation input; pass `--cache off` to force a full rebuild for a single invocation. `graph-delta` and `drift` keep revision-range semantics and are not current-state queries.

Human-readable `impact`, `--compact`, and MCP `impact` apply request-wide analysis budgets by default so large diffs stay useful accelerants instead of timing out. Prefer ranking-aware partial results with exact omit counts in `diagnostics` over unbounded compute. Library callers leave budgets unset for unlimited analysis unless they opt in.

```bash
# Analyze PR impact from git history
codegraph impact --provider git --base main --head HEAD

# Analyze current staged and unstaged worktree changes against HEAD
codegraph impact

# Analyze the current index against HEAD
codegraph impact --provider git --base HEAD --head STAGED

# Analyze GitHub PR impact
codegraph impact --provider github --repo owner/name --pr 123

# Analyze raw diff text from stdin
cat diff.txt | codegraph impact --provider raw

# Human-readable summary with severity scores
codegraph impact --base main --head feature

# Control duplicate leads in human-readable summaries
codegraph impact --base main --head feature --duplicates changed
codegraph impact --base main --head feature --duplicates off

# Compact impact JSON
codegraph impact --base main --head feature --compact

# Limit analysis depth and reference count
codegraph impact --base main --head feature --depth 2 --max-refs 1000

# Bound whole-request analysis work (symbols, lookups, retained refs, soft deadline)
codegraph impact --base main --head feature \
  --max-changed-symbols 250 --max-reference-lookups 250 \
  --max-total-references 5000 --time-budget-ms 25000

# Exported-only scope
codegraph impact --base main --head feature --scope imported

# Ignore noisy files
codegraph impact --base main --head feature --ignore-glob "**/package-lock.json" --ignore-glob "**/dist/**"

# Symbol references only
codegraph impact --base main --head feature --members-only

# Line context snippets for references
codegraph impact --base main --head feature --ref-context line

# Block context snippets for references
codegraph impact --base main --head feature --ref-context block --ref-block-max-lines 30

# Verify missing imports, exports, and declarations in changed lines
codegraph impact --base main --head feature --verify-refs

# Include candidate test suggestions in the impact report
codegraph impact --base main --head feature --include-tests

# Add LCOV and coverage-aware suggestions
codegraph impact --base main --head feature --lcov coverage/lcov.info --coverage-report coverage/coverage-final.json

# Use a repository-specific test command template
codegraph impact --base main --head feature --coverage-report coverage/coverage-final.json --test-command-template "pnpm vitest {files}"

# Review bundle for LLM-driven code review
codegraph review --base origin/main --head HEAD --json > review.json
codegraph review --base origin/main --head HEAD --include-symbol-details --max-callsites 5 --json > review.json
codegraph review --base origin/main --head HEAD --review-depth standard --json > review.json

# Compact human-readable review handoff
codegraph review --base origin/main --head HEAD
codegraph review
codegraph review --base origin/main --head HEAD --duplicates impacted

# File-level graph delta between revisions
codegraph graph-delta --git-base origin/main --git-head HEAD --json > graph-delta.json

# Disable fast graph extraction for changed files while keeping incremental selection
codegraph graph-delta --git-base origin/main --git-head HEAD --incremental-strict --json
```

```bash
# Architecture drift with CI policy gates
codegraph drift ./src --base origin/main --head HEAD --graph-edges summary --public-api removals
codegraph drift ./src --base origin/main --head HEAD --json
codegraph drift ./src --base origin/main --head HEAD --fail-on new-cycle,unresolved-import,public-api-removal
codegraph drift --base-artifact ./baseline/codegraph-out --head . --json
```

`drift` compares architecture signals, not runtime behavior, compiler diagnostics, or style.

- `--graph-edges full|summary|off` controls whether graph-edge churn is emitted per edge, summarized by source file, or suppressed.
- An edge that flips between type-only and runtime (for example `import type` becoming a runtime import) is reported as a `graph-edge-type-changed` finding (warning when an edge gains runtime weight, info when it becomes type-only) rather than as an add/remove pair.
- `--public-api all|removals|off` controls whether API additions are shown; removals stay the main review signal.
- Duplicate drift compares group counts plus stable top-group deltas; group identity keys on file, unit kind, symbol name, and content shape, so inserting lines above an unchanged clone does not rewrite its key. Duplicate increases are review or CI findings and only fail the process when selected by `--fail-on`.

For git-provider impact, `--head` accepts normal revisions plus worktree sentinels. Use `WORKTREE` to compare the base revision against the current working tree, including staged and unstaged tracked-file changes. Use `STAGED` or `INDEX` to compare the base revision against the current index; with `--base HEAD`, that is staged changes only. Untracked files are not included until they are staged or otherwise tracked by Git.

Impact JSON responses include `schemaVersion` plus `format: "full" | "compact"` so downstream tools can branch on payload shape without inferring it from missing fields. Use `--compact` for compact impact JSON. Impact JSON can also include `exportSummary`, `reexportChains`, `topImpacts`, `surfaceArea`, `clusters`, and `changedSymbols[].callCompatibility` when applicable. `changedFiles[]` entries preserve git copy or rename metadata as `oldFile` and `similarityIndex` when present. File paths in impact reports are project-relative, and raw diffs that point outside the project root are rejected.

When a review or non-empty impact range is analyzed, its JSON report includes `markdownLinks`, the same result schema used by `codegraph links --json` for Markdown sources in the analysis scope; pretty output adds a `Markdown links:` section. The check validates only `.md` sources, including raw `a[href]` inside Markdown. Standalone HTML, MDX, JSX, and TSX links are outside this validator's scope.

`callCompatibility` is a conservative review hint, not type checking. Likely-mismatch support is provider-backed for source languages where codegraph resolves the callee and can count arguments with high confidence. Overload sets are skipped unless codegraph can prove the exact overload target. Pretty impact and review summaries show only `likely_mismatch` findings; compatible, unsupported, or ambiguous callsites are omitted from human output and appear in structured data only when useful.

Each `impacted[]` item carries `severity` (0-1, ranked descending) and an independent `confidence` (0-1, how sure codegraph is the impact is real). `confidence` starts from the reference's relationship to the changed symbol (direct, namespace, import alias, or transitive) and is discounted further when the underlying reference was verified through medium- or low-confidence resolution, such as receiver/instance member-call matching (`obj.method()`) rather than an exact scope or import binding; `explain.resolutionConfidence` reports that discount tier (`"medium" | "low"`) when applied. This discount changes `confidence` only, not `severity` or item ranking, so a lower-certainty finding stays visible rather than silently dropping in rank.

`diagnostics.memberResolutionCoverage` reports, for the source languages among changed files, which languages have verified receiver/instance member-call resolution (`receiverAwareLanguages`) and which do not (`limitedLanguages`). For `limitedLanguages`, consumers reached only through a receiver expression may be missing from `impacted[]` entirely, not just lower-confidence; direct name, import, and same-file references are unaffected. Pretty output prints a `Note:`/diagnostics line naming the limited languages when present; the field is omitted from JSON when there is nothing to flag. See `docs/language-parity.md` for which languages currently support receiver resolution.

Pretty impact and review summaries also show high-confidence exact or renamed duplicate leads by default:

- Human-readable `impact` defaults to `--duplicates changed`.
- Human-readable `review` defaults to `--duplicates impacted`.
- Identical import-list and barrel-file boilerplate is omitted from these leads by default and reported under `omittedCounts.byBoilerplate`.
- Use `--duplicates off|changed|impacted|all` to control duplicate-lead scope.
- For `review`, `--duplicates off` is parsed before report construction and skips `prepareDuplicateAnalysis` / duplicate review tasks entirely, not just the human summary.
- Git copy or rename `similarityIndex` metadata of 80 or higher can boost scoped duplicate leads when both old and new files exist in the indexed snapshot.
- Structured review JSON also adds bounded `duplicate-sibling` review tasks when changed files or symbols overlap high-confidence duplicate groups. Treat these as "check the sibling implementation" prompts, not semantic-equivalence claims.
- JSON output keeps the existing impact and review contracts; use `codegraph duplicates --json` for full grouped duplicate JSON.

### Call Compatibility Output

Run impact or review normally; no extra flag is required:

```bash
codegraph impact --base main --head feature
codegraph impact --base main --head feature --json
codegraph review --base main --head feature
codegraph review --base main --head feature --json > review.json
```

Call compatibility appears only after codegraph detects a changed callable signature. Human output lists likely argument-count mismatches as review leads; JSON output attaches full hint objects under `changedSymbols[].callCompatibility`.

- Inspect `callsiteFile`, `callsiteRange`, `expected`, and `actual` before treating a hint as a defect.
- Expect skipped output for overload sets, spread arguments, dynamic dispatch, unresolved callsites, and unsupported syntax.
- Use `docs/language-parity.md` for the current language support matrix and known limitations.

Changed non-indexed tracked files such as scripts, Markdown, and extensionless project files report `status: "updated"` when they still exist; `deleted` is reserved for diff/disk deletion evidence.

`codegraph.config.json` may include `graph.resolutionHints` for repo-local include roots (especially C/C++). CLI `--resolution-hint` values merge on top of config hints and participate in cache/manifest identity.

`codegraph review` prints the changed-file count, changed-symbol count, risk summary, review tasks, and suggested tests without emitting the full `projectFiles` and symbol-detail JSON payload. High- and medium-confidence candidate tests are listed directly; low-confidence pattern matches are summarized as breadth hints. Use `review --json` when a downstream tool needs the complete structured bundle.

SQL review context is emitted only as `sqlContext.entries[]` in structured review JSON. Entries carry a `reason` such as `changed_sql_file` or `changed_sql_literal`, the matched `objectName`, and the original SQL statement fact. They are review hints, not source dependency edges.

`inspect` and `unresolved` exclude graph-only document/template link edges plus known runtime and package externals from unresolved-import counts so diagnostics stay focused on source import resolution gaps. `unresolved` remains a source-import diagnostic and does not check Markdown link targets; use `links` for local Markdown link validation. Runtime and package filtering includes Node builtins such as `node:path` and `fs`, supported-language standard library imports, URL imports, and dependencies declared in nearby manifests such as `package.json`, `requirements.txt`, `requirements.in`, `pyproject.toml`, `setup.cfg`, `Pipfile`, `composer.json`, `Cargo.toml`, `go.mod`, `build.zig.zon`, `Gemfile`, `*.gemspec`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `*.csproj`, `*.fsproj`, `*.vbproj`, `vcpkg.json`, and `Package.swift`.

### Doctor and skill commands

```bash
# Print the installed CLI version
codegraph version
codegraph -v

# Print package identity as JSON
codegraph version --json

# Inspect package identity plus backend and runtime state
codegraph doctor

# Inspect one explicit graph or index artifact path
codegraph doctor ./.codegraph-cache/index-v1

# Inspect an artifact bundle directory or one artifact file
codegraph doctor ./codegraph-out
codegraph doctor ./codegraph-out/codegraph.sqlite

# Install the bundled skill into a known agent location.
# The installer creates the target skills directory as needed.
codegraph skill install --agent codex

codegraph skill install --agent claude

codegraph skill install --agent agents

codegraph skill install --agent cursor

codegraph skill install --agent gemini

codegraph skill install --agent opencode

codegraph skill install --agent omp

codegraph skill install --agent kilo

# Install the bundled skill into an explicit target directory
# The target must end with /skills/codegraph.
codegraph skill install --target ~/.codex/skills/codegraph --force

# Inspect bundled skill paths and target health
codegraph skill doctor
```

`codegraph skill install --agent <name>` supports `agents`, `codex`, `claude`, `cursor`, `gemini`, `opencode`, `omp`, and `kilo`. Skill install targets must end with `skills/codegraph`, except OMP's managed target ending with `managed-skills/codegraph`; when that safe target shape is satisfied, the installer creates the directory as needed. Cursor CLI now supports native skills directories too, so `.cursor/skills/codegraph` works alongside the universal `~/.agents/skills/codegraph` location. `codegraph -v`, `codegraph version --json`, and `codegraph doctor` include or identify the installed package version.

`doctor.native.origin` reports `workspace`, `package`, or `cache`, plus normalized source and loaded paths when known. Cache origins include the target, package version, cache key, SHA-256, and `updateSafeForCurrentProcess`; a package fallback retains `cacheError` instead of treating cache preparation failure as native unavailability.

`doctor.native.update` reports bounded, normalized `staleRetirementPaths`, `runningVersion`, `installedVersion`, `restartRequired`, and an optional reason. Doctor never deletes retirement paths, cache entries, or running processes.

After installing or updating codegraph, restart or reload each MCP client so it launches the current package and tool catalog. If behavior still looks stale, run `codegraph doctor --json` from the same shell or configured executable path, compare running and installed identity, then use MCP `refresh_index` only for repository snapshot freshness.

## Incremental git-scoped runs

Use `--changed-since <ref>` or `--git-base <ref> [--git-head <ref>]` with `graph` and `index` to limit processing to the files reported by `git diff`.

The CLI pipes that file list into `buildProjectIndexFromFiles`, so unchanged files are skipped entirely when you are reviewing a PR.

`--git-head` accepts normal revisions plus the same worktree sentinels used by git-provider impact: `WORKTREE` compares the base revision to staged and unstaged tracked-file changes, while `STAGED` and `INDEX` compare the base revision to the current index.

## SQLite schema and raw SQL

The SQLite export is a first-class query interface for agent workflows.

### Tables

- `files(path TEXT PRIMARY KEY, is_external INTEGER)`
- `symbols(id TEXT PRIMARY KEY, file TEXT, name TEXT, kind TEXT, docstring TEXT, line_span INTEGER, complexity INTEGER, visibility TEXT)`
- `file_edges(from_path TEXT, to_path TEXT, to_type TEXT, raw TEXT, type_only INTEGER)`
- `symbol_edges(from_id TEXT, to_id TEXT, label TEXT)`
- `graph_metadata(key TEXT PRIMARY KEY, value TEXT)`
- `graph_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER, mode TEXT, changed_files INTEGER, deleted_files INTEGER, file_nodes INTEGER, file_edges INTEGER, symbol_nodes INTEGER, symbol_edges INTEGER)`
- `graph_snapshot_files(snapshot_id INTEGER, file_path TEXT, change_kind TEXT)`. Graph snapshot history retains the newest 100 snapshots; child rows are deleted before expired parent rows.

### Indexes

- `idx_symbols_name`, `idx_symbols_kind`, `idx_symbols_name_kind`, `idx_symbols_file_kind`, `idx_symbols_kind_complexity`
- `idx_file_edges_from`, `idx_file_edges_to`, `idx_file_edges_type`
- `idx_symbol_edges_from`, `idx_symbol_edges_to`, `idx_symbol_edges_label`, `idx_symbol_edges_label_to`, `idx_symbol_edges_label_from`, `idx_symbol_edges_label_from_to`

### Example SQL

```sql
SELECT s.name, s.file, COUNT(*) AS calls
FROM symbol_edges e
JOIN symbols s ON s.id = e.to_id
WHERE e.label = 'calls' AND s.kind = 'function'
GROUP BY s.id
ORDER BY calls DESC
LIMIT 20;

SELECT from_path
FROM file_edges
WHERE to_path = 'src/auth.ts' AND to_type = 'file';
```

Raw SQL access is intentionally read-only:

```bash
codegraph sql ./codegraph.sqlite "SELECT name, file FROM symbols WHERE kind = 'function' LIMIT 5;"
```

It accepts result-producing statements such as `SELECT` and `PRAGMA` and rejects mutating SQL. Each command has a 10-second deadline, so a long-running query can fail when that budget expires. While a native SQLite step finishes after an expired deadline, concurrent SQL commands can also fail temporarily when the bounded worker capacity is full; retry after the earlier query completes.

## Review bundle shape

`codegraph review` reuses the incremental manifest and produces a JSON bundle optimized for LLM-driven reviews.

```jsonc
{
  "schemaVersion": 2,
  "status": "ok",
  "summary": {
    "filesChanged": 3,
    "symbolsChanged": 12,
    "candidateTests": 5,
  },
  "riskSummary": {
    "level": "medium",
    "score": 60,
    "signals": ["exported-symbols-changed"],
  },
  "reviewTasks": [
    {
      "id": "review-summary",
      "title": "Review changed symbols",
      "description": "Scan the changed symbols and confirm behavioral changes align with intent.",
      "priority": "medium",
      "reason": "baseline-review",
    },
  ],
  "changedFiles": [
    {
      "file": "src/foo.ts",
      "status": "updated",
    },
  ],
  "graphDelta": [
    {
      "from": "src/foo.ts",
      "to": { "type": "file", "path": "src/bar.ts" },
      "raw": "./bar",
    },
  ],
  "candidateTests": [
    {
      "file": "tests/foo.test.ts",
      "confidence": "high",
      "reason": "importsChanged",
    },
  ],
  "diagnostics": {
    "missingFiles": [],
    "symbolMappingParseFailures": [],
    "memberResolutionCoverage": {
      "receiverAwareLanguages": ["ts"],
      "limitedLanguages": ["python"],
    },
  },
}
```

Important review-bundle details:

- `schemaVersion` identifies the review JSON schema for CI validation and compatibility checks.
- `riskSummary` and `reviewTasks` provide agent-ready review focus areas and likely risk hotspots.
- `changedFiles[].status` distinguishes normal updates from real Git deletions and explicit missing input files.
- `changedFiles[].isBinary` is `true` when Git reported a binary diff. Those entries make no symbol-level claims.
- `diagnostics.symbolMappingParseFailures` reports files where symbol-level diff mapping degraded. Source-language failures affect `symbol-mapping-degraded` risk; graph-first document files remain diagnostics without becoming high-priority source review tasks.
- `diagnostics.missingFiles` reports explicit paths that were not present on disk.
- `diagnostics.memberResolutionCoverage` buckets the source languages among changed files by whether codegraph resolves receiver/instance member calls (`obj.method()`). `limitedLanguages` flags languages where that resolution is not implemented, so consumers reached only through a receiver may be undercounted; direct name, import, and same-file references remain unaffected. The field is omitted when there is nothing to flag.
- `graph-delta` reports file-level edge additions and removals for changed files and is intended for lightweight CI artifacts.
- `--include-symbol-details` attaches definition snippets and callsite ranges for changed symbols.
- Changed symbol details may include `callCompatibility` for high-confidence provider-backed callsite arity mismatches after signature changes. Agents should inspect the code before treating these leads as defects.
- When diff data is available, `symbols` and `summary.symbolsChanged` include only symbols and re-exports touched by diff hunks. Unchanged re-exports may appear in `changedFiles[].apiContext`, never as changed symbols.
- `--review-depth minimal|standard|deep` applies preset bundles:
  - `minimal`: fast graph, no symbol snippets, `maxCallsites=0`, `maxCandidates=10`
  - `standard`: symbol snippets plus up to 2 callsites, `maxCandidates=25`
  - `deep`: symbol snippets plus up to 10 callsites, `maxCandidates=50`
- Explicit flags like `--include-symbol-details`, `--max-callsites`, `--max-tests`, or `--fast-graph` override preset defaults.
- For review accuracy, keep the default Tree-sitter import extraction unless you intentionally accept less complete JavaScript or TypeScript edges.
- `--incremental-strict` disables fast graph extraction for changed files while still using incremental file selection.
- `--cache-verify` validates the manifest before reuse and falls back to a full rebuild if mismatches are detected.

## Local development

If you are working on this package itself, use `tsx` to run the source entrypoint directly:

```bash
npx tsx src/cli.ts graph
npx tsx src/cli.ts graph --fast-graph
npx tsx src/cli.ts goto <file> <line> <column>
```

## Output formats

Human-readable output is optimized for compact reading by people or models and may omit low-confidence or verbose context that remains available in structured JSON and TypeScript return values. `--pretty` is an explicit equivalent of that default. Integrators that compose deterministic review packs should use the exported TypeScript functions or JSON output.

Plain `graph` output is a Mermaid file dependency graph on stdout. `graph --json` returns the structured file graph shown below; add `--output <path>` to write any selected format to a file.

`graph` JSON output is always compact: `files` lists each path once, and every edge references source and target files by their integer offset into `files` instead of repeating the path string. This keeps output size proportional to the number of distinct files rather than the number of edges. Every JSON graph payload (with or without `--symbols`) ends with an `analysis` object describing the parse backend that produced it (`mode`: `semantic`, `mixed`, or `reduced`; plus `backend`, a human `label`, and fallback file counts), mirroring what `index --json` reports.

```json
{
  "files": ["/abs/path/a.ts", "/abs/path/b.ts", "..."],
  "fileEdges": [
    {
      "from": 0,
      "to": { "type": "external", "name": "react" },
      "raw": "react"
    },
    {
      "from": 0,
      "to": { "type": "file", "path": 1 },
      "raw": "./b"
    }
  ],
  "analysis": {
    "mode": "semantic",
    "backend": "native",
    "parserDegradedFiles": 0,
    "fallbackImportExtractionFiles": 0,
    "nativeFilesUsed": 2,
    "nativeFilesFellBack": 0,
    "label": "native semantic"
  }
}
```

SQL files are part of normal graph output: `.sql` files are discovered by default, SQL-to-SQL object references appear as file edges, and SQL object symbols work with `goto` and `refs` inside SQL files. SQL-to-SQL edges are precise for exact object-name matches, heuristic for unambiguous qualified-to-basename fallback matches, and skipped for ambiguous basename guesses. SQL `goto` and `refs` resolve schema-qualified names plus object-level alias/table-qualified references such as `t.id` or `schema.table.id` to table/view definitions, not to column declarations. With `--sql-artifacts`, JSON graph output also includes detailed SQL statement facts and object-candidate metadata. SQL artifact nodes use `sql_statement_fact` and `sql_schema_candidate` truth tiers; they do not assert a current schema and do not globally link application-code strings to SQL objects.

Format notes:

- Use `--mermaid` for a Mermaid flowchart.
- Use `--dot` for Graphviz DOT.
- In DOT output, type-only edges are dotted and external nodes are dashed ellipses.
- `--fast-graph` bypasses native import queries only for plain `.js` and `.ts` files, using lightweight text extraction that may miss multiline or complex patterns. TSX and other languages keep their normal extraction path.

When using `--symbols`:

- Mermaid and DOT output include file nodes, file-to-file edges, symbol nodes, file-to-symbol containment edges, and symbol-to-symbol import edges.
- Use `--symbols-only` to omit file nodes and edges and render symbols only.

When using `--symbols-detailed`:

- codegraph adds symbol-to-symbol `uses` edges when a symbol body references another symbol through local references, named or default imports, or namespace members.
- You can combine `--symbols-detailed` with `--symbols` to keep both usage and import edges alongside file nodes.
- Pruning options for large repos:
  - `--symbols-detailed-scope {all|imported}`
  - `--symbols-detailed-max-edges N`
  - `--symbols-detailed-members-only`

With `--symbols` or `--symbols-detailed`, the same JSON also carries `symbols` (each with an integer `id` and `file` offset), `symbolEdges` (integer `from`/`to`), and `symbolIdIndex` (the original string symbol ids, indexed by `symbols[].id`) so callers can recover the portable id when needed:

```bash
codegraph graph --root . ./src --symbols-detailed --json --output graph.json
```

When targeting a different repo, pass it with `--root` rather than as an extra positional path:

```bash
codegraph graph --root /path/to/project --json --symbols-detailed --output graph.json
```

## Graph export and inspection

codegraph ships graph data formats for scripts and existing graph tools, plus a packaged interactive viewer for humans. Use `codegraph viewer --root . --open` for the current project, or add `--graph codegraph.json` to inspect a root-confined exported snapshot; it is not an agent interface.

```bash
# Compact JSON for scripts and downstream tooling
codegraph graph --root . ./src --json --output codegraph.json

# Mermaid for Markdown renderers that support Mermaid diagrams
codegraph graph --root . ./src --mermaid --output graph.mmd

# DOT for Graphviz
codegraph graph --root . ./src --dot --output graph.dot
```

## Related docs

- [docs/installation.md](./installation.md)
- [docs/library-api.md](./library-api.md)
- [docs/agent-workflows.md](./agent-workflows.md)
- [docs/how-it-works.md](./how-it-works.md)
