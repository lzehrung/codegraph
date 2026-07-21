# Warm-Run Discovery Avoidance Plan

This plan targets one specific, verified gap left by `2026-06-06-performance-and-cache-opportunities.md`: even on a fully warm, unchanged repo, most commands still pay for a full recursive directory scan before any cache or manifest logic gets a chance to short-circuit. Priority 7 of that plan ("Persist a Ready-to-Load Project Index Snapshot") made graph reconstruction skippable once files are known unchanged, but it did not remove the discovery scan that determines "unchanged" in the first place. This plan closes that gap and fixes a related default-cache inconsistency across CLI commands.

It is self-contained so another agent can implement items without the original conversation. It complements, and in one place extends, `2026-06-06-performance-and-cache-opportunities.md`; see the cross-reference added there.

## Problem Statement

All findings below are evidence-backed against the current `main` tree.

### F1: `AgentSession` always re-scans the full tree, warm or not

`createAgentSession()` in `src/agent/session.ts` backs `search`, `orient`, `explore`, `explain`, `packet get`, `refactor-plan`, `rename-preview`, `callers`/`callees`, `supertypes`/`subtypes`, `workspace-symbols`, `file --include-graph-context`, `artifact build`, `sync`, and every MCP tool. Its `loadFiles()` (session.ts:193-201) unconditionally calls `listAgentSessionFiles()` -> `listProjectFiles()` (session.ts:104-106) on every `loadProject()` call that does not already have a cached promise for this process. That scanned list is then passed into `buildProjectIndexIncremental()` as `opts.files` (session.ts:209-221).

This is not accidental: it is the only mechanism that reliably surfaces brand-new, uncommitted, untracked files (see F6). But it means every agent-facing command pays full-tree discovery cost regardless of whether anything changed.

### F2: Discovery silently doubles as a second full tree walk

`listProjectFiles()` (`src/util/projectFiles.ts:322-379`) does the expected pattern-matching `fg()` walk, then unconditionally calls `listEntriesFromSafeSymlinkDirectories()` (`projectFiles.ts:381-446`), which runs a **second** full recursive walk (`fg(["**/*"], { onlyFiles: false, ... })`) to find symlinked directories. This runs even for projects with zero symlinks. Every discovery call pays for two tree walks, not one.

### F3: MCP freshness checks repeat the same full scan

