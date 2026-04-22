import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex, collectGraph } from "../src/index.js";
import { resolveSpecifier } from "../src/util.js";

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
    const mainFile = Array.from(index.byFile.keys()).find((f) =>
      f.endsWith("main.ts"),
    );
    const utilsFile = Array.from(index.byFile.keys()).find((f) =>
      f.endsWith("utils.ts"),
    );

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
    expect((helperImport!.resolved as string).replace(/\\/g, "/")).toBe(
      utilsFile!.replace(/\\/g, "/"),
    );
  });

  it("should resolve .mjs imports to .mts source files", async () => {
    const root = await mkTmpDir("dg-resolve-mjs-mts-");

    const utilsContent = `export function helper() { return 42; }\n`;
    await fsp.writeFile(path.join(root, "utils.mts"), utilsContent, "utf8");

    const mainContent = `import { helper } from './utils.mjs';\nexport function main() { return helper(); }\n`;
    await fsp.writeFile(path.join(root, "main.mts"), mainContent, "utf8");

    const index = await buildProjectIndex(root);

    const mainFile = Array.from(index.byFile.keys()).find((f) =>
      f.endsWith("main.mts"),
    );
    const utilsFile = Array.from(index.byFile.keys()).find((f) =>
      f.endsWith("utils.mts"),
    );

    expect(mainFile).toBeDefined();
    expect(utilsFile).toBeDefined();

    const mainModule = index.byFile.get(mainFile!);
    const helperImport = mainModule!.imports[0];
    expect(typeof helperImport!.resolved).toBe("string");
    expect((helperImport!.resolved as string).replace(/\\/g, "/")).toBe(
      utilsFile!.replace(/\\/g, "/"),
    );
  });

  it("should resolve .cjs imports to .cts source files", async () => {
    const root = await mkTmpDir("dg-resolve-cjs-cts-");

    const utilsContent = `export function helper() { return 42; }\n`;
    await fsp.writeFile(path.join(root, "utils.cts"), utilsContent, "utf8");

    const mainContent = `import { helper } from './utils.cjs';\nexport function main() { return helper(); }\n`;
    await fsp.writeFile(path.join(root, "main.cts"), mainContent, "utf8");

    const index = await buildProjectIndex(root);

    const mainFile = Array.from(index.byFile.keys()).find((f) =>
      f.endsWith("main.cts"),
    );
    const utilsFile = Array.from(index.byFile.keys()).find((f) =>
      f.endsWith("utils.cts"),
    );

    expect(mainFile).toBeDefined();
    expect(utilsFile).toBeDefined();

    const mainModule = index.byFile.get(mainFile!);
    const helperImport = mainModule!.imports[0];
    expect(typeof helperImport!.resolved).toBe("string");
    expect((helperImport!.resolved as string).replace(/\\/g, "/")).toBe(
      utilsFile!.replace(/\\/g, "/"),
    );
  });

  it("should still resolve regular .js files when they exist", async () => {
    const root = await mkTmpDir("dg-resolve-actual-js-");

    // Create an actual .js file
    const utilsContent = `export function helper() { return 42; }\n`;
    await fsp.writeFile(path.join(root, "utils.js"), utilsContent, "utf8");

    const mainContent = `import { helper } from './utils.js';\nexport function main() { return helper(); }\n`;
    await fsp.writeFile(path.join(root, "main.js"), mainContent, "utf8");

    const index = await buildProjectIndex(root);

    const mainFile = Array.from(index.byFile.keys()).find((f) =>
      f.endsWith("main.js"),
    );
    const utilsFile = Array.from(index.byFile.keys()).find((f) =>
      f.endsWith("utils.js"),
    );

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

    const mainFile = Array.from(index.byFile.keys()).find((f) =>
      f.endsWith("main.ts"),
    );
    expect(mainFile).toBeDefined();

    const mainModule = index.byFile.get(mainFile!);
    const helperImport = mainModule!.imports[0];
    expect(typeof helperImport!.resolved).toBe("object");
    expect(helperImport!.resolved.external).toBe("./nonexistent.js");
  });

  it("should handle detailed symbol graph with .js imports to .ts files", async () => {
    const root = await mkTmpDir("dg-resolve-detailed-");

    const utilsContent = `export function helper() { return 42; }\n`;
    await fsp.writeFile(path.join(root, "utils.ts"), utilsContent, "utf8");

    const mainContent = `import { helper } from './utils.js';\nexport function main() { return helper(); }\n`;
    await fsp.writeFile(path.join(root, "main.ts"), mainContent, "utf8");

    const { buildProjectIndex, buildSymbolGraphDetailed } =
      await import("../src/index.js");
    const index = await buildProjectIndex(root);
    const symbolGraph = await buildSymbolGraphDetailed(index);

    // Find the main and helper functions in the symbol graph
    const mainFile = Array.from(index.byFile.keys()).find((f) =>
      f.endsWith("main.ts"),
    );
    const utilsFile = Array.from(index.byFile.keys()).find((f) =>
      f.endsWith("utils.ts"),
    );

    const nodes = [...symbolGraph.nodes.values()];
    const mainFunc = nodes.find(
      (n) => n.file === mainFile && n.name === "main",
    );
    const helperFunc = nodes.find(
      (n) => n.file === utilsFile && n.name === "helper",
    );

    expect(mainFunc).toBeDefined();
    expect(helperFunc).toBeDefined();

    // There should be a "uses" edge from main to helper
    const usesEdge = symbolGraph.edges.find(
      (e) =>
        e.from === mainFunc.id && e.to === helperFunc.id && e.label === "uses",
    );
    expect(usesEdge).toBeDefined();
  });

  it("treats URL-like specifiers as external without filesystem probing", async () => {
    const root = await mkTmpDir("dg-resolve-url-like-");
    const main = path.join(root, "main.ts");
    await fsp.writeFile(main, "export const x = 1\n", "utf8");

    const resolved = await resolveSpecifier(
      main,
      "https://cdn.example.com/lib.js",
      root,
    );

    expect(typeof resolved).toBe("object");
    if (typeof resolved !== "string") {
      expect(resolved.external).toBe("https://cdn.example.com/lib.js");
    }
  });

  it("does not resolve source-language imports to graph-only document files", async () => {
    const root = await mkTmpDir("dg-resolve-doc-regression-");
    await fsp.writeFile(
      path.join(root, "main.ts"),
      'import guide from "./guide";\nexport const x = guide;\n',
      "utf8",
    );
    await fsp.writeFile(path.join(root, "guide.md"), "# guide\n", "utf8");

    const index = await buildProjectIndex(root);
    const mainFile = Array.from(index.byFile.keys()).find((f) =>
      f.endsWith("main.ts"),
    );

    expect(mainFile).toBeDefined();

    const mainModule = index.byFile.get(mainFile!);
    const guideImport = mainModule?.imports[0];

    expect(guideImport).toBeDefined();
    expect(typeof guideImport?.resolved).toBe("object");
    if (guideImport?.resolved && typeof guideImport.resolved !== "string") {
      expect(guideImport.resolved.external).toBe("./guide");
    }
  });

  it("preserves authored graph-only specifiers for unresolved index imports", async () => {
    const root = await mkTmpDir("dg-resolve-graph-only-unresolved-");
    const pageFile = path.join(root, "page.md");

    await fsp.writeFile(pageFile, "[Raw HTML](raw.html#section)\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const index = await buildProjectIndex(root);
    const pageModule = index.byFile.get(normalizedPage);
    const rawImport = pageModule?.imports[0];

    expect(pageModule).toBeDefined();
    expect(rawImport).toBeDefined();
    expect(rawImport?.from).toBe("raw.html#section");
    expect(typeof rawImport?.resolved).toBe("object");
    if (rawImport?.resolved && typeof rawImport.resolved !== "string") {
      expect(rawImport.resolved.external).toBe("raw.html#section");
    }
  });

  it("resolves tsconfig path aliases for mdx static imports", async () => {
    const root = await mkTmpDir("dg-resolve-mdx-alias-");
    const componentFile = path.join(root, "src", "components", "Card.tsx");
    const pageFile = path.join(root, "page.mdx");

    await fsp.mkdir(path.dirname(componentFile), { recursive: true });
    await fsp.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["src/*"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(
      componentFile,
      "export default function Card() { return null; }\n",
      "utf8",
    );
    await fsp.writeFile(pageFile, 'import Card from "@/components/Card";\n', "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedComponent = componentFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedComponent]);
    const index = await buildProjectIndex(root);
    const pageModule = index.byFile.get(normalizedPage);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedPage &&
          edge.to.type === "file" &&
          edge.to.path === normalizedComponent,
      ),
    ).toBe(true);
    expect(pageModule?.imports.some((imp) => imp.resolved === normalizedComponent)).toBe(
      true,
    );
  });

  it("resolves tsconfig path aliases for astro frontmatter imports", async () => {
    const root = await mkTmpDir("dg-resolve-astro-alias-");
    const layoutFile = path.join(root, "src", "components", "Layout.astro");
    const pageFile = path.join(root, "page.astro");

    await fsp.mkdir(path.dirname(layoutFile), { recursive: true });
    await fsp.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["src/*"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(layoutFile, "<slot />\n", "utf8");
    await fsp.writeFile(
      pageFile,
      ['---', 'import Layout from "@/components/Layout";', '---', "<Layout />"].join("\n"),
      "utf8",
    );

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedLayout = layoutFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedLayout]);
    const index = await buildProjectIndex(root);
    const pageModule = index.byFile.get(normalizedPage);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedPage &&
          edge.to.type === "file" &&
          edge.to.path === normalizedLayout,
      ),
    ).toBe(true);
    expect(pageModule?.imports.some((imp) => imp.resolved === normalizedLayout)).toBe(
      true,
    );
  });

  it("prefers graph-only document extensions for extensionless rst targets", async () => {
    const root = await mkTmpDir("dg-resolve-rst-prefer-doc-");
    const indexFile = path.join(root, "index.rst");
    const apiDocFile = path.join(root, "api.rst");
    const apiMarkdownFile = path.join(root, "api.md");
    const apiSourceFile = path.join(root, "api.ts");

    await fsp.writeFile(
      indexFile,
      ["Docs", "====", "", ".. toctree::", "", "   api"].join("\n"),
      "utf8",
    );
    await fsp.writeFile(apiDocFile, "API docs\n========\n", "utf8");
    await fsp.writeFile(apiMarkdownFile, "# API\n", "utf8");
    await fsp.writeFile(apiSourceFile, "export const api = 1;\n", "utf8");

    const normalizedIndex = indexFile.replace(/\\/g, "/");
    const normalizedApiDoc = apiDocFile.replace(/\\/g, "/");
    const normalizedApiMarkdown = apiMarkdownFile.replace(/\\/g, "/");
    const normalizedApiSource = apiSourceFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [
      normalizedIndex,
      normalizedApiDoc,
      normalizedApiMarkdown,
      normalizedApiSource,
    ]);
    const index = await buildProjectIndex(root);
    const indexModule = index.byFile.get(normalizedIndex);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedIndex &&
          edge.to.type === "file" &&
          edge.to.path === normalizedApiDoc,
      ),
    ).toBe(true);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedIndex &&
          edge.to.type === "file" &&
          edge.to.path === normalizedApiSource,
      ),
    ).toBe(false);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedIndex &&
          edge.to.type === "file" &&
          edge.to.path === normalizedApiMarkdown,
      ),
    ).toBe(false);

    expect(indexModule?.imports.some((imp) => imp.resolved === normalizedApiDoc)).toBe(
      true,
    );
  });

  it("prefers graph-only document extensions for titled rst toctree targets", async () => {
    const root = await mkTmpDir("dg-resolve-rst-titled-");
    const indexFile = path.join(root, "index.rst");
    const apiDocFile = path.join(root, "api.rst");
    const apiMarkdownFile = path.join(root, "api.md");
    const apiSourceFile = path.join(root, "api.ts");

    await fsp.writeFile(
      indexFile,
      ["Docs", "====", "", ".. toctree::", "", "   API Reference <api>"].join("\n"),
      "utf8",
    );
    await fsp.writeFile(apiDocFile, "API docs\n========\n", "utf8");
    await fsp.writeFile(apiMarkdownFile, "# API\n", "utf8");
    await fsp.writeFile(apiSourceFile, "export const api = 1;\n", "utf8");

    const normalizedIndex = indexFile.replace(/\\/g, "/");
    const normalizedApiDoc = apiDocFile.replace(/\\/g, "/");
    const normalizedApiMarkdown = apiMarkdownFile.replace(/\\/g, "/");
    const normalizedApiSource = apiSourceFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [
      normalizedIndex,
      normalizedApiDoc,
      normalizedApiMarkdown,
      normalizedApiSource,
    ]);
    const index = await buildProjectIndex(root);
    const indexModule = index.byFile.get(normalizedIndex);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedIndex &&
          edge.to.type === "file" &&
          edge.to.path === normalizedApiDoc,
      ),
    ).toBe(true);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedIndex &&
          edge.to.type === "file" &&
          edge.to.path === normalizedApiSource,
      ),
    ).toBe(false);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedIndex &&
          edge.to.type === "file" &&
          edge.to.path === normalizedApiMarkdown,
      ),
    ).toBe(false);

    expect(indexModule?.imports.some((imp) => imp.resolved === normalizedApiDoc)).toBe(
      true,
    );
  });

  it("prefers graph-only document extensions for extensionless asciidoc targets", async () => {
    const root = await mkTmpDir("dg-resolve-adoc-prefer-doc-");
    const indexFile = path.join(root, "index.adoc");
    const apiDocFile = path.join(root, "api.adoc");
    const apiMarkdownFile = path.join(root, "api.md");
    const apiSourceFile = path.join(root, "api.ts");

    await fsp.writeFile(indexFile, "xref:api[API]\n", "utf8");
    await fsp.writeFile(apiDocFile, "= API\n", "utf8");
    await fsp.writeFile(apiMarkdownFile, "# API\n", "utf8");
    await fsp.writeFile(apiSourceFile, "export const api = 1;\n", "utf8");

    const normalizedIndex = indexFile.replace(/\\/g, "/");
    const normalizedApiDoc = apiDocFile.replace(/\\/g, "/");
    const normalizedApiMarkdown = apiMarkdownFile.replace(/\\/g, "/");
    const normalizedApiSource = apiSourceFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [
      normalizedIndex,
      normalizedApiDoc,
      normalizedApiMarkdown,
      normalizedApiSource,
    ]);
    const index = await buildProjectIndex(root);
    const indexModule = index.byFile.get(normalizedIndex);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedIndex &&
          edge.to.type === "file" &&
          edge.to.path === normalizedApiDoc,
      ),
    ).toBe(true);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedIndex &&
          edge.to.type === "file" &&
          edge.to.path === normalizedApiSource,
      ),
    ).toBe(false);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedIndex &&
          edge.to.type === "file" &&
          edge.to.path === normalizedApiMarkdown,
      ),
    ).toBe(false);

    expect(indexModule?.imports.some((imp) => imp.resolved === normalizedApiDoc)).toBe(
      true,
    );
  });

  it("keeps mdx static imports resolving to source files before markdown siblings", async () => {
    const root = await mkTmpDir("dg-resolve-mdx-source-before-doc-");
    const pageFile = path.join(root, "page.mdx");
    const componentFile = path.join(root, "Card.tsx");
    const markdownFile = path.join(root, "Card.md");

    await fsp.writeFile(
      pageFile,
      'import Card from "./Card";\n\n<Card />\n',
      "utf8",
    );
    await fsp.writeFile(
      componentFile,
      "export default function Card() { return null; }\n",
      "utf8",
    );
    await fsp.writeFile(markdownFile, "# Card\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedComponent = componentFile.replace(/\\/g, "/");
    const normalizedMarkdown = markdownFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [
      normalizedPage,
      normalizedComponent,
      normalizedMarkdown,
    ]);
    const index = await buildProjectIndex(root);
    const pageModule = index.byFile.get(normalizedPage);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedPage &&
          edge.to.type === "file" &&
          edge.to.path === normalizedComponent,
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedPage &&
          edge.to.type === "file" &&
          edge.to.path === normalizedMarkdown,
      ),
    ).toBe(false);
    expect(
      pageModule?.imports.some((imp) => imp.resolved === normalizedComponent),
    ).toBe(true);
  });

  it("keeps astro frontmatter imports resolving to astro components before markdown siblings", async () => {
    const root = await mkTmpDir("dg-resolve-astro-source-before-doc-");
    const pageFile = path.join(root, "page.astro");
    const componentFile = path.join(root, "Layout.astro");
    const markdownFile = path.join(root, "Layout.md");

    await fsp.writeFile(
      pageFile,
      ['---', 'import Layout from "./Layout";', '---', "<Layout />"].join("\n"),
      "utf8",
    );
    await fsp.writeFile(componentFile, "<slot />\n", "utf8");
    await fsp.writeFile(markdownFile, "# Layout\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedComponent = componentFile.replace(/\\/g, "/");
    const normalizedMarkdown = markdownFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [
      normalizedPage,
      normalizedComponent,
      normalizedMarkdown,
    ]);
    const index = await buildProjectIndex(root);
    const pageModule = index.byFile.get(normalizedPage);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedPage &&
          edge.to.type === "file" &&
          edge.to.path === normalizedComponent,
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedPage &&
          edge.to.type === "file" &&
          edge.to.path === normalizedMarkdown,
      ),
    ).toBe(false);
    expect(
      pageModule?.imports.some((imp) => imp.resolved === normalizedComponent),
    ).toBe(true);
  });

  it("resolves tsconfig path aliases for tsx dependency graphs", async () => {
    const root = await mkTmpDir("dg-resolve-tsx-alias-");
    const buttonFile = path.join(root, "src", "components", "Button.tsx");
    const appFile = path.join(root, "App.tsx");

    await fsp.mkdir(path.dirname(buttonFile), { recursive: true });
    await fsp.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@/*": ["src/*"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(
      buttonFile,
      "export function Button() { return null; }\n",
      "utf8",
    );
    await fsp.writeFile(
      appFile,
      'import { Button } from "@/components/Button";\nexport function App() { return <Button />; }\n',
      "utf8",
    );

    const normalizedApp = appFile.replace(/\\/g, "/");
    const normalizedButton = buttonFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedApp, normalizedButton]);

    expect(
      graph.edges.some(
        (edge) =>
          edge.from === normalizedApp &&
          edge.to.type === "file" &&
          edge.to.path === normalizedButton,
      ),
    ).toBe(true);
  });
});
