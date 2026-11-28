import { SqliteDatabase } from "../../sqlite-driver.js";
import { QUERY_INDEX_CHUNKER_VERSION, QUERY_INDEX_NORMALIZER_VERSION } from "./content.js";

export const QUERY_INDEX_SCHEMA_VERSION = 5;

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
  chunk_text BLOB NOT NULL,
  byte_length INTEGER NOT NULL,
  line_count INTEGER NOT NULL
) STRICT;

-- A chunk's text is the UTF-8 byte range [text_start, text_end) of its file's decompressed chunk_text.
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text_start INTEGER NOT NULL,
  text_end INTEGER NOT NULL,
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

-- Trigram index of each chunk's normalized text with its spaces removed, so a term that spans word boundaries is
-- found without scanning chunk text. It is case sensitive and keeps no content: every character of the compact text
-- is already lowercase and a hit must equal an exact substring of it.
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_compact_search USING fts5(
  compact_text,
  content='',
  contentless_delete=1,
  tokenize='trigram case_sensitive 1'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunk_search(rowid, normalized_text) VALUES (new.chunk_id, new.normalized_text);
  INSERT INTO chunk_compact_search(rowid, compact_text) VALUES (new.chunk_id, replace(new.normalized_text, ' ', ''));
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunk_search(chunk_search, rowid, normalized_text)
  VALUES ('delete', old.chunk_id, old.normalized_text);
  DELETE FROM chunk_compact_search WHERE rowid = old.chunk_id;
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunk_search(chunk_search, rowid, normalized_text)
  VALUES ('delete', old.chunk_id, old.normalized_text);
  INSERT INTO chunk_search(rowid, normalized_text) VALUES (new.chunk_id, new.normalized_text);
  DELETE FROM chunk_compact_search WHERE rowid = old.chunk_id;
  INSERT INTO chunk_compact_search(rowid, compact_text) VALUES (new.chunk_id, replace(new.normalized_text, ' ', ''));
END;
`;

const REQUIRED_TABLES = ["metadata", "files", "chunks", "chunk_search", "chunk_compact_search"];
const DERIVED_TRIGGERS = ["files_ai", "files_ad", "files_au", "chunks_ai", "chunks_ad", "chunks_au"];
const DERIVED_TABLES = ["file_search", "chunk_search", "chunk_compact_search", "chunks", "files"];

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

/**
 * An earlier schema's rows are never read as current rows: versions 1 and 2 lack derived columns, and versions 3 and 4
 * compress each chunk's text on its own where version 5 keeps one block per file. Their tables are dropped with the
 * metadata, so the next update prepares every file again and no reader matches its snapshot identity against the
 * emptied tables. The write lock is taken first so a second opener sees the finished rebuild instead of repeating it.
 * Returns whether this call dropped earlier rows.
 */
function rebuildDerivedQueryIndexSchema(db: SqliteDatabase): boolean {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const version = readQueryIndexSchemaVersion(db);
    const rebuilt = version > 0 && version < QUERY_INDEX_SCHEMA_VERSION;
    if (rebuilt) {
      for (const trigger of DERIVED_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger};`);
      for (const table of DERIVED_TABLES) db.exec(`DROP TABLE IF EXISTS ${table};`);
      db.exec(QUERY_INDEX_SCHEMA_SQL);
      db.exec("DELETE FROM metadata;");
      db.pragma(`user_version = ${QUERY_INDEX_SCHEMA_VERSION}`);
    }
    db.exec("COMMIT;");
    return rebuilt;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}

/** Opens the sidecar schema, creating it or rebuilding an earlier version's; returns whether earlier rows were dropped. */
export function ensureQueryIndexSchema(db: SqliteDatabase): boolean {
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
    return false;
  }
  const rebuilt = version < QUERY_INDEX_SCHEMA_VERSION && rebuildDerivedQueryIndexSchema(db);
  const existing = existingQueryTables(db);
  const missing = REQUIRED_TABLES.filter((table) => !existing.has(table));
  if (missing.length) throw new QueryIndexSchemaError(`Query index schema is missing: ${missing.join(", ")}.`);
  db.pragma("foreign_keys = ON");
  return rebuilt;
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
      | { count?: unknown }
      | undefined;
    return { enableFts5, trigram: row?.count === 1 };
  } finally {
    db.close();
  }
}
