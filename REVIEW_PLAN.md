# Code Review Follow-up Plan

Scope: `src/graphs`, `src/impact`, and `src/indexer`.

## Checklist

- [x] Thread `maxRefs` through impact reference lookup.
  - `src/impact/analyzer.ts` applies `maxRefs` after `findReferences()` returns, so hot symbols can still scan and contextualize more references than needed.
  - Suggested fix: pass `maxReferences` to `findReferences()` with enough headroom for test and ignore filtering, then keep the existing post-filter cap.
  - Tests: impact analysis with a hot symbol, ignored/test refs, and `refContext` enabled.

- [x] Reuse parsed context for namespace member reference lookup.
  - `src/indexer/navigation.ts` builds or retrieves scope for namespace imports, then `collectNamespaceMemberRefs()` reparses the same file with no cached context.
  - Suggested fix: pass parsed context, or a tree/source/sup tuple, into namespace member collection.
  - Tests: namespace reference lookup with `keepParsed` enabled and disabled.

- [x] Consolidate native and JS fallback import-binding conversion.
  - `src/indexer/imports.ts` duplicates capture-to-`ImportBinding` conversion and per-language heuristics across native and JS fallback branches.
  - Suggested fix: introduce a shared helper that accepts normalized captures and emits bindings.
  - Tests: parity coverage for Java, C#, Go, Rust, Kotlin, Swift, Zig, C, and C++ import binding extraction.

- [x] Share module specifier parsing between graph and index extraction.
  - `src/graphs/specifiers.ts` has its own parser path for Python, PHP, Kotlin, Rust, C#, JS/TS fallback, HTML-like, and stylesheet specifiers.
  - Suggested fix: factor common statement/specifier parsing below both graph specifiers and index import binding extraction.
  - Tests: graph/index parity tests for extracted raw specifiers and type-only behavior.

- [x] Deduplicate member-chain resolution in detailed symbol graph.
  - `src/graphs/symbol-graph-detailed.ts` contains two near-identical chain walkers for namespace/member usage.
  - Suggested fix: extract a shared chain resolver that accepts the emitting callback and label.
  - Tests: `membersOnly` and full detailed symbol graph cases for optional chaining, subscript/string keys, and namespace imports.

- [x] Review manifest/index build edge merging for duplicate handling cost.
  - `src/indexer/build-index.ts` only deduplicates workspace manifest edges through `appendUniqueGraphEdges`; per-file graph edges are appended directly.
  - Suggested fix: decide whether duplicate edges are expected from per-file collectors, and centralize edge key generation if deduplication is required.
  - Tests: duplicate import edges from mixed graph/index paths and workspace manifest edges.

- [x] Extract shared diff hunk utilities for impact workflows.
  - Hunk line parsing exists in `src/impact/map.ts`, `src/impact/suggestions.ts`, `src/impact/report.ts`, and `src/impact/report-suggestions.ts`.
  - Suggested fix: create a small shared module for changed-line collection, added/removed line text extraction, removed-line mapping, and new-file hunk ranges.
  - Tests: deletion-only hunks, mixed replacement hunks, EOF deletion, and report hunk range rendering.

- [x] Reuse graph adjacency helpers in impact context and test candidate discovery.
  - `src/impact/context.ts` rebuilds forward and reverse dependency maps locally instead of using `index.graphAdjacency` or `buildGraphAdjacency`.
  - Suggested fix: route file-subgraph and candidate-test traversal through existing graph adjacency helpers while preserving edge metadata where needed.
  - Tests: candidate test ranking and N-hop context traversal with duplicate and type-only edges.

- [x] Cap reference scans in untested-change suggestions.
  - `src/impact/report-suggestions.ts` calls `findReferences()` for every changed symbol while building test coverage suggestions, but does not pass `maxReferences`.
  - Suggested fix: add a small cap or option-derived cap for this probe, since it only needs to know whether any reference is in a test file.
  - Tests: exported hot symbol with many references and at least one test reference.

