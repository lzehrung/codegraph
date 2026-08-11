import { fileIdentityKey } from "../util/paths.js";
import type { ParsedFileContext } from "./parse-context.js";
import type { BuildOptions } from "./types.js";

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
