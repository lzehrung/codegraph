# Codegraph Analysis: Correctness & Performance

Analysis of concrete bugs and performance opportunities in the codebase.

---

## Part 1: Correctness Issues

### C1. CRITICAL: `resolveExportFrom` infinite recursion on circular re-exports

**Location:** `src/graphs.ts:1166-1239`

The `resolveExportFrom` function (used by `buildSymbolGraphDetailed`) has no cycle detection. It uses a `cache` Map to memoize results, but the cache key is only written *after* a result is found — not before recursion starts. Circular re-export chains cause stack overflow.

Contrast with `resolveExport` in `src/indexer.ts:3515-3587`, which correctly uses a `visited` Set populated *before* recursing:
```typescript
// indexer.ts (correct)
if (visited.has(cycleKey)) return null;
visited.add(cycleKey);  // Added BEFORE recursion
```

```typescript
// graphs.ts (broken) — cache only set AFTER result found
if (cache.has(key)) return cache.get(key) ?? null;
// ... no sentinel set here ...
const down = resolveExportFrom(e.fromModule, ...);  // Can recurse back to same key
```

**Reproduction:**
```typescript
// moduleA.ts: export { x as y } from "./moduleB";
// moduleB.ts: export { y as x } from "./moduleA";
// Calling buildSymbolGraphDetailed → resolveExportFrom("A", "y") → stack overflow
```

**Fix:** Add a sentinel to `cache` before recursion (matching the `visited` pattern in `resolveExport`):
```typescript
cache.set(key, null);  // Sentinel before recursion
// ... existing resolution logic ...
```

---

### C2. HIGH: `stripJsLikeComments` corrupts string literals containing `//`

**Location:** `src/util.ts:721-724`

```typescript
export function stripJsLikeComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
```

The line-comment regex only skips `//` preceded by `:` (to preserve `https://`). But `//` appears in many non-URL string contexts:

- `const cdn = "//cdn.example.com/lib.js"` → becomes `const cdn = "`
- Template strings: `` `${base}//path` ``

Used in 4 critical paths:
1. `extractJsTsSpecifiers` (regex fallback for import detection) — `src/util.ts:761`
2. `extractJsTsDynamicSpecifiers` — `src/util.ts:927`
3. tsconfig.json parsing — `src/util.ts:996`
4. Indexer fallback import extraction — `src/indexer.ts:2013`

**Impact:** Corrupted source text causes missed imports and broken tsconfig resolution.

**Fix:** Replace the naive regex with a string-aware comment stripper that skips string/template contents:
```typescript
export function stripJsLikeComments(src: string): string {
  let result = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return result.replace(
    /(["'`])(?:\\[\s\S]|(?!\1).)*?\1|\/\/.*/g,
    (match) => (match.startsWith("/") ? "" : match),
  );
}
```

---

### C3. HIGH: Python relative-only imports missed by `extractPythonSpecifiers`

**Location:** `src/util.ts:965-966`

```typescript
const reFrom =
  /^\s*from\s+([A-Za-z_][\w\.]|\.+[A-Za-z_][\w\.]*)\s+import/gm;
```

The regex requires either an identifier start or dots followed by an identifier. It cannot match dot-only relative imports:

```python
from . import utils     # NOT matched — just "." with no identifier
from .. import config   # NOT matched — ".." with no identifier
from .helpers import x  # Matched correctly
```

`from . import` is idiomatic Python for relative package imports.

**Fix:**
```typescript
const reFrom =
  /^\s*from\s+(\.+(?:[A-Za-z_][\w\.]*)?|[A-Za-z_][\w\.]*)\s+import/gm;
```

---

### C4. HIGH: Python dot-only specifiers passed as module name instead of `null`

**Location:** `src/graphs.ts:321-328`

```typescript
const res = await resolvePythonModule(
  projectRoot,
  file,
  spec.includes(".") || !spec.startsWith(".") ? spec : null,
  relDots,
);
```

For `spec = ".."` (from `from .. import config`):
- `"..".includes(".")` → `true`
- Condition passes `".."` as `moduleName` instead of `null`

C3 and C4 compound — even if C3 is fixed to capture dot-only imports, C4 still misinterprets them during resolution.

**Fix:**
```typescript
const isDotsOnly = /^\.+$/.test(spec);
const moduleName = !isDotsOnly && (spec.includes(".") || !spec.startsWith("."))
  ? spec
  : null;
