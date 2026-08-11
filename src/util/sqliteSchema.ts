import { SqliteDatabase } from "../sqlite-driver.js";

export type SqliteSchemaVersion = { status: "missing" } | { status: "invalid" } | { status: "ok"; version: number };

export type SqliteTableColumn = {
  name: string;
  definition: string;
};

function quoteSqliteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQLite identifier "${identifier}".`);
  }
  return `"${identifier}"`;
}

export function ensureSqliteSchemaMetadataTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_schema_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function createSqliteTableIfMissing(
  db: SqliteDatabase,
  tableName: string,
  columns: readonly SqliteTableColumn[],
  tableConstraints: readonly string[] = [],
): void {
  const columnSql = columns.map((column) => `${quoteSqliteIdentifier(column.name)} ${column.definition}`);
  const statements = [...columnSql, ...tableConstraints];
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${quoteSqliteIdentifier(tableName)} (
      ${statements.join(",\n      ")}
    );
  `);
}

export function recreateSqliteTable(
  db: SqliteDatabase,
  tableName: string,
  createTable: (db: SqliteDatabase) => void,
): void {
  db.exec(`DROP TABLE IF EXISTS ${quoteSqliteIdentifier(tableName)};`);
  createTable(db);
}

export function readSqliteSchemaVersion(db: SqliteDatabase, key: string): SqliteSchemaVersion {
  const row = db.prepare("SELECT value FROM cache_schema_metadata WHERE key = ?").get(key) as
    { value?: unknown } | undefined;
  if (!row) return { status: "missing" };
  if (typeof row.value !== "string") return { status: "invalid" };
  const version = Number(row.value);
  if (!Number.isInteger(version) || version < 0) return { status: "invalid" };
  return { status: "ok", version };
}

export function writeSqliteSchemaVersion(db: SqliteDatabase, key: string, version: number): void {
  db.prepare(
    `INSERT INTO cache_schema_metadata (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(version));
}

export function ensureSqliteVersionedTableSchema(args: {
  db: SqliteDatabase;
  tableName: string;
  schemaVersionKey: string;
  schemaVersion: number;
  createTable: (db: SqliteDatabase) => void;
  migrateTable: (db: SqliteDatabase) => void;
}): void {
  ensureSqliteSchemaMetadataTable(args.db);
  const schemaVersion = readSqliteSchemaVersion(args.db, args.schemaVersionKey);
  if (
    schemaVersion.status === "invalid" ||
    (schemaVersion.status === "ok" && schemaVersion.version > args.schemaVersion)
  ) {
    recreateSqliteTable(args.db, args.tableName, args.createTable);
  } else {
    args.migrateTable(args.db);
  }
  writeSqliteSchemaVersion(args.db, args.schemaVersionKey, args.schemaVersion);
}

export function sqliteTableColumns(db: SqliteDatabase, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`).all() as Array<{ name?: unknown }>;
  const columns = new Set<string>();
  for (const row of rows) {
    if (typeof row.name === "string") columns.add(row.name);
  }
  return columns;
}
