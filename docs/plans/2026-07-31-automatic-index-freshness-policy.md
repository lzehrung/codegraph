# Automatic Index Freshness Policy Plan

**Status: Planned.** Baseline verified on `fix/graph-query-disk-cache` at `cb32ec8b` (PR #189) on 2026-07-31.

## Decision

Current-state, read-only queries must validate freshness automatically and use the disk cache by default. Manual `index` or `sync` runs remain optional warmup and repair operations, not correctness prerequisites.

Do not add a time-to-live. Time does not prove whether repository inputs changed, while the existing manifest, configuration, Git, file-signature, and snapshot checks can make that decision from repository state.

## Goal

Create one internal loading policy for current-project queries so every caller gets the same behavior:

1. Validate the existing index before use.
2. Reuse a compatible persisted snapshot when inputs are unchanged.
3. Incrementally update changed files and affected dependents when safe.
4. Fall back to a full rebuild whenever compatibility or freshness cannot be established.
5. Preserve explicit user overrides such as `--cache off`, `--cache-verify`, and `--cache-strict`.
6. Make new commands declare their index behavior so a raw full-build path cannot be introduced accidentally.

The result should make `codegraph index` useful for prewarming, but unnecessary before `deps`, `refs`, `inspect`, or any other current-state query.

## Non-goals

- No new cache storage format or manifest schema.
- No daemon, filesystem watcher, or polling service.
- No TTL or scheduled rebuild.
- No removal of `buildProjectIndex`, `buildProjectIndexFromFiles`, or explicit full-build APIs.
- No change to historical or artifact-producing commands merely to maximize cache reuse.
- No weakening of path confinement, option/configuration compatibility checks, native-runtime fingerprinting, snapshot validation, transient-file handling, or deleted-file dependent invalidation.
- No conversion of the library `Session` API's explicit `incremental` choice into an implicit behavior change.
- No invented wall-clock performance threshold. Behavioral cache outcomes are the release gate; timings are reported evidence.

## Why this is needed

PR #189 corrected another group of commands that bypassed the incremental loader. On the Gunship repository, an unchanged `deps` invocation fell from roughly 15.4 seconds to 0.52 seconds, with approximately 247 ms spent validating the existing index and no rebuild.

That repair exposed a maintainability problem rather than a missing invalidation algorithm: freshness logic is centralized, but the choice to invoke it is not.

### F1: Query entry-point selection is scattered

`buildProjectIndexIncremental` is the authoritative disk freshness path, but callers choose among it, `buildProjectIndex`, and `buildProjectIndexFromFiles` independently. Current direct callers include CLI navigation, graph queries, inspection, duplicate analysis, impact, review, agent tools, agent sessions, library sessions, index generation, graph generation, and drift snapshots.

PR #189 had to correct `deps`, `rdeps`, `path`, `unresolved`, unscoped `cycles`, `apisurface`, and `duplicates` individually. The same class of regression can recur whenever a command defaults to the wrong builder or omits `cache: "disk"`.

### F2: Option assembly is duplicated

`src/cli.ts` currently creates general build options, then separately adds the disk-cache default for graph queries and duplicates. `inspect`, navigation, impact, review, and agent-backed commands establish similar defaults in their own modules.

This duplication makes a caller's behavior depend on where it was wired rather than on the command's declared intent.

### F3: Explicit files have two incompatible meanings

For incremental builds, `files` can mean either:

- change inputs that should invalidate the current project index; or
- the complete resolved scope of a scoped query.

Scoped current-state queries must set `filesAreProjectScope: true`. Missing that distinction can cause unnecessary reparsing, while applying it to a partial change set can hide required invalidation.

### F4: CLI command coverage is not exhaustive

`CLI_COMMAND_CATALOG` is the complete command inventory, but it does not record index behavior. A new command can be added without choosing between no index, automatic current-state loading, an agent session, explicit materialization, or historical reconstruction.

### F5: Warm behavior is tested by module family, not as one product contract

Existing tests cover many individual cache paths, and PR #189 added warm regressions for graph queries and duplicates. There is no single contract that proves every current-state command family validates automatically and that intentional rebuild paths remain intentional.

## Existing architecture to preserve

### `buildProjectIndexIncremental` remains authoritative

Do not duplicate its invalidation logic in a new policy layer. It already handles:

- missing or incompatible manifests;
- discovery, native, graph-option, and configuration changes;
- committed, staged, unstaged, untracked, deleted, and transient files;
- file signatures and optional exhaustive verification;
- stale Git revisions;
- snapshot identity and payload validation;
- dependent invalidation for removed or changed files;
- safe fallback to full discovery and rebuild.

The new layer chooses this loader and supplies unambiguous scope/options. It does not decide whether repository bytes are fresh itself.

### Agent-session freshness remains a separate lifetime concern

`createAgentSession` already defaults its initial build to incremental disk loading. Its `manual`, `check`, and `auto` freshness policies decide whether an in-memory snapshot held by a long-running process should be checked or refreshed.

Keep that API. Per-invocation CLI freshness and long-lived in-memory freshness solve different problems, even though both eventually use the same incremental indexer.

### Low-level builders remain explicit tools

Retain the current builders for callers with deliberate semantics:

- `buildProjectIndex`: full discovery/current bytes, including public library callers that explicitly request it.
- `buildProjectIndexFromFiles`: an explicit file-set build or artifact materialization.
- `buildProjectIndexIncremental`: automatic persisted-state validation and incremental repair.

The policy layer must not make the low-level API ambiguous or silently reinterpret historical/change-set builds as current-project queries.

### Progress output remains truthful

A current-state query reports `Checking project index`, followed by:

- `Checked project index` for an unchanged snapshot;
- build or update progress only when work occurred.

JSON stdout must remain unchanged. Cache diagnostics remain on stderr.

## Proposed design

### 1. Add one current-project index loader

Create an internal module, preferably `src/indexer/load-current-index.ts`, with a narrow API around `buildProjectIndexIncremental`.

Proposed contract:

```ts
export type CurrentProjectIndexScope = { kind: "project" } | { kind: "resolved-files"; files: readonly string[] };

export type LoadCurrentProjectIndexOptions = Omit<
  IncrementalBuildOptions,
  | "files"
  | "filesAreProjectScope"
  | "gitBase"
  | "gitHead"
  | "changedSince"
  | "reconciledManifestUpdatedAt"
  | "reconciledWorkingTreeDiffFiles"
  | "reconciledUntrackedFiles"
>;

export async function loadCurrentProjectIndex(request: {
  root: string;
  scope: CurrentProjectIndexScope;
  options?: LoadCurrentProjectIndexOptions;
}): Promise<ProjectIndex>;
```

Exact type names may follow nearby conventions, but preserve these invariants:

- Default `cache` to `"disk"` only when the caller did not specify a mode.
- Preserve explicit `off` and `memory` modes.
- For `project`, do not pass an explicit file list.
- For `resolved-files`, copy the file list and set `filesAreProjectScope: true` in one place.
- Exclude change-range and reconciled-evidence fields from this API. Those belong to specialized incremental callers and must not be confused with query scope.
- Forward progress, report, discovery, graph, native, worker, strict, and verification options unchanged.
- Return the existing `ProjectIndex`; do not introduce another result envelope or cache status schema.

This helper is internal and should not be exported from the package root in the first change.

### 2. Centralize CLI option policy

Replace command-specific `cache ??= "disk"` mutations with one option constructor for automatic current-state queries. Keep parsing of CLI flags in `src/cli.ts`; move only policy defaults and scope semantics into the loader.

Handler contexts should receive either:

- a `loadCurrentProjectIndex` callback; or
- fully parsed options and call the shared loader directly.

Prefer the callback where handlers already use dependency injection for focused tests. Remove fallbacks such as a locally aliased `defaultBuildProjectIndex` from query handlers once every production callsite supplies the current-state loader.

### 3. Classify every CLI command

Add a non-user-facing index behavior classification adjacent to `CLI_COMMAND_CATALOG`, or in a dedicated `src/cli/indexPolicy.ts` keyed by canonical command name.

Use these categories:

- `none`: no index is loaded.
- `current-query`: load current repository state through the new automatic policy.
- `agent-session`: use `createAgentSession`, including its in-memory freshness contract.
- `explicit-build`: intentionally create, refresh, or materialize an index/artifact.
- `historical`: reconstruct or compare a requested revision/range where current-state query policy is not applicable.

Commands with conditional behavior may declare more than one category, but each index-loading branch must be named. Add a catalog parity test so adding or removing a command fails until its index behavior is classified.

The classification is an architectural inventory, not runtime dispatch. Do not make a documentation catalog decide implementation control flow.

### 4. Migrate current-state query families

Route these current-state paths through the shared loader:

- navigation: `goto`, `refs`, `dumpmod`;
- graph queries: `deps`, `rdeps`, `path`, unscoped `cycles`, `unresolved`, `apisurface`;
- structural summaries: `inspect`, `hotspots`;
- analysis: `duplicates`;
- current-project portions of `impact` and `review` after diff/range selection is kept separate;
- direct agent-tool fallbacks that load current state without an `AgentSession`.

Preserve these boundaries:

- Scoped graph collection that deliberately calls `collectGraph` may remain separate until it can consume a `ProjectIndex` without changing output.
- `graph` and `index` artifact/materialization modes retain explicit behavior.
- `drift` retains revision-isolated snapshot construction.
- `graph-delta` and changed-range incremental builds retain their range semantics.
- `createAgentSession` keeps its reconciled manifest/Git evidence path; do not force that richer path through the narrower helper.
- Library `Session` preserves its documented `incremental` option and force-full behavior.

Any remaining raw builder call in a CLI query module must have an adjacent reason captured in the classification and covered by a focused behavioral test.

### 5. Add an architectural boundary

Prevent future query modules from importing low-level full builders casually.

Preferred enforcement:

- Add a narrow ESLint `no-restricted-imports` override for current-query CLI modules, allowing imports from `load-current-index.ts` but rejecting direct `buildProjectIndex` and `buildProjectIndexFromFiles` imports.
- Keep a small explicit exemption list for artifact, lifecycle, historical, and graph-materialization modules.

If ESLint cannot express symbol-level exemptions cleanly without blocking legitimate imports, use module boundaries instead: move current-query handlers behind a context type that exposes only `loadCurrentProjectIndex`. Do not add a test that merely searches source text for function names.

## Test strategy

### Layer 1: Loader decision matrix

Add focused tests for `loadCurrentProjectIndex` using real temporary repositories and the existing build reports/progress events.

Required cases:

1. Missing manifest performs a build and writes usable cache state.
2. Unchanged second load reuses the snapshot with zero parsed files.
3. Modified tracked file updates that file and required dependents.
4. Staged change is detected before commit.
5. New untracked eligible file is indexed.
6. Deleted and renamed files are removed, with dependent invalidation preserved.
7. Discovery/config/native/graph-option mismatch triggers the existing safe rebuild path.
8. Missing or malformed snapshot falls back safely.
9. `--cache off` semantics are preserved and do not claim a disk-cache hit.
10. `cacheVerify` and `cacheStrict` still select their exhaustive validation paths.
11. `resolved-files` scope is treated as complete scope rather than a set of changed inputs.
12. A non-Git project remains correct through full-discovery fallback.
13. Explicit transient-file provenance and retirement remain correct.

Reuse existing cache-invalidation fixtures rather than creating a parallel synthetic cache model.

### Layer 2: CLI current-query contract matrix

Create a table-driven integration suite grouped by loader family rather than duplicating every mutation scenario for every command.

For each current-query family:

1. Run one representative command cold with `--progress`.
2. Run it again unchanged.
3. Assert the warm run reports `Checking project index` and `Checked project index`.
4. Assert the warm run does not report `Building project index` or `Updating project index`.
5. Assert structured command output remains equivalent after removing nondeterministic timing/report fields.

At minimum, cover:

- navigation (`refs` or `goto`);
- graph query (`deps`);
- whole-project graph summary (`cycles` or `apisurface`);
- scoped summary (`inspect` or `hotspots`);
- duplicate analysis (`duplicates`);
- diff-aware analysis (`impact` or `review`) while proving the diff range does not become index invalidation input;
- one AgentSession-backed command.

Then mutate one repository fixture and prove one representative automatic query sees the changed result without a manual `index` call. Shared loader tests carry the exhaustive mutation matrix; command tests prove correct wiring.

### Layer 3: Command classification completeness

Add a test that compares canonical names from `CLI_COMMAND_CATALOG` with the index-policy registry:

- every command has a classification;
- no policy entry references a nonexistent command;
- aliases inherit the canonical command's classification;
- each `current-query` family has a named behavioral test case;
- explicit-build and historical exceptions are enumerated, not inferred from the command family label.

This is the check that prevents a future command from shipping without an explicit freshness decision.

### Layer 4: Runtime smoke and measurement

Use the built CLI against this repository and Gunship:

```powershell
node ./dist/cli.js deps src/cli.ts --root . --json --progress
node ./dist/cli.js deps src/cli.ts --root . --json --progress
node ./dist/cli.js refs src/cli.ts --root . --json --progress
node ./dist/cli.js refs src/cli.ts --root . --json --progress
node ./dist/cli.js inspect --root ../gunship --json --progress
node ./dist/cli.js inspect --root ../gunship --json --progress
```

Record cold/warm wall time and build-report counts, but gate correctness on observed cache behavior, not machine-specific milliseconds.

## Implementation sequence

### PR 1: Introduce the policy primitive

- Add `loadCurrentProjectIndex` and discriminated project/resolved-file scope.
- Add its decision-matrix tests.
- Preserve all existing callsites initially, proving the helper is behaviorally equivalent to direct incremental loading.
- Do not change public exports or docs yet.

Acceptance:

- The helper defaults to disk only when cache mode is absent.
- Scope cannot be confused with changed-file inputs at the type boundary.
- All invalidation and fallback cases remain delegated to `buildProjectIndexIncremental`.

### PR 2: Migrate current-state callers

- Replace direct builder selection in the listed query families.
- Remove duplicated disk-default mutations and handler-local default builders.
- Keep intentional artifact, historical, lifecycle, and changed-range paths explicit.
- Add the table-driven cold/warm CLI contract suite.

Acceptance:

- No current-state query requires a preceding manual `index` or `sync`.
- An unchanged second call performs validation without parsing files.
- A changed repository is observed automatically.
- Existing JSON and human-readable command results remain compatible.

### PR 3: Make policy completeness enforceable

- Add the command classification registry and catalog parity test.
- Add the import/module boundary preventing raw full-build use in current-query handlers.
- Record the explicit exceptions with tests.
- Update canonical documentation and the bundled skill.

Acceptance:

- Adding a CLI command without an index policy fails verification.
- Adding a raw full-builder import to a protected query module fails lint or compilation architecture checks.
- Documentation states that manual indexing is optional and accurately describes override/fallback behavior.

The three PRs may be delivered on one branch as three reviewable commits if repository workflow favors a single pull request. Keep each acceptance boundary intact.

## Likely files

Core policy:

- `src/indexer/load-current-index.ts` (new)
- `src/indexer/build-index.ts` only if a narrow reusable type/export is required
- `src/indexer/types.ts`

CLI wiring and classification:

- `src/cli.ts`
- `src/cli/commandCatalog.ts`
- `src/cli/indexPolicy.ts` (new, if classification is kept separate)
- `src/cli/navigation.ts`
- `src/cli/graphQueries.ts`
- `src/cli/inspect.ts`
- `src/cli/duplicates.ts`
- `src/cli/impact.ts`
- `src/cli/review.ts` or the current review dispatcher
- `src/agent-tools.ts`
- `eslint.config.js`

Tests:

- `tests/cache-invalidation.test.ts`
- `tests/cli-command-modules.test.ts`
- `tests/duplicates.test.ts`
- `tests/agent-session.test.ts`
- a focused policy test file following existing naming conventions

Documentation:

- `docs/cli.md`
- `docs/agent-workflows.md`
- `docs/how-it-works.md`
- `codegraph-skill/codegraph/SKILL.md`

## Risks and mitigations

### Risk: Scope is mislabeled as a change set

Mitigation: make project scope discriminated and exclude change-range fields from the new request type. Cover resolved-file scope with a regression that would reparse perpetually if `filesAreProjectScope` were omitted.

### Risk: Historical analysis accidentally reads current cached state

Mitigation: keep drift, graph-delta, and explicit revision reconstruction outside the current-state helper. Classification and exception tests must name these paths.

### Risk: Cache overrides stop working

Mitigation: default with `options.cache ?? "disk"`; never overwrite an explicit mode. Test `off`, `memory`, `disk`, verify, and strict behavior.

### Risk: A central helper becomes a second indexer

Mitigation: the helper owns only intent translation, default mode, and scope encoding. All compatibility, discovery, signatures, invalidation, fallback, persistence, and snapshot validation remain in `buildProjectIndexIncremental`.

### Risk: Every command is tested with an expensive Cartesian matrix

Mitigation: exhaustive mutation behavior belongs to the shared loader suite. CLI tests prove one cold/warm pair per wiring family plus one end-to-end mutation path.

### Risk: Public APIs change accidentally

Mitigation: keep the helper internal for the first program. Do not change root exports, `SessionOptions.incremental`, or `AgentFreshnessPolicy` without a separate reviewed API proposal.

### Risk: Automatic validation becomes too expensive

Mitigation: retain Git-backed reconciliation and snapshot fast paths. Measure the check phase separately, but do not trade correctness for a time budget or TTL.

## Documentation contract

The canonical guidance should say:

- Current-state index-backed commands validate automatically.
- `index` and `sync` can prewarm or repair state but are not prerequisites for queries.
- Unchanged runs reuse compatible persisted state.
- Changed runs update incrementally when safe and rebuild when required.
- `--cache off` bypasses persisted reuse.
- `--cache-verify` and `--cache-strict` request stronger checks.
- MCP/agent-session `manual`, `check`, and `auto` policies govern an already-loaded in-memory snapshot and are distinct from CLI process startup validation.

Do not promise that every command uses the cache. Artifact production, historical reconstruction, explicit lifecycle operations, and intentionally scoped collectors must be described precisely.

## Definition of done

- One internal API owns automatic current-project index loading and disk-cache defaulting.
- Current-state query families use that API or `createAgentSession`; none select a full builder accidentally.
- Project scope and resolved-file scope are distinct at the type boundary.
- Every CLI command has an explicit index behavior classification.
- A new unclassified command fails verification.
- Protected current-query modules cannot import full-build entry points without an explicit architectural exception.
- Cold, warm, modified, staged, untracked, deleted, renamed, config-mismatch, malformed-cache, non-Git, strict, verify, and cache-off cases are covered at the appropriate test layer.
- A warm unchanged query reports validation without build/update progress and parses zero files.
- A repository change is visible on the next query without a manual `index` or `sync`.
- Historical, artifact, lifecycle, and public library semantics remain unchanged.
- `docs/cli.md`, `docs/agent-workflows.md`, `docs/how-it-works.md`, and `codegraph-skill/codegraph/SKILL.md` describe the final contract accurately.
- Focused suites, runtime smoke commands, fixture cleanliness, and `npm run check` pass.