- [x] Reduce expensive streaming impact item deduplication.
  - `src/impact/streaming.ts` deduplicates emitted items by `JSON.stringify(item)`, which can become expensive when context refs are included in large partial updates.
  - Suggested fix: use a stable structural key based on file, phase, reasons, symbols, severity/depth, and ref count instead of serializing full context payloads.
  - Tests: streaming with repeated partial updates and `refContext` enabled.

## Second-Pass Complexity Findings

- [x] Split the CLI dispatcher into shared command context plus focused command runners.
  - `src/cli.ts` has a 1,188-line `runCliWithActiveRuntime()` block that mixes argument parsing, discovery setup, graph/index/review command execution, output formatting, report writing, and repeated build-option assembly.
  - Suggested fix: extract a `CliCommandContext` builder, a `resolveCliScanPlan()` helper that returns files plus deleted/existing git state once, and move the remaining in-file command bodies into focused modules. Start with `graph`, `index`, `impact`, and `review` because they contain the most duplicated build/index/report plumbing.
  - Tests: CLI regression coverage for `graph --sqlite`, `graph --symbols-detailed`, `index --json`, `impact --pretty`, `review --summary`, and include-root/git-diff combinations.

- [x] Factor import extraction into language-specific extractors with a shared binding sink.
  - `src/indexer/imports.ts` still has a 1,018-line `collectImportsForFile()` orchestration block. It now shares implicit binding conversion, but graph-only handling, Python regex import extraction, statement overrides, native capture handling, and JS/CJS fallback remain coupled in one function.
  - Suggested fix: introduce an `ImportExtractionContext` with `resolveFrom()`, `pushBinding()`, fallback reporting, and source/language metadata; move Python, JS/CJS fallback, graph-only, and native statement override logic into separate modules under `src/indexer/imports/`.
  - Tests: import binding parity for TypeScript/JavaScript, Python multiline and alias forms, Java/Kotlin/C#/Go/Rust/PHP native and fallback paths, and graph-only module specifier behavior.

- [x] Decompose detailed symbol graph collection into reusable AST passes.
  - `src/graphs/symbol-graph-detailed.ts` has a 690-line `buildSymbolGraphDetailed()` with nested walkers for definitions, aliases, member chains, calls, class inheritance, decorators, and Rust impls.
  - Suggested fix: build per-file indexes (`localsByName`, imported alias maps, namespace maps), extract small collectors for `uses/calls`, member chains, decorators, class inheritance, and Rust impls, and run one merged traversal per function body where possible.
  - Performance opportunity: current function-body processing walks the same subtree separately for alias uses, member uses, and calls; a merged visitor should reduce repeated AST traversal on large functions.
  - Tests: detailed symbol graph edge cases for namespace members, `membersOnly`, decorator edges, Java/C# inheritance, Rust impls, optional chaining, and max-edge pruning.

- [x] Split review report generation into staged pipeline helpers.
  - `src/review.ts` has a 485-line `buildReviewReport()` that handles change discovery, diff normalization, deleted snapshots, incremental indexing, changed-symbol mapping, reference lookups, file summaries, graph delta, candidate tests, SQL context, risk summary, and final report assembly.
  - Suggested fix: extract `collectReviewChanges()`, `buildReviewIndex()`, `summarizeChangedFiles()`, `collectReviewGraphDelta()`, and `assembleReviewReport()` so each stage has explicit inputs/outputs and can be tested directly.
  - Correctness opportunity: make deleted/missing/ignored file status transitions explicit in one data structure instead of spreading them across changed-file sets, diff maps, and final summary branches.
  - Tests: raw diff, git `WORKTREE`, deleted files, missing explicit files, ignored diff files, include-symbol-details, SQL context, and candidate-test sorting.

