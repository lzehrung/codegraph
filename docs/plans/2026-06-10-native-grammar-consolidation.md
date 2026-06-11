# Migrate node-gyp tree-sitter grammars to the Rust native addon

**Status:** Proposed (Phase 0 partially established)
**Date:** 2026-06-10
**Owner:** TBD

## Progress

- [x] **Grammar parity confirmed at the dependency level** — `packages/codegraph-native/Cargo.toml`
      already statically links every grammar present in `codegraph-js-fallback/package.json` (20 langs).
- [x] **Parity oracle exists and is green** — `tests/native-query-ownership-parity.test.ts` asserts
      native vs JS produce identical `chunkFile`/query output; full suite passes (164 files, 1827 tests)
      after rebuilding native bindings on win32.
- [ ] Phase 0 — full parity matrix per language + per-language blocking sub-issues for any divergence.
- [ ] Phase 0 — 3-OS CI matrix running the suite with **only** the native prebuilt (no js-fallback). _(Acceptance gate — currently would fail.)_
- [ ] Phase 1 — native authoritative for all grammar languages behind `CODEGRAPH_DISABLE_JS_GRAMMARS`.
- [ ] Phase 2 — zero-native degradation (regex + graph-only) replaces the grammar fallback.
- [ ] Phase 3 — remove the 20 node-gyp `tree-sitter-*` deps; retire/strip the js-fallback workspace.
- [ ] Phase 4 — docs (`language-parity.md`, `installation.md`, `how-it-works.md`).

> Note: the win32 `npm rebuild` that unblocked the local suite is a **symptom** fix (rebuilt
> wrong-platform `.node` binaries), not a plan phase. The plan removes the node-gyp stack so that
> rebuild is never required again.

## Problem

Parsing is served by two parallel grammar stacks:

1. **`@lzehrung/codegraph-native`** — a Rust/`napi-rs` addon that statically links every
   tree-sitter grammar and is distributed as per-platform prebuilt packages
   (`napi.targets` → `optionalDependencies` selected by `os`/`cpu`). No build, no install
   script on the consumer.
2. **`@lzehrung/codegraph-js-fallback`** — an optional workspace that re-implements the same
   grammar set as **node-gyp** packages (`tree-sitter-c`, `tree-sitter-kotlin`,
   `tree-sitter-java`, …). It compiles `.node` binaries locally and is loaded lazily as a
   fallback when the native addon is unavailable.

Stack (2) is the source of the platform-portability failures: node-gyp `.node` binaries are
compiled for one OS/arch and silently mismatch when a `node_modules` tree is reused across
platforms (e.g. Linux-provisioned tree opened on Windows → `tree_sitter_kotlin_binding.node
is not a valid Win32 application`). It also doubles grammar maintenance and version drift
(the two stacks already disagree: `tree-sitter-kotlin@0.3.8` JS vs `tree-sitter-kotlin-ng@1.1.0`
Rust; `tree-sitter-vue` JS vs `arborium-vue` Rust).

The Rust crate **already has full grammar parity** (see `packages/codegraph-native/Cargo.toml`):
c, c-sharp, cpp, css, go, html, java, javascript, kotlin (kotlin-ng), php, python, ruby, rust,
sql (sequel), scss (arborium), svelte (svelte-next), swift, typescript, vue (arborium), zig.

## Goal

Make the Rust native addon the **single** grammar source. Remove all node-gyp `tree-sitter-*`
dependencies. Replace the JS fallback's grammar-backed path with a **pure-JS, zero-native**
degradation (regex/heuristic extraction + graph-only), so a host without a matching native
prebuilt loses _capability_, never _correctness_, and never needs a compiler.

### Non-goals

- Changing query semantics or graph output for languages already served by native.
- Dropping graph-only languages (markdown, rst, adoc, …) — those never used tree-sitter grammars.
- Reworking the napi distribution mechanism — it already follows the `os`/`cpu` optionalDependencies
  pattern and stays as-is.

## Current boundary (what must be replaced)

The JS-fallback module (`src/jsFallback.ts`) exposes the surface the rest of the code consumes:

- `loadTreeSitterLanguage(packageName)` / `loadTypeScriptGrammars()` — grammar handles.
- `parseWithJsLanguage(source, language) → JsSyntaxTree` — full syntax tree.
- `executeJsQueryAsNativeMatches(source, language, queryText, tree?) → JsNativeMatch[]` — query exec.

Consumers route through `src/indexer/parse-context.ts`:

- `getNativeSyntaxTreeExecution(...)` (native) vs `parseWithJsLanguage(...)` (fallback) in
  `attemptParsePreparedFileContext`.
- `getNativeQueryExecution(...)` vs the JS query path.

So every grammar-backed JS call already has a native counterpart. The fallback is the only thing
pulling node-gyp grammars into the dependency tree.

## Migration phases

### Phase 0 — Parity audit & guardrail (no code change)

