import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";

import { buildProjectIndex, type BuildReport } from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("disk cache uses sqlite backend", () => {
  it("persists module cache in sqlite and reuses entries", async () => {
    const root = await mkTmpDir("dg-disk-cache-");
    await fsp.writeFile(
      path.join(root, "a.ts"),
      'import { b } from "./b";\nexport const a = b + 1;\n',
      "utf8",
    );
    await fsp.writeFile(path.join(root, "b.ts"), "export const b = 2;\n", "utf8");

    const report1: BuildReport = {};
    await buildProjectIndex(root, {
      cache: "disk",
      keepParsed: false,
      report: report1,
      threads: 1,
    });

    const report2: BuildReport = {};
    await buildProjectIndex(root, {
      cache: "disk",
      keepParsed: false,
      report: report2,
      threads: 1,
    });

    const cacheDir = path.join(root, ".codegraph-cache", "index-v1");
    const entries = await fsp.readdir(cacheDir);

    expect(entries.includes("index-cache.sqlite")).toBe(true);
    const hashedJsonEntries = entries.filter((name) => /^[a-f0-9]{40}\.json$/.test(name));
    expect(hashedJsonEntries.length).toBe(0);
    expect((report2.cache?.hits ?? 0) > 0).toBe(true);
  });
});