- [x] Share full and incremental index-build state machines.
  - `src/indexer/build-index.ts` has two large overlapping flows: `buildIndexFromFileListShared()` at 303 lines and `buildProjectIndexIncremental()` at 371 lines. Both initialize reports, graph options, file signatures, worker pools, parsed caches, bloom filters, JSON dependency modules, graph adjacency, manifest writes, and final `ProjectIndex` assembly.
  - Suggested fix: extract reusable helpers for `IndexBuildRunState`, `prepareFileSignatures()`, `buildFileModules()`, `writeIndexManifest()`, `finalizeProjectIndex()`, and parsed-cache trimming. Keep full and incremental file-selection logic separate, but share execution and finalization.
  - Performance opportunity: centralizing file signature and cached-edge reuse should make it easier to avoid recomputing graph edges or SQL fact caches when only module cache state changed.
  - Tests: cache modes, incremental strict, manifest option mismatch, deleted tracked files, SQL corpus signatures, worker pool parity, and parsed-cache reuse.

- [x] Split multi-language resolution into per-language modules and unify project symbol indexes.
  - `src/util/resolution.ts` is 1,872 lines and combines TS path config, generic specifier resolution, node_modules resolution, JVM package indexes, PHP composer/symbol scanning, Go module/workspace handling, and Python package resolution.
  - Suggested fix: move language-specific resolvers into `src/util/resolution/{go,jvm,php,python,node}.ts` and keep `resolveImportSpecifier()` as a small dispatcher. Share a generic project-symbol-index builder for Java, Kotlin, and PHP while keeping PHP's multi-namespace/kind metadata.
  - Correctness opportunity: PHP, Java, and Kotlin symbol indexers use regex/token scanners independent of native parsed symbols; consider reusing native/local export extraction where available so import resolution and indexed symbols stay aligned.
  - Tests: resolution regression suites for Java, Kotlin, PHP Composer/autoload/classmap, Go workspaces, Python namespace packages, TS paths, node_modules exports, and cache clearing.

## Third-Pass Complexity Findings

- [x] Share declaration and export extraction infrastructure across locals, scope, and impact mapping.
  - `src/indexer/locals-and-exports.ts` has a 598-line `collectLocalsAndExportsFromSource()` and `src/indexer/scope.ts` has a 263-line `buildScopeIndexFromSource()`; both classify declaration names, compute ranges, walk parameters, and interpret language-specific definition nodes. `src/impact/map.ts` also repeats declaration-name checks while locating changed symbols.
  - Suggested fix: introduce a shared declaration walker that emits normalized declaration events (`name`, `kind`, `range`, `node`, `scopeRole`) and let locals/export extraction, scope indexing, and impact mapping consume those events.
  - Correctness opportunity: this would keep language additions from updating locals but not scope, or scope but not impact symbol mapping.
  - Tests: scope-quality, changed-line mapping, and cross-language local/export extraction for TypeScript, Python, Go, Rust, Kotlin, Swift, C/C++, PHP, and Ruby.

- [x] Split module specifier extraction from edge resolution and reuse fallback/query handling.
  - `src/graphs/specifiers.ts` has a 330-line `collectModuleSpecifiersFromSource()` and `src/graph-edge-collector.ts` has a 109-complexity `collectEdgesForFile()`. Both contain language routing, fallback reporting, graph-only handling, HTML/style extras, and per-language resolution decisions.
  - Suggested fix: make specifier extraction return normalized `ModuleSpecifier` values plus diagnostics only, then move edge target resolution into a table of language-specific resolver functions. Share helper code for native query execution, JS fallback recovery, HTML/style appended specifiers, and graph-only resolution config.
  - Performance opportunity: the edge collector currently resolves all specifiers via `Promise.all`, which can burst filesystem work for large files; a bounded resolver queue would make graph builds smoother without changing results.
  - Tests: fallback import extraction diagnostics, graph-only document links, CSS/SCSS/Less URL imports, HTML/Vue/Svelte/Astro imports, PHP qualified references, JVM package fan-out, and dynamic import heuristics.

