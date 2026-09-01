# How It Works

## Short version

codegraph turns source files into a resolved dependency graph and a semantic index:

1. Discover files under the selected roots.
2. Parse supported source languages with Tree-sitter and run language queries for imports, exports, definitions, and bindings.
3. Resolve each module specifier to a project file or an external dependency, then assemble forward and reverse graph indexes.
4. Use the same indexed symbols, scopes, and edges for navigation, impact analysis, review, and agent queries.
5. Reuse compatible parsed files and graph edges when caching or a long-lived session is enabled.

The normal supported-language path is Tree-sitter. The native addon accelerates the shared parse and query path; it is not a separate analysis model. `--fast-graph` is a narrower, opt-in shortcut for plain `.js` and `.ts` import specifiers, not a switch that disables all AST work.

The first index-backed question, such as `codegraph explore "..." --root .`, may discover, parse, resolve, and persist a cold index. Interactive progress goes to stderr; later compatible queries reuse the project-root cache and only rebuild or update work invalidated by file, configuration, or option changes.

## Discovery

Commands start from the project root and any selected scan roots. codegraph walks those roots, applies supported-extension filtering, honors `.gitignore` by default, and then applies configured and command-line include or ignore globs. Excluding generated, vendored, and fixture trees here avoids reading or parsing them later.

Each discovered file is mapped to a language definition. First-class source languages feed the shared Tree-sitter pipeline. Graph-first formats such as documentation and templates use their dedicated link or specifier extractors where the [language parity matrix](./language-parity.md) says graph support is available.

