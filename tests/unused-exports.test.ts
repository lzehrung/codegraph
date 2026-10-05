import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProjectIndexFromFiles, findReferences } from "../src/index.js";
import { findUnusedExports } from "../src/indexer/unused-exports.js";
import { fileIdentityKey } from "../src/util/paths.js";

import type { BuildReport } from "../src/indexer.js";

const sources: Record<string, string> = {
  "unused.ts": "export function orphan() { return 1; }\n",
  "used.ts": "export function called() { return 2; }\n",
  "consumer.ts": 'import { called } from "./used";\ncalled();\n',
  "reexported.ts": "export function kept() { return 3; }\n",
  "barrel.ts": 'export { kept } from "./reexported";\n',
  "entry.ts": "export function entryExport() { return 4; }\n",
  "main-entry.ts": "export function mainExport() { return 5; }\n",
  "bin.ts": "export function binExport() { return 6; }\n",
  "dynamic.ts": "export function dynamicValue() { return 7; }\n",
  // Dynamic module loading is intentional: there may be no static member reference.
  "loader.ts": 'async function load() { return import("./dynamic"); }\n',
};

describe("findUnusedExports", () => {
  it("keeps only the unused fixture across five usage cases", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-unused-exports-"));
    try {
      const files = await Promise.all(
        Object.entries(sources).map(async ([name, source]) => {
          const file = path.join(root, name);
          await writeFile(file, source, "utf8");
          return file;
        }),
      );
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          exports: { ".": { import: "./entry.ts" } },
          main: "main-entry",
          bin: { app: "./bin.ts" },
        }),
        "utf8",
      );
      const index = await buildProjectIndexFromFiles(root, files, { cache: "off" });
      const unusedFile = path.join(root, "unused.ts");
      const def = index.byFile.get(fileIdentityKey(unusedFile))?.locals.find((item) => item.localName === "orphan");
      expect(def).toBeDefined();
      if (!def) return;
      const refs = await findReferences(index, { def });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.referenceCoverage.state).toBe("complete");
      expect(refs.references.every((ref) => fileIdentityKey(ref.file) === fileIdentityKey(unusedFile))).toBe(true);
      const candidates = await findUnusedExports(index);
      expect(candidates).toEqual([
        expect.objectContaining({
          file: unusedFile.replaceAll("\\", "/"),
          name: "orphan",
          exportedAs: "orphan",
          kind: "function",
          reason: "no references found in the indexed project",
          range: { start: expect.objectContaining({ line: 1 }), end: expect.any(Object) },
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("protects a default index entry but reports another unused export", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-unused-default-entry-"));
    try {
      const entryFile = path.join(root, "index.ts");
      const unusedFile = path.join(root, "unused.ts");
      await writeFile(entryFile, "export function packageEntry() { return 1; }\n", "utf8");
      await writeFile(unusedFile, sources["unused.ts"]!, "utf8");
      await writeFile(path.join(root, "package.json"), "{}", "utf8");
      const index = await buildProjectIndexFromFiles(root, [entryFile, unusedFile], { cache: "off" });
      expect(await findUnusedExports(index)).toEqual([
        expect.objectContaining({ file: unusedFile.replaceAll("\\", "/"), name: "orphan" }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not claim unused exports when package metadata cannot be read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-unused-metadata-"));
    try {
      const file = path.join(root, "unused.ts");
      await writeFile(file, sources["unused.ts"]!, "utf8");
      await writeFile(path.join(root, "package.json"), "{invalid", "utf8");
      const index = await buildProjectIndexFromFiles(root, [file], { cache: "off" });
      expect(await findUnusedExports(index)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not label wildcard package entry points unused", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-unused-wildcard-"));
    try {
      const file = path.join(root, "unused.ts");
      await writeFile(file, sources["unused.ts"]!, "utf8");
      await writeFile(path.join(root, "package.json"), JSON.stringify({ exports: { "./*": "./*.ts" } }), "utf8");
      const index = await buildProjectIndexFromFiles(root, [file], { cache: "off" });
      expect(await findUnusedExports(index)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits a declaration when reference coverage is partial", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-unused-partial-"));
    try {
      const file = path.join(root, "unused.ts");
      await writeFile(file, sources["unused.ts"]!, "utf8");
      const report: BuildReport = { timings: {} };
      const index = await buildProjectIndexFromFiles(root, [file], {
        cache: "off",
        report,
      });
      if (!report.backend) throw new Error("Expected a backend report");
      report.backend.parser = {
        total: 1,
        byLanguage: { typescript: 1 },
        files: [{ file, languageId: "typescript" }],
      };
      const def = index.byFile.get(fileIdentityKey(file))?.locals.find((item) => item.localName === "orphan");
      if (!def) throw new Error("Expected orphan declaration");
      const refs = await findReferences(index, { def });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") return;
      expect(refs.referenceCoverage).toMatchObject({
        state: "partial",
        reasons: ["parser_degraded"],
      });
      expect(await findUnusedExports(index)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
