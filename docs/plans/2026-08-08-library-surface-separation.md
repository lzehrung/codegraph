# Library and product package split (2026-08-08)

Status: implemented in 2.0.0. `@lzehrung/codegraph-core` is the slim library package; `@lzehrung/codegraph` remains the CLI, MCP, viewer, and installer product.

## Problem

A single package could narrow import exports, but could not avoid installing MCP, CLI, installer, and viewer dependencies for library consumers.

## Decision

Publish two JavaScript packages:

- `@lzehrung/codegraph-core`: indexing, graph, impact, language, indexer, and agent APIs. No CLI, MCP, installer, or viewer assets.
- `@lzehrung/codegraph`: the product package. It depends on core and provides the CLI, MCP server, viewer, and installer.

Core and product release together. The product publishes after core.

## Implemented boundaries

### Phase 1: directory boundary

Moved package identity helpers from `src/cli/packageInfo.ts` to `src/util/packageInfo.ts`. Library imports no longer cross into `src/cli/`.

### Phase 2: public exports

- Root exports core primitives only.
- Agent APIs and `tool_*` wrappers are `@lzehrung/codegraph/agent`.
- MCP APIs are `@lzehrung/codegraph/mcp`.
- CLI follow-up string formatters are internal.

This is a clean breaking change: removed root exports have no compatibility aliases.

### Phase 3: slim package

`stage-core-package.mjs` derives the core package from documented runtime entry points and their declaration closure. It rejects CLI, MCP, installer, and bin paths. Core has no MCP SDK, `jsonc-parser`, `smol-toml`, viewer assets, or skill assets.

## Migration

- Library-only: `npm install @lzehrung/codegraph-core`.
- Agent APIs: `@lzehrung/codegraph-core/agent` or `@lzehrung/codegraph/agent`.
- MCP APIs: `@lzehrung/codegraph/mcp`.
- CLI, MCP server, viewer, or installer: keep `@lzehrung/codegraph`.

## Verification

- Root entrypoint closure rejects CLI and MCP modules.
- Core staging checks runtime and `.d.ts` dependency closure.
- Certification, release, and onboarding fixtures pack the core tarball and release its manifest with the product manifest.
- `npm run check` passed after implementation.
