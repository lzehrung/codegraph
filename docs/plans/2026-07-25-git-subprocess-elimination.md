# Git subprocess elimination on warm agent paths

Status: Planned. Measurements verified on `main` at `3024ed2b` (`v1.8.100`) on 2026-07-25 by
instrumenting `child_process` before importing `dist/cli.js`. See
[performance program index](2026-07-25-performance-program-index.md) for the shared baseline.

## Goal

Take warm, read-only agent commands on a clean tree from 6 or 7 git subprocesses to zero, fix a
latent correctness bug that silently disables git signatures on larger repositories, and stop
serializing independent probes.

## Non-goals

- No change to change-detection semantics. Git remains the authority on what changed; this plan
  changes only how often and how expensively we ask.
- No new caching layer with its own invalidation rules. Every memo here is scoped to one
  process, where the answer is provably invariant.

## Verified baseline defects

### F1: Warm read-only commands spawn 6 to 7 git processes

Measured by intercepting `execFile`, its `util.promisify.custom` variant, and `spawn`:

Warm `orient --root . --budget small --json`, 7 spawns in this order:

```
git diff --name-only --diff-filter=ACDMRTUXB --end-of-options ...
git ls-files --others -z --exclude-standard
git rev-parse --is-inside-work-tree
git ls-files -z -- <every project file>
git hash-object --stdin-paths
git rev-parse HEAD
git rev-parse --is-inside-work-tree          <- second time, same process
```

Warm `search`, 6 spawns: the same list without the trailing `rev-parse --is-inside-work-tree`.

Measured per-call latencies on this repository, 3 rounds: `rev-parse HEAD` 18 to 19 ms,
`rev-parse --is-inside-work-tree` 17 ms, `diff --name-only` 38 to 42 ms,
`ls-files --others` 25 to 32 ms, `hash-object --stdin-paths` 80 to 102 ms. Total serialized git
time is roughly 200 ms, against a 301 ms warm module load. Git is about a third of warm agent
command latency and, on a clean unchanged tree, none of it is necessary.

### F2: Any untracked file permanently disables the snapshot fast path

`src/indexer/build-index.ts:1165-1170`:

```
const canSkipFileValidation =
  gitAvailable &&
  !opts?.cacheStrict &&
  !untrackedFiles.length &&
  !additionalFiles.length &&
  !gitChangeCandidates.size;
```

`untrackedFiles` is a discovery signal, meaning new files exist, not a staleness signal. An
untracked file that was already indexed on a previous run changes nothing, yet it pins the build
off `reuseUnchangedSnapshot()` forever.

Measured on this repository: `git diff --name-only` returns zero files, `additionalFiles` is
empty, so `!untrackedFiles.length` is the only failing term, and it fails because of five
scratch files. The consequence is 3 extra git spawns plus a full 668-file signature validation
pass plus a manifest rewrite, on every warm command.

This condition is common in real use: build outputs, `.env` files, editor scratch files, and
local notes all trigger it.

### F3: `getGitBlobHashes` will silently break on larger repositories

`src/util/git.ts:129` spreads every file path into argv:

```
await execFileAsync("git", ["ls-files", "-z", "--", ...relFiles], { cwd: projectRoot, ... })
```

and the whole function is wrapped in `catch { return new Map(); }` at `src/util/git.ts:179-181`.

Windows caps a command line at 32,767 characters. Measured: with 1013 tracked paths the argv
string is 33,805 characters and `execFile` fails with `spawn ENAMETOOLONG`. The catch-all
swallows it and returns an empty Map, so `gitSig` is undefined for every file, and every file
falls back to full content hashing. Manifest `gitSig` reuse becomes permanently dead.

This repository is at 19,982 characters, about 61% of the limit, so the bug is latent here and
trips at roughly 1,100 files. It degrades silently: no error, just an unexplained O(repository)
slowdown past a size threshold.

Measured alternative: `git ls-files -z` with no path arguments returns in 1 ms.

### F4: Independent probes are strictly serialized

- `src/indexer/incremental-plan.ts:199-202` awaits `listChangedFiles`, then awaits
  `listUntrackedProjectFiles`.
- `src/indexer/build-index.ts:971` and `:1417` await `isGitRepo` before the diff work.
- `src/lifecycle/gitignore.ts:71-77` runs `isGitRepo`, then `isGitPathTracked`, then
  `isGitPathIgnored` twice: four sequential spawns.

Process creation dominates per-call cost on Windows, so serializing independent probes turns a
concurrent 40 ms into an additive 40 + 28 + 17 ms.

### F5: `isGitRepo` has no process-level memo

`src/util/git.ts:53-63` spawns `git rev-parse --is-inside-work-tree` on every call. Call sites:
`src/indexer/build-index.ts:548`, `:971`, `:1417`, `src/agent/orient.ts:162`, and
`src/lifecycle/gitignore.ts:71`.

