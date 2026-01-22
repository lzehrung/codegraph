# Plan: Tune concurrency and bloom filters per repo size

## Goal
Automatically select sensible defaults for threading and bloom filters to improve performance across small and large repos.

## Why this matters
- The indexer currently uses a fixed default concurrency of 8 and enables bloom filters by default. This can be suboptimal for very small or very large repos.

## Constraints
- Keep logic simple and deterministic.
- Avoid adding new dependencies.

## Requirements
- Heuristics MUST be used only when `opts.threads` is not provided.
- Bloom filter defaults MUST remain overrideable via build options.
- Selected defaults MUST be recorded in a build report for debugging.

## Step-by-step plan (junior-friendly)

### 1) Add repo size heuristics
**Owner:** Junior engineer
**Tasks:**
1. Compute basic repo stats during indexing:
   - number of files
   - total bytes of files
2. Use these to determine default concurrency if `opts.threads` is not provided:
   - small repo: 2–4
   - medium repo: 8
   - large repo: 12–16 (cap at 64)

### 2) Tune bloom filter defaults
**Owner:** Junior engineer
**Tasks:**
1. Define a threshold (e.g., < 200 files) where bloom filters are disabled by default.
2. For larger repos, enable bloom filters and size them proportionally to file count.
3. Keep an override option in `BuildOptions`.

### 3) Add report logging for defaults
**Owner:** Junior engineer
**Tasks:**
1. Record selected defaults in `BuildReport`.
2. Print a concise summary when verbose is enabled.

### 4) Add unit tests
**Owner:** Junior engineer
**Tasks:**
1. Test small/medium/large repo heuristics with synthetic file lists.
2. Assert chosen concurrency and bloom filter settings match expected ranges.

## How we’ll measure success
- Reduced total index time for large repos.
- No performance regression on small repos.
- Defaults remain predictable and explainable.
