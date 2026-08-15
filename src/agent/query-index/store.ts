import type { PreparedQueryIndexFile, QueryTextChunk } from "./content.js";
import { SqliteDatabase } from "../../sqlite-driver.js";
import { brotliDecompressSync } from "node:zlib";
import {
  ensureQueryIndexSchema,
  expectedQueryIndexVersionMetadata,
  readQueryIndexMetadata,
  type QueryIndexMetadata,
} from "./schema.js";

export const QUERY_INDEX_BUSY_TIMEOUT_MS = 250;

/** Final cap on hydrated query-index candidates passed into scoring. */
export const QUERY_INDEX_CANDIDATE_ROW_LIMIT = 2000;

/** Overfetch before applying the final cap so later, higher-quality matches can survive
 * path-ordered SQL reads and be kept once we do cheap in-memory ranking. */
const QUERY_INDEX_CANDIDATE_PREFETCH_LIMIT = QUERY_INDEX_CANDIDATE_ROW_LIMIT * 4;

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function escapeFtsTrigramTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

function normalizedCandidateLimit(limit: number, fallback = QUERY_INDEX_CANDIDATE_PREFETCH_LIMIT): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(0, Math.min(Math.trunc(limit), QUERY_INDEX_CANDIDATE_PREFETCH_LIMIT));
}

export type StoredQueryIndexChunk = QueryTextChunk & {
  path: string;
};

export class QueryIndexStaleError extends Error {
  constructor() {
    super("Query index identity does not match the loaded project snapshot.");
    this.name = "QueryIndexStaleError";
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

export function isSqliteBusyError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
  return error instanceof Error && /database is (?:busy|locked)/iu.test(error.message);
}

export function isSqliteCorruptionError(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") return true;
  return (
    error instanceof Error && /(?:malformed|not a database|database disk image is malformed)/iu.test(error.message)
  );
}

function numericId(value: number | bigint): number {
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new Error(`Invalid SQLite row id: ${String(value)}`);
  return numeric;
}

function chunkFromRow(row: Record<string, unknown>): QueryTextChunk | null {
  const ordinal = row.ordinal;
  const kind = row.kind;
  const name = row.name;
  const text = row.text;
  const normalizedText = row.normalized_text;
  const startLine = row.start_line;
  const endLine = row.end_line;
  if (
    typeof ordinal !== "number" ||
    typeof kind !== "string" ||
    (name !== null && typeof name !== "string") ||
    typeof text !== "string" ||
    typeof normalizedText !== "string" ||
    typeof startLine !== "number" ||
    typeof endLine !== "number"
  ) {
    return null;
  }
  return {
    ordinal,
    kind,
    ...(typeof name === "string" ? { name } : {}),
    text,
    normalizedText,
    startLine,
    endLine,
  };
}

function storedCandidateChunkFromRow(row: Record<string, unknown>): StoredQueryIndexChunk | null {
  if (typeof row.path !== "string" || !(row.text instanceof Uint8Array)) return null;
  try {
    const text = brotliDecompressSync(row.text).toString("utf8");
    const chunk = chunkFromRow({ ...row, text });
    return chunk ? { ...chunk, path: row.path } : null;
  } catch {
    return null;
  }
}

export class QueryIndexStore {
  private readonly db: SqliteDatabase;
  private closed = false;
  private normalizedFiles: Map<string, string> | undefined;

  constructor(readonly filePath: string) {
    const db = new SqliteDatabase(filePath, { timeout: QUERY_INDEX_BUSY_TIMEOUT_MS });
    this.db = db;
    try {
      ensureQueryIndexSchema(db);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.pragma("foreign_keys = ON");
    } catch (error) {
      db.close();
      throw error;
    }
  }

  metadata(): Partial<QueryIndexMetadata> {
    return readQueryIndexMetadata(this.db);
  }

  assertReadable(): void {
    this.db.prepare("SELECT count(*) AS count FROM chunk_search").get();
  }