```

---

### C5. MEDIUM: `fileExistsCache` never invalidated

**Location:** `src/util.ts:2326, 1062-1074`

```typescript
const fileExistsCache = new Map<string, boolean>();
```

Module-level Map with no clearing mechanism. The `parsedMap` in indexer.ts has `.clear()` calls, but `fileExistsCache`, `resolveSpecifierCache`, and `resolvePythonModuleCache` in util.ts are never cleared.

For single-pass CLI usage this is fine, but problematic for:
- Long-lived `CodeReviewSession` instances
- Incremental builds where files are generated mid-process
- Multiple sequential analyses in the same Node process

**Fix:** Add a `clearResolutionCaches()` export:
```typescript
export function clearResolutionCaches(): void {
  fileExistsCache.clear();
  resolveSpecifierCache.clear();
  resolvePythonModuleCache.clear();
  tsconfigCache.clear();
}
```

---

## Part 2: Performance Opportunities

### P1. HIGH: Sequential file existence checks in specifier resolution

**Location:** `src/util.ts:1774-1781`

```typescript
const tryResolveCandidates = async (candidates: string[]): Promise<string | null> => {
  for (const c of candidates) {
    if (await fileExists(c)) return path.resolve(c);  // Sequential I/O
  }
  return null;
};
```

`buildCandidates()` generates ~43 candidate paths per specifier (1 base + 21 extensions + 21 index variants). On first-pass resolution (before the fileExists cache is warm), each candidate triggers a serial `fs.access()` call. For a project with 500 files averaging 10 imports each, that's ~215,000 serial filesystem lookups.

**Fix:** Check candidates in parallel, return the first match by priority order:
```typescript
const tryResolveCandidates = async (candidates: string[]): Promise<string | null> => {
  const results = await Promise.all(candidates.map(c => fileExists(c)));
  const idx = results.indexOf(true);
  return idx >= 0 ? path.resolve(candidates[idx]!) : null;
};
```

**Estimated impact:** Significant improvement on first-pass resolution. After the fileExists cache warms, subsequent lookups are effectively free, so the benefit is primarily on cold starts and large projects.

---

### P2. HIGH: Sequential import resolution within `collectEdgesForFile`

**Location:** `src/graphs.ts:319-405`

```typescript
for (const { spec, typeOnly, resolved, confidence } of specs) {
  // Each iteration awaits resolution before starting the next
  const res = await resolvePythonModule(...);
}
```

Each file's imports are resolved one-by-one. A file with 20 imports pays the serial cost even though resolutions are independent of each other.

**Fix:** Resolve all specifiers in parallel:
```typescript
const resolvedSpecs = await Promise.all(
  specs.map(({ spec, typeOnly }) => resolveSpecForLanguage(spec, sup, ...))
);
```

**Estimated impact:** Meaningful per-file speedup. The outer `mapLimit` already parallelizes across files, so the total improvement depends on how many files have many imports.

---

### P3. MEDIUM: Synchronous `fs.accessSync` in tsconfig path matching

**Location:** `src/util.ts:1797-1835`

```typescript
if (matchPath) {
  const m = matchPath(
    spec,
    undefined,
    (candidate: string) => {
      try {
        fs.accessSync(candidate, fs.constants.R_OK);  // BLOCKS event loop
        return true;
      } catch { return false; }
    },
    [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
  );
```

The `matchPath` callback uses synchronous I/O. This blocks the event loop during resolution of every bare specifier in TypeScript projects. The `tsconfig-paths` library requires a sync callback, but the results could be cached to minimize blocking.

**Fix:** Pre-populate a sync cache from async results, or replace `tsconfig-paths` with a custom async implementation. As a smaller fix, the extension probing loop after `matchPath` (lines 1818-1834) also uses `fs.accessSync` and could be converted to async.

---

### P4. MEDIUM: Multiple regex passes in `extractJsTsSpecifiers`

**Location:** `src/util.ts:758-920`

The function runs 6+ separate `matchAll` calls on the same source string:
```
reImportFrom, reImportSide, reExportFrom, reExportStar, reRequire, reDynamic
```

Each regex scans the entire file independently.

**Fix:** Combine into a single-pass line-by-line scan or a union regex that classifies matches:
```typescript
const combinedRe = /^\s*(?:import|export|(?:const|let|var)\s+.*=\s*require)\b/gm;
// Pre-filter lines that might contain specifiers, then classify
```

**Estimated impact:** 20-30% faster regex-mode extraction, most significant on large files.

---

### P5. LOW: Redundant fan-in computation in impact analysis

**Location:** `src/impact/analyzer.ts:58-65`

Fan-in is computed by iterating all graph edges. Reverse dependency lookups use the same edge data but are computed separately. Could be combined into a single pass.

---

## Priority Matrix

| ID | Severity | Effort | Summary |
|----|----------|--------|---------|
| C1 | CRITICAL | Low | `resolveExportFrom` stack overflow on circular re-exports |
| C2 | HIGH | Medium | `stripJsLikeComments` corrupts strings with `//` |
| C3 | HIGH | Low | Python regex misses `from . import` |
| C4 | HIGH | Low | Python dot-only spec passed as module name |
| C5 | MEDIUM | Low | Resolution caches never cleared |
| P1 | HIGH | Low | Parallelize file existence candidate checks |
| P2 | HIGH | Medium | Parallelize per-file import resolution |
| P3 | MEDIUM | Medium | Sync I/O in tsconfig path matching blocks event loop |
| P4 | MEDIUM | Medium | Multiple regex passes over same source |
| P5 | LOW | Low | Redundant fan-in computation |

## Suggested Fix Order

**Batch 1 — Quick wins:**
1. C1: Add sentinel to `resolveExportFrom` cache before recursion
2. C3 + C4: Fix Python relative import regex and module name condition
3. C5: Add `clearResolutionCaches()` export
4. P1: Parallelize `tryResolveCandidates`

**Batch 2 — Medium effort:**
5. C2: String-aware comment stripper
6. P2: Parallelize import resolution in `collectEdgesForFile`
7. P3: Cache-backed sync path resolution or async replacement

**Batch 3 — Optimization:**
8. P4: Single-pass regex extraction
9. P5: Combine fan-in and reverse-edge computation
