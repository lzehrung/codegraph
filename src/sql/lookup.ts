import { sqlObjectBaseName } from "./lex.js";

export function sqlObjectLookupKeys(name: string): string[] {
  const normalized = name.toLowerCase();
  const baseName = sqlObjectBaseName(name).toLowerCase();
  return normalized === baseName ? [normalized] : [normalized, baseName];
}

export function pushSqlLookupValue<T>(lookup: Map<string, T[]>, key: string, value: T): void {
  const existing = lookup.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  lookup.set(key, [value]);
}
