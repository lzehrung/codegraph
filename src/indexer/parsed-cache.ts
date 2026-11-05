import { fileIdentityKey } from "../util/paths.js";
import type { NativeMatch, NativeSyntaxTree } from "../native/contracts.js";
import { ProjectedSyntaxTree } from "../native/projected-tree.js";
import type { ByteToStringIndexMap } from "../native/byte-index.js";
import {
  ensureParsedContext,
  parseNavigationContext,
  SyntaxTreeUnavailableError,
  type ParsedFileContext,
} from "./parse-context.js";
import type { BuildOptions, ProjectIndex } from "./types.js";
import type { ScopeIndex } from "./scope-types.js";

export function parsedCacheMaxEntries(opts: BuildOptions | undefined): number {
  return Math.max(1, opts?.parsedCacheMaxEntries ?? 1024);
}

export function setParsedCacheEntry(
  parsedMap: Map<string, ParsedFileContext>,
  file: string,
  entry: ParsedFileContext,
  maxEntries: number,
): void {
  const key = fileIdentityKey(file);
  if (parsedMap.has(key)) parsedMap.delete(key);
  parsedMap.set(key, entry);
  while (parsedMap.size > maxEntries) {
    const oldest = parsedMap.keys().next().value;
    if (!oldest) break;
    parsedMap.delete(oldest);
  }
}

export function retainedParsedCache(
  parsedMap: Map<string, ParsedFileContext>,
  opts: BuildOptions | undefined,
): Map<string, ParsedFileContext> | undefined {
  const keepParsed = opts?.keepParsed ?? false;
  const maxParsedEntries = parsedCacheMaxEntries(opts);
  if (!keepParsed) {
    parsedMap.clear();
    return undefined;
  }
  while (parsedMap.size > maxParsedEntries) {
    const oldest = parsedMap.keys().next().value;
    if (!oldest) break;
    parsedMap.delete(oldest);
  }
  return parsedMap;
}

/**
 * Query views are more expensive than their native columnar source: a projected tree
 * allocates a node slot per syntax node, and a scope index keeps additional wrappers.
 * Keep the compact source/columns in a separate bounded tier so evicting those views
 * does not force another native parse.
 */
const DEFAULT_COMPACT_SYNTAX_CACHE_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_LIVE_SYNTAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_SYNTAX_CACHE_MAX_ENTRIES = 32_768;

type CompactSyntaxContext = {
  source: string;
  sup: ParsedFileContext["sup"];
  columns: NativeSyntaxTree;
  byteIndexMap: ByteToStringIndexMap;
  nativeQueries: ParsedFileContext["nativeQueries"];
  embeddedBlocks: ParsedFileContext["embeddedBlocks"];
  bytes: number;
  nativeBufferBytes: number;
  sourceBytes: number;
  positionMapBytes: number;
  compactHeapBytes: number;
};

type CachedParsedContext = {
  signature: string | undefined;
  signatureBytes: number;
  compact?: CompactSyntaxContext;
  parsed?: ParsedFileContext | undefined;
  compactBytes: number;
  liveBytes: number;
};

type PendingParsedContext = {
  signature: string | undefined;
  promise: Promise<ParsedFileContext>;
};

type QuerySyntaxCache = {
  entries: Map<string, CachedParsedContext>;
  liveEntries: Map<string, CachedParsedContext>;
  inFlight: Map<string, PendingParsedContext>;
  compactBytes: number;
  liveBytes: number;
  compactEntries: number;
  maxCompactBytes: number;
  maxLiveBytes: number;
  maxEntries: number;
};

const querySyntaxCaches = new WeakMap<ProjectIndex, QuerySyntaxCache>();

