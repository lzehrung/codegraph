import { fileIdentityKey } from "../util/paths.js";
import { ensureParsedContext, parseNavigationContext, type ParsedFileContext } from "./parse-context.js";
import type { BuildOptions, ProjectIndex } from "./types.js";

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

/** Retain parsed contexts for the index lifetime so query consumers and scopes share one syntax tree. */
type CachedParsedContext = { promise: Promise<ParsedFileContext>; parsed?: ParsedFileContext };
const onDemandParsedContexts = new WeakMap<ProjectIndex, Map<string, CachedParsedContext>>();

/** Synchronous owners can reuse a completed shared tree without creating another parser pass. */
export function cachedParsedContextForIndexSync(index: ProjectIndex, file: string): ParsedFileContext | undefined {
  const fileKey = fileIdentityKey(file);
  return index.parsed?.get(fileKey) ?? onDemandParsedContexts.get(index)?.get(fileKey)?.parsed;
}

/** Read an already retained tree without parsing a file just to check the cache. */
export function cachedParsedContextForIndex(index: ProjectIndex, file: string): Promise<ParsedFileContext> | undefined {
  const fileKey = fileIdentityKey(file);
  const retained = index.parsed?.get(fileKey);
  if (retained) return ensureParsedContext(file, retained, index.languageExtensions);
  return onDemandParsedContexts.get(index)?.get(fileKey)?.promise;
}

/** Reuse one query-time syntax parse per file, including files loaded from a disk-cached index. */
export function ensureParsedContextForIndex(
  index: ProjectIndex,
  file: string,
  parsed?: ParsedFileContext,
): Promise<ParsedFileContext> {
  const fileKey = fileIdentityKey(file);
  const retained = index.parsed?.get(fileKey);
  if (retained) return ensureParsedContext(file, retained, index.languageExtensions);

  let cache = onDemandParsedContexts.get(index);
  if (!cache) {
    cache = new Map();
    onDemandParsedContexts.set(index, cache);
  }
  const cached = cache.get(fileKey);
  if (cached) return cached.promise;

  const promise = parsed ? Promise.resolve(parsed) : parseNavigationContext(file, index.languageExtensions);
  const entry: CachedParsedContext = { promise };
  if (parsed) entry.parsed = parsed;
  cache.set(fileKey, entry);
  void promise.then(
    (context) => {
      if (cache.get(fileKey) === entry) entry.parsed = context;
    },
    () => {
      if (cache.get(fileKey) === entry) cache.delete(fileKey);
    },
  );
  return promise;
}
