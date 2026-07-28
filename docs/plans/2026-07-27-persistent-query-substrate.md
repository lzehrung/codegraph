# Persistent query substrate

Status: Implemented

Parent review: [Project improvement review](./2026-07-27-project-improvement-review.md)

## Vision

A warm Codegraph session should search a persistent index, not reread source files. The first query creates it beside the project snapshot. Later CLI and MCP calls reuse it, score candidates, and preserve deterministic results.

This extends warm project-index work. Without it, warm project loading still leaves `search`, `explore`, and agent packets scanning source or rebuilding normalized content in each process.

## User outcome

After implementation:

- the first search after an index-changing edit updates only changed files,
- a no-change CLI search opens the persistent sidecar and performs no repository-wide source reads,
- repeated MCP searches reuse prepared statements and in-memory result caches,
- CLI and MCP return the same ordered results for the same request and snapshot,
- cache corruption, unsupported schemas, writer contention, and path attacks fall back to a correct rebuild or in-memory search, never a wrong answer.

## Current measured baseline

Snapshot: `main` at `44de8b47` (`v1.8.103`), Windows 11, Node.js 24.15.0, 2026-07-27.

Five-run warm CLI samples on this repository:

| Mode   | Median |      Range | Approximate output |
| ------ | -----: | ---------: | -----------------: |
| hybrid |  2.98s | 2.97-3.03s |           11.5 KiB |
| symbol |  1.03s | 1.02-1.04s |           11.5 KiB |
| path   |  0.42s | 0.41-0.47s |            3.7 KiB |
| text   |  2.26s | 2.16-2.33s |            4.6 KiB |
| graph  |  0.86s | 0.86-0.87s |           11.5 KiB |

Three live MCP `search` calls took approximately 20.5s cold, then 1.14-1.18s warm, with about 26 KiB serialized output per call.

Runtime tracing showed:

- `orient` and `inspect` issue no git subprocesses on the measured warm path,
- hybrid and text search costs remain proportional to repository files,
- `src/agent/search.ts` reads snapshot files sequentially and prepares normalized file/chunk content in an in-memory `SearchCache`,
- a fresh CLI process cannot reuse that prepared content,
- MCP can reuse the in-memory cache only while its `AgentSession` remains alive.

Re-run this matrix before implementation. Store raw JSON timings under `Saved/` or an ignored temporary path; do not commit machine-specific timings as product claims.

## Existing architecture to preserve

Build on these existing boundaries; do not create a second indexing stack:

- `src/indexer/build-index.ts` creates `ProjectIndex.manifestEntries` from the same signatures used by the graph cache.
- `ProjectIndex.projectSnapshotIdentity` identifies an exact reusable project snapshot.
- `src/indexer/build-cache/project-snapshot.ts` already persists the graph/index snapshot and a versioned detailed-symbol-graph sidecar.
- `src/agent/session.ts` owns freshness checks, project reloads, and session-level caches.
- `src/agent/search.ts` owns query parsing, current matching, ranking, omissions, and response formatting.
- CLI `search` calls `searchCodegraph`, while MCP calls the same search contract through a persistent `AgentSession`.

Do not change search into a vector service. Do not create a daemon. Do not make search correctness depend on network access.

## Scope

### Included

- persistent normalized file and chunk content,
- substring-safe candidate retrieval,
- incremental per-file updates using current manifest identities,
- shared CLI/MCP query execution,
- sidecar schema/version handling,
- cache correctness and concurrency tests,
- query-stage telemetry in existing reports,
- performance and parity gates.

### Excluded

- embeddings or approximate nearest-neighbor search,
- natural-language model calls,
- cross-project global indexes,
- replacing symbol, graph, SQL, or navigation indexes,
- changing public search ranking as an optimization shortcut,
- background services or file watchers,
- storing results outside the configured `--root` cache boundary.

## Design decision: SQLite FTS5 trigram sidecar

When disk cache is enabled, add one derived sidecar under the existing cache root. For the default project-local cache, its path is `.codegraph-cache/index-v1/search-v1.sqlite`.

SQLite fits the existing artifacts, Node 22.16+ provides `node:sqlite`, transactions support safe incremental updates, and FTS5 trigram finds normalized substrings of at least three characters.

Probe `ENABLE_FTS5` and trigram support on the minimum Node version. If unavailable on a supported runtime, ship an explicit trigram-postings table in this schema. Do not claim the persistent index is active while falling back to a full source scan.

