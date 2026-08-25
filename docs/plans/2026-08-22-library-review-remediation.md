# Library review remediation (2026-08-22)

Status: Planned. Five sequenced pull requests from a full-library review of docs, source, tests, accuracy, structure, performance, and use-case coverage at v2.1.2.

## Why this plan exists

A full-library review found no ordinary decay. `src/` has zero `TODO`/`FIXME`/`HACK` comments, zero `eslint-disable` directives, zero `@ts-expect-error`, and zero uses of `any`; coverage is 90.95% lines on the JavaScript side and 96.49% on the Rust side; the docs are unusually honest about limits.

What it did find is narrower and more specific:

- a dead parser seam left behind when the JavaScript Tree-sitter backend was removed, threaded through 15 modules and 5 public API signatures
- the quality gates that would have caught that seam are switched off, so it survived
- a fully measured startup performance plan that remains entirely unimplemented
- documentation contracts that nothing enforces, and that have already drifted
- one 2,346-line module that has outgrown its file

Intended outcome: every remaining line is live code, the gates that would have caught the dead code are on, warm command latency matches what `README.md` already claims, the docs are checked rather than trusted, and the one backlog feature that most improves the repeated-agent-query use case ships.

## Findings

### F1: a dead parser seam threads through 15 modules and 5 public API signatures

`src/parserBackend.ts` is a stub. Every behavior-bearing function in it is inert:

| Symbol                                       | Behavior                                      | `src/` callers | Test callers |
| -------------------------------------------- | --------------------------------------------- | -------------: | -----------: |
| `isNonNativeParserAvailable` (`:64`)         | `return false`, always                        |              0 |           21 |
| `parseWithLanguage` (`:86`)                  | always throws                                 |              0 |           16 |
| `executeQueryAsNativeMatches` (`:94`)        | always throws                                 |              0 |            7 |
| `loadTreeSitterLanguage` (`:72`)             | returns a `{ name: packageName }` placeholder |             41 |            0 |
| `loadTypeScriptGrammars` (`:76`)             | returns two placeholders                      |              4 |            0 |
| `__resetParserBackendModuleForTests` (`:60`) | empty body                                    |              0 |            0 |

[2026-07-25 native runtime startup](2026-07-25-native-runtime-startup.md) already recorded "`src/parserBackend.ts` is a pure stub" as a startup non-issue. It is, however, load-bearing scaffolding for a chain of dead code:

- **A placeholder value is threaded through the whole extraction pipeline.** `LanguageDefinition.grammar` (`src/languages/types.ts:26`) is adapted into `LanguageSupport.language()` (`src/languages.ts:42`), called at `src/languages/filePrep.ts:58`, and the resulting `ParserLanguage` is carried as `lang` through `parse-context.ts`, `build-index.ts`, `locals-and-exports.ts`, `navigation-local.ts`, `navigation-references.ts`, `imports.ts`, `graph-edge-collector.ts`, and `scope.ts`. No terminal consumer reads it. `buildScopeIndexFromSource` (`src/indexer/scope.ts:14-21`) accepts `lang` and never uses it; `collectModuleSpecifiersFromSource` (`src/graphs/specifiers.ts:244-246`) has already renamed its parameter to `_lang: unknown`.
- **It reaches the public API.** `parseFile`, `ensureParsedContext`, `collectLocalsAndExportsFromSource`, `buildScopeIndexFromSource`, and `collectImportsForFile` all expose `lang` in exported signatures (`src/indexer.ts:168`, `:187`, `:213`), as do `ParsedFileContext.lang` and `ParsedFileCacheEntry.lang`. `lang` is in-memory only and never persisted, so removing it touches no on-disk cache payload.
- **It is baked into cache identity.** `src/indexer/build-cache/options.ts:96` hashes `functionSource(definition.grammar)` into the build-cache implementation fingerprint, so a dead closure participates in deciding whether a cache entry is valid.
- **Two error branches are unreachable.** `isNonNativeParserUnavailableError(error)` can only be true for errors thrown by the stub, which nothing calls. The guards at `src/indexer/build-index.ts:943` and `:1727` are dead.
- **`isParserSyntaxTree(tree)` is doubly dead.** At `src/indexer/build-index.ts:333` the guard requires `"walk" in tree`, but the only tree implementation in the runtime is `ProjectedSyntaxTree` (`src/native/projectedTree.ts:14`), which has no `walk()`. The guard is always false, and `collectImportsForFile` declares `tree?: SyntaxTreeLike` (`src/indexer/imports.ts:41`) without reading it anywhere in the body. There is no behavior or performance win hiding here; it is purely dead code.

The syntax-node types in `parserBackend.ts` (`SyntaxPoint`, `ParserSyntaxNode`, `ParserSyntaxTree`, `QueryPoint`, `QueryCapture`, `QueryMatch`) are live: `src/languages/types.ts:1` re-exports them and `ProjectedSyntaxTree` implements them. Only the functions and the `ParserLanguage` threading are dead.

### F2: five test blocks are permanently skipped and read as coverage

Because `isNonNativeParserAvailable()` is hardcoded `false`, every suite gated on it never runs:

| File                                      | Gate                      | Dead `it()` blocks |
| ----------------------------------------- | ------------------------- | -----------------: |
| `tests/cache-path-confinement.test.ts:99` | `nonNativeParserDescribe` |                 17 |
| `tests/native-tree-sitter.test.ts:118`    | `nonNativeParserDescribe` |                  7 |
| `tests/native-query-scope.test.ts:507`    | `nonNativeParserDescribe` |                  3 |
| `tests/native-parse-tree.test.ts:75`      | `nonNativeParserIt`       |                  1 |
| `tests/native-runtime-mode.test.ts:42`    | `nonNativeParserIt`       |                  1 |

`tests/languages/svelte.test.ts.skip` is a further 21-line orphan, unreferenced by any config or script and superseded by the live 217-line `svelte.test.ts` beside it.

### F3: the gates that would have caught F1 and F2 are switched off

- **`@typescript-eslint/no-unused-vars` is `"off"`** (`eslint.config.js:46`), precisely the rule that flags an unread `lang` parameter. It is the only disabled rule in that config carrying a correctness signal rather than a style preference; the disabled `no-unsafe-*` rules are defensible given `no-explicit-any` is `"error"` and `src/` has zero `any`.
- **Tests are never type-checked.** `tsconfig.json` excludes `tests`; `tsconfig.eslint.json` includes them but only to power type-aware lint rules, which do not report TypeScript compile errors; and Vitest transpiles through esbuild with `typecheck` unset in `vitest.config.ts`. A type error in a test file passes `npm run check`.
- **Native-gated suites can silently no-op.** `scripts/run-native-required-tests.mjs` enforces 10 suites, but `tests/type-hierarchy-language-parity.test.ts`, `tests/native-combined-extraction.test.ts`, `tests/cache-path-confinement.test.ts`, `tests/fallback-import-extraction.test.ts`, and the duplicate-tokenizer parity case at `tests/duplicates.test.ts:67` all fall back to `describe.skip` or `test.skip` without failing. `AGENTS.md` requires parity claims to be backed by explicit tests; these five can pass vacuously.

### F4: the measured startup performance plan is real and entirely unimplemented

All six defects in [2026-07-25 native runtime startup](2026-07-25-native-runtime-startup.md) are still present on `main`:

| ID  | Defect                                                                                                       | Confirmed at                                                           |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| F1  | `getNativeRuntimeFingerprint` calls `loadBinding()`, forcing a full 29 MB addon load on non-parsing commands | `src/native/runtime.ts:136`, reached from 5 build-cache/manifest sites |
| F2  | The Windows native cache hashes 29 MB twice per process                                                      | `src/native/runtimeCache.ts:234` and `:251`                            |
| F3  | Every worker repeats the main thread's binding pipeline                                                      | `src/worker/nativeExtractWorker.ts`                                    |
| F4  | `setupWorkerPool` runs before the unchanged-snapshot early return                                            | `build-index.ts:1594` precedes `:1645`                                 |
| F5  | The native cache grows without bound (about 145 MB measured across 5 versions)                               | `runtimeCache.ts:229-275`                                              |
| F6  | Guaranteed-miss workspace probing on every run and every worker                                              | `src/native/bindingLoader.ts:65-77`                                    |

Four of six program acceptance criteria in [the performance program index](2026-07-25-performance-program-index.md) remain unchecked (`--version` at or under 100 ms, warm `orient` at or under 450 ms, warm `search` at or under 700 ms, cold CLI import at or under 1500 ms). This is the largest remaining latency item and the priority index already ranks it next.

### F5: documentation contracts that nothing enforces

- **The package split is documented inconsistently.** `README.md` and `docs/library-api.md` use `@lzehrung/codegraph-core` in every example; `docs/agent-workflows.md` uses `@lzehrung/codegraph` for the same core APIs (`createCodeReviewSession`, `SessionManager`, `analyzeImpactStreaming`, `buildProjectIndex`, `querySymbols`, `textGrep`, `withPartialResults`, `collectImpactContext`, `listCandidateTestFiles`). Both resolve, but the 2.0.0 split exists specifically to steer library consumers to core, and the largest workflow doc points the other way.
- **No test type-checks the documented examples.** `docs/library-api.md` carries about 26 TypeScript code fences across 990 lines; `docs/agent-workflows.md` carries more. `tests/public-docs-benchmarks.test.ts` validates the benchmark harness, not the examples. Nothing detects drift when an export is renamed.
- **CLI exit codes are an undocumented public contract.** `context.exit(1)` appears 19 times and `context.exit(2)` 34 times across `src/cli/`, and `CHANGELOG.md` treats "validation errors consistently use exit code `2`" as a shipped fix, but the string "exit code" appears nowhere in `docs/cli.md`. CI consumers cannot distinguish 1 (findings) from 2 (invalid input) from the docs.
- **CLI and skill parity is unenforced and has already drifted.** `tests/mcp-skill-parity.test.ts` enforces MCP-tool coverage in `codegraph-skill/codegraph/SKILL.md`, and `tests/cli-entrance.test.ts:62` enforces catalog-to-dispatch parity, but nothing checks the CLI catalog against `SKILL.md` or `docs/cli.md`. `apisurface`, `chunk`, and `dumpmod` are already absent from `SKILL.md` despite the `AGENTS.md` rule requiring it to reflect the current tool surface.
- **Two docs give different numbers for the same command.** `README.md:21` claims warm `orient --root . --budget small --json` at about 0.6 s; the performance program's baseline table records 1256 ms with the 450 ms acceptance box unchecked. Neither references the other, so a reader cannot tell which measurement is current.
- **The checked benchmark measures the least representative configuration.** Every row in `docs/benchmarks/README.md` is cold-process, `--cache off`, tiny synthetic fixture, which is the worst case. The resulting table (codegraph 400-456 ms against a baseline of 2.4-3.8 ms, with identical file reads) needs five paragraphs of caveats to stop it misleading, and there is no warm-cache or warm-MCP row, so the checked corpus cannot support the README's own headline claim.
- **`docs/plans/` violates its own hygiene rule.** The index states that completed and superseded plan files should be removed, yet `2026-08-08-library-surface-separation.md` is marked implemented in 2.0.0 and retained, and `2026-08-17-unicode-identifier-support.md` sits under Planned while its checklist shows every phase complete except one item explicitly blocked on an unrelated C# namespace-resolution gap.
- **The coverage report mis-ranks worker entry points.** `docs/coverage/js.md` lists `src/sqlite/rawQueryWorker.ts` at 0.00% as the least-covered file. Its body runs inside a worker thread, which V8 coverage does not attribute; the file is a 20-line delegator to `withReadOnlySqliteDatabase` and `collectBoundedRawSqlRows`, both well covered, and `tests/raw-query-worker-lifecycle.test.ts` exercises it. The report already has a type-only escape hatch; it needs a worker-entry equivalent.

### F6: `src/mcp/server.ts` has outgrown its file

At 2,346 lines it is the largest module in the repository and mixes five concerns:

| Concern                               | Span                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| Handler definitions                   | `createCodegraphMcpHandlersForSession` at `:479`, a single function of about 660 lines |
| Protocol server and tool dispatch     | `:1180-1345`, `callMcpTool` at `:1972`                                                 |
| stdio framing and lifecycle           | `createParseErrorReportingStdin` `:1345`, `serveCodegraphMcp` `:1396`                  |
| Streamable HTTP transport             | `startCodegraphMcpHttpServer` `:1448`, `handleMcpHttpRequest` `:1543`                  |
| Legacy SSE session store and eviction | `:1614-1899`                                                                           |

`src/mcp/` already has the right shape for this (`http.ts`, `security.ts`, `sqliteGuard.ts`, `stdioLifecycle.ts`, `tools.ts`); `server.ts` simply never got split. The next tier (`build-index.ts` 2,025 lines; `build-cache/project-snapshot.ts` 1,648; `duplicates/scoring.ts` 1,437) is large but internally cohesive, so it does not carry the same cost, and `build-index.ts` is edited by the performance work, so it stays out of scope.

### F7: development-loop friction

- `npm run check` runs `test:native` and then `test:coverage`, and `test:coverage` runs the entire suite including the native suites, so the native-required tests execute twice per pre-commit run.
- `scripts/coverage.mjs:170` passes `--maxWorkers 4`, overriding the `maxWorkers: 2` in `vitest.config.ts` whose comment explains that the bound exists to avoid exhausting the CI process limit.
- `test:ci` is the only script wired to `scripts/report-slow-tests.mjs`, and no CI workflow invokes it (CI uses `test:coverage`). Correction made while implementing PR 1: `test:ci` is not dead - `scripts/release.mjs:471` and the `preversion` hook both run it, so slow-test reporting does run, just on release rather than per-PR. Deleting it would break the release flow; the open question is only whether per-PR CI should report slow tests too.

### F8: small correctness nit in portable handles

`parseAgentSqlHandle` (`src/agent/handles.ts:106-112`) has a `parts.length > 4` branch that returns `name` and `file` undecoded, unlike the 4-part branch at `:98-104` which calls `decodeHandlePart`. `formatAgentSqlHandle` always encodes both fields and `encodeURIComponent` escapes `:`, so the longer branch is unreachable from any handle codegraph produces. It is untested lenient-parse code that returns a differently shaped result than the supported path. `src/agent/handles.ts` sits at 45% branch coverage, the lowest of any runtime file in the report.

### F9: syntax-tree projection dominated per-file indexing throughput

Status: fixed.

That startup program covers fixed per-process cost. This was a separate per-file throughput cost: the projected syntax tree crossed the napi boundary as one JS object per AST node, then crossed the worker boundary again as a structured clone of those objects.

Measured on this repository (386 TypeScript files under `src/`, 3.13 MB, 882,142 projected AST nodes; best of 5 runs, Linux, Node 22.22, 4 CPUs, both encodings measured in one session under the same load):

| Step                                               |   Before |          After |
| -------------------------------------------------- | -------: | -------------: |
| `runLanguageQueries` (one parse plus four queries) |  4.30 ms | 4.25 - 4.42 ms |
| Tree projection added by `extractLanguage`         | 11.06 ms | 1.15 - 1.60 ms |
| `structuredClone` of those trees (worker-to-main)  | 12.16 ms | 0.13 - 0.14 ms |
| Worker path total, per file                        | 27.52 ms | 5.58 - 6.00 ms |

