import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { Graph } from "./types.js";
import type { SymbolGraph, SymbolNode } from "./graphs.js";
import { parseGraphQuery } from "./query.js";

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
};

export type GraphQueryResult =
  | { kind: "mostCalledMethods"; results: Array<{ name: string; file: string; count: number }> }
  | { kind: "dependencyChain"; results: string[] }
  | { kind: "controllersMostEndpoints"; results: Array<{ name: string; file: string; count: number }> }
  | { kind: "classesImplementing"; results: Array<{ name: string; file: string }> }
  | { kind: "affectedFunctionsForModule"; results: Array<{ name: string; file: string }> }
  | { kind: "highestComplexityClasses"; results: Array<{ name: string; file: string; complexity: number }> };

export type RawSqlResult = {
  columns: string[];
  rows: Array<Array<unknown>>;
};

const loadBetterSqlite3 = () => {
  const require = createRequire(import.meta.url);
  return require("better-sqlite3") as typeof import("better-sqlite3");
};

type BetterSqliteDatabase = import("better-sqlite3").Database;

const ensureSchema = (db: BetterSqliteDatabase) => {
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
  `);

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
  ];

  const indexRows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%';")
    .raw()
    .all() as Array<Array<unknown>>;
  const existingIndexes = new Set<string>();
  for (const row of indexRows) {
    if (!Array.isArray(row)) continue;
    const name = row[0] ? String(row[0]) : "";
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

const execRows = (
  db: BetterSqliteDatabase,
  sql: string,
): Array<Array<unknown>> => {
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
  db: BetterSqliteDatabase,
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

const loadFileEdges = (
  db: BetterSqliteDatabase,
  toType?: string,
) => {
  const hasFilter = toType !== undefined;
  const sql = hasFilter
    ? "SELECT from_path, to_path FROM file_edges WHERE to_type = ?;"
    : "SELECT from_path, to_path, to_type FROM file_edges;";
  const rows = hasFilter
    ? execRowsParams(db, sql, [toType as string])
    : execRows(db, sql);
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

const bfsReverseDependencies = (
  edges: Array<{ from: string; to: string }>,
  start: string,
) => {
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

const collectSymbolIdsForFiles = (
  symbolGraph: SymbolGraph,
  changedSet: Set<string>,
): string[] => {
  const ids: string[] = [];
  for (const [id, node] of symbolGraph.nodes.entries()) {
    if (changedSet.has(node.file)) ids.push(id);
  }
  return ids;
};

const symbolGraphEdgesForFiles = (
  symbolGraph: SymbolGraph,
  changedSet: Set<string>,
) => {
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

const insertFiles = (
  db: BetterSqliteDatabase,
  files: Array<{ path: string; isExternal: boolean }>,
) => {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO files (path, is_external) VALUES (?, ?);",
  );
  for (const file of files) {
    stmt.run([file.path, file.isExternal ? 1 : 0]);
  }
};

const insertSymbols = (db: BetterSqliteDatabase, nodes: SymbolNode[]) => {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO symbols (id, file, name, kind, docstring, line_span, complexity) VALUES (?, ?, ?, ?, ?, ?, ?);",
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
    ]);
  }
};

const insertFileEdges = (db: BetterSqliteDatabase, edges: Graph["edges"]) => {
  const stmt = db.prepare(
    "INSERT INTO file_edges (from_path, to_path, to_type, raw, type_only) VALUES (?, ?, ?, ?, ?);",
  );
  for (const edge of edges) {
    const toPath = edge.to.type === "file" ? edge.to.path : edge.to.name;
    stmt.run([
      edge.from,
      toPath,
      edge.to.type,
      edge.raw,
      edge.typeOnly ? 1 : 0,
    ]);
  }
};

const insertSymbolEdges = (
  db: BetterSqliteDatabase,
  edges: SymbolGraph["edges"],
) => {
  const stmt = db.prepare(
    "INSERT INTO symbol_edges (from_id, to_id, label) VALUES (?, ?, ?);",
  );
  for (const edge of edges) {
    stmt.run([edge.from, edge.to, edge.label ?? null]);
  }
};

const readSymbolIdsForFiles = (
  db: BetterSqliteDatabase,
  files: string[],
): string[] => {
  if (files.length === 0) return [];
  const placeholders = files.map(() => "?").join(", ");
  const sql = `SELECT id FROM symbols WHERE file IN (${placeholders});`;
  const values = execRowsParams(db, sql, files);
  return values
    .map((row) => (row[0] ? String(row[0]) : null))
    .filter((id): id is string => !!id);
};

const deleteBySymbolIds = (db: BetterSqliteDatabase, ids: string[]) => {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM symbol_edges WHERE from_id IN (${placeholders});`,
  ).run(ids);
  db.prepare(
    `DELETE FROM symbol_edges WHERE to_id IN (${placeholders});`,
  ).run(ids);
  db.prepare(`DELETE FROM symbols WHERE id IN (${placeholders});`).run(ids);
};

