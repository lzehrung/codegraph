import type { LanguageSupport } from "../languages.js";
import type { NativeCompatibilityQueryKind, NativeQueryKind } from "../languages/types.js";

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
