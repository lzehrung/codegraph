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

/** Definitions of one SQL name space, indexed by exact lookup key and by base-name lookup key. */
export type SqlDefinitionIndex<T> = {
  exact: Map<string, T[]>;
  basename: Map<string, T[]>;
};

export function createSqlDefinitionIndex<T>(): SqlDefinitionIndex<T> {
  return { exact: new Map(), basename: new Map() };
}

export function addSqlDefinition<T>(index: SqlDefinitionIndex<T>, name: string, definition: T): void {
  pushSqlLookupValue(index.exact, sqlObjectLookupKey(name), definition);
  pushSqlLookupValue(index.basename, sqlObjectBaseNameLookupKey(name), definition);
}

/**
 * Routine definitions that one name can mean. An exact lookup key wins, so `app.normalize_email`
 * finds only the definition with that qualified name. Otherwise a definition qualifies when it has
 * the same base name and one of the two names is unqualified. More than one candidate means the name
 * cannot be tied to one definition: overloads and repeated `CREATE OR REPLACE` statements share a name.
 */
export function sqlRoutineNameCandidates<T>(
  index: SqlDefinitionIndex<T>,
  name: string,
  definitionName: (definition: T) => string,
): { candidates: readonly T[]; exact: boolean } {
  const exactMatches = index.exact.get(sqlObjectLookupKey(name));
  if (exactMatches?.length) return { candidates: exactMatches, exact: true };
  const sameBaseName = index.basename.get(sqlObjectBaseNameLookupKey(name)) ?? [];
  const candidates = sameBaseName.filter((definition) =>
    sqlObjectNamesMatchConservatively(name, definitionName(definition)),
  );
  return { candidates, exact: false };
}