In `orient` the second call exists only to pick a help string: the result flows to
`buildRecommendedNext(...)` at `src/agent/orient.ts:164` and is consumed at `:395` to decide
whether to append one suggested command. The indexer established the same fact milliseconds
earlier.

### F6: MCP re-runs git reconciliation on every tool call

`src/agent/session.ts:405` inside `checkFreshness` calls the free function
`listAgentSessionFiles`, not the session's memoized `loadFilePlan` (`src/agent/session.ts:231`).
MCP freshness policy is `auto` (`src/mcp/server.ts:284`), and `withFreshness`
(`src/mcp/server.ts:359-365`) wraps every handler.

Measured with an instrumented `child_process`, calling `handlers.search` three times: first call
6 git spawns and 32.1 s (cold), second 2 spawns and 1509 ms, third 2 spawns and 1411 ms. The two
recurring spawns are exactly `diff --name-only` and `ls-files --others`.

### F7: Duplicate diff computation in `impact` and `review`

- `src/impact/providers/base.ts:96` runs a `--shortstat` diff whose output is used only to build
  a warning string at `:101-103`, then `:108` spawns the real diff over the same range.
- `src/review/changes.ts:52` calls `listChangedFiles`, then `:71` calls `getUnifiedDiff` over the
  same base and head, and the diff is parsed at `:77` anyway.

Both make git walk the identical tree diff twice.

### F8: Dead code with a per-file spawn trap

`getGitBlobHash` (`src/util/git.ts:86`) spawns twice per single file, at `:98` and `:102`. It has
no caller in `src/` other than a re-export at `src/util.ts:10`, and one test reference.

## Priority 0: Restore the snapshot fast path -- IMPLEMENTED (`5dc3ecb7`)

Single highest-leverage change in the whole performance program, because it also skips most
warm-hydration validation on clean trees.

- [x] Change the `untrackedFiles` term at `src/indexer/build-index.ts` so only files that block
      genuine proof of freshness defeat the fast path. The naive form sketched during planning
      (`!untrackedFiles.some((file) => !Object.hasOwn(trackedEntries, file))`, "already in the
      manifest") turned out to be unsafe: Git has no diff history for untracked files, so mere
      presence in the manifest does not prove the file is still current the way a clean `git
diff` proves it for tracked files. The shipped fix instead does a single cheap `stat()`
      per already-known untracked file and compares `${mtimeMs}:${size}` against the prefix of
      the file's persisted `entry.sig` (format confirmed from the on-disk manifest: always
      `${mtimeMs}:${size}:${contentHash}`). Unseen files and stat-mismatched files still block
      the fast path exactly as before.
- [x] Left `additionalFiles` untouched. Per PR #164, transient/explicit files are intentionally
      forced through full validation every time -- that is by-design correctness for provenance
      tracking of files outside discovery, not the same discovery-versus-staleness confusion
      `untrackedFiles` had. Treating it the same way the plan originally proposed would have
      regressed that guarantee.
- [x] Added a regression: index a repository, create an untracked file, index again with nothing
      changed, and assert `getGitBlobHashes` (the cheapest reliable signal that the _early_
      fast-path branch specifically was skipped -- `tryLoadFromCache` and even `changedFiles`
      staying empty can be reached by a _different_, unrelated post-validation short-circuit that
      exists independently of this gate) is never called.
- [x] Added the safety-net regression the naive fix would have failed: modify an already-known
      untracked file's content and assert the change is still picked up on the next build.

Likely files: `src/indexer/build-index.ts`, `tests/cache-invalidation.test.ts`.

Acceptance:

- [x] With scratch files present and no tracked changes, a warm command takes the fast path.
      Measured end-to-end (not spawn-counted in isolation, since the fast path also skips the
      git-signature step targeted by Priority 2): warm `orient` on this repository with one
      routine untracked file went from ~905ms to ~734ms.
- [x] A new untracked source file is still indexed on the next run.

## Priority 1: Fix the argv limit and stop swallowing spawn errors -- IMPLEMENTED (PR #167)

- [x] Replace the path-argument form at `src/util/git.ts` with a plain `git ls-files -z` (no
      path arguments) and intersect the tracked set against the requested files in memory via
      a `Set`. Eliminates the ENAMETOOLONG failure mode at any repository size.
- [x] Stop returning an empty Map for every failure silently. The early `!gitAvailable` return
      stays a normal, unlogged empty result (the caller already knows there is no git repo);
      the `catch` block and the hash-count-mismatch branch now both call `logWithLevel` with
      `"warn"` severity before returning empty, so a genuine invocation failure is visible
      instead of silently degrading into full content hashing.
- [x] Added a regression using a padded subdirectory name (not just file count) to reliably
      cross the real ~32,767-character Windows argv limit at 700 files -- an earlier attempt
      with 1,300 short flat filenames stayed under the limit (~14,500 characters) and passed
      even without the fix, so it proved nothing. Confirmed against the actual failure: fails
      with `hashes.size === 0` on the pre-fix code, passes after.
