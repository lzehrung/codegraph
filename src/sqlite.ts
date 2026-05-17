import fs from "node:fs/promises";
import path from "node:path";
import type { Graph } from "./types.js";
import type { SymbolGraph, SymbolNode } from "./graphs.js";
import { parseGraphQuery } from "./query.js";
import { isReadOnlySqliteError, SqliteDatabase, type SqliteStatement } from "./sqlite-driver.js";

export type SqliteGraphOptions = {
  fileGraph: Graph;
  symbolGraph: SymbolGraph;
  outputPath: string;
};

export type SqliteGraphUpdateOptions = {
  fileGraph: Graph;
  symbolGraph: SymbolGraph;
  outputPath: string;
  changedFiles: string[];
  deletedFiles?: string[];
  /**
   * When true, reconcile DB rows against the provided full graph for changed/deleted files.
   * Use this with full project graphs for accurate incremental CI patching.
   */
  fullGraphSync?: boolean;
};

export type GraphQueryResult =
  | {
      kind: "mostCalledMethods";
      results: Array<{ name: string; file: string; count: number }>;
    }
  | { kind: "dependencyChain"; results: string[] }
  | {
      kind: "controllersMostEndpoints";
      results: Array<{ name: string; file: string; count: number }>;
    }
  | {
      kind: "classesImplementing";
      results: Array<{ name: string; file: string }>;
    }
  | {
      kind: "affectedFunctionsForModule";
      results: Array<{ name: string; file: string }>;
    }
  | {
      kind: "highestComplexityClasses";
      results: Array<{ name: string; file: string; complexity: number }>;
    }
  | {
      kind: "highestComplexityFunctions";
      results: Array<{ name: string; file: string; complexity: number }>;
    };

export type RawSqlResult = {
  columns: string[];
  rows: Array<Array<unknown>>;
  rowLimit?: number;
  byteLimit?: number;
  bytes?: number;
  truncated?: boolean;
};

const SQLITE_SCHEMA_VERSION = 2;

const toSqliteText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
};

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

const ensureSchema = (db: SqliteDatabase) => {
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

  ensureSymbolsVisibilityColumn(db);
  db.prepare("INSERT OR REPLACE INTO graph_metadata (key, value) VALUES (?, ?);").run([
    "schema_version",
    String(SQLITE_SCHEMA_VERSION),
  ]);

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
};

const execRows = (db: SqliteDatabase, sql: string): Array<Array<unknown>> => {
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

const execRowsParams = (
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

const loadFileEdges = (db: SqliteDatabase, toType?: string) => {
  const hasFilter = toType !== undefined;
  const sql = hasFilter
    ? "SELECT from_path, to_path FROM file_edges WHERE to_type = ?;"
    : "SELECT from_path, to_path, to_type FROM file_edges;";
  const rows = hasFilter ? execRowsParams(db, sql, [toType]) : execRows(db, sql);
  return rows.map((row) => ({
    from: String(row[0]),
    to: String(row[1]),
    type: hasFilter ? String(toType) : String(row[2]),
  }));
};

const bfsDependencies = (edges: Array<{ from: string; to: string }>, start: string) => {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adj.get(edge.from) ?? [];
    list.push(edge.to);
    adj.set(edge.from, list);
  }
  const visited = new Set<string>();
  const queue: string[] = [start];
  let head = 0;
  visited.add(start);
  const result: string[] = [];
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    if (!current) continue;
    const neighbors = adj.get(current) ?? [];
    for (const next of neighbors) {
      if (visited.has(next)) continue;
      visited.add(next);
      result.push(next);
      queue.push(next);
    }
  }
  return result;
};

const bfsReverseDependencies = (edges: Array<{ from: string; to: string }>, start: string) => {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adj.get(edge.to) ?? [];
    list.push(edge.from);
    adj.set(edge.to, list);
  }
  const visited = new Set<string>();
  const queue: string[] = [start];
  let head = 0;
  visited.add(start);
  const result: string[] = [];
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    if (!current) continue;
    const neighbors = adj.get(current) ?? [];
    for (const next of neighbors) {
      if (visited.has(next)) continue;
      visited.add(next);
      result.push(next);
      queue.push(next);
    }
  }
  return result;
};

const collectSymbolIdsForFiles = (symbolGraph: SymbolGraph, changedSet: Set<string>): Set<string> => {
  const ids = new Set<string>();
  for (const [id, node] of symbolGraph.nodes.entries()) {
    if (changedSet.has(node.file)) ids.add(id);
  }
  return ids;
};

