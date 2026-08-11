import { sqlObjectBaseNameLookupKey, sqlObjectLookupKey } from "./lex.js";

export function sqlObjectLookupKeys(name: string): string[] {
  const normalized = sqlObjectLookupKey(name);
  const baseName = sqlObjectBaseNameLookupKey(name);
  return normalized === baseName ? [normalized] : [normalized, baseName];
}

export function pushSqlLookupValue<T>(lookup: Map<string, T[]>, key: string, value: T): void {
  appendToArrayMap(lookup, key, value);
}