- [x] Added a second regression forcing a genuine git invocation failure (a directory with no
      `.git` at all, `gitAvailable: true` passed anyway) and asserting `console.warn` fires.

Likely files: `src/util/git.ts`, `src/indexer/build-index.ts` (three call sites now thread
`opts?.logLevel` through), `tests/cache-invalidation.test.ts`.

Acceptance:

- [x] A synthetic repository above the argv threshold still produces git signatures for every
      file (verified at 700 files / ~36,300 argv characters under the old form).
- [x] A genuine git failure surfaces via `console.warn` rather than degrading silently.

## Priority 2: Memoize and parallelize

- [ ] Memoize `isGitRepo` per resolved root in `src/util/git.ts` with a
      `Map<string, Promise<boolean>>`. Git availability cannot change mid-process in any
      supported flow.
- [ ] Better still for `orient`: surface `gitAvailable` on the build report or snapshot and have
      `src/agent/orient.ts:162` read it instead of probing.
- [ ] Run `listChangedFiles` and `listUntrackedProjectFiles` concurrently in
      `src/indexer/incremental-plan.ts:199-202`.
- [ ] In `src/lifecycle/gitignore.ts:71-77`, run the tracked probe and both ignore probes
      concurrently after the single `isGitRepo`, or replace the two `check-ignore --quiet`
      spawns with one `git check-ignore --stdin -z`.

Acceptance:

- [ ] Warm `orient` spawns `rev-parse --is-inside-work-tree` at most once.
- [ ] The serial git chain on a warm command drops from roughly 200 ms to roughly 110 ms of
      critical path where git is still needed.

## Priority 3: Zero-git warm path

The structural win. On a warm cache with an unchanged working tree, `search`, `refs`, `goto`,
`deps`, `packet`, and `explore` are fully answerable from the manifest plus the project
snapshot. Git is used only as a change detector.

- [ ] Add a cheap pre-gate to `resolveIncrementalFilePlan`: if no manifest-tracked file has an
      mtime newer than `manifest.updatedAt`, return a "no changes" plan without invoking git.
- [ ] Route `checkFreshness` (`src/agent/session.ts:405`) through the session's memoized
      `loadFilePlan` so MCP tool calls stop re-reconciling.
- [ ] Consider debouncing MCP freshness so repeated tools within a short window reuse the last
      check.
- [ ] Ensure the pre-gate is conservative: any mtime newer than the manifest, any missing file,
      or any explicit `--cache-strict` falls through to the full git path.

Acceptance:

- [ ] Warm read-only agent commands on a clean tree spawn zero git processes.
- [ ] Editing a file still invalidates correctly on the next command, proven by an mtime-based
      regression.
- [ ] MCP second and subsequent tool calls spawn zero git processes when nothing changed.

## Priority 4: Remove duplicate diff work

- [ ] In `src/impact/providers/base.ts`, delete the `--shortstat` pre-flight at `:96` and
      compute insertions and deletions from the already-parsed streaming diff result, setting
      the warning afterward.
- [ ] In `src/review/changes.ts`, drop the `listChangedFiles` call at `:52` and derive changed
      files from `diff.files` parsed at `:77`, preserving the include and ignore filtering.
- [ ] Batch `git show <rev>:<file>` in `src/review/deleted.ts:183`, currently one spawn per
      deleted file serialized in the loop at `:210`, using `git cat-file --batch`.
- [ ] Delete `getGitBlobHash` (`src/util/git.ts:86`) and its re-export at `src/util.ts:10`, or
      mark it explicitly test-only if a test still needs it.

Acceptance:

- [ ] `impact --provider git` and `review` each run one tree diff per invocation.
- [ ] Deleted-file review content is fetched in one batch rather than one spawn per file.

## Validation checklist

### Focused automated checks

- [ ] `npx vitest run tests/cache-invalidation.test.ts tests/git-diff-semantics.test.ts`
- [ ] `npx vitest run tests/mcp-server.test.ts tests/agent-session.test.ts`
- [ ] `npx vitest run tests/review.test.ts tests/impact-analyzer.test.ts`
- [ ] A test that counts git subprocesses for a warm command on a clean tree and asserts zero.

### Measurement protocol

Instrument `child_process` as in the baseline and record, before and after each priority:

- [ ] Git spawn count and total git wall time for warm `orient` and warm `search`.
- [ ] Git spawn count for the second MCP tool call in a session.

### Repository qualification

- [ ] `node ./dist/cli.js doctor`
- [ ] `npm run check`

## Documentation

- [ ] `docs/how-it-works.md`: describe when git is consulted and when the mtime pre-gate skips
      it, so the freshness contract stays explicit.

## Success criteria

Git is consulted when something might have changed, once, concurrently where independent, and
never as a fixed tax on answering a question from a warm cache.
