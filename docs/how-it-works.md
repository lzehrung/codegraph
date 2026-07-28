# How It Works

## Short version

Codegraph turns source files into a resolved dependency graph and a semantic index:

1. Discover files under the selected roots.
2. Parse supported source languages with Tree-sitter and run language queries for imports, exports, definitions, and bindings.
3. Resolve each module specifier to a project file or an external dependency, then assemble forward and reverse graph indexes.
4. Use the same indexed symbols, scopes, and edges for navigation, impact analysis, review, and agent queries.
5. Reuse compatible parsed files and graph edges when caching or a long-lived session is enabled.

The normal supported-language path is Tree-sitter. The native addon accelerates the shared parse and query path; it is not a separate analysis model. `--fast-graph` is a narrower, opt-in shortcut for plain `.js` and `.ts` import specifiers, not a switch that disables all AST work.

## Discovery

Commands start from the project root and any selected scan roots. Codegraph walks those roots, applies supported-extension filtering, honors `.gitignore` by default, and then applies configured and command-line include or ignore globs. Excluding generated, vendored, and fixture trees here avoids reading or parsing them later.

Each discovered file is mapped to a language definition. First-class source languages feed the shared Tree-sitter pipeline. Graph-first formats such as documentation and templates use their dedicated link or specifier extractors where the [language parity matrix](./language-parity.md) says graph support is available.

