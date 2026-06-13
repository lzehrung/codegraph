# Native grammar consolidation

**Status:** Completed
**Date:** 2026-06-10
**Completed:** 2026-06-12

## Outcome

Codegraph now uses the Rust native addon as the only Tree-sitter grammar backend.
The `@lzehrung/codegraph-js-fallback` workspace remains only as a compatibility shim package with no grammar bundle and no node-gyp dependencies.
When native is unavailable, Codegraph degrades to reduced graph-only and regex recovery mode instead of loading JS grammars.

## Completed work

- [x] Native is authoritative for grammar-backed languages.
- [x] JS grammar-backed parse/query fallback paths were removed.
- [x] Zero-native degradation now uses reduced graph-only and regex recovery paths.
- [x] `packages/codegraph-js-fallback/package.json` no longer ships `tree-sitter`, `tree-sitter-*`, `@tree-sitter-grammars/*`, or `@derekstride/tree-sitter-sql` dependencies.
- [x] Release/install flows no longer require patching tree-sitter node-gyp packages or `npm rebuild`.
- [x] Docs were updated to describe native-first behavior and reduced mode.

## Final runtime contract

### Native available

- Parse and query execution run through `@lzehrung/codegraph-native`.
- Supported source languages keep full graph extraction, chunking, symbol extraction, navigation, references, and review behavior.

### Native unavailable or `native: "off"`

- Codegraph does not attempt a JS Tree-sitter parse.
- JS/TS/TSX keep regex-backed import/specifier recovery where available.
- Graph-first/document languages continue to work through their existing text extraction paths.
- Other grammar-backed languages degrade safely: graph/index construction continues without parser context instead of throwing a cross-platform `.node` load error.

### Native required with `native: "on"`

- Missing native remains a hard error.

## Key implementation changes

- `src/jsFallback.ts`
  - Replaced the grammar loader bridge with an unavailable compatibility facade.
- `packages/codegraph-js-fallback/js-fallback.cjs`
  - Reduced to a shim package with no grammar runtime.
- `src/indexer/parse-context.ts`
  - Stopped falling back to JS parsing when native syntax trees are unavailable.
- `src/indexer/scope.ts`
  - Requires parser context from native instead of reconstructing scopes through JS fallback parsing.
- `src/indexer/imports.ts`
  - Removed JS grammar import-binding recovery and retained reduced regex recovery.
- `src/indexer/locals-and-exports.ts`
  - Removed JS grammar tree/query fallback; JS/TS regex export recovery remains.
- `src/graphs/specifiers.ts`
  - Removed JS grammar query fallback; native/query output plus regex and graph-only recovery remain.
- `src/chunking/chunkMatches.ts`
  - Native-only query execution.
- `src/native/jsBridge.ts`
  - Reduced unified query execution to native-only plus reduced-mode empty results.
- `scripts/release.mjs` and `.github/workflows/release.yml`
  - Removed tree-sitter patch/rebuild steps from release preparation.

## Verification

- Native/reduced-mode targeted coverage updated for chunking, specifiers, symbol extraction, AST grep, package metadata, release workflow expectations, and logging behavior.
- Packaging metadata confirms the compatibility shim has no grammar dependencies.
- Full repository verification remains the acceptance gate:
  - `npm run check`

## Compatibility notes

- `@lzehrung/codegraph-js-fallback` still exists for package continuity, but it is no longer a parser runtime.
- `native: "off"` now means reduced graph-only and regex recovery mode, not a JS grammar mode.
- User-facing docs and tests should treat `--json`/native contracts as authoritative and reduced mode as a capability downgrade, not a correctness fallback.
