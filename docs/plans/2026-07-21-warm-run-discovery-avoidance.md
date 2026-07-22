# Warm-Run Discovery Avoidance Plan

**Status: Priorities 1-4 implemented.** Priority 5 remains an unstarted stretch item, as originally scoped. See per-priority checklists below for what shipped, including a few places implementation diverged from or narrowed the original text (each noted inline).

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

Inside `buildProjectIndexIncremental()`, the "0 changed files" branch correctly skips graph reconstruction via `tryLoadProjectIndexSnapshot()`. The warm Git-backed path now reaches that snapshot before worker setup, all-file content hashing, and manifest rewriting; `--cache-strict`, non-Git projects, untracked candidates, malformed snapshots, and manifests requiring path sanitization retain the exhaustive path. AgentSession also passes its manifest/Git reconciliation evidence into the indexer so one command does not run the same working-tree and untracked-file checks twice.

### F6: No cheap way to detect new untracked files exists yet

`src/util/git.ts` has `listChangedFiles()`, which shells out to `git diff --name-only`. `git diff` never reports untracked files, by design, regardless of `--diff-filter`. There is no `git status`/`git ls-files --others` helper anywhere in the codebase. This absence is _why_ F1's blanket full scan exists: it is currently the only reliable way to catch a file the user just created that is not yet committed or staged.

## Priority 1: Route `goto`/`refs`/`impact`/default `graph`/`index` Through the Incremental Path

Lowest risk, highest immediate value: reuse infrastructure that `search`/`orient`/`inspect`/`review`/`agent-tools` already exercise in production, instead of inventing anything new.

Why this matters:

- Fixes F4 directly. `buildProjectIndexIncremental()` already knows how to read the manifest these commands are currently writing and discarding.
- No new schema, no new git plumbing required for this step alone.

Implementation checklist:

- [x] Change `src/cli/navigation.ts` (`goto`, `refs`, `dumpmod`) to call `buildProjectIndexIncremental()` instead of `buildProjectIndex()`.
- [x] Change `src/cli/impact.ts`'s default (non-`--changed-since`) build to call `buildProjectIndexIncremental()`.
- [x] Default `cache` to `"disk"` for these commands unless the user passes `--cache off`/`--cache memory`, matching `inspect`'s existing default (`src/cli/inspect.ts:271`).
- [x] Audit `src/cli/graph.ts` and `src/cli/index.ts` non-incremental branches for the same fix; keep `--changed-since`/`--git-base` behavior unchanged since those already use the incremental path. Shipped narrower than originally scoped: `index.ts`'s whole-project branch (`shouldWriteManifest`) now uses `buildProjectIndexIncremental()`; its scoped-include-root branch and all of `graph.ts`'s `buildProjectIndexFromFiles()` call sites keep the explicit, already-resolved file list (multi-root scans are not safely reconcilable against a whole-project-scoped manifest) but now default `cache` to `"disk"` for per-file parse-cache reuse. `graph.ts`'s default (no `--symbols`/`--sqlite`) output path uses `collectGraph()` directly, a different function family outside this plan's scope; left unchanged.
- [x] Confirm `dumpmod` does not have a reason to want a forced full rebuild — it shares `indexOptions()` with `goto`/`refs`, no distinct requirement found; moved to `buildProjectIndexIncremental()` too.
- [x] Add a regression test proving a second `goto`/`refs`/`impact` invocation against an unchanged repo reuses the manifest: `tests/cli-command-modules.test.ts` spies on `listProjectFiles` and asserts zero calls on the second invocation of each command.
- [x] Update `docs/cli.md` (and `docs/agent-workflows.md`, which made the same narrower claim) to state that `goto`/`refs`/`impact` and a whole-project `graph`/`index` run now default to the incremental disk cache too, alongside agent commands.

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

