# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

GitHub Releases remain the certified publish record. This file summarizes product-facing changes so the repository itself has a readable history.

## [Unreleased]

### Changed

- Added `codegraph server start|status|stop` to manage one project-local MCP HTTP server. The loopback-only default serializes lifecycle changes, records a non-secret credential ID after a challenged root, process, and startup-identity health check, writes startup diagnostics to `.codegraph/server.log`, distinguishes confirmed stale state from an unreachable server, and requires an explicit restart after a package update.
- Installed Windows packages that only read a warm cache no longer load the native addon. The
  runtime fingerprint needed the addon's supported-language list, so every cache-validity check
  paid a full load to prove it did not need one; Windows now replays that list from a record beside
  the cached binary. The same record lets a warm run skip the two full-file SHA-256 passes the
  Windows native cache performed per process, re-verifying once a day instead. A tampered binary
  is still detected on the next verification, and any size or mtime change forces one immediately.
- Extraction workers are handed the addon the main thread already resolved instead of repeating
  the whole resolution, which on Windows was two 29 MB hashes and a cache verification per worker.
- The indexer creates its worker pool after it knows which files changed, sizes it by that count,
  and skips it entirely below a measured threshold. A warm run with nothing changed now starts no
  workers at all, and a small incremental update starts at most one per file. The auto threshold
  moved from 250 files to 32 on measurement, so incremental builds between those sizes are now
  parallelized. `--workers` and an explicit `useNativeWorkers` still override the decision.
- Installing a native addon now clears cached copies that no project has used in a month, which
  previously accumulated at roughly 29 MB per version. Retention is by age rather than by
  version because the cache is shared across projects on a machine: two projects pinned to
  different native versions both keep their entry.

### Removed

- Removed the inert non-native parser seam. `isNonNativeParserAvailable`, `isNonNativeParserUnavailableError`, `parseWithLanguage`, `executeQueryAsNativeMatches`, `loadTreeSitterLanguage`, `loadTypeScriptGrammars`, `isParserSyntaxTree`, `__resetParserBackendModuleForTests`, and the `ParserLanguage`, `ParserSyntaxTree`, `QueryMatch`, `QueryCapture`, and `QueryPoint` types are gone, along with `languageForFile`, `LanguageSupport.language`, and `LanguageDefinition.grammar`. Every one of them was either a stub that returned a placeholder, a function that always threw, or a type describing those. The native parser has been the only grammar backend since 2.0.0.
- Removed the `lang` parameter and option from the exported signatures that threaded it: `collectLocalsAndExportsFromSource`, `buildScopeIndexFromSource`, `collectImportsForFile`, and `collectModuleSpecifiersFromSource`, plus the unread `tree` option on `collectImportsForFile`. Callers should drop the argument; nothing read it. This is a breaking change to the library surface, shipping in a 2.x minor by explicit decision, matching how 2.0.0 handled export narrowing without compatibility aliases.
- Dropped `behavior.grammar` from the language-definition cache fingerprint. Existing build caches rebuild once on first run after upgrading, which is the designed rebuild path rather than a schema migration.
- Deleted five leftover declarations that no code read: the superseded `codegraph packet get` command formatters in agent orientation, a duplicate ignorable-character pattern in JVM symbol resolution, a per-file source split in locals extraction, and a bundled-skill read copied into the uninstall planner. `codegraph uninstall` no longer fails when the package's bundled skill file is missing, which it never needed.

### Fixed

- `parseAgentSqlHandle` no longer carries an unreachable branch for handles with more than four colon-separated parts. `formatAgentSqlHandle` percent-encodes the name and file, so a colon in either can never survive as a separator, and that branch would have skipped decoding had it ever run.
- Retried transient Windows filesystem failures while moving standalone-install versions, and restored a clean-installable npm lockfile.

### Changed

- `@typescript-eslint/no-unused-vars` is enforced as an error (with `^_` ignore patterns) instead of being switched off.

## [2.1.2] - 2026-08-19

### Fixed

