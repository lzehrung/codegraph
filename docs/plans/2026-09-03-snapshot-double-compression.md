# Snapshot and disk-cache double compression

Status: Thin snapshot (C) is implemented. This companion stays blocked until that ships on main; do not start a separate SQLite-into-blob adapter.

## Goal

Stop compressing the same `ModuleIndex` objects twice per build: once in SQLite (`writeModulesToCache`) and once inside `project-index-snapshot.json` (`writeProjectIndexSnapshot`).

## Current duplication

On a disk-cache build that actually changes files:

1. `writeModulesToCache` (`src/indexer/build-cache/module-cache.ts`) Brotli-compresses `JSON.stringify(transformed module)` per changed file into SQLite.
2. `writeProjectIndexSnapshot` (`src/indexer/build-cache/project-snapshot.ts`) transforms **every** in-memory module again, `JSON.stringify`s the whole corpus, and Brotli-compresses it as one blob.

The two stores are independent. Incremental load prefers snapshot modules, then SQLite. The unchanged fast path uses only the snapshot blob.

Bloom filters are a third pass (`bloom-filters.json` plus an optional copy inside the project snapshot). Graph edges are a fourth copy (manifest per-file `edges` plus snapshot `graph`).

## Why this waits

The snapshot-scope plan's recommended architecture (thin snapshot, module bodies only in SQLite) **removes the duplicate module corpus**. Implementing a "reuse SQLite payloads inside the blob" adapter before that decision would freeze the wrong layout.

If measurement rejects thin-snapshot hydrate (N SQLite reads much slower than one blob on Windows), this plan comes back with a narrower design: keep the blob for the fast path, and either defer rewriting it (option B there) or stitch already-compressed per-file frames so stringify+Brotli of unchanged modules never runs.

## Non-goals until unblocked

- Changing SQLite module schema.
- Replacing Brotli quality.
- Bloom/graph dedup, except as a later note after module bodies have a single owner.
