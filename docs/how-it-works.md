# How It Works

## Short version

codegraph turns source files into a resolved dependency graph and a semantic index:

1. Discover files under the selected roots.
2. Parse supported source languages with Tree-sitter and run language queries for imports, exports, definitions, and bindings.
3. Resolve each module specifier to a project file or an external dependency, then assemble forward and reverse graph indexes.
4. Use the same indexed symbols, scopes, and edges for navigation, impact analysis, review, and agent queries.
5. Reuse compatible parsed files and graph edges when caching or a long-lived session is enabled.

The native addon is required for Tree-sitter parsing and queries. TypeScript code owns discovery, normalization, resolution, graph assembly, semantic operations, and output.

The first index-backed question, such as `codegraph explore "..." --root .`, may discover, parse, resolve, and persist a cold index. Interactive progress goes to stderr; later compatible queries reuse the project-root cache and only rebuild or update work invalidated by file, configuration, or option changes.

CLI stdio MCP processes bridge requests to a compatible owner per physical project root. The owner holds the session, worker pool and watcher; the existing verified HTTP lifecycle coordinates startup and detects incompatible configuration or runtime code. An explicit workspace routes to those same per-project owners without building a parent-root graph. Library sessions remain caller-owned.

## Discovery

Commands start from the project root and any selected scan roots. Git repositories normally use tracked and non-ignored untracked paths; other modes scan the filesystem. Discovery applies supported-extension filtering, honors `.gitignore` by default, and applies configured and command-line include or ignore globs. Excluding generated, vendored, and fixture trees here avoids reading or parsing them later.

Each index build shares config inputs, Git paths, directory listings, and ignore rules across config, source, and metadata discovery. Root config files are checked even when Git ignores them. Ignore files inside excluded trees are not hashed on the Git path; changes to parent rules that expose those trees are detected. The context is discarded after the build; source-file signatures and symlink checks stay fresh.

Each discovered file is mapped to a language definition. First-class source languages feed the shared Tree-sitter pipeline. Graph-first formats such as documentation and templates use their dedicated link or specifier extractors where the [language parity matrix](./language-parity.md) says graph support is available.

