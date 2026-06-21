import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  clearMemoryCache,
  tryLoadFromCache,
  writeToCache,
} from "../src/indexer/build-cache/module-cache.js";
import type { ModuleIndex } from "../src/indexer/types.js";

function moduleFor(file: string, label: string): ModuleIndex {
  return {
    file,
    exports: [],
    imports: [],
    locals: [{ file, localName: label, kind: 1, range: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } }],
  };
}

describe("module memory cache bounds", () => {
  it("evicts oldest entries and clears on teardown", () => {
    const rootA = path.join(os.tmpdir(), "dg-cache-a");
    const rootB = path.join(os.tmpdir(), "dg-cache-b");
    const sig = "sig-1";

    for (let i = 0; i < 5001; i += 1) {
      writeToCache(rootA, `/files/a-${i}.ts`, sig, moduleFor(`/files/a-${i}.ts`, `a-${i}`), { cache: "memory" });
    }

    expect(tryLoadFromCache(rootA, "/files/a-0.ts", sig, { cache: "memory" })).toBeNull();
    expect(tryLoadFromCache(rootA, "/files/a-5000.ts", sig, { cache: "memory" })?.locals[0]?.localName).toBe("a-5000");

    writeToCache(rootB, "/files/b.ts", sig, moduleFor("/files/b.ts", "b"), { cache: "memory" });
    expect(tryLoadFromCache(rootB, "/files/b.ts", sig, { cache: "memory" })?.locals[0]?.localName).toBe("b");

    clearMemoryCache();
    expect(tryLoadFromCache(rootA, "/files/a-5000.ts", sig, { cache: "memory" })).toBeNull();
    expect(tryLoadFromCache(rootB, "/files/b.ts", sig, { cache: "memory" })).toBeNull();
  });
});
