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

/** With 500 paths and LIMIT, 128 two-parameter predicates stay below even SQLite's
 * legacy 999-variable limit and its 1000-level expression-depth limit. */
const QUERY_INDEX_INLINE_TERM_LIMIT = 128;

/**
 * Eligible files are read in batches of this many, in the order given. The candidate cap and its lower-bound flag
 * depend on where a batch ends, so retrieval keeps the batches, however many statements it reads them with.
 */
export const QUERY_INDEX_PATH_BATCH_SIZE = 500;

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function supportsFtsTrigramTerm(term: string): boolean {
  return codePointLength(term) >= 3 && isAscii(term);
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

export type QueryIndexCandidateRetrieval = {
  chunks: StoredQueryIndexChunk[];
  totalCandidatesLowerBound: boolean;
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

/**
 * The files a retrieval reads, batch after batch: the stored files among the eligible paths, each batch in path order.
 */
type PathBatchPlan = {
  /** The stored file ids of each batch that holds any. */
  batches: ReadonlyArray<readonly number[]>;
  /** The same ids as a JSON array of arrays for `json_each`. */
  batchesJson: string;
  /** The batch number of each of those arrays; a batch that holds no stored file has none. */
  batchNumbers: readonly number[];
};

/** The batches of `paths` that list each file. A file listed in two batches is read in both, as separate reads would. */
function pathBatches(paths: readonly string[], batchSize: number): Map<string, number[]> {
  const batches = new Map<string, number[]>();
  paths.forEach((path, position) => {
    const batch = Math.floor(position / batchSize);
    const listed = batches.get(path);
    if (!listed) batches.set(path, [batch]);
    else if (listed[listed.length - 1] !== batch) listed.push(batch);
  });
  return batches;
}

/** Raised when a candidate read hands rows back in an order its statement does not get from SQL. */
class QueryIndexReadOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryIndexReadOrderError";
  }
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

/**
 * The chunk ids of one batch's read, from the JSON its statement builds. The read relies on the files coming in the
 * order they were listed and a file's chunks in ordinal order, which no ORDER BY promises, so each chunk carries the
 * position of its file and its ordinal and the whole read is checked before any of it is used. The last row is one
 * past what any use of the read needs: it is what shows the order inside the file the used rows end in, when that
 * file holds more matches than the read does.
 */
function chunkIdsOfBatchRead(text: string): number[] {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("chunks" in parsed) ||
    !("files" in parsed) ||
    !("ordinals" in parsed)
  ) {
    throw new Error("Invalid query index batch read.");
  }
  const { chunks, files, ordinals } = parsed;
  if (!isNumberArray(chunks) || !isNumberArray(files) || !isNumberArray(ordinals)) {
    throw new Error("Invalid query index batch read.");
  }
  if (files.length !== chunks.length || ordinals.length !== chunks.length) {
    throw new Error("Invalid query index batch read.");
  }
  for (let index = 1; index < chunks.length; index += 1) {
    const file = files[index]!;
    const previousFile = files[index - 1]!;
    if (file < previousFile || (file === previousFile && ordinals[index]! <= ordinals[index - 1]!)) {
      throw new QueryIndexReadOrderError("Query index chunks arrived out of read order.");
    }
  }
  return chunks;
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

const MAX_NORMALIZED_FILES_CACHE_ENTRIES = 2_048;
const MAX_NORMALIZED_FILES_CACHE_BYTES = 16 * 1024 * 1024;

export class QueryIndexStore {
  private readonly db: SqliteDatabase;
  private closed = false;
  private normalizedFiles: Map<string, string> | undefined;
  private normalizedFilesMetadataKey: string | undefined;
  private readOrderFallbackCount = 0;

  /** Whether `close()` has run. Lets callers check lifecycle without touching internals. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * How many candidate reads gave up the streamed read for ordered statements because SQLite returned rows in another
   * order. It stays zero unless the SQLite build or its planner breaks the order the streamed read relies on.
   */
  get readOrderFallbacks(): number {
    return this.readOrderFallbackCount;
  }
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

  /** Connection-level pragmas applied when this store opens its handle. */
  runtimePragmas(): { journalMode: string; synchronous: number; foreignKeys: number } {
    const journalMode = (this.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined)
      ?.journal_mode;
    const synchronous = (this.db.prepare("PRAGMA synchronous").get() as { synchronous?: unknown } | undefined)
      ?.synchronous;
    const foreignKeys = (this.db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: unknown } | undefined)
      ?.foreign_keys;
    if (typeof journalMode !== "string" || typeof synchronous !== "number" || typeof foreignKeys !== "number") {
      throw new Error("Query index connection pragmas are unavailable.");
    }
    return { journalMode, synchronous, foreignKeys };
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
   * ASCII terms of 3+ codepoints use the trigram FTS index; short and non-ASCII
   * terms scan normalized text because SQLite's trigram tokenizer is ASCII-only.
   */
  eligibleFilePaths(normalizedTerms: readonly string[]): string[] {
    if (!normalizedTerms.length) return [];
    const paths = new Set<string>();
    const matchedFileIds = new Set<number>();
    const shortTerms: string[] = [];
    for (const term of normalizedTerms) {
      if (codePointLength(term) < 3 || !isAscii(term)) {
        shortTerms.push(term);
        continue;
      }
      const rows = this.db
        .prepare(
          `
          SELECT DISTINCT chunks.file_id AS file_id
          FROM chunk_search
          JOIN chunks ON chunks.chunk_id = chunk_search.rowid
          WHERE chunk_search MATCH ?
        `,
        )
        .all(escapeFtsTrigramTerm(term)) as Array<{ file_id?: unknown }>;
      for (const row of rows) {
        if (typeof row.file_id === "number") matchedFileIds.add(row.file_id);
      }
    }
    if (matchedFileIds.size) {
      // Paths are read once for every matching file rather than joined to each matching chunk.
      for (const row of this.db.prepare("SELECT file_id, path FROM files").all() as Array<Record<string, unknown>>) {
        if (typeof row.file_id === "number" && typeof row.path === "string" && matchedFileIds.has(row.file_id)) {
          paths.add(row.path);
        }
      }
    }
    if (shortTerms.length) {
      const metadata = readQueryIndexMetadata(this.db);
      const metadataKey = [
        metadata.projectSnapshotIdentity ?? "",
        metadata.projectRootIdentity ?? "",
        metadata.schemaVersion ?? "",
        metadata.normalizerVersion ?? "",
        metadata.chunkerVersion ?? "",
      ].join("\0");
      if (this.normalizedFilesMetadataKey !== metadataKey) {
        this.normalizedFiles = undefined;
        this.normalizedFilesMetadataKey = metadataKey;
      }
      let normalizedFiles = this.normalizedFiles;
      if (!normalizedFiles) {
        const rows = this.db.prepare("SELECT path, normalized_text FROM files ORDER BY path").all() as Array<{
          path?: unknown;
          normalized_text?: unknown;
        }>;
        normalizedFiles = new Map<string, string>();
        let cachedBytes = 0;
        for (const row of rows) {
          if (typeof row.path !== "string" || !(row.normalized_text instanceof Uint8Array)) {
            throw new Error("Invalid query index file normalization.");
          }
          const normalizedText = brotliDecompressSync(row.normalized_text).toString("utf8");
          normalizedFiles.set(row.path, normalizedText);
          cachedBytes += Buffer.byteLength(normalizedText, "utf8");
        }
        if (
          normalizedFiles.size <= MAX_NORMALIZED_FILES_CACHE_ENTRIES &&
          cachedBytes <= MAX_NORMALIZED_FILES_CACHE_BYTES
        ) {
          this.normalizedFiles = normalizedFiles;
        }
      }
      for (const [file, normalizedText] of normalizedFiles) {
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
      this.normalizedFilesMetadataKey = undefined;
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

  /**
   * Lays out the files the batches of `paths` read. A path listed twice in one batch is read once there; one listed in
   * two batches is read in both, as separate reads of each batch would.
   */
  private planPathBatches(paths: readonly string[]): PathBatchPlan {
    const batchesOfPath = pathBatches(paths, QUERY_INDEX_PATH_BATCH_SIZE);
    const fileIdsOfBatch = new Map<number, number[]>();
    // Stored files come in the order SQLite sorts their paths in, which is the order a batch reads its files in.
    const stored = this.db.prepare("SELECT file_id, path FROM files ORDER BY path").raw().all() as unknown[][];
    for (const [fileId, path] of stored) {
      if (typeof fileId !== "number" || typeof path !== "string") continue;
      for (const batch of batchesOfPath.get(path) ?? []) {
        const fileIds = fileIdsOfBatch.get(batch);
        if (fileIds) fileIds.push(fileId);
        else fileIdsOfBatch.set(batch, [fileId]);
      }
    }
    const batchNumbers = [...fileIdsOfBatch.keys()].sort((left, right) => left - right);
    const batches = batchNumbers.map((batch) => fileIdsOfBatch.get(batch) ?? []);
    return { batches, batchesJson: JSON.stringify(batches), batchNumbers };
  }

  /** The stored rows of the given chunks, by chunk id. */
  private chunkRowsById(chunkIds: readonly number[]): Map<number, Record<string, unknown>> {
    const rowsById = new Map<number, Record<string, unknown>>();
    if (!chunkIds.length) return rowsById;
    const rows = this.db
      .prepare(
        `
        SELECT chunks.chunk_id AS chunk_id, files.path AS path, chunks.ordinal, chunks.kind, chunks.name,
               chunks.start_line, chunks.end_line, chunks.text, chunks.normalized_text
        FROM chunks
        JOIN files ON files.file_id = chunks.file_id
        WHERE chunks.chunk_id IN (SELECT value FROM json_each(?))
      `,
      )
      .all(JSON.stringify(chunkIds)) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (typeof row.chunk_id === "number") rowsById.set(row.chunk_id, row);
    }
    return rowsById;
  }

  /**
   * The chunks that match the terms in the eligible files, read pass by pass (the phrase, every term together, then
   * each term alone) in batches of 500 files, each pass kept up to its cap.
   */
  candidateChunkRetrievalForTerms(
    terms: readonly string[],
    paths: readonly string[],
    normalizedRankPhrase: string,
    limit = QUERY_INDEX_CANDIDATE_PREFETCH_LIMIT,
  ): QueryIndexCandidateRetrieval {
    if (!terms.length || !paths.length) {
      return { chunks: [], totalCandidatesLowerBound: false };
    }
    const normalizedLimit = normalizedCandidateLimit(limit);
    if (!normalizedLimit) {
      return { chunks: [], totalCandidatesLowerBound: false };
    }
    const plan = this.planPathBatches(paths);
    try {
      return this.readCandidateChunks(terms, paths, plan, normalizedRankPhrase, normalizedLimit, false);
    } catch (error) {
      if (!(error instanceof QueryIndexReadOrderError)) throw error;
      // SQLite returned rows in an order the streamed read does not get from SQL. The read runs again with an ORDER BY
      // for every batch, which gives the same chunks in an order SQL promises.
      this.readOrderFallbackCount += 1;
      return this.readCandidateChunks(terms, paths, plan, normalizedRankPhrase, normalizedLimit, true);
    }
  }

  /** Reads the chunks of `candidateChunkRetrievalForTerms`; `ordered` reads every batch with its own ORDER BY. */
  private readCandidateChunks(
    terms: readonly string[],
    paths: readonly string[],
    plan: PathBatchPlan,
    normalizedRankPhrase: string,
    normalizedLimit: number,
    ordered: boolean,
  ): QueryIndexCandidateRetrieval {
    const candidates = new Set<number>();
    let totalCandidatesLowerBound = false;

    // Keeps what one batch's read returns as a capped read of that batch alone would: at most the rows the cap still
    // allows, plus one that only shows whether more were left, so a read that fills it is only a lower bound. Returns
    // whether the pass is decided, which it is once the cap is met.
    const keepBatchRead = (chunkIds: readonly number[], batchNumber: number, maximum: number): boolean => {
      const requested = maximum - candidates.size + 1;
      if (chunkIds.length >= requested) totalCandidatesLowerBound = true;
      for (let index = 0; index < chunkIds.length && index < requested; index += 1) {
        const chunkId = chunkIds[index]!;
        if (candidates.has(chunkId)) continue;
        candidates.add(chunkId);
        if (candidates.size >= maximum) break;
      }
      if (candidates.size < maximum) return false;
      if ((batchNumber + 1) * QUERY_INDEX_PATH_BATCH_SIZE < paths.length) totalCandidatesLowerBound = true;
      return true;
    };

    // The streamed read of a pass is one statement. Its outer loop takes the batches in order, and for each batch a
    // subquery runs through the batch's files in path order and returns the first `room + 1` chunks that match, `room`
    // being what the cap leaves when the pass starts, each with the position of its file and its ordinal. A batch is
    // therefore never asked for more than any read of it could use plus one row, however many chunks match, and it is
    // not read until the pass reaches it, so a pass stops once its cap is decided. The CROSS JOIN keeps the files as
    // the outer loop and the `+chunks.chunk_id` tests keep the planner from looping over chunk ids instead, which puts
    // the rows in read order without a sort. No ORDER BY promises that, so every read is checked as it arrives (see
    // `chunkIdsOfBatchRead`) and a read that fails the check reruns the whole retrieval with the ordered statements.
    const collectStreamed = (conditions: readonly string[], parameters: readonly string[], maximum: number): void => {
      if (candidates.size >= maximum || !plan.batchNumbers.length) return;
      const room = maximum - candidates.size + 1;
      const rows = this.db
        .prepare(
          `
          SELECT batch.key,
                 (SELECT json_object(
                           'chunks', json_group_array(hit.chunk_id),
                           'files', json_group_array(hit.file),
                           'ordinals', json_group_array(hit.ordinal))
                  FROM (
                    SELECT chunks.chunk_id AS chunk_id, driver.key AS file, chunks.ordinal AS ordinal
                    FROM json_each(batch.value) AS driver
                    CROSS JOIN chunks ON chunks.file_id = driver.value
                    WHERE ${conditions.join(" AND ")}
                    LIMIT ?
                  ) AS hit)
          FROM json_each(?) AS batch
        `,
        )
        .raw()
        .iterate(...parameters, room + 1, plan.batchesJson) as Iterable<unknown[]>;
      let lastKey = -1;
      for (const [key, read] of rows) {
        if (typeof key !== "number" || typeof read !== "string") throw new Error("Invalid query index candidate row.");
        const batchNumber = plan.batchNumbers[key];
        if (batchNumber === undefined)
          throw new Error("Query index candidate row names a batch outside the read plan.");
        if (key <= lastKey) throw new QueryIndexReadOrderError("Query index batches arrived out of read order.");
        lastKey = key;
        if (keepBatchRead(chunkIdsOfBatchRead(read), batchNumber, maximum)) break;
      }
    };

    // The ordered read of a pass is a statement per batch with the ORDER BY and LIMIT of a capped read of that batch.
    // It is slower, because every statement builds the trigram match sets again, and it is what a retrieval falls back
    // to when the streamed read finds its rows out of order.
    const collectOrdered = (conditions: readonly string[], parameters: readonly string[], maximum: number): void => {
      if (candidates.size >= maximum) return;
      const statement = this.db
        .prepare(
          `
          SELECT chunks.chunk_id
          FROM chunks
          JOIN files ON files.file_id = chunks.file_id
          WHERE chunks.file_id IN (SELECT value FROM json_each(?)) AND ${conditions.join(" AND ")}
          ORDER BY files.path, chunks.ordinal
          LIMIT ?
        `,
        )
        .raw();
      for (const [index, batchNumber] of plan.batchNumbers.entries()) {
        const requested = maximum - candidates.size + 1;
        const rows = statement.all(JSON.stringify(plan.batches[index]), ...parameters, requested) as unknown[][];
        const chunkIds = rows.flatMap(([chunkId]) => (typeof chunkId === "number" ? [chunkId] : []));
        if (keepBatchRead(chunkIds, batchNumber, maximum)) break;
      }
    };
    const collect = ordered ? collectOrdered : collectStreamed;

    const termCondition = (term: string): { condition: string; parameters: string[] } => {
      if (!supportsFtsTrigramTerm(term)) {
        return {
          condition: `(instr(chunks.normalized_text, ?) > 0 OR instr(replace(chunks.normalized_text, ' ', ''), ?) > 0)`,
          parameters: [term, term],
        };
      }
      // A spaced match comes from the normalized-text index and a match across word boundaries from the compact-text
      // index; both are index lookups, so no chunk text is scanned.
      const match = escapeFtsTrigramTerm(term);
      return {
        condition: `+chunks.chunk_id IN (
          SELECT rowid FROM chunk_search WHERE chunk_search MATCH ?
          UNION
          SELECT rowid FROM chunk_compact_search WHERE chunk_compact_search MATCH ?
        )`,
        parameters: [match, match],
      };
    };

    const phrase = normalizedRankPhrase;
    if (terms.length > 1) {
      const conditions = ["instr(chunks.normalized_text, ?) > 0"];
      const parameters = [phrase];
      if (terms.every(supportsFtsTrigramTerm)) {
        conditions.unshift("+chunks.chunk_id IN (SELECT rowid FROM chunk_search WHERE chunk_search MATCH ?)");
        parameters.unshift(escapeFtsTrigramTerm(phrase));
      }
      collect(conditions, parameters, normalizedLimit);
    }

    if (terms.length > 1) {
      if (candidates.size < normalizedLimit) {
        if (terms.length <= QUERY_INDEX_INLINE_TERM_LIMIT) {
          const allTerms = terms.map(termCondition);
          collect(
            allTerms.map((term) => term.condition),
            allTerms.flatMap((term) => term.parameters),
            normalizedLimit,
          );
        } else {
          // Keep every term without growing SQL depth or bind count. NOT EXISTS
          // applies the same FTS/substring/compact match before the candidate cap.
          const termValues = terms.map((term) => [
            term,
            supportsFtsTrigramTerm(term) ? escapeFtsTrigramTerm(term) : null,
          ]);
          collect(
            [
              `NOT EXISTS (
                SELECT 1 FROM json_each(?) AS query_terms
                WHERE NOT (
                  CASE WHEN json_extract(query_terms.value, '$[1]') IS NULL
                    THEN instr(chunks.normalized_text, json_extract(query_terms.value, '$[0]')) > 0
                    ELSE chunks.chunk_id IN (
                      SELECT rowid FROM chunk_search
                      WHERE chunk_search MATCH json_extract(query_terms.value, '$[1]')
                    )
                  END
                  OR instr(replace(chunks.normalized_text, ' ', ''), json_extract(query_terms.value, '$[0]')) > 0
                )
              )`,
            ],
            [JSON.stringify(termValues)],
            normalizedLimit,
          );
        }
      } else {
        totalCandidatesLowerBound = true;
      }
    }

    const perTermLimit = Math.max(1, Math.ceil(normalizedLimit / terms.length));
    for (let index = 0; index < terms.length; index += 1) {
      if (candidates.size >= normalizedLimit) {
        totalCandidatesLowerBound = true;
        break;
      }
      const termMatch = termCondition(terms[index]!);
      collect([termMatch.condition], termMatch.parameters, Math.min(normalizedLimit, candidates.size + perTermLimit));
    }

    const matches = [...candidates];
    const rowsByChunkId = this.chunkRowsById(matches);
    const chunks = matches.flatMap((chunkId) => {
      const row = rowsByChunkId.get(chunkId);
      const chunk = row ? storedCandidateChunkFromRow(row) : null;
      return chunk ? [chunk] : [];
    });
    return {
      chunks,
      totalCandidatesLowerBound,
    };
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

  checkpoint(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
