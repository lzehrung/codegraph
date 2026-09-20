import { appendToArrayMap } from "../util/collections.js";

import { sqlObjectBaseNameLookupKey, sqlObjectLookupKey } from "./lex.js";

export function sqlObjectLookupKeys(name: string): string[] {
  const normalized = sqlObjectLookupKey(name);
  const baseName = sqlObjectBaseNameLookupKey(name);
  return normalized === baseName ? [normalized] : [normalized, baseName];
}

/**
 * Conservative pairwise SQL object match used by impact analysis.
 * Exact lookup keys always match. Basename fallback applies only when the
 * changed object or the edge target is itself unqualified. Two qualified
 * names in different schemas never match, even when they share a basename.
 */
export function sqlObjectNamesMatchConservatively(left: string, right: string): boolean {
  const leftKey = sqlObjectLookupKey(left);
  const rightKey = sqlObjectLookupKey(right);
  if (leftKey === rightKey) return true;
  const leftBase = sqlObjectBaseNameLookupKey(left);
  const rightBase = sqlObjectBaseNameLookupKey(right);
  if (leftBase !== rightBase) return false;
  return leftKey === leftBase || rightKey === rightBase;
}

export function pushSqlLookupValue<T>(lookup: Map<string, T[]>, key: string, value: T): void {
  appendToArrayMap(lookup, key, value);
}
