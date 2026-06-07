import { findReferences } from "../indexer/navigation.js";
import { ensureParsedContext } from "../indexer/parse-context.js";
import { extractEnclosingBlock, extractLineContext } from "../indexer/reference-context.js";
import { DEFAULT_REF_CONTEXT_LINES } from "../indexer/shared.js";
import type { FindReferencesResult, ProjectIndex, Reference, SymbolDef } from "../indexer/types.js";
import type { LanguageSupport } from "../languages.js";
import type { SyntaxTreeLike } from "../languages/types.js";

export type CachedReferenceOptions = {
  maxReferences?: number;
  context?: "line" | "block";
  lines?: number;
  blockMaxLines?: number;
};

type BaseReferenceEntry = {
  maxReferences: number | undefined;
  refs: Promise<FindReferencesResult>;
};

export type ReferenceLookupCache = {
  get(index: ProjectIndex, def: SymbolDef, options?: CachedReferenceOptions): Promise<FindReferencesResult>;
};

export function createReferenceLookupCache(): ReferenceLookupCache {
  const cachesByIndex = new WeakMap<ProjectIndex, Map<string, BaseReferenceEntry[]>>();
  return {
    async get(index, def, options) {
      const maxReferences = normalizeMaxReferences(options?.maxReferences);
      const indexCache = getIndexReferenceCache(cachesByIndex, index);
      const baseResult = await getBaseReferences(index, def, maxReferences, indexCache);
      const bounded = cloneReferenceResult(baseResult, maxReferences);
      if (bounded.status !== "ok" || options?.context === undefined) return bounded;
      await attachReferenceContext(index, bounded.references, options);
      return bounded;
    },
  };
}
function getIndexReferenceCache(
  cachesByIndex: WeakMap<ProjectIndex, Map<string, BaseReferenceEntry[]>>,
  index: ProjectIndex,
): Map<string, BaseReferenceEntry[]> {
  let cache = cachesByIndex.get(index);
  if (!cache) {
    cache = new Map();
    cachesByIndex.set(index, cache);
  }
  return cache;
}


function getBaseReferences(
  index: ProjectIndex,
  def: SymbolDef,
  maxReferences: number | undefined,
  cache: Map<string, BaseReferenceEntry[]>,
): Promise<FindReferencesResult> {
  const key = referenceLookupKey(def);
  const entries = cache.get(key) ?? [];
  const reusable = entries.find((entry) => canReuseEntry(entry.maxReferences, maxReferences));
  if (reusable) return reusable.refs;
  const refs = findReferences(index, { def }, maxReferences === undefined ? undefined : { maxReferences });
  entries.push({ maxReferences, refs });
  cache.set(key, entries);
  return refs;
}

function canReuseEntry(existingLimit: number | undefined, requestedLimit: number | undefined): boolean {
  if (existingLimit === undefined) return true;
  if (requestedLimit === undefined) return false;
  return existingLimit >= requestedLimit;
}

function normalizeMaxReferences(maxReferences: number | undefined): number | undefined {
  if (maxReferences === undefined || maxReferences <= 0) return undefined;
  return maxReferences;
}

function cloneReferenceResult(result: FindReferencesResult, maxReferences: number | undefined): FindReferencesResult {
  if (result.status !== "ok") return result;
  const references = result.references.slice(0, maxReferences).map(cloneReference);
  return {
    status: "ok",
    definition: result.definition,
    references,
    ...(result.provenance ? { provenance: result.provenance } : {}),
  };
}

function cloneReference(reference: Reference): Reference {
  return {
    file: reference.file,
    range: reference.range,
    ...(reference.context !== undefined ? { context: reference.context } : {}),
    ...(reference.via !== undefined ? { via: reference.via } : {}),
  };
}

async function attachReferenceContext(
  index: ProjectIndex,
  references: Reference[],
  options: CachedReferenceOptions,
): Promise<void> {
  const perFileCache = new Map<string, { source: string; tree: SyntaxTreeLike; sup: LanguageSupport }>();
  for (const ref of references) {
    let cached = perFileCache.get(ref.file);
    if (!cached) {
      const parsedEntry = index.parsed?.get(ref.file);
      const parsed = await ensureParsedContext(ref.file, parsedEntry);
      cached = { source: parsed.source, tree: parsed.tree, sup: parsed.sup };
      perFileCache.set(ref.file, cached);
    }
    if (options.context === "line") {
      ref.context = extractLineContext(cached.source, ref.range.start.line, options.lines ?? DEFAULT_REF_CONTEXT_LINES);
    } else if (options.context === "block") {
      ref.context = extractEnclosingBlock(cached.source, cached.tree, ref.range, options.blockMaxLines ?? 60, cached.sup);
    }
  }
}

function referenceLookupKey(def: SymbolDef): string {
  return JSON.stringify({
    file: def.file,
    name: def.localName,
    kind: def.kind,
    line: def.range.start.line,
    column: def.range.start.column,
    index: def.range.start.index,
  });
}
