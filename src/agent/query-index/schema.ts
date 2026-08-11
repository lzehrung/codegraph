import { SqliteDatabase } from "../../sqlite-driver.js";
import { QUERY_INDEX_CHUNKER_VERSION, QUERY_INDEX_NORMALIZER_VERSION } from "./content.js";

export const QUERY_INDEX_SCHEMA_VERSION = 3;

export type QueryIndexMetadata = {
  schemaVersion: string;
  projectSnapshotIdentity: string;
  normalizerVersion: string;
  chunkerVersion: string;
  projectRootIdentity: string;
  createdByCodegraphVersion: string;
  updatedAt: string;
};

export class QueryIndexFutureSchemaError extends Error {
  constructor(version: number) {
    super(`Query index schema version ${version} is newer than supported version ${QUERY_INDEX_SCHEMA_VERSION}.`);
    this.name = "QueryIndexFutureSchemaError";
  }
}

export class QueryIndexSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryIndexSchemaError";
  }
}

const QUERY_INDEX_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS files (
  file_id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  source_identity TEXT NOT NULL,
  surface TEXT NOT NULL,
  language TEXT,
  normalized_text BLOB NOT NULL,
  byte_length INTEGER NOT NULL,
  line_count INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text BLOB NOT NULL,
  normalized_text TEXT NOT NULL,
  UNIQUE(file_id, ordinal)
) STRICT;

CREATE INDEX IF NOT EXISTS chunks_file_id_idx ON chunks(file_id);



CREATE VIRTUAL TABLE IF NOT EXISTS chunk_search USING fts5(
  normalized_text,
  content='chunks',
  content_rowid='chunk_id',
  tokenize='trigram'
);



CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunk_search(rowid, normalized_text) VALUES (new.chunk_id, new.normalized_text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunk_search(chunk_search, rowid, normalized_text)
  VALUES ('delete', old.chunk_id, old.normalized_text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunk_search(chunk_search, rowid, normalized_text)
  VALUES ('delete', old.chunk_id, old.normalized_text);
  INSERT INTO chunk_search(rowid, normalized_text) VALUES (new.chunk_id, new.normalized_text);
END;
`;

const REQUIRED_TABLES = ["metadata", "files", "chunks", "chunk_search"];

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function readQueryIndexSchemaVersion(db: SqliteDatabase): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  return numericValue(row?.user_version) ?? 0;
}

function existingQueryTables(db: SqliteDatabase): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name?: unknown }>;
  return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

function rebuildDerivedQueryIndexSchema(db: SqliteDatabase): void {
  db.transaction(() => {
    db.exec("DROP TRIGGER IF EXISTS files_ai;");
    db.exec("DROP TRIGGER IF EXISTS files_ad;");
    db.exec("DROP TRIGGER IF EXISTS files_au;");
    db.exec("DROP TRIGGER IF EXISTS chunks_ai;");
    db.exec("DROP TRIGGER IF EXISTS chunks_ad;");
    db.exec("DROP TRIGGER IF EXISTS chunks_au;");
    db.exec("DROP TABLE IF EXISTS file_search;");
    db.exec("DROP TABLE IF EXISTS chunk_search;");
    db.exec("DROP TABLE IF EXISTS chunks;");
    db.exec("DROP TABLE IF EXISTS files;");
    db.exec(QUERY_INDEX_SCHEMA_SQL);
    db.pragma(`user_version = ${QUERY_INDEX_SCHEMA_VERSION}`);
  })();
}

export function ensureQueryIndexSchema(db: SqliteDatabase): void {
  const version = readQueryIndexSchemaVersion(db);
  if (version > QUERY_INDEX_SCHEMA_VERSION) throw new QueryIndexFutureSchemaError(version);
  if (!version) {
    const existing = existingQueryTables(db);
    if (existing.size) {
      throw new QueryIndexSchemaError("Query index has tables but no recognized schema version.");
    }
    // Only takes effect before any tables exist; reclaims delete/rewrite churn via
    // cheap per-write PRAGMA incremental_vacuum instead of growing the file forever.
    db.pragma("auto_vacuum = INCREMENTAL");
    db.exec(QUERY_INDEX_SCHEMA_SQL);
    db.pragma(`user_version = ${QUERY_INDEX_SCHEMA_VERSION}`);
    return;
  }
  if (version === 1 || version === 2) {
    rebuildDerivedQueryIndexSchema(db);
  } else if (version < QUERY_INDEX_SCHEMA_VERSION) {
    throw new QueryIndexSchemaError(`Query index schema version ${version} has no supported migration.`);
  }
  const existing = existingQueryTables(db);
  const missing = REQUIRED_TABLES.filter((table) => !existing.has(table));
  if (missing.length) throw new QueryIndexSchemaError(`Query index schema is missing: ${missing.join(", ")}.`);
  db.pragma("foreign_keys = ON");
}

export function readQueryIndexMetadata(db: SqliteDatabase): Partial<QueryIndexMetadata> {
  const rows = db.prepare("SELECT key, value FROM metadata").all() as Array<{ key?: unknown; value?: unknown }>;
  const metadata: Partial<QueryIndexMetadata> = {};
  for (const row of rows) {
    if (typeof row.key !== "string" || typeof row.value !== "string") continue;
    if (
      row.key === "schemaVersion" ||
      row.key === "projectSnapshotIdentity" ||
      row.key === "normalizerVersion" ||
      row.key === "chunkerVersion" ||
      row.key === "projectRootIdentity" ||
      row.key === "createdByCodegraphVersion" ||
      row.key === "updatedAt"
    ) {
      metadata[row.key] = row.value;
    }
  }
  return metadata;
}

export function expectedQueryIndexVersionMetadata(): Pick<
  QueryIndexMetadata,
  "schemaVersion" | "normalizerVersion" | "chunkerVersion"
> {
  return {
    schemaVersion: String(QUERY_INDEX_SCHEMA_VERSION),
    normalizerVersion: String(QUERY_INDEX_NORMALIZER_VERSION),
    chunkerVersion: String(QUERY_INDEX_CHUNKER_VERSION),
  };
}

export function probeQueryIndexSqliteSupport(): { enableFts5: boolean; trigram: boolean } {
  const db = new SqliteDatabase(":memory:");
  try {
    const options = db.prepare("PRAGMA compile_options").all() as Array<{ compile_options?: unknown }>;
    const enableFts5 = options.some((row) => row.compile_options === "ENABLE_FTS5");
    db.exec("CREATE VIRTUAL TABLE probe_trigram USING fts5(text, tokenize='trigram')");
    db.prepare("INSERT INTO probe_trigram(text) VALUES (?)").run("persistent codegraph search");
    const row = db.prepare("SELECT count(*) AS count FROM probe_trigram WHERE probe_trigram MATCH ?").get("code") as
      { count?: unknown } | undefined;
    return { enableFts5, trigram: row?.count === 1 };
  } finally {
    db.close();
  }
}
