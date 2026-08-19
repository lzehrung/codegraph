import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { canInstallReadonlyAuthorizer, SqliteDatabase } from "../src/sqlite-driver.js";

describe("SQLite read-only authorizer guard", () => {
  it("accepts recursive read-only queries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-sqlite-authorizer-"));
    const databasePath = path.join(root, "artifact.sqlite");
    const writer = new DatabaseSync(databasePath);
    writer.exec("CREATE TABLE values_table (value INTEGER);");
    writer.close();
    const database = new SqliteDatabase(databasePath, { readonly: true });
    try {
      expect(
        database
          .prepare(
            "WITH RECURSIVE count(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM count WHERE x < 3) SELECT max(x) AS value FROM count;",
          )
          .get(),
      ).toMatchObject({ value: 3 });
    } finally {
      database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not install an incomplete authorizer action table", () => {
    expect(
      canInstallReadonlyAuthorizer({
        SQLITE_DENY: 1,
        SQLITE_OK: 0,
        SQLITE_READ: 20,
        SQLITE_SELECT: 21,
      }),
    ).toBe(false);
  });
});