Queries shorter than three normalized characters use `instr(normalized_text, ?)` over sidecar rows. They may scan the sidecar, but they must not reread repository files.

## Sidecar schema

Use `PRAGMA user_version = 1` and a metadata table. All paths are normalized project-relative paths; never store absolute source paths in searchable rows.

```sql
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE files (
  file_id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  source_identity TEXT NOT NULL,
  surface TEXT NOT NULL,
  language TEXT,
  normalized_text TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  line_count INTEGER NOT NULL
) STRICT;

CREATE TABLE chunks (
  chunk_id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  UNIQUE(file_id, ordinal)
) STRICT;

CREATE VIRTUAL TABLE file_search USING fts5(
  normalized_text,
  content='files',
  content_rowid='file_id',
  tokenize='trigram'
);

CREATE VIRTUAL TABLE chunk_search USING fts5(
  normalized_text,
  content='chunks',
  content_rowid='chunk_id',
  tokenize='trigram'
);
```

Metadata keys:

- `schemaVersion`
- `projectSnapshotIdentity`
- `normalizerVersion`
- `chunkerVersion`
- `projectRootIdentity`
- `createdByCodegraphVersion`
- `updatedAt`

`normalizerVersion` and `chunkerVersion` are integer constants owned by the query-index module. Change them whenever matching normalization or chunk boundaries change.

The sidecar is derived but persistent. New schemas need an explicit migration, or a validated rebuild path and prior-schema regression fixture. Never write an unknown future schema.

## Source identity and incremental invalidation

Use `ProjectIndex.manifestEntries` as the file-content provenance. For each file, compute a stable source identity from the available `sig` and `gitSig` fields with an unambiguous versioned encoding.

```text
sourceIdentity = sha256("search-source-v1\0" + normalizedPath + "\0" + sig + "\0" + (gitSig ?? ""))
```

One warm-path gap remains: `tryLoadProjectIndexSnapshot` receives only `filesSignature`, so loaded `ProjectIndex` objects lack `manifestEntries`. Pass it the validated manifest-entry map used for `filesSignature`, then derive or verify the signature and attach sanitized entries to the loaded index. Keep the manifest as the source of truth; do not duplicate entries in `project-index-snapshot.json` or bump that schema.

Test that a fresh-process snapshot hit exposes the same path, `sig`, and `gitSig` entries as a live incremental build. Use its manifest entries for identity; do not read file metadata again before deciding whether files changed.

Update algorithm:

1. Open and validate the sidecar metadata and schema.
2. If `projectSnapshotIdentity`, normalizer version, and chunker version all match, return a read-ready store without reading source files.
3. Otherwise, compare current `ProjectIndex.manifestEntries` with `files.source_identity`.
4. Delete rows for paths absent from the current index.
5. Read, normalize, and rechunk only added or identity-changed paths.
6. Replace each changed file and its chunks within one transaction.
7. Update FTS rows and metadata only after all changed rows succeed.
8. Commit, then reopen or refresh read statements.

A graph-only snapshot change can change `projectSnapshotIdentity` without changing source identities. Update metadata without rebuilding text rows.

Current transient include-root files use their manifest identity. Delete retired transients from the sidecar when they leave `ProjectIndex.byFile`.

If `manifestEntries` is unavailable because cache is off or an older caller built `ProjectIndex` manually, use in-memory search and report `sidecarState: "unavailable"`. Do not invent weaker identities.

## Atomicity and concurrency

Multiple CLI processes and an MCP server may share one cache root.

Use these rules:

- SQLite WAL mode for readers during updates.
- Foreign keys on.
- A bounded busy timeout no longer than the existing command startup tolerance.
- `BEGIN IMMEDIATE` only around changed-row writes, not source reads or chunk preparation.
- Prepare all changed-file content before acquiring the write transaction.
- Recheck sidecar metadata after acquiring the writer lock; another process may already have completed the update.
- Commit all changed rows and metadata together.
- On `SQLITE_BUSY`, continue with a correct process-local prepared cache and report `sidecarState: "writer-busy"`; never block a user query indefinitely.
- On corruption, rename the sidecar to a bounded diagnostic name when safe, rebuild to a temporary file, fsync, and atomically replace it.
- On Windows, close all database handles before rename or replacement.

Keep at most one retained corrupt copy per cache identity. Cleanup must never follow symlinks or delete outside the fixed cache root.

## Query execution

### Candidate retrieval

Retain the current search-term parser and current scoring functions.

