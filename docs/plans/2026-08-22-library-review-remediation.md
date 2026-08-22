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
- `test:ci` is the only script wired to `scripts/report-slow-tests.mjs`, and no workflow invokes it (CI uses `test:coverage`), so slow-test reporting never runs.

### F8: small correctness nit in portable handles

`parseAgentSqlHandle` (`src/agent/handles.ts:106-112`) has a `parts.length > 4` branch that returns `name` and `file` undecoded, unlike the 4-part branch at `:98-104` which calls `decodeHandlePart`. `formatAgentSqlHandle` always encodes both fields and `encodeURIComponent` escapes `:`, so the longer branch is unreachable from any handle codegraph produces. It is untested lenient-parse code that returns a differently shaped result than the supported path. `src/agent/handles.ts` sits at 45% branch coverage, the lowest of any runtime file in the report.

## Target use cases and feature selection

The library serves four use cases well today: agent repo orientation (`orient`, `explore`, `search`, `packet`), change review (`review`, `impact`, `affected`, `drift`, `duplicates`), semantic navigation (`goto`, `refs`, `callers`/`callees`, hierarchies, `rename-preview`, `refactor-plan`), and structured handoff (`graph`, `artifact`, SQLite, MCP).

`docs/plans/` already owns the feature backlog and it is well reasoned. Ranked against the stated positioning of repeated agent queries over one repo snapshot:

1. [Shared server lifecycle](2026-07-03-03-shared-server-lifecycle.md) is highest and is scheduled below as PR 5. MCP is the documented path for repeated queries, but starting and managing it is manual, so most users pay cold CLI start per query. It pairs directly with PR 2: PR 2 lowers the per-process cost, PR 5 stops paying it at all.
2. [Semantic graph synthesizers](2026-07-03-semantic-graph-synthesizers.md) is the biggest capability expansion, because "how does this feature work" currently stops at imports and calls while framework routes are where the answer usually lives. Deferred: it needs the shared provenance contract designed before the first slice.
3. [Privacy-preserving diagnostics](2026-07-03-14-privacy-preserving-diagnostics.md) is modest and mostly reduces support cost. Deferred.
4. [Source language expansion](2026-05-12-source-language-expansion.md) stays deprioritized, correctly: breadth without semantic depth weakens the parity story. Deferred.

No feature is proposed beyond this backlog. The gaps that matter are execution, not ideas.

## PR 1: retire the dead parser seam and re-arm the quality gates

Fixes F1, F2, F3, F7, and F8. Largest diff, simplest review: almost all of it is deletion. The seam and the gates belong in one change because they share a root cause. Turning the gates on without deleting the code first would only produce a red tree.

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

## PR 2: native runtime and worker startup costs

Fixes F4 and the stale performance numbers in F5. Implement [2026-07-25 native runtime startup](2026-07-25-native-runtime-startup.md) as written, priorities 0 through 4. That plan is measured, specific, and already reviewed; this is execution, not redesign.

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

PR 1, then PR 2, then PR 3 and PR 4 in either order, then PR 5.

PR 1 goes first because it removes code the later changes would otherwise have to preserve. PR 2 is second because it is the highest-value user-facing change and its measurements feed PR 3's docs. PR 3 and PR 4 are independent of each other. PR 5 is last because it wants PR 2's lower startup cost, PR 4's split MCP modules for its health endpoint, and PR 3's parity test to force its own docs to be written.
