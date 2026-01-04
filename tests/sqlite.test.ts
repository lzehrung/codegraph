import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import {
  buildProjectIndex,
  buildSymbolGraphDetailed,
  writeGraphSqlite,
} from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return dir;
}

const resolveSqlWasmPath = () => {
  const require = createRequire(import.meta.url);
  return require.resolve("sql.js/dist/sql-wasm.wasm");
};

type SqlExecRow = Array<string | number | null>;
type SqlExecResult = { values: SqlExecRow[] };
type SqlJsDatabase = { exec: (sql: string) => SqlExecResult[] };

const dbQuery = (db: SqlJsDatabase, sql: string): string[] => {
  const result = db.exec(sql);
  if (result.length === 0) return [];
  return result[0]?.values?.map((row) => String(row[0])) ?? [];
};

describe("SQLite graph export", () => {
  it("writes tables, indexes, and supports basic queries", async () => {
    const root = await mkTmpDir("dg-sqlite-");
    const main = `
export class Widget {}
export function helper() { return 1; }
export function run() { helper(); new Widget(); }
`;
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const index = await buildProjectIndex(root);
    const sgraph = await buildSymbolGraphDetailed(index);
    const dbPath = path.join(root, "graph.sqlite");
    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
    });

    const SQL = await initSqlJs({ locateFile: () => resolveSqlWasmPath() });
    const data = await fsp.readFile(dbPath);
    const db = new SQL.Database(new Uint8Array(data)) as SqlJsDatabase;

    const tables = dbQuery(db, "SELECT name FROM sqlite_master WHERE type='table';");
    expect(tables).toContain("files");
    expect(tables).toContain("symbols");
    expect(tables).toContain("file_edges");
    expect(tables).toContain("symbol_edges");

    const indexes = dbQuery(
      db,
      "SELECT name FROM sqlite_master WHERE type='index';",
    );
    expect(indexes).toContain("idx_symbols_name");
    expect(indexes).toContain("idx_symbol_edges_from");
    expect(indexes).toContain("idx_file_edges_from");

    const symbols = dbQuery(
      db,
      "SELECT name FROM symbols WHERE name = 'Widget';",
    );
    expect(symbols).toEqual(["Widget"]);

    const calls = dbQuery(
      db,
      "SELECT label FROM symbol_edges WHERE label = 'calls';",
    );
    expect(calls.length).toBeGreaterThan(0);
  });
});