- [x] Unify member-access parsing for goto, references, and detailed symbol graph.
  - Member/object/property extraction appears in `src/indexer/navigation-goto.ts`, `src/indexer/navigation.ts` (`collectNamespaceMemberRefs()`), and `src/graphs/symbol-graph-detailed.ts`. Each handles Python/Ruby/Go/Java/C#/Kotlin/Swift member shapes with local variations.
  - Suggested fix: create a `memberAccess.ts` helper that normalizes member nodes into `{ object, property, chain }` and supports language-specific node shapes. Use it in goto, namespace reference collection, and detailed symbol graph member/call collectors.
  - Correctness opportunity: optional chaining, Kotlin/Swift navigation expressions, Ruby scope resolution, and Go qualified types should resolve consistently across goto, refs, and symbol graph edges.
  - Tests: `goto`, `references`, and detailed-symbol edge cases for namespace members, optional/member chains, Ruby `::`, Go qualified types, Java static members, C# nested members, Kotlin aliases, and Swift static factories.

- [x] Extract shared SQL lexical helpers and reuse them across facts, navigation, and MCP query checks.
  - `splitTopLevelCommaSeparated()` is duplicated in `src/sql/extractFacts.ts` and `src/sql/navigation.ts`; paren-depth logic is also duplicated. `src/mcp/server.ts` has its own SQL comment/literal stripper for resource checks.
  - Suggested fix: create `src/sql/lex.ts` for top-level splitting, paren depth, comment/string masking, and bounded identifier scanning. Reuse it in fact extraction, SQL navigation, and MCP SQLite query validation.
  - Correctness opportunity: SQL parsing edge cases such as quoted strings, comments, nested expressions, and CTE clauses should not diverge between review facts and navigation.
  - Tests: SQL fact extraction, SQL navigation, SQL review context, and MCP `query_sqlite` resource-bound rejection tests.

- [x] Share native binding contracts between runtime and worker code.
  - `NativeBinding` is declared separately in `src/native/treeSitterNative.ts` and `src/worker/nativeExtractWorker.ts`, with slightly different optional capabilities.
  - Suggested fix: move the binding interface and result/fallback reason contracts into a shared native module imported by both runtime and worker code.
  - Correctness opportunity: adding a native capability such as syntax-tree parsing or compact queries should update one contract instead of relying on duplicated structural types.
  - Tests: native binding loader, native worker parity, native runtime mode, and native parser ownership tests.

- [x] Decompose project-file discovery parsers into manifest-specific helpers.
  - `src/util/projectFiles.ts` combines discovery traversal with many manifest-name parsers (`package.json`, TOML, INI, setup.py, Maven, Gradle, .NET, Go, Gem, Swift) and a long `PROJECT_FILE_DEFINITIONS` registry.
  - Suggested fix: move parser helpers and definitions into `src/util/projectFiles/definitions.ts` and `src/util/projectFiles/parsers.ts`, leaving traversal/path-safety logic in the main module.
  - Correctness opportunity: parser tests can cover manifest name extraction directly, instead of only through full project discovery.
  - Tests: project file discovery, workspace detection, language parity docs fixtures where project metadata affects external classification.

- [x] Split MCP server into tool registry, HTTP transport, file security, and SQL guard modules.
  - `src/mcp/server.ts` is 1,286 lines and mixes MCP tool handlers, Streamable HTTP session handling, Host-header checks, JSON body parsing, file confinement, file-prefix reads, UTF-8 truncation, SQLite query guarding, and row/byte bounding.
  - Suggested fix: extract `mcp/tools.ts`, `mcp/http.ts`, `mcp/security.ts`, and `mcp/sqliteGuard.ts`, keeping `server.ts` as composition glue.
  - Reuse opportunity: UTF-8 truncation and path confinement are general utilities that could also support artifact/file-reading code paths.
  - Tests: MCP server tests for tool handlers, HTTP Host validation, request size limits, artifact path confinement, file reads, SQLite row/byte limits, and unsupported SQL functions.