function querySyntaxCacheFor(index: ProjectIndex): QuerySyntaxCache {
  let cache = querySyntaxCaches.get(index);
  if (!cache) {
    cache = {
      entries: new Map(),
      liveEntries: new Map(),
      inFlight: new Map(),
      compactBytes: 0,
      liveBytes: 0,
      compactEntries: 0,
      maxCompactBytes: DEFAULT_COMPACT_SYNTAX_CACHE_BYTES,
      maxLiveBytes: DEFAULT_LIVE_SYNTAX_CACHE_BYTES,
      maxEntries: DEFAULT_SYNTAX_CACHE_MAX_ENTRIES,
    };
    querySyntaxCaches.set(index, cache);
  }
  return cache;
}

function indexFileSignature(index: ProjectIndex, fileKey: string): string | undefined {
  // Resolve the identity key because manifest entries use the module's path spelling.
  const file = index.byFile.get(fileKey)?.file ?? fileKey;
  const entry = index.manifestEntries?.get(file);
  if (!entry) return undefined;
  return `${entry.sig}\0${entry.cacheSig ?? ""}\0${entry.gitSig ?? ""}`;
}

function stringBytes(value: string): number {
  return value.length * 2 + 24;
}

function byteIndexMapBytes(map: ByteToStringIndexMap): number {
  return (
    96 + map.byteToStringIndex.byteLength + map.lineStartBytes.length * 8 + (map.loneCrLineStarts?.length ?? 0) * 8
  );
}

function retainedSignatureBytes(signature: string | undefined): number {
  return signature === undefined ? 0 : stringBytes(signature);
}

function nativeColumnBufferBytes(columns: NativeSyntaxTree): number {
  const buffers = new Set<ArrayBufferLike>();
  buffers.add(columns.kindIds.buffer);
  buffers.add(columns.parentIds.buffer);
  buffers.add(columns.named.buffer);
  buffers.add(columns.isMissing.buffer);
  buffers.add(columns.startRow.buffer);
  buffers.add(columns.startColumn.buffer);
  buffers.add(columns.startIndex.buffer);
  buffers.add(columns.endRow.buffer);
  buffers.add(columns.endColumn.buffer);
  buffers.add(columns.endIndex.buffer);
  buffers.add(columns.childOffsets.buffer);
  buffers.add(columns.childIds.buffer);
  buffers.add(columns.childFieldNameIds.buffer);
  buffers.add(columns.namedChildOffsets.buffer);
  buffers.add(columns.namedChildIds.buffer);
  let bytes = 0;
  for (const buffer of buffers) bytes += buffer.byteLength;
  return bytes;
}

function nativeColumnHeapBytes(columns: NativeSyntaxTree): number {
  let bytes = 256;
  for (const kind of columns.kinds) bytes += stringBytes(kind);
  for (const fieldName of columns.fieldNames) bytes += stringBytes(fieldName);
  return bytes;
}

function nativeMatchBytes(matches: readonly NativeMatch[]): number {
  let bytes = 0;
  for (const match of matches) {
    bytes += 64;
    for (const capture of match.captures) {
      bytes += 128 + stringBytes(capture.name) + stringBytes(capture.text) + stringBytes(capture.nodeType);
    }
  }
  return bytes;
}

function nativeQueryBytes(parsed: ParsedFileContext): number {
  const results = parsed.nativeQueries;
  if (!results) return 0;
  return (
    nativeMatchBytes(results.imports) +
    nativeMatchBytes(results.exports) +
    nativeMatchBytes(results.locals) +
    nativeMatchBytes(results.importBindings)
  );
}

