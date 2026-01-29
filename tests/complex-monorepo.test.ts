import { describe, it, expect } from "vitest";
import path from "node:path";
import { collectGraph, buildProjectIndex } from "../src/index.js";

describe("Complex Monorepo Scenarios", () => {
  const root = path.join(process.cwd(), "tests", "samples", "complex-monorepo");

  it("resolves path aliases from tsconfig.json", async () => {
    const mainFile = path.join(root, "packages/web-app/src/main.ts").replace(/\\/g, "/");
    const graph = await collectGraph(root, [mainFile]);

    // Check if @complex/core-logic resolves to packages/core-logic/src/index.ts
    const hasCoreLogicEdge = graph.edges.some(
      (e) =>
        e.from === mainFile &&
        e.raw === "@complex/core-logic" &&
        e.to.type === "file" &&
        e.to.path.endsWith("packages/core-logic/src/index.ts")
    );
    expect(hasCoreLogicEdge).toBe(true);

    // Check if @complex/shared-types resolves to packages/shared-types/src/index.ts
    const sharedTypesEdge = graph.edges.find(
      (e) =>
        e.from === mainFile &&
        e.raw === "@complex/shared-types" &&
        e.to.type === "file" &&
        e.to.path.endsWith("packages/shared-types/src/index.ts")
    );
    expect(sharedTypesEdge).toBeDefined();
    expect(sharedTypesEdge?.typeOnly).toBe(true);
  });

  it("handles barrel circularity and local cycles", async () => {
    const internalFile = path.join(root, "packages/core-logic/src/internal.ts").replace(/\\/g, "/");
    const index = await buildProjectIndex(root);
    
    // Verify that internal.ts can resolve 'login' which is exported by the barrel it imports from
    const fileIndex = index.byFile.get(internalFile);
    expect(fileIndex).toBeDefined();
    
    // Find the import from './index'
    const loginImport = fileIndex?.imports.find(i => i.from === './index');
    expect(loginImport).toBeDefined();
    
    if (loginImport?.kind === 'named') {
      expect(loginImport.imported).toBe('login');
    } else {
      throw new Error(`Expected named import, got ${loginImport?.kind}`);
    }
    
    expect(loginImport?.resolved).toContain("packages/core-logic/src/index.ts");
  });

  it("detects dynamic imports", async () => {
    const mainFile = path.join(root, "packages/web-app/src/main.ts").replace(/\\/g, "/");
    const graph = await collectGraph(root, [mainFile]);

    const hasDynamicEdge = graph.edges.some(
      (e) =>
        e.from === mainFile &&
        e.raw === "./plugins/logger" &&
        e.to.type === "file" &&
        e.to.path.endsWith("packages/web-app/src/plugins/logger.ts")
    );
    expect(hasDynamicEdge).toBe(true);
  });

  it("handles type-only imports in TS files", async () => {
    const mainFile = path.join(root, "packages/web-app/src/main.ts").replace(/\\/g, "/");
    const index = await buildProjectIndex(root);
    const fileIndex = index.byFile.get(mainFile);
    
    const typeImport = fileIndex?.imports.find(i => i.from === '@complex/shared-types');
    expect(typeImport).toBeDefined();
    // This confirms the fix for TS type-only detection
    expect(typeImport?.typeOnly).toBe(true);
    expect(typeImport?.resolved).toContain("packages/shared-types/src/index.ts");
  });

  it("handles type-only imports in TSX files", async () => {
    const tsxFile = path.join(root, "packages/web-app/src/UserProfile.tsx").replace(/\\/g, "/");
    const index = await buildProjectIndex(root);
    const fileIndex = index.byFile.get(tsxFile);
    
    const typeImport = fileIndex?.imports.find(i => i.from === '@complex/shared-types');
    expect(typeImport).toBeDefined();
    // This confirms the fix for TSX type-only detection
    expect(typeImport?.typeOnly).toBe(true);
  });
});
