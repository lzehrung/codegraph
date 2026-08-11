import type { SqliteDatabase } from "../sqlite-driver.js";
import { toSqliteText } from "./common.js";

export const SQLITE_SCHEMA_VERSION = 2;
const GRAPH_SCHEMA_VERSION_KEY = "schema_version";

const hasColumn = (db: SqliteDatabase, table: string, column: string): boolean => {
  const rows = db.prepare(`PRAGMA table_info(${table});`).raw().all();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const name = row[1] ? String(row[1]) : "";
    if (name === column) return true;
  }
  return false;
};

const ensureSymbolsVisibilityColumn = (db: SqliteDatabase) => {
  if (hasColumn(db, "symbols", "visibility")) return;
  db.exec("ALTER TABLE symbols ADD COLUMN visibility TEXT;");
};

export function readGraphSchemaVersion(db: SqliteDatabase): number {
  try {
    const row = db.prepare("SELECT value FROM graph_metadata WHERE key = ?").get(GRAPH_SCHEMA_VERSION_KEY) as
      { value?: unknown } | undefined;
    if (!row?.value) return 0;
    const version = Number(String(row.value));
    if (!Number.isInteger(version) || version < 0) return 0;
    return version;
  } catch {
    return 0;
  }
}

function writeGraphSchemaVersion(db: SqliteDatabase, version: number): void {
  db.prepare("INSERT OR REPLACE INTO graph_metadata (key, value) VALUES (?, ?);").run([
    GRAPH_SCHEMA_VERSION_KEY,
    String(version),
  ]);
}

function migrateGraphSchema(db: SqliteDatabase, fromVersion: number): void {
  let version = fromVersion;
  if (version < 1) {
    version = 1;
  }
  if (version < 2) {
    ensureSymbolsVisibilityColumn(db);
    version = 2;
  }
  if (version !== fromVersion) {
    writeGraphSchemaVersion(db, version);
  }
}

const ensureGraphIndexes = (db: SqliteDatabase): boolean => {
  const indexSpecs: Array<{ name: string; sql: string }> = [
    {
      name: "idx_files_external",
      sql: "CREATE INDEX idx_files_external ON files(is_external);",
    },
    {
      name: "idx_symbols_file",
      sql: "CREATE INDEX idx_symbols_file ON symbols(file);",
    },
    {
      name: "idx_symbols_name",
      sql: "CREATE INDEX idx_symbols_name ON symbols(name);",
    },
    {
      name: "idx_symbols_lower_name",
      sql: "CREATE INDEX idx_symbols_lower_name ON symbols(lower(name));",
    },
    {
      name: "idx_symbols_kind",
      sql: "CREATE INDEX idx_symbols_kind ON symbols(kind);",
    },
    {
      name: "idx_symbols_name_kind",
      sql: "CREATE INDEX idx_symbols_name_kind ON symbols(name, kind);",
    },
    {
      name: "idx_symbols_file_kind",
      sql: "CREATE INDEX idx_symbols_file_kind ON symbols(file, kind);",
    },
    {
      name: "idx_symbols_kind_file",
      sql: "CREATE INDEX idx_symbols_kind_file ON symbols(kind, file);",
    },
    {
      name: "idx_symbols_kind_id",
      sql: "CREATE INDEX idx_symbols_kind_id ON symbols(kind, id);",
    },
    {
      name: "idx_symbols_kind_complexity",
      sql: "CREATE INDEX idx_symbols_kind_complexity ON symbols(kind, complexity DESC);",
    },
    {
      name: "idx_file_edges_from",
      sql: "CREATE INDEX idx_file_edges_from ON file_edges(from_path);",
    },
    {
      name: "idx_file_edges_to",
      sql: "CREATE INDEX idx_file_edges_to ON file_edges(to_path);",
    },
    {
      name: "idx_file_edges_type",
      sql: "CREATE INDEX idx_file_edges_type ON file_edges(to_type);",
    },
    {
      name: "idx_file_edges_from_file",
      sql: "CREATE INDEX idx_file_edges_from_file ON file_edges(from_path, to_path) WHERE to_type = 'file';",
    },
    {
      name: "idx_file_edges_to_file",
      sql: "CREATE INDEX idx_file_edges_to_file ON file_edges(to_path, from_path) WHERE to_type = 'file';",
    },
    {
      name: "idx_symbol_edges_from",
      sql: "CREATE INDEX idx_symbol_edges_from ON symbol_edges(from_id);",
    },
    {
      name: "idx_symbol_edges_to",
      sql: "CREATE INDEX idx_symbol_edges_to ON symbol_edges(to_id);",
    },
    {
      name: "idx_symbol_edges_label",
      sql: "CREATE INDEX idx_symbol_edges_label ON symbol_edges(label);",
    },
    {
      name: "idx_symbol_edges_label_to",
      sql: "CREATE INDEX idx_symbol_edges_label_to ON symbol_edges(label, to_id);",
    },
    {
      name: "idx_symbol_edges_label_from",
      sql: "CREATE INDEX idx_symbol_edges_label_from ON symbol_edges(label, from_id);",
    },
    {
      name: "idx_symbol_edges_label_from_to",
      sql: "CREATE INDEX idx_symbol_edges_label_from_to ON symbol_edges(label, from_id, to_id);",
    },
    {
      name: "idx_graph_snapshots_created_at",
      sql: "CREATE INDEX idx_graph_snapshots_created_at ON graph_snapshots(created_at DESC);",
    },
    {
      name: "idx_graph_snapshot_files_snapshot",
      sql: "CREATE INDEX idx_graph_snapshot_files_snapshot ON graph_snapshot_files(snapshot_id);",
    },
    {
      name: "idx_graph_snapshot_files_path",
      sql: "CREATE INDEX idx_graph_snapshot_files_path ON graph_snapshot_files(file_path);",
    },
  ];

  const indexRows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%';")
    .raw()
    .all() as Array<Array<unknown>>;
  const existingIndexes = new Set<string>();
  for (const row of indexRows) {
    if (!Array.isArray(row)) continue;
    const name = toSqliteText(row[0]);
    if (name) existingIndexes.add(name);
  }

  let createdIndex = false;
  for (const spec of indexSpecs) {
    if (existingIndexes.has(spec.name)) continue;
    db.exec(spec.sql);
    createdIndex = true;
  }

  if (createdIndex) {
    db.exec("ANALYZE;");
  }
  return createdIndex;
};

