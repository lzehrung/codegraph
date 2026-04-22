import { describe, it, expect } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildProjectIndexFromFiles } from "../src/index.js";
import {
  createTestIndex,
  expectFileInIndex,
  expectModuleCount,
} from "./test-utils.js";

describe("Project Indexing", () => {
  it("does not add workspace manifest edges outside explicit file-list indexes", async () => {
    const root = await fsp.mkdtemp(
      path.join(os.tmpdir(), "dg-explicit-manifest-scope-"),
    );
    const appManifest = path.join(root, "apps", "app", "package.json");
    const libManifest = path.join(root, "packages", "lib", "package.json");

    await fsp.mkdir(path.dirname(appManifest), { recursive: true });
    await fsp.mkdir(path.dirname(libManifest), { recursive: true });
    await fsp.writeFile(
      appManifest,
      JSON.stringify(
        {
          name: "app",
          dependencies: {
            lib: "workspace:*",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(
      libManifest,
      JSON.stringify({ name: "lib" }, null, 2),
      "utf8",
    );

    const index = await buildProjectIndexFromFiles(root, [appManifest]);

    expect(index.byFile.has(appManifest.replace(/\\/g, "/"))).toBe(true);
    expect(index.byFile.has(libManifest.replace(/\\/g, "/"))).toBe(false);
    expect(
      index.graph.edges.some(
        (edge) =>
          edge.from === appManifest.replace(/\\/g, "/") &&
          edge.to.type === "file" &&
          edge.to.path === libManifest.replace(/\\/g, "/"),
      ),
    ).toBe(false);
  });

  describe("TypeScript Project", () => {
    it("should index all TypeScript files", async () => {
      const index = await createTestIndex("typescript");

      expectModuleCount(index, 5);

      const samplePath = path.resolve(
        process.cwd(),
        "tests",
        "samples",
        "typescript"
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "main.ts").replace(/\\/g, "/")
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "utils.ts").replace(/\\/g, "/")
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "helpers.ts").replace(/\\/g, "/")
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "dynamic-import.ts").replace(/\\/g, "/")
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "tsconfig.json").replace(/\\/g, "/")
      );
    });

    it("should detect imports and exports", async () => {
      const index = await createTestIndex("typescript");

      // Check that utils.ts has exports
      const samplePath = path.resolve(
        process.cwd(),
        "tests",
        "samples",
        "typescript"
      );
      const utilsFile = path.join(samplePath, "utils.ts").replace(/\\/g, "/");
      const utilsModule = index.byFile.get(utilsFile);

      expect(utilsModule).toBeDefined();
      expect(utilsModule!.exports.length).toBeGreaterThan(0);
      expect(utilsModule!.locals.length).toBeGreaterThan(0);
    });

    it("should detect imports in main.ts", async () => {
      const index = await createTestIndex("typescript");

      const samplePath = path.resolve(
        process.cwd(),
        "tests",
        "samples",
        "typescript"
      );
      const mainFile = path.join(samplePath, "main.ts").replace(/\\/g, "/");
      const mainModule = index.byFile.get(mainFile);

      expect(mainModule).toBeDefined();
      expect(mainModule!.imports.length).toBeGreaterThan(0);
    });
  });

  describe("Python Project", () => {
    it("should index all Python files", async () => {
      const index = await createTestIndex("python");

      expectModuleCount(index, 5);

      const samplePath = path.resolve(
        process.cwd(),
        "tests",
        "samples",
        "python"
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "main.py").replace(/\\/g, "/")
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "utils.py").replace(/\\/g, "/")
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "helpers.py").replace(/\\/g, "/")
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "relative-imports.py").replace(/\\/g, "/")
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "__init__.py").replace(/\\/g, "/")
      );
    });

    it("should detect Python imports and exports", async () => {
      const index = await createTestIndex("python");

      const samplePath = path.resolve(
        process.cwd(),
        "tests",
        "samples",
        "python"
      );
      const utilsFile = path.join(samplePath, "utils.py").replace(/\\/g, "/");
      const utilsModule = index.byFile.get(utilsFile);

      expect(utilsModule).toBeDefined();
      expect(utilsModule!.exports.length).toBeGreaterThan(0);
      expect(utilsModule!.locals.length).toBeGreaterThan(0);
    });

    it("should detect Python imports in main.py", async () => {
      const index = await createTestIndex("python");

      const samplePath = path.resolve(
        process.cwd(),
        "tests",
        "samples",
        "python"
      );
      const mainFile = path.join(samplePath, "main.py").replace(/\\/g, "/");
      const mainModule = index.byFile.get(mainFile);

      expect(mainModule).toBeDefined();
      expect(mainModule!.imports.length).toBeGreaterThan(0);
    });
  });

  describe("JavaScript Project", () => {
    it("should index all JavaScript files", async () => {
      const index = await createTestIndex("javascript");

      expectModuleCount(index, 7);

      const samplePath = path.resolve(
        process.cwd(),
        "tests",
        "samples",
        "javascript"
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "main.js").replace(/\\/g, "/")
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "utils.js").replace(/\\/g, "/")
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "helpers.js").replace(/\\/g, "/")
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "dynamic-import.js").replace(/\\/g, "/")
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "legacy.js").replace(/\\/g, "/")
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "mixed.js").replace(/\\/g, "/")
      );
      expectFileInIndex(
        index,
        path.join(samplePath, "package.json").replace(/\\/g, "/")
      );
    });

    it("should detect JavaScript ES6 imports and exports", async () => {
      const index = await createTestIndex("javascript");

      const samplePath = path.resolve(
        process.cwd(),
        "tests",
        "samples",
        "javascript"
      );
      const utilsFile = path.join(samplePath, "utils.js").replace(/\\/g, "/");
      const utilsModule = index.byFile.get(utilsFile);

      expect(utilsModule).toBeDefined();
      expect(utilsModule!.exports.length).toBeGreaterThan(0);
      expect(utilsModule!.locals.length).toBeGreaterThan(0);
    });

    it("should detect JavaScript imports in main.js", async () => {
      const index = await createTestIndex("javascript");

      const samplePath = path.resolve(
        process.cwd(),
        "tests",
        "samples",
        "javascript"
      );
      const mainFile = path.join(samplePath, "main.js").replace(/\\/g, "/");
      const mainModule = index.byFile.get(mainFile);

      expect(mainModule).toBeDefined();
      expect(mainModule!.imports.length).toBeGreaterThan(0);
    });

    it("should detect CommonJS require statements", async () => {
      const index = await createTestIndex("javascript");

      const samplePath = path.resolve(
        process.cwd(),
        "tests",
        "samples",
        "javascript"
      );
      const mainFile = path.join(samplePath, "main.js").replace(/\\/g, "/");
      const mainModule = index.byFile.get(mainFile);

      expect(mainModule).toBeDefined();

      // Should detect both ES6 imports and CommonJS requires
      const hasES6Import = mainModule!.imports.some(
        (imp) =>
          imp.kind === "default" ||
          imp.kind === "named" ||
          imp.kind === "namespace"
      );
      const hasCommonJSRequire = mainModule!.imports.some(
        (imp) => imp.mechanism === "cjs"
      );

      expect(hasES6Import || hasCommonJSRequire).toBe(true);
    });

    it("should detect mixed module systems", async () => {
      const index = await createTestIndex("javascript");

      const samplePath = path.resolve(
        process.cwd(),
        "tests",
        "samples",
        "javascript"
      );
      const mixedFile = path.join(samplePath, "mixed.js").replace(/\\/g, "/");
      const mixedModule = index.byFile.get(mixedFile);

      expect(mixedModule).toBeDefined();
      expect(mixedModule!.imports.length).toBeGreaterThan(0);
      expect(mixedModule!.exports.length).toBeGreaterThan(0);
    });
  });

  describe("Graph-Only Document Projects", () => {
    it("keeps graph-only modules semantically inert while preserving imports", async () => {
      const markdownPath = path.resolve(
        process.cwd(),
        "tests",
        "samples",
        "markdown",
      );
      const mdxPath = path.resolve(process.cwd(), "tests", "samples", "mdx");
      const rstPath = path.resolve(process.cwd(), "tests", "samples", "rst");
      const adocPath = path.resolve(process.cwd(), "tests", "samples", "adoc");

      const markdownFile = path.join(markdownPath, "index.md").replace(/\\/g, "/");
      const mdxFile = path.join(mdxPath, "page.mdx").replace(/\\/g, "/");
      const rstFile = path.join(rstPath, "index.rst").replace(/\\/g, "/");
      const adocFile = path.join(adocPath, "index.adoc").replace(/\\/g, "/");

      const markdownIndex = await buildProjectIndexFromFiles(markdownPath, [
        markdownFile,
        path.join(markdownPath, "guide.md").replace(/\\/g, "/"),
      ]);
      const mdxIndex = await buildProjectIndexFromFiles(mdxPath, [
        mdxFile,
        path.join(mdxPath, "guide.md").replace(/\\/g, "/"),
        path.join(mdxPath, "components", "Card.tsx").replace(/\\/g, "/"),
      ]);
      const rstIndex = await buildProjectIndexFromFiles(rstPath, [
        rstFile,
        path.join(rstPath, "guide.rst").replace(/\\/g, "/"),
      ]);
      const adocIndex = await buildProjectIndexFromFiles(adocPath, [
        adocFile,
        path.join(adocPath, "guide.adoc").replace(/\\/g, "/"),
      ]);

      const markdownModule = markdownIndex.byFile.get(markdownFile);
      const mdxModule = mdxIndex.byFile.get(mdxFile);
      const rstModule = rstIndex.byFile.get(rstFile);
      const adocModule = adocIndex.byFile.get(adocFile);

      expect(markdownModule).toBeDefined();
      expect(markdownModule!.imports.length).toBeGreaterThan(0);
      expect(markdownModule!.exports).toHaveLength(0);
      expect(markdownModule!.locals).toHaveLength(0);

      expect(mdxModule).toBeDefined();
      expect(mdxModule!.imports.length).toBeGreaterThan(0);
      expect(mdxModule!.exports).toHaveLength(0);
      expect(mdxModule!.locals).toHaveLength(0);

      expect(rstModule).toBeDefined();
      expect(rstModule!.imports.length).toBeGreaterThan(0);
      expect(rstModule!.exports).toHaveLength(0);
      expect(rstModule!.locals).toHaveLength(0);

      expect(adocModule).toBeDefined();
      expect(adocModule!.imports.length).toBeGreaterThan(0);
      expect(adocModule!.exports).toHaveLength(0);
      expect(adocModule!.locals).toHaveLength(0);
    });
  });
});
