# Indexer Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose `src/indexer.ts` into focused internal modules behind a stable `src/indexer.ts` facade without changing behavior or reducing test coverage.

**Architecture:** Keep `src/indexer.ts` as the public entrypoint while extracting cohesive internal modules under `src/indexer/`. Sequence the work from lowest-risk pure helpers to highest-risk orchestration, and lock each extraction behind targeted and full verification before moving to the next seam.

**Tech Stack:** TypeScript, Vitest, existing native Tree-sitter integration, existing CLI/library facade, Git branch workflow

---

## File Structure

**Create:**
- `src/indexer/shared.ts`
- `src/indexer/parse-context.ts`
- `src/indexer/locals-and-exports.ts`
- `src/indexer/imports.ts`
- `src/indexer/reference-context.ts`
- `src/indexer/scope.ts`
- `src/indexer/navigation.ts`
- `src/indexer/build-cache.ts`
- `src/indexer/build-index.ts`

**Modify:**
- `src/indexer.ts`
- `src/index.ts`
- `docs/how-it-works.md` if the internal architecture section needs a concise update after the final extraction

**Test:**
- `tests/goto.test.ts`
- `tests/references.test.ts`
- `tests/native-semantic-parity.test.ts`
- `tests/detailed-symbol-native-only.test.ts`
- `tests/fallback-import-extraction.test.ts`
- `tests/native-fallback-contract.test.ts`
- `tests/cache-invalidation.test.ts`
- `tests/disk-cache-sqlite.test.ts`
- `tests/graph-delta.test.ts`
- `tests/parsed-cache-reuse.test.ts`
- `tests/parsed-cache-eviction.test.ts`
- `tests/bloom-filter-integration.test.ts`
- `tests/handles.test.ts`
- `tests/agent-tools.test.ts`
- `tests/complex-monorepo.test.ts`
- `tests/angularjs-framework.test.ts`

### Task 1: Freeze the Behavioral Baseline

**Files:**
- Modify: `tests/fallback-import-extraction.test.ts` only if extraction seams lack direct characterization
- Modify: `tests/detailed-symbol-native-only.test.ts` only if parse-context seams lack direct characterization
- Modify: `tests/references.test.ts` only if navigation helpers lack direct characterization

- [ ] **Step 1: Audit current coverage against the extraction seams**

Run:

```powershell
rg -n "collectLocalsAndExportsFromSource|collectImportsForFile|ensureParsedContext|goToDefinition|findReferences" tests src
```

Expected: existing direct or indirect tests clearly cover each public seam before code moves.

- [ ] **Step 2: Add only missing characterization tests first**

Rules:

```text
Add tests only where the current suite is indirect enough that a clean extraction could break behavior without a localized failure.
Do not change production code in this step.
Prefer direct tests of existing public functions over new helper exports.
```

- [ ] **Step 3: Verify the new tests fail for the intended reason before any implementation change**

Run the narrow commands for every added test:

```powershell
npm run test:ci -- tests/fallback-import-extraction.test.ts
npm run test:ci -- tests/detailed-symbol-native-only.test.ts
npm run test:ci -- tests/references.test.ts
```

Expected: new assertions fail against the temporary red state, not because of typos or broken fixtures.

- [ ] **Step 4: Restore the original behavior and verify green**

Run:

```powershell
npm run test:ci -- tests/fallback-import-extraction.test.ts tests/detailed-symbol-native-only.test.ts tests/references.test.ts
```

Expected: all targeted characterization tests pass.

- [ ] **Step 5: Commit the baseline tests**

```powershell
git add tests/fallback-import-extraction.test.ts tests/detailed-symbol-native-only.test.ts tests/references.test.ts
git commit -m "test: lock indexer decomposition seams"
```

### Task 2: Extract Shared Types and Pure Helpers

**Files:**
- Create: `src/indexer/shared.ts`
- Modify: `src/indexer.ts`

- [ ] **Step 1: Move only pure shared helpers and low-risk types**

Move these first:

```text
DEFAULT_REF_CONTEXT_LINES
QUERY_DRIVEN_LOCALS_LANGUAGES
parseGoImportAlias
createEmptyModuleIndex
edgeKey
compareEdges
toRelativeEdge
sameDef
_rangeContains
```

Constraint:

```text
Do not move BuildOptions, BuildReport, ProjectIndex, or public API function signatures in this task unless required to break a circular dependency cleanly.
```

- [ ] **Step 2: Keep `src/indexer.ts` as the import facade**

Implementation shape:

```typescript
import {
  DEFAULT_REF_CONTEXT_LINES,
  QUERY_DRIVEN_LOCALS_LANGUAGES,
  parseGoImportAlias,
} from "./indexer/shared.js";
```

- [ ] **Step 3: Run build, lint, and narrow semantic checks**

Run:

```powershell
npm run build
npm run lint
npm run test:ci -- tests/handles.test.ts tests/agent-tools.test.ts tests/references.test.ts
```

Expected: zero build errors, zero lint errors, targeted tests pass unchanged.