const symbolGraphEdgesForFiles = (symbolGraph: SymbolGraph, changedSet: Set<string>) => {
  const edgeList = [];
  for (const edge of symbolGraph.edges) {
    const fromNode = symbolGraph.nodes.get(edge.from);
    const toNode = symbolGraph.nodes.get(edge.to);
    if (!fromNode || !toNode) continue;
    if (changedSet.has(fromNode.file) || changedSet.has(toNode.file)) {
      edgeList.push(edge);
    }
  }
  return edgeList;
};

const fileGraphEdgesForFiles = (fileGraph: Graph, changedSet: Set<string>) =>
  fileGraph.edges.filter((edge) => changedSet.has(edge.from));

const symbolGraphEdgesForSymbolIds = (symbolGraph: SymbolGraph, symbolIds: Set<string>) => {
  const edgeList = [];
  for (const edge of symbolGraph.edges) {
    if (symbolIds.has(edge.from) || symbolIds.has(edge.to)) {
      edgeList.push(edge);
    }
  }
  return edgeList;
};

const insertFiles = (db: SqliteDatabase, files: Array<{ path: string; isExternal: boolean }>) => {
  const stmt = db.prepare("INSERT OR REPLACE INTO files (path, is_external) VALUES (?, ?);");
  for (const file of files) {
    stmt.run([file.path, file.isExternal ? 1 : 0]);
  }
};

const dedupeFileEntries = (
  entries: Array<{ path: string; isExternal: boolean }>,
): Array<{ path: string; isExternal: boolean }> => {
  const unique = new Map<string, boolean>();
  for (const entry of entries) {
    const existing = unique.get(entry.path);
    if (existing === undefined) {
      unique.set(entry.path, entry.isExternal);
    } else if (entry.isExternal) {
      unique.set(entry.path, true);
    }
  }
  return [...unique.entries()].map(([path, isExternal]) => ({
    path,
    isExternal,
  }));
};

const insertSymbols = (db: SqliteDatabase, nodes: SymbolNode[]) => {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO symbols (id, file, name, kind, docstring, line_span, complexity, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
  );
  for (const node of nodes) {
    stmt.run([
      node.id,
      node.file,
      node.name,
      node.kind,
      node.docstring ?? null,
      node.lineSpan ?? null,
      node.complexity ?? null,
      node.visibility ?? null,
    ]);
  }
};

const insertFileEdges = (db: SqliteDatabase, edges: Graph["edges"]) => {
  const stmt = db.prepare(
    "INSERT INTO file_edges (from_path, to_path, to_type, raw, type_only) VALUES (?, ?, ?, ?, ?);",
  );
  for (const edge of edges) {
    const toPath = edge.to.type === "file" ? edge.to.path : edge.to.name;
    stmt.run([edge.from, toPath, edge.to.type, edge.raw, edge.typeOnly ? 1 : 0]);
  }
};

const insertSymbolEdges = (db: SqliteDatabase, edges: SymbolGraph["edges"]) => {
  const stmt = db.prepare("INSERT INTO symbol_edges (from_id, to_id, label) VALUES (?, ?, ?);");
  for (const edge of edges) {
    stmt.run([edge.from, edge.to, edge.label ?? null]);
  }
};

const clearCurrentGraphState = (db: SqliteDatabase) => {
  db.exec(`
    DELETE FROM symbol_edges;
    DELETE FROM file_edges;
    DELETE FROM symbols;
    DELETE FROM files;
  `);
};

const readSymbolIdsForFiles = (db: SqliteDatabase, files: string[]): string[] => {
  if (!files.length) return [];
  const placeholders = files.map(() => "?").join(", ");
  const sql = `SELECT id FROM symbols WHERE file IN (${placeholders});`;
  const values = execRowsParams(db, sql, files);
  return values
    .map((row) => {
      const id = toSqliteText(row[0]);
      return id || null;
    })
    .filter((id): id is string => !!id);
};

const deleteBySymbolIds = (db: SqliteDatabase, ids: string[]) => {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(`DELETE FROM symbol_edges WHERE from_id IN (${placeholders});`).run(ids);
  db.prepare(`DELETE FROM symbol_edges WHERE to_id IN (${placeholders});`).run(ids);
  db.prepare(`DELETE FROM symbols WHERE id IN (${placeholders});`).run(ids);
};