function compactContextFor(parsed: ParsedFileContext): CompactSyntaxContext | undefined {
  if (!(parsed.tree instanceof ProjectedSyntaxTree)) return undefined;
  const sourceBytes = stringBytes(parsed.source);
  const nativeBufferBytes = nativeColumnBufferBytes(parsed.tree.columns);
  const positionMapBytes = byteIndexMapBytes(parsed.tree.byteIndexMap);
  let compactHeapBytes = nativeColumnHeapBytes(parsed.tree.columns) + nativeQueryBytes(parsed) + 128;
  if (parsed.embeddedBlocks) {
    for (const block of parsed.embeddedBlocks) compactHeapBytes += 160 + stringBytes(block.source);
  }
  return {
    source: parsed.source,
    sup: parsed.sup,
    columns: parsed.tree.columns,
    byteIndexMap: parsed.tree.byteIndexMap,
    nativeQueries: parsed.nativeQueries,
    embeddedBlocks: parsed.embeddedBlocks,
    bytes: sourceBytes + nativeBufferBytes + positionMapBytes + compactHeapBytes,
    nativeBufferBytes,
    sourceBytes,
    positionMapBytes,
    compactHeapBytes,
  };
}

function projectedViewBytes(parsed: ParsedFileContext): number {
  const tree = parsed.tree;
  if (!(tree instanceof ProjectedSyntaxTree)) return 256 + parsed.source.length * 2;
  return 256 + tree.columns.nodeCount * 40;
}

function scopeIndexBytes(scope: ScopeIndex): number {
  let occurrenceCount = 0;
  for (const binding of scope.all) occurrenceCount += binding.occurrences.length;
  return (
    256 +
    scope.allScopes.length * 256 +
    scope.all.length * 512 +
    occurrenceCount * 128 +
    scope.bindings.size * 64 +
    scope.cppQualifiedFunctionBindings.size * 64
  );
}

function touchEntry(cache: QuerySyntaxCache, fileKey: string, entry: CachedParsedContext): void {
  cache.entries.delete(fileKey);
  cache.entries.set(fileKey, entry);
  if (entry.liveBytes) {
    cache.liveEntries.delete(fileKey);
    cache.liveEntries.set(fileKey, entry);
  }
}

function evictLiveView(
  index: ProjectIndex,
  cache: QuerySyntaxCache,
  fileKey: string,
  entry: CachedParsedContext,
): void {
  cache.liveEntries.delete(fileKey);
  if (entry.liveBytes) {
    cache.liveBytes -= entry.liveBytes;
    entry.liveBytes = 0;
  }
  entry.parsed = undefined;
  index.scopeCache.delete(fileKey);
  if (!entry.compact) cache.entries.delete(fileKey);
}

function evictEntry(index: ProjectIndex, cache: QuerySyntaxCache, fileKey: string, entry: CachedParsedContext): void {
  evictLiveView(index, cache, fileKey, entry);
  if (entry.compact) {
    cache.compactBytes -= entry.compactBytes;
    cache.compactEntries -= 1;
  }
  cache.entries.delete(fileKey);
}

function trimQuerySyntaxCache(index: ProjectIndex, cache: QuerySyntaxCache): void {
  while (cache.liveBytes > cache.maxLiveBytes) {
    const oldest = cache.liveEntries.entries().next().value;
    if (!oldest) break;
    evictLiveView(index, cache, oldest[0], oldest[1]);
  }
  while (cache.compactBytes > cache.maxCompactBytes || cache.compactEntries > cache.maxEntries) {
    let evicted = false;
    for (const [fileKey, entry] of cache.entries) {
      if (!entry.compact) continue;
      evictEntry(index, cache, fileKey, entry);
      evicted = true;
      break;
    }
    if (!evicted) break;
  }
  while (cache.entries.size > cache.maxEntries) {
    const oldest = cache.entries.entries().next().value;
    if (!oldest) break;
    evictEntry(index, cache, oldest[0], oldest[1]);
  }
}

function cacheEntryFor(
  index: ProjectIndex,
  cache: QuerySyntaxCache,
  fileKey: string,
  signature: string | undefined,
): CachedParsedContext | undefined {
  const entry = cache.entries.get(fileKey);
  if (!entry) return undefined;
  if (entry.signature !== signature) {
    evictEntry(index, cache, fileKey, entry);
    return undefined;
  }
  return entry;
}

