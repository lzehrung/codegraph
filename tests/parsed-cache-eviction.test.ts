import { describe, it, expect } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import { buildProjectIndex } from "../src/index.js";
import { mkTmpDir } from "./helpers/filesystem.js";

describe("parsed AST cache eviction", () => {
  it("bounds retained parsed contexts during a project build", async () => {
    const root = await mkTmpDir("dg-parsed-lru-");
    const fixtures = ["a.ts", "b.ts", "c.ts", "d.ts"].map((name, index) => ({
      name,
      source: `export const value${index + 1} = ${index + 1};\n`,
    }));
    try {
      await Promise.all(
        fixtures.map((fixture) => fsp.writeFile(path.join(root, fixture.name), fixture.source, "utf8")),
      );
      const index = await buildProjectIndex(root, {
        cache: "off",
        keepParsed: true,
        native: "on",
        parsedCacheMaxEntries: 2,
      });

      expect(index.parsed?.size).toBe(2);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