  sourceIdentities(): Map<string, string> {
    const rows = this.db.prepare("SELECT path, source_identity FROM files ORDER BY path").all() as Array<{
      path?: unknown;
      source_identity?: unknown;
    }>;
    const identities = new Map<string, string>();
    for (const row of rows) {
      if (typeof row.path === "string" && typeof row.source_identity === "string") {
        identities.set(row.path, row.source_identity);
      }
    }
    return identities;
  }
  /**
   * Files whose normalized text plausibly contains at least one of the given terms.
   * Terms of 3+ codepoints are resolved through the trigram FTS index (same substring
   * semantics as `ftsChunkCandidates`, but indexed instead of scanning every file); only
   * terms too short for the trigram tokenizer fall back to decompressing and scanning
   * file text directly, and only for those short terms.
   */
  eligibleFilePaths(normalizedTerms: readonly string[]): string[] {
    if (!normalizedTerms.length) return [];
    const paths = new Set<string>();
    const shortTerms: string[] = [];
    for (const term of normalizedTerms) {
      if (codePointLength(term) < 3) {
        shortTerms.push(term);
        continue;
      }
      const rows = this.db
        .prepare(
          `
          SELECT DISTINCT files.path AS path
          FROM chunk_search
          JOIN chunks ON chunks.chunk_id = chunk_search.rowid
          JOIN files ON files.file_id = chunks.file_id
          WHERE chunk_search MATCH ?
        `,
        )
        .all(escapeFtsTrigramTerm(term)) as Array<{ path?: unknown }>;
      for (const row of rows) {
        if (typeof row.path === "string") paths.add(row.path);
      }
    }
    if (shortTerms.length) {
      if (!this.normalizedFiles) {
        const rows = this.db.prepare("SELECT path, normalized_text FROM files ORDER BY path").all() as Array<{
          path?: unknown;
          normalized_text?: unknown;
        }>;
        const normalizedFiles = new Map<string, string>();
        for (const row of rows) {
          if (typeof row.path !== "string" || !(row.normalized_text instanceof Uint8Array)) {
            throw new Error("Invalid query index file normalization.");
          }
          normalizedFiles.set(row.path, brotliDecompressSync(row.normalized_text).toString("utf8"));
        }
        this.normalizedFiles = normalizedFiles;
      }
      for (const [file, normalizedText] of this.normalizedFiles) {
        if (shortTerms.some((term) => normalizedText.includes(term))) paths.add(file);
      }
    }
    return [...paths].sort((left, right) => left.localeCompare(right));
  }