- [ ] **Step 4: Commit**

```powershell
git add src/indexer/shared.ts src/indexer.ts
git commit -m "refactor: extract indexer shared helpers"
```

### Task 3: Extract Parse Context and Native/JS Reconstruction

**Files:**
- Create: `src/indexer/parse-context.ts`
- Modify: `src/indexer.ts`

- [ ] **Step 1: Move parse-context helpers as one cohesive unit**

Move together:

```text
ParsedFileContext
PreparedFileContext
PreparedFileParseAttempt
attemptParsePreparedFileContext
tryParsePreparedFileContext
parsePreparedFileContext
initParserBackendDegradationReport
recordParserBackendDegradation
prepareFileForIndexing
prepareFileContextForBuild
parseFile
ensureParsedContext
```

- [ ] **Step 2: Preserve existing exports from `src/indexer.ts`**

Required facade behavior:

```typescript
export async function parseFile(file: string): Promise<ParsedFileContext> {
  return await parseFileFromContext(file);
}
```

The exact helper name may differ, but `src/indexer.ts` must retain the public export names and signatures.

- [ ] **Step 3: Verify red-green on any new parse-context characterization tests**

Run:

```powershell
npm run test:ci -- tests/detailed-symbol-native-only.test.ts
```

Expected: native-only degradation and parse reconstruction behaviors still match the pre-refactor baseline.

- [ ] **Step 4: Run broader verification for parse consumers**

Run:

```powershell
npm run build
npm run lint
npm run test:ci -- tests/detailed-symbol-native-only.test.ts tests/native-fallback-contract.test.ts tests/native-semantic-parity.test.ts tests/parsed-cache-reuse.test.ts tests/parsed-cache-eviction.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git add src/indexer/parse-context.ts src/indexer.ts
git commit -m "refactor: extract indexer parse context"
```

### Task 4: Extract Local/Export Collection

**Files:**
- Create: `src/indexer/locals-and-exports.ts`
- Modify: `src/indexer.ts`

- [ ] **Step 1: Move the full locals/exports pipeline together**

Move together:

```text
parseObjectPatternBindings only if imports also need it immediately, otherwise leave it for Task 5
collectLocalsAndExportsFromSource
docstring helpers
complexity helpers
native/js locals query helpers
export assembly helpers
appendJsLikeRegexFallbackExports dependencies stay where already defined unless extraction requires a local wrapper
```

- [ ] **Step 2: Keep cross-module behavior stable**

Rules:

```text
Do not simplify language-specific export handling during extraction.
Do not remove Python __all__ handling, TS export= normalization, or JS regex fallback behavior.
```

- [ ] **Step 3: Verify targeted behavior**

Run:

```powershell
npm run test:ci -- tests/export-fallback-regression.test.ts tests/detailed-symbol-native-only.test.ts tests/native-semantic-parity.test.ts
```

- [ ] **Step 4: Run build and lint**

```powershell
npm run build
npm run lint
```

- [ ] **Step 5: Commit**

```powershell
git add src/indexer/locals-and-exports.ts src/indexer.ts
git commit -m "refactor: extract indexer locals and exports"
```

### Task 5: Extract Import Collection

**Files:**
- Create: `src/indexer/imports.ts`
- Modify: `src/indexer.ts`

- [ ] **Step 1: Move the full import pipeline together**

Move together:

```text
collectImportsForFile
parseObjectPatternBindings if still local
language-specific statement override helpers
graph-only import handling
fallback import extraction handler dependencies that are local to imports
```

- [ ] **Step 2: Keep language-specific behavior intact**

Do not change:

```text
Python import/module resolution behavior
PHP Composer implicit import behavior
Go alias normalization
Java/Kotlin text import fallback behavior
Native-authoritative vs fallback logic
```

- [ ] **Step 3: Verify import extraction behavior before moving on**

Run:

```powershell
npm run test:ci -- tests/fallback-import-extraction.test.ts tests/detailed-symbol-native-only.test.ts tests/complex-monorepo.test.ts tests/angularjs-framework.test.ts
```

- [ ] **Step 4: Run build and lint**

```powershell
npm run build
npm run lint
```

- [ ] **Step 5: Commit**

```powershell
git add src/indexer/imports.ts src/indexer.ts
git commit -m "refactor: extract indexer imports"
```

### Task 6: Extract Reference Context and Scope Helpers

**Files:**
- Create: `src/indexer/reference-context.ts`
- Create: `src/indexer/scope.ts`
- Modify: `src/indexer.ts`

- [ ] **Step 1: Move scope-building and reference-snippet helpers without changing semantics**

Move together:

```text
ScopeIndex types and helpers
buildScopeIndexFromSource
extractLineContext
extractLineContextWithMaxTotal
extractEnclosingBlock
collectNamespaceMemberRefs only if it depends directly on the moved helpers, otherwise defer to Task 7
```

- [ ] **Step 2: Run targeted scope/reference checks**

Run:

```powershell
npm run test:ci -- tests/references.test.ts tests/goto.test.ts tests/native-semantic-parity.test.ts
```

- [ ] **Step 3: Run build and lint**

```powershell
npm run build
npm run lint
```

- [ ] **Step 4: Commit**

```powershell
git add src/indexer/reference-context.ts src/indexer/scope.ts src/indexer.ts
git commit -m "refactor: extract indexer scope helpers"
```

### Task 7: Extract Navigation APIs

**Files:**
- Create: `src/indexer/navigation.ts`
- Modify: `src/indexer.ts`

- [ ] **Step 1: Move navigation as a cohesive semantic unit**

Move together:

```text
GoToRequest
GoToResult
Reference
goToDefinition
findReferences
goToDefinitionById
findReferencesById
collectNamespaceMemberRefs if not moved earlier
resolveImported-related local helpers that exist only for navigation
```

- [ ] **Step 2: Keep public signatures and result shapes unchanged**

Rules:

```text
No result-field renames
No changed error reasons
No changed reference sorting
No changed context snippet behavior
```

- [ ] **Step 3: Verify targeted navigation behavior**

Run:

```powershell
npm run test:ci -- tests/goto.test.ts tests/references.test.ts tests/handles.test.ts tests/native-semantic-parity.test.ts tests/bloom-filter-integration.test.ts
```

- [ ] **Step 4: Run broader downstream checks**

Run:

```powershell
npm run test:ci -- tests/agent-tools.test.ts tests/impact-analyzer.test.ts tests/impact-context.test.ts tests/review.test.ts
```

- [ ] **Step 5: Run build and lint**

```powershell
npm run build
npm run lint
```

- [ ] **Step 6: Commit**

```powershell
git add src/indexer/navigation.ts src/indexer.ts
git commit -m "refactor: extract indexer navigation"
```

### Task 8: Extract Cache, Manifest, and Build Orchestration

**Files:**
- Create: `src/indexer/build-cache.ts`
- Create: `src/indexer/build-index.ts`
- Modify: `src/indexer.ts`

- [ ] **Step 1: Move cache and manifest helpers into `build-cache.ts`**

Move together:

```text
SQLite cache helpers
manifest types and helpers
file signature helpers
manifest verification and normalization helpers
worker pool setup/teardown helpers if build-index depends on them directly
```

- [ ] **Step 2: Move build orchestration into `build-index.ts`**

Move together:

```text
resolveCrossModuleSymbolExports
buildIndexedModuleForFile
buildIndexFromFileListShared
buildProjectIndex
buildProjectIndexFromFiles
buildProjectIndexIncremental
buildGraphDelta
```

- [ ] **Step 3: Preserve the stable facade**

Implementation requirement:

```text
`src/indexer.ts` remains the public export surface for all existing build functions.
```

- [ ] **Step 4: Run high-risk incremental/cache verification**

Run:

```powershell
npm run test:ci -- tests/cache-invalidation.test.ts tests/disk-cache-sqlite.test.ts tests/graph-delta.test.ts tests/parsed-cache-reuse.test.ts tests/parsed-cache-eviction.test.ts
```

- [ ] **Step 5: Run build and lint**

```powershell
npm run build
npm run lint
```

- [ ] **Step 6: Commit**

```powershell
git add src/indexer/build-cache.ts src/indexer/build-index.ts src/indexer.ts
git commit -m "refactor: extract indexer build pipeline"
```

### Task 9: Final Facade Cleanup and Full Verification

**Files:**
- Modify: `src/indexer.ts`
- Modify: `docs/how-it-works.md` only if the architecture description is now materially misleading

- [ ] **Step 1: Reduce `src/indexer.ts` to a thin, readable facade**

Rules:

```text
Keep only public type exports, public wrapper exports, and minimal glue needed to avoid circular imports.
Do not move public exports out of `src/indexer.ts` if that adds churn without user value.
```

- [ ] **Step 2: Update docs only if needed**

Potential doc delta:

```text
Concisely note that indexing internals are now split across focused modules under `src/indexer/` while public APIs remain unchanged.
```

- [ ] **Step 3: Run the full verification suite**

Run:

```powershell
npm run build
npm run lint
npm run test:ci
```

Expected: build passes, lint passes, full test suite passes with no new coverage regressions.

- [ ] **Step 4: Check branch state and commit the final cleanup**

```powershell
git status --short
git add src/indexer.ts src/indexer/*.ts docs/how-it-works.md
git commit -m "refactor: finalize indexer decomposition"
```

- [ ] **Step 5: Push the completed branch**

```powershell
git push
```

## Self-Review

- Spec coverage: this plan covers baseline characterization, pure helper extraction, parse context, locals/exports, imports, scope/navigation, build/cache orchestration, final facade cleanup, and full verification.
- Placeholder scan: no TBD/TODO placeholders remain; every task names exact files and verification commands.
- Type consistency: the plan keeps `src/indexer.ts` as the stable facade throughout, which avoids accidental public API churn while internal modules move underneath it.