export const ensureSchema = (db: SqliteDatabase) => {
  const currentVersion = readGraphSchemaVersion(db);
  if (currentVersion > SQLITE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported codegraph SQLite schema version ${currentVersion}; this version supports up to ${SQLITE_SCHEMA_VERSION}.`,
    );
  }

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      is_external INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS symbols (
      id TEXT PRIMARY KEY,
      file TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT,
      docstring TEXT,
      line_span INTEGER,
      complexity INTEGER,
      visibility TEXT,
      FOREIGN KEY(file) REFERENCES files(path)
    );
    CREATE TABLE IF NOT EXISTS file_edges (
      from_path TEXT NOT NULL,
      to_path TEXT NOT NULL,
      to_type TEXT NOT NULL,
      raw TEXT,
      type_only INTEGER,
      FOREIGN KEY(from_path) REFERENCES files(path),
      FOREIGN KEY(to_path) REFERENCES files(path)
    );
    CREATE TABLE IF NOT EXISTS symbol_edges (
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      label TEXT,
      FOREIGN KEY(from_id) REFERENCES symbols(id),
      FOREIGN KEY(to_id) REFERENCES symbols(id)
    );
    CREATE TABLE IF NOT EXISTS graph_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS graph_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      mode TEXT NOT NULL,
      changed_files INTEGER NOT NULL,
      deleted_files INTEGER NOT NULL,
      file_nodes INTEGER NOT NULL,
      file_edges INTEGER NOT NULL,
      symbol_nodes INTEGER NOT NULL,
      symbol_edges INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS graph_snapshot_files (
      snapshot_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      change_kind TEXT NOT NULL,
      FOREIGN KEY(snapshot_id) REFERENCES graph_snapshots(id)
    );
  `);

  migrateGraphSchema(db, currentVersion);
  ensureGraphIndexes(db);
  writeGraphSchemaVersion(db, SQLITE_SCHEMA_VERSION);
};
