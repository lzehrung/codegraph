import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { SqliteDatabase } from "../src/sqlite-driver.js";
import {
  buildProjectIndex,
  buildSymbolGraphDetailed,
  writeGraphSqlite,
  updateGraphSqlite,
  queryGraphSqlite,
  queryGraphSqliteRaw,
  SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY,
} from "../src/index.js";
import { mkTmpDir, normalizeTestPath } from "./helpers/filesystem.js";

const dbQuery = (db: DatabaseSync, sql: string): string[] => {
  const stmt = db.prepare(sql);
  stmt.setReturnArrays(true);
  const rows = stmt.all() as Array<Array<unknown>>;
  return rows.map((row) => String(row[0]));
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

    const db = new DatabaseSync(dbPath);

    const tables = dbQuery(db, "SELECT name FROM sqlite_master WHERE type='table';");
    expect(tables).toContain("files");
    expect(tables).toContain("symbols");
    expect(tables).toContain("file_edges");
    expect(tables).toContain("symbol_edges");
    expect(tables).toContain("graph_snapshots");
    expect(tables).toContain("graph_snapshot_files");
    expect(tables).toContain("graph_metadata");

    const indexes = dbQuery(db, "SELECT name FROM sqlite_master WHERE type='index';");
    expect(indexes).toContain("idx_symbols_name");
    expect(indexes).toContain("idx_symbols_name_kind");
    expect(indexes).toContain("idx_symbols_file_kind");
    expect(indexes).toContain("idx_symbols_kind_complexity");
    expect(indexes).toContain("idx_symbol_edges_from");
    expect(indexes).toContain("idx_symbol_edges_label_to");
    expect(indexes).toContain("idx_symbol_edges_label_from");
    expect(indexes).toContain("idx_symbol_edges_label_from_to");
    expect(indexes).toContain("idx_file_edges_from");
    expect(indexes).toContain("idx_graph_snapshots_created_at");

    const symbols = dbQuery(db, "SELECT name FROM symbols WHERE name = 'Widget';");
    expect(symbols).toEqual(["Widget"]);

    const calls = dbQuery(db, "SELECT label FROM symbol_edges WHERE label = 'calls';");
    expect(calls.length).toBeGreaterThan(0);
    db.close();
  });

  it("clears artifact freshness metadata on unsigned full rewrites", async () => {
    const root = await mkTmpDir("dg-sqlite-freshness-rewrite-");
    const mainPath = path.join(root, "main.ts");
    await fsp.writeFile(mainPath, "export const one = 1;\n", "utf8");
    const index = await buildProjectIndex(root);
    const sgraph = await buildSymbolGraphDetailed(index);
    const dbPath = path.join(root, "graph.sqlite");
    const stat = await fsp.stat(mainPath);
    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
      fileSignatures: [{ path: mainPath, size: stat.size, mtimeMs: stat.mtimeMs }],
    });
    let db = new DatabaseSync(dbPath);
    expect(dbQuery(db, "SELECT value FROM graph_metadata WHERE key = 'artifact_file_signatures_v1';")).toHaveLength(1);
    db.close();

    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
    });
    db = new DatabaseSync(dbPath);
    expect(
      dbQuery(db, `SELECT value FROM graph_metadata WHERE key = '${SQLITE_ARTIFACT_FILE_SIGNATURES_METADATA_KEY}';`),
    ).toHaveLength(0);
    db.close();
  });

  it("keeps full SQLite exports idempotent across repeated writes", async () => {
    const root = await mkTmpDir("dg-sqlite-idempotent-");
    await fsp.writeFile(
      path.join(root, "main.ts"),
      `import { helper } from "./util";
export function run() { return helper(); }
`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "util.ts"),
      `export function helper() { return 1; }
`,
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const sgraph = await buildSymbolGraphDetailed(index);
    const dbPath = path.join(root, "graph.sqlite");
    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
    });

    const firstCounts = await queryGraphSqliteRaw(
      dbPath,
      "SELECT (SELECT COUNT(*) FROM files), (SELECT COUNT(*) FROM file_edges), (SELECT COUNT(*) FROM symbols), (SELECT COUNT(*) FROM symbol_edges);",
    );

    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
    });

    const secondCounts = await queryGraphSqliteRaw(
      dbPath,
      "SELECT (SELECT COUNT(*) FROM files), (SELECT COUNT(*) FROM file_edges), (SELECT COUNT(*) FROM symbols), (SELECT COUNT(*) FROM symbol_edges);",
    );

    expect(secondCounts.rows).toEqual(firstCounts.rows);
  });

  it("migrates older DBs missing symbols.visibility", async () => {
    const root = await mkTmpDir("dg-sqlite-migrate-");
    const main = `
export class Widget {}
export function helper() { return 1; }
export function run() { helper(); new Widget(); }
`;
    await fsp.writeFile(path.join(root, "main.ts"), main, "utf8");

    const dbPath = path.join(root, "graph.sqlite");
    {
      const db = new DatabaseSync(dbPath);
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
      db.close();
    }

    const index = await buildProjectIndex(root);
    const sgraph = await buildSymbolGraphDetailed(index);
    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
    });

    const db = new DatabaseSync(dbPath);
    const columns = db
      .prepare("PRAGMA table_info(symbols);")
      .all()
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter(Boolean);
    expect(columns).toContain("visibility");
    const tables = dbQuery(db, "SELECT name FROM sqlite_master WHERE type='table';");
    expect(tables).toContain("graph_snapshots");
    const schemaVersion = dbQuery(db, "SELECT value FROM graph_metadata WHERE key = 'schema_version';");
    expect(schemaVersion[0]).toBe("2");
    db.close();
  });

  it("migrates v1 schema_version databases to v2", async () => {
    const root = await mkTmpDir("dg-sqlite-v1-version-");
    const dbPath = path.join(root, "graph.sqlite");
    {
      const db = new DatabaseSync(dbPath);
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
        CREATE TABLE IF NOT EXISTS graph_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO graph_metadata (key, value) VALUES ('schema_version', '1');
      `);
      db.close();
    }

    const db = new SqliteDatabase(dbPath);
    const { ensureSchema, readGraphSchemaVersion, SQLITE_SCHEMA_VERSION } = await import("../src/sqlite/schema.js");
    expect(readGraphSchemaVersion(db)).toBe(1);
    ensureSchema(db);
    expect(readGraphSchemaVersion(db)).toBe(SQLITE_SCHEMA_VERSION);
    const columns = db
      .prepare("PRAGMA table_info(symbols);")
      .all()
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter(Boolean);
    expect(columns).toContain("visibility");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table';")
      .all()
      .map((row) => String((row as { name?: unknown }).name));
    expect(tables).toContain("graph_snapshots");
    db.close();
  });

  it("rejects future schema_version databases without downgrading them", async () => {
    const root = await mkTmpDir("dg-sqlite-future-version-");
    const dbPath = path.join(root, "graph.sqlite");
    const db = new SqliteDatabase(dbPath);
    const { ensureSchema, readGraphSchemaVersion, SQLITE_SCHEMA_VERSION } = await import("../src/sqlite/schema.js");
    db.exec(`
      CREATE TABLE IF NOT EXISTS graph_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO graph_metadata (key, value) VALUES ('schema_version', '999');
    `);

    expect(() => ensureSchema(db)).toThrow(`Unsupported codegraph SQLite schema version 999`);
    expect(readGraphSchemaVersion(db)).toBe(999);
    expect(SQLITE_SCHEMA_VERSION).toBeLessThan(999);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
      .all()
      .map((row) => String((row as { name?: unknown }).name));
    expect(tables).toEqual(["graph_metadata"]);
    db.close();
  });

  it("updates changed files incrementally", async () => {
    const root = await mkTmpDir("dg-sqlite-update-");
    const base = `
export class OldWidget {}
export function run() { return new OldWidget(); }
`;
    const util = `
export function helper() { return 1; }
`;
    await fsp.writeFile(path.join(root, "main.ts"), base, "utf8");
    await fsp.writeFile(path.join(root, "util.ts"), util, "utf8");

    const index = await buildProjectIndex(root);
    const sgraph = await buildSymbolGraphDetailed(index);
    const dbPath = path.join(root, "graph.sqlite");
    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
    });

    const updated = `
export class NewWidget {}
export function run() { return new NewWidget(); }
`;
    await fsp.writeFile(path.join(root, "main.ts"), updated, "utf8");
    const nextIndex = await buildProjectIndex(root);
    const nextSgraph = await buildSymbolGraphDetailed(nextIndex);
    const changedPath = path.join(root, "main.ts").replace(/\\/g, "/");
    await updateGraphSqlite({
      fileGraph: nextIndex.graph,
      symbolGraph: nextSgraph,
      outputPath: dbPath,
      changedFiles: [changedPath],
    });

    const db = new DatabaseSync(dbPath);

    const oldSymbols = dbQuery(db, "SELECT name FROM symbols WHERE name = 'OldWidget';");
    const newSymbols = dbQuery(db, "SELECT name FROM symbols WHERE name = 'NewWidget';");
    const helperSymbols = dbQuery(db, "SELECT name FROM symbols WHERE name = 'helper';");
    expect(oldSymbols).toEqual([]);
    expect(newSymbols).toEqual(["NewWidget"]);
    expect(helperSymbols).toEqual(["helper"]);
    db.close();
  });

  it("removes stale files and edges when a full export rewrites an existing DB", async () => {
    const root = await mkTmpDir("dg-sqlite-full-rewrite-");
    await fsp.writeFile(
      path.join(root, "main.ts"),
      `import { helper } from "./util";
export const run = () => helper();
`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "util.ts"),
      `export function helper() { return 1; }
`,
      "utf8",
    );

    const dbPath = path.join(root, "graph.sqlite");
    let index = await buildProjectIndex(root);
    let sgraph = await buildSymbolGraphDetailed(index);
    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
    });

    await fsp.unlink(path.join(root, "util.ts"));
    await fsp.writeFile(
      path.join(root, "main.ts"),
      `export const run = () => 1;
`,
      "utf8",
    );

    index = await buildProjectIndex(root);
    sgraph = await buildSymbolGraphDetailed(index);
    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
    });

    const utilPath = path.join(root, "util.ts").replace(/\\/g, "/");
    const utilFiles = await queryGraphSqliteRaw(dbPath, "SELECT path FROM files WHERE path = ?;", [utilPath]);
    const utilEdges = await queryGraphSqliteRaw(dbPath, "SELECT to_path FROM file_edges WHERE to_path = ?;", [
      utilPath,
    ]);
    const utilSymbols = await queryGraphSqliteRaw(dbPath, "SELECT id FROM symbols WHERE file = ?;", [utilPath]);

    expect(utilFiles.rows).toEqual([]);
    expect(utilEdges.rows).toEqual([]);
    expect(utilSymbols.rows).toEqual([]);
  });

  it("removes deleted files and stale edges during incremental updates", async () => {
    const root = await mkTmpDir("dg-sqlite-delete-");
    await fsp.writeFile(
      path.join(root, "main.ts"),
      `import { helper } from "./util";
export const run = () => helper();
`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "util.ts"),
      `export function helper() { return 1; }
`,
      "utf8",
    );

    const baseIndex = await buildProjectIndex(root);
    const baseSgraph = await buildSymbolGraphDetailed(baseIndex);
    const dbPath = path.join(root, "graph.sqlite");
    await writeGraphSqlite({
      fileGraph: baseIndex.graph,
      symbolGraph: baseSgraph,
      outputPath: dbPath,
    });

    await fsp.unlink(path.join(root, "util.ts"));
    await fsp.writeFile(
      path.join(root, "main.ts"),
      `export const run = () => 1;
`,
      "utf8",
    );

    const nextIndex = await buildProjectIndex(root);
    const nextSgraph = await buildSymbolGraphDetailed(nextIndex);
    await updateGraphSqlite({
      fileGraph: nextIndex.graph,
      symbolGraph: nextSgraph,
      outputPath: dbPath,
      changedFiles: [normalizeTestPath(path.join(root, "main.ts"))],
      deletedFiles: [normalizeTestPath(path.join(root, "util.ts"))],
      fullGraphSync: true,
    });

    const db = new DatabaseSync(dbPath);
    const utilFiles = dbQuery(
      db,
      `SELECT path FROM files WHERE path = '${normalizeTestPath(path.join(root, "util.ts"))}';`,
    );
    const utilSymbols = dbQuery(db, "SELECT name FROM symbols WHERE name = 'helper';");
    const staleEdges = dbQuery(
      db,
      `SELECT to_path FROM file_edges WHERE to_path = '${normalizeTestPath(path.join(root, "util.ts"))}';`,
    );

    expect(utilFiles).toEqual([]);
    expect(utilSymbols).toEqual([]);
    expect(staleEdges).toEqual([]);
    db.close();
  });

  it("removes inbound edges for deleted files even when importers are unchanged", async () => {
    const root = await mkTmpDir("dg-sqlite-delete-inbound-");
    const mainPath = path.join(root, "main.ts");
    const utilPath = path.join(root, "util.ts");

    await fsp.writeFile(
      mainPath,
      `import { helper } from "./util";
export const run = () => helper();
`,
      "utf8",
    );
    await fsp.writeFile(
      utilPath,
      `export function helper() { return 1; }
`,
      "utf8",
    );

    const baseIndex = await buildProjectIndex(root);
    const baseSgraph = await buildSymbolGraphDetailed(baseIndex);
    const dbPath = path.join(root, "graph.sqlite");
    await writeGraphSqlite({
      fileGraph: baseIndex.graph,
      symbolGraph: baseSgraph,
      outputPath: dbPath,
    });

    await fsp.unlink(utilPath);
    const nextIndex = await buildProjectIndex(root);
    const nextSgraph = await buildSymbolGraphDetailed(nextIndex);

    await updateGraphSqlite({
      fileGraph: nextIndex.graph,
      symbolGraph: nextSgraph,
      outputPath: dbPath,
      changedFiles: [],
      deletedFiles: [utilPath.replace(/\\/g, "/")],
      fullGraphSync: true,
    });

    const rows = await queryGraphSqliteRaw(
      dbPath,
      "SELECT from_path, to_path, to_type FROM file_edges ORDER BY from_path, to_path;",
    );
    expect(rows.rows).toEqual([]);

    const remainingFile = await queryGraphSqliteRaw(dbPath, "SELECT path FROM files ORDER BY path;");
    expect(remainingFile.rows).toEqual([[mainPath.replace(/\\/g, "/")]]);
  });

  it("removes orphaned external file rows during incremental updates", async () => {
    const root = await mkTmpDir("dg-sqlite-orphan-external-");
    const mainPath = path.join(root, "main.ts");
    const dbPath = path.join(root, "graph.sqlite");

    await fsp.writeFile(
      mainPath,
      `import lodash from "lodash";
export const value = lodash;
`,
      "utf8",
    );

    let index = await buildProjectIndex(root);
    let sgraph = await buildSymbolGraphDetailed(index);
    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
    });

    await fsp.writeFile(
      mainPath,
      `export const value = 1;
`,
      "utf8",
    );

    index = await buildProjectIndex(root);
    sgraph = await buildSymbolGraphDetailed(index);
    await updateGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
      changedFiles: [mainPath.replace(/\\/g, "/")],
    });

    const externalRows = await queryGraphSqliteRaw(
      dbPath,
      "SELECT path FROM files WHERE is_external = 1 ORDER BY path;",
    );
    expect(externalRows.rows).toEqual([]);
  });

  it("records temporal snapshots for full and incremental updates", async () => {
    const root = await mkTmpDir("dg-sqlite-snapshots-");
    await fsp.writeFile(
      path.join(root, "main.ts"),
      `import { helper } from "./util";
export const run = () => helper();
`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "util.ts"),
      `export function helper() { return 1; }
`,
      "utf8",
    );

    const dbPath = path.join(root, "graph.sqlite");
    const baseIndex = await buildProjectIndex(root);
    const baseSgraph = await buildSymbolGraphDetailed(baseIndex);
    await writeGraphSqlite({
      fileGraph: baseIndex.graph,
      symbolGraph: baseSgraph,
      outputPath: dbPath,
    });

    await fsp.unlink(path.join(root, "util.ts"));
    await fsp.writeFile(
      path.join(root, "main.ts"),
      `export const run = () => 2;
`,
      "utf8",
    );
    const nextIndex = await buildProjectIndex(root);
    const nextSgraph = await buildSymbolGraphDetailed(nextIndex);
    await updateGraphSqlite({
      fileGraph: nextIndex.graph,
      symbolGraph: nextSgraph,
      outputPath: dbPath,
      changedFiles: [normalizeTestPath(path.join(root, "main.ts"))],
      deletedFiles: [normalizeTestPath(path.join(root, "util.ts"))],
      fullGraphSync: true,
    });

    const db = new DatabaseSync(dbPath);
    const snapshotModes = dbQuery(db, "SELECT mode FROM graph_snapshots ORDER BY id ASC;");
    expect(snapshotModes).toEqual(["full", "incremental"]);
    const snapshotFiles = dbQuery(db, "SELECT change_kind FROM graph_snapshot_files ORDER BY rowid ASC;");
    expect(snapshotFiles).toContain("changed");
    expect(snapshotFiles).toContain("deleted");
    db.close();
  });
  it("supports deterministic graph queries", async () => {
    const root = await mkTmpDir("dg-sqlite-query-");
    const auth = `
import { UserRepository } from "./repo";

export class AuthService {}
export class UserController {}
export function getUser() {}
export function postUser() {}
export function runAuth() { helper(); }
export function helper() {}
export class RepoImpl implements UserRepository {}
`;
    const repo = `
export interface UserRepository {}
`;
    await fsp.writeFile(path.join(root, "auth.ts"), auth, "utf8");
    await fsp.writeFile(path.join(root, "repo.ts"), repo, "utf8");

    const index = await buildProjectIndex(root);
    const sgraph = await buildSymbolGraphDetailed(index);
    const dbPath = path.join(root, "graph.sqlite");
    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
    });

    const called = await queryGraphSqlite(dbPath, "What are the most called methods in the codebase?");
    expect(called.kind).toBe("mostCalledMethods");
    expect(called.results.length).toBeGreaterThan(0);

    const chain = await queryGraphSqlite(dbPath, "Show me the dependency chain for the AuthService class");
    expect(chain.kind).toBe("dependencyChain");
    if (chain.kind === "dependencyChain") {
      expect(chain.results.some((entry) => entry.endsWith("/repo.ts"))).toBe(true);
    }

    const controllers = await queryGraphSqlite(dbPath, "Which controllers have the most endpoints?");
    expect(controllers.kind).toBe("controllersMostEndpoints");
    if (controllers.kind === "controllersMostEndpoints") {
      const userController = controllers.results.find((row) => row.name === "UserController");
      expect(userController).toBeDefined();
      if (userController) {
        expect(userController.count).toBeGreaterThanOrEqual(2);
      }
    }

    const impls = await queryGraphSqlite(dbPath, "Find all classes that implement the UserRepository interface");
    expect(impls.kind).toBe("classesImplementing");
    if (impls.kind === "classesImplementing") {
      expect(impls.results.some((row) => row.name === "RepoImpl")).toBe(true);
    }

    const modulePath = path.join(root, "auth.ts").replace(/\\/g, "/");
    const affected = await queryGraphSqlite(
      dbPath,
      `What functions would be affected if I change this module ${modulePath}`,
    );
    expect(affected.kind).toBe("affectedFunctionsForModule");
    if (affected.kind === "affectedFunctionsForModule") {
      expect(affected.results.some((row) => row.name === "runAuth")).toBe(true);
    }

    const complexity = await queryGraphSqlite(dbPath, "Which classes have the highest complexity in the codebase?");
    expect(complexity.kind).toBe("highestComplexityClasses");
    expect(complexity.results.length).toBeGreaterThan(0);
  });

  it("merges dependency chains across duplicate class names deterministically", async () => {
    const root = await mkTmpDir("dg-sqlite-duplicate-class-");
    await fsp.writeFile(
      path.join(root, "a.ts"),
      `export class Service {}
`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "b.ts"),
      `import "./a";
export class Service {}
`,
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const sgraph = await buildSymbolGraphDetailed(index);
    const dbPath = path.join(root, "graph.sqlite");
    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
    });

    const chain = await queryGraphSqlite(dbPath, "Show me the dependency chain for the Service class");
    expect(chain.kind).toBe("dependencyChain");
    if (chain.kind === "dependencyChain") {
      expect(chain.results).toEqual([path.join(root, "a.ts").replace(/\\/g, "/")]);
    }
  });

  it("walks sqlite canned file traversals through cycles without duplicate results", async () => {
    const root = await mkTmpDir("dg-sqlite-cycle-traversal-");
    await fsp.writeFile(
      path.join(root, "a.ts"),
      `import "./b";
export class Service {}
export function runA() { return 1; }
`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "b.ts"),
      `import "./c";
export function runB() { return 1; }
`,
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "c.ts"),
      `import "./b";
export function runC() { return 1; }
`,
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const sgraph = await buildSymbolGraphDetailed(index);
    const dbPath = path.join(root, "graph.sqlite");
    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
    });

    const bPath = path.join(root, "b.ts").replace(/\\/g, "/");
    const cPath = path.join(root, "c.ts").replace(/\\/g, "/");
    const chain = await queryGraphSqlite(dbPath, "Show me the dependency chain for the Service class");
    expect(chain.kind).toBe("dependencyChain");
    if (chain.kind === "dependencyChain") {
      expect(chain.results).toEqual([bPath, cPath]);
    }

    const affected = await queryGraphSqlite(
      dbPath,
      `What functions would be affected if I change this module ${cPath}`,
    );
    expect(affected.kind).toBe("affectedFunctionsForModule");
    if (affected.kind === "affectedFunctionsForModule") {
      const names = affected.results.map((row) => row.name);
      expect(names).toEqual(["runA", "runB", "runC"]);
    }
  });

  it("uses updated sqlite file edges for canned traversals after incremental updates", async () => {
    const root = await mkTmpDir("dg-sqlite-incremental-traversal-");
    const mainPath = path.join(root, "main.ts");
    const utilPath = path.join(root, "util.ts");
    await fsp.writeFile(
      mainPath,
      `import "./util";
export class Service {}
`,
      "utf8",
    );
    await fsp.writeFile(
      utilPath,
      `export function helper() { return 1; }
`,
      "utf8",
    );

    let index = await buildProjectIndex(root);
    let sgraph = await buildSymbolGraphDetailed(index);
    const dbPath = path.join(root, "graph.sqlite");
    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
    });

    await fsp.writeFile(
      mainPath,
      `export class Service {}
`,
      "utf8",
    );
    index = await buildProjectIndex(root);
    sgraph = await buildSymbolGraphDetailed(index);
    await updateGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
      changedFiles: [mainPath.replace(/\\/g, "/")],
    });

    const chain = await queryGraphSqlite(dbPath, "Show me the dependency chain for the Service class");
    expect(chain.kind).toBe("dependencyChain");
    if (chain.kind === "dependencyChain") {
      expect(chain.results).toEqual([]);
    }
  });

  it("executes raw SQL queries with column metadata", async () => {
    const root = await mkTmpDir("dg-sqlite-raw-");
    const main = `
export class Widget {}
export class Gadget {}
export function helper() { return 1; }
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

    const result = await queryGraphSqliteRaw(
      dbPath,
      "SELECT name, kind FROM symbols WHERE kind = 'class' ORDER BY name;",
    );
    expect(result.columns).toEqual(["name", "kind"]);
    const names = result.rows.map((row) => String(row[0]));
    expect(names).toEqual(["Gadget", "Widget"]);
  });

  it("closes the database handle after raw SQL failures", async () => {
    const root = await mkTmpDir("dg-sqlite-raw-failure-");
    await fsp.writeFile(
      path.join(root, "main.ts"),
      `export const value = 1;
`,
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const sgraph = await buildSymbolGraphDetailed(index);
    const dbPath = path.join(root, "graph.sqlite");
    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
    });

    await expect(queryGraphSqliteRaw(dbPath, "SELECT * FROM missing_table;")).rejects.toThrow();

    await expect(fsp.rm(dbPath, { force: true })).resolves.toBeUndefined();
  });

  it("rejects mutating raw SQL queries before execution", async () => {
    const root = await mkTmpDir("dg-sqlite-raw-readonly-");
    await fsp.writeFile(
      path.join(root, "main.ts"),
      `export const value = 1;
`,
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const sgraph = await buildSymbolGraphDetailed(index);
    const dbPath = path.join(root, "graph.sqlite");
    await writeGraphSqlite({
      fileGraph: index.graph,
      symbolGraph: sgraph,
      outputPath: dbPath,
    });

    await expect(queryGraphSqliteRaw(dbPath, "DELETE FROM symbols RETURNING name;")).rejects.toThrow(
      /read-only result-producing statements/,
    );

    const remaining = await queryGraphSqliteRaw(dbPath, "SELECT COUNT(*) FROM symbols;");
    expect(remaining.rows).toEqual([[1]]);
  });

  it("fails fast when high-level SQLite queries target a missing database", async () => {
    const root = await mkTmpDir("dg-sqlite-missing-");
    const missingDir = path.join(root, "nested");
    const dbPath = path.join(missingDir, "graph.sqlite");

    await expect(queryGraphSqlite(dbPath, "What are the most called methods in the codebase?")).rejects.toThrow();
    await expect(fsp.access(dbPath)).rejects.toThrow();
  });
});
