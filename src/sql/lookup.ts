import { appendToArrayMap } from "../util/collections.js";
import { sqlObjectBaseName } from "./lex.js";

export function sqlObjectLookupKeys(name: string): string[] {
  const normalized = name.toLowerCase();
  const baseName = sqlObjectBaseName(name).toLowerCase();
  return normalized === baseName ? [normalized] : [normalized, baseName];
}

export function pushSqlLookupValue<T>(lookup: Map<string, T[]>, key: string, value: T): void {
  appendToArrayMap(lookup, key, value);
}