For each normalized term:

- length >= 3: query FTS5 trigram rows,
- length < 3: query `instr(normalized_text, ?)` with the same candidate cap,
- union candidates for the current `textCouldMatchNormalized` any-term semantics,
- verify each candidate with the current exact matcher before scoring.

FTS rank is never the public score. It selects candidates only; the existing deterministic matcher and ranker remain authoritative.

Fetch only rows needed for bounded scoring and formatting. Reject at file level before materializing every chunk where possible.

### Search modes

- `path`: continue using path candidates from the project index; the sidecar is unnecessary.
- `symbol`: continue using symbol lookup and current symbol scoring; sidecar may supply snippets only for final rows.
- `graph`: continue using graph neighborhoods; sidecar may supply text evidence only for selected files.
- `text`: use sidecar file/chunk candidates directly.
- `hybrid`: merge symbol, graph, path, and sidecar candidates before the existing final ranking and bounds.
- `sql`: preserve current SQL-object search; do not duplicate SQL facts into this sidecar in v1.

This mode split prevents the persistent text substrate from slowing already-fast path and graph searches.

### Snippets and source reads

Persist chunk text for matching and bounded snippets. For a whole-file match outside a chunk, use sidecar content or read only the final matched file after checking its manifest identity.

Store enough raw chunk text and line offsets to format current results without source reads. Preserve current binary, size, and sensitive-file exclusions.

### Result cache

Keep the existing session-level result cache above the sidecar. Its key must include:

- project snapshot identity,
- normalized query,
- mode,
- result limit,
- depth/from options,
- include-snippets flag,
- versions of the normalizer and ranking contract.

A sidecar update or refresh invalidates only results for the old snapshot. This top-level cache mainly benefits MCP, not one-shot CLI processes.

## Module boundaries

Add:

```text
src/agent/query-index/
  schema.ts
  paths.ts
  sourceIdentity.ts
  store.ts
  update.ts
  candidates.ts
  worker.ts
```

Responsibilities:

- `schema.ts`: version constants, SQL, payload validation, migrations.
- `paths.ts`: cache-root confinement and sidecar paths.
- `sourceIdentity.ts`: manifest-entry identity only.
- `store.ts`: database lifecycle and prepared statements.
- `update.ts`: diff, changed-file preparation, transactions, corruption recovery.
- `candidates.ts`: safe FTS query construction and bounded candidate retrieval.
- `worker.ts`: off-main-thread normalization/chunking and optional initial database build.

Keep public request/response types in `src/agent/search.ts` or their existing shared modules. The query-index directory is internal and must not become a second public API in the first PR.

## Worker strategy

Initial population can normalize hundreds of files and make many synchronous SQLite writes. Keep it off the MCP event loop.

- Use one worker for initial build or updates above a small measured changed-file threshold.
- Use the current process for no-change opens and tiny updates.
- Pass project-relative paths and bounded build options to the worker, not a serialized `ProjectIndex`.
- The parent validates paths against the project root before dispatch.
- The worker returns counts, timings, and final identity; it does not return source content.
- Bundle the worker into the published CLI and add a package test proving the bundled worker resolves.

Choose the threshold from benchmark evidence. Start with a constant, not an adaptive policy.

## AgentSession integration

Extend the session's loaded snapshot with an internal query-store handle. Lifecycle:

1. `loadProject` builds or loads the `ProjectIndex` as today.
2. First text/hybrid search calls `ensureQueryIndex(snapshot)` lazily.
3. No-change sessions open and validate the sidecar.
4. Changed sessions update it from current manifest provenance.
5. `checkFreshness` keeps current semantics; a stale snapshot never queries newer sidecar rows.
6. `refresh` closes statements tied to the old identity, loads the new snapshot, and lazily reopens or updates.
7. `clear` closes database handles and clears memory results.

Do not eagerly open the sidecar for commands that never search.

One-shot CLI search must use the same `AgentSession` path, not a separate `searchCodegraph` preparation path. If the exported convenience function needs a wrapper, it creates, uses, and disposes a session.

## Freshness invariant

A response may combine only artifacts that prove the same current project state.

Before returning a sidecar-backed response, verify:

- session snapshot identity is unchanged,
- sidecar metadata identity equals the loaded snapshot identity,
- each changed row transaction committed,
- freshness state still permits a response under current MCP rules.

If a file changes during preparation, the existing freshness check must mark or refresh the snapshot. Never mix old symbol results with new text rows.

## Observability