const deleteFileEdgesForFiles = (db: SqliteDatabase, files: string[]) => {
  if (!files.length) return;
  const placeholders = files.map(() => "?").join(", ");
  db.prepare(`DELETE FROM file_edges WHERE from_path IN (${placeholders});`).run(files);
};

const deleteFileEdgesToFiles = (db: SqliteDatabase, files: string[]) => {
  if (!files.length) return;
  const placeholders = files.map(() => "?").join(", ");
  db.prepare(`DELETE FROM file_edges WHERE to_type = 'file' AND to_path IN (${placeholders});`).run(files);
};

const deleteFilesByPath = (db: SqliteDatabase, files: string[]) => {
  if (!files.length) return;
  const placeholders = files.map(() => "?").join(", ");
  db.prepare(`DELETE FROM files WHERE path IN (${placeholders});`).run(files);
};

const recordGraphSnapshot = (
  db: SqliteDatabase,
  options: {
    mode: "full" | "incremental";
    changedFiles: string[];
    deletedFiles: string[];
    fileNodes: number;
    fileEdges: number;
    symbolNodes: number;
    symbolEdges: number;
  },
) => {
  const snapshotStmt = db.prepare(`INSERT INTO graph_snapshots (
      created_at,
      mode,
      changed_files,
      deleted_files,
      file_nodes,
      file_edges,
      symbol_nodes,
      symbol_edges
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`);
  const result = snapshotStmt.run([
    Date.now(),
    options.mode,
    options.changedFiles.length,
    options.deletedFiles.length,
    options.fileNodes,
    options.fileEdges,
    options.symbolNodes,
    options.symbolEdges,
  ]);
  const snapshotId = Number(result.lastInsertRowid);
  const fileRows = [
    ...options.changedFiles.map((file) => ({
      file,
      kind: "changed" as const,
    })),
    ...options.deletedFiles.map((file) => ({
      file,
      kind: "deleted" as const,
    })),
  ];
  if (!fileRows.length) return;
  const fileStmt = db.prepare(
    "INSERT INTO graph_snapshot_files (snapshot_id, file_path, change_kind) VALUES (?, ?, ?);",
  );
  for (const row of fileRows) {
    fileStmt.run([snapshotId, row.file, row.kind]);
  }
};

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

