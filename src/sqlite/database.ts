import fs from "node:fs/promises";
import path from "node:path";
import { SqliteDatabase, type SqliteStatement } from "../sqlite-driver.js";
import { ensureSchema } from "./schema.js";

const readOrCreateDb = async (outputPath: string, options?: { readonly?: boolean }) => {
  const readonly = options?.readonly ?? false;
  const dir = path.dirname(outputPath);
  if (dir && !readonly) {
    await fs.mkdir(dir, { recursive: true });
  }
  const db = new SqliteDatabase(outputPath, {
    readonly,
  });
  return { db };
};

export async function withSqliteDatabase<T>(
  outputPath: string,
  callback: (db: SqliteDatabase) => T | Promise<T>,
): Promise<T> {
  const { db } = await readOrCreateDb(outputPath);
  try {
    ensureSchema(db);
    return await callback(db);
  } finally {
    db.close();
  }
}

export async function withReadOnlySqliteDatabase<T>(
  outputPath: string,
  callback: (db: SqliteDatabase) => T | Promise<T>,
): Promise<T> {
  const { db } = await readOrCreateDb(outputPath, { readonly: true });
  try {
    return await callback(db);
  } finally {
    db.close();
  }
}

export function assertReadOnlyQueryStatement(stmt: SqliteStatement): void {
  if (stmt.columns().length) return;
  throw new Error("Raw SQLite queries must be read-only result-producing statements such as SELECT or PRAGMA.");
}