- [x] Centralize agent limit normalization and bounded output shaping.
  - `src/agent/search.ts`, `src/agent/explain.ts`, and `src/agent-tools.ts` each normalize limits, bound results, and convert file/module references into agent-facing shapes. Handle formatting is shared, but bounded-list and output normalization policies are still scattered.
  - Suggested fix: introduce `src/agent/bounds.ts` and `src/agent/normalize.ts` for limit clamping, bounded-list metadata, relative path normalization, and common follow-up command shaping.
  - Correctness opportunity: agent search, explain, artifact questions, and tool wrappers should report omission counts and path shapes consistently.
  - Tests: agent search, agent explain, agent tools, artifact build, and package metadata API-surface tests.

## Fourth-Pass Complexity Findings

- [x] Split native runtime orchestration from native query execution helpers.
  - `src/native/treeSitterNative.ts` is a high fan-in hotspot and now owns binding loading, runtime-mode enforcement, normalized query caching, compact/full query execution, single-query execution, JS fallback bridging, and syntax-tree parsing.
  - Suggested fix: extract native binding state/runtime-mode helpers, normalized query metadata, query execution wrappers, and JS fallback bridging into focused modules under `src/native/`. Keep the public runtime facade small and preserve existing exported entry points.
  - Correctness opportunity: compact imports, full language queries, ad-hoc queries, and syntax-tree parsing repeat fallback reason/error shaping; one result-normalization helper would keep native-required failures and unsupported-language behavior consistent.
  - Tests: native runtime mode, native query normalization, compact imports fallback, native parser ownership, native worker parity, and explicit native-required failure paths.

- [x] Decompose SQLite persistence into schema, write/update, and query modules.
  - `src/sqlite.ts` is 920 lines and combines schema creation/migration, insert/delete helpers, full writes, incremental updates, canned graph queries, raw read-only query validation, and snapshot metadata.
  - Suggested fix: split `sqlite/schema.ts`, `sqlite/write.ts`, `sqlite/update.ts`, `sqlite/query.ts`, and `sqlite/guards.ts`. Keep schema-version handling and migration helpers isolated so persistent storage changes have one upgrade path.
  - Correctness opportunity: `ensureSchema()` creates tables and patches columns in the same file as query execution; separating schema upgrades would make older on-disk database regression tests easier to maintain.
  - Tests: SQLite full write, incremental update/delete, schema migration from older fixtures, raw read-only guard behavior, artifact SQLite generation, and MCP SQLite query paths.

- [x] Extract impact report assembly into reusable compact/full report stages.
  - `src/impact/report.ts` has a 265-line `buildCompactReport()` plus full-report assembly, re-export chain discovery, top impacts, clusters, cycles, and surface-area summaries in one module.
  - Suggested fix: introduce staged helpers for display-file normalization, file-index construction, compact serializers, graph summary sections, re-export chains, top impacts, clusters, and surface area. Share the precomputed file/symbol indexes between compact and full formats.
  - Performance opportunity: compact report construction repeatedly calls `displayFile()` and looks up file indexes across each section; a shared serializer context can avoid repeated normalization and make missing-index errors explicit.
  - Tests: compact/full impact reports, project file metadata, re-export chains, graph cycles, clusters, surface area summaries, top impacts, and schema-version compatibility.

- [x] Split impact analyzer into direct-reference, transitive, and severity calculators.
  - `src/impact/analyzer.ts` has a 221-line `analyzeImpact()` that handles option normalization, ignore/test matchers, bounded reference lookup, streaming emission, direct impact merging, file-level changes, and transitive propagation. The same module also owns severity scoring.
  - Suggested fix: extract `impact/direct.ts`, `impact/transitive.ts`, and `impact/severity.ts` around a shared `ImpactAnalysisContext` containing matchers, dependency stats, diagnostics, and emit hooks.
  - Correctness opportunity: include-test and ignore-glob policy is rebuilt across direct and transitive phases; one context would keep filtering and diagnostics consistent as new impact reasons are added.
  - Tests: direct refs with `maxRefs`, ignored/test refs, file-level changes, transitive depth/type-only edges, diagnostics counters, streaming partial items, and severity weight overrides.

