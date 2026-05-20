import type { SqliteDatabase } from "../sqlite-driver.js";

export const toSqliteText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
};

export const execRows = (db: SqliteDatabase, sql: string): Array<Array<unknown>> => {
  const rows = db.prepare(sql).raw().all();
  const normalized: Array<Array<unknown>> = [];
  for (const row of rows) {
    if (!Array.isArray(row)) {
      throw new Error("Expected sqlite raw() results to be row arrays.");
    }
    normalized.push(row);
  }
  return normalized;
};

export const execRowsParams = (
  db: SqliteDatabase,
  sql: string,
  params: Array<string | number | null>,
): Array<Array<unknown>> => {
  const rows = db.prepare(sql).raw().all(params);
  const normalized: Array<Array<unknown>> = [];
  for (const row of rows) {
    if (!Array.isArray(row)) {
      throw new Error("Expected sqlite raw() results to be row arrays.");
    }
    normalized.push(row);
  }
  return normalized;
};

export const dedupePreservingOrder = (values: string[]): string[] => {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
};
