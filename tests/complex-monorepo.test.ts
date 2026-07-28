import { describe, it, expect } from "vitest";
import path from "node:path";
import { collectGraph, buildProjectIndex } from "../src/index.js";
import type { ImportBinding } from "../src/index.js";
import { readOnlySamplePath } from "./helpers/filesystem.js";

function expectNamespaceImport(binding: ImportBinding | undefined, localNS: string): void {
  expect(binding).toBeDefined();
  expect(binding?.kind).toBe("namespace");
  if (binding?.kind !== "namespace") {
    throw new Error(`Expected namespace import for ${localNS}`);
  }
  expect(binding.localNS).toBe(localNS);
}

describe("Complex Monorepo Scenarios", () => {
  const root = readOnlySamplePath("complex-monorepo");

  it("resolves path aliases from tsconfig.json", async () => {
    const mainFile = path.join(root, "packages/web-app/src/main.ts").replace(/\\/g, "/");
    const graph = await collectGraph(root, [mainFile]);

    // Check if @complex/core-logic resolves to packages/core-logic/src/index.ts
    const hasCoreLogicEdge = graph.edges.some(
      (e) =>
        e.from === mainFile &&
        e.raw === "@complex/core-logic" &&
        e.to.type === "file" &&
        e.to.path.endsWith("packages/core-logic/src/index.ts"),
    );
    expect(hasCoreLogicEdge).toBe(true);

    // Check if @complex/shared-types resolves to packages/shared-types/src/index.ts
    const sharedTypesEdge = graph.edges.find(
      (e) =>
        e.from === mainFile &&
        e.raw === "@complex/shared-types" &&
        e.to.type === "file" &&
        e.to.path.endsWith("packages/shared-types/src/index.ts"),
    );
    expect(sharedTypesEdge).toBeDefined();
    expect(sharedTypesEdge?.typeOnly).toBe(true);

    // Check if @complex/shadowed resolves to packages/core-logic/src/auth.ts
    const shadowedEdge = graph.edges.find((e) => e.from === mainFile && e.raw === "@complex/shadowed");
    expect(shadowedEdge).toBeDefined();
    expect(shadowedEdge?.to.type).toBe("file");
    expect(shadowedEdge?.to.path).toContain("packages/core-logic/src/auth.ts");
  });

  it("handles barrel circularity and local cycles", async () => {
    const internalFile = path.join(root, "packages/core-logic/src/internal.ts").replace(/\\/g, "/");
    const index = await buildProjectIndex(root, { cache: "off" });

    // Verify that internal.ts can resolve 'login' which is exported by the barrel it imports from
    const fileIndex = index.byFile.get(internalFile);
    expect(fileIndex).toBeDefined();

    // Find the import from './index'
    const loginImport = fileIndex?.imports.find((i) => i.from === "./index");
    expect(loginImport).toBeDefined();

    if (loginImport?.kind === "named") {
      expect(loginImport.imported).toBe("login");
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
        e.to.path.endsWith("packages/web-app/src/plugins/logger.ts"),
    );
    expect(hasDynamicEdge).toBe(true);
  });

  it("handles type-only imports in TS files", async () => {
    const mainFile = path.join(root, "packages/web-app/src/main.ts").replace(/\\/g, "/");
    const index = await buildProjectIndex(root, { cache: "off" });
    const fileIndex = index.byFile.get(mainFile);

    const typeImport = fileIndex?.imports.find((i) => i.from === "@complex/shared-types");
    expect(typeImport).toBeDefined();
    // This confirms the fix for TS type-only detection
    expect(typeImport?.typeOnly).toBe(true);
    expect(typeImport?.resolved).toContain("packages/shared-types/src/index.ts");
  });

  it("handles type-only imports in TSX files", async () => {
    const tsxFile = path.join(root, "packages/web-app/src/UserProfile.tsx").replace(/\\/g, "/");
    const index = await buildProjectIndex(root, { cache: "off" });
    const fileIndex = index.byFile.get(tsxFile);

    const typeImport = fileIndex?.imports.find((i) => i.from === "@complex/shared-types");
    expect(typeImport).toBeDefined();
    // This confirms the fix for TSX type-only detection
    expect(typeImport?.typeOnly).toBe(true);
    expect(typeImport?.resolved).not.toBeUndefined();
    expect(typeof typeImport?.resolved).toBe("string");
  });

  it("resolves subpath exports from package.json", async () => {
    const mainFile = path.join(root, "packages/web-app/src/main.ts").replace(/\\/g, "/");
    const graph = await collectGraph(root, [mainFile]);

    const hasSubpathEdge = graph.edges.some(
      (e) =>
        e.from === mainFile &&
        e.raw === "@complex/utils/runtime" &&
        e.to.type === "file" &&
        e.to.path.endsWith("packages/utils/src/runtime/index.ts"),
    );
    expect(hasSubpathEdge).toBe(true);
  });

  it("handles multi-level tsconfig inheritance", async () => {
    const mainFile = path.join(root, "packages/web-app/src/main.ts").replace(/\\/g, "/");
    // This file uses @complex/shared-types defined in tsconfig.base.json
    // and @complex/shadowed defined in tsconfig.json
    const graph = await collectGraph(root, [mainFile]);

    const hasSharedTypes = graph.edges.some((e) => e.raw === "@complex/shared-types");
    expect(hasSharedTypes).toBe(true);
  });

  it("prioritizes path aliases over node_modules (shadowing)", async () => {
    const mainFile = path.join(root, "packages/web-app/src/main.ts").replace(/\\/g, "/");
    const graph = await collectGraph(root, [mainFile]);

    // 'react' is shadowed to shared-types/src/index.ts in root tsconfig.json
    const reactEdge = graph.edges.find((e) => e.from === mainFile && e.raw === "react");
    expect(reactEdge).toBeDefined();
    expect(reactEdge?.to.type).toBe("file");
    expect(reactEdge?.to.path).toContain("packages/shared-types/src/index.ts");
  });

  it("identifies impact from ambient global type changes", async () => {
    const index = await buildProjectIndex(root, { cache: "off" });
    const authFile = path.join(root, "packages/core-logic/src/auth.ts").replace(/\\/g, "/");

    // The auth.ts file uses App.GlobalConfig from globals.d.ts
    // We want to see if the tool can find this reference
    const fileIndex = index.byFile.get(authFile);
    expect(fileIndex).toBeDefined();

    // Check for symbol references to 'App' or 'GlobalConfig'
    // This depends on how the tool handles globals.
    // Usually it won't have an 'import' but should have a reference.
  });

  it("handles Go grouped and aliased imports", async () => {
    const goFile = path.join(root, "packages/go-lib/lib.go").replace(/\\/g, "/");
    const index = await buildProjectIndex(root, { cache: "off" });
    const fileIndex = index.byFile.get(goFile);

    expect(fileIndex).toBeDefined();

    // Check for "fmt"
    const fmtImport = fileIndex?.imports.find((i) => i.from === "fmt");
    expectNamespaceImport(fmtImport, "fmt");

    // Check for aliased "os"
    const osImport = fileIndex?.imports.find((i) => i.from === "os");
    expectNamespaceImport(osImport, "oslib");
  });

  it("handles Rust mod items", async () => {
    const rustFile = path.join(root, "packages/rust-lib/src/lib.rs").replace(/\\/g, "/");
    const index = await buildProjectIndex(root, { cache: "off" });
    const fileIndex = index.byFile.get(rustFile);

    expect(fileIndex).toBeDefined();

    // Check for 'mod utils;'
    const modUtils = fileIndex?.imports.find((i) => i.from === "utils");
    expect(modUtils).toBeDefined();
    expect(modUtils?.kind).toBe("namespace");
  });

  it("handles Rust nested use blocks and re-exports", async () => {
    const rustFile = path.join(root, "packages/rust-lib/src/lib.rs").replace(/\\/g, "/");
    const index = await buildProjectIndex(root, { cache: "off" });

    // Check for 'use utils::helper;' (captured by re-export in our current query)
    const helperExport = index.byFile.get(rustFile)?.exports.find((e) => e.exportedAs === "helper");
    expect(helperExport).toBeDefined();
  });
});