  replaceFiles(
    files: readonly PreparedQueryIndexFile[],
    deletedPaths: readonly string[],
    metadata: QueryIndexMetadata,
  ): "committed" | "already-current" {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const current = readQueryIndexMetadata(this.db);
      const expectedVersions = expectedQueryIndexVersionMetadata();
      if (
        current.projectSnapshotIdentity === metadata.projectSnapshotIdentity &&
        current.projectRootIdentity === metadata.projectRootIdentity &&
        current.schemaVersion === expectedVersions.schemaVersion &&
        current.normalizerVersion === expectedVersions.normalizerVersion &&
        current.chunkerVersion === expectedVersions.chunkerVersion
      ) {
        this.db.exec("ROLLBACK;");
        return "already-current";
      }

      const deleteFile = this.db.prepare("DELETE FROM files WHERE path = ?");
      for (const relativePath of deletedPaths) deleteFile.run(relativePath);
      for (const file of files) deleteFile.run(file.path);

      const insertFile = this.db.prepare(`
        INSERT INTO files(path, source_identity, surface, language, normalized_text, byte_length, line_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertChunk = this.db.prepare(`
        INSERT INTO chunks(file_id, ordinal, kind, name, start_line, end_line, text, normalized_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const file of files) {
        const inserted = insertFile.run(
          file.path,
          file.sourceIdentity,
          file.surface,
          file.language ?? null,
          file.normalizedText,
          file.byteLength,
          file.lineCount,
        );
        const fileId = numericId(inserted.lastInsertRowid);
        for (const chunk of file.chunks) {
          insertChunk.run(
            fileId,
            chunk.ordinal,
            chunk.kind,
            chunk.name ?? null,
            chunk.startLine,
            chunk.endLine,
            chunk.text,
            chunk.normalizedText,
          );
        }
      }

      const upsertMetadata = this.db.prepare(`
        INSERT INTO metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      for (const [key, value] of Object.entries(metadata)) upsertMetadata.run(key, value);
      this.db.exec("COMMIT;");
      this.normalizedFiles = undefined;
      this.reclaimFreeSpace();
      return "committed";
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Preserve the original write failure.
      }
      throw error;
    }
  }

  /**
   * Reclaims pages freed by deletes/rewrites so the sidecar does not grow unbounded.
   * Incremental auto-vacuum (set in the constructor) makes this a cheap per-write
   * PRAGMA once enabled; sidecars created before that switch to it here the first time
   * accumulated free space crosses a threshold worth a one-time full VACUUM.
   */
  private reclaimFreeSpace(): void {
    try {
      const mode = (this.db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | undefined)?.auto_vacuum;
      if (mode === 2) {
        this.db.exec("PRAGMA incremental_vacuum;");
        return;
      }
      const freelist =
        (this.db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined)?.freelist_count ??
        0;
      const pages =
        (this.db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined)?.page_count ?? 0;
      if (pages > 0 && freelist / pages > 0.15) {
        this.db.pragma("auto_vacuum = INCREMENTAL");
        this.db.exec("VACUUM;");
      }
    } catch {
      // Best-effort maintenance; never block a write on it.
    }
  }

  withReadSnapshot<T>(projectSnapshotIdentity: string, read: () => T): T {
    this.db.exec("BEGIN;");
    try {
      if (this.metadata().projectSnapshotIdentity !== projectSnapshotIdentity) throw new QueryIndexStaleError();
      const result = read();
      if (this.metadata().projectSnapshotIdentity !== projectSnapshotIdentity) throw new QueryIndexStaleError();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {
        // Preserve the original read failure.
      }
      throw error;
    }
  }

  candidateChunksForTerms(terms: readonly string[], paths: readonly string[]): StoredQueryIndexChunk[] {
    if (!terms.length || !paths.length) return [];
    const ftsTerms = terms.filter((term) => codePointLength(term) >= 3);
    const directTerms = terms.filter((term) => codePointLength(term) < 3);
    const conditions: string[] = [];
    const directParameters: string[] = [];
    if (ftsTerms.length) {
      conditions.push("chunks.chunk_id IN (SELECT rowid FROM fts_matches)");
    }
    for (const term of directTerms) {
      conditions.push("instr(chunks.normalized_text, ?) > 0");
      directParameters.push(term);
    }
    for (const term of terms) {
      conditions.push("instr(replace(chunks.normalized_text, ' ', ''), ?) > 0");
      directParameters.push(term);
    }
    const ftsQuery = ftsTerms.map(escapeFtsTrigramTerm).join(" OR ");
    const prefix = ftsTerms.length
      ? "WITH fts_matches AS (SELECT rowid FROM chunk_search WHERE chunk_search MATCH ?)"
      : "";
    const candidates = new Map<string, StoredQueryIndexChunk>();
    const batchSize = 500;
    for (let offset = 0; offset < paths.length; offset += batchSize) {
      const batch = paths.slice(offset, offset + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `
          ${prefix}
          SELECT files.path AS path, chunks.ordinal, chunks.kind, chunks.name,
                 chunks.start_line, chunks.end_line, chunks.text, chunks.normalized_text
          FROM chunks
          JOIN files ON files.file_id = chunks.file_id
          WHERE files.path IN (${placeholders})
            AND (${conditions.join(" OR ")})
          ORDER BY files.path, chunks.ordinal
        `,
        )
        .all(
          ...(ftsTerms.length ? [ftsQuery, ...batch, ...directParameters] : [...batch, ...directParameters]),
        ) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const chunk = storedCandidateChunkFromRow(row);
        if (chunk) candidates.set(`${chunk.path}\0${chunk.ordinal}`, chunk);
      }
    }
    return [...candidates.values()];
  }

  ftsChunkCandidates(query: string, limit = QUERY_INDEX_CANDIDATE_PREFETCH_LIMIT): StoredQueryIndexChunk[] {
    const normalizedLimit = normalizedCandidateLimit(limit);
    const rows = this.db
      .prepare(
        `
        SELECT files.path AS path, chunks.ordinal, chunks.kind, chunks.name,
               chunks.start_line, chunks.end_line, chunks.text, chunks.normalized_text
        FROM chunk_search
        JOIN chunks ON chunks.chunk_id = chunk_search.rowid
        JOIN files ON files.file_id = chunks.file_id
        WHERE chunk_search MATCH ?
        ORDER BY files.path, chunks.ordinal
        LIMIT ?
      `,
      )
      .all(query, normalizedLimit) as Array<Record<string, unknown>>;
    return rows.flatMap((row) => {
      const chunk = storedCandidateChunkFromRow(row);
      return chunk ? [chunk] : [];
    });
  }

  substringChunkCandidates(
    query: string,
    paths: readonly string[],
    limit = QUERY_INDEX_CANDIDATE_PREFETCH_LIMIT,
  ): StoredQueryIndexChunk[] {
    const normalizedLimit = normalizedCandidateLimit(limit);
    const candidates: StoredQueryIndexChunk[] = [];
    const batchSize = 500;
    for (let offset = 0; offset < paths.length; offset += batchSize) {
      const batch = paths.slice(offset, offset + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      const remaining = normalizedLimit - candidates.length;
      if (remaining <= 0) break;
      const rows = this.db
        .prepare(
          `
          SELECT files.path AS path, chunks.ordinal, chunks.kind, chunks.name,
                 chunks.start_line, chunks.end_line, chunks.text, chunks.normalized_text
          FROM chunks
          JOIN files ON files.file_id = chunks.file_id
          WHERE files.path IN (${placeholders})
            AND instr(chunks.normalized_text, ?) > 0
          ORDER BY files.path, chunks.ordinal
          LIMIT ?
        `,
        )
        .all(...batch, query, remaining) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const chunk = storedCandidateChunkFromRow(row);
        if (chunk) candidates.push(chunk);
        if (candidates.length >= normalizedLimit) break;
      }
      if (candidates.length >= normalizedLimit) break;
    }
    return candidates;
  }

  compactChunkCandidates(
    query: string,
    paths: readonly string[],
    limit = QUERY_INDEX_CANDIDATE_PREFETCH_LIMIT,
  ): StoredQueryIndexChunk[] {
    const normalizedLimit = normalizedCandidateLimit(limit);
    const candidates: StoredQueryIndexChunk[] = [];
    const batchSize = 500;
    for (let offset = 0; offset < paths.length; offset += batchSize) {
      const batch = paths.slice(offset, offset + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      const remaining = normalizedLimit - candidates.length;
      if (remaining <= 0) break;
      const rows = this.db
        .prepare(
          `
          SELECT files.path AS path, chunks.ordinal, chunks.kind, chunks.name,
                 chunks.start_line, chunks.end_line, chunks.text, chunks.normalized_text
          FROM chunks
          JOIN files ON files.file_id = chunks.file_id
          WHERE files.path IN (${placeholders})
            AND instr(replace(chunks.normalized_text, ' ', ''), ?) > 0
          ORDER BY files.path, chunks.ordinal
          LIMIT ?
        `,
        )
        .all(...batch, query, remaining) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const chunk = storedCandidateChunkFromRow(row);
        if (chunk) candidates.push(chunk);
        if (candidates.length >= normalizedLimit) break;
      }
      if (candidates.length >= normalizedLimit) break;
    }
    return candidates;
  }
  checkpoint(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