async function withSqliteDatabase<T>(
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

async function withReadOnlySqliteDatabase<T>(
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

function assertReadOnlyQueryStatement(stmt: SqliteStatement): void {
  if (stmt.columns().length) return;
  throw new Error("Raw SQLite queries must be read-only result-producing statements such as SELECT or PRAGMA.");
}

const deleteUnreferencedExternalFiles = (db: SqliteDatabase) => {
  db.exec(`
    DELETE FROM files
    WHERE is_external = 1
      AND path NOT IN (
        SELECT DISTINCT to_path
        FROM file_edges
        WHERE to_type = 'external'
      );
  `);
};

const dedupePreservingOrder = (values: string[]): string[] => {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
};

export async function writeGraphSqlite(options: SqliteGraphOptions): Promise<void> {
  await withSqliteDatabase(options.outputPath, (db) => {
    const runInsert = db.transaction(() => {
      clearCurrentGraphState(db);
      const fileEntries: Array<{ path: string; isExternal: boolean }> = [];
      for (const file of options.fileGraph.nodes) {
        fileEntries.push({ path: file, isExternal: false });
      }
      for (const edge of options.fileGraph.edges) {
        if (edge.to.type === "external") {
          fileEntries.push({ path: edge.to.name, isExternal: true });
        } else {
          fileEntries.push({ path: edge.to.path, isExternal: false });
        }
      }
      insertFiles(db, dedupeFileEntries(fileEntries));
      insertFileEdges(db, options.fileGraph.edges);
      insertSymbols(db, [...options.symbolGraph.nodes.values()]);
      insertSymbolEdges(db, options.symbolGraph.edges);
      recordGraphSnapshot(db, {
        mode: "full",
        changedFiles: [],
        deletedFiles: [],
        fileNodes: options.fileGraph.nodes.size,
        fileEdges: options.fileGraph.edges.length,
        symbolNodes: options.symbolGraph.nodes.size,
        symbolEdges: options.symbolGraph.edges.length,
      });
    });
    runInsert();
    db.exec("ANALYZE;");
  });
}

export async function updateGraphSqlite(options: SqliteGraphUpdateOptions): Promise<void> {
  await withSqliteDatabase(options.outputPath, (db) => {
    const runUpdate = db.transaction(() => {
      const changedSet = new Set(options.changedFiles);
      const deletedSet = new Set(options.deletedFiles ?? []);
      const touchedSet = new Set([...changedSet, ...deletedSet]);
      const touchedFiles = [...touchedSet];

      const removedSymbolIds = readSymbolIdsForFiles(db, touchedFiles);
      deleteBySymbolIds(db, removedSymbolIds);
      deleteFileEdgesForFiles(db, touchedFiles);
      deleteFileEdgesToFiles(db, [...deletedSet]);
      deleteFilesByPath(db, [...deletedSet]);

      const fileEntries: Array<{ path: string; isExternal: boolean }> = [];
      for (const file of changedSet) {
        fileEntries.push({ path: file, isExternal: false });
      }

      for (const edge of options.fileGraph.edges) {
        if (!changedSet.has(edge.from)) continue;
        if (edge.to.type === "external") {
          fileEntries.push({ path: edge.to.name, isExternal: true });
        } else {
          fileEntries.push({ path: edge.to.path, isExternal: false });
        }
      }

      if (fileEntries.length) {
        insertFiles(db, dedupeFileEntries(fileEntries));
      }

      const changedSymbolIds = collectSymbolIdsForFiles(options.symbolGraph, changedSet);
      const changedSymbolNodes = [...changedSymbolIds]
        .map((id) => options.symbolGraph.nodes.get(id))
        .filter((node): node is SymbolNode => !!node);
      if (changedSymbolNodes.length) {
        insertSymbols(db, changedSymbolNodes);
      }

      const fileEdges = fileGraphEdgesForFiles(options.fileGraph, changedSet);
      if (fileEdges.length) {
        insertFileEdges(db, fileEdges);
      }

      const symbolEdges = options.fullGraphSync
        ? symbolGraphEdgesForSymbolIds(options.symbolGraph, changedSymbolIds)
        : symbolGraphEdgesForFiles(options.symbolGraph, changedSet);
      if (symbolEdges.length) {
        insertSymbolEdges(db, symbolEdges);
      }

      deleteUnreferencedExternalFiles(db);

      recordGraphSnapshot(db, {
        mode: "incremental",
        changedFiles: [...changedSet],
        deletedFiles: [...deletedSet],
        fileNodes: changedSet.size,
        fileEdges: fileEdges.length,
        symbolNodes: changedSymbolNodes.length,
        symbolEdges: symbolEdges.length,
      });
    });
    runUpdate();
    db.exec("ANALYZE;");
  });
}

export async function queryGraphSqlite(outputPath: string, queryText: string): Promise<GraphQueryResult> {
  const parsed = parseGraphQuery(queryText);
  if (!parsed) {
    throw new Error("Unsupported query text.");
  }
  return await withReadOnlySqliteDatabase(outputPath, (db) => {
    switch (parsed.kind) {
      case "mostCalledMethods": {
        const rows = execRowsParams(
          db,
          `
            SELECT s.name, s.file, COUNT(*) as cnt
            FROM symbol_edges e
            JOIN symbols s ON s.id = e.to_id
            WHERE e.label = ? AND s.kind = ?
            GROUP BY s.id
            ORDER BY cnt DESC
            LIMIT ?;
          `,
          ["calls", "function", parsed.limit],
        );
        return {
          kind: parsed.kind,
          results: rows.map((row) => ({
            name: String(row[0]),
            file: String(row[1]),
            count: Number(row[2]),
          })),
        };
      }
      case "dependencyChain": {
        const rows = execRowsParams(db, `SELECT file FROM symbols WHERE name = ? AND kind = ? ORDER BY file;`, [
          parsed.className,
          "class",
        ]);
        const startFiles = rows.map((row) => toSqliteText(row[0])).filter(Boolean);
        if (!startFiles.length) {
          return { kind: parsed.kind, results: [] };
        }
        const edges = loadFileEdges(db, "file").map((edge) => ({
          from: edge.from,
          to: edge.to,
        }));
        const chain = dedupePreservingOrder(startFiles.flatMap((startFile) => bfsDependencies(edges, startFile)));
        return { kind: parsed.kind, results: chain };
      }
      case "controllersMostEndpoints": {
        const rows = execRowsParams(
          db,
          `
            SELECT c.name, c.file, COUNT(f.id) as cnt
            FROM symbols c
            LEFT JOIN symbols f
              ON f.file = c.file
              AND f.kind = ?
              AND (
                lower(f.name) LIKE ? OR
                lower(f.name) LIKE ? OR
                lower(f.name) LIKE ? OR
                lower(f.name) LIKE ? OR
                lower(f.name) LIKE ?
              )
            WHERE c.kind = ? AND c.name LIKE ?
            GROUP BY c.id
            ORDER BY cnt DESC
            LIMIT ?;
          `,
          ["function", "get%", "post%", "put%", "delete%", "patch%", "class", "%Controller", parsed.limit],
        );
        return {
          kind: parsed.kind,
          results: rows.map((row) => ({
            name: String(row[0]),
            file: String(row[1]),
            count: Number(row[2]),
          })),
        };
      }
      case "classesImplementing": {
        const rows = execRowsParams(
          db,
          `
            SELECT DISTINCT s.name, s.file
            FROM symbol_edges e
            JOIN symbols s ON s.id = e.from_id
            JOIN symbols t ON t.id = e.to_id
            WHERE e.label = ? AND t.name = ?;
          `,
          ["implements", parsed.interfaceName],
        );
        return {
          kind: parsed.kind,
          results: rows.map((row) => ({
            name: String(row[0]),
            file: String(row[1]),
          })),
        };
      }
      case "affectedFunctionsForModule": {
        const edges = loadFileEdges(db, "file").map((edge) => ({
          from: edge.from,
          to: edge.to,
        }));
        const reverseDeps = bfsReverseDependencies(edges, parsed.modulePath);
        const impactedFiles = [parsed.modulePath, ...reverseDeps];
        if (!impactedFiles.length) {
          return { kind: parsed.kind, results: [] };
        }
        const placeholders = impactedFiles.map(() => "?").join(", ");
        const rows = execRowsParams(
          db,
          `
            SELECT name, file
            FROM symbols
            WHERE kind = ?
              AND file IN (${placeholders});
          `,
          ["function", ...impactedFiles],
        );
        return {
          kind: parsed.kind,
          results: rows.map((row) => ({
            name: String(row[0]),
            file: String(row[1]),
          })),
        };
      }
      case "highestComplexityClasses": {
        const rows = execRowsParams(
          db,
          `
            SELECT name, file, COALESCE(complexity, 0) as score
            FROM symbols
            WHERE kind = ?
            ORDER BY score DESC
            LIMIT ?;
          `,
          ["class", parsed.limit],
        );
        return {
          kind: parsed.kind,
          results: rows.map((row) => ({
            name: String(row[0]),
            file: String(row[1]),
            complexity: Number(row[2]),
          })),
        };
      }
      case "highestComplexityFunctions": {
        const rows = execRowsParams(
          db,
          `
            SELECT name, file, COALESCE(complexity, 0) as score
            FROM symbols
            WHERE kind = ?
            ORDER BY score DESC
            LIMIT ?;
          `,
          ["function", parsed.limit],
        );
        return {
          kind: parsed.kind,
          results: rows.map((row) => ({
            name: String(row[0]),
            file: String(row[1]),
            complexity: Number(row[2]),
          })),
        };
      }
    }
  });
}

export async function queryGraphSqliteRaw(
  outputPath: string,
  sql: string,
  params: Array<string | number | null> = [],
  options?: { maxRows?: number | undefined },
): Promise<RawSqlResult> {
  return await withReadOnlySqliteDatabase(outputPath, (db) => {
    try {
      const stmt = db.prepare(sql);
      assertReadOnlyQueryStatement(stmt);
      const columns = stmt.columns().map((col) => col.name);
      const rowLimit = options?.maxRows;
      if (rowLimit !== undefined) {
        const rows: Array<Array<unknown>> = [];
        let truncated = false;
        for (const row of stmt.raw().iterate(params) as Iterable<Array<unknown>>) {
          if (rows.length >= rowLimit) {
            truncated = true;
            break;
          }
          rows.push(row);
        }
        return {
          columns,
          rows,
          rowLimit,
          truncated,
        };
      }
      const rows = stmt.raw().all(params) as Array<Array<unknown>>;
      return { columns, rows };
    } catch (error) {
      if (isReadOnlySqliteError(error)) {
        throw new Error("Raw SQLite queries must be read-only result-producing statements such as SELECT or PRAGMA.");
      }
      throw error;
    }
  });
}