See [CLI scan and root behavior](./cli.md#project-config) for the distinction between project configuration and one-off command flags.

## Extraction

### Default: Tree-sitter queries

For supported source languages, language definitions provide a Tree-sitter grammar plus queries and classification rules. The indexer parses each file and normalizes query captures into common records for module specifiers, exports, local definitions, import bindings, and scopes. Later stages therefore consume the same shapes across languages.

The native addon performs Tree-sitter parse and query work for supported source languages. Source discovery, normalization, resolution, graph assembly, semantic operations, and output formatting remain in TypeScript.

### Windows installed-runtime cache

On Windows, an installed codegraph package resolves the platform `.node` file without loading it, hashes it with a bounded streaming buffer, and publishes the verified bytes to `%LOCALAPPDATA%\codegraph\native-cache\v1`. Each cache entry is keyed by platform target, package version, and SHA-256; concurrent processes converge on one immutable final file without overwriting mapped binaries.

After a verified load, a source-keyed identity record stores the source and cached-file metadata, runtime details, supported languages, and binding origin. A later process reuses it only while the exact files still match and the one-day re-verification interval has not expired; entries not verified for 30 days are pruned.

The loader requires the cached path and records both the package-owned source and loaded origin. Local workspace builds bypass this cache so rebuilding `packages/codegraph-native` still takes effect immediately, while non-Windows installed packages keep their existing package loader.

### Native failures and skipped files

The native addon is required. If it cannot load, Codegraph returns an error; run `codegraph doctor` to diagnose the installation. A file over the native size limit is skipped with `sourceTooLarge` in the backend report. A failed native query reports `queryFailure` and does not trigger regex recovery. A valid empty query result stays empty. Graph-only document and stylesheet extraction is unchanged.

Each indexed module records whether native parsed or skipped its file, and whether part of it could not be indexed (its syntax tree could not be built, the imports of its source or of an embedded Vue or Svelte block could not be extracted, or its processing failed), so the `analysis` summary and its skipped-file count describe the whole index, including files reused from the cache, not only the files the latest build parsed. The label counts each skipped or degraded file once, and a build report adds only a file it names that the index holds no module for, such as a C# file read only to find a namespace. `backend: "unknown"` means no indexed file was parsed natively, as in a project of Markdown and other graph-only files.

A C# `using X = N.Type;` or `using static N.Type;` whose type lookup could not read a C# file of the project (a file that discovery ignores, for example) stays external, and its importer counts as degraded in `analysis`. The next build that changes any file extracts that importer again, so the alias resolves once the file reads. An incremental build that finds no changed file serves the project snapshot as it was.

## Resolution and graph construction

Extraction produces raw module specifiers. Resolution then turns them into graph targets:

- Relative and absolute-like paths are matched to discovered files with supported extension and index-file rules.
- TypeScript path aliases and `baseUrl`, workspace packages, and package metadata participate where configured.
- `node_modules` resolution is opt-in with `--resolve-node-modules`.
- Resolution hints and dynamic-import heuristics are opt-in because guesses can create false positives.
- A specifier that cannot be mapped to a project file remains an `external` node instead of disappearing.

An index build answers the file, directory, and real-path questions of resolution through one cache that lives for that build, so the next build sees a file created in between. The cache lists a directory once the build probes it for more than a few names and reads each answer from the listing as `stat` or `realpath` would on that volume, including its case rules; a symbolic link, a directory it cannot list, or a name it cannot match with certainty still goes to the file system. A resolution is cached by the importer's directory for a relative specifier, and by the tsconfig `baseUrl` and `paths` for a bare one, not by importer file.

The resulting file nodes and typed edges are stored with forward and reverse adjacency indexes. That graph powers `graph`, `deps`, `rdeps`, `path`, `cycles`, unresolved-import checks, and the dependency portion of higher-level analysis. Mermaid, DOT, JSON, and SQLite are output views of the same graph model.

## Semantic navigation and impact

The semantic index links definitions, scopes, exports, imports, and resolved calls. `goto`, `refs`, workspace symbols, call and type hierarchies, implementations, and impact read that index. Results use one snapshot and project-relative locations.

Go-to-definition, find references, and the detailed call graph share one implementation of each resolution decision:

- **Bare names.** `src/indexer/name-resolution.ts` looks up the closest scope binding, then a local declared later in the same scope, then imports, compilation-unit peers, and star imports. Language rules are hooks in `src/indexer/name-lookup-policies/`.
- **Members.** `src/indexer/member-selection.ts` searches the receiver's type and then its supertypes, and applies visibility, static or instance scope, and the argument count. Navigation reads types from the index. The graph reads them from its ownership and inheritance edges.
  - The search stops at the first type that declares the name, because that declaration hides the ones above it.
  - Java, Kotlin, and C# overloads span the class hierarchy. There the search continues to ancestors for an overload that accepts the call, and it skips an ancestor method that a same-signature override replaces.
  - In JavaScript, TypeScript, Ruby, Swift, and Kotlin, static and instance members are separate, so a member of the other kind does not hide the name.
- **Receivers.** One classifier decides what a receiver is: `this` or `self`, a declared type, a constructed value, a type name, or a module. Proofs are reused only for the same receiver syntax site, so block, closure, and parameter shadowing cannot borrow another binding's type.
- **Callables.** Each indexed function stores its identity in `SymbolDef.callable`: a key, its owner, and the argument counts it accepts. A C++ prototype and its definition share a key, also across files, unless the function has internal linkage. C declarations share a key only within one file; navigation joins a header prototype and its definition through includes. TypeScript overload signatures and their implementation in one file share a key.
- **Imports.** `src/util/resolution/specifier-targets.ts` maps an import specifier to its target files for both import bindings and file-graph edges.
- **Exports.** `resolveExport` expands each module/name at most once per lookup, including cycles and diamond routes. Uncut, non-ambiguous answers can serve any walk; a cycle-dependent or ambiguous root answer is reused only for the same top-level lookup. Ambiguity propagates through re-exporting barrels, while Python star re-exports use the later binding.

References verify each candidate through go-to-definition. The graph applies two filters of its own. A target must be an indexed symbol, because a parameter or block local has no graph node. A call edge needs a target that accepts the call's argument count, while go-to-definition still names the only candidate so callers of a changed signature stay visible.

References choose the files they verify from the importers of each file, which every index build records, and from two tables that the first lookup of an index builds and every later lookup reuses: the modules that re-export each file, and the modules sorted once. A lookup tests the files that can reach the definition (its re-exporters, their importers, and its compilation-unit peers), not every indexed module, so a definition with no importers costs the same on a project of 17,000 files as on one of 1,800. The indexes belong to one index object and are never stored in a module entry or on disk, so an incremental update returns a new index that starts without them.

Query-time syntax uses two per-index least-recently-used caches:

- Compact source, native columns, query facts, and byte-offset maps have a 4 GiB estimated budget.
- Projected tree views and their scope indexes share a 2 GiB estimated budget. Eviction drops both together; retained compact data can reconstruct the view without another native parse.
- At most 32,768 syntax entries are retained. Concurrent requests share an in-flight parse; an incremental index starts with fresh query caches.
- A small source fingerprint per queried indexed file survives syntax eviction. If a later read finds different source or a missing file, the query fails and requires an index rebuild instead of mixing snapshots. The fingerprint cannot prove that source was unchanged before its first query.
- These are retention estimates, not process RSS limits. Source fingerprints, active requests, graph data, build-time `keepParsed` retention, and allocator overhead are separate.

A test matrix in `tests/call-form-matrix/` checks each language and call form against all three consumers, with a same-named decoy that must not match. The [call-form coverage matrix](./coverage/call-forms.md) reports the results.

Only proven semantic links are reported. Dynamic dispatch, unresolved symbols, and unsupported language features stay absent or appear as limitations; bounds report exact omissions. See the [language parity matrix](./language-parity.md) for per-language coverage.

`rename_preview` and refactor planning produce review evidence only. They never write files, and stale, conflicting, uncertain, or truncated rename plans are not safe.

Impact maps changed symbols to resolved references and reverse dependencies. Severity ranks likely effects, confidence shows resolution certainty, and `diagnostics.memberResolutionCoverage` warns when a language cannot resolve receiver calls.

## Cache and session behavior

Caching avoids repeated work; it does not change extraction or resolution semantics.

- `off` runs cold.
- `memory` reuses parsed work in one process.
- `disk` persists parsed files and an incremental graph under `.codegraph/cache/index-v1`. The index `manifest.json` is compact JSON; pretty-printed files from earlier versions still load.

Disk loads reuse unchanged files and update changed ones. Codegraph validates file, configuration, build, and available Git state before reuse; incompatible or corrupt data is rebuilt. Strict mode hashes content, while non-strict mode accepts the documented metadata speed tradeoff. Graph resolution options (`--resolve-node-modules`, `--resolution-hint`, and `graph.resolutionHints`) are part of that validated state, so changing them invalidates cached modules and edges instead of mixing resolutions from different runs.

`buildProjectIndexIncremental` records indexed or discovery-matching tracked paths that differ from its commit, or from Git's empty tree before the first commit. A manifest rewrite takes a fresh Git diff after file reads; clean recorded state skips signature blob listings, while missing or invalid dirty-path metadata falls back to tracked blob reconciliation. Direct disk/memory builds and whole-project agent sessions refresh restored modules and importers; arbitrary file-list builds do not retire rows outside their scope. `listChangedFiles` confines Git changes to the requested project root, including nested roots and directory aliases.

Git fast-path blind spots remain:

- Reverts hidden by `assume-unchanged` or `skip-worktree` index flags.
- Changes to files inside submodules when Git reports only the gitlink.
- EOL-only rewrites normalized away by `core.autocrlf`.
- Case-only rename-back sequences that retain stale path spelling in the disk cache.

Index builds are not atomic filesystem snapshots. If files change during a build, repeat the update; use `buildProjectIndex(root, { cache: "off" })` when the Git blind spots above apply.

Module and graph cache identities also include effective TypeScript `baseUrl`/`paths` (including `extends`) and workspace package names, locations, `main`, and `exports`. These inputs are checked even when `resolveNodeModules` is disabled, so configuration-only changes cannot leave cached import targets on the old files. Unchanged resolution inputs still permit reuse.

C#, Java, and Kotlin builds prepare per-file facts before resolving imports:

- Native workers reuse each indexed file's extraction tree for namespace and package facts.
- Scan candidates outside indexed discovery use facts-only tasks without retaining source or tree payloads.
- Warm builds reuse unchanged indexed files' persisted facts.
- Cold builds retain raw extraction payloads until resolution consumes them; this avoids repeated parsing but can increase peak memory.

`buildProjectIndex`, `buildProjectIndexFromFiles`, and `buildProjectIndexIncremental` apply the same 8 MiB limit to C# scan candidates with workers on or off, including ignored files and files outside an explicit list. An oversized candidate leaves C# alias and static-using type lookups partial.

The detailed symbol graph that `callers`, `callees`, `supertypes`, `subtypes`, `explain`, `packet get`, `rename-preview`, `refactor-plan`, and `artifact build` read persists beside them as `detailed-symbol-graph.bin`, a compressed binary file of typed columns that holds each file once as a project-relative path. A load builds the graph without parsing source: it checks a SHA-256 of the whole file, header and payload, then the project snapshot identity and the implementation fingerprint, then rebases each file once and checks that the index holds it and that it lies inside the project root, not once per symbol and edge. No step builds the graph as one text string, so a graph of millions of edges persists. A changed project, configuration, or build, a damaged file (a byte changed anywhere in it), or an earlier format rebuilds the graph, and the earlier `detailed-symbol-graph.json` is ignored and removed by the next write.

A cached module is keyed by its own content, but its import targets depend on other files. A warm build extracts a module again when:

- the module changed;
- a file it imports was deleted, or a resolved import or re-export target no longer exists;
- an added file can satisfy one of its specifiers;
- it is a C#, Java, Kotlin, PHP, or C++ module, and a file it depends on changed. These imports resolve through the namespace or package declarations of other files.

With an index manifest, the build re-resolves the affected specifiers of added files. Without one (a `memory` cache, or a `disk` cache that no manifest-writing build has seen), the cached import bindings replace the manifest edges.

Incremental indexing applies the full build's discovery patterns, includes, and ignores, including `.gitignore` and repository/configured excludes, to changed and untracked Git candidates; `buildGraphDelta` uses the same filters for changed paths. Editing or staging an ignored file does not add it to the index. `buildGraphDelta` reports removed manifest files and their edges even when a rename destination is ignored. Explicit library file inputs remain explicit overrides.

An incremental update (`codegraph index`, `buildProjectIndexIncremental`, agent sessions) extracts the importers of a changed file again only when the file's public surface changed:

- The public surface is the file's exported names and kinds, its re-export sources, and, for a file with no exports, the names that a star import would bind. Bodies, parameters, and positions are not part of it, so a body or signature edit extracts only the edited file.
- A changed surface extracts the direct importers. An importer that re-exports from the file has a changed surface too, so a chain of re-exports extracts every importer along it.
- `manifest.json` stores each file's surface (`surface`). A manifest from an earlier version has none, so the first change to each file counts as a surface change.
- The transitive importers of a changed C#, Java, Kotlin, PHP, C++, or Rust file, or a Python `__init__.py`, always extract again, because they resolve through its declarations.

Declaration-based imports name a package, namespace, or module, not a file:

- Any added, changed, or deleted file of the language re-resolves that language's importers. The file suffix or the configured language selects the file.
- Without a manifest, the rows of the previous build show removed or rewritten declarations.
- A build deletes the cache row of each stale importer before it extracts the importer again. A failed extraction or cache write then cannot leave a row that a later build reuses. If a disk row cannot be deleted, the build keeps the previous manifest, so the next build finds the same stale importer.
- A manifest-less full-discovery build also deletes the rows of confirmed-deleted files, so the next unchanged build is fully warm. A build over an explicit file list keeps them, because an importer outside the list still needs them.
- A `memory` cache evicts payloads past 5,000 entries. The old declarations are also unknown when the previous row of a changed file cannot be decoded. The affected importers then re-resolve until a complete build restores the rows.

Existing `.codegraph-cache/` directories migrate automatically to `.codegraph/cache/` on the next run.

Disk search can also store normalized source and chunk text in SQLite, with two trigram indexes over it: the normalized text, and the same text without spaces, so a term that spans word boundaries is an index lookup, not a scan of every chunk. A sidecar from an earlier schema version is upgraded in place on first use from its stored text, without reading source files. Treat that cache as sensitive derived source data; use `--cache off` to avoid it and stop codegraph before deletion.

Long-lived sessions reuse only compatible state and refresh on drift. `codegraph init` can warm the disk cache, but index-backed commands do not require lifecycle initialization.

## Performance choices

Choose the least lossy option that solves the actual bottleneck:

1. **Narrow discovery first.** Scan only the roots you need and ignore generated or vendored trees. Work avoided here benefits every later stage.
2. **Use disk cache for repeated CLI or agent work.** Use memory cache for repeated operations in one process and cache-off for controlled cold runs.
3. **Use `--threads N` for file-level indexing and I/O concurrency.** Start near the available CPU count, then measure; excessive concurrency can become I/O-bound.
4. **Use `--workers` for CPU-parallel native extraction on larger index-building workloads.** It requires the native addon; direct file-only graph output does not use this pool. Single-threaded extraction remains the fallback if a worker pool cannot start, and preprocessed single-file component formats stay on the main thread.

Use `--report` to inspect cache, backend, and worker-pool behavior instead of assuming a tuning flag helped. For controlled evidence about agent-oriented discovery, see the [benchmark methodology and checked results](./benchmarks/README.md); those fixtures do not establish universal speedups.

## Extension and testing

New source-language support should extend the shared definition, native grammar, extraction, resolution, semantic, and fixture conventions rather than introduce a parallel parser architecture. Graph-first languages should state their narrower contract explicitly.

Opt-in dynamic import heuristics enter through `extractDynamicImportSpecifiers(...)` in `src/util/specifiers.ts`, which dispatches to a shared per-language adapter. Each adapter scans source without executing it, emits the common heuristic module-specifier shape, and sends candidates through the existing language resolver. The same adapters run for embedded JS or TypeScript script blocks.

An adapter supplies only its call shapes: the runner owns the trivia mask, the shared constant-path fold, deduplication, and the heuristic confidence tag. A new adapter is appropriate only when static call data maps to the language's existing source module resolver. It must keep alias tracking bounded, ignore computed values it cannot prove, and cover enabled, disabled, and false-positive behavior. Reflection or runtime plugin APIs need separate graph semantics unless their values can be mapped to source files.

- [Adding language support](./adding-language-support.md) gives the implementation and review checklist.
- [Language parity](./language-parity.md) records the public capability matrix.
- [Scenario catalog](./scenario-catalog.md) links claimed behavior to fixtures and regression coverage.

Test the smallest layer that owns a change, then add a small end-to-end fixture when discovery, resolution, or CLI output is part of the contract. Native suites verify extraction, error reporting, and skipped-file behavior without a reduced-mode comparison.

## Related docs

- [CLI reference](./cli.md)
- [Library API](./library-api.md)
- [Agent workflows](./agent-workflows.md)
- [Vectorless search](./search.md)
- [Benchmark methodology and results](./benchmarks/README.md)
