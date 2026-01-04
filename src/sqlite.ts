import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Graph } from "./types.js";
import type { SymbolGraph } from "./graphs.js";

export type SqliteGraphOptions = {
  fileGraph: Graph;
  symbolGraph: SymbolGraph;
  outputPath: string;
};

const resolveSqlWasmPath = () => {
  const require = createRequire(import.meta.url);
  return require.resolve("sql.js/dist/sql-wasm.wasm");
};

export async function writeGraphSqlite(
  options: SqliteGraphOptions,
): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: () => resolveSqlWasmPath(),
  });
  const db = new SQL.Database();

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

  const fileInsert = db.prepare(
    "INSERT OR IGNORE INTO files (path, is_external) VALUES (?, ?);",
  );
  for (const file of options.fileGraph.nodes) {
    fileInsert.run([file, 0]);
  }
  for (const edge of options.fileGraph.edges) {
    if (edge.to.type === "external") {
      fileInsert.run([edge.to.name, 1]);
    } else {
      fileInsert.run([edge.to.path, 0]);
    }
  }
  fileInsert.free();

  const fileEdgeInsert = db.prepare(
    "INSERT INTO file_edges (from_path, to_path, to_type, raw, type_only) VALUES (?, ?, ?, ?, ?);",
  );
  for (const edge of options.fileGraph.edges) {
    const toPath = edge.to.type === "file" ? edge.to.path : edge.to.name;
    fileEdgeInsert.run([
      edge.from,
      toPath,
      edge.to.type,
      edge.raw,
      edge.typeOnly ? 1 : 0,
    ]);
  }
  fileEdgeInsert.free();

  const symbolInsert = db.prepare(
    "INSERT INTO symbols (id, file, name, kind, docstring, line_span, complexity) VALUES (?, ?, ?, ?, ?, ?, ?);",
  );
  for (const node of options.symbolGraph.nodes.values()) {
    symbolInsert.run([
      node.id,
      node.file,
      node.name,
      node.kind,
      node.docstring ?? null,
      node.lineSpan ?? null,
      node.complexity ?? null,
    ]);
  }
  symbolInsert.free();

  const symbolEdgeInsert = db.prepare(
    "INSERT INTO symbol_edges (from_id, to_id, label) VALUES (?, ?, ?);",
  );
  for (const edge of options.symbolGraph.edges) {
    symbolEdgeInsert.run([edge.from, edge.to, edge.label ?? null]);
  }
  symbolEdgeInsert.free();

  const data = db.export();
  const dir = path.dirname(options.outputPath);
  if (dir) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(options.outputPath, data);
  db.close();
}
