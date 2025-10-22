import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex } from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return dir;
}

describe("Import Resolution", () => {
  it("should resolve .js imports to .ts source files", async () => {
    const root = await mkTmpDir("dg-resolve-js-ts-");
    
    // Create a TypeScript file that exports a function
    const utilsContent = `export function helper() { return 42; }\n`;
    await fsp.writeFile(path.join(root, "utils.ts"), utilsContent, "utf8");
    
    // Create a TypeScript file that imports using .js extension (ESM style)
    const mainContent = `import { helper } from './utils.js';\nexport function main() { return helper(); }\n`;
    await fsp.writeFile(path.join(root, "main.ts"), mainContent, "utf8");
    
    const index = await buildProjectIndex(root);
    
    // Find the main module
    const mainFile = Array.from(index.byFile.keys()).find(f => f.endsWith("main.ts"));
    const utilsFile = Array.from(index.byFile.keys()).find(f => f.endsWith("utils.ts"));
    
    expect(mainFile).toBeDefined();
    expect(utilsFile).toBeDefined();
    
    const mainModule = index.byFile.get(mainFile!);
    expect(mainModule).toBeDefined();
    expect(mainModule!.imports.length).toBe(1);
    
    // The import should resolve to the .ts file, not be marked as external
    const helperImport = mainModule!.imports[0];
    expect(helperImport!.kind).toBe("named");
    expect(helperImport!.from).toBe("./utils.js");
    expect(typeof helperImport!.resolved).toBe("string");
    expect((helperImport!.resolved as string).replace(/\\/g, "/")).toBe(utilsFile!.replace(/\\/g, "/"));
  });

  it("should resolve .mjs imports to .mts source files", async () => {
    const root = await mkTmpDir("dg-resolve-mjs-mts-");
    
    const utilsContent = `export function helper() { return 42; }\n`;
    await fsp.writeFile(path.join(root, "utils.mts"), utilsContent, "utf8");
    
    const mainContent = `import { helper } from './utils.mjs';\nexport function main() { return helper(); }\n`;
    await fsp.writeFile(path.join(root, "main.mts"), mainContent, "utf8");
    
    const index = await buildProjectIndex(root);
    
    const mainFile = Array.from(index.byFile.keys()).find(f => f.endsWith("main.mts"));
    const utilsFile = Array.from(index.byFile.keys()).find(f => f.endsWith("utils.mts"));
    
    expect(mainFile).toBeDefined();
    expect(utilsFile).toBeDefined();
    
    const mainModule = index.byFile.get(mainFile!);
    const helperImport = mainModule!.imports[0];
    expect(typeof helperImport!.resolved).toBe("string");
    expect((helperImport!.resolved as string).replace(/\\/g, "/")).toBe(utilsFile!.replace(/\\/g, "/"));
  });

  it("should resolve .cjs imports to .cts source files", async () => {
    const root = await mkTmpDir("dg-resolve-cjs-cts-");
    
    const utilsContent = `export function helper() { return 42; }\n`;
    await fsp.writeFile(path.join(root, "utils.cts"), utilsContent, "utf8");
    
    const mainContent = `import { helper } from './utils.cjs';\nexport function main() { return helper(); }\n`;
    await fsp.writeFile(path.join(root, "main.cts"), mainContent, "utf8");
    
    const index = await buildProjectIndex(root);
    
    const mainFile = Array.from(index.byFile.keys()).find(f => f.endsWith("main.cts"));
    const utilsFile = Array.from(index.byFile.keys()).find(f => f.endsWith("utils.cts"));
    
    expect(mainFile).toBeDefined();
    expect(utilsFile).toBeDefined();
    
    const mainModule = index.byFile.get(mainFile!);
    const helperImport = mainModule!.imports[0];
    expect(typeof helperImport!.resolved).toBe("string");
    expect((helperImport!.resolved as string).replace(/\\/g, "/")).toBe(utilsFile!.replace(/\\/g, "/"));
  });

  it("should still resolve regular .js files when they exist", async () => {
    const root = await mkTmpDir("dg-resolve-actual-js-");
    
    // Create an actual .js file
    const utilsContent = `export function helper() { return 42; }\n`;
    await fsp.writeFile(path.join(root, "utils.js"), utilsContent, "utf8");
    
    const mainContent = `import { helper } from './utils.js';\nexport function main() { return helper(); }\n`;
    await fsp.writeFile(path.join(root, "main.js"), mainContent, "utf8");
    
    const index = await buildProjectIndex(root);
    
    const mainFile = Array.from(index.byFile.keys()).find(f => f.endsWith("main.js"));
    const utilsFile = Array.from(index.byFile.keys()).find(f => f.endsWith("utils.js"));
    
    expect(mainFile).toBeDefined();
    expect(utilsFile).toBeDefined();
    
    const mainModule = index.byFile.get(mainFile!);
    const helperImport = mainModule!.imports[0];
    expect(typeof helperImport!.resolved).toBe("string");
    expect(helperImport!.resolved).toBe(utilsFile);
  });

  it("should mark as external when neither .js nor .ts file exists", async () => {
    const root = await mkTmpDir("dg-resolve-external-");
    
    // Create a file that imports a non-existent module
    const mainContent = `import { helper } from './nonexistent.js';\nexport function main() { return helper(); }\n`;
    await fsp.writeFile(path.join(root, "main.ts"), mainContent, "utf8");
    
    const index = await buildProjectIndex(root);
    
    const mainFile = Array.from(index.byFile.keys()).find(f => f.endsWith("main.ts"));
    expect(mainFile).toBeDefined();
    
    const mainModule = index.byFile.get(mainFile!);
    const helperImport = mainModule!.imports[0];
    expect(typeof helperImport!.resolved).toBe("object");
    expect((helperImport!.resolved as any).external).toBe("./nonexistent.js");
  });

  it("should handle detailed symbol graph with .js imports to .ts files", async () => {
    const root = await mkTmpDir("dg-resolve-detailed-");
    
    const utilsContent = `export function helper() { return 42; }\n`;
    await fsp.writeFile(path.join(root, "utils.ts"), utilsContent, "utf8");
    
    const mainContent = `import { helper } from './utils.js';\nexport function main() { return helper(); }\n`;
    await fsp.writeFile(path.join(root, "main.ts"), mainContent, "utf8");
    
    const { buildProjectIndex, buildSymbolGraphDetailed } = await import("../src/index.js");
    const index = await buildProjectIndex(root);
    const symbolGraph = await buildSymbolGraphDetailed(index);
    
    // Find the main and helper functions in the symbol graph
    const mainFile = Array.from(index.byFile.keys()).find(f => f.endsWith("main.ts"));
    const utilsFile = Array.from(index.byFile.keys()).find(f => f.endsWith("utils.ts"));
    
    const nodes = [...symbolGraph.nodes.values()];
    const mainFunc = nodes.find(n => n.file === mainFile && n.name === "main");
    const helperFunc = nodes.find(n => n.file === utilsFile && n.name === "helper");
    
    expect(mainFunc).toBeDefined();
    expect(helperFunc).toBeDefined();
    
    // There should be a "uses" edge from main to helper
    const usesEdge = symbolGraph.edges.find(
      e => e.from === (mainFunc as any).id && e.to === (helperFunc as any).id && e.label === "uses"
    );
    expect(usesEdge).toBeDefined();
  });
});