- [x] Centralize build-cache option normalization, manifest comparison, and reports.
  - `src/indexer/build-cache.ts` is 807 lines and mixes workspace manifest edges, memory/disk module cache, file signatures, fallback extraction reports, manifest IO, build-option summaries, diffing, and graph-option equality.
  - Suggested fix: split cache option normalization/equality into `indexer/build-cache/options.ts`, manifest IO/verification into `manifest.ts`, module cache read/write into `module-cache.ts`, and report shaping into `reports.ts`.
  - Correctness opportunity: the same normalized option shapes drive manifest writes, manifest diffs, and graph-option equality; a single typed comparer would reduce false rebuilds and missed rebuilds when discovery or graph options change.
  - Tests: cache invalidation, cache strict/off modes, discovery option normalization, graph option equality, fallback extraction report aggregation, disk cache reuse, and manifest mismatch messages.

- [x] Decompose graph-only document link extraction and chunking by format.
  - `src/documentLinks.ts` is 692 lines and routes Markdown, MDX, Astro, Handlebars, reStructuredText, AsciiDoc, HTML attributes, inline scripts, link normalization, and Markdown parsing in one file. `src/chunking/chunkFile.ts` is another large format-sensitive flow for block extraction, splitting, merging, and gap filling.
  - Suggested fix: move document extractors into `documentLinks/{markdown,html,rst,asciidoc,sfc}.ts` behind a small dispatcher, and split chunking into match collection, block classification, large-block splitting, merge, and gap-fill helpers.
  - Correctness opportunity: document specifier normalization should match graph-only edge extraction, chunking, and source-style imports for mixed formats like MDX/Astro/SFC files.
  - Tests: Markdown reference/inline links, MDX/Astro/Handlebars imports, RST toctrees/targets, AsciiDoc xref/include/link forms, HTML `srcset`/inline scripts, CSS-style URLs, and chunk splitting/merge behavior.

- [ ] Split external dependency classification into manifest parsers, stdlib tables, and context lookup.
  - `src/graphs/external-classifier.ts` is 743 lines and contains large stdlib tables, manifest parsers for many ecosystems, ancestor-boundary search, package-name matching, caches, and final external classification.
  - Suggested fix: move ecosystem manifest readers into `graphs/external/manifests.ts`, stdlib/module tables into `stdlib.ts`, context/ancestor lookup into `context.ts`, and leave `classifyExternalSpecifier()` as a small coordinator.
  - Correctness opportunity: manifest parsing overlaps with project-file discovery but uses separate parsing rules; extracting parser units makes it easier to align dependency detection with discovery fixtures and language parity claims.
  - Tests: unresolved import classification for Node, Python, Ruby, Go, Rust, Zig, Java/Kotlin, .NET, C/C++, Swift, Composer, nested manifests, VCS boundaries, and cache reset/stats.

- [ ] Separate graph query parsing and traversal execution from SQLite query dispatch.
  - `src/query.ts`, `src/graphs/queries.ts`, `src/cli/graphQueries.ts`, and `src/sqlite.ts` each participate in graph-query parsing, graph traversal, result bounding, cycle detail construction, and canned SQL-backed query dispatch.
  - Suggested fix: introduce a typed query AST/parser module and execution modules for in-memory graph queries and SQLite-backed canned queries. Reuse traversal helpers for neighbors, shortest paths, reverse dependencies, cycles, and unresolved imports.
  - Performance opportunity: `querySymbolNeighbors()` builds incoming/outgoing maps per call and then scans all edges again to materialize results; reusable adjacency indexes would help interactive agents and CLI graph queries on large symbol graphs.
  - Tests: text query parsing, symbol neighbor depth/direction/label filters, detailed cycle ordering/remediation hints, unresolved import classification, CLI graph query output, and SQLite canned query parity.
