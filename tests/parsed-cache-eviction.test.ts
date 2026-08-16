import { describe, it, expect } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileIdentityKey } from "../src/util/paths.js";
import { parseFile } from "../src/index.js";
import { setParsedCacheEntry } from "../src/indexer/parsed-cache.js";
import { mkTmpDir } from "./helpers/filesystem.js";

describe("parsed AST cache eviction", () => {
  it("keeps exact LRU key identity for real parsed source fixtures", async () => {
    const root = await mkTmpDir("dg-parsed-lru-");
    const fixtures = ["a.ts", "b.ts", "c.ts", "d.ts"].map((name, index) => ({
      name,
      source: `export const value${index + 1} = ${index + 1};\n`,
    }));
    try {
      await Promise.all(
        fixtures.map((fixture) => fsp.writeFile(path.join(root, fixture.name), fixture.source, "utf8")),
      );
      const entries = await Promise.all(fixtures.map((fixture) => parseFile(path.join(root, fixture.name))));
      const parsedMap = new Map<string, (typeof entries)[number]>();

      for (const [index, fixture] of fixtures.entries()) {
        setParsedCacheEntry(parsedMap, fixture.name, entries[index]!, 2);
      }

      expect([...parsedMap.keys()]).toEqual([fileIdentityKey("c.ts"), fileIdentityKey("d.ts")]);

      const cEntry = parsedMap.get(fileIdentityKey("c.ts"))!;
      setParsedCacheEntry(parsedMap, "c.ts", cEntry, 2);
      expect([...parsedMap.keys()]).toEqual([fileIdentityKey("d.ts"), fileIdentityKey("c.ts")]);

      setParsedCacheEntry(parsedMap, "a.ts", entries[0]!, 2);
      expect([...parsedMap.keys()]).toEqual([fileIdentityKey("c.ts"), fileIdentityKey("a.ts")]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
