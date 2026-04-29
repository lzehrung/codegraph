# How It Works

Runtime behavior, performance characteristics, architecture, extension points, and testing notes.

## Performance

### Quick start for large repos

- Graph only: `codegraph graph --fast-graph --threads 8 --mermaid > graph.mmd`
- Full index: `codegraph index --workers --threads 8 --cache disk`
- Detailed symbols, pruned: `codegraph graph --root . ./src --symbols-detailed --symbols-detailed-scope imported --symbols-detailed-members-only --symbols-detailed-max-edges 5000 --mermaid > graph.symbols.pruned.mmd`

### Fast graph

- Regex-based specifier extraction is available for JS and TS only.
- It covers common `import`, `export ... from`, `require()`, and `import()` patterns and ignores commented imports.
- If the output looks off, rerun without `--fast-graph`.
- Programmatic callers can set `graph.fastRegexDisabledLanguages` to opt specific languages out of regex fast paths.

### Caching

- Modes: `off` (default), `memory` (per-process), `disk` (persist across runs under `.codegraph-cache/index-v1`)
- Content-hash caching is the default: parsed-module cache keys use content SHA1 for reliability.
- Set `cacheStrict: false` to use mtime and size for manifest signatures when you want faster, less reliable git-heavy rebuilds.
- Per-file parsed caches are versioned; version mismatches trigger a rebuild of that file's cached outputs.
- Bloom filters are built automatically during indexing for faster reference scanning. Disable them with `useBloomFilters: false` if needed.
- `.codegraph-cache/index-v1/manifest.json` stores the last indexed commit, graph options, and per-file signatures plus resolved edges.
- Incremental runs treat the manifest as a cached base graph: unchanged files keep their edges, while changed files are reparsed and their edges replaced.
- `codegraph hotspots` and `codegraph inspect` reuse the disk index cache when the manifest is present and log the manifest path, timestamp, and last commit hash to stderr.
- Remove the manifest, clear `.codegraph-cache/index-v1`, or rerun with different graph flags to force a full graph rebuild.

### Threads

- Use `--threads` to increase concurrency.
- A typical sweet spot is CPU cores or cores times two.
- Very high values may become I/O-bound; 8-32 is a good SSD-era range.

### Native Tree-sitter acceleration

- `npm run build` attempts the local native workspace build when Cargo is available.
- Use `npm run build:native` when you want native-only rebuilds or a hard failure if Rust is missing.
- When the addon is present, Codegraph runs supported Tree-sitter parse and query work in Rust.
- If native mode is `auto`, unavailable query recovery paths can degrade through the optional JS fallback package or native-owned final recovery paths.
- If native mode is `on`, a missing native addon is a hard error.
- `--workers` uses a Piscina worker pool to offload per-file Rust extraction across CPU cores.
- Vue, Svelte, and Astro files stay on the main thread because they need source preprocessing before extraction.
- Falls back silently to single-threaded extraction if Piscina is unavailable or pool creation fails.
- Use `--report` to inspect `workerPool` statistics.

### Monorepo resolution

- Workspace detection precedence: `package.json` workspaces, then `pnpm-workspace.yaml`, then `lerna.json`
- `pnpm-workspace.yaml` supports `packages:` include globs and `!` exclude globs.
- Bare-specifier resolution precedence:
  - nearest TypeScript `paths` and `baseUrl`
  - workspace packages
  - `node_modules` only when `--resolve-node-modules` is enabled
- Package subpaths are resolved via `exports` and `main` heuristics.

### Troubleshooting

- Missing JS or TS edges: disable `--fast-graph`.
- Dynamic JS or TS specifiers or bare imports from custom roots: use `--dynamic-import-heuristics` and or `--resolution-hint <dir>` only when needed because they can introduce false positives.
- Stale results: use `--cache-strict` or clear `.codegraph-cache`.
- Windows path separators are normalized to `/` where relevant.

## Architecture

### 1. Language adapters

Language adapters expose:

- file extensions
- the Tree-sitter grammar
- a few node-type helpers
- four small query groups for imports, exports, locals, and import bindings
- definition classification and scope behavior

### 2. Indexing

- TypeScript owns the shared indexing pipeline, resolution logic, and output shapes.
- The parser and query hot path stays on Tree-sitter for every supported language.
- When available, the addon inside `@lzehrung/codegraph-native` runs those Tree-sitter parses and queries natively, then returns plain capture data to TypeScript.

### 3. Graph building

- For each file, Codegraph collects module specifiers and resolves them.
- Path-like specifiers resolve to best-effort file targets.
- Unresolved targets become `external` nodes instead of being discarded.

### 4. Navigation

- `goToDefinition` checks local scope first, then imported bindings, and understands namespace-member access.
- `findReferences` builds per-file scope, seeds imports as bindings, records occurrences, and resolves through imports and namespace members.

### 5. AST grep

AST grep runs any Tree-sitter query across matched files and prints hits as `file:line:col: @capture: snippet`.

## Extending to other languages

Codegraph uses one unified language-definition system that powers both dependency graph extraction and semantic chunking.

For the full checklist, see [docs/adding-language-support.md](./adding-language-support.md).

The short version:

1. Add a definition file in `src/languages/definitions/<language>.ts`.
2. Register it in `src/languages.ts` and `src/bootstrap/treeSitterLanguages.ts`.
3. Add the nearest language sample and regression coverage in `tests/languages`.

Do not stop at "80/20" support unless the parity docs and scenario catalog explicitly mark the limitation and the tests prove it.

## Testing

The core stays intentionally pure and test-friendly. Good seams to target directly include:

- `collectLocalsAndExportsFromSource(file, source, support, lang)`
- `collectModuleSpecifiersFromSource(support, lang, source)`
- `buildScopeIndexFromSource(file, source, support, lang, imports)`
- `resolveExport(index, file, exportedName)`
- `goToDefinition(index, req)`
- `findReferences(index, req)`

Recommended strategy:

- Feed inline strings as source and assert on JSON-serializable structures.
- For end-to-end tests, create a small temp directory with a few files and run the CLI with `tsx`.

## Related docs

- [docs/cli.md](./cli.md)
- [docs/library-api.md](./library-api.md)
- [docs/agent-workflows.md](./agent-workflows.md)
- [docs/language-parity.md](./language-parity.md)
- [docs/scenario-catalog.md](./scenario-catalog.md)
