import { parseGraphQuery } from "../query.js";
import type { SqliteDatabase } from "../sqlite-driver.js";
import type { GraphQueryResult } from "./types.js";
import { dedupePreservingOrder, execRowsParams, toSqliteText } from "./common.js";
import { withReadOnlySqliteDatabase } from "./database.js";

type DirectFileEdgeDirection = "dependencies" | "dependents";

const loadDirectFileEdges = (db: SqliteDatabase, filePath: string, direction: DirectFileEdgeDirection): string[] => {
  // Use a literal to_type = 'file' so SQLite can apply the partial indexes
  // idx_file_edges_from_file / idx_file_edges_to_file.
  let sql = `
      SELECT to_path
      FROM file_edges
      WHERE to_type = 'file' AND from_path = ?
      ORDER BY rowid;
    `;
  if (direction === "dependents") {
    sql = `
      SELECT from_path
      FROM file_edges
      WHERE to_type = 'file' AND to_path = ?
      ORDER BY rowid;
    `;
  }
  return execRowsParams(db, sql, [filePath])
    .map((row) => toSqliteText(row[0]))
    .filter(Boolean);
};

const loadDirectFileDependencies = (db: SqliteDatabase, fromPath: string): string[] =>
  loadDirectFileEdges(db, fromPath, "dependencies");

const loadDirectFileDependents = (db: SqliteDatabase, toPath: string): string[] =>
  loadDirectFileEdges(db, toPath, "dependents");

const bfsFileTraversal = (start: string, loadNeighbors: (file: string) => string[]): string[] => {
  const visited = new Set<string>();
  const queue: string[] = [start];
  let head = 0;
  visited.add(start);
  const result: string[] = [];
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    if (!current) continue;
    for (const next of loadNeighbors(current)) {
      if (visited.has(next)) continue;
      visited.add(next);
      result.push(next);
      queue.push(next);
    }
  }
  return result;
};

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
        const chain = dedupePreservingOrder(
          startFiles.flatMap((startFile) =>
            bfsFileTraversal(startFile, (file) => loadDirectFileDependencies(db, file)),
          ),
        );
        return { kind: parsed.kind, results: chain };
      }
      case "controllersMostEndpoints": {
        // Avoid lower() + leading-wildcard LIKE on both sides. Prefix matches on
        // endpoint names stay sargable; controller suffix uses GLOB (case-sensitive
        // variants) instead of lower(name) LIKE '%controller'.
        const rows = execRowsParams(
          db,
          `
            SELECT c.name, c.file, COUNT(f.id) as cnt
            FROM symbols c
            LEFT JOIN symbols f
              ON f.file = c.file
              AND f.kind = 'function'
              AND (
                f.name GLOB 'get*' OR f.name GLOB 'Get*' OR f.name GLOB 'GET*' OR
                f.name GLOB 'post*' OR f.name GLOB 'Post*' OR f.name GLOB 'POST*' OR
                f.name GLOB 'put*' OR f.name GLOB 'Put*' OR f.name GLOB 'PUT*' OR
                f.name GLOB 'delete*' OR f.name GLOB 'Delete*' OR f.name GLOB 'DELETE*' OR
                f.name GLOB 'patch*' OR f.name GLOB 'Patch*' OR f.name GLOB 'PATCH*'
              )
            WHERE c.kind = 'class'
              AND (c.name GLOB '*Controller' OR c.name GLOB '*controller')
            GROUP BY c.id
            ORDER BY cnt DESC
            LIMIT ?;
          `,
          [parsed.limit],
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
        const reverseDeps = bfsFileTraversal(parsed.modulePath, (file) => loadDirectFileDependents(db, file));
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
            ORDER BY complexity DESC NULLS LAST
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
            ORDER BY complexity DESC NULLS LAST
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
