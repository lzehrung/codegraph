import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex, findReferences } from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Bloom filter integration", () => {
  it("keeps references when symbols are imported with aliases", async () => {
    const root = await mkTmpDir("dg-bloom-alias-");
    const fileA = path.join(root, "a.ts");
    const fileB = path.join(root, "b.ts");

    await fsp.writeFile(
      fileA,
      "export function target() {\n  return 1;\n}\n",
      "utf8",
    );
    await fsp.writeFile(
      fileB,
      "import { target as alias } from './a';\nexport const value = alias();\n",
      "utf8",
    );

    try {
      const index = await buildProjectIndex(root, {
        cache: "off",
        useBloomFilters: true,
      });

      const file = fileA.replace(/\\/g, "/");
      const refs = await findReferences(index, { file, line: 1, column: 20 });

      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        const files = refs.references.map((ref) => ref.file);
        expect(files).toContain(fileB.replace(/\\/g, "/"));
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("builds bloom filters even when cache is used", async () => {
    const root = await mkTmpDir("dg-bloom-cache-");
    const fileA = path.join(root, "a.ts");
    const fileB = path.join(root, "b.ts");

    await fsp.writeFile(
      fileA,
      "export const value = 123;\n",
      "utf8",
    );
    await fsp.writeFile(
      fileB,
      "import { value } from './a';\nconsole.log(value);\n",
      "utf8",
    );

    try {
      await buildProjectIndex(root, { cache: "disk", useBloomFilters: true });
      const index = await buildProjectIndex(root, {
        cache: "disk",
        useBloomFilters: true,
      });

      expect(index.bloomFilters).toBeDefined();
      if (index.bloomFilters) {
        expect(index.bloomFilters.size()).toBeGreaterThan(0);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