function retainParsedContext(
  index: ProjectIndex,
  cache: QuerySyntaxCache,
  fileKey: string,
  signature: string | undefined,
  parsed: ParsedFileContext,
): void {
  if (indexFileSignature(index, fileKey) !== signature) return;
  let entry = cache.entries.get(fileKey);
  if (entry && entry.signature !== signature) {
    evictEntry(index, cache, fileKey, entry);
    entry = undefined;
  }
  if (!entry) {
    entry = { signature, signatureBytes: retainedSignatureBytes(signature), compactBytes: 0, liveBytes: 0 };
    cache.entries.set(fileKey, entry);
  }
  const compact = entry.compact ?? compactContextFor(parsed);
  if (compact && !entry.compact) {
    entry.compact = compact;
    entry.compactBytes = compact.bytes;
    cache.compactBytes += compact.bytes;
    cache.compactEntries += 1;
  }
  if (entry.parsed !== parsed) {
    if (entry.liveBytes) cache.liveBytes -= entry.liveBytes;
    entry.parsed = parsed;
    entry.liveBytes = projectedViewBytes(parsed);
    cache.liveBytes += entry.liveBytes;
    index.scopeCache.delete(fileKey);
  }
  touchEntry(cache, fileKey, entry);
  trimQuerySyntaxCache(index, cache);
}

function parsedContextFromCompact(compact: CompactSyntaxContext): ParsedFileContext {
  const parsed: ParsedFileContext = {
    source: compact.source,
    tree: new ProjectedSyntaxTree(compact.source, compact.columns, compact.byteIndexMap),
    sup: compact.sup,
  };
  if (compact.nativeQueries !== undefined) parsed.nativeQueries = compact.nativeQueries;
  if (compact.embeddedBlocks) parsed.embeddedBlocks = compact.embeddedBlocks;
  return parsed;
}

function restoreParsedContext(
  index: ProjectIndex,
  cache: QuerySyntaxCache,
  fileKey: string,
  entry: CachedParsedContext,
): ParsedFileContext {
  const compact = entry.compact;
  if (!compact) throw new Error("Cannot restore a query syntax view without compact columns");
  const parsed = parsedContextFromCompact(compact);
  if (entry.liveBytes) cache.liveBytes -= entry.liveBytes;
  entry.parsed = parsed;
  entry.liveBytes = projectedViewBytes(parsed);
  cache.liveBytes += entry.liveBytes;
  index.scopeCache.delete(fileKey);
  touchEntry(cache, fileKey, entry);
  trimQuerySyntaxCache(index, cache);
  return parsed;
}

/** Synchronous owners can reuse a completed shared tree without creating another parser pass. */
export function cachedParsedContextForIndexSync(index: ProjectIndex, file: string): ParsedFileContext | undefined {
  const fileKey = fileIdentityKey(file);
  const retained = index.parsed?.get(fileKey);
  if (retained) {
    const cache = querySyntaxCaches.get(index);
    if (cache) {
      const entry = cacheEntryFor(index, cache, fileKey, indexFileSignature(index, fileKey));
      if (entry) touchEntry(cache, fileKey, entry);
    }
    return retained;
  }
  const cache = querySyntaxCaches.get(index);
  if (!cache) return undefined;
  const entry = cacheEntryFor(index, cache, fileKey, indexFileSignature(index, fileKey));
  if (!entry) return undefined;
  if (entry.parsed) {
    touchEntry(cache, fileKey, entry);
    return entry.parsed;
  }
  if (entry.compact) return restoreParsedContext(index, cache, fileKey, entry);
  return undefined;
}

/** Return a cached scope and refresh its owning query-view entry in the LRU. */
export function cachedScopeIndexForIndex(index: ProjectIndex, file: string): ScopeIndex | undefined {
  const fileKey = fileIdentityKey(file);
  const cache = querySyntaxCaches.get(index);
  if (cache) {
    const entry = cacheEntryFor(index, cache, fileKey, indexFileSignature(index, fileKey));
    if (entry) touchEntry(cache, fileKey, entry);
  }
  return index.scopeCache.get(fileKey);
}

