import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  cacheDatabasePath,
  diskModuleCacheExists,
  pruneDiskModuleCache,
  resetDiskModuleCacheSqliteStateForTests,
  writeModulesToCache,
  type PendingModuleCacheWrite,
} from "../src/indexer/build-cache/module-cache.js";
import { SymbolKind, type ModuleIndex } from "../src/indexer/types.js";
import {
  SqliteDatabase,
  isNodeSqliteUnavailableError,
  isNodeSqliteUsable,
  markNodeSqliteUnavailable,
} from "../src/sqlite-driver.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const tempRoots = createTempRootRegistry();

function moduleFor(file: string): ModuleIndex {
  return {
    file,
    exports: [],
    imports: [],
    locals: [
      {
        file,
        localName: "entry",
        kind: SymbolKind.Variable,
        range: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
      },
    ],
  };
}

function diskWrite(file: string): PendingModuleCacheWrite {
  return { file, sig: "sig", mod: moduleFor(file) };
}

describe("unsupported node:sqlite runtime", () => {
  afterEach(async () => {
    resetDiskModuleCacheSqliteStateForTests();
    vi.restoreAllMocks();
    await tempRoots.cleanup();
  });

  it("accepts the current Node build's node:sqlite statement API", () => {
    expect(isNodeSqliteUsable()).toBe(true);
  });

  it("classifies missing setReturnArrays and columns as unsupported node:sqlite", () => {
    expect(isNodeSqliteUnavailableError(new TypeError("setReturnArrays is not a function"))).toBe(true);
    expect(isNodeSqliteUnavailableError(new TypeError("columns is not a function"))).toBe(true);
  });

  it("warns once when cache-read gating checks existence on an unusable runtime", async () => {
    const root = await tempRoots.create("cg-sqlite-exists-");
    markNodeSqliteUnavailable(new TypeError("this.statement.setReturnArrays is not a function"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const opts = { cache: "disk" as const };

    expect(diskModuleCacheExists(root, opts)).toBe(false);
    expect(diskModuleCacheExists(root, opts)).toBe(false);

    const warnings = warn.mock.calls.filter((args) => String(args[0]).includes("Disk cache disabled for this run"));
    expect(warnings).toHaveLength(1);
  });

  it("disables disk cache after one warning and does not create a cache database", async () => {
    const root = await tempRoots.create("cg-sqlite-runtime-");
    markNodeSqliteUnavailable(new TypeError("this.statement.setReturnArrays is not a function"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const opts = { cache: "disk" as const };

    for (let i = 0; i < 50; i += 1) {
      writeModulesToCache(root, [diskWrite(path.join(root, `file-${i}.ts`))], opts);
    }
    expect(pruneDiskModuleCache(root, [], opts)).toBe(0);

    const warnings = warn.mock.calls.filter((args) => String(args[0]).includes("Disk cache disabled for this run"));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).not.toMatch(/TypeError|setReturnArrays/);
    expect(mkdir).not.toHaveBeenCalled();
    expect(fs.existsSync(cacheDatabasePath(root, opts, "index-cache.sqlite"))).toBe(false);
    expect(() => new SqliteDatabase(path.join(root, "probe.sqlite"))).toThrow(/setReturnArrays is not a function/);
  });
});