1. Generate a parity matrix: for each grammar in `codegraph-js-fallback/package.json`, confirm the
   Rust crate parses the same constructs and the query packs (`.scm`) produce identical captures.
   Reuse the existing `tests/native-query-ownership-parity.test.ts` as the oracle — it already
   asserts native vs JS produce identical `chunkFile`/query output.
2. For any language where native output diverges from JS today, file a blocking sub-issue. These
   must reach parity **before** the JS grammar is removed for that language.
3. Add a CI matrix that runs the full suite on win32-x64, linux-x64, darwin-arm64 with **only** the
   native prebuilt installed (no js-fallback workspace built). Today this would fail; it is the
   acceptance gate for the migration.

### Phase 1 — Make native authoritative for every grammar language

1. Audit call sites where the JS fallback is still reachable for a _grammar_ language (not graph-only).
   Target: native is the sole path for all 20 grammars; the JS grammar path is dead code.
2. Where the native binding is _present_, never fall through to a JS grammar. Keep the existing
   `nativeFallbackReason` plumbing for observability, but a missing native binding for a supported
   language should resolve to the **pure-JS degradation** (Phase 2), not a node-gyp parse.
3. Land behind a flag (`CODEGRAPH_DISABLE_JS_GRAMMARS=1`) so the change can bake in CI before default.

### Phase 2 — Replace the grammar fallback with a zero-native degradation

The JS fallback stops loading tree-sitter grammars. When the native addon is unavailable for the
host, supported languages degrade to the existing **regex/heuristic extractors** already used for
import/export recovery (`src/fallback-import-extraction`, `export-fallback-regression` paths) plus
**graph-only** navigation. Concretely:

1. Delete `loadTreeSitterLanguage`, `loadTypeScriptGrammars`, `parseWithJsLanguage`,
   `executeJsQueryAsNativeMatches` grammar bodies; keep the no-native code paths (regex extractors).
2. `attemptParsePreparedFileContext`: when native tree is null **and** language is grammar-backed,
   return the regex-extracted result with `nativeFallbackReason: "nativeBindingUnavailable"` instead
   of throwing `Failed to reconstruct syntax tree`. (Today it throws — see `parse-context.ts:92`.)
3. Emit one actionable warning per process: "native parser unavailable for <platform>; running in
   reduced (graph-only) mode — reinstall to fetch the matching @lzehrung/codegraph-native-<target>".

### Phase 3 — Remove node-gyp dependencies

1. Delete every `tree-sitter-*` and `tree-sitter` dependency from
   `packages/codegraph-js-fallback/package.json` (20 packages + runtime).
2. Either retire the `codegraph-js-fallback` workspace entirely (preferred — it no longer ships
   native code) or reduce it to a pure-JS utility package with **zero** `binding.gyp`/`.node` deps.
3. Drop the `@derekstride/tree-sitter-sql`, `@tree-sitter-grammars/*` scoped grammars too.
4. Remove `npm rebuild` / node-gyp from any dev `setup` docs — no longer needed.

### Phase 4 — Cleanup & docs

1. Update `docs/language-parity.md` and `docs/installation.md`: one native stack, per-platform
   prebuilt, no compiler required; reduced mode is graph-only.
2. Update `docs/how-it-works.md` parsing section to drop the JS-grammar fallback tier.
3. Remove now-dead tests that assert JS-grammar behavior; keep parity tests pointed at native + the
   regex degradation.

## Verification / acceptance

- Phase 1: full suite green with `CODEGRAPH_DISABLE_JS_GRAMMARS=1` on all three OSes.
- Phase 3: `npm ls | grep -E "tree-sitter-(c|java|kotlin|...)"` returns nothing; no `binding.gyp`
  anywhere under `node_modules` of a default install.
- A `node_modules` tree provisioned on Linux and run on Windows (the original failure) parses every
  language via the native prebuilt, or degrades to graph-only — never throws
  "is not a valid Win32 application".
- No install scripts: `npm ci --ignore-scripts` yields a fully working parser.

## Risks & mitigations

- **Native parity gap for an edge construct.** Mitigation: Phase 0 oracle + per-language blocking
  sub-issues; do not remove a JS grammar until its language is at parity.
- **Loss of fallback fidelity on unsupported hosts.** Reduced mode is graph-only/regex, weaker than a
  full JS parse. Mitigation: `napi.targets` already covers win/mac/linux × x64/arm64 (gnu+musl), so
  reduced mode is a rare last resort, not a common path.
- **Grammar version churn during consolidation.** Pin Rust grammar crate versions; record the
  native↔JS version reconciliation (e.g. kotlin-ng vs kotlin) in the parity matrix.

## Rollback

Each phase is independently revertible. Phase 1/2 ship behind `CODEGRAPH_DISABLE_JS_GRAMMARS`;
flipping the flag restores the JS grammar path until Phase 3 deletes it. Keep Phase 3 (dependency
removal) as the final, separate commit so a revert restores grammars without touching parser logic.
