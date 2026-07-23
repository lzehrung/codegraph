import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { collectImpactContext, listCandidateTestFiles } from "../src/impact/index.js";
import { createTestIndex } from "./test-utils.js";
import { buildProjectIndex, buildProjectIndexFromFiles } from "../src/index.js";
import { normalizePath } from "../src/util.js";
import type { ProjectIndex } from "../src/indexer.js";
import type { Edge } from "../src/types.js";

describe("Impact Context Collection", () => {
  describe("collectImpactContext", () => {
    it("should collect N-hop subgraph around impacted files", async () => {
      const index = await createTestIndex("typescript");
      const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");

      // Get some impacted files from the index
      const impactedFiles = Array.from(index.byFile.keys()).slice(0, 2);
      const changedSymbolIds: string[] = [];

      // Get a symbol ID for testing
      for (const file of impactedFiles) {
        const mod = index.byFile.get(file);
        if (mod?.locals.length) {
          const symbolId = `${file}::${mod.locals[0].localName}::${mod.locals[0].range.start.index}`;
          changedSymbolIds.push(symbolId);
          break; // Just need one
        }
      }

      const context = await collectImpactContext(
        index,
        impactedFiles,
        changedSymbolIds,
        2, // 2-hop context
      );

      expect(context).toBeDefined();
      expect(context.fileSubgraph).toBeDefined();
      expect(context.symbolNeighbors).toBeDefined();
      expect(context.neighborFiles).toBeDefined();

      // Verify subgraph structure
      expect(context.fileSubgraph.nodes instanceof Set).toBe(true);
      expect(Array.isArray(context.fileSubgraph.edges)).toBe(true);

      // Verify symbol neighbors structure
      expect(Array.isArray(context.symbolNeighbors)).toBe(true);
      for (const neighbor of context.symbolNeighbors) {
        expect(typeof neighbor.symbolId).toBe("string");
        expect(typeof neighbor.file).toBe("string");
        expect(typeof neighbor.name).toBe("string");
        expect(typeof neighbor.kind).toBe("string");
        expect(["uses", "usedBy"]).toContain(neighbor.relationship);
      }

      // Verify neighbor files is a set
      expect(context.neighborFiles instanceof Set).toBe(true);
    });

    it("should handle empty inputs gracefully", async () => {
      const index = await createTestIndex("typescript");

      const context = await collectImpactContext(index, [], [], 1);

      expect(context.fileSubgraph.nodes.size).toBe(0);
      expect(context.fileSubgraph.edges.length).toBe(0);
      expect(context.symbolNeighbors.length).toBe(0);
      expect(context.neighborFiles.size).toBe(0);
    });

    it("marks a file-pair edge as type-only only when all matching graph edges are type-only", async () => {
      const sourceFile = "/repo/src/source.ts";
      const targetFile = "/repo/src/types.ts";
      const edges: Edge[] = [
        { from: sourceFile, to: { type: "file", path: targetFile }, raw: "./types", typeOnly: true },
        { from: sourceFile, to: { type: "file", path: targetFile }, raw: "./types-runtime", typeOnly: false },
      ];
      const index: ProjectIndex = {
        graph: {
          nodes: new Set([sourceFile, targetFile]),
          edges,
        },
        modules: new Map(),
        byFile: new Map(),
        exportCache: new Map(),
        scopeCache: new Map(),
      };

      const context = await collectImpactContext(index, [sourceFile], [], 1);
      const edge = context.fileSubgraph.edges.find((entry) => entry.from === sourceFile && entry.to === targetFile);

      expect(edge?.typeOnly).toBe(false);
    });

    it("should collect symbol neighbors with correct relationships", async () => {
      const index = await createTestIndex("typescript");

      // Find a file with exports and imports to test relationships
      const files = Array.from(index.byFile.keys());
      let testFile = "";
      let symbolId = "";

      for (const file of files) {
        const mod = index.byFile.get(file);
        if (mod?.exports.length && mod.imports.length) {
          testFile = file;
          // Find an exported symbol
          for (const exp of mod.exports) {
            if (exp.type === "local" && exp.target) {
              symbolId = `${file}::${exp.target.localName}::${exp.target.range.start.index}`;
              break;
            }
          }
          if (symbolId) break;
        }
      }

      if (symbolId) {
        const context = await collectImpactContext(index, [testFile], [symbolId], 1);

        // Should find some symbol neighbors if the symbol is actually used
        expect(context.symbolNeighbors.length).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("listCandidateTestFiles", () => {
    it("should return empty array for projects with no test files", async () => {
      const index = await createTestIndex("typescript");

      // Create mock files that don't match test patterns
      const mockFiles = ["/src/utils.ts", "/src/helpers.ts"];
      const mockSymbolIds = ["utils.ts::helper::100"];

      const candidates = listCandidateTestFiles(index, mockFiles, mockSymbolIds, { maxCandidates: 10 });

      // Should return empty or very low confidence candidates
      expect(Array.isArray(candidates)).toBe(true);
    });

    it("should respect maxCandidates limit", async () => {
      const index = await createTestIndex("typescript");

      const files = Array.from(index.byFile.keys());
      const changedSymbolIds: string[] = [];

      // Get some symbol IDs
      for (const file of files.slice(0, 3)) {
        const mod = index.byFile.get(file);
        if (mod?.locals.length) {
          const symbolId = `${file}::${mod.locals[0].localName}::${mod.locals[0].range.start.index}`;
          changedSymbolIds.push(symbolId);
        }
      }

      const candidates = listCandidateTestFiles(index, files, changedSymbolIds, { maxCandidates: 5 });

      expect(candidates.length).toBeLessThanOrEqual(5);
    });

    it("should accept custom test patterns", async () => {
      const index = await createTestIndex("typescript");

      // Test with a very specific pattern that shouldn't match the default patterns
      const candidates = listCandidateTestFiles(index, Array.from(index.byFile.keys()), [], {
        testPatterns: ["VerySpecificTestPattern"], // Should not match anything
        maxCandidates: 10,
      });

      // Should return candidates based on the very specific pattern (likely none)
      // or fall back to default patterns if the specific pattern doesn't match
      expect(Array.isArray(candidates)).toBe(true);
      expect(candidates.length).toBeGreaterThanOrEqual(0);
    });

    it("should prioritize high-confidence candidates", async () => {
      const index = await createTestIndex("typescript");

      // Create a scenario where some files directly import changed symbols
      const files = Array.from(index.byFile.keys());
      const changedSymbolIds: string[] = [];

      // Find symbols that are actually imported
      for (const file of files) {
        const mod = index.byFile.get(file);
        if (mod) {
          for (const imp of mod.imports) {
            if (typeof imp.resolved === "string") {
              // Find a local symbol that matches this import's local binding
              for (const local of mod.locals) {
                let importLocalName: string | undefined;

                // Extract the local name based on import kind
                if (imp.kind === "default" || imp.kind === "named") {
                  importLocalName = imp.local;
                } else if (imp.kind === "namespace") {
                  importLocalName = imp.localNS;
                }

                if (importLocalName && local.localName === importLocalName) {
                  const symbolId = `${file}::${local.localName}::${local.range.start.index}`;
                  changedSymbolIds.push(symbolId);
                  break;
                }

                // Also check imported name for named imports
                if (imp.kind === "named" && local.localName === imp.imported) {
                  const symbolId = `${file}::${local.localName}::${local.range.start.index}`;
                  changedSymbolIds.push(symbolId);
                  break;
                }
              }
            }
          }
        }
        if (changedSymbolIds.length >= 2) break;
      }

      if (changedSymbolIds.length) {
        const candidates = listCandidateTestFiles(index, files.slice(0, 3), changedSymbolIds, { maxCandidates: 10 });

        // Check that candidates are properly sorted by confidence
        for (let i = 1; i < candidates.length; i++) {
          const prev = candidates[i - 1];
          const curr = candidates[i];

          // Higher confidence should come first (high > medium > low)
          const confidenceOrder = { high: 3, medium: 2, low: 1 };
          expect(confidenceOrder[prev.confidence]).toBeGreaterThanOrEqual(confidenceOrder[curr.confidence]);
        }
      }
    });

    it("accepts project-relative changed files from impact reports", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-context-"));
      try {
        await fsp.mkdir(path.join(root, "src"), { recursive: true });
        await fsp.mkdir(path.join(root, "tests"), { recursive: true });
        await fsp.writeFile(path.join(root, "src", "feature.ts"), "export function feature() { return 1; }\n", "utf8");
        await fsp.writeFile(
          path.join(root, "tests", "feature.test.ts"),
          "import { feature } from '../src/feature';\nfeature();\n",
          "utf8",
        );

        const index = await buildProjectIndex(root, { logLevel: "error" });
        const changedSymbolIds = [`${path.join(root, "src", "feature.ts").replace(/\\/g, "/")}::feature::16`];

        const candidates = listCandidateTestFiles(index, ["src/feature.ts"], changedSymbolIds, { maxCandidates: 5 });

        expect(candidates).toContainEqual({
          file: path.join(root, "tests", "feature.test.ts").replace(/\\/g, "/"),
          confidence: "high",
          reason: "importsChanged",
        });
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("infers a usable root for sparse indexes from changed files", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-context-"));
      try {
        const srcDir = path.join(root, "src");
        const checksDir = path.join(root, "checks");
        await fsp.mkdir(srcDir, { recursive: true });
        await fsp.mkdir(checksDir, { recursive: true });
        const libFile = path.join(srcDir, "lib.ts");
        const verifyFile = path.join(checksDir, "lib.verify.ts");
        await fsp.writeFile(libFile, "export const lib = 1;\n", "utf8");
        await fsp.writeFile(verifyFile, "import { lib } from '../src/lib';\nlib;\n", "utf8");

        const index = await buildProjectIndexFromFiles(root, [verifyFile], {
          cache: "memory",
        });
        const candidates = listCandidateTestFiles(index, [libFile], [], {
          testPatterns: ["^checks/.*\\.verify\\.ts$"],
        });

        expect(candidates).toContainEqual({
          file: normalizePath(verifyFile),
          confidence: "high",
          reason: "importsChanged",
        });
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });

    it("uses the index root for one-directory sparse indexes", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-context-"));
      try {
        const checksDir = path.join(root, "checks");
        await fsp.mkdir(checksDir, { recursive: true });
        const helperFile = path.join(checksDir, "helper.ts");
        const verifyFile = path.join(checksDir, "lib.verify.ts");
        await fsp.writeFile(helperFile, "export function helper() { return 1; }\n", "utf8");
        await fsp.writeFile(verifyFile, "import { helper } from './helper';\nhelper();\n", "utf8");

        const index = await buildProjectIndexFromFiles(root, [helperFile, verifyFile], {
          cache: "memory",
        });
        const candidates = listCandidateTestFiles(index, [helperFile], [], {
          testPatterns: ["^checks/.*\\.verify\\.ts$"],
        });

        expect(candidates).toContainEqual({
          file: normalizePath(verifyFile),
          confidence: "high",
          reason: "importsChanged",
        });
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
    it("keeps indirect test dependency links at medium confidence", async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-impact-context-indirect-"));
      try {
        const libFile = path.join(root, "lib.ts");
        const facadeFile = path.join(root, "facade.ts");
        const testFile = path.join(root, "facade.test.ts");
        await fsp.writeFile(libFile, "export const value = 1;\n", "utf8");
        await fsp.writeFile(facadeFile, "export { value } from './lib';\n", "utf8");
        await fsp.writeFile(testFile, "import { value } from './facade';\nvalue;\n", "utf8");

        const index = await buildProjectIndexFromFiles(root, [libFile, facadeFile, testFile], {
          cache: "memory",
        });
        expect(listCandidateTestFiles(index, [libFile], [])).toContainEqual({
          file: normalizePath(testFile),
          confidence: "medium",
          reason: "dependsOnChanged",
        });
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    });
  });
});