The query cost is identical either side, which is the control: the change touches only projection and transfer. Projection is about 7x cheaper, the transfer about 87x cheaper, and the extraction step as a whole about 4.7x cheaper.

Mechanics of the original cost:

- `extract_language` unconditionally projected the tree, and the worker always returned it.
- Every node carried `node_type: node.kind().to_string()`, allocating a Rust `String` per node even though `kind()` returns `&'static str` from a small interned set. Across napi that became a fresh JS string per node, about 882k strings on this repository, plus a `child_field_names: Vec<String>` per node with one mostly-empty entry per child.
- The tree is consumed **sparsely but was transported wholly**. Its only index-build uses are `descendantForIndex` lookups for local classification and docstrings (`src/indexer/locals-and-exports.ts:496-503`), `supplementMethodLocalsFromSyntaxTree` (`:531-534`), and scope construction when query-driven locals do not apply (`:520-528`).
- Workers auto-enable at 250 files (`NATIVE_WORKER_AUTO_FILE_THRESHOLD`, `src/indexer/build-workers.ts:21`), so every real repository takes this path by default.

Ruled out by measurement, recorded so they are not re-investigated:

- JS-side `new ProjectedSyntaxTree(...)` was already cheap: 60 ms for all files. `ProjectedSyntaxNode` is a thin lazy wrapper.
- `namedChildren` allocating a fresh array per access costs 147 ms for a full walk of every node. Real, but an order of magnitude below projection and clone.
- Moving the tree work into the worker does **not** work. `collectLocalsAndExportsFromSource` consumes resolved `imports` (`locals-and-exports.ts:522`, `:708`, `:967`), and those come from `collectImportsForFile`, which does filesystem, tsconfig, and workspace-manifest resolution on the main thread. Relocating locals extraction would mean relocating module resolution.
- `extract_language` was never a regression. It was introduced in `bce06bc` (#246, v2.0.6) and made this path faster: the worker previously called `runLanguageQueries` and then `parseSyntaxTree`, parsing each source twice. That change collapsed two parses into one.
- `Piscina.move()` zero-copy transfer is not worth adding. With the columnar encoding the clone is already 0.13 ms/file; transferring buffers would save a fraction of that in exchange for detached-buffer failure modes.

Fixed by the columnar `NativeSyntaxTree` encoding: `packages/codegraph-native/src/projection.rs`, `src/native/projectedTree.ts`. See CHANGELOG-equivalent history: commit `perf(native): encode projected syntax trees as columns`.

### F10: an invalid CLI comparison hid a real double-parse bug

Status: corrected and fixed. This finding originally read "worker threads still do not beat single-threaded indexing." That conclusion was wrong, and the investigation that reached it was flawed in a specific, instructive way: it never actually measured a single-threaded run.

**The flawed premise.** `codegraph index` has no `--no-workers` flag: `src/cli/invocationContext.ts:149-150` shows `--workers` sets `useNativeWorkers: true`, and omitting it leaves `workerOpts = {}`, i.e. `useNativeWorkers` stays `undefined`. `shouldEnableNativeWorkers` (`src/indexer/build-workers.ts:34-40`) then auto-enables the pool once `fileCount >= NATIVE_WORKER_AUTO_FILE_THRESHOLD` (250). This repository indexes 811 files. So the original "workers on" vs "workers off" CLI comparison was "explicitly true" vs "auto-true" - the same configuration measured twice, not a real single-thread baseline. The "no speedup" finding was an artifact of comparing two identical configurations.

**The real comparison**, forced through the library API (`buildProjectIndex(root, { cache: "disk", cacheDir, useNativeWorkers: false | true })`, fresh cache directory per run, cold every time), best-of-3, Linux, 4 CPUs, 811 files:

| Configuration                    |      Cold runs (ms) |
| -------------------------------- | ------------------: |
| `useNativeWorkers: true`         | 21037, 21440, 21339 |
| `useNativeWorkers: false` (real) | 27734, 26335, 26680 |

Workers on is consistently about 21% faster than a genuine single-threaded run. Workers help; they always did.

**What the flawed comparison's own profile pointed at instead.** A CPU profile of the genuine single-threaded run (`node --cpu-prof`) showed two adjacent hot functions: `getNativeQueryExecutionForState` (10,383 ms self time across the run) and `getNativeSyntaxTreeExecution` (2,711 ms). Reading the code that calls them (`src/indexer/parse-context.ts`) found the actual bug: `prepareFileForIndexing` called `getNativeQueryExecution` for queries, and - when no worker had already supplied a tree - `attemptParsePreparedFileContext` separately called `getNativeSyntaxTreeExecution` for the tree. Each is backed by its own Tree-sitter parse. **Every file on this path was parsed twice.**

The worker path never had this problem: `src/worker/nativeExtractWorker.ts` already calls the combined `extractLanguage` (one parse, both results), and `PreparedFileContext.syntaxTree` already carries the comment "avoids a second parse on the main thread" for the tree a worker supplies. The non-worker path simply never got the same treatment. This affects every file in a project under the 250-file worker threshold, and every SFC file (`.vue`/`.svelte`/`.astro`) even when workers are enabled, since `prepareFileContextForBuild` (`src/indexer/build-workers.ts:188,228`) explicitly routes those around the pool.

**Fix**: added `getNativeExtractionExecution` (`src/native/execution.ts`), the same combined-call wrapper around `extractLanguage` the worker uses, and pointed `prepareFileForIndexing` at it. Populating `PreparedFileContext.syntaxTree` here means the existing `if (context.syntaxTree)` fast path in `attemptParsePreparedFileContext` - already built for the worker's case - now also skips the second call on the main thread. No consumer code changed.

Verified mechanistically, not just by wall-clock delta: profiled before and after. Before: two adjacent buckets (`getNativeQueryExecutionForState` 10,383 ms + `getNativeSyntaxTreeExecution` 2,711 ms). After: one bucket (`getNativeExtractionExecution`, 11,857 ms), the second gone. True single-threaded cold build: ~26.9s -> ~24.8s (~8%). Workers-on numbers unchanged, as expected - they never took the double-parse path.

The lesson for future perf comparisons in this repo: **verify a comparison's two arms are actually different before trusting its conclusion.** A profile of the "slow" arm is what surfaced the real bug here; the wall-clock comparison alone would have kept pointing at the wrong cause indefinitely.

### F11: further marshalling and cache-write costs, not yet fixed

Two follow-ups surfaced while investigating F10, both real, both sized, neither fixed this pass.

**`NativeCapture` has the same per-item shape problem the syntax tree used to have**, and is now the largest remaining marshalled payload: cloning one repository's worth of query-capture results across the worker boundary costs 0.52 ms/file against 0.12 ms/file for the now-columnar trees, despite 50,846 captures against 882,142 tree nodes - 17x fewer items, over 4x the cost, purely from one-JS-object-per-capture (name, text, node type, two point objects).

Unlike the tree, this is **not** a same-sized fix. The tree had exactly one reader (`ProjectedSyntaxNode`), so PR 2b's columnar rewrite touched no consumer code. `NativeCapture`/`NativeMatch` are read directly, as plain objects, from six files: `src/indexer/locals-and-exports.ts`, `src/indexer/imports/nativeCaptures.ts`, `src/indexer/imports.ts`, `src/graphs/specifiers.ts`, `src/native/queryResults.ts`, `src/chunking/chunkMatches.ts` - the core symbol-extraction surface. A safe columnar rewrite needs a JS-side reconstruction step (columns -> plain `NativeMatch[]`/`NativeCapture[]` objects, once per file, immediately after the boundary crossing) so those six consumers stay unchanged, mirroring PR 2b's "no consumer code changes" result rather than rewriting six correctness-critical call sites directly. That reconstruction step should itself be cheap: PR 2b's equivalent JS-side tree reconstruction measured 60 ms total across 385 files. `query.rs`'s capture-collection logic (`capture_to_object`, `execute_query_cached`) is comparable in scope to `projection.rs`, so this is realistically its own PR, not a follow-up hour.

**`transformModulePaths`** (`src/indexer/build-cache/module-cache.ts:380-389`) deep-clones an entire `ModuleIndex` - every local, every export, for the whole file - via `structuredClone(module)`, purely to rewrite the `file` path field on a handful of top-level locations (`copy.file`, each local's `file`, each export target's `file`) between absolute and cache-relative form. `structuredClone` appeared as a top-15 cost even in the genuinely single-threaded profile (three call sites, ~885 ms combined on this repository), where there is no worker boundary to cross, confirming this specific site is a real, separate cost rather than worker-transport noise. Not fixed here: the surrounding code is path-confinement-sensitive (`assertFilePathWithinRoot`), and a correct fix (shallow-copy only the nested arrays that actually get a `file` field rewritten, rather than deep-cloning the whole graph) needs its own careful review against that safety property before shipping, not a rushed edit alongside two unrelated fixes.

## Target use cases and feature selection

The library serves four use cases well today: agent repo orientation (`orient`, `explore`, `search`, `packet`), change review (`review`, `impact`, `affected`, `drift`, `duplicates`), semantic navigation (`goto`, `refs`, `callers`/`callees`, hierarchies, `rename-preview`, `refactor-plan`), and structured handoff (`graph`, `artifact`, SQLite, MCP).

`docs/plans/` already owns the feature backlog and it is well reasoned. Ranked against the stated positioning of repeated agent queries over one repo snapshot:

1. [Shared server lifecycle](2026-07-03-03-shared-server-lifecycle.md) is highest and is scheduled below as PR 5. MCP is the documented path for repeated queries, but starting and managing it is manual, so most users pay cold CLI start per query. It pairs directly with PR 2: PR 2 lowers the per-process cost, PR 5 stops paying it at all.
2. [Semantic graph synthesizers](2026-07-03-semantic-graph-synthesizers.md) is the biggest capability expansion, because "how does this feature work" currently stops at imports and calls while framework routes are where the answer usually lives. Deferred: it needs the shared provenance contract designed before the first slice.
3. [Privacy-preserving diagnostics](2026-07-03-14-privacy-preserving-diagnostics.md) is modest and mostly reduces support cost. Deferred.
4. [Source language expansion](2026-05-12-source-language-expansion.md) stays deprioritized, correctly: breadth without semantic depth weakens the parity story. Deferred.

No feature is proposed beyond this backlog. The gaps that matter are execution, not ideas.

## PR 1: retire the dead parser seam and re-arm the quality gates (implemented)

Status: implemented, including the `typecheck` gate - see "What actually shipped" below for how that
gate differed from what this plan assumed. Fixes F1, F2, F3, F8, and part of F7. Largest diff, simplest review: almost all of it is deletion. The seam and the gates belong in one change because they share a root cause. Turning the gates on without deleting the code first would only produce a red tree.

Removing `lang` from exported signatures is a breaking change to the library surface. It ships in a 2.x minor by explicit decision rather than waiting for a major, matching how 2.0.0 handled export narrowing with no compatibility aliases.

- **Delete the stub's dead surface.** Remove `isNonNativeParserAvailable`, `isNonNativeParserUnavailableError`, `parseWithLanguage`, `executeQueryAsNativeMatches`, `loadTreeSitterLanguage`, `loadTypeScriptGrammars`, `__resetParserBackendModuleForTests`, and `ParserLanguage` from `src/parserBackend.ts`. Keep the syntax-node interfaces, which are live. Rename the file to `src/syntaxTypes.ts` so it stops advertising a backend that no longer exists, or keep the name and correct its header comment, but do not leave `parserBackend` naming on a pure type module without a note. Delete `src/languages/definitions/loadLanguage.ts`, a one-line re-export of two deleted functions.
- **Remove the `lang` threading.** Drop `grammar` from `LanguageDefinition` (`src/languages/types.ts:26`) and the 21 definition files under `src/languages/definitions/`; drop `language` from `LanguageSupport` and `adaptDefinition` (`src/languages.ts:12`, `:42`); drop `languageForFile` (`src/languages.ts:150`); drop `lang` from `PreparedFileContext`, `ParsedFileContext`, and `ParsedFileCacheEntry` (`src/indexer/parse-context.ts:17-45`), from `src/languages/filePrep.ts:20`, and from every call site listed in F1. Delete the `_lang` parameter from `collectModuleSpecifiersFromSource` (`src/graphs/specifiers.ts:246`) and the `tree` option from `collectImportsForFile` (`src/indexer/imports.ts:41`); neither is read.
- **Remove the unreachable branches.** `src/indexer/build-index.ts:943` and `:1727` lose the `isNonNativeParserUnavailableError(error)` disjunct while keeping `isUnsupportedParserInputError`; `:333` loses the `isParserSyntaxTree(tree)` guard entirely.
- **Update the cache fingerprint.** Remove `behavior.grammar` from `src/indexer/build-cache/options.ts:96`. This invalidates existing build caches once, which is the designed rebuild path rather than a schema migration, but per `AGENTS.md` add a regression test that starts from a snapshot written with the old fingerprint and proves a clean rebuild rather than a corrupt read.
- **Delete the dead tests.** Remove the five `nonNativeParser*` blocks in F2 with their gate constants and imports, and delete `tests/languages/svelte.test.ts.skip`. Delete `tests/parser-backend-unavailable.test.ts` and the `isNonNativeParserAvailable` assertions in `tests/esm-language-loading.test.ts`, which assert that a deleted stub is a stub. Update the `support.language(...)` call sites in `tests/export-fallback-regression.test.ts`, `tests/native-query-results.test.ts`, `tests/native-query-scope.test.ts`, and `tests/detailed-symbol-native-only.test.ts`.
- **Re-arm the gates.** Set `@typescript-eslint/no-unused-vars` to `"error"` with `argsIgnorePattern` and `varsIgnorePattern` of `^_`, and fix the fallout in this change. Add a `typecheck` script (`tsc -p tsconfig.eslint.json --noEmit`) to `npm run check` and the CI lint step so test files are compiled. Add `tests/type-hierarchy-language-parity.test.ts`, `tests/native-combined-extraction.test.ts`, `tests/cache-path-confinement.test.ts`, and `tests/fallback-import-extraction.test.ts` to `nativeRequiredSuites` in `scripts/run-native-required-tests.mjs`, and make the duplicate-tokenizer parity case at `tests/duplicates.test.ts:67` fail rather than skip when native is required.
- **Clean the dev loop.** Drop the redundant `test:native` from `npm run check`, since the coverage run already covers those suites once native is required. Reconcile `scripts/coverage.mjs:170` with the `maxWorkers: 2` in `vitest.config.ts`. Either wire `report-slow-tests.mjs` into the CI coverage step or delete `test:ci`.
- **Fix F8.** Delete the unreachable `parts.length > 4` branch in `parseAgentSqlHandle`; deleting is preferable to making it decode consistently, because nothing produces that shape. Add handle round-trip cases covering names and paths containing `:`, `%`, and non-ASCII characters, which is what lifts `src/agent/handles.ts` off 45% branch coverage.
- **Docs.** Add a `### Removed` entry under `[Unreleased]` in `CHANGELOG.md` naming the removed exports and stating that this ships as a 2.x minor. Remove any reference to a non-native parser backend from `docs/library-api.md` and `docs/how-it-works.md`.

Verification:

```bash
npm run typecheck
npm run lint
npm run build
npm run test:native
npm run test:coverage
npm run check
node ./dist/cli.js doctor
node ./dist/cli.js orient --root . --budget small --json
```

Also confirm that `git grep -n "ParserLanguage\|isNonNativeParser\|loadTreeSitterLanguage"` returns nothing outside the deleted files, and that the coverage thresholds in `vitest.config.ts` still pass after roughly 30 dead `it()` blocks are removed. Those blocks never executed, so the numbers should not move; if they do, something in F2 was not actually dead and needs re-checking before merge.

### What actually shipped

Everything in the list above landed. One item, the `typecheck` gate, cost far more than this
plan assumed and is worth recording in detail, because the plan mis-scoped it as a one-line
change.

**The `typecheck` gate was not a one-line addition, but it is now on.** The plan says to add
`tsc -p tsconfig.eslint.json --noEmit` to `npm run check` and the CI lint step "so test files
are compiled". Measured on clean `main`: that command reports **949 errors across 253 test
files**. `tsconfig.eslint.json` exists to give ESLint a type-aware program, not to compile, so
it inherited src-tuned strictness and nothing ever ran it.

The fix was a dedicated `tsconfig.tests.json` plus a real cleanup. `src/` keeps the stricter
`tsconfig.json` untouched; the tests config relaxes only options whose value is specific to
shipped code (`noUncheckedIndexedAccess`, which alone accounted for 529 errors; `dom` lib for
the browser-viewer suites; `vitest/globals` because `globals: true` is set; `allowJs` for the
untyped `scripts/*.mjs` helpers). `exactOptionalPropertyTypes` stays on, verified load-bearing:
relaxing it surfaces a real error in `src/cli/invocationContext.ts`. Configuration took 918 to
307; the remaining 307 were fixed individually. `npm run typecheck` now runs both projects and
is wired into `npm run check` and all three CI lanes.

**A method note worth keeping.** The first before/after comparison used to prove "no new type
errors" compared the _set of files_ containing errors. That is not sound: a file already in the
253 can acquire a new error invisibly. It did - `tests/scope-quality.test.ts` kept passing
`undefined` in the removed `lang` slot, which silently shifted `imports` into the options
parameter, and three tests failed at runtime before the coarse diff caught anything. Compare
full error text, not file names.

**Deviations from the plan's dev-loop item, both deliberate:**

- The plan says to drop `test:native` from `npm run check` as redundant with `test:coverage`.
  Only its JavaScript half is redundant. `test:native` also runs `cargo test` and enforces that
  the native addon actually loads (`run-native-required-tests.mjs` exits non-zero if it does
  not), neither of which `test:coverage` does. Dropping it would trade a real guarantee for
  local speed, so it stays.
- The plan offers "delete `test:ci`" as an option. It is live - see the correction under F7.

**One addition beyond the plan.** `run-native-required-tests.mjs` now passes
`CODEGRAPH_NATIVE_REQUIRED=1` to the suites it runs, and the duplicate-tokenizer parity case
reads it. Previously that case self-skipped whenever native was unavailable, including inside
the runner that had just _proven_ native was available - a skip that read as coverage while
asserting nothing. `tests/duplicates.test.ts` joins the native-required list.

**Unrelated flake observed, not fixed.** `tests/native-worker-parity.test.ts` failed once in
three full-suite runs (`workerPool.enabled` false) and passed in isolation every time, on a
tree whose changes do not touch worker enablement. It is load- or order-sensitive and predates
this PR; recorded here rather than folded into it.

## PR 2: native runtime and worker startup costs (implemented)

Status: implemented, priorities 0 through 4, with one sub-item of P4 declined on inspection - see
"What actually shipped" below. Fixes F4 and the stale performance numbers in F5. Implement [2026-07-25 native runtime startup](2026-07-25-native-runtime-startup.md) as written, priorities 0 through 4. That plan is measured, specific, and already reviewed; this is execution, not redesign.

- **P0**: extend the cache manifest (`src/native/runtimeCache.ts:208-230`) with `supportedLanguageIds` and the serialized fingerprint, and make `getNativeRuntimeFingerprint` (`src/native/runtime.ts:119-147`) read it on a size- and mtime-validated cache hit instead of calling `loadBinding()`. Keep `loadBinding()` on the parse paths in `src/native/execution.ts`.
- **P1**: cheap-identity fast path. Record package name, version, target, source size, and source mtime, and skip both SHA-256 passes when they match, preserving path confinement and full hashing on any mismatch.
- **P2**: pass the resolved `loadedPath` and verified sha256 into workers through Piscina `workerData` so `src/worker/nativeExtractWorker.ts` skips `prepareNativeRuntimeCache`.
- **P3**: move `setupWorkerPool` (`build-index.ts:1594`) below the changed-file computation, size threads as `min(resolvedThreads, changedList.length)`, and skip the pool below a measured threshold.
- **P4**: prune sibling native-cache entries from other package versions, ignoring `EBUSY`.

Also in this change, because it is the only point where the numbers are trustworthy: re-measure warm `--version`, `orient --budget small`, and `search --limit 3` against an installed build, update the acceptance boxes in [the performance program index](2026-07-25-performance-program-index.md), and reconcile `README.md:21` with the result so the two documents stop disagreeing. If a target is not met, say so in the plan file rather than leaving the box silently unchecked.

Verification:

```bash
npx vitest run tests/native-fallback-contract.test.ts tests/native-fallback-reporting.test.ts
npx vitest run tests/native-worker-parity.test.ts tests/native-semantic-parity.test.ts
npm run test:native
npm run check
```

Plus the plan's own measurement protocol: a `process.dlopen` hook test asserting zero native loads on a warm cache-hit `orient`, `search`, and `refs`; `dlopen` count and total SHA-256 bytes recorded per process before and after; and measurement against a globally installed build rather than the workspace checkout, since the workspace resolves the addon by a different path.

### What actually shipped

Each priority landed as its own commit; the checkboxes in
[the native runtime startup plan](2026-07-25-native-runtime-startup.md) record the detail. Three
things are worth carrying here because they changed the shape of the work.

**P0 and P1 turned out to be one mechanism.** Deriving the fingerprint without loading the addon
needs the entry located without hashing, which is the same problem P1 solves. One path-keyed
identity record per source realpath, written after a verified load, answers both: it holds the
stat fields that let a later process find the entry, the digest that lets it skip verification,
the addon's supported languages, and the binding origin. It is separate from `manifest.json`
because the manifest is content-addressed and published once, while identity records are mutable
and hold facts that only exist after a load. Entries with no matching record miss the fast path
and take the old route.

**P3's threshold was measured, and the plan's suggestion was wrong.** Cold builds of a fixed file
list on this repository, median of 3, workers on versus off: 4 files -60%, 16 files -26%, 24 files
-0.2%, 32 files +11%, 64 files +25%, 256 files +36%. The crossover is 24. The plan proposed 16,
which is 26% slower than no pool at all. The threshold is now 32. The old value of 250 was chosen
when that count meant "files in the project"; it now means "files this build will parse", so it
was leaving real work single-threaded. Two callers - the agent session and `codegraph inspect` -
were separately forcing the pool on from the project's total file count and would have overridden
this on every small incremental update; both now leave the decision to the build.

**Two P4 items came out differently from the plan.** The first was declined rather than left
unticked: the plan folds F6's filesystem probing into P4, on the reasoning that a valid cached
entry makes the workspace probe and the platform-package metadata reads unnecessary. It does not -
the fast path needs the source path and package version to locate the entry at all, and those
reads are what produce them.

The second is pruning itself. "Delete sibling entries whose version differs from the current one"
is right for one project and wrong on a real machine: the cache root is per-user and shared, so
two projects pinned to different native versions would delete each other's entry on every run,
each re-copying 29 MB and never reaching the fast path - worse than the growth it set out to fix.
Entries are removed once no project has used them for 30 days instead. An entry in use is
re-verified at least daily and that refreshes its timestamp, so age separates abandoned from
active where version does not. Both are recorded against their checkboxes in the native plan.

**A review pass before opening the PR found three defects, all in the P0/P1 fast path**, and they
are worth recording because they share a cause: a stat-only match is a weaker claim than the
hashing it replaces, and each was a place where the claim was allowed to carry more than it had
proven.

- The lookup matched a record on package version, size, and mtime but never on _which install_
  it described. The cache root is shared, and npm can produce byte-identical files with matching
  mtimes, so a second project on the same version could be handed the first project's source
  path - which travels into the binding origin and changes the runtime fingerprint, invalidating
  its index cache on every run.
- Nothing tied a record to the runtime that proved the file loadable. A major Node upgrade
  changes the addon ABI: the bytes are untouched, every stat still matches, and the file no
  longer loads. The fingerprint would have reported native as available for a build that then
  fell back, stamping a degraded index as a native one.
- Pruning, as above.

The first two are fixed by recording the resolved source path and the runtime stamp
(`process.versions.modules`, platform, arch) and requiring both to match, and by dropping any
fast-path memo the moment a real load happens so later queries are answered from the binding
rather than from a claim about it. Each guard has a test that fails when the guard is removed.

### Measured result

P2 and P3 were each measured where they apply; P3's full-build check is in its commit and in the
native plan. P0, P1, and P4 save work that exists only on the Windows runtime cache path - the
addon load inside the fingerprint, two 29 MB SHA-256 passes per process, and entries accumulating
across versions - so they are structurally invisible on Linux and could not be timed here. Their
behavior is asserted instead, against an injected win32 platform and cache root.

The re-measurement this PR also owed - warm `--version`, `orient --budget small`, and
`search --limit 3`, with the acceptance boxes in
[the performance program index](2026-07-25-performance-program-index.md) and `README.md` - is
recorded there. `--version` meets its target at 83 ms. `orient` and `search` do not, and are also
slower than the original figures, but the measurement was taken on a different OS, machine, core
count, and a repository that has grown from 668 to 811 files, so it is a new baseline rather than
a before-and-after. Which part of that gap is real is not established, and the F10 correction
below is the reason for not guessing. `README.md` now states the conditions and the range instead
of a single number.

### Verification performed

```bash
npx vitest run tests/native-runtime-identity.test.ts tests/native-worker-handoff.test.ts \
  tests/native-worker-pool-sizing.test.ts
npx vitest run tests/native-fallback-contract.test.ts tests/native-fallback-reporting.test.ts
npx vitest run tests/native-worker-parity.test.ts tests/native-semantic-parity.test.ts
npm run typecheck && npm run lint && npm run check
```

Each new behavior was mutation-checked rather than assumed: disabling the identity lookup, the
handoff branch, and the pruning call each fails the tests written for it.

## PR 2b: columnar syntax-tree encoding (implemented)

Status: implemented. Fixes F9. This PR's own follow-up read ("workers still do not beat single-threaded indexing") was itself wrong, for a reason worth recording precisely: see F10 for the invalid comparison it rested on and the real bug that comparison's profile actually surfaced, fixed separately.

Separate from PR 2 because that change is about fixed per-process startup cost while this one is about per-file throughput, and because this one changes the native ABI.

### What shipped

`NativeSyntaxTree` was one JS object per AST node, each holding a kind string, two point objects, and three arrays. It is now column-oriented: one typed array per attribute indexed by node id, with node kinds and child field names interned into string tables, and child lists in compressed sparse row layout. A file crosses the boundary as about fifteen typed arrays plus a few hundred strings rather than thousands of objects.

- `packages/codegraph-native/src/projection.rs` - `project_columns` replaces `push_projected_node`, writing columns directly and interning kinds and field names. Node and depth budgets, their error messages, and the fail-closed behavior are unchanged.
- `packages/codegraph-native/src/types.rs`, `lib.rs` - the columnar `NativeSyntaxTree`, plus `parse_syntax_tree_columns` and `extract_language_parts` so the projection pipeline is exercised by pure-Rust unit tests. The napi wrappers are `cfg(not(test))`: typed arrays hold JS references whose `Drop` calls into the runtime, which the `noop` feature used by `cargo test` does not provide.
- `src/native/projectedTree.ts` - reads columns and materializes `ProjectedSyntaxNode` lazily, memoized by id so node identity is still stable. `SyntaxNodeLike` is unchanged, so **no consumer code changed**.
- `src/native/treeShape.ts` - `REQUIRED_NATIVE_EXTRACTION_VERSION` plus a structural probe. An older native binary still exports `extractLanguage`, so capability detection cannot catch it; the probe rejects a present-but-legacy tree with an actionable message while still tolerating a missing tree, which is an existing downstream state.
- Native package bumped to 1.10.0 and the `optionalDependencies` floor with it.

### Measured result

See F9 for the full table. Per file, on this repository with both encodings measured in one session: projection 11.06 to about 1.4 ms, worker-to-main clone 12.16 to about 0.13 ms, extraction step 27.52 to about 5.9 ms, roughly 4.7x. The unchanged query cost either side is the control.

`Piscina.move()` was considered and rejected on the measurement: at 0.13 ms per file the clone no longer justifies detached-buffer failure modes.

### Verification performed

- `cargo test` - 29 pass, including four new projection tests covering child ordering, the named-child subset, field-name resolution, interning, and every budget.
- `npm run test:native` - all native-required and fallback suites pass.
- `npm run test:fast` (3530 tests) and `npm run test:integration` (149) pass, except one failure specific to this dev sandbox: `tests/duplicates.test.ts` disagreed at U+088F between the sandbox's Node (reports `unicode: '17.0'`, `icu: '78.2'` - not a real released Node build) and the pinned `unicode-ident = "=1.0.14"`. Not this PR's bug, and not a real CI bug either - see the correction log entry below. Left unchanged.
- `npm run lint` and `npm run format:check` clean.

### Follow-ups this opened

F10 (corrected and fixed separately: the real bug was a redundant second parse on the non-worker path, not a worker-coordination cost) and F11 (`NativeCapture` interning, `transformModulePaths`'s cache-write clone cost - both real, both sized, neither fixed yet).

## PR 2c: stop double-parsing files on the non-worker path (implemented)

Fixes F10, correcting the "workers don't help" conclusion PR 2b's own follow-up had reached from an invalid comparison.

### What shipped

`codegraph index` has no `--no-workers` flag (`src/cli/invocationContext.ts:149-150`); omitting `--workers` still auto-enables the pool once the project crosses `NATIVE_WORKER_AUTO_FILE_THRESHOLD` (250 files, `src/indexer/build-workers.ts:21`). This repository has 811 indexed files. So a prior CLI-based "on vs off" comparison was actually "on vs also-on" - no genuine single-threaded run was ever measured.

Measuring for real, through the library API (`BuildOptions.useNativeWorkers` forced explicitly, `src/indexer/types.ts:177`), found workers-on already about 21% faster than a genuine single-threaded run. Profiling the genuine single-threaded run then found a real, separate bug: `prepareFileForIndexing` (`src/indexer/parse-context.ts`) called `getNativeQueryExecution` for queries, and - whenever no worker-supplied tree already existed - `attemptParsePreparedFileContext` separately called `getNativeSyntaxTreeExecution` for the tree. Each is backed by its own Tree-sitter parse, so every file on this path was parsed twice. The worker path never had this problem: it already calls the combined `extractLanguage` (one parse, both results), and `PreparedFileContext.syntaxTree` already carries a comment noting it "avoids a second parse on the main thread" for the tree a worker supplies - the non-worker path just never got the same treatment.

This runs for every file in a project under the worker threshold, and for every SFC file (`.vue`/`.svelte`/`.astro`) even when workers are enabled, since `prepareFileContextForBuild` (`src/indexer/build-workers.ts:188,228`) explicitly routes those around the pool.

- `src/native/execution.ts` - added `getNativeExtractionExecution`, the same combined-call wrapper around `extractLanguage` the worker uses.
- `src/native/contracts.ts` - added `NativeExtractionExecution` (`{ results, tree, fallbackReason?, error? }`).
- `src/indexer/parse-context.ts` - `prepareFileForIndexing` calls the combined function and populates `PreparedFileContext.syntaxTree`, so the existing `if (context.syntaxTree)` fast path in `attemptParsePreparedFileContext` - already built for the worker's case - now also skips the second call here. **No other consumer code changed.**

### Measured result

True single- vs multi-thread, forced through the library API, fresh cold cache per run, best-of-3, this repository (811 files):

| Configuration             |                                                Cold runs (ms) |
| ------------------------- | ------------------------------------------------------------: |
| `useNativeWorkers: true`  | 21037, 21440, 21339 (before fix); 21677, 21196, 20360 (after) |
| `useNativeWorkers: false` | 27734, 26335, 26680 (before fix); 25650, 24509, 24274 (after) |

Workers-on is essentially unchanged by this fix, as expected - it never took the double-parse path. Genuine single-threaded cold indexing improved from roughly 26.9s to roughly 24.8s, about 8%. Workers-on remains about 15% faster than workers-off after this fix (down from about 21% before it, since the single-threaded floor itself moved).

Verified mechanistically, not just by wall-clock delta: profiled the single-threaded run before and after. Before: two adjacent buckets, `getNativeQueryExecutionForState` (10,383 ms self time across the run) and `getNativeSyntaxTreeExecution` (2,711 ms). After: one bucket, `getNativeExtractionExecution` (11,857 ms) - the second bucket is gone.

### Verification performed

- `npm run test:native` - all native-required and fallback suites pass.
- `npm run test:fast` (3530 tests, all passing - the F9/PR-2b duplicates.test.ts failure is fixed separately, see above) and `npm run test:integration` (149) pass.
- `npm run lint` and `npm run format:check` clean.
- Two tests mocked `getNativeQueryExecution` directly to simulate a per-file native failure (`tests/detailed-symbol-native-only.test.ts`, `tests/native-fallback-contract.test.ts`); that mock no longer intercepts the call the build actually makes. Both updated to also mock `getNativeExtractionExecution` with the same per-file predicate, confirming the fallback contract (degraded reporting, no crash, no mixing native and JS extraction for the same file) still holds through the new call path.

### Follow-ups this opened

F11: `NativeCapture` is now the largest remaining marshalled payload and has the same per-item-object shape problem the tree used to have, but fixing it safely needs a JS-side reconstruction layer across six correctness-critical consumer files rather than a same-sized rewrite - sized, not yet scheduled. `transformModulePaths`'s whole-`ModuleIndex` `structuredClone` for a handful of path-field rewrites is a separate, smaller, path-confinement-sensitive follow-up.

## PR 3: documentation accuracy contracts

Fixes the rest of F5. Small diff, high durability: the point is to make the docs enforceable so this review does not need repeating.

- **Unify the package guidance.** Rewrite every library example in `docs/agent-workflows.md` to import from `@lzehrung/codegraph-core` or `@lzehrung/codegraph-core/agent`, matching `README.md` and `docs/library-api.md`. Keep `@lzehrung/codegraph` only where the example genuinely needs the product package: MCP handlers, viewer, or installer.
- **Type-check the documented examples.** Add `tests/docs-examples.test.ts` that extracts every `ts`-tagged fence from `README.md`, `docs/library-api.md`, and `docs/agent-workflows.md`, writes them to a temp directory, and compiles them against the built declarations with the project's compiler options. Compile only, do not execute; the goal is drift detection on renamed or removed exports.
- **Document the exit-code contract.** Add an exit-codes section to `docs/cli.md` covering 0 for success, 1 for findings or not-found, and 2 for invalid input or usage, with per-command meaning where it differs. Mirror the summary into `codegraph-skill/codegraph/SKILL.md` and add a test asserting the documented code for one representative of each class: `links` with a broken link returns 1, an unknown flag returns 2.
- **Enforce CLI and docs parity.** Extend `tests/mcp-skill-parity.test.ts`, or add a sibling, asserting that every `CLI_COMMAND_CATALOG` name appears in both `docs/cli.md` and `SKILL.md`. Then close the existing drift by documenting `apisurface`, `chunk`, and `dumpmod` in `SKILL.md`.
- **Add warm rows to the checked benchmark.** Extend `docs/benchmarks/scenarios.json` with a warm-cache CLI variant and a warm-MCP variant of at least one existing scenario, regenerate with `npm run bench:docs`, and rewrite the latency-sources section around the warm numbers. The cold `--cache off` rows stay, but they stop being the only evidence.
- **Fix the coverage ranking.** Add a worker-entry category to `scripts/coverage-markdown-lib.mjs` alongside the existing type-only section so `src/sqlite/rawQueryWorker.ts`, `src/agent/query-index/workerPool.ts`, and `src/worker/nativeExtractWorker.ts` are reported as off-thread rather than ranked as least-covered. Regenerate `docs/coverage/js.md`.
- **Plans hygiene.** Delete `docs/plans/2026-08-08-library-surface-separation.md`, implemented in 2.0.0, whose record lives in `CHANGELOG.md` and Git history. Move `2026-08-17-unicode-identifier-support.md` out of Planned: either close it and record the one blocked C# item as a `docs/language-parity.md` limitation, where it already appears, or move it to a blocked section naming that dependency.

Verification:

```bash
npx vitest run tests/docs-examples.test.ts tests/mcp-skill-parity.test.ts tests/links-cli.test.ts
npm run bench:docs && npm run bench:docs:check
npm run coverage:markdown
node ./dist/cli.js links --root .
npm run check
```

## PR 4: split `src/mcp/server.ts`

Fixes F6. Pure move, no behavior change. Break the module along the five seams in F6, keeping `src/mcp/server.ts` as the composition root that re-exports the public surface (`createCodegraphMcpHandlers`, `listCodegraphMcpTools`, `serveCodegraphMcp`) so `src/mcp.ts` and `@lzehrung/codegraph/mcp` are unchanged.

| New module                  | Content                                                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/mcp/handlers.ts`       | `createCodegraphMcpHandlersForSession` and its handler types. Split the long function by tool family (search, navigate, review, artifact); this is the main readability win.                 |
| `src/mcp/protocol.ts`       | `createCodegraphMcpProtocolServer*`, the operation and concurrency trackers, `callMcpTool`, `toToolResult`, `toToolErrorResult`, and the zod meta schemas.                                   |
| `src/mcp/httpTransport.ts`  | `startCodegraphMcpHttpServer`, `handleMcpHttpRequest`, and the body and timeout constants. Coordinate with the existing `src/mcp/http.ts` host and origin policy rather than duplicating it. |
| `src/mcp/legacySessions.ts` | The legacy SSE session store, eviction, and `runWithLegacyRequestAbortSignal`.                                                                                                               |

Constraints: no signature changes, no reordering of exported members that tests import by name, and no behavior change of any kind. A diff that is not a pure move should be split out and justified separately. `tests/mcp-server.test.ts` plus `mcp-protocol-v2`, `mcp-stdio-lifecycle`, and `mcp-stream-cancellation` are the safety net and should need no edits beyond import paths.

Out of scope: `src/indexer/build-index.ts`, which PR 2 edits; `build-cache/project-snapshot.ts`; `duplicates/scoring.ts`; and the flat `tests/` layout.

Verification:

```bash
npx vitest run tests/mcp-server.test.ts tests/mcp-protocol-v2.test.ts \
  tests/mcp-stdio-lifecycle.test.ts tests/mcp-stream-cancellation.test.ts \
  tests/mcp-workspace-symbols.test.ts tests/mcp-call-hierarchy.test.ts \
  tests/mcp-type-hierarchy.test.ts tests/mcp-rename-preview.test.ts tests/mcp-refactor-plan.test.ts
npm run build && npm run check
```

Also confirm that `npm run build:core` still rejects MCP modules from the core package closure (`tests/core-package-surface.test.ts`), since the split adds new files that must stay product-only, and smoke-test `node ./dist/cli.js mcp serve --root .` over stdio with a `tools/list` followed by one `tools/call`.

## PR 5: shared server lifecycle

Implements [shared server lifecycle](2026-07-03-03-shared-server-lifecycle.md). Lands after PR 2, which reduces the per-process cost this feature then stops paying entirely.

Add `codegraph server start|status|stop` as a convenience wrapper over `codegraph mcp serve`, with a project-local registry at `.codegraph/server.json`. Follow that plan as written; the parts that matter most:

- `start` refuses to start when a live server is already registered for the root unless `--replace`, defaults to host `127.0.0.1` and port `7331`, writes the registry only after the server accepts requests, and forwards `--warmup`, `--warmup-symbols`, `--cache`, `--native`, `--workers`, and the discovery flags.
- `status` validates liveness with an HTTP health request rather than `pid` existence, because PIDs are reused, and supports `--json`. A stale registry is reported as stale with the remedy, not treated as live.
- `stop` only stops a process that identifies as codegraph for the same root, and removes stale registry files safely.
- The registry stores process metadata only (`schemaVersion`, `pid`, `url`, `root`, `startedAt`, `version`), never analysis data.
- Preserve the immutable Windows native cache semantics: report installed-version drift and require an explicit restart rather than replacing mapped runtime files or terminating clients.

Files: new `src/cli/server.ts`, plus `src/cli/commandCatalog.ts`, `src/cli/help.ts`, `src/cli/options.ts`, `src/cli.ts`, and an optional health endpoint in the MCP server, which should land after PR 4 so it targets the split modules. Docs: `docs/cli.md`, `docs/mcp.md`, `docs/agent-workflows.md`, and `codegraph-skill/codegraph/SKILL.md`.

Non-goals from that plan are kept: no implicit server start from unrelated commands, no detached daemon manager, and no non-loopback bind by default.

Verification:

```bash
npx vitest run tests/mcp-server-lifecycle.test.ts
npm run check
```

New tests must cover a registry written only after the server is reachable, `status --json` against a live server, stale-registry detection, `stop` removing the registry and stopping the process, a rejected root mismatch, and a public host requiring an explicit `--host`. Manual smoke: `codegraph server start --root . --warmup`, point two MCP clients at the printed URL, then `codegraph server stop --root .`. Because PR 3 adds CLI-to-docs parity enforcement, the new command names fail the build until `docs/cli.md` and `SKILL.md` are updated in the same change, which is the intended behavior.

## Explicitly deferred

| Item                                                                             | Why not now                                                                                                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Semantic graph synthesizers                                                      | Needs the shared provenance contract designed first; it is a design change followed by a slice, not a cleanup.               |
| Privacy-preserving diagnostics                                                   | Self-contained and low risk, but low user-visible value next to PR 5.                                                        |
| Source language expansion                                                        | The priority index correctly deprioritizes breadth until semantic depth justifies it.                                        |
| Splitting `build-index.ts`                                                       | Overlaps PR 2's edits to the same file. Revisit once the performance work settles.                                           |
| Reorganizing the flat `tests/` tree                                              | Large churn, and no correctness or clarity gain that the existing naming convention does not already provide.                |
| [Performance measurement backlog](2026-08-03-performance-measurement-backlog.md) | It does not authorize an optimization by itself; PR 2's re-measurement shows whether its scenarios are still worth building. |

## Sequencing

PR 2b and PR 2c shipped first (out of order, driven by the indexing-performance investigation), then PR 1. Remaining: PR 2, then PR 3 and PR 4 in either order, then PR 5.

PR 1 goes first because it removes code the later changes would otherwise have to preserve. PR 2, PR 2b, and PR 2c are next because they are the highest-value user-facing changes and their measurements feed PR 3's docs; PR 2 covers fixed per-process startup cost, PR 2b covers per-file syntax-tree marshalling, and PR 2c covers the non-worker path's redundant parse that PR 2b's own follow-up measurement had misread as a worker-coordination problem. (Stale as written: this said to run PR 2 first because its worker-startup fixes touch the same files PR 2b and PR 2c edit. Those two already shipped, so PR 2 now lands on top of their changed versions of `build-workers.ts` and `nativeExtractWorker.ts` instead.) PR 2c depends on PR 2b's columnar encoding existing, since its fix reuses the same `PreparedFileContext.syntaxTree` fast path PR 2b's worker case already relies on. PR 3 and PR 4 are independent of each other. PR 5 is last because it wants the lower startup cost from PR 2, PR 4's split MCP modules for its health endpoint, and PR 3's parity test to force its own docs to be written.

## Correction log

This plan's own investigation contained a real mistake, worth recording rather than quietly editing away: PR 2b's initial "Follow-ups this opened" section (and the original F10) concluded that native worker threads provide no speedup on this repository. That conclusion was reached from a CLI-based "workers on" vs "workers off" comparison that, on inspection, compared two identical configurations - `codegraph index` has no way to force workers off from the CLI, and this repository's file count always crosses the auto-enable threshold either way. The real comparison (forced through the library API) shows workers consistently about 15-21% faster. The profile from that flawed comparison was still useful - it pointed at a real, separate bug (F10, corrected) - but the conclusion drawn from the comparison itself was wrong until re-measured properly. See F10 for the full account.

A second mistake, same shape: `tests/duplicates.test.ts` disagreed with the native tokenizer at U+088F in this dev sandbox, and that was read as a real pre-existing bug and "fixed" by bumping `unicode-ident` from `"=1.0.14"` to `"=1.0.24"` (plus a `DUPLICATE_TOKENIZER_REVISION` bump). The verification behind that fix - diffing `unicode-ident`'s XID tables against this sandbox's `\p{XID_Start}`/`\p{XID_Continue}` - was run against the wrong target: this sandbox's Node reports `unicode: '17.0'`, `icu: '78.2'`, which is not a real released Node build, while CI's `build-and-test` job pins the actual `node-version: 22.16.0` from nodejs.org. CI's `build-and-test` job at commit `d52ab27` (before any `unicode-ident` change) was green, proving the original `"=1.0.14"` pin already agreed with real Node 22.16.0's ICU on U+088F. The bump made CI fail in the opposite direction it had "fixed" locally. Reverted both the `unicode-ident` pin and the `DUPLICATE_TOKENIZER_REVISION` bump; the sandbox-local disagreement remains and is a sandbox/Node-build artifact, not a repository bug - not chased further. Lesson: a local "fix" for a test failure needs verification against the actual CI/runtime target, not whatever Node happens to be on the box you're standing on.
