# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

GitHub Releases remain the certified publish record. This file summarizes product-facing changes so the repository itself has a readable history.

## [Unreleased]

### Changed

- Release candidate assembly now runs only source-quality checks and one package build, leaving
  tests, security, fixture, and package certification to their dedicated release jobs.
- Clean disk-cache builds now skip module lookups when the cache database does not exist, while
  preserving per-file miss accounting.

### Fixed

- The certified release workflow now generates and validates its final committed lock under Node
  22/npm 10, matching the minimum supported CI runtime.

## [2.3.0] - 2026-08-28

### Changed

- MCP tool responses now use compact JSON, `explore` omits source by default, and follow-ups are
  deduplicated and limited to callable MCP tools
  ([#286](https://github.com/lzehrung/codegraph/pull/286)).
- CLI help and validation are grouped more clearly, dependency traversal is bounded by default,
  graph JSON is deterministic, and long index checks emit a delayed progress heartbeat
  ([#287](https://github.com/lzehrung/codegraph/pull/287)).
- Detailed graph cache comparison now avoids temporary edge maps and repeated string allocation
  ([#290](https://github.com/lzehrung/codegraph/pull/290)).

### Fixed

- Pinned standalone release-script lock generation and validation to npm 10.9.2.

### Removed

- Removed four unused low-level facade exports and added a deterministic snapshot guard for future
  public API changes ([#288](https://github.com/lzehrung/codegraph/pull/288)).

## [2.2.3] - 2026-08-28

### Changed

- Cold discovery now uses Git-aware file enumeration, cached repository facts, grouped ignore
  matching, and bounded symlink screening. On the measured Unreal project, discovery fell from
  26.1 seconds to 1.0-1.4 seconds with the same 3,841 files
  ([#293](https://github.com/lzehrung/codegraph/pull/293),
  [#297](https://github.com/lzehrung/codegraph/pull/297)).
- Project-local state now lives under one `.codegraph/` directory, with disk caches in
  `.codegraph/cache/index-v1/`. Existing project and repository caches migrate automatically
  ([#296](https://github.com/lzehrung/codegraph/pull/296)).

### Fixed

- Release commits now normalize and verify the exact lockfile immediately before staging it,
  preventing later manifest or publication steps from committing a host-pruned dependency graph
  ([#294](https://github.com/lzehrung/codegraph/pull/294)).

## [2.2.2] - 2026-08-27

### Changed

- Stabilized cache implementation fingerprints, reused hydrated snapshots without cloning, and
  reported cache invalidation causes more clearly
  ([#283](https://github.com/lzehrung/codegraph/pull/283)).
- Reduced index and navigation work while preserving nested tsconfig aliases and resolved re-export
  targets ([#292](https://github.com/lzehrung/codegraph/pull/292)).

### Fixed

- Restored optional emnapi lockfile entries required by clean installs and added a pre-publication
  `npm ci` lockfile gate
  ([#289](https://github.com/lzehrung/codegraph/pull/289),
  [#291](https://github.com/lzehrung/codegraph/pull/291)).

## [2.2.1] - 2026-08-27

### Fixed

- Corrected Markdown link checks for aliased project roots and kept cached symlink hints confined to
  the requested root.

## [2.2.0] - 2026-08-26

### Added

- Added `codegraph server start|status|stop` for one project-local, loopback-only MCP HTTP server,
  with health checks, per-user credentials, startup diagnostics, and explicit restart behavior
  ([#281](https://github.com/lzehrung/codegraph/pull/281)).

### Changed

- Added columnar native syntax-tree encoding and removed a redundant parse
  ([#276](https://github.com/lzehrung/codegraph/pull/276)).
- Reduced native addon loading, hashing, and worker startup on warm and incremental runs, and removed
  cached addon versions unused for one month
  ([#278](https://github.com/lzehrung/codegraph/pull/278)).
- Enforced `@typescript-eslint/no-unused-vars` as an error with `^_` ignore patterns.

### Removed

- Removed the inert non-native parser seam, unread extraction parameters, and leftover declarations
  that no code used. Existing caches rebuild once after the fingerprint change
  ([#277](https://github.com/lzehrung/codegraph/pull/277)).

### Fixed

- Removed an unreachable `parseAgentSqlHandle` branch that could have skipped decoding.
- Retried transient Windows filesystem failures during standalone installation and restored a
  clean-installable npm lockfile.

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
