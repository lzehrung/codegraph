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

const resolveSqlWasmPath = () => {
  const require = createRequire(import.meta.url);
  return require.resolve("sql.js/dist/sql-wasm.wasm");
};

const loadSqlJs = () => {
  const require = createRequire(import.meta.url);
  return require("sql.js") as typeof import("sql.js");
};

type SqlJsDatabase = {
  run: (sql: string, params?: Array<string | number | null>) => void;
  exec: (sql: string) => Array<{ values: Array<Array<string | number | null>> }>;
  prepare: (sql: string) => {
    run: (params: Array<string | number | null>) => void;
    free: () => void;
  };
  export: () => Uint8Array;
  close: () => void;
};

const ensureSchema = (db: SqlJsDatabase) => {
  db.run(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA foreign_keys = ON;
  `);

  db.run(`
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

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_files_external ON files(is_external);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
    CREATE INDEX IF NOT EXISTS idx_file_edges_from ON file_edges(from_path);
    CREATE INDEX IF NOT EXISTS idx_file_edges_to ON file_edges(to_path);
    CREATE INDEX IF NOT EXISTS idx_file_edges_type ON file_edges(to_type);
    CREATE INDEX IF NOT EXISTS idx_symbol_edges_from ON symbol_edges(from_id);
    CREATE INDEX IF NOT EXISTS idx_symbol_edges_to ON symbol_edges(to_id);
    CREATE INDEX IF NOT EXISTS idx_symbol_edges_label ON symbol_edges(label);
  `);
};

const execRows = (
  db: SqlJsDatabase,
  sql: string,
): Array<Array<string | number | null>> => {
  const result = db.exec(sql);
  if (result.length === 0) return [];
  return result[0]?.values ?? [];
};

const escapeSqlString = (value: string) => value.replace(/'/g, "''");

const loadFileEdges = (db: SqlJsDatabase) =>
  execRows(
    db,
    "SELECT from_path, to_path, to_type FROM file_edges;",
  ).map((row) => ({
    from: String(row[0]),
    to: String(row[1]),
    type: String(row[2]),
  }));

const bfsDependencies = (edges: Array<{ from: string; to: string }>, start: string) => {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adj.get(edge.from) ?? [];
    list.push(edge.to);
    adj.set(edge.from, list);
  }
  const visited = new Set<string>();
  const queue: string[] = [start];
  visited.add(start);
  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
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
  visited.add(start);
  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
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
  db: SqlJsDatabase,
  files: Array<{ path: string; isExternal: boolean }>,
) => {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO files (path, is_external) VALUES (?, ?);",
  );
  for (const file of files) {
    stmt.run([file.path, file.isExternal ? 1 : 0]);
  }
  stmt.free();
};

const insertSymbols = (db: SqlJsDatabase, nodes: SymbolNode[]) => {
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
  stmt.free();
};

const insertFileEdges = (db: SqlJsDatabase, edges: Graph["edges"]) => {
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
  stmt.free();
};

const insertSymbolEdges = (
  db: SqlJsDatabase,
  edges: SymbolGraph["edges"],
) => {
  const stmt = db.prepare(
    "INSERT INTO symbol_edges (from_id, to_id, label) VALUES (?, ?, ?);",
  );
  for (const edge of edges) {
    stmt.run([edge.from, edge.to, edge.label ?? null]);
  }
  stmt.free();
};

const readSymbolIdsForFiles = (
  db: SqlJsDatabase,
  files: string[],
): string[] => {
  if (files.length === 0) return [];
  const escaped = files.map((file) => `'${file.replace(/'/g, "''")}'`);
  const sql = `SELECT id FROM symbols WHERE file IN (${escaped.join(", ")});`;
  const result = db.exec(sql);
  if (result.length === 0) return [];
  const values = result[0]?.values ?? [];
  return values
    .map((row) => (row[0] ? String(row[0]) : null))
    .filter((id): id is string => !!id);
};

const deleteBySymbolIds = (db: SqlJsDatabase, ids: string[]) => {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  db.run(`DELETE FROM symbol_edges WHERE from_id IN (${placeholders});`, ids);
  db.run(`DELETE FROM symbol_edges WHERE to_id IN (${placeholders});`, ids);
  db.run(`DELETE FROM symbols WHERE id IN (${placeholders});`, ids);
};

