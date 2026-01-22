# Plan: Reduce redundant parsing / increase reuse

## Goal
Improve performance by reusing parsed trees and symbol data more effectively across runs, without adding external language servers.

## Why this matters
- Indexing currently builds a per-run `parsedMap` and uses manifests and file signatures, but parsing still happens frequently for unchanged files.

## Constraints
- Keep caching simple and local (no external services).
- Avoid complex invalidation rules; prefer content-hash validation.

## Requirements
- Cache entries MUST be invalidated when content hash changes.
- Cache format MUST be versioned to allow safe upgrades.
- Build reports MUST expose cache hit/miss counts.

## Step-by-step plan (junior-friendly)

### 1) Audit existing cache flow
**Owner:** Junior engineer
**Tasks:**
1. Trace build flow in `buildIndexFromFileListShared` and `buildProjectIndexIncremental`.
2. Identify when cached module indexes are reused vs. reparsed.
3. Document the current decision points in a short checklist.

### 2) Add optional disk cache for parsed outputs
**Owner:** Junior engineer
**Tasks:**
1. Add a cache entry format that stores:
   - file signature
   - symbol list
   - import/export bindings
2. Store under the existing cache dir (`.codegraph-cache/index-v1`) with one file per source.
3. Validate cache hits with content hash to avoid stale data.

### 3) Add cache hit metrics
**Owner:** Junior engineer
**Tasks:**
1. Extend `BuildReport` to include cache hit/miss counts for parsed outputs.
2. Print a concise summary for debugging in verbose mode.

### 4) Add tests for cache reuse
**Owner:** Junior engineer
**Tasks:**
1. Create a test that builds an index, then re-builds with no changes.
2. Assert that parse count drops and cache hit count increases.
3. Add a test that changes one file and validates only that file is re-parsed.

## How we’ll measure success
- Second build on unchanged repo has minimal parse time and high cache hit rate.
- Cache reuse is transparent and reliable in tests.
