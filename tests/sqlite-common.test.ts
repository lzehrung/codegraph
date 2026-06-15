import path from "node:path";
import { describe, expect, it } from "vitest";
import { dedupePreservingOrder, execRows, execRowsParams, toSqliteText } from "../src/sqlite/common.js";
import { SqliteDatabase } from "../src/sqlite-driver.js";
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
});