`checkFreshness()` (session.ts:275-315), used when `freshness.policy` is `"check"` or `"auto"` (the MCP server's default per `src/mcp/server.ts:282`), calls `listProjectFiles()` again (session.ts:282) to diff against the cached baseline. Long-running MCP sessions pay the full F1/F2 cost on every freshness check, on top of the one paid at session creation.

### F4: `goto`, `refs`, `impact`, and default `graph`/`index` bypass the incremental path entirely

`src/cli/navigation.ts` (`goto`, `refs`, `dumpmod`) and `src/cli/impact.ts` build via `buildProjectIndex()` / `buildProjectIndexFromFiles()`, not `buildProjectIndexIncremental()`. `buildProjectIndexWithManifestOptions()` (`src/indexer/build-index.ts:783-810`) always runs `listProjectFiles()` + `discoverProjectFiles()` in parallel (line 789-797) with no manifest short-circuit — there is no "unchanged, skip discovery" branch on this path at all, only on `buildProjectIndexIncremental()`.

Worse, these commands never pass `--cache`, so `cache` defaults to `"off"` (`createIndexBuildRunState`, build-index.ts:420). `cacheEnabled` becomes `false`, disabling per-file parse-cache reuse (build-index.ts:427). Yet `buildProjectIndexWithManifestOptions()` still passes `manifestMode: "read-write"` unconditionally (build-index.ts:799), so a manifest is written on every run — and then never read back, because these commands do not call the one function (`buildProjectIndexIncremental`) that reads it. The manifest write cost is paid for no benefit on this code path.

Net effect: `codegraph goto`, `codegraph refs`, and `codegraph impact` fully rediscover and fully reparse the project on every single invocation, by construction, independent of any cache flag the user might think to pass.

### F5: The existing snapshot fast path is real but discovery-gated

Inside `buildProjectIndexIncremental()`, the "0 changed files" branch (build-index.ts:1039-1078) correctly skips graph reconstruction via `tryLoadProjectIndexSnapshot()`. This is Priority 7 from the prior plan and it works. But it only runs after `allFiles` has already been assembled from `opts.files` (the pre-scanned list from F1) unioned with manifest/git-diff data. The snapshot optimization saves graph-build time; it does not and cannot save discovery time, because discovery already happened one layer up.

### F6: No cheap way to detect new untracked files exists yet

`src/util/git.ts` has `listChangedFiles()`, which shells out to `git diff --name-only`. `git diff` never reports untracked files, by design, regardless of `--diff-filter`. There is no `git status`/`git ls-files --others` helper anywhere in the codebase. This absence is *why* F1's blanket full scan exists: it is currently the only reliable way to catch a file the user just created that is not yet committed or staged.

## Priority 1: Route `goto`/`refs`/`impact`/default `graph`/`index` Through the Incremental Path

Lowest risk, highest immediate value: reuse infrastructure that `search`/`orient`/`inspect`/`review`/`agent-tools` already exercise in production, instead of inventing anything new.

Why this matters:

- Fixes F4 directly. `buildProjectIndexIncremental()` already knows how to read the manifest these commands are currently writing and discarding.
- No new schema, no new git plumbing required for this step alone.

Implementation checklist:

- [ ] Change `src/cli/navigation.ts` (`goto`, `refs`, `dumpmod`) to call `buildProjectIndexIncremental()` instead of `buildProjectIndex()`.
- [ ] Change `src/cli/impact.ts`'s default (non-`--changed-since`) build to call `buildProjectIndexIncremental()`.
- [ ] Default `cache` to `"disk"` for these commands unless the user passes `--cache off`/`--cache memory`, matching `inspect`'s existing default (`src/cli/inspect.ts:271`).
- [ ] Audit `src/cli/graph.ts` and `src/cli/index.ts` non-incremental branches (the `else` branch at `graph.ts:330` and the `full` branch in `index.ts:76-78`) for the same fix; keep `--changed-since`/`--git-base` behavior unchanged since those already use the incremental path.
- [ ] Confirm `dumpmod` (undocumented/internal) does not have a reason to want a forced full rebuild; if it does, keep it on `buildProjectIndex()` explicitly with a comment explaining why.
- [ ] Add a regression test proving a second `goto`/`refs`/`impact` invocation against an unchanged repo reuses the manifest (spy on `listProjectFiles` call count, or assert `report.manifest.reused === true` when `--report` is used).
- [ ] Update `docs/cli.md` to remove the "Agent commands... default to disk cache" wording if plain navigation/impact commands now default to disk cache too; state the actual scope precisely instead of implying an intentional exclusion that no longer holds.

Likely files:

- `src/cli/navigation.ts`
- `src/cli/impact.ts`
- `src/cli/graph.ts`
- `src/cli/index.ts`
- `docs/cli.md`
- `tests/cli-command-modules.test.ts`
- `tests/navigation.test.ts` or equivalent
- `tests/impact-analyzer.test.ts`

Risks:

- `buildProjectIndexIncremental()` on a stale/mismatched manifest falls back to a full rebuild automatically (build-index.ts:889-897), so behavior should degrade gracefully; verify this with a test that mutates `codegraph.config.json` between runs and confirms a full rebuild still happens.
- Confirm no caller relies on `goto`/`refs`/`impact` ignoring on-disk cache state for correctness (e.g., deliberately avoiding any manifest interaction). Search history/tests before changing; if found, document why and scope the change narrower.

Validation:

- [ ] `npx vitest run tests/cli-command-modules.test.ts tests/impact-analyzer.test.ts`
- [ ] `node ./dist/cli.js goto <file> <line> <column>` timed twice back-to-back; second run should be markedly faster on this repo.
- [ ] `node ./dist/cli.js impact --base HEAD --head WORKTREE --json` timed twice back-to-back.

## Priority 2: Cheap Git-Status Reconciliation for `AgentSession` Discovery

Addresses F1 and F6 for the majority git-repo case, without regressing correctness for untracked files.

Why this matters:

- This is the actual fix for "expensive full recursive directory scan before every command" for the whole agent/MCP surface, not just the four commands in Priority 1.
- `git status`/`git ls-files --others` is native, typically far cheaper than a JS `fast-glob` + `picomatch` walk against every ignore/include pattern, and git already tracks its own working-tree state.

Implementation checklist:

- [ ] Add a `listGitWorkingTreeStatus()` helper to `src/util/git.ts` combining `git diff --name-only --diff-filter=ACDMRTUXB <lastCommit>` (modified/deleted tracked files since the manifest's `lastCommit`) with `git ls-files --others --exclude-standard -z` (new untracked files), returning added/modified/deleted sets.
- [ ] In `AgentSession.loadFiles()` (session.ts), add a fast path: when `gitAvailable`, a valid manifest exists, discovery config is unchanged since the manifest was written, and `--cache-strict` is not set, reconcile `trackedEntries.keys()` with the git-status delta instead of calling `listProjectFiles()`.
- [ ] Apply codegraph's own include/ignore glob filtering only to the (small) delta set of newly-added/untracked paths, not to the full baseline (the baseline was already filtered when it entered the manifest).
- [ ] Fall back to the current full `listProjectFiles()` scan when: no git repo, no manifest yet, discovery options changed, the git command fails for any reason, or `--cache-strict` is set.
- [ ] Keep `discoverFiles()` (the public `AgentSession.discoverFiles` method some callers use for an always-fresh list) on the full-scan path unchanged, since its contract is "authoritative fresh list," not "fast path."
- [ ] Add tests: new untracked file appears in next session load without a full scan; deleted tracked file disappears; renamed file handled as delete+add; non-git project still works via full-scan fallback; discovery-config change forces full-scan fallback.

Likely files:

- `src/util/git.ts`
- `src/agent/session.ts`
- `tests/agent-session.test.ts`
- `tests/cache-invalidation.test.ts`
- New or extended `tests/util-git.test.ts`

Risks:

- Git worktrees, submodules, and sparse checkouts need explicit test coverage; do not assume `git status` behaves identically to a plain repo in these configurations.
- `git status`/`git ls-files` still walks the working tree internally in the worst case (no fsmonitor); benchmark before assuming a guaranteed win on very large repos, and keep the fallback path correct regardless of the performance delta.
- A file rewritten with git-invisible changes (e.g., content changed but `git diff` sees it as clean due to a race, or `.git` metadata corruption) must not silently go stale; keep `--cache-verify` as an explicit escape hatch that always forces the full path.

Validation:

- [ ] `npx vitest run tests/agent-session.test.ts tests/cache-invalidation.test.ts`
- [ ] Manual timing: `node ./dist/cli.js orient --root . --budget small --json` twice, unchanged repo, before/after.
- [ ] Manual correctness check: create an untracked file, run `search`/`orient`, confirm it is found without `--changed-since`.

## Priority 3: Skip the Symlink-Directory Walk When There Are No Symlinks

Small, safe, and independent of Priority 1/2 — ship first if sequencing matters.

Why this matters:

- Fixes F2. Most projects have zero symlinked directories under the project root, yet pay for a second full `fg(["**/*"], { onlyFiles: false })` walk on every single `listProjectFiles()` call.

Implementation checklist:

- [ ] Record a `hasSymlinkDirectories: boolean` flag in the manifest (or project-index snapshot) the next time a full scan runs and actually enumerates entries.
- [ ] In `listProjectFiles()`, skip `listEntriesFromSafeSymlinkDirectories()` when the flag is known `false`; run it (and refresh the flag) when the flag is `true` or unknown (first run, or manifest absent).
- [ ] Per `AGENTS.md`'s persistent-storage-schema rule: this is a manifest schema change, so add a migration/backfill path for existing on-disk manifests missing the field (treat missing as "unknown", i.e. run the walk once to populate it) and a regression test loading an old-schema manifest.
- [ ] Add a test proving a project with a symlinked directory still gets that directory's files, both on first scan and after the flag is cached `true`.

Likely files:

- `src/util/projectFiles.ts`
- `src/indexer/build-cache/manifest.ts`
- `tests/project-files.test.ts` or equivalent
- `tests/cache-invalidation.test.ts` (schema migration case)

Validation:

- [ ] `npx vitest run tests/cache-invalidation.test.ts` plus the project-files symlink tests.
- [ ] Confirm a project with an intentional symlinked source directory still indexes those files correctly, cold and warm.

## Priority 4: Make Freshness Checks Reuse the Cheap Path

Why this matters:

- Fixes F3. Once Priority 2 exists, `checkFreshness()` should use the same git-status reconciliation instead of an independent `listProjectFiles()` call, so long-running MCP servers do not pay full-scan cost on every freshness check.

Implementation checklist:

- [ ] Reuse the Priority 2 helper inside `checkFreshness()` (session.ts:275-315) instead of calling `listProjectFiles()` directly.
- [ ] Keep the existing size/mtime signature diff logic (`collectAgentFileSignatures`/`diffAgentFileSignatures`) for files identified by the reconciliation as candidates; do not stat every file in the repo, only the delta plus previously-known files needed for byte-count budgeting.
- [ ] Preserve `policy: "manual"` (skip check) and the `maxAutoRefreshFiles`/`maxAutoRefreshBytes` auto-refresh gates unchanged.

Likely files:

- `src/agent/session.ts`
- `tests/mcp-server.test.ts`
- `tests/agent-session.test.ts`

Validation:

- [ ] `npx vitest run tests/mcp-server.test.ts tests/agent-session.test.ts`
- [ ] Long-running MCP session smoke test: several tool calls with `freshness.policy: "auto"` against an unchanged repo; confirm no full scan per call (spy count).

## Priority 5 (Stretch): Directory-Mtime Fallback Discovery for Non-Git Projects

Not scoped for immediate implementation; recorded so it is not lost.

Why this matters:

- Priority 2 only helps git repos. Non-git projects (or git repos with `--cache-strict` forced) still pay full discovery every time.
- Most filesystems update a directory's mtime when an entry is added, removed, or renamed directly inside it (not on content changes to existing files). A manifest that records each directory's mtime can skip re-globbing subtrees whose mtime has not moved, without needing git at all.

Notes for whoever picks this up:

- Known caveats to design around explicitly: some network/cloud-sync filesystems and certain overlay/bind mounts do not reliably update directory mtimes; this must have a documented, tested fallback (periodic full-rescan interval, or `--cache-verify` forcing it).
- This is a larger manifest-schema change than Priority 3's single boolean; plan explicit schema versioning per `AGENTS.md`, with a migration test starting from the current schema.
- Do not start this until Priority 2 ships and its real-world hit rate is known; git-status reconciliation may cover enough of the practical caseload that this stretch item stops being worth the complexity.

## Correctness and Schema Notes

- Priorities 3 and 5 both touch persistent manifest state. Per `AGENTS.md`, any schema change needs an explicit migration/backfill path and a regression test that starts from the older schema, not just `CREATE TABLE IF NOT EXISTS` or an added-but-unvalidated JSON field.
- Priority 2's git-status fast path must never silently under-report changes. Keep `--cache-verify` as an unconditional trapdoor back to the full scan, and keep the existing manifest-mismatch / config-hash / graph-options-mismatch full-rebuild triggers untouched.
- `docs/cli.md` and `codegraph-skill/codegraph/SKILL.md` both currently assert "every command that starts by loading the project index... default[s] to disk cache" or similar. Priority 1 makes that statement true for `goto`/`refs`/`impact`; until then, update the docs to describe the actual, narrower current behavior rather than leaving an inaccurate blanket claim in place.

## Other Opportunities Observed (Not Scoped Into a Priority Above)

Noted during this investigation; each needs its own scoping/benchmark before becoming a priority.

- **`getGitBlobHashes()` still reads every tracked file's content on every incremental run** (`src/util/git.ts:113-182`, via `git hash-object --stdin-paths`). It is native and batched (Priority 8 from the prior plan is accurate about that), but it is still O(files) content reads per run. A stat-based pre-filter (compare mtime/size against the git index before falling back to `hash-object` for files that look unchanged) could shrink this further on large repos — worth a benchmark before committing to it.
- **`checkFreshness()`'s `"check"` policy is mtime+size only, not content-hash.** A file rewritten with identical size and mtime (e.g. via `touch -r` after an external tool restores content) would not be detected as stale. This is a reasonable tradeoff for a fast check, but should be called out explicitly in `docs/mcp.md`/`docs/agent-workflows.md` as a known limitation rather than left implicit.
- **No visibility into which cache tier actually served a given run.** Add a field to `--report`/`status --json` (or a new `doctor` line) showing whether a run used the git-status fast path, the full scan, or the project-index snapshot skip. This would make future "why is this still slow" reports self-diagnosing instead of requiring code archaeology like this investigation.
- **`buildProjectIndexWithManifestOptions()` runs `listProjectFiles()` and `discoverProjectFiles()` as two independent tree walks in parallel** (build-index.ts:789-797). `discoverProjectFiles()` matches a narrow lockfile/manifest pattern set, so it is likely cheap relative to the main walk, but this has not been measured. Worth a quick benchmark before assuming it needs its own fix; if it is cheap, leave it alone rather than adding complexity for no measured win.
- **Close out the two unchecked validation items in Priority 7 of `2026-06-06-performance-and-cache-opportunities.md`** (warm-cache parity test, before/after `orient` timing) while working in this area, since they are directly adjacent and currently unverified despite the rest of that priority being marked complete.

## Suggested Execution Order

- [ ] Priority 3 first: smallest, safest, no cross-cutting risk, immediately reduces every discovery call's cost by roughly half.
- [ ] Priority 1 next: reuses existing, already-tested incremental infrastructure; fixes the most visibly broken commands (`goto`, `refs`, `impact` never benefiting from their own manifest writes).
- [ ] Priority 2 after Priority 1 lands and its tests are stable: the higher-effort, higher-payoff git-status fast path, now benefiting all commands including the ones just fixed in Priority 1.
- [ ] Priority 4 immediately follows Priority 2, since it is a small reuse of the same helper.
- [ ] Priority 5 only if Priority 2's real-world coverage (git-repo share of usage) leaves a meaningful non-git gap.

## Validation Checklist

- [ ] `npx vitest run tests/agent-session.test.ts tests/mcp-server.test.ts tests/cache-invalidation.test.ts`
- [ ] `npx vitest run tests/cli-command-modules.test.ts tests/impact-analyzer.test.ts`
- [ ] `node ./dist/cli.js doctor`
- [ ] `node ./dist/cli.js orient --root . --budget small --json` (timed, warm, before/after)
- [ ] `node ./dist/cli.js goto <file> <line> <column>` (timed, warm, before/after)
- [ ] `node ./dist/cli.js impact --base HEAD --head WORKTREE --json` (timed, warm, before/after)
- [ ] `npm run check` before concluding major work