/** Keep scope references under the same live-view budget as the tree wrappers they reference. */
export function retainScopeIndexForIndex(
  index: ProjectIndex,
  file: string,
  parsed: ParsedFileContext,
  scope: ScopeIndex,
): void {
  const fileKey = fileIdentityKey(file);
  const cache = querySyntaxCacheFor(index);
  const signature = indexFileSignature(index, fileKey);
  let entry = cacheEntryFor(index, cache, fileKey, signature);
  if (!entry) {
    entry = { signature, signatureBytes: retainedSignatureBytes(signature), compactBytes: 0, liveBytes: 0 };
    cache.entries.set(fileKey, entry);
  }

  let retainedParsed: ParsedFileContext;
  if (entry.parsed?.tree === parsed.tree) {
    retainedParsed = entry.parsed;
  } else {
    const indexedParsed = index.parsed?.get(fileKey);
    const retainedIndexedParsed = indexedParsed?.tree === parsed.tree ? indexedParsed : undefined;
    retainedParsed = retainedIndexedParsed ?? parsed;
    const compact = entry.compact ?? compactContextFor(retainedParsed);
    if (compact && !entry.compact) {
      entry.compact = compact;
      entry.compactBytes = compact.bytes;
      cache.compactBytes += compact.bytes;
      cache.compactEntries += 1;
    }
    entry.parsed = retainedIndexedParsed ? undefined : retainedParsed;
  }
  const previousLiveBytes = entry.liveBytes;
  if (previousLiveBytes) cache.liveBytes -= previousLiveBytes;
  const scopeBytes = scopeIndexBytes(scope);
  entry.liveBytes = projectedViewBytes(retainedParsed) + scopeBytes;
  cache.liveBytes += entry.liveBytes;
  index.scopeCache.set(fileKey, scope);
  touchEntry(cache, fileKey, entry);
  trimQuerySyntaxCache(index, cache);
}

/** Reuse one query-time syntax parse per file, including files loaded from a disk-cached index. */
export function ensureParsedContextForIndex(
  index: ProjectIndex,
  file: string,
  parsed?: ParsedFileContext,
): Promise<ParsedFileContext> {
  const fileKey = fileIdentityKey(file);
  const retained = index.parsed?.get(fileKey);
  if (retained) {
    const cache = querySyntaxCacheFor(index);
    retainParsedContext(index, cache, fileKey, indexFileSignature(index, fileKey), retained);
    return ensureParsedContext(file, retained, index.languageExtensions);
  }

  const cache = querySyntaxCacheFor(index);
  const signature = indexFileSignature(index, fileKey);
  const entry = cacheEntryFor(index, cache, fileKey, signature);
  if (entry?.parsed) {
    touchEntry(cache, fileKey, entry);
    return Promise.resolve(entry.parsed);
  }
  if (entry?.compact) return Promise.resolve(restoreParsedContext(index, cache, fileKey, entry));

  const pending = cache.inFlight.get(fileKey);
  if (pending && pending.signature === signature) return pending.promise;

  const promise = parsed ? Promise.resolve(parsed) : parseNavigationContext(file, index.languageExtensions);
  const pendingEntry: PendingParsedContext = { signature, promise };
  cache.inFlight.set(fileKey, pendingEntry);
  void promise.then(
    (context) => {
      if (cache.inFlight.get(fileKey) !== pendingEntry) return;
      cache.inFlight.delete(fileKey);
      retainParsedContext(index, cache, fileKey, signature, context);
    },
    () => {
      if (cache.inFlight.get(fileKey) === pendingEntry) cache.inFlight.delete(fileKey);
    },
  );
  return promise;
}