Extend internal analysis/report data with:

```ts
type QueryIndexDiagnostics = {
  sidecarState: "hit" | "created" | "updated" | "unavailable" | "writer-busy" | "rebuilt-corrupt";
  filesRead: number;
  filesAdded: number;
  filesUpdated: number;
  filesDeleted: number;
  fileCandidates: number;
  chunkCandidates: number;
  openMs: number;
  updateMs: number;
  candidateMs: number;
  scoringMs: number;
};
```

Expose this only through existing verbose/report diagnostics unless a reviewed public schema changes. Ordinary output stays unchanged.

Add a test-only file-read counter at the query-index boundary. Exact warm-hit tests must prove zero source reads; timing alone is not proof.

## Security and privacy

The sidecar contains normalized source and chunk text. Treat it as sensitive local derived data.

- Keep it under the existing project cache boundary.
- Respect `--root`, include roots, ignore globs, gitignore, sensitive-file filtering, and max-file-size limits.
- Normalize and realpath-check source paths before reads.
- Reject sidecar rows with absolute paths, traversal, NULs, or paths outside the loaded project.
- Never include environment variables, registry tokens, or source text in corruption filenames or logs.
- Use parameterized SQL exclusively.
- Escape FTS syntax in one tested helper; never concatenate user text into SQL.
- Keep `uninit` unchanged unless the product explicitly decides to remove cache state.

Document that local cache files can contain indexed source content.

## Schema evolution

Version 1 has no deployed predecessor, but implement the framework now:

1. read `PRAGMA user_version`,
2. reject future versions,
3. migrate known older versions transactionally,
4. rebuild only when a documented migration is impossible for derived data,
5. test an old-schema fixture for every v2+ change.

A normalizer or chunker mismatch is not a schema migration. It invalidates row content and triggers a bounded rebuild without changing the database contract.

## Performance targets

Measure cold, first-sidecar, warm-sidecar, one-file-change, deletion, and repeated-MCP cases. Record five CLI and ten in-process MCP samples after discarding one warmup.

Reviewed targets for this repository and workstation class:

- warm hybrid CLI p50 <= 1.2s and at least 2.5x faster than the recorded pre-implementation baseline,
- warm text CLI p50 <= 0.9s and at least 2.5x faster,
- warm symbol/path/graph modes regress by no more than 10% against the same-revision sidecar-disabled baseline,
- repeated warmed MCP search p50 <= 300ms and p95 <= 600ms,
- exact warm sidecar hit reads zero repository source files,
- one-file incremental update reads only that file plus files the current chunking contract requires,
- first-sidecar search regresses no more than 20% versus the current cold search,
- bounded response schemas, ranking, and omission counts remain equivalent.

Fresh-process startup and snapshot validation raised the hybrid target from 1.0s to 1.2s. Compact cross-word recovery within files admitted by the existing full-file prefilter raised the text target from 0.8s to 0.9s. Both retain the 2.5x goal without changing semantics or parity.

On Windows 11 with Node.js 24.15.0, five fresh CLI and ten warmed MCP samples on 2026-07-28 measured hybrid p50 at 1.189s (baseline 2.98s), text p50 at 0.863s (baseline 2.26s), and warmed MCP p50/p95 at 166/174ms.

The same-revision sidecar-disabled p50s were 0.961s symbol, 0.334s path, and 0.967s graph. With the sidecar, they were 0.964s, 0.337s, and 0.974s, within the regression target.

Absolute timings are environment-specific. CI should gate relative regressions and structural counters; local benchmarks may report absolute values with environment metadata.

## Correctness tests

### Candidate parity

Run the old full-scan matcher and new sidecar candidate path against the same snapshots and compare final responses for:

- hybrid, text, symbol, path, and graph modes,
- one-, two-, and three-character queries,
- punctuation and quoted text,
- Unicode normalization supported by current search,
- mixed code and documentation matches,
- no matches,
- maximum result limits and pagination/from behavior,
- snippets enabled and disabled.

Keep the old matcher as a rollout test oracle. Remove it from production after parity is proved.

### Invalidation

Cover:

- no-change exact identity,
- one added file,
- one modified tracked file,
- one untracked file,
- deleted tracked file,
- retired transient include-root file,
- changed config/include roots,
- changed normalizer/chunker version,
- graph identity change with unchanged source rows,
- cache off/memory mode,
- stale MCP snapshot and explicit refresh.

### Storage and migration

Cover:

- initial create,
- reopen in a fresh process,
- malformed metadata,
- unknown future user version,
- truncated/corrupt database,
- FTS table corruption,
- writer contention,
- Windows close-before-replace behavior,
- symlink/cache path escape,
- bounded corrupt-copy retention.

### Packaging

Cover:

- worker bundled in `dist/bin`,
- package metadata includes required runtime files,
- packed CLI search uses the sidecar,
- source checkout and published bin resolve the same cache path,
- minimum supported Node provides the required SQLite feature.

## Rollout sequence

### PR 1: measurement and schema probe

- add benchmark harness and file-read instrumentation,
- probe SQLite FTS5 trigram on supported CI runtimes,
- lock current search parity fixtures,
- make no behavior change.

Exit: repeatable baselines and a documented storage choice.

### PR 2: sidecar create and exact-hit read

- add schema/store/update modules,
- populate lazily on first text/hybrid search,
- reopen on a fresh CLI process,
- keep the full-scan matcher only as a guarded test comparison path.

Exit: exact warm hit performs zero source reads and parity suite passes.

### PR 3: incremental update and concurrency

- diff by `manifestEntries`,
- update added/changed/deleted/transient files,
- add worker threshold, WAL, busy fallback, and corruption recovery.

Exit: one-file changes stay bounded and concurrent CLI/MCP tests remain correct.

### PR 4: unify CLI and MCP path

- route one-shot CLI through the session/query-store lifecycle,
- retain MCP prepared statements and result cache,
- add diagnostics and bundle checks.

Exit: identical request/snapshot yields identical CLI and MCP ordering and metadata.

### PR 5: documentation and performance gate

- publish methodology and measured results,
- add relative performance checks,
- document local source cache sensitivity and cleanup.

Exit: targets are met on the baseline repository and no existing mode regresses beyond thresholds.

## Documentation updates

When implementation lands, update:

- `docs/how-it-works.md`: search sidecar, identities, invalidation, concurrency
- `docs/cli.md`: cache behavior only if user-visible flags/output change
- `docs/agent-workflows.md`: persistent MCP session behavior and freshness
- `docs/mcp.md`: warmup, refresh, and sidecar diagnostics
- `docs/installation.md`: local cache may contain source-derived text
- `README.md`: one concise performance statement and canonical link
- `codegraph-skill/codegraph/SKILL.md`: any changed CLI/tool contract

Add no cache flag unless existing `--cache off|memory|disk` cannot express the behavior. Defaults follow the command's current effective cache mode.

## Risks and mitigations

### FTS candidate false negatives

A candidate filter that misses a match is a correctness bug. Use trigram substring candidates, the existing exact verifier, short-query fallback, and parity fixtures before removing production comparison code.

### Sidecar size

Raw chunks can duplicate source. Measure indexed bytes per source byte, retain current oversized-file exclusions, and cap the representative corpus at 2.5x indexed text before SQLite overhead.

### Initial-query regression

The first sidecar build adds work. Prepare once, batch writes, use a worker for large builds, and cap cold regression at 20%.

### SQLite synchronous stalls

`node:sqlite` is synchronous. Keep heavy create/update work off the MCP event loop and bound candidates before materializing rows.

### Cache identity mismatch

Mixing graph and text snapshots can produce plausible wrong results. Verify identity before response assembly and invalidate handles on refresh.

### Windows locking

Open handles can block replacement. Centralize ownership, close before rename, and test on Windows CI.

### Public API growth

`ProjectIndex` already carries manifest provenance. Keep query-store handles session-internal and do not export storage details in v1.

## Definition of done

The checked items below remain the implementation audit ledger.

- [x] Disk cache creates the project-local `.codegraph-cache/index-v1/search-v1.sqlite` sidecar; cache-off creates none.
- [x] Source identities use current `ProjectIndex.manifestEntries`.
- [x] Exact warm CLI search opens the sidecar without repository-wide reads.
- [x] Updates touch only added, changed, deleted, or retired paths.
- [x] FTS selects candidates; existing matching and ranking decide results.
- [x] CLI and MCP use one query path.
- [x] Freshness prevents mixed-snapshot responses.
- [x] Corruption, future schemas, contention, and path escapes fail safely.
- [x] Parity tests cover every mode and short queries.
- [x] Packed-binary tests cover worker and sidecar behavior.
- [x] Hybrid, text, and MCP targets pass without regressions elsewhere.
- [x] Cache privacy and behavior are documented.
- [x] `npm run check` passes.
