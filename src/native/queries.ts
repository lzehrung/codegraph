import type { LanguageSupport } from "../languages.js";
import type { NativeCompatibilityQueryKind, NativeQueryKind } from "../languages/types.js";
import type { NativeBinding, NativeQueryScope } from "./contracts.js";

export const NATIVE_QUERY_KINDS: NativeQueryKind[] = ["imports", "exports", "locals", "importBindings"];

/**
 * Per-language cache of normalized query text and modification status.
 * Normalization is constant for a given (support.id, queryKind) pair,
 * so we compute it once per language per kind.
 */
const normalizedQueryCache = new Map<string, Map<NativeQueryKind, { text: string; wasModified: boolean }>>();

export function normalizeNativeQueryForSupport(
  support: LanguageSupport,
  kind: NativeCompatibilityQueryKind,
  queryText: string,
): string {
  return support.native?.normalizeQuery?.(kind, queryText) ?? queryText;
}

function getOrComputeNormalizedEntry(
  support: LanguageSupport,
  kind: NativeQueryKind,
): { text: string; wasModified: boolean } {
  let byKind = normalizedQueryCache.get(support.id);
  if (!byKind) {
    byKind = new Map();
    normalizedQueryCache.set(support.id, byKind);
  }
  let entry = byKind.get(kind);
  if (!entry) {
    const original = support.queries[kind];
    const normalized = normalizeNativeQueryForSupport(support, kind, original);
    entry = { text: normalized, wasModified: normalized !== original };
    byKind.set(kind, entry);
  }
  return entry;
}

/**
 * Returns the normalized query text for the support's own query.
 * Cached per (support.id, kind) to avoid re-running regex normalization
 * on every file.
 */
export function getCachedNormalizedQuery(support: LanguageSupport, kind: NativeQueryKind): string {
  return getOrComputeNormalizedEntry(support, kind).text;
}

/**
 * Ids the addon returned for each (language, scope) query set, per binding. An id means something only to the binding
 * that issued it, so a different binding object (a test double, a reloaded addon) registers again and gets its own.
 */
const querySetIdsByBinding = new WeakMap<NativeBinding, Map<string, number>>();

/**
 * The id of `support`'s normalized queries in `binding`, registered on first use. The "full" scope names every query
 * kind and "imports" only the imports query, so an extraction call carries the id instead of up to several kilobytes of
 * query text. The addon registers by content, so each thread of a process that asks gets the same id and the same
 * compiled queries.
 */
export function getNativeQuerySetId(binding: NativeBinding, support: LanguageSupport, scope: NativeQueryScope): number {
  let ids = querySetIdsByBinding.get(binding);
  if (!ids) {
    ids = new Map();
    querySetIdsByBinding.set(binding, ids);
  }
  const key = `${support.id}:${scope}`;
  const known = ids.get(key);
  if (known !== undefined) return known;
  const importsOnly = scope === "imports";
  const id = binding.registerQuerySet(
    support.id,
    getCachedNormalizedQuery(support, "imports"),
    importsOnly ? "" : getCachedNormalizedQuery(support, "exports"),
    importsOnly ? "" : getCachedNormalizedQuery(support, "locals"),
    importsOnly ? "" : getCachedNormalizedQuery(support, "importBindings"),
  );
  ids.set(key, id);
  return id;
}

/**
 * Returns true when the native query for this (support, kind) differs from
 * the original JS query - meaning the language has grammar divergence and
 * empty native results should NOT be treated as authoritative.
 */
export function isNativeQueryModified(support: LanguageSupport, kind: NativeQueryKind): boolean {
  return getOrComputeNormalizedEntry(support, kind).wasModified;
}

export function isNativeQueryAuthoritative(support: LanguageSupport, kind: NativeQueryKind): boolean {
  if (!isNativeQueryModified(support, kind)) {
    return true;
  }
  return support.native?.authoritativeKinds?.includes(kind) ?? false;
}

export function getNativeQueryMetadataForSupport(support: LanguageSupport): {
  normalizedQueryKinds: NativeQueryKind[];
  skippedQueryKinds: NativeQueryKind[];
} {
  const normalizedQueryKinds: NativeQueryKind[] = [];
  const skippedQueryKinds: NativeQueryKind[] = [];

  for (const kind of NATIVE_QUERY_KINDS) {
    if (!isNativeQueryModified(support, kind)) {
      continue;
    }
    normalizedQueryKinds.push(kind);
    const originalQuery = support.queries[kind];
    const normalized = normalizeNativeQueryForSupport(support, kind, originalQuery);
    if (originalQuery.trim().length && !normalized.trim().length) {
      skippedQueryKinds.push(kind);
    }
  }

  return {
    normalizedQueryKinds,
    skippedQueryKinds,
  };
}
