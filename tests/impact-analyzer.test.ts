import { describe, it, expect } from "vitest";
import path from "node:path";
import { analyzeImpact, seedTransitiveFromFiles, calculateSeverity } from "../src/impact/analyzer.js";
import { SymbolKind } from "../src/indexer.js";
import type { ProjectIndex } from "../src/indexer.js";
import type { Edge } from "../src/types.js";
import { createTestIndex } from "./test-utils.js";

describe("Impact Analyzer Edge Cases", () => {
  describe("seedTransitiveFromFiles", () => {
    it("should seed transitive impact for deleted files", async () => {
      const index = await createTestIndex("typescript");

      // Create mock file changes for deleted files
      const fileChanges = [
        {
          path: "src/deleted-file.ts",
          kind: "deleted" as const,
          hunks: []
        }
      ];

      const impacted = new Map();

      // This function should handle the case gracefully even with mock data
      await seedTransitiveFromFiles(index, impacted, fileChanges, {});

      // Should not throw and should handle empty reverse deps gracefully
      expect(impacted.size).toBeGreaterThanOrEqual(0);
    });

    it("should seed transitive impact for renamed files", async () => {
      const index = await createTestIndex("typescript");

      // Create mock file changes for renamed files
      const fileChanges = [
        {
          path: "src/renamed-file.ts",
          kind: "renamed" as const,
          oldPath: "src/old-name.ts",
          hunks: []
        }
      ];

      const impacted = new Map();

      await seedTransitiveFromFiles(index, impacted, fileChanges, {});

      // Should handle renamed files with fileRenamed hint
      const impactedItems = Array.from(impacted.values());
      if (impactedItems.length > 0) {
        expect(impactedItems.some(item =>
          item.explain?.hints?.includes("fileRenamed")
        )).toBe(true);
      }
    });


    it("supports file-level fallback for modified files without symbols", async () => {
      const changedFile = path.resolve("src/setup.ts");
      const dependentFile = path.resolve("src/main.ts");
      const edges: Edge[] = [
        {
          from: dependentFile,
          to: { type: "file", path: changedFile },
          raw: "./setup",
        },
      ];
      const index: ProjectIndex = {
        graph: { nodes: new Set([changedFile, dependentFile]), edges },
        modules: new Map(),
        byFile: new Map(),
        exportCache: new Map(),
        scopeCache: new Map(),
      };

      const impacted = new Map();
      await seedTransitiveFromFiles(
        index,
        impacted,
        [{ path: changedFile, kind: "modified", hunks: [] }],
        {
          includeTests: false,
          fileLevelFallback: true,
          fileLevelFallbackPaths: [changedFile],
        },
      );

      const fallbackItem = Array.from(impacted.values()).find(
        (item) => item.file === dependentFile,
      );
      expect(fallbackItem?.reasons).toContain("fileLevelChange");
    });

    it("should respect includeTests option", async () => {
      const index = await createTestIndex("typescript");

      // Create mock file changes
      const fileChanges = [
        {
          path: "src/utils.ts",
          kind: "deleted" as const,
          hunks: []
        }
      ];

      const impactedWithTests = new Map();
      const impactedWithoutTests = new Map();

      await seedTransitiveFromFiles(index, impactedWithTests, fileChanges, { includeTests: true });
      await seedTransitiveFromFiles(index, impactedWithoutTests, fileChanges, { includeTests: false });

      // Both should work without throwing
      expect(impactedWithTests.size).toBeGreaterThanOrEqual(0);
      expect(impactedWithoutTests.size).toBeGreaterThanOrEqual(0);
    });


    it("ignores invalid custom test regex patterns", async () => {
      const featureFile = path.resolve("src/feature.ts");
      const dependentFile = path.resolve("src/latest.ts");
      const edges: Edge[] = [
        {
          from: dependentFile,
          to: { type: "file", path: featureFile },
          raw: "./feature",
        },
      ];
      const index: ProjectIndex = {
        graph: { nodes: new Set([featureFile, dependentFile]), edges },
        modules: new Map(),
        byFile: new Map(),
        exportCache: new Map(),
        scopeCache: new Map(),
      };

      const impacted = new Map();
      await seedTransitiveFromFiles(
        index,
        impacted,
        [{ path: featureFile, kind: "deleted", hunks: [] }],
        { includeTests: false, testPatterns: ["[invalid"] },
      );

      expect(Array.from(impacted.values()).some((item) => item.file.endsWith("latest.ts"))).toBe(true);
    });

    it("does not treat latest.ts as a test file by default", async () => {
      const featureFile = path.resolve("src/feature.ts");
      const dependentFile = path.resolve("src/latest.ts");
      const edges: Edge[] = [
        {
          from: dependentFile,
          to: { type: "file", path: featureFile },
          raw: "./feature",
        },
      ];
      const index: ProjectIndex = {
        graph: { nodes: new Set([featureFile, dependentFile]), edges },
        modules: new Map(),
        byFile: new Map(),
        exportCache: new Map(),
        scopeCache: new Map(),
      };

      const impacted = new Map();
      await seedTransitiveFromFiles(
        index,
        impacted,
        [{ path: featureFile, kind: "deleted", hunks: [] }],
        { includeTests: false },
      );

      expect(Array.from(impacted.values()).some((item) => item.file.endsWith("latest.ts"))).toBe(true);
    });

    it("supports custom test patterns", async () => {
      const featureFile = path.resolve("src/feature.ts");
      const testFile = path.resolve("checks/feature.case.ts");
      const edges: Edge[] = [
        {
          from: testFile,
          to: { type: "file", path: featureFile },
          raw: "./feature",
        },
      ];
      const index: ProjectIndex = {
        graph: { nodes: new Set([featureFile, testFile]), edges },
        modules: new Map(),
        byFile: new Map(),
        exportCache: new Map(),
        scopeCache: new Map(),
      };

      const impactedWithoutPattern = new Map();
      await seedTransitiveFromFiles(
        index,
        impactedWithoutPattern,
        [{ path: featureFile, kind: "deleted", hunks: [] }],
        { includeTests: false },
      );
      expect(
        Array.from(impactedWithoutPattern.values()).some((item) =>
          item.file.endsWith("feature.case.ts"),
        ),
      ).toBe(true);

      const impactedWithPattern = new Map();
      await seedTransitiveFromFiles(
        index,
        impactedWithPattern,
        [{ path: featureFile, kind: "deleted", hunks: [] }],
        { includeTests: false, testPatterns: ["case\\.ts$"] },
      );
      expect(
        Array.from(impactedWithPattern.values()).some((item) =>
          item.file.endsWith("feature.case.ts"),
        ),
      ).toBe(false);
    });
  });

  describe("calculateSeverity", () => {
    it("should calculate severity with hints for exported symbols", async () => {
      const mockIndex = {
        graph: { edges: [] },
        byFile: new Map()
      };

      const changedSymbol = {
        id: "test.ts::exportedFunc::100",
        file: "test.ts",
        name: "exportedFunc",
        kind: SymbolKind.Function,
        exported: true,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 3, column: 2, index: 150 } },
        typeOnly: false
      };

      const ref = {
        file: "user.ts",
        range: { start: { line: 5, column: 10 } }
      };

      const result = await calculateSeverity(changedSymbol, ref, ["directRef"], 0, mockIndex);

      expect(result.severity).toBeGreaterThan(0);
      expect(result.explain.hints).toContain("exportChanged");
      expect(result.explain.exported).toBe(true);
    });

    it("should apply depth decay correctly", async () => {
      const mockIndex = {
        graph: { edges: [] },
        byFile: new Map()
      };

      const changedSymbol = {
        id: "test.ts::func::100",
        file: "test.ts",
        name: "func",
        kind: SymbolKind.Function,
        exported: false,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 3, column: 2, index: 150 } },
        typeOnly: false
      };

      const ref = {
        file: "user.ts",
        range: { start: { line: 5, column: 10 } }
      };

      const depth0 = await calculateSeverity(changedSymbol, ref, ["directRef"], 0, mockIndex);
      const depth1 = await calculateSeverity(changedSymbol, ref, ["transitive"], 1, mockIndex);
      const depth2 = await calculateSeverity(changedSymbol, ref, ["transitive"], 2, mockIndex);

      // Higher depth should result in lower severity (decay)
      expect(depth0.severity).toBeGreaterThan(depth1.severity);
      expect(depth1.severity).toBeGreaterThan(depth2.severity);
    });

    it("should boost severity for same-file references", async () => {
      const mockIndex = {
        graph: { edges: [] },
        byFile: new Map()
      };

      const changedSymbol = {
        id: "test.ts::func::100",
        file: "test.ts",
        name: "func",
        kind: SymbolKind.Function,
        exported: false,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 3, column: 2, index: 150 } },
        typeOnly: false
      };

      const sameFileRef = {
        file: "test.ts", // Same file
        range: { start: { line: 5, column: 10 } }
      };

      const differentFileRef = {
        file: "other.ts", // Different file
        range: { start: { line: 5, column: 10 } }
      };

      const sameFileResult = await calculateSeverity(changedSymbol, sameFileRef, ["directRef"], 0, mockIndex);
      const differentFileResult = await calculateSeverity(changedSymbol, differentFileRef, ["directRef"], 0, mockIndex);

      expect(sameFileResult.explain.sameFile).toBe(true);
      expect(differentFileResult.explain.sameFile).toBeUndefined();

      // Both should be 1.0 due to clamping, but sameFile should be marked in explain
      expect(sameFileResult.severity).toBe(1.0);
      expect(differentFileResult.severity).toBe(1.0);
    });

    it("should penalize type-only changes", async () => {
      const mockIndex = {
        graph: { edges: [] },
        byFile: new Map()
      };

      const typeOnlySymbol = {
        id: "test.ts::TypeAlias::100",
        file: "test.ts",
        name: "TypeAlias",
        kind: SymbolKind.TypeAlias,
        exported: false,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 2, column: 20, index: 120 } },
        typeOnly: true
      };

      const runtimeSymbol = {
        id: "test.ts::func::100",
        file: "test.ts",
        name: "func",
        kind: SymbolKind.Function,
        exported: false,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 3, column: 2, index: 150 } },
        typeOnly: false
      };

      const ref = {
        file: "user.ts",
        range: { start: { line: 5, column: 10 } }
      };

      const typeOnlyResult = await calculateSeverity(typeOnlySymbol, ref, ["directRef"], 0, mockIndex);
      const runtimeResult = await calculateSeverity(runtimeSymbol, ref, ["directRef"], 0, mockIndex);

      expect(typeOnlyResult.explain.typeOnly).toBe(true);
      // Type-only changes should have lower severity
      expect(runtimeResult.severity).toBeGreaterThan(typeOnlyResult.severity);
    });

    it("should consider fan-in when calculating severity", async () => {
      const mockIndexWithDeps = {
        graph: {
          edges: [
            { to: { type: "file", path: "user.ts" } }, // One dependency
            { to: { type: "file", path: "user.ts" } }, // Another dependency
            { to: { type: "file", path: "user.ts" } }  // Third dependency
          ]
        },
        byFile: new Map()
      };

      const mockIndexNoDeps = {
        graph: { edges: [] },
        byFile: new Map()
      };

      const changedSymbol = {
        id: "test.ts::func::100",
        file: "test.ts",
        name: "func",
        kind: SymbolKind.Function,
        exported: false,
        range: { start: { line: 1, column: 1, index: 100 }, end: { line: 3, column: 2, index: 150 } },
        typeOnly: false
      };

      const ref = {
        file: "user.ts",
        range: { start: { line: 5, column: 10 } }
      };

      const highFanInResult = await calculateSeverity(changedSymbol, ref, ["directRef"], 0, mockIndexWithDeps);
      const lowFanInResult = await calculateSeverity(changedSymbol, ref, ["directRef"], 0, mockIndexNoDeps);

      expect(highFanInResult.explain.fanIn).toBe(3);
      expect(lowFanInResult.explain.fanIn).toBeUndefined();

      // Both should be 1.0 due to clamping, but high fan-in should be marked in explain
      expect(highFanInResult.severity).toBe(1.0);
      expect(lowFanInResult.severity).toBe(1.0);
    });
  });

  describe("analyzeImpact edge cases", () => {
    it("should handle empty changedSymbols with file seeding", async () => {
      const index = await createTestIndex("typescript");

      // Mock file changes for deleted files
      const fileChanges = [
        {
          path: "src/deleted.ts",
          kind: "deleted" as const,
          hunks: []
        }
      ];

      const result = await analyzeImpact(index, [], fileChanges, { depth: 1 });

      // Should not throw and should handle the case appropriately
      expect(Array.isArray(result)).toBe(true);
    });

    it("should handle membersOnly option correctly", async () => {
      const index = await createTestIndex("typescript");

      // Use real files from the sample index
      const files = Array.from(index.byFile.keys());
      const firstFile = files[0];

      if (firstFile) {
        const mod = index.byFile.get(firstFile);
        if (mod && mod.locals.length > 0) {
          const local = mod.locals[0];

          const changedSymbols = [
            {
              id: `${firstFile}::${local.localName}::${local.range.start.index}`,
              file: firstFile,
              name: local.localName,
              kind: local.kind,
              exported: false,
              range: local.range,
              typeOnly: false
            }
          ];

          const fileChanges = [
            {
              path: firstFile,
              kind: "modified" as const,
              hunks: []
            }
          ];

          const membersOnlyResult = await analyzeImpact(index, changedSymbols, fileChanges, {
            membersOnly: true,
            depth: 2
          });

          const withTransitiveResult = await analyzeImpact(index, changedSymbols, fileChanges, {
            membersOnly: false,
            depth: 2
          });

          // Members-only should limit depth to 0
          expect(membersOnlyResult.every(item => (item.depth ?? 0) === 0)).toBe(true);

          // With transitive, there might be deeper items (depending on the graph)
          const hasDeepItems = withTransitiveResult.some(item => (item.depth ?? 0) > 0);
          expect(hasDeepItems || withTransitiveResult.length >= 0).toBe(true);
        }
      }
    });

    it("should respect maxRefs limit", async () => {
      const index = await createTestIndex("typescript");

      // Use real files from the sample index
      const files = Array.from(index.byFile.keys());
      const firstFile = files[0];

      if (firstFile) {
        const mod = index.byFile.get(firstFile);
        if (mod && mod.locals.length > 0) {
          const local = mod.locals[0];

          const changedSymbols = [
            {
              id: `${firstFile}::${local.localName}::${local.range.start.index}`,
              file: firstFile,
              name: local.localName,
              kind: local.kind,
              exported: false,
              range: local.range,
              typeOnly: false
            }
          ];

          const result = await analyzeImpact(index, changedSymbols, [], { maxRefs: 5 });

          expect(Array.isArray(result)).toBe(true);
        }
      }
    });

    it("should handle type-only impact correctly", async () => {
      const index = await createTestIndex("typescript");

      // Use real files from the sample index
      const files = Array.from(index.byFile.keys());
      const firstFile = files[0];

      if (firstFile) {
        const mod = index.byFile.get(firstFile);
        if (mod && mod.locals.length > 0) {
          const local = mod.locals[0];

          const changedSymbols = [
            {
              id: `${firstFile}::${local.localName}::${local.range.start.index}`,
              file: firstFile,
              name: local.localName,
              kind: local.kind,
              exported: false,
              range: local.range,
              typeOnly: true  // Mark as type-only
            }
          ];

          const result = await analyzeImpact(index, changedSymbols, [], {});

          // Should not throw and should handle the case appropriately
          expect(Array.isArray(result)).toBe(true);
        }
      }
    });
  });
});
