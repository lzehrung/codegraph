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

/** Parsed contexts follow the index lifetime, as scopeCache already retains their syntax trees. */
const onDemandParsedContexts = new WeakMap<ProjectIndex, Map<string, Promise<ParsedFileContext>>>();

/** Reuse one query-time syntax parse per file, including files loaded from a disk-cached index. */
export function ensureParsedContextForIndex(index: ProjectIndex, file: string): Promise<ParsedFileContext> {
  const fileKey = fileIdentityKey(file);
  const retained = index.parsed?.get(fileKey);
  if (retained) return ensureParsedContext(file, retained, index.languageExtensions);

  let cache = onDemandParsedContexts.get(index);
  if (!cache) {
    cache = new Map();
    onDemandParsedContexts.set(index, cache);
  }
  const cached = cache.get(fileKey);
  if (cached) return cached;

  const promise = parseNavigationContext(file, index.languageExtensions);
  cache.set(fileKey, promise);
  void promise.catch(() => {
    if (cache.get(fileKey) === promise) cache.delete(fileKey);
  });
  return promise;
}
