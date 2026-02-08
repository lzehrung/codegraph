import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import {
  buildProjectIndex,
  buildSymbolGraphDetailed,
  writeGraphSqlite,
  updateGraphSqlite,
  queryGraphSqlite,
  queryGraphSqliteRaw,
} from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return dir;
}

const loadBetterSqlite3 = () => {
  const require = createRequire(import.meta.url);
  return require("better-sqlite3") as typeof import("better-sqlite3");
};

type BetterSqliteDatabase = import("better-sqlite3").Database;

const dbQuery = (db: BetterSqliteDatabase, sql: string): string[] => {
  const rows = db.prepare(sql).raw().all() as Array<Array<unknown>>;
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

    const BetterSqlite3 = loadBetterSqlite3();
    const db = new BetterSqlite3(dbPath);

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
    expect(indexes).toContain("idx_symbols_name_kind");
    expect(indexes).toContain("idx_symbols_file_kind");
    expect(indexes).toContain("idx_symbols_kind_complexity");
    expect(indexes).toContain("idx_symbol_edges_from");
    expect(indexes).toContain("idx_symbol_edges_label_to");
    expect(indexes).toContain("idx_symbol_edges_label_from");
    expect(indexes).toContain("idx_symbol_edges_label_from_to");
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
    db.close();
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
      const BetterSqlite3 = loadBetterSqlite3();
      const db = new BetterSqlite3(dbPath);
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

    const BetterSqlite3 = loadBetterSqlite3();
    const db = new BetterSqlite3(dbPath);
    const columns = db
      .prepare("PRAGMA table_info(symbols);")
      .raw()
      .all()
      .map((row) => (Array.isArray(row) && row[1] ? String(row[1]) : ""))
      .filter(Boolean);
    expect(columns).toContain("visibility");
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

    const BetterSqlite3 = loadBetterSqlite3();
    const db = new BetterSqlite3(dbPath);

    const oldSymbols = dbQuery(
      db,
      "SELECT name FROM symbols WHERE name = 'OldWidget';",
    );
    const newSymbols = dbQuery(
      db,
      "SELECT name FROM symbols WHERE name = 'NewWidget';",
    );
    const helperSymbols = dbQuery(
      db,
      "SELECT name FROM symbols WHERE name = 'helper';",
    );
    expect(oldSymbols).toEqual([]);
    expect(newSymbols).toEqual(["NewWidget"]);
    expect(helperSymbols).toEqual(["helper"]);
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

    const called = await queryGraphSqlite(
      dbPath,
      "What are the most called methods in the codebase?",
    );
    expect(called.kind).toBe("mostCalledMethods");
    expect(called.results.length).toBeGreaterThan(0);

    const chain = await queryGraphSqlite(
      dbPath,
      "Show me the dependency chain for the AuthService class",
    );
    expect(chain.kind).toBe("dependencyChain");
    if (chain.kind === "dependencyChain") {
      expect(chain.results.some((entry) => entry.endsWith("/repo.ts"))).toBe(
        true,
      );
    }

    const controllers = await queryGraphSqlite(
      dbPath,
      "Which controllers have the most endpoints?",
    );
    expect(controllers.kind).toBe("controllersMostEndpoints");
    if (controllers.kind === "controllersMostEndpoints") {
      const userController = controllers.results.find(
        (row) => row.name === "UserController",
      );
      expect(userController).toBeDefined();
      if (userController) {
        expect(userController.count).toBeGreaterThanOrEqual(2);
      }
    }

    const impls = await queryGraphSqlite(
      dbPath,
      "Find all classes that implement the UserRepository interface",
    );
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

    const complexity = await queryGraphSqlite(
      dbPath,
      "Which classes have the highest complexity in the codebase?",
    );
    expect(complexity.kind).toBe("highestComplexityClasses");
    expect(complexity.results.length).toBeGreaterThan(0);
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
});
