# Separating the reusable TypeScript library from CLI, MCP, and viewer bloat (2026-08-08)

Status: Phases 1–3 implemented on branch `refactor/library-surface-separation` (package version 2.0.0). `@lzehrung/codegraph-core` is the slim library package; `@lzehrung/codegraph` remains the CLI/MCP/viewer product and depends on core.

## Problem

`import { ... } from "@lzehrung/codegraph"` (the `"."` export) currently pulls in far more
than a project-graph library consumer needs:

- The full MCP protocol server (`src/mcp/server.ts`, ~58KB, plus `tools.ts`, `http.ts`,
  `sqliteGuard.ts`, `security.ts`, `stdioLifecycle.ts`) and its SDK dependencies
  (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`).
- CLI-presentation helpers that format follow-ups as literal shell strings
  (`formatAgentFollowUpAsCli`, `formatAgentFollowUpsAsCli` in `src/agent/followUps.ts`),
  exported straight from root.
- The entire `agent/*` "agent-shaped JSON" facade duplicated into root even though
  `"./agent"` already exists as its own subpath (see `package.json#exports`).

None of this is separately published — `@lzehrung/codegraph` is one npm package with one
`dependencies` array and one `files` array, so `npm install` always pulls the MCP SDK and
ships `docs/graph-visualization` (vendored `sigma.js`/`graphology` bundles),
`codegraph-skill/`, and the whole CLI `dist/` regardless of which export a consumer
imports. Only static-import surface (what a bundler can tree-shake, what TypeScript
autocomplete surfaces) is fixable without a package split; raw install size is not.

## Current export surface (verified)

`package.json#exports` already carves out `"./agent"`, `"./graphs"`, `"./impact"`,
`"./indexer"`, `"./languages"` alongside `"."`. There is no `"./mcp"` subpath — MCP only
ships bundled into root. `src/cli.ts` / `src/cli/*` / `src/installer/*` are not exported
from `index.ts` today (good), but `src/cli/viewer.ts` (dev graph-viewer HTTP server) and
`src/installer/registry.ts` (1,296 lines; writes MCP/skill config into Claude/Cursor/Codex
etc.) are CLI-only features that ship in `dist/` and inflate the package regardless.

## Verified boundary violations

`src/cli/` is meant to be CLI-only, but `src/cli/packageInfo.ts` (pure `fs`/`path`
helpers: `findPackageRoot`, `getCodegraphPackageRoot`, `getCodegraphVersion`,
`getCodegraphPackageIdentity`, `normalizePathForDisplay`, `pathExists` — no argv parsing,
no stdout/stderr I/O) is imported from **outside** `src/cli/`:

- `src/agent/query-index/update.ts` and `workerPool.ts` — both reachable from the root
  library export via `agent/search.ts` (`searchCodegraph`/`searchCodegraphWithSession`).
  **Today, `import { searchCodegraph } from "@lzehrung/codegraph"` already transitively
  imports a file under `src/cli/`.**
- `src/runtimeIdentity.ts` (imported by `mcp/server.ts` and `cli/doctor.ts`).
- `src/installer/registry.ts`.

This makes it impossible to write a "library never imports `src/cli/`" regression test
(the pattern used for the barrel-import tests in `tests/package-metadata.test.ts`) without
first relocating `packageInfo.ts` — its content is core utility, not CLI-only, and just
lives in the wrong directory.

## Plan

### Phase 1 — Fix the directory boundary (prerequisite, no behavior change)

Move `src/cli/packageInfo.ts`'s content to `src/util/packageInfo.ts`. Update the ~7
importers (`cli/*.ts`, `agent/query-index/update.ts`, `agent/query-index/workerPool.ts`,
`installer/registry.ts`, `runtimeIdentity.ts`). No export or behavior change; this only
makes `src/cli/` an enforceable boundary. Verify with `npx tsc --noEmit` and a targeted
test run; no library API changes yet.

### Phase 2 — Trim the root `"."` barrel (breaking, needs a major version bump)

Remove from `src/index.ts`:

- The `mcp/server.ts` re-exports (`createCodegraphMcpHandlers`, `listCodegraphMcpTools`,
  `serveCodegraphMcp`, `CodegraphMcpHandlers`, `CodegraphMcpServerOptions`). Add a new
  `"./mcp"` subpath export in `package.json#exports` pointing at `dist/mcp/server.js`,
  mirroring the existing `"./agent"` pattern.
- `formatAgentFollowUpAsCli` / `formatAgentFollowUpsAsCli` (CLI shell-string formatting).
  Keep `toolFollowUp` / `AgentFollowUp` (structured data, legitimate for agent
  consumers) under `"./agent"` only; the CLI-string formatter becomes CLI-internal only
  (used by `src/cli/*.ts`, not published).
- The duplicated `agent/*` re-exports already available via `"./agent"` — keep root `"."`
  to graph/indexer/impact/chunking/sql/duplicates/drift/review/session/presets/
  partial-results/lazy-symbols/symbol-hash primitives only. A consumer who wants
  agent-shaped JSON envelopes (freshness, omission counts, portable handles) explicitly
  imports `"@lzehrung/codegraph/agent"`; a consumer who wants the MCP server explicitly
  imports `"@lzehrung/codegraph/mcp"`.

Update every internal consumer (CLI handlers, MCP server itself, tests) to import from the
new subpaths. Update `docs/library-api.md`, `docs/agent-workflows.md`, `docs/mcp.md`, and
`README.md` for the new import paths. Add a `CHANGELOG.md` breaking-change entry and a
migration note (old root imports of agent/MCP symbols now 404 at the type level — no
silent runtime shim, per this repo's clean-cutover convention).

Add a regression test alongside the existing barrel-import tests in
`tests/package-metadata.test.ts`: assert `src/index.ts`'s transitive closure never
resolves a specifier ending in `mcp/server.js`, `mcp/tools.js`, or `cli/*.js` — the same
style already used for `keeps implementation modules from importing through the public
barrel`.

### Phase 3 — Decide whether to also prune install-size (separate package)

Phase 1–2 fix API/bundle surface (what a bundler tree-shakes, what autocomplete shows)
but **not** raw `npm install` weight: `@modelcontextprotocol/server`/`@modelcontextprotocol/node`
stay in `dependencies` because the CLI binary (`codegraph mcp serve`, the primary
documented feature) still needs them, and a single package cannot make its own
`dependencies` conditional on "installed as a library" vs "installed as a CLI." Moving
those to `peerDependencies` with `peerDependenciesMeta.optional: true` would silently
break `codegraph mcp serve` for the majority global-CLI-install audience (npm does not
auto-install optional peers), so it is rejected for this package as long as CLI and
library are one package.

True install-size pruning requires a real package split: a new `@lzehrung/codegraph-core`
workspace member (pure library: graph/indexer/impact/chunking/sql/duplicates/drift/review,
no MCP SDK, no `jsonc-parser`/`smol-toml` installer deps, no vendored viewer assets) that
`@lzehrung/codegraph` (unchanged name/bin, keeps CLI + MCP + viewer + installer) depends on
via the existing `packages/*` workspace, the same pattern already used for
`@lzehrung/codegraph-native`. This is a bigger, higher-blast-radius change (new published
package, new install/versioning surface, every doc/skill referencing "the codegraph
library" needs to say which package) and should only be done if Phase 1–2 turns out to be
insufficient in practice — recommend shipping Phase 1–2 first and revisiting Phase 3 based
on real user feedback about install size specifically (not API surface, which Phase 2 already
fixes).

## Non-goals

- `src/cli/viewer.ts` and `src/installer/registry.ts` are already CLI-only (not exported
  from `index.ts`) and use no heavy runtime dependencies beyond `node:http`/`jsonc-parser`/
  `smol-toml` (the latter two are also used by core config loading, so they cannot be cut
  from `dependencies` without their own investigation). Their only "bloat" contribution is
  shipped static assets (`docs/graph-visualization`, `codegraph-skill/`) in the package
  `files` array, which Phase 1–2 does not address and Phase 3 (package split) would.
- `zod` and `piscina` are used by core config loading and indexing respectively, not just
  MCP/CLI — they stay `dependencies` regardless of phase.

## Verification per phase

- Phase 1: `npx tsc --noEmit`, targeted vitest run of touched files, no export change.
- Phase 2: `npm run check` (full gate), new barrel-boundary regression test green, manual
  smoke of `codegraph mcp serve` (still works via CLI, now importing `"./mcp"` internally)
  and one MCP client round-trip against `tests/mcp-server.test.ts`.
- Phase 3 (if pursued): a fresh `npm pack --dry-run` size comparison for
  `@lzehrung/codegraph-core` vs the current single package, plus a real consumer smoke
  test that imports only `-core` and confirms no `@modelcontextprotocol/*` package
  appears in its resolved dependency tree.