See [CLI scan and root behavior](./cli.md#project-config) for the distinction between project configuration and one-off command flags.

## Extraction

### Default: Tree-sitter queries

For supported source languages, language definitions provide a Tree-sitter grammar plus queries and classification rules. The indexer parses each file and normalizes query captures into common records for module specifiers, exports, local definitions, import bindings, and scopes. Later stages therefore consume the same shapes across languages.

In the normal `auto` runtime mode, the native addon performs this Tree-sitter parse and query work when available. TypeScript code owns discovery, normalization, resolution, graph assembly, semantic operations, and output formatting, so native acceleration does not change the public result contract.

### Windows installed-runtime cache

On Windows, an installed Codegraph package resolves the platform `.node` file without loading it, hashes it with a bounded streaming buffer, and publishes the verified bytes to `%LOCALAPPDATA%\codegraph\native-cache\v1`. Each cache entry is keyed by platform target, package version, and SHA-256; concurrent processes converge on one immutable final file without overwriting mapped binaries.

The loader requires the cached path and records both the package-owned source and loaded origin. Local workspace builds bypass this cache so rebuilding `packages/codegraph-native` still takes effect immediately, while non-Windows installed packages keep their existing package loader.

### Opt-in: `--fast-graph`

`--fast-graph` bypasses native import queries only for plain `.js` and `.ts` files and extracts their module specifiers with a lightweight text matcher instead. TSX and other parser-backed languages keep their normal extraction path, and other analysis work can still require parsed syntax.

The shortcut recognizes common `import`, `export ... from`, `require()`, and `import()` forms. It can miss multiline or complex patterns, so use it for a quick dependency overview when that accuracy tradeoff is acceptable. Rerun without it when edges from `.js` or `.ts` files look incomplete or when review accuracy matters.

### Recovery when parsing is unavailable

Recovery is separate from `--fast-graph`. If the native addon is unavailable in `auto` mode, Codegraph continues in a reduced graph-only mode and uses the available regex or graph-first recovery extractors. It does not load a second JavaScript grammar backend. Semantic features that need definitions, scopes, or precise syntax may be unavailable or less complete in this mode.

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

Impact and review commands can apply request-wide work budgets so large diffs return ranked partial evidence with exact omit counts instead of hanging. External review orchestrators should treat `impact --provider git` and `review --summary` as bounded accelerants, not as an owned review workflow or packet protocol.

The semantic index connects definitions, scopes, exports, and import bindings to graph edges. `goto` resolves local definitions and imported bindings, including supported namespace-member cases. `refs` follows local and imported references through the same model.

Workspace-symbol lookup builds a cached candidate view from indexed definitions and only materializes import aliases when requested. It applies kind, exported, and project-relative file-glob filters before deterministic ranking: qualified and exact names lead, followed by case-insensitive exact, prefix, identifier-token, and substring matches.

Call hierarchy reads resolved `calls` edges from the detailed symbol graph. It builds incoming and outgoing adjacency once per symbol-graph snapshot, attributes nested calls to the nearest indexed callable, groups multiple exact callsites by symbol pair, and traverses breadth-first with deterministic depth and result bounds.

Agent, CLI, and MCP callers reuse the project snapshot and cached adjacency. Results do not reparse source, treat file dependencies or arbitrary references as calls, or guess unresolved dynamic dispatch; reduced graph-only recovery therefore does not claim equivalent call hierarchy coverage.

Type hierarchy extraction adds resolved `extends` and `implements` edges to the detailed symbol graph. Breadth-first supertype and subtype queries deduplicate cycles, sort deterministically by depth and symbol identity, and apply limits after traversal so omission counts remain exact.

Implementation lookup follows the same proven edges. Interface or trait member lookup also requires a proven implementing type and an indexed same-name member inside that type; it does not infer structural conformance, dynamic dispatch, unrelated same-name methods, or unresolved external bases.

Rename preview resolves the target handle through the same semantic index, collects proven definitions, references, imports, exports, and supported interface-member implementations, then validates scope collisions and source freshness. Optional comment and string scans are marked low confidence, edit limits produce explicit omissions and `safe: false`, and every output path is normalized to the project root.

The operation only returns a plan. Filename matches are suggestions, and the library, CLI, agent-tool, and MCP surfaces never write or expose an apply command.

Refactor planning resolves either a portable search/workspace-symbol handle or an exact internal review/impact symbol handle, then composes references, direct calls, hierarchy, implementations, candidate tests, and follow-ups from one loaded snapshot and freshness decision. Each section is bounded independently, omissions remain explicit, and internal input identities are normalized to portable target handles in output.

An optional rename uses the same snapshot and preserves the nested rename preview without weakening `rename.safe`. Refactor planning is evidence composition rather than compiler-grade transformation: unsupported dispatch, unresolved external symbols, stale evidence, conflicts, and truncation remain limitations or safety blockers.

The result limit is applied after ranking, so omission counts describe matching candidates rather than pre-filter truncation. Agent, CLI, and MCP surfaces then normalize paths and qualified names to the project root and attach portable handles, exact locations, analysis, freshness, and provenance.

Impact analysis maps diff hunks to changed symbols, follows resolved references and reverse dependencies, and ranks the affected files. Review and agent-facing commands build on that evidence, adding bounded snippets or related findings as requested. Call compatibility is deliberately narrower than type checking: it reports high-confidence arity mismatches for resolved callable changes, not overload, dispatch, macro, or data-flow conclusions.

Precise semantic navigation depends on successful parsing and queries. Reduced recovery can preserve useful file edges without claiming equivalent symbol or scope analysis. Current per-language capabilities are listed in the [language parity matrix](./language-parity.md).

## Cache and session behavior

Caching avoids repeating work; it does not change extraction or resolution semantics.

- `off` is useful for a deliberately cold run.
- `memory` reuses parsed work inside one process.
- `disk` persists compatible parsed-file entries and an incremental graph manifest under `.codegraph-cache/index-v1` for later commands.
- Strict content hashes favor reliable reuse. Non-strict metadata checks are an explicit speed tradeoff.

An incremental graph starts from a compatible manifest, keeps edges for unchanged files, and replaces edges for changed files. Changes to file signatures, discovery configuration, graph options, cache schema, or relevant build options invalidate the affected reuse boundary. Corrupt or unsupported cache data is rebuilt rather than treated as current analysis.

Disk-backed text and hybrid search lazily maintain `.codegraph-cache/index-v1/search-v1.sqlite`. Its file and chunk rows come from the loaded snapshot's manifest signatures. SQLite FTS5 selects candidates only; the existing exact matcher and ranker remain authoritative.

A bounded worker pool updates added, changed, deleted, and retired files. One SQLite transaction commits the affected rows and metadata.

Readers use the sidecar only when its project snapshot identity matches the loaded snapshot. On a mismatch, Codegraph updates and revalidates the sidecar; it falls back to in-memory source scanning only if that update cannot be used. Writer contention, unavailable storage, future schemas, or corruption also use in-memory source scanning. Codegraph never returns mixed-snapshot results.

The sidecar stores normalized source and chunk text. [Installation](./installation.md#local-caches) covers sensitive-data handling, cache-off behavior, and safe deletion.

Long-lived agent and review sessions reuse only compatible index state. They refresh it when relevant file, configuration, or project signals drift.

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
