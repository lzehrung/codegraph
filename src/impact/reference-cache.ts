import { findReferences, findUsageReferences } from "../indexer/navigation.js";
import { ensureParsedContext } from "../indexer/parse-context.js";
import { extractEnclosingBlock, extractLineContext } from "../indexer/reference-context.js";
import { DEFAULT_REF_CONTEXT_LINES } from "../indexer/shared.js";
import type {
  FindReferencesResult,
  ProjectIndex,
  Reference,
  ReferenceCoverage,
  ReferenceCoverageReason,
  SymbolDef,
} from "../indexer/types.js";
import type { LanguageSupport } from "../languages.js";
import type { SyntaxTreeLike } from "../languages/types.js";
import { fileIdentityKey } from "../util/paths.js";

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
  getUsages(index: ProjectIndex, def: SymbolDef, options?: CachedReferenceOptions): Promise<FindReferencesResult>;
};

export function createReferenceLookupCache(): ReferenceLookupCache {
  const cachesByIndex = new WeakMap<ProjectIndex, Map<string, BaseReferenceEntry[]>>();
  const lookup = async (
    mode: "all" | "usages",
    index: ProjectIndex,
    def: SymbolDef,
    options?: CachedReferenceOptions,
  ): Promise<FindReferencesResult> => {
    const maxReferences = normalizeMaxReferences(options?.maxReferences);
    const indexCache = getIndexReferenceCache(cachesByIndex, index);
    const baseResult = await getBaseReferences(index, def, maxReferences, indexCache, mode);
    const bounded = cloneReferenceResult(baseResult, maxReferences);
    if (bounded.status !== "ok" || options?.context === undefined) return bounded;
    await attachReferenceContext(index, bounded.references, options);
    return bounded;
  };
  return {
    get: (index, def, options) => lookup("all", index, def, options),
    getUsages: (index, def, options) => lookup("usages", index, def, options),
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
  mode: "all" | "usages",
): Promise<FindReferencesResult> {
  const key = referenceLookupKey(def, mode);
  const entries = cache.get(key) ?? [];
  const reusable = entries.find((entry) => canReuseEntry(entry.maxReferences, maxReferences));
  if (reusable) return reusable.refs;
  const finder = mode === "usages" ? findUsageReferences : findReferences;
  const refs = finder(index, { def }, maxReferences === undefined ? undefined : { maxReferences });
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

const COVERAGE_REASON_ORDER: ReferenceCoverageReason[] = ["parser_degraded", "unresolved_import", "truncated"];

function cloneCoverage(coverage: ReferenceCoverage): ReferenceCoverage {
  return {
    scope: coverage.scope,
    state: coverage.state,
    ...(coverage.reasons ? { reasons: [...coverage.reasons] } : {}),
    ...(coverage.affectedFiles ? { affectedFiles: [...coverage.affectedFiles] } : {}),
  };
}

function withTruncatedCoverage(coverage: ReferenceCoverage): ReferenceCoverage {
  const reasons = new Set<ReferenceCoverageReason>(coverage.reasons ?? []);
  reasons.add("truncated");
  return {
    scope: "indexed_candidates",
    state: "partial",
    reasons: COVERAGE_REASON_ORDER.filter((reason) => reasons.has(reason)),
    ...(coverage.affectedFiles ? { affectedFiles: [...coverage.affectedFiles] } : {}),
  };
}

function cloneReferenceResult(result: FindReferencesResult, maxReferences: number | undefined): FindReferencesResult {
  if (result.status !== "ok") return result;
  const truncatedByBound = maxReferences !== undefined && result.references.length > maxReferences;
  const references = result.references.slice(0, maxReferences).map(cloneReference);
  const baseCoverage = cloneCoverage(result.referenceCoverage);
  return {
    status: "ok",
    definition: result.definition,
    references,
    referenceCoverage: truncatedByBound ? withTruncatedCoverage(baseCoverage) : baseCoverage,
    ...(result.provenance ? { provenance: result.provenance } : {}),
  };
}

function cloneReference(reference: Reference): Reference {
  return {
    file: reference.file,
    range: { start: { ...reference.range.start }, end: { ...reference.range.end } },
    ...(reference.context !== undefined ? { context: reference.context } : {}),
    ...(reference.via !== undefined ? { via: { ...reference.via } } : {}),
    ...(reference.provenance !== undefined ? { provenance: { ...reference.provenance } } : {}),
  };
}

async function attachReferenceContext(
  index: ProjectIndex,
  references: Reference[],
  options: CachedReferenceOptions,
): Promise<void> {
  const perFileCache = new Map<string, { source: string; tree: SyntaxTreeLike; sup: LanguageSupport }>();
  for (const ref of references) {
    const fileKey = fileIdentityKey(ref.file);
    let cached = perFileCache.get(fileKey);
    if (!cached) {
      const parsedEntry = index.parsed?.get(fileKey);
      const parsed = await ensureParsedContext(ref.file, parsedEntry, index.languageExtensions);
      cached = { source: parsed.source, tree: parsed.tree, sup: parsed.sup };
      perFileCache.set(fileKey, cached);
    }
    if (options.context === "line") {
      ref.context = extractLineContext(cached.source, ref.range.start.line, options.lines ?? DEFAULT_REF_CONTEXT_LINES);
    } else if (options.context === "block") {
      ref.context = extractEnclosingBlock(
        cached.source,
        cached.tree,
        ref.range,
        options.blockMaxLines ?? 60,
        cached.sup,
      );
    }
  }
}

function referenceLookupKey(def: SymbolDef, mode: "all" | "usages"): string {
  return JSON.stringify({
    mode,
    file: def.file,
    name: def.localName,
    kind: def.kind,
    line: def.range.start.line,
    column: def.range.start.column,
    index: def.range.start.index,
  });
}