const deleteFileEdgesForFiles = (db: SqlJsDatabase, files: string[]) => {
  if (files.length === 0) return;
  const placeholders = files.map(() => "?").join(", ");
  db.run(`DELETE FROM file_edges WHERE from_path IN (${placeholders});`, files);
};

const readOrCreateDb = async (outputPath: string) => {
  const { default: initSqlJs } = loadSqlJs();
  const SQL = await initSqlJs({
    locateFile: () => resolveSqlWasmPath(),
  });
  let db: SqlJsDatabase;
  try {
    const data = await fs.readFile(outputPath);
    db = new SQL.Database(new Uint8Array(data)) as SqlJsDatabase;
  } catch {
    db = new SQL.Database() as SqlJsDatabase;
  }
  return { db };
};

export async function writeGraphSqlite(
  options: SqliteGraphOptions,
): Promise<void> {
  const { db } = await readOrCreateDb(options.outputPath);
  ensureSchema(db);

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

  const data = db.export();
  const dir = path.dirname(options.outputPath);
  if (dir) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(options.outputPath, data);
  db.close();
}

export async function updateGraphSqlite(
  options: SqliteGraphUpdateOptions,
): Promise<void> {
  const { db } = await readOrCreateDb(options.outputPath);
  ensureSchema(db);

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

  const data = db.export();
  const dir = path.dirname(options.outputPath);
  if (dir) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(options.outputPath, data);
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
      const rows = execRows(
        db,
        `
          SELECT s.name, s.file, COUNT(*) as cnt
          FROM symbol_edges e
          JOIN symbols s ON s.id = e.to_id
          WHERE e.label = 'calls' AND s.kind = 'function'
          GROUP BY s.id
          ORDER BY cnt DESC
          LIMIT ${parsed.limit};
        `,
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
      const className = escapeSqlString(parsed.className);
      const rows = execRows(
        db,
        `SELECT file FROM symbols WHERE name = '${className}' AND kind = 'class' LIMIT 1;`,
      );
      const startFile = rows[0]?.[0] ? String(rows[0][0]) : "";
      if (!startFile) {
        db.close();
        return { kind: parsed.kind, results: [] };
      }
      const edges = loadFileEdges(db)
        .filter((edge) => edge.type === "file")
        .map((edge) => ({ from: edge.from, to: edge.to }));
      const chain = bfsDependencies(edges, startFile);
      db.close();
      return { kind: parsed.kind, results: chain };
    }
    case "controllersMostEndpoints": {
      const rows = execRows(
        db,
        `
          SELECT c.name, c.file, COUNT(f.id) as cnt
          FROM symbols c
          LEFT JOIN symbols f
            ON f.file = c.file
            AND f.kind = 'function'
            AND (
              lower(f.name) LIKE 'get%' OR
              lower(f.name) LIKE 'post%' OR
              lower(f.name) LIKE 'put%' OR
              lower(f.name) LIKE 'delete%' OR
              lower(f.name) LIKE 'patch%'
            )
          WHERE c.kind = 'class' AND c.name LIKE '%Controller'
          GROUP BY c.id
          ORDER BY cnt DESC
          LIMIT ${parsed.limit};
        `,
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
      const iface = escapeSqlString(parsed.interfaceName);
      const rows = execRows(
        db,
        `
          SELECT DISTINCT s.name, s.file
          FROM symbol_edges e
          JOIN symbols s ON s.id = e.from_id
          JOIN symbols t ON t.id = e.to_id
          WHERE e.label = 'implements' AND t.name = '${iface}';
        `,
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
      const modulePath = escapeSqlString(parsed.modulePath);
      const edges = loadFileEdges(db)
        .filter((edge) => edge.type === "file")
        .map((edge) => ({ from: edge.from, to: edge.to }));
      const reverseDeps = bfsReverseDependencies(edges, modulePath);
      const impactedFiles = [parsed.modulePath, ...reverseDeps];
      if (impactedFiles.length === 0) {
        db.close();
        return { kind: parsed.kind, results: [] };
      }
      const escaped = impactedFiles.map((file) => `'${escapeSqlString(file)}'`);
      const rows = execRows(
        db,
        `
          SELECT name, file
          FROM symbols
          WHERE kind = 'function'
            AND file IN (${escaped.join(", ")});
        `,
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
      const rows = execRows(
        db,
        `
          SELECT name, file, COALESCE(complexity, 0) as score
          FROM symbols
          WHERE kind = 'class'
          ORDER BY score DESC
          LIMIT ${parsed.limit};
        `,
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