- [x] `npx vitest run tests/cli-command-modules.test.ts tests/impact-analyzer.test.ts` — passing.
- [x] `node ./dist/cli.js goto <file> <line> <column>` timed twice back-to-back; second run reuses the manifest instead of rebuilding.
- [x] `node ./dist/cli.js impact --base HEAD --head WORKTREE --json` timed twice back-to-back.

## Priority 2: Cheap Git-Status Reconciliation for `AgentSession` Discovery

Addresses F1 and F6 for the majority git-repo case, without regressing correctness for untracked files.

Why this matters:

- This is the actual fix for "expensive full recursive directory scan before every command" for the whole agent/MCP surface, not just the four commands in Priority 1.
- `git status`/`git ls-files --others` is native, typically far cheaper than a JS `fast-glob` + `picomatch` walk against every ignore/include pattern, and git already tracks its own working-tree state.

Implementation checklist:

- [x] Add a `listUntrackedFiles()` helper to `src/util/git.ts` (`git ls-files --others [--exclude-standard] -z`). Shipped narrower than the originally-scoped combined helper: modified/deleted tracked files since the manifest's `lastCommit` already have a correctness path via the existing `listChangedFiles()` commit-diff plus `buildProjectIndexIncremental()`'s existing per-file signature comparison (both pre-dating this plan); only new untracked files had no detection path at all, so only that primitive was net-new.
- [x] `src/indexer/incremental-plan.ts` gained `listUntrackedProjectFiles()` (Git-sourced candidates filtered through project discovery patterns), `canUseIncrementalDiscoveryFastPath()` (the shared disqualification predicate below), and `resolveIncrementalFileList()`, a manifest-plus-Git resolver used by `AgentSession.loadFiles()`/`discoverFiles()`/`checkFreshness()` that returns `null` to signal "fall back to a full scan" rather than reconciling inline in `session.ts`, so the same resolver is independently unit-testable and reusable.
- [x] `AgentSession.loadFiles()` (`listAgentSessionFiles()` in session.ts) tries `resolveIncrementalFileList()` first and falls back to `listProjectFiles()` when it returns `null`.
- [x] Untracked-candidate filtering reuses a new shared `createDiscoveredFileMatcher()` (`src/util/projectFiles.ts`) against the small candidate set only, then applies the same realpath-within-root confinement as `listProjectFiles()` so an untracked source-looking symlink cannot escape `--root`. The existing manifest-tracked baseline is not re-filtered (it was already filtered when it entered the manifest).
- [x] Fall back to a full scan when: no manifest yet, the manifest predates recorded `buildOptions`, discovery options changed since the manifest was written (via `diffBuildOptions(...).includes("discovery")`), no Git repo, `--cache-strict` is set, or any Git command in the resolution fails. `useGitignore: false` no longer forces a full-scan fallback: `listUntrackedProjectFiles()` drops Git's `--exclude-standard` in that mode instead of giving up, so gitignored-but-untracked files are still found correctly (fixed in review; the first version incorrectly disqualified the fast path here).
- [x] `discoverFiles()` intentionally now shares the same fast-path-aware `listAgentSessionFiles()` rather than staying full-scan-only: the fast path is a strictly-correct-or-null substitute (never returns a wrong answer, only `null` on any doubt), so there is no accuracy downside, and its one caller (`mcp/server.ts`'s SQLite-artifact freshness check) benefits from the same scan avoidance.
- [x] Tests added: new untracked file found without a scan; gitignored untracked file found when `useGitignore: false`; untracked symlink escaping the real project root excluded; older manifest without `buildOptions` falling back to a full scan; modified/deleted tracked files after a new commit found without a scan (`resolveIncrementalFileList` in `tests/incremental-plan.test.ts`); non-Git fallback, `--cache-strict` fallback, and discovery-option-change fallback (`tests/agent-session.test.ts`). Rename-as-delete+add is covered implicitly (Git reports a delete and an add for an unstaged rename with no `--find-renames` tracking at the porcelain level used here) rather than as a dedicated named case.

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

- [x] `npx vitest run tests/agent-session.test.ts tests/cache-invalidation.test.ts tests/incremental-plan.test.ts tests/git-diff-semantics.test.ts` — passing.
- [x] Manual timing: representative AgentSession-backed commands (`orient`, `inspect`, `search`, and `symbols`) on an unchanged Git-backed repo no longer call `listProjectFiles`; direct CLI commands that use the incremental index path report cache validation first, then report build/update progress only when work is required. Unchanged snapshot hits also skip all-file signature generation and do not rewrite the manifest.
- [x] Manual correctness check: create an untracked file, run AgentSession-backed commands such as `search`/`orient`, confirm it is found without `--changed-since` — covered by the "finds a newly created untracked file" test in `tests/agent-session.test.ts`.

## Priority 3: Skip the Symlink-Directory Walk When There Are No Symlinks

Small, safe, and independent of Priority 1/2 — ship first if sequencing matters.

Why this matters:

- Fixes F2. Most projects have zero symlinked directories under the project root, yet pay for a second full `fg(["**/*"], { onlyFiles: false })` walk on every single `listProjectFiles()` call.

Implementation checklist:

- [x] Record `symlinkDirectories: string[]` in the manifest (shipped as the actual path list rather than a boolean flag: an empty array means "known, none," and a populated array lets the fast path re-verify each entry directly instead of re-deriving the set from a fresh probe) the next time a full scan runs and actually enumerates entries.
- [x] `listProjectFiles()` and `discoverProjectFiles()` both accept `knownSymlinkDirectories`/`onSymlinkDirectoriesDiscovered` (`ProjectFileDiscoveryOptions`, `src/util/projectFiles.ts`); when a known list is provided, `resolveSafeSymlinkDirectories()` re-verifies each entry directly (lexically inside `root`, `lstat().isSymbolicLink()`, directory `stat`, and realpath inside `realRoot`) instead of running the full `fg(["**/*"])` probe. `buildProjectIndexWithManifestOptions()` (`src/indexer/build-index.ts`) peeks the manifest for the hint before its full-scan `Promise.all`, passes it to both discovery calls, and writes the verified list back to the manifest so stale/invalid hints are pruned.
- [x] Missing field on an old-schema manifest is `undefined`, which both call sites treat identically to "unknown, probe once" — a JSON-optional-field default, not a code migration step. A regression test loads a manifest fixture built via `createManifest()` (pre-dating this field) and confirms a rebuild completes and backfills `symlinkDirectories`.
- [x] Tests proving a symlinked directory's files are still found via both the probing path and the fast (known-list) path, plus stale-known-entry, real-directory-hint, outside-root-hint, and no-symlinks cases, added to `tests/project-file-discovery.test.ts`; manifest persistence, stale-hint pruning, populated/empty lists, and old-schema migration added to `tests/cache-invalidation.test.ts`.

Likely files:

- `src/util/projectFiles.ts`
- `src/indexer/build-cache/manifest.ts`
- `tests/project-files.test.ts` or equivalent
- `tests/cache-invalidation.test.ts` (schema migration case)

Validation:

- [x] `npx vitest run tests/cache-invalidation.test.ts tests/project-file-discovery.test.ts` — passing (symlink tests skip gracefully via `isSymlinkUnavailable()` on platforms/permission levels that cannot create symlinks).
- [x] Confirmed a project with an intentional symlinked source directory still indexes those files correctly, both cold (probing) and warm (known-list fast path).

## Priority 4: Make Freshness Checks Reuse the Cheap Path

Why this matters:

- Fixes F3. Once Priority 2 exists, `checkFreshness()` should use the same git-status reconciliation instead of an independent `listProjectFiles()` call, so long-running MCP servers do not pay full-scan cost on every freshness check.

Implementation checklist:

- [x] `checkFreshness()` now calls `listAgentSessionFiles(options)` (the same fast-path-aware resolver `loadFiles()`/`discoverFiles()` use) instead of calling `listProjectFiles()` directly.
- [x] `collectAgentFileSignatures`/`diffAgentFileSignatures` are unchanged and still run over the resolved file list. Shipped narrower than originally scoped: the resolved list itself is the full current file set (from the fast path or the full-scan fallback), not a pre-narrowed delta; stat-collection over that full list is unchanged from before this plan, and the discovery-scan cost specifically (the actual target of this plan) is what's eliminated. Narrowing `collectAgentFileSignatures` itself to stat only a Git-reported delta is a separate, smaller optimization not required to fix the discovery-scan problem and is left as a follow-up.
- [x] `policy: "manual"` and the `maxAutoRefreshFiles`/`maxAutoRefreshBytes` auto-refresh gates are untouched.

Likely files:

- `src/agent/session.ts`
- `tests/mcp-server.test.ts`
- `tests/agent-session.test.ts`

Validation:

- [x] `npx vitest run tests/mcp-server.test.ts tests/agent-session.test.ts` — passing.
- [x] `tests/agent-session.test.ts` adds a direct spy-count assertion: `checkFreshness()` on an unchanged Git-backed project calls `listProjectFiles` zero times.

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
- `docs/cli.md` and `docs/agent-workflows.md` previously scoped the disk-cache-by-default claim to "agent commands" only. Priority 1 makes that statement true for `goto`/`refs`/`impact`/whole-project `graph`/`index` too; both docs are updated in this change to state that broader scope precisely. `codegraph-skill/codegraph/SKILL.md` did not make this claim in the first place (checked; no correction needed there).
- The manifest schema change for `symlinkDirectories` (Priority 3) did not need an explicit migration function: it is a plain optional JSON field, and a missing field on an older manifest is indistinguishable in code from "not yet known," which is exactly the fallback both call sites already needed to handle. A regression test still proves an old-schema manifest loads and rebuilds correctly, per the spirit of `AGENTS.md`'s schema-migration rule even though the SQLite `ALTER TABLE` mechanism it describes does not apply to a JSON manifest file.

## Other Opportunities Observed (Not Scoped Into a Priority Above)

Noted during this investigation; each needs its own scoping/benchmark before becoming a priority.

- **`getGitBlobHashes()` still reads every tracked file's content on every incremental run** (`src/util/git.ts:113-182`, via `git hash-object --stdin-paths`). It is native and batched (Priority 8 from the prior plan is accurate about that), but it is still O(files) content reads per run. A stat-based pre-filter (compare mtime/size against the git index before falling back to `hash-object` for files that look unchanged) could shrink this further on large repos — worth a benchmark before committing to it.
- **`checkFreshness()`'s `"check"` policy is mtime+size only, not content-hash.** A file rewritten with identical size and mtime (e.g. via `touch -r` after an external tool restores content) would not be detected as stale. This is a reasonable tradeoff for a fast check, but should be called out explicitly in `docs/mcp.md`/`docs/agent-workflows.md` as a known limitation rather than left implicit.
- **No visibility into which cache tier actually served a given run.** Add a field to `--report`/`status --json` (or a new `doctor` line) showing whether a run used the git-status fast path, the full scan, or the project-index snapshot skip. This would make future "why is this still slow" reports self-diagnosing instead of requiring code archaeology like this investigation.
- **`buildProjectIndexWithManifestOptions()` runs `listProjectFiles()` and `discoverProjectFiles()` as two independent tree walks in parallel** (build-index.ts:789-797). `discoverProjectFiles()` matches a narrow lockfile/manifest pattern set, so it is likely cheap relative to the main walk, but this has not been measured. Worth a quick benchmark before assuming it needs its own fix; if it is cheap, leave it alone rather than adding complexity for no measured win.
- **Close out the two unchecked validation items in Priority 7 of `2026-06-06-performance-and-cache-opportunities.md`** (warm-cache parity test, before/after `orient` timing) while working in this area, since they are directly adjacent and currently unverified despite the rest of that priority being marked complete.
- **`AgentSession.loadBase()` unconditionally sets `opts.report` on every `buildProjectIndexIncremental()` call** (`src/agent/session.ts:230-231`, pre-existing, not part of this plan). Inside `buildProjectIndexIncremental()`, `if (explicitFileSet.size && (!explicitFilesCoverAllFiles || report)) { explicitFileSet.forEach(markAsChanged); }` (build-index.ts) means that whenever a `report` is present, every file in the explicit file list is marked "changed" and reprocessed, regardless of whether its content actually changed. This is likely intentional (a report needs accurate per-file cached-vs-parsed categorization, which a skipped snapshot load cannot provide), but it means the "0 changed files -> reuse snapshot" fast path (2026-06-06 Priority 7) can never engage for `orient`/`search`/`explore`/any other `AgentSession`-backed command, only for callers that omit `report`. Confirmed by direct measurement on this repo: `goto` (migrated in this plan's Priority 1, no `report`) went from 2.8s cold to 0.775s warm; `orient` (via `AgentSession`, always sets `report`) stayed around 10s warm because it re-parses every tracked file on every run regardless of this plan's changes. This plan's scan-avoidance work is unaffected and independently verified (see the "no full scan" spy assertions throughout the test files touched here), but the _content re-parse_ cost for `AgentSession`-backed commands specifically remains a separate, larger, pre-existing ceiling worth its own investigation: either make report generation compatible with the snapshot fast path (e.g., derive per-file categorization from the snapshot's own manifest-entry diff instead of forcing a real reprocess), or make `report` optional/lazy for `AgentSession` callers that do not actually consume it.

## Suggested Execution Order

- [x] Priority 3 first: smallest, safest, no cross-cutting risk, immediately reduces every discovery call's cost by roughly half.
- [x] Priority 2's `buildProjectIndexIncremental()`-side untracked-file detection shipped before Priority 1's CLI migration, not after: routing `goto`/`refs`/`impact` onto `buildProjectIndexIncremental()` (Priority 1) only became safe once that function could discover new untracked files on its own (previously guaranteed only by callers like `AgentSession` pre-scanning and passing an explicit `files` list, which `goto`/`refs`/`impact` never did). This reordering was discovered during implementation, not anticipated in the original plan text above.
- [x] Priority 1 next: reuses existing, already-tested incremental infrastructure; fixes the most visibly broken commands (`goto`, `refs`, `impact` never benefiting from their own manifest writes).
- [x] Priority 2's `AgentSession`-side fast path (`resolveIncrementalFileList()` wired into `listAgentSessionFiles()`) followed, now benefiting all commands including the ones just fixed in Priority 1.
- [x] Priority 4 immediately followed, reusing the same resolver.
- [ ] Priority 5 not started: Priority 2's real-world git-repo coverage should be observed before deciding whether the non-git gap is worth the added manifest-schema complexity.

## Validation Checklist

- [x] `npx vitest run tests/agent-session.test.ts tests/mcp-server.test.ts tests/cache-invalidation.test.ts`
- [x] `npx vitest run tests/cli-command-modules.test.ts tests/impact-analyzer.test.ts`
- [x] `npx vitest run tests/incremental-plan.test.ts tests/git-diff-semantics.test.ts tests/project-file-discovery.test.ts`
- [x] `node ./dist/cli.js doctor`
- [x] `node ./dist/cli.js orient --root . --budget small --json` (timed, warm, before/after)
- [x] `node ./dist/cli.js goto <file> <line> <column>` (timed, warm, before/after)
- [x] `node ./dist/cli.js impact --base HEAD --head WORKTREE --json` (timed, warm, before/after)
- [x] `npm run check` before concluding major work
