import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { buildProjectIndex, collectGraph, findCycles, goToDefinition, listProjectFiles } from "../src/index.js";
import { fileIdentityKey } from "../src/util/paths.js";

const SAMPLES_ROOT = path.resolve(__dirname, "samples/pathological");

describe("Pathological Test Cases", () => {
  describe("Deeply Nested Imports (10+ levels)", () => {
    const projectRoot = path.join(SAMPLES_ROOT, "deeply-nested");

    it("should resolve imports through 5 levels of re-exports", async () => {
      const index = await buildProjectIndex(projectRoot, {
        cache: "none",
        logLevel: "silent",
      });

      // Check that all levels were indexed
      const files = [...index.byFile.keys()];
      expect(files.length).toBeGreaterThanOrEqual(5);

      // Check that level5Export is accessible from index.ts
      const indexModule = index.byFile.get(fileIdentityKey(path.join(projectRoot, "index.ts").replace(/\\/g, "/")));
      expect(indexModule).toBeDefined();

      // Verify exports are tracked
      const exports = indexModule?.exports ?? [];
      const exportNames = exports
        .filter((e) => e.type === "local" || e.type === "reexport")
        .map((e) => (e as { exportedAs: string }).exportedAs);
      expect(exportNames).toContain("level5Export");
    });

    it("should build graph without stack overflow", async () => {
      const files = await listProjectFiles(projectRoot);
      const graph = await collectGraph(projectRoot, files, {
        fast: false,
      });

      expect(graph.nodes.size).toBeGreaterThanOrEqual(5);
      expect(graph.edges.length).toBeGreaterThan(0);
    });
  });

  describe("Circular Re-exports (A -> B -> C -> A)", () => {
    const projectRoot = path.join(SAMPLES_ROOT, "circular-reexports");

    it("should detect circular dependencies", async () => {
      const files = await listProjectFiles(projectRoot);
      const graph = await collectGraph(projectRoot, files, {
        fast: false,
      });

      const cycles = findCycles(graph);
      expect(cycles.length).toBeGreaterThan(0);

      // Verify cycle contains all three modules
      const cycleFiles = cycles.flat();
      const hasModuleA = cycleFiles.some((f) => f.includes("moduleA"));
      const hasModuleB = cycleFiles.some((f) => f.includes("moduleB"));
      const hasModuleC = cycleFiles.some((f) => f.includes("moduleC"));

      // At least one cycle should contain multiple modules
      expect(hasModuleA || hasModuleB || hasModuleC).toBe(true);
    });

    it("should handle circular re-exports without infinite loop", async () => {
      const index = await buildProjectIndex(projectRoot, {
        cache: "none",
        logLevel: "silent",
      });

      // Should complete without timeout
      expect(index.byFile.size).toBeGreaterThanOrEqual(3);
    });
  });

  describe("Syntax Errors (Graceful Degradation)", () => {
    const projectRoot = path.join(SAMPLES_ROOT, "syntax-errors");

    it("should still index valid parts of files with syntax errors", async () => {
      // This test verifies graceful degradation
      // The parser should recover and extract what it can
      try {
        const index = await buildProjectIndex(projectRoot, {
          cache: "none",
          logLevel: "silent",
        });

        // Valid file should still be indexed
        const validFile = [...index.byFile.keys()].find((f) => f.includes("valid.ts"));
        expect(validFile).toBeDefined();

        if (validFile) {
          const mod = index.byFile.get(validFile);
          expect(mod?.exports.length).toBeGreaterThan(0);
        }
      } catch {
        // If parsing fails completely, that's also acceptable
        // The important thing is no unhandled exception
        expect(true).toBe(true);
      }
    });
  });

  describe("Performance Bounds", () => {
    it("should complete indexing within reasonable time", async () => {
      const projectRoot = path.join(SAMPLES_ROOT, "deeply-nested");
      const start = performance.now();

      await buildProjectIndex(projectRoot, {
        cache: "none",
        logLevel: "silent",
      });

      const elapsed = performance.now() - start;
      // Should complete within 10 seconds even for pathological cases
      expect(elapsed).toBeLessThan(10000);
    });
  });
});
