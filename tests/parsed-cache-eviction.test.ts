import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";

import { buildProjectIndex } from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("parsed AST cache eviction", () => {
  it("limits parsed entries to configured max", async () => {
    const root = await mkTmpDir("dg-parsed-lru-");
    const files = ["a.ts", "b.ts", "c.ts", "d.ts"].map((name, i) => ({
      name,
      source: `export const v${i + 1} = ${i + 1};\n`,
    }));

    for (const file of files) {
      await fsp.writeFile(path.join(root, file.name), file.source, "utf8");
    }

    const index = await buildProjectIndex(root, {
      parsedCacheMaxEntries: 2,
      threads: 1,
      cache: "off",
      keepParsed: true,
    });

    expect(index.parsed).toBeDefined();
    expect((index.parsed?.size ?? 0) <= 2).toBe(true);
  });
});