See [CLI scan and root behavior](./cli.md#project-config) for the distinction between project configuration and one-off command flags.

## Extraction

### Default: Tree-sitter queries

For supported source languages, language definitions provide a Tree-sitter grammar plus queries and classification rules. The indexer parses each file and normalizes query captures into common records for module specifiers, exports, local definitions, import bindings, and scopes. Later stages therefore consume the same shapes across languages.

In the normal `auto` runtime mode, the native addon performs this Tree-sitter parse and query work when available. TypeScript code owns discovery, normalization, resolution, graph assembly, semantic operations, and output formatting, so native acceleration does not change the public result contract.

### Windows installed-runtime cache

On Windows, an installed codegraph package resolves the platform `.node` file without loading it, hashes it with a bounded streaming buffer, and publishes the verified bytes to `%LOCALAPPDATA%\codegraph\native-cache\v1`. Each cache entry is keyed by platform target, package version, and SHA-256; concurrent processes converge on one immutable final file without overwriting mapped binaries.

After a verified load, a source-keyed identity record stores the source and cached-file metadata, runtime details, supported languages, and binding origin. A later process reuses it only while the exact files still match and the one-day re-verification interval has not expired; entries not verified for 30 days are pruned.

The loader requires the cached path and records both the package-owned source and loaded origin. Local workspace builds bypass this cache so rebuilding `packages/codegraph-native` still takes effect immediately, while non-Windows installed packages keep their existing package loader.

### Opt-in: `--fast-graph`

`--fast-graph` bypasses native import queries only for plain `.js` and `.ts` files and extracts their module specifiers with a lightweight text matcher instead. TSX and other parser-backed languages keep their normal extraction path, and other analysis work can still require parsed syntax.

The shortcut recognizes common `import`, `export ... from`, `require()`, and `import()` forms. It can miss multiline or complex patterns, so use it for a quick dependency overview when that accuracy tradeoff is acceptable. Rerun without it when edges from `.js` or `.ts` files look incomplete or when review accuracy matters.

### Recovery when parsing is unavailable

Recovery is separate from `--fast-graph`. If the native addon is unavailable in `auto` mode, codegraph continues in a reduced graph-only mode and uses the available regex or graph-first recovery extractors. It does not load a second JavaScript grammar backend. Semantic features that need definitions, scopes, or precise syntax may be unavailable or less complete in this mode.

A failed or empty import query can also trigger a language-specific recovery extractor for that file. This is resilience behavior, not the normal architecture. Use `--report` or `codegraph doctor` when you need to confirm which backend ran. `--native on` makes a missing native addon an error; `--native off` explicitly selects reduced behavior.

## Resolution and graph construction

Extraction produces raw module specifiers. Resolution then turns them into graph targets:

- Relative and absolute-like paths are matched to discovered files with supported extension and index-file rules.
- TypeScript path aliases and `baseUrl`, workspace packages, and package metadata participate where configured.
- `node_modules` resolution is opt-in with `--resolve-node-modules`.
- Resolution hints and dynamic-import heuristics are opt-in because guesses can create false positives.
- A specifier that cannot be mapped to a project file remains an `external` node instead of disappearing.

The resulting file nodes and typed edges are stored with forward and reverse adjacency indexes. That graph powers `graph`, `deps`, `rdeps`, `path`, `cycles`, unresolved-import checks, and the dependency portion of higher-level analysis. Mermaid, DOT, JSON, and SQLite are output views of the same graph model.

## Semantic navigation and impact

The semantic index links definitions, scopes, exports, imports, and resolved calls. `goto`, `refs`, workspace symbols, call and type hierarchies, implementations, and impact read that index. Results use one snapshot and project-relative locations.

Only proven semantic links are reported. Dynamic dispatch, unresolved symbols, and unsupported language features stay absent or appear as limitations; bounds report exact omissions. See the [language parity matrix](./language-parity.md) for per-language coverage.

`rename_preview` and refactor planning produce review evidence only. They never write files, and stale, conflicting, uncertain, or truncated rename plans are not safe.

Impact maps changed symbols to resolved references and reverse dependencies. Severity ranks likely effects, confidence shows resolution certainty, and `diagnostics.memberResolutionCoverage` warns when a language cannot resolve receiver calls.

## Cache and session behavior

Caching avoids repeated work; it does not change extraction or resolution semantics.

- `off` runs cold.
- `memory` reuses parsed work in one process.
- `disk` persists parsed files and an incremental graph under `.codegraph/cache/index-v1`.

Disk loads reuse unchanged files and update changed ones. Codegraph validates file, configuration, build, and available Git state before reuse; incompatible or corrupt data is rebuilt. Strict mode hashes content, while non-strict mode accepts the documented metadata speed tradeoff.

Existing `.codegraph-cache/` directories migrate automatically to `.codegraph/cache/` on the next run.

Disk search can also store normalized source and chunk text in SQLite. Treat that cache as sensitive derived source data; use `--cache off` to avoid it and stop codegraph before deletion.

Long-lived sessions reuse only compatible state and refresh on drift. `codegraph init` can warm the disk cache, but index-backed commands do not require lifecycle initialization.

## Performance choices

Choose the least lossy option that solves the actual bottleneck:

1. **Narrow discovery first.** Scan only the roots you need and ignore generated or vendored trees. Work avoided here benefits every later stage.
2. **Use disk cache for repeated CLI or agent work.** Use memory cache for repeated operations in one process and cache-off for controlled cold runs.
3. **Use `--threads N` for file-level indexing and I/O concurrency.** Start near the available CPU count, then measure; excessive concurrency can become I/O-bound.
4. **Use `--workers` for CPU-parallel native extraction on larger index-building workloads.** It requires the native addon; direct file-only graph output does not use this pool. Single-threaded extraction remains the fallback if a worker pool cannot start, and preprocessed single-file component formats stay on the main thread.
5. **Use `--fast-graph` only for a quick plain-JavaScript or plain-TypeScript dependency pass.** It trades import-specifier completeness for less native query work on `.js` and `.ts` files; TSX and other languages keep their normal extraction path.

Use `--report` to inspect cache, backend, and worker-pool behavior instead of assuming a tuning flag helped. For controlled evidence about agent-oriented discovery, see the [benchmark methodology and checked results](./benchmarks/README.md); those fixtures do not establish universal speedups.

## Extension and testing

New source-language support should extend the shared definition, native grammar, extraction, resolution, semantic, and fixture conventions rather than introduce a parallel parser architecture. Graph-first languages should state their narrower contract explicitly.

Opt-in dynamic import heuristics enter through `extractDynamicImportSpecifiers(...)` in `src/util/specifiers.ts`, which dispatches to a shared per-language adapter. Each adapter scans source without executing it, emits the common heuristic module-specifier shape, and sends candidates through the existing language resolver. The same adapters run for embedded JS or TypeScript script blocks.

A new adapter is appropriate only when static call data maps to the language's existing source module resolver. It must mask comments and strings, keep alias tracking bounded, ignore computed values it cannot prove, and cover enabled, disabled, and false-positive behavior. Reflection or runtime plugin APIs need separate graph semantics unless their values can be mapped to source files.

- [Adding language support](./adding-language-support.md) gives the implementation and review checklist.
- [Language parity](./language-parity.md) records the public capability matrix.
- [Scenario catalog](./scenario-catalog.md) links claimed behavior to fixtures and regression coverage.

Test the smallest layer that owns a change, then add a small end-to-end fixture when discovery, resolution, or CLI output is part of the contract. Native-required suites verify the normal Tree-sitter path; native-fallback suites verify reduced recovery without presenting it as parity.

## Related docs

- [CLI reference](./cli.md)
- [Library API](./library-api.md)
- [Agent workflows](./agent-workflows.md)
- [Vectorless search](./search.md)
- [Benchmark methodology and results](./benchmarks/README.md)