const deleteFileEdgesForFiles = (db: BetterSqliteDatabase, files: string[]) => {
  if (files.length === 0) return;
  const placeholders = files.map(() => "?").join(", ");
  db.prepare(
    `DELETE FROM file_edges WHERE from_path IN (${placeholders});`,
  ).run(files);
};

const readOrCreateDb = async (outputPath: string) => {
  const dir = path.dirname(outputPath);
  if (dir) {
    await fs.mkdir(dir, { recursive: true });
  }
  const BetterSqlite3 = loadBetterSqlite3();
  const db = new BetterSqlite3(outputPath);
  return { db };
};

export async function writeGraphSqlite(
  options: SqliteGraphOptions,
): Promise<void> {
  const { db } = await readOrCreateDb(options.outputPath);
  ensureSchema(db);

  const runInsert = db.transaction(() => {
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
    insertFiles(db, fileEntries);
    insertFileEdges(db, options.fileGraph.edges);
    insertSymbols(db, [...options.symbolGraph.nodes.values()]);
    insertSymbolEdges(db, options.symbolGraph.edges);
  });
  runInsert();
  db.exec("ANALYZE;");
  db.close();
}

export async function updateGraphSqlite(
  options: SqliteGraphUpdateOptions,
): Promise<void> {
  const { db } = await readOrCreateDb(options.outputPath);
  ensureSchema(db);

  const runUpdate = db.transaction(() => {
    const changedSet = new Set(options.changedFiles);
    const changedFiles = [...changedSet];
    const removedSymbolIds = readSymbolIdsForFiles(db, changedFiles);
    deleteBySymbolIds(db, removedSymbolIds);
    deleteFileEdgesForFiles(db, changedFiles);

    const fileEntries: Array<{ path: string; isExternal: boolean }> = [];
    for (const file of changedFiles) {
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
    insertFiles(db, fileEntries);

    const changedSymbolIds = collectSymbolIdsForFiles(
      options.symbolGraph,
      changedSet,
    );
    const changedSymbolNodes = changedSymbolIds
      .map((id) => options.symbolGraph.nodes.get(id))
      .filter((node): node is SymbolNode => !!node);
    insertSymbols(db, changedSymbolNodes);

    const fileEdges = fileGraphEdgesForFiles(options.fileGraph, changedSet);
    insertFileEdges(db, fileEdges);

    const symbolEdges = symbolGraphEdgesForFiles(
      options.symbolGraph,
      changedSet,
    );
    insertSymbolEdges(db, symbolEdges);
  });
  runUpdate();
  db.exec("ANALYZE;");
  db.close();
}

export async function queryGraphSqlite(
  outputPath: string,
  queryText: string,
): Promise<GraphQueryResult> {
  const parsed = parseGraphQuery(queryText);
  if (!parsed) {
    throw new Error("Unsupported query text.");
  }
  const { db } = await readOrCreateDb(outputPath);
  ensureSchema(db);

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
      db.close();
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
      const rows = execRowsParams(
        db,
        `SELECT file FROM symbols WHERE name = ? AND kind = ? LIMIT 1;`,
        [parsed.className, "class"],
      );
      const startFile = rows[0]?.[0] ? String(rows[0][0]) : "";
      if (!startFile) {
        db.close();
        return { kind: parsed.kind, results: [] };
      }
      const edges = loadFileEdges(db, "file").map((edge) => ({
        from: edge.from,
        to: edge.to,
      }));
      const chain = bfsDependencies(edges, startFile);
      db.close();
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
        [
          "function",
          "get%",
          "post%",
          "put%",
          "delete%",
          "patch%",
          "class",
          "%Controller",
          parsed.limit,
        ],
      );
      db.close();
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
      db.close();
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
      if (impactedFiles.length === 0) {
        db.close();
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
      db.close();
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
      db.close();
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
}

export async function queryGraphSqliteRaw(
  outputPath: string,
  sql: string,
  params: Array<string | number | null> = [],
): Promise<RawSqlResult> {
  const { db } = await readOrCreateDb(outputPath);
  ensureSchema(db);
  const stmt = db.prepare(sql);
  const columns = stmt.columns().map((col) => col.name);
  const rows = stmt.raw().all(params) as Array<Array<unknown>>;
  db.close();
  return { columns, rows };
}