- Repaired CLI and artifact contracts: SQLite artifacts tolerate unsigned nodes, validation errors consistently use exit code `2`, documented MCP idle timeout parsing works, and graph output/cache options are applied consistently ([#269](https://github.com/lzehrung/codegraph/pull/269)).
- Restored TSX, Python package, JVM, inherited-tsconfig, Unicode search, and rename-preview semantic behavior; agent outputs now preserve freshness and bounded-result metadata ([#270](https://github.com/lzehrung/codegraph/pull/270)).
- Made MCP malformed input, unknown tools, cancellation, HTTP concurrency, artifact serialization, and SQLite authorization report correct, safe protocol behavior ([#271](https://github.com/lzehrung/codegraph/pull/271)).
- Corrected impact/review severity, omissions, truncation, fan-out, and Git-diff handling; hardened portable cache, sidecar, worker, and query-index behavior ([#272](https://github.com/lzehrung/codegraph/pull/272), [#273](https://github.com/lzehrung/codegraph/pull/273)).
- Hardened resumable release publication, installer rollback and TOML ownership, native staging, and CI contract coverage ([#274](https://github.com/lzehrung/codegraph/pull/274)).
- Allowed recursive read-only SQLite queries without permitting writes.

## [2.1.1] - 2026-08-19

### Fixed

- Made cache identities root- and implementation-aware, prevented stale cross-project reuse, and kept resolver, native, and query-index caches valid across updates ([#261](https://github.com/lzehrung/codegraph/pull/261), [#268](https://github.com/lzehrung/codegraph/pull/268)).
- Stabilized CLI output and public API documentation, restored parsed-cache insertion, and improved impact/review result accuracy ([#253](https://github.com/lzehrung/codegraph/pull/253)).
- Preserved Unicode identifier behavior in duplicate fingerprints and navigation, and bounded MCP body/session/query resources.

## [2.1.0] - 2026-08-14

### Changed

- Published certified packages through npm trusted publishing and made public npm installation the primary documented workflow ([#249](https://github.com/lzehrung/codegraph/pull/249)).

## [2.0.6] - 2026-08-11

### Fixed

- Corrected cache identity and project confinement, cross-language semantic resolution, impact ranking, capped-result metadata, and native CI coverage across the full-system review ([#246](https://github.com/lzehrung/codegraph/pull/246)).

## [2.0.5] - 2026-08-11

### Changed

- Discounted medium-confidence member references in impact/review risk ranking and reported limited member-resolution coverage ([#245](https://github.com/lzehrung/codegraph/pull/245)).

## [2.0.4] - 2026-08-10

### Added

- Added navigation, graph, and type-hierarchy coverage for class fields, Java/C# records, PHP/Ruby inheritance, Python match bindings, Rust grouped imports, Go embedding, and several SQL, RST, AngularJS, Swift, and C# constructs ([#237](https://github.com/lzehrung/codegraph/pull/237), [#238](https://github.com/lzehrung/codegraph/pull/238), [#239](https://github.com/lzehrung/codegraph/pull/239), [#240](https://github.com/lzehrung/codegraph/pull/240), [#241](https://github.com/lzehrung/codegraph/pull/241), [#242](https://github.com/lzehrung/codegraph/pull/242), [#243](https://github.com/lzehrung/codegraph/pull/243), [#244](https://github.com/lzehrung/codegraph/pull/244)).

## [2.0.3] - 2026-08-09

### Added

- Accepted qualified symbol paths in navigation commands ([#236](https://github.com/lzehrung/codegraph/pull/236)).

## [2.0.2] - 2026-08-09

### Fixed

- Included the core package in standalone releases and documented core-library workflows.

## [2.0.1] - 2026-08-09

### Fixed

- Certified planned release package versions before publication.

## [2.0.0] - 2026-08-09

### Added

- Published `@lzehrung/codegraph-core` as the slim library install (graphs/indexer/impact/agent helpers) without MCP SDK, installer-only deps, or viewer/skill assets.

### Breaking Changes

- Narrowed the root `@lzehrung/codegraph` export to core library primitives (indexing, graphs, impact, `CodeReviewSession`, SQLite/SQL, chunking, duplicates, drift, review, config, languages, native checks, and indexer `query*` aliases).
- Moved agent-shaped APIs (`createAgentSession`, explore/orient/search/explain/packet/file-view helpers, semantic hierarchy/rename/refactor helpers, and `tool_*` wrappers) to `@lzehrung/codegraph/agent`.
- Moved MCP handlers/server (`createCodegraphMcpHandlers`, `listCodegraphMcpTools`, `serveCodegraphMcp`) to `@lzehrung/codegraph/mcp`.
- Stopped exporting `formatAgentFollowUpAsCli` / `formatAgentFollowUpsAsCli` from public package entry points.
- Relocated package identity helpers from `src/cli/packageInfo.ts` to `src/util/packageInfo.ts` (internal path only).

### Migration

- Library-only consumers should install `@lzehrung/codegraph-core` (and its `./agent` subpath) instead of the full CLI/MCP package.
- Replace root imports of agent APIs with `@lzehrung/codegraph/agent` or `@lzehrung/codegraph-core/agent`.
- Replace root imports of MCP APIs with `@lzehrung/codegraph/mcp`.
- Import `toolFollowUp` / `AgentFollowUp` from the agent entrypoint when needed; do not depend on CLI follow-up string formatters.

## [1.8.111] - 2026-08-05

### Added

- `codegraph viewer` can load a current project graph automatically through the validated disk cache, without requiring an exported JSON file first ([#209](https://github.com/lzehrung/codegraph/pull/209)).

## [1.8.110] - 2026-08-04

### Changed

- Migrated the MCP server runtime to the Model Context Protocol TypeScript SDK v2 ([#208](https://github.com/lzehrung/codegraph/pull/208)).

## [1.8.109] - 2026-08-04

### Changed

- Improved graph viewer selection usability ([#206](https://github.com/lzehrung/codegraph/pull/206)).

## Earlier releases

See the [GitHub Releases](https://github.com/lzehrung/codegraph/releases) page for certified package versions, native package counterparts, checksums, and standalone preview assets.

[2.1.2]: https://github.com/lzehrung/codegraph/releases/tag/v2.1.2
[2.1.1]: https://github.com/lzehrung/codegraph/releases/tag/v2.1.1
[2.1.0]: https://github.com/lzehrung/codegraph/releases/tag/v2.1.0
[2.0.6]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.6
[2.0.5]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.5
[2.0.4]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.4
[2.0.3]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.3
[2.0.2]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.2
[2.0.1]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.1
[2.0.0]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.0
[1.8.111]: https://github.com/lzehrung/codegraph/releases/tag/v1.8.111
[1.8.110]: https://github.com/lzehrung/codegraph/releases/tag/v1.8.110
[1.8.109]: https://github.com/lzehrung/codegraph/releases/tag/v1.8.109
