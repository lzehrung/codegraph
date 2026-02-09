import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndexFromFiles, type BuildReport } from "../src/index.js";
import { stripJsLikeComments } from "../src/util.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Import extraction fallback reporting", () => {
  it("avoids regex fallback for TypeScript import equals", async () => {
    const root = await mkTmpDir("cg-import-equals-");
    const main = path.join(root, "main.ts");
    const dep = path.join(root, "dep.ts");
    await fsp.writeFile(dep, "export const value = 1;\n", "utf8");
    await fsp.writeFile(
      main,
      "import util = require('./dep');\nconsole.log(util);\n",
      "utf8",
    );

    const report: BuildReport = { timings: {} };
    const index = await buildProjectIndexFromFiles(root, [main], { report });
    const fallback = report.graph?.fallbackImportExtraction;

    expect(fallback).toBeDefined();
    expect(fallback?.total ?? 0).toBe(0);

    const normalizedMain = main.replace(/\\/g, "/");
    const normalizedDep = dep.replace(/\\/g, "/");
    const mod = index.byFile.get(normalizedMain);
    const importBinding = mod?.imports.find(
      (entry) =>
        entry.kind === "default" &&
        entry.local === "util" &&
        entry.from === "./dep",
    );
    const edge = index.graph.edges.find(
      (entry) =>
        entry.from === normalizedMain &&
        entry.to.type === "file" &&
        entry.to.path === normalizedDep,
    );
    expect(importBinding).toBeTruthy();
    expect(edge).toBeTruthy();
  });

  it("preserves // inside string literals while stripping comments", () => {
    const source = [
      'const cdn = "//cdn.example.com/lib.js";',
      'const api = "https://api.example.com/v1";',
      "const tpl = `${base}//path`;",
      "// remove me",
      "const keep = 1; /* also remove */",
    ].join("\n");

    const stripped = stripJsLikeComments(source);

    expect(stripped).toContain('"//cdn.example.com/lib.js"');
    expect(stripped).toContain('"https://api.example.com/v1"');
    expect(stripped).toContain("`${base}//path`");
    expect(stripped).not.toContain("// remove me");
    expect(stripped).not.toContain("/* also remove */");
  });
});
