import path from "node:path";
import { describe, expect, it } from "vitest";
import { dedupePreservingOrder, execRows, execRowsParams, toSqliteText } from "../src/sqlite/common.js";
import { SqliteDatabase } from "../src/sqlite-driver.js";
import {
  ensureSqliteSchemaMetadataTable,
  ensureSqliteVersionedTableSchema,
  readSqliteSchemaVersion,
  writeSqliteSchemaVersion,
} from "../src/util/sqliteSchema.js";
import { mkTmpDir } from "./helpers/filesystem.js";

describe("SQLite common helpers", () => {
  it("normalizes SQLite scalar values to text", () => {
    expect(toSqliteText("value")).toBe("value");
    expect(toSqliteText(42)).toBe("42");
    expect(toSqliteText(false)).toBe("false");
    expect(toSqliteText(null)).toBe("");
    expect(toSqliteText({ value: 42 })).toBe("");
  });

  it("dedupes strings while preserving first-seen order", () => {
    expect(dedupePreservingOrder(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  it("returns raw row arrays with and without parameters", async () => {
    const root = await mkTmpDir("dg-sqlite-common-");
    const db = new SqliteDatabase(path.join(root, "graph.sqlite"));
    try {
      db.exec("CREATE TABLE entries (name TEXT NOT NULL, rank INTEGER NOT NULL);");
      db.prepare("INSERT INTO entries (name, rank) VALUES (?, ?);").run("alpha", 1);
      db.prepare("INSERT INTO entries (name, rank) VALUES (?, ?);").run("beta", 2);

      expect(execRows(db, "SELECT name FROM entries ORDER BY rank;")).toEqual([["alpha"], ["beta"]]);
      expect(execRowsParams(db, "SELECT name FROM entries WHERE rank > ? ORDER BY rank;", [1])).toEqual([["beta"]]);
    } finally {
      db.close();
    }
  });

  it("migrates older versioned SQLite table schemas without dropping compatible rows", async () => {
    const root = await mkTmpDir("dg-sqlite-versioned-older-");
    const db = new SqliteDatabase(path.join(root, "cache.sqlite"));
    try {
      db.exec("CREATE TABLE cache_entries (id TEXT PRIMARY KEY);");
      db.prepare("INSERT INTO cache_entries (id) VALUES (?);").run("kept");
      ensureSqliteSchemaMetadataTable(db);
      writeSqliteSchemaVersion(db, "cache_entries.schema_version", 0);
      ensureSqliteVersionedTableSchema({
        db,
        tableName: "cache_entries",
        schemaVersionKey: "cache_entries.schema_version",
        schemaVersion: 1,
        createTable: (target) => {
          target.exec(
            "CREATE TABLE IF NOT EXISTS cache_entries (id TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '');",
          );
        },
        migrateTable: (target) => {
          target.exec("ALTER TABLE cache_entries ADD COLUMN payload TEXT NOT NULL DEFAULT '';");
        },
      });

      expect(execRows(db, "SELECT id, payload FROM cache_entries;")).toEqual([["kept", ""]]);
      expect(readSqliteSchemaVersion(db, "cache_entries.schema_version")).toEqual({ status: "ok", version: 1 });
    } finally {
      db.close();
    }
  });

  it("rebuilds versioned SQLite tables created by a newer schema", async () => {
    const root = await mkTmpDir("dg-sqlite-versioned-newer-");
    const db = new SqliteDatabase(path.join(root, "cache.sqlite"));
    try {
      db.exec("CREATE TABLE cache_entries (id TEXT PRIMARY KEY);");
      db.prepare("INSERT INTO cache_entries (id) VALUES (?);").run("discarded");
      ensureSqliteSchemaMetadataTable(db);
      writeSqliteSchemaVersion(db, "cache_entries.schema_version", 2);
      ensureSqliteVersionedTableSchema({
        db,
        tableName: "cache_entries",
        schemaVersionKey: "cache_entries.schema_version",
        schemaVersion: 1,
        createTable: (target) => {
          target.exec(
            "CREATE TABLE IF NOT EXISTS cache_entries (id TEXT PRIMARY KEY, payload TEXT NOT NULL DEFAULT '');",
          );
        },
        migrateTable: () => {
          throw new Error("newer schemas should rebuild instead of migrating");
        },
      });

      expect(execRows(db, "SELECT id, payload FROM cache_entries;")).toEqual([]);
      expect(readSqliteSchemaVersion(db, "cache_entries.schema_version")).toEqual({ status: "ok", version: 1 });
    } finally {
      db.close();
    }
  });
});