/** Graph builds may skip a missing tree; navigation still rejects, and failed parses remain retryable. */
export async function tryEnsureParsedContextForIndex(
  index: ProjectIndex,
  file: string,
): Promise<ParsedFileContext | null> {
  try {
    return await ensureParsedContextForIndex(index, file);
  } catch (error) {
    if (error instanceof SyntaxTreeUnavailableError) return null;
    throw error;
  }
}

/** Internal cache controls used by deterministic retention regressions. */
export function __setQuerySyntaxCacheLimitsForTests(
  index: ProjectIndex,
  limits: { compactBytes?: number; liveBytes?: number; entries?: number },
): void {
  const cache = querySyntaxCacheFor(index);
  if (limits.compactBytes !== undefined) cache.maxCompactBytes = Math.max(0, limits.compactBytes);
  if (limits.liveBytes !== undefined) cache.maxLiveBytes = Math.max(0, limits.liveBytes);
  if (limits.entries !== undefined) cache.maxEntries = Math.max(0, limits.entries);
  trimQuerySyntaxCache(index, cache);
}

/** Byte components overlap compact/live budgets; entry and in-flight metadata are separate. */
export function __querySyntaxCacheStatsForTests(index: ProjectIndex): {
  compactBytes: number;
  liveBytes: number;
  compactEntries: number;
  liveEntries: number;
  entries: number;
  inFlight: number;
  nativeBufferBytes: number;
  sourceBytes: number;
  positionMapBytes: number;
  compactHeapBytes: number;
  liveViewOverheadBytes: number;
  projectedNodeBytes: number;
  scopeBytes: number;
  signatureBytes: number;
  entryMetadataBytes: number;
  inFlightMetadataBytes: number;
} {
  const cache = querySyntaxCacheFor(index);
  let liveEntries = 0;
  let nativeBufferBytes = 0;
  let sourceBytes = 0;
  let compactHeapBytes = 0;
  let positionMapBytes = 0;
  let projectedNodeBytes = 0;
  let scopeBytes = 0;
  let signatureBytes = 0;
  let entryMetadataBytes = 0;
  let inFlightMetadataBytes = 0;
  for (const [fileKey, entry] of cache.entries) {
    if (entry.liveBytes) {
      liveEntries += 1;
      entryMetadataBytes += 64;
    }
    signatureBytes += entry.signatureBytes;
    entryMetadataBytes += stringBytes(fileKey) + entry.signatureBytes + 128;
    if (entry.compact) {
      nativeBufferBytes += entry.compact.nativeBufferBytes;
      sourceBytes += entry.compact.sourceBytes;
      positionMapBytes += entry.compact.positionMapBytes;
      compactHeapBytes += entry.compact.compactHeapBytes;
    } else if (entry.parsed) {
      sourceBytes += stringBytes(entry.parsed.source);
    }
    if (entry.parsed?.tree instanceof ProjectedSyntaxTree) {
      projectedNodeBytes += entry.parsed.tree.columns.nodeCount * 40;
    }
    const scope = index.scopeCache.get(fileKey);
    if (scope) scopeBytes += scopeIndexBytes(scope);
  }
  for (const [fileKey, pending] of cache.inFlight) {
    inFlightMetadataBytes += stringBytes(fileKey) + retainedSignatureBytes(pending.signature) + 96;
  }
  return {
    compactBytes: cache.compactBytes,
    liveBytes: cache.liveBytes,
    compactEntries: cache.compactEntries,
    liveEntries,
    entries: cache.entries.size,
    inFlight: cache.inFlight.size,
    nativeBufferBytes,
    sourceBytes,
    positionMapBytes,
    compactHeapBytes,
    liveViewOverheadBytes: cache.liveBytes - scopeBytes,
    projectedNodeBytes,
    scopeBytes,
    signatureBytes,
    entryMetadataBytes,
    inFlightMetadataBytes,
  };
}
