import fs from "node:fs/promises";
import { type SymbolGraph, type SymbolNode } from "../graphs/symbol-graph.js";
import type { Graph } from "../types.js";
import type { SqliteDatabase } from "../sqlite-driver.js";
import type { SqliteGraphOptions, SqliteGraphUpdateOptions } from "./types.js";
import { execRowsParams } from "./common.js";
import { withSqliteDatabase } from "./database.js";

export const SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY = "artifact_file_signatures_v1";

type SqliteArtifactFileSignature = {
  path: string;
  size: number;
  mtimeMs: number;
};

async function collectSqliteArtifactFileSignatures(files: Iterable<string>): Promise<SqliteArtifactFileSignature[]> {
  const signatures: SqliteArtifactFileSignature[] = [];
  await Promise.all(
    [...files].map(async (file) => {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return;
      signatures.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs });
    }),
  );
  signatures.sort((left, right) => left.path.localeCompare(right.path));
  return signatures;
}

function normalizeSqliteArtifactFileSignatures(
  signatures: Iterable<SqliteArtifactFileSignature>,
): SqliteArtifactFileSignature[] {
  const normalized = [...signatures].map((signature) => ({
    path: signature.path,
    size: signature.size,
    mtimeMs: signature.mtimeMs,
  }));
  normalized.sort((left, right) => left.path.localeCompare(right.path));
  return normalized;
}

function writeArtifactFileSignatures(db: SqliteDatabase, signatures: readonly SqliteArtifactFileSignature[]): void {
  db.prepare("INSERT OR REPLACE INTO graph_metadata (key, value) VALUES (?, ?);").run([
    SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY,
    JSON.stringify(signatures),
  ]);
}

function clearArtifactFileSignatures(db: SqliteDatabase): void {
  db.prepare("DELETE FROM graph_metadata WHERE key = ?;").run([SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY]);
}

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
      const id = typeof row[0] === "string" ? row[0] : "";
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

export async function writeGraphSqlite(options: SqliteGraphOptions): Promise<void> {
  const fileSignatures = options.fileSignatures
    ? normalizeSqliteArtifactFileSignatures(options.fileSignatures)
    : undefined;
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
      if (fileSignatures) {
        writeArtifactFileSignatures(db, fileSignatures);
      } else {
        clearArtifactFileSignatures(db);
      }
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
