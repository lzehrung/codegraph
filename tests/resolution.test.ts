import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import { buildProjectIndex, clearImportResolutionCaches, collectGraph, goToDefinition } from "../src/index.js";
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
    const mainFile = Array.from(index.byFile.keys()).find((f) => f.endsWith("main.ts"));
    const utilsFile = Array.from(index.byFile.keys()).find((f) => f.endsWith("utils.ts"));

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

  it("should resolve .jsx imports to .tsx source files", async () => {
    const root = await mkTmpDir("dg-resolve-jsx-tsx-");
    const buttonFile = path.join(root, "components", "Button.tsx");
    const appFile = path.join(root, "App.tsx");

    await fsp.mkdir(path.dirname(buttonFile), { recursive: true });
    await fsp.writeFile(buttonFile, "export function Button() { return null; }\n", "utf8");
    await fsp.writeFile(
      appFile,
      'import { Button } from "./components/Button.jsx";\nexport function App() { return <Button />; }\n',
      "utf8",
    );

    const resolved = await resolveSpecifier(appFile, "./components/Button.jsx", root);

    expect(resolved).toBe(buttonFile);

    const index = await buildProjectIndex(root);
    const normalizedApp = appFile.replace(/\\/g, "/");
    const normalizedButton = buttonFile.replace(/\\/g, "/");
    const appModule = index.byFile.get(normalizedApp);
    const buttonImport = appModule?.imports[0];

    expect(buttonImport?.from).toBe("./components/Button.jsx");
    expect(buttonImport?.resolved).toBe(normalizedButton);
  });

  it("should resolve .mjs imports to .mts source files", async () => {
    const root = await mkTmpDir("dg-resolve-mjs-mts-");

    const utilsContent = `export function helper() { return 42; }\n`;
    await fsp.writeFile(path.join(root, "utils.mts"), utilsContent, "utf8");

    const mainContent = `import { helper } from './utils.mjs';\nexport function main() { return helper(); }\n`;
    await fsp.writeFile(path.join(root, "main.mts"), mainContent, "utf8");

    const index = await buildProjectIndex(root);

    const mainFile = Array.from(index.byFile.keys()).find((f) => f.endsWith("main.mts"));
    const utilsFile = Array.from(index.byFile.keys()).find((f) => f.endsWith("utils.mts"));

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

    const mainFile = Array.from(index.byFile.keys()).find((f) => f.endsWith("main.cts"));
    const utilsFile = Array.from(index.byFile.keys()).find((f) => f.endsWith("utils.cts"));

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

    const mainFile = Array.from(index.byFile.keys()).find((f) => f.endsWith("main.js"));
    const utilsFile = Array.from(index.byFile.keys()).find((f) => f.endsWith("utils.js"));

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

    const mainFile = Array.from(index.byFile.keys()).find((f) => f.endsWith("main.ts"));
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

    const { buildProjectIndex, buildSymbolGraphDetailed } = await import("../src/index.js");
    const index = await buildProjectIndex(root);
    const symbolGraph = await buildSymbolGraphDetailed(index);

    // Find the main and helper functions in the symbol graph
    const mainFile = Array.from(index.byFile.keys()).find((f) => f.endsWith("main.ts"));
    const utilsFile = Array.from(index.byFile.keys()).find((f) => f.endsWith("utils.ts"));

    const nodes = [...symbolGraph.nodes.values()];
    const mainFunc = nodes.find((n) => n.file === mainFile && n.name === "main");
    const helperFunc = nodes.find((n) => n.file === utilsFile && n.name === "helper");

    expect(mainFunc).toBeDefined();
    expect(helperFunc).toBeDefined();

    // There should be a "uses" edge from main to helper
    const usesEdge = symbolGraph.edges.find((e) => e.from === mainFunc.id && e.to === helperFunc.id && e.label === "uses");
    expect(usesEdge).toBeDefined();
  });

  it("treats URL-like specifiers as external without filesystem probing", async () => {
    const root = await mkTmpDir("dg-resolve-url-like-");
    const main = path.join(root, "main.ts");
    await fsp.writeFile(main, "export const x = 1\n", "utf8");

    const resolved = await resolveSpecifier(main, "https://cdn.example.com/lib.js", root);

    expect(typeof resolved).toBe("object");
    if (typeof resolved !== "string") {
      expect(resolved.external).toBe("https://cdn.example.com/lib.js");
    }
  });

  it("does not resolve source-language imports to graph-only document files", async () => {
    const root = await mkTmpDir("dg-resolve-doc-regression-");
    await fsp.writeFile(path.join(root, "main.ts"), 'import guide from "./guide";\nexport const x = guide;\n', "utf8");
    await fsp.writeFile(path.join(root, "guide.md"), "# guide\n", "utf8");

    const index = await buildProjectIndex(root);
    const mainFile = Array.from(index.byFile.keys()).find((f) => f.endsWith("main.ts"));

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

  it("drops ambiguous asciidoc xrefs when they do not resolve to a file", async () => {
    const root = await mkTmpDir("dg-resolve-adoc-anchor-only-");
    const pageFile = path.join(root, "page.adoc");

    await fsp.writeFile(pageFile, "xref:local-anchor[]\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage]);
    const index = await buildProjectIndex(root);
    const pageModule = index.byFile.get(normalizedPage);

    expect(graph.edges).toHaveLength(0);
    expect(pageModule).toBeDefined();
    expect(pageModule?.imports).toHaveLength(0);
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
    await fsp.writeFile(componentFile, "export default function Card() { return null; }\n", "utf8");
    await fsp.writeFile(pageFile, 'import Card from "@/components/Card";\n', "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedComponent = componentFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedComponent]);
    const index = await buildProjectIndex(root);
    const pageModule = index.byFile.get(normalizedPage);

    expect(
      graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedComponent),
    ).toBe(true);
    expect(pageModule?.imports.some((imp) => imp.resolved === normalizedComponent)).toBe(true);
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
    await fsp.writeFile(pageFile, ["---", 'import Layout from "@/components/Layout";', "---", "<Layout />"].join("\n"), "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedLayout = layoutFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedLayout]);
    const index = await buildProjectIndex(root);
    const pageModule = index.byFile.get(normalizedPage);

    expect(graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedLayout)).toBe(
      true,
    );
    expect(pageModule?.imports.some((imp) => imp.resolved === normalizedLayout)).toBe(true);
  });

  it("prefers graph-only document extensions for extensionless rst targets", async () => {
    const root = await mkTmpDir("dg-resolve-rst-prefer-doc-");
    const indexFile = path.join(root, "index.rst");
    const apiDocFile = path.join(root, "api.rst");
    const apiMarkdownFile = path.join(root, "api.md");
    const apiSourceFile = path.join(root, "api.ts");

    await fsp.writeFile(indexFile, ["Docs", "====", "", ".. toctree::", "", "   api"].join("\n"), "utf8");
    await fsp.writeFile(apiDocFile, "API docs\n========\n", "utf8");
    await fsp.writeFile(apiMarkdownFile, "# API\n", "utf8");
    await fsp.writeFile(apiSourceFile, "export const api = 1;\n", "utf8");

    const normalizedIndex = indexFile.replace(/\\/g, "/");
    const normalizedApiDoc = apiDocFile.replace(/\\/g, "/");
    const normalizedApiMarkdown = apiMarkdownFile.replace(/\\/g, "/");
    const normalizedApiSource = apiSourceFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedIndex, normalizedApiDoc, normalizedApiMarkdown, normalizedApiSource]);
    const index = await buildProjectIndex(root);
    const indexModule = index.byFile.get(normalizedIndex);

    expect(graph.edges.some((edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedApiDoc)).toBe(
      true,
    );

    expect(
      graph.edges.some((edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedApiSource),
    ).toBe(false);

    expect(
      graph.edges.some((edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedApiMarkdown),
    ).toBe(false);

    expect(indexModule?.imports.some((imp) => imp.resolved === normalizedApiDoc)).toBe(true);
  });

  it("prefers graph-only document extensions for titled rst toctree targets", async () => {
    const root = await mkTmpDir("dg-resolve-rst-titled-");
    const indexFile = path.join(root, "index.rst");
    const apiDocFile = path.join(root, "api.rst");
    const apiMarkdownFile = path.join(root, "api.md");
    const apiSourceFile = path.join(root, "api.ts");

    await fsp.writeFile(indexFile, ["Docs", "====", "", ".. toctree::", "", "   API Reference <api>"].join("\n"), "utf8");
    await fsp.writeFile(apiDocFile, "API docs\n========\n", "utf8");
    await fsp.writeFile(apiMarkdownFile, "# API\n", "utf8");
    await fsp.writeFile(apiSourceFile, "export const api = 1;\n", "utf8");

    const normalizedIndex = indexFile.replace(/\\/g, "/");
    const normalizedApiDoc = apiDocFile.replace(/\\/g, "/");
    const normalizedApiMarkdown = apiMarkdownFile.replace(/\\/g, "/");
    const normalizedApiSource = apiSourceFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedIndex, normalizedApiDoc, normalizedApiMarkdown, normalizedApiSource]);
    const index = await buildProjectIndex(root);
    const indexModule = index.byFile.get(normalizedIndex);

    expect(graph.edges.some((edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedApiDoc)).toBe(
      true,
    );

    expect(
      graph.edges.some((edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedApiSource),
    ).toBe(false);

    expect(
      graph.edges.some((edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedApiMarkdown),
    ).toBe(false);

    expect(indexModule?.imports.some((imp) => imp.resolved === normalizedApiDoc)).toBe(true);
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
    const graph = await collectGraph(root, [normalizedIndex, normalizedApiDoc, normalizedApiMarkdown, normalizedApiSource]);
    const index = await buildProjectIndex(root);
    const indexModule = index.byFile.get(normalizedIndex);

    expect(graph.edges.some((edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedApiDoc)).toBe(
      true,
    );

    expect(
      graph.edges.some((edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedApiSource),
    ).toBe(false);

    expect(
      graph.edges.some((edge) => edge.from === normalizedIndex && edge.to.type === "file" && edge.to.path === normalizedApiMarkdown),
    ).toBe(false);

    expect(indexModule?.imports.some((imp) => imp.resolved === normalizedApiDoc)).toBe(true);
  });

  it("keeps mdx static imports resolving to source files before markdown siblings", async () => {
    const root = await mkTmpDir("dg-resolve-mdx-source-before-doc-");
    const pageFile = path.join(root, "page.mdx");
    const componentFile = path.join(root, "Card.tsx");
    const markdownFile = path.join(root, "Card.md");

    await fsp.writeFile(pageFile, 'import Card from "./Card";\n\n<Card />\n', "utf8");
    await fsp.writeFile(componentFile, "export default function Card() { return null; }\n", "utf8");
    await fsp.writeFile(markdownFile, "# Card\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedComponent = componentFile.replace(/\\/g, "/");
    const normalizedMarkdown = markdownFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedComponent, normalizedMarkdown]);
    const index = await buildProjectIndex(root);
    const pageModule = index.byFile.get(normalizedPage);

    expect(
      graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedComponent),
    ).toBe(true);
    expect(graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedMarkdown)).toBe(
      false,
    );
    expect(pageModule?.imports.some((imp) => imp.resolved === normalizedComponent)).toBe(true);
  });

  it("keeps astro frontmatter imports resolving to astro components before markdown siblings", async () => {
    const root = await mkTmpDir("dg-resolve-astro-source-before-doc-");
    const pageFile = path.join(root, "page.astro");
    const componentFile = path.join(root, "Layout.astro");
    const markdownFile = path.join(root, "Layout.md");

    await fsp.writeFile(pageFile, ["---", 'import Layout from "./Layout";', "---", "<Layout />"].join("\n"), "utf8");
    await fsp.writeFile(componentFile, "<slot />\n", "utf8");
    await fsp.writeFile(markdownFile, "# Layout\n", "utf8");

    const normalizedPage = pageFile.replace(/\\/g, "/");
    const normalizedComponent = componentFile.replace(/\\/g, "/");
    const normalizedMarkdown = markdownFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedPage, normalizedComponent, normalizedMarkdown]);
    const index = await buildProjectIndex(root);
    const pageModule = index.byFile.get(normalizedPage);

    expect(
      graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedComponent),
    ).toBe(true);
    expect(graph.edges.some((edge) => edge.from === normalizedPage && edge.to.type === "file" && edge.to.path === normalizedMarkdown)).toBe(
      false,
    );
    expect(pageModule?.imports.some((imp) => imp.resolved === normalizedComponent)).toBe(true);
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
    await fsp.writeFile(buttonFile, "export function Button() { return null; }\n", "utf8");
    await fsp.writeFile(appFile, 'import { Button } from "@/components/Button";\nexport function App() { return <Button />; }\n', "utf8");

    const normalizedApp = appFile.replace(/\\/g, "/");
    const normalizedButton = buttonFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [normalizedApp, normalizedButton]);

    expect(graph.edges.some((edge) => edge.from === normalizedApp && edge.to.type === "file" && edge.to.path === normalizedButton)).toBe(
      true,
    );
  });

  it("resolves PHP PSR-4 imports declared in composer.json", async () => {
    const root = await mkTmpDir("dg-resolve-php-psr4-");
    const srcDir = path.join(root, "src", "Domain");
    const consumerFile = path.join(root, "consumer.php");
    const serviceFile = path.join(srcDir, "Service.php");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(
      path.join(root, "composer.json"),
      JSON.stringify({ autoload: { "psr-4": { "App\\\\": "src/" } } }, null, 2),
      "utf8",
    );
    await fsp.writeFile(serviceFile, ["<?php", "", "namespace App\\Domain;", "", "class Service {}", ""].join("\n"), "utf8");
    await fsp.writeFile(consumerFile, ["<?php", "", "use App\\Domain\\Service;", "", "$service = new Service();", ""].join("\n"), "utf8");

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 16,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(serviceFile.replace(/\\/g, "/"));
      expect(result.definition.range.start.line).toBe(5);
    }
  });

  it("resolves PHP autoload-dev PSR-4 imports declared in composer.json", async () => {
    const root = await mkTmpDir("dg-resolve-php-autoload-dev-");
    const srcDir = path.join(root, "dev-tools");
    const consumerFile = path.join(root, "consumer.php");
    const toolFile = path.join(srcDir, "Harness.php");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(
      path.join(root, "composer.json"),
      JSON.stringify({ "autoload-dev": { "psr-4": { "Dev\\\\": "dev-tools/" } } }, null, 2),
      "utf8",
    );
    await fsp.writeFile(toolFile, ["<?php", "", "namespace Dev;", "", "class Harness {}", ""].join("\n"), "utf8");
    await fsp.writeFile(consumerFile, ["<?php", "", "use Dev\\Harness;", "", "$tool = new Harness();", ""].join("\n"), "utf8");

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 13,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(toolFile.replace(/\\/g, "/"));
      expect(result.definition.range.start.line).toBe(5);
    }
  });

  it("merges duplicate PHP PSR-4 prefixes across autoload and autoload-dev", async () => {
    const root = await mkTmpDir("dg-resolve-php-autoload-merge-");
    const srcDir = path.join(root, "src", "Domain");
    const devDir = path.join(root, "dev-tools", "Testing");
    const prodConsumerFile = path.join(root, "prod-consumer.php");
    const devConsumerFile = path.join(root, "dev-consumer.php");
    const serviceFile = path.join(srcDir, "Service.php");
    const harnessFile = path.join(devDir, "Harness.php");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(devDir, { recursive: true });
    await fsp.writeFile(
      path.join(root, "composer.json"),
      JSON.stringify(
        {
          autoload: { "psr-4": { "App\\\\": "src/" } },
          "autoload-dev": { "psr-4": { "App\\\\": "dev-tools/" } },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(serviceFile, ["<?php", "", "namespace App\\Domain;", "", "class Service {}", ""].join("\n"), "utf8");
    await fsp.writeFile(harnessFile, ["<?php", "", "namespace App\\Testing;", "", "class Harness {}", ""].join("\n"), "utf8");
    await fsp.writeFile(
      prodConsumerFile,
      ["<?php", "", "use App\\Domain\\Service;", "", "$service = new Service();", ""].join("\n"),
      "utf8",
    );
    await fsp.writeFile(devConsumerFile, ["<?php", "", "use App\\Testing\\Harness;", "", "$tool = new Harness();", ""].join("\n"), "utf8");

    const index = await buildProjectIndex(root);
    const prodResult = await goToDefinition(index, {
      file: prodConsumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 16,
    });
    const devResult = await goToDefinition(index, {
      file: devConsumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 13,
    });

    expect(prodResult.status).toBe("ok");
    if (prodResult.status === "ok") {
      expect(prodResult.definition.file).toBe(serviceFile.replace(/\\/g, "/"));
    }
    expect(devResult.status).toBe("ok");
    if (devResult.status === "ok") {
      expect(devResult.definition.file).toBe(harnessFile.replace(/\\/g, "/"));
    }
  });

  it("resolves PHP PSR-0 imports that use underscores in the class name portion", async () => {
    const root = await mkTmpDir("dg-resolve-php-psr0-");
    const decoyDir = path.join(root, "aaa-decoy");
    const libDir = path.join(root, "lib", "Utils");
    const consumerFile = path.join(root, "consumer.php");
    const decoyFile = path.join(decoyDir, "StringHelper.php");
    const legacyFile = path.join(libDir, "StringHelper.php");

    await fsp.mkdir(decoyDir, { recursive: true });
    await fsp.mkdir(libDir, { recursive: true });
    await fsp.writeFile(path.join(root, "composer.json"), JSON.stringify({ autoload: { "psr-0": { Legacy_: "lib/" } } }, null, 2), "utf8");
    await fsp.writeFile(decoyFile, ["<?php", "", "class Legacy_Utils_StringHelper {}", ""].join("\n"), "utf8");
    await fsp.writeFile(legacyFile, ["<?php", "", "class Legacy_Utils_StringHelper {}", ""].join("\n"), "utf8");
    await fsp.writeFile(
      consumerFile,
      ["<?php", "", "use Legacy_Utils_StringHelper;", "", "$helper = new Legacy_Utils_StringHelper();", ""].join("\n"),
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const consumerModule = index.byFile.get(consumerFile.replace(/\\/g, "/"));
    const helperImport = consumerModule?.imports.find((entry) => entry.kind === "named" && entry.local === "Legacy_Utils_StringHelper");

    expect(helperImport?.resolved).toBe(legacyFile.replace(/\\/g, "/"));

    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 16,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(legacyFile.replace(/\\/g, "/"));
      expect(result.definition.range.start.line).toBe(3);
    }
  });

  it("resolves PHP classmap entries for global-namespace classes", async () => {
    const root = await mkTmpDir("dg-resolve-php-classmap-");
    const legacyDir = path.join(root, "legacy");
    const consumerFile = path.join(root, "consumer.php");
    const serviceFile = path.join(legacyDir, "LegacyService.php");

    await fsp.mkdir(legacyDir, { recursive: true });
    await fsp.writeFile(path.join(root, "composer.json"), JSON.stringify({ autoload: { classmap: ["legacy/"] } }, null, 2), "utf8");
    await fsp.writeFile(serviceFile, ["<?php", "", "class LegacyService {}", ""].join("\n"), "utf8");
    await fsp.writeFile(consumerFile, ["<?php", "", "use LegacyService;", "", "$service = new LegacyService();", ""].join("\n"), "utf8");

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 16,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(serviceFile.replace(/\\/g, "/"));
      expect(result.definition.range.start.line).toBe(3);
    }
  });

  it("does not resolve PHP symbols outside Composer classmap boundaries", async () => {
    const root = await mkTmpDir("dg-resolve-php-classmap-boundary-");
    const legacyDir = path.join(root, "legacy");
    const otherDir = path.join(root, "other");
    const consumerFile = path.join(root, "consumer.php");
    const allowedServiceFile = path.join(otherDir, "AllowedService.php");
    const legacyServiceFile = path.join(legacyDir, "LegacyService.php");

    await fsp.mkdir(legacyDir, { recursive: true });
    await fsp.mkdir(otherDir, { recursive: true });
    await fsp.writeFile(path.join(root, "composer.json"), JSON.stringify({ autoload: { classmap: ["other/"] } }, null, 2), "utf8");
    await fsp.writeFile(allowedServiceFile, ["<?php", "", "class AllowedService {}", ""].join("\n"), "utf8");
    await fsp.writeFile(legacyServiceFile, ["<?php", "", "class LegacyService {}", ""].join("\n"), "utf8");
    await fsp.writeFile(consumerFile, ["<?php", "", "use LegacyService;", "", "$service = new LegacyService();", ""].join("\n"), "utf8");

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 16,
    });

    expect(result.status).toBe("not_found");
  });

  it("resolves PHP __DIR__ include expressions", async () => {
    const root = await mkTmpDir("dg-resolve-php-dir-include-");
    const consumerFile = path.join(root, "consumer.php");
    const helpersFile = path.join(root, "helpers.php");

    await fsp.writeFile(
      helpersFile,
      ["<?php", "", "function helper_from_dir(): string", "{", "    return 'ok';", "}", ""].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      consumerFile,
      ["<?php", "", "require __DIR__ . '/helpers.php';", "", "$value = helper_from_dir();", ""].join("\n"),
      "utf8",
    );

    const consumerPath = consumerFile.replace(/\\/g, "/");
    const helpersPath = helpersFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [consumerPath, helpersPath]);
    expect(graph.edges.some((edge) => edge.from === consumerPath && edge.to.type === "file" && edge.to.path === helpersPath)).toBe(true);

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerPath,
      line: 5,
      column: 12,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(helpersPath);
      expect(result.definition.range.start.line).toBe(3);
    }
  });

  it("resolves PHP relative include strings that start with ./", async () => {
    const root = await mkTmpDir("dg-resolve-php-relative-include-");
    const consumerFile = path.join(root, "consumer.php");
    const helpersFile = path.join(root, "helpers.php");

    await fsp.writeFile(
      helpersFile,
      ["<?php", "", "function helper_from_relative(): string", "{", "    return 'ok';", "}", ""].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      consumerFile,
      ["<?php", "", "require './helpers.php';", "", "$value = helper_from_relative();", ""].join("\n"),
      "utf8",
    );

    const consumerPath = consumerFile.replace(/\\/g, "/");
    const helpersPath = helpersFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [consumerPath, helpersPath]);
    expect(graph.edges.some((edge) => edge.from === consumerPath && edge.to.type === "file" && edge.to.path === helpersPath)).toBe(true);

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerPath,
      line: 5,
      column: 12,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(helpersPath);
      expect(result.definition.range.start.line).toBe(3);
    }
  });

  it("resolves fully-qualified PHP class references without use statements", async () => {
    const root = await mkTmpDir("dg-resolve-php-qualified-");
    const srcDir = path.join(root, "src", "Domain");
    const consumerFile = path.join(root, "consumer.php");
    const serviceFile = path.join(srcDir, "Service.php");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(
      path.join(root, "composer.json"),
      JSON.stringify({ autoload: { "psr-4": { "App\\\\": "src/" } } }, null, 2),
      "utf8",
    );
    await fsp.writeFile(serviceFile, ["<?php", "", "namespace App\\Domain;", "", "class Service {}", ""].join("\n"), "utf8");
    await fsp.writeFile(consumerFile, ["<?php", "", "$service = new App\\Domain\\Service();", ""].join("\n"), "utf8");

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 3,
      column: 27,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(serviceFile.replace(/\\/g, "/"));
      expect(result.definition.range.start.line).toBe(5);
    }
  });

  it("resolves fully-qualified PHP static class references without use statements", async () => {
    const root = await mkTmpDir("dg-resolve-php-qualified-static-");
    const srcDir = path.join(root, "src", "Domain");
    const consumerFile = path.join(root, "consumer.php");
    const serviceFile = path.join(srcDir, "Service.php");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(
      path.join(root, "composer.json"),
      JSON.stringify({ autoload: { "psr-4": { "App\\\\": "src/" } } }, null, 2),
      "utf8",
    );
    await fsp.writeFile(
      serviceFile,
      [
        "<?php",
        "",
        "namespace App\\Domain;",
        "",
        "class Service",
        "{",
        "    public static function make(): self",
        "    {",
        "        return new self();",
        "    }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(consumerFile, ["<?php", "", "$service = App\\Domain\\Service::make();", ""].join("\n"), "utf8");

    const consumerPath = consumerFile.replace(/\\/g, "/");
    const servicePath = serviceFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [consumerPath, servicePath]);
    expect(graph.edges.some((edge) => edge.from === consumerPath && edge.to.type === "file" && edge.to.path === servicePath)).toBe(true);

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerPath,
      line: 3,
      column: 23,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(servicePath);
      expect(result.definition.range.start.line).toBe(5);
    }
  });

  it("does not create PHP class dependency edges from quoted fully-qualified names", async () => {
    const root = await mkTmpDir("dg-resolve-php-qualified-string-");
    const consumerFile = path.join(root, "consumer.php");

    await fsp.writeFile(consumerFile, ["<?php", "", 'echo "new App\\\\Domain\\\\Service()";', ""].join("\n"), "utf8");

    const consumerPath = consumerFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [consumerPath]);
    expect(graph.edges).toHaveLength(0);
  });

  it("resolves PHP function imports to functions even when classes share the same basename", async () => {
    const root = await mkTmpDir("dg-resolve-php-function-kind-");
    const srcDir = path.join(root, "src", "Collision");
    const consumerFile = path.join(root, "consumer.php");
    const classFile = path.join(srcDir, "Thing.php");
    const functionFile = path.join(srcDir, "ThingFunction.php");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(
      path.join(root, "composer.json"),
      JSON.stringify({ autoload: { "psr-4": { "App\\\\": "src/" } } }, null, 2),
      "utf8",
    );
    await fsp.writeFile(classFile, ["<?php", "", "namespace App\\Collision;", "", "class Thing {}", ""].join("\n"), "utf8");
    await fsp.writeFile(
      functionFile,
      ["<?php", "", "namespace App\\Collision;", "", "function Thing(): string", "{", "    return 'ok';", "}", ""].join("\n"),
      "utf8",
    );
    await fsp.writeFile(consumerFile, ["<?php", "", "use function App\\Collision\\Thing;", "", "$value = Thing();", ""].join("\n"), "utf8");

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 10,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(functionFile.replace(/\\/g, "/"));
      expect(result.definition.range.start.line).toBe(5);
    }
  });

  it("does not index PHP methods as top-level functions for Composer symbol resolution", async () => {
    const root = await mkTmpDir("dg-resolve-php-method-pollution-");
    const srcDir = path.join(root, "src", "Domain");
    const consumerFile = path.join(root, "consumer.php");
    const serviceFile = path.join(srcDir, "Service.php");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(path.join(root, "composer.json"), JSON.stringify({ autoload: { classmap: ["src/"] } }, null, 2), "utf8");
    await fsp.writeFile(
      serviceFile,
      ["<?php", "", "class Service", "{", "    public function make(): string", "    {", "        return 'ok';", "    }", "}", ""].join(
        "\n",
      ),
      "utf8",
    );
    await fsp.writeFile(consumerFile, ["<?php", "", "use function make;", "", "$value = make();", ""].join("\n"), "utf8");

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 10,
    });

    expect(result.status).toBe("not_found");
  });

  it("does not index PHP declarations that only appear inside comments", async () => {
    const root = await mkTmpDir("dg-resolve-php-comment-pollution-");
    const srcDir = path.join(root, "src");
    const consumerFile = path.join(root, "consumer.php");
    const commentOnlyFile = path.join(srcDir, "CommentOnly.php");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(path.join(root, "composer.json"), JSON.stringify({ autoload: { classmap: ["src/"] } }, null, 2), "utf8");
    await fsp.writeFile(
      commentOnlyFile,
      ["<?php", "", "// function GhostHelper() {}", "/** class PhantomClass {} */", "echo 'placeholder';", ""].join("\n"),
      "utf8",
    );
    await fsp.writeFile(consumerFile, ["<?php", "", "use function GhostHelper;", "", "$value = GhostHelper();", ""].join("\n"), "utf8");

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 10,
    });

    expect(result.status).toBe("not_found");
  });

  it("indexes PHP declarations that share a line with attributes", async () => {
    const root = await mkTmpDir("dg-resolve-php-attributes-");
    const srcDir = path.join(root, "src");
    const consumerFile = path.join(root, "consumer.php");
    const serviceFile = path.join(srcDir, "AttrService.php");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(path.join(root, "composer.json"), JSON.stringify({ autoload: { classmap: ["src/"] } }, null, 2), "utf8");
    await fsp.writeFile(serviceFile, ["<?php", "", "#[Route('/attr')] class AttrService {}", ""].join("\n"), "utf8");
    await fsp.writeFile(consumerFile, ["<?php", "", "use AttrService;", "", "$service = new AttrService();", ""].join("\n"), "utf8");

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 16,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(serviceFile.replace(/\\/g, "/"));
      expect(result.definition.range.start.line).toBe(3);
    }
  });

  it("prefers namespace-level PHP const imports over class constants", async () => {
    const root = await mkTmpDir("dg-resolve-php-const-kind-");
    const srcDir = path.join(root, "src", "Domain");
    const consumerFile = path.join(root, "consumer.php");
    const classFile = path.join(srcDir, "AClass.php");
    const constFile = path.join(srcDir, "ZConst.php");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(
      path.join(root, "composer.json"),
      JSON.stringify({ autoload: { "psr-4": { "App\\\\": "src/" } } }, null, 2),
      "utf8",
    );
    await fsp.writeFile(
      classFile,
      ["<?php", "", "namespace App\\Domain;", "", "class AClass", "{", "    public const NAME = 'class';", "}", ""].join("\n"),
      "utf8",
    );
    await fsp.writeFile(constFile, ["<?php", "", "namespace App\\Domain;", "", "const NAME = 'namespace';", ""].join("\n"), "utf8");
    await fsp.writeFile(consumerFile, ["<?php", "", "use const App\\Domain\\NAME;", "", "$value = NAME;", ""].join("\n"), "utf8");

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 10,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(constFile.replace(/\\/g, "/"));
      expect(result.definition.range.start.line).toBe(5);
    }
  });

  it("does not index PHP const initializer identifiers as constants", async () => {
    const root = await mkTmpDir("dg-resolve-php-const-initializer-");
    const srcDir = path.join(root, "src");
    const consumerFile = path.join(root, "consumer.php");
    const constFile = path.join(srcDir, "Constants.php");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(path.join(root, "composer.json"), JSON.stringify({ autoload: { classmap: ["src/"] } }, null, 2), "utf8");
    await fsp.writeFile(constFile, ["<?php", "", "const REAL_NAME = VALUE_ALIAS;", ""].join("\n"), "utf8");
    await fsp.writeFile(consumerFile, ["<?php", "", "use const VALUE_ALIAS;", "", "$value = VALUE_ALIAS;", ""].join("\n"), "utf8");

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 12,
    });

    expect(result.status).toBe("not_found");
  });

  it("resolves PHP imports from bracketed namespace blocks later in the same file", async () => {
    const root = await mkTmpDir("dg-resolve-php-bracketed-namespace-");
    const srcDir = path.join(root, "src");
    const consumerFile = path.join(root, "consumer.php");
    const libraryFile = path.join(srcDir, "Library.php");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(path.join(root, "composer.json"), JSON.stringify({ autoload: { classmap: ["src/"] } }, null, 2), "utf8");
    await fsp.writeFile(
      libraryFile,
      [
        "<?php",
        "",
        "namespace App\\One {",
        "    class FirstService {}",
        "}",
        "",
        "namespace App\\Two {",
        "    class SecondService {}",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      consumerFile,
      ["<?php", "", "use App\\Two\\SecondService;", "", "$service = new SecondService();", ""].join("\n"),
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 17,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(libraryFile.replace(/\\/g, "/"));
      expect(result.definition.range.start.line).toBe(8);
    }
  });

  it("resolves PHP namespace-relative references inside later bracketed namespace blocks", async () => {
    const root = await mkTmpDir("dg-resolve-php-namespace-relative-");
    const srcDir = path.join(root, "src");
    const consumerFile = path.join(srcDir, "consumer.php");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(
      consumerFile,
      [
        "<?php",
        "",
        "namespace App\\One {",
        "    class FirstService {}",
        "}",
        "",
        "namespace App\\Two {",
        "    class SecondService {}",
        "",
        "    $service = new namespace\\SecondService();",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 10,
      column: 31,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(consumerFile.replace(/\\/g, "/"));
      expect(result.definition.range.start.line).toBe(8);
    }
  });

  it("resolves cross-file PHP namespace-relative references inside later bracketed namespace blocks", async () => {
    const root = await mkTmpDir("dg-resolve-php-namespace-relative-cross-file-");
    const srcDir = path.join(root, "src");
    const consumerFile = path.join(srcDir, "consumer.php");
    const libraryFile = path.join(srcDir, "Library.php");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(path.join(root, "composer.json"), JSON.stringify({ autoload: { classmap: ["src/"] } }, null, 2), "utf8");
    await fsp.writeFile(
      libraryFile,
      [
        "<?php",
        "",
        "namespace App\\One {",
        "    class FirstService {}",
        "}",
        "",
        "namespace App\\Two {",
        "    class SecondService {}",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fsp.writeFile(
      consumerFile,
      [
        "<?php",
        "",
        "namespace App\\One {",
        "    class Placeholder {}",
        "}",
        "",
        "namespace App\\Two {",
        "    $service = new namespace\\SecondService();",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 8,
      column: 31,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(libraryFile.replace(/\\/g, "/"));
      expect(result.definition.range.start.line).toBe(8);
    }
  });

  it("clears cached PHP Composer autoload surfaces when import caches reset", async () => {
    const root = await mkTmpDir("dg-resolve-php-autoload-cache-clear-");
    const srcDir = path.join(root, "src");
    const consumerFile = path.join(root, "consumer.php");
    const serviceFile = path.join(srcDir, "NewService.php");

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(path.join(root, "composer.json"), JSON.stringify({ autoload: { classmap: ["src/"] } }, null, 2), "utf8");
    await fsp.writeFile(consumerFile, ["<?php", "", "use NewService;", "", "$service = new NewService();", ""].join("\n"), "utf8");

    let index = await buildProjectIndex(root);
    let result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 16,
    });
    expect(result.status).toBe("not_found");

    await fsp.writeFile(serviceFile, ["<?php", "", "class NewService {}", ""].join("\n"), "utf8");

    clearImportResolutionCaches();
    index = await buildProjectIndex(root);
    result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 16,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(serviceFile.replace(/\\/g, "/"));
      expect(result.definition.range.start.line).toBe(3);
    }
  });

  it("does not resolve PHP symbols excluded from Composer classmaps", async () => {
    const root = await mkTmpDir("dg-resolve-php-classmap-exclude-");
    const includedDir = path.join(root, "src", "Included");
    const excludedDir = path.join(root, "src", "Excluded");
    const consumerFile = path.join(root, "consumer.php");
    const visibleFile = path.join(includedDir, "VisibleService.php");
    const hiddenFile = path.join(excludedDir, "HiddenService.php");

    await fsp.mkdir(includedDir, { recursive: true });
    await fsp.mkdir(excludedDir, { recursive: true });
    await fsp.writeFile(
      path.join(root, "composer.json"),
      JSON.stringify(
        {
          autoload: {
            classmap: ["src/"],
            "exclude-from-classmap": ["/src/Excluded/"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(visibleFile, ["<?php", "", "class VisibleService {}", ""].join("\n"), "utf8");
    await fsp.writeFile(hiddenFile, ["<?php", "", "class HiddenService {}", ""].join("\n"), "utf8");
    await fsp.writeFile(consumerFile, ["<?php", "", "use HiddenService;", "", "$service = new HiddenService();", ""].join("\n"), "utf8");

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerFile.replace(/\\/g, "/"),
      line: 5,
      column: 16,
    });

    expect(result.status).toBe("not_found");
  });

  it("treats PHP autoload.files entries as implicit file dependencies and symbol sources", async () => {
    const root = await mkTmpDir("dg-resolve-php-autoload-files-");
    const bootstrapDir = path.join(root, "bootstrap");
    const consumerFile = path.join(root, "consumer.php");
    const bootstrapFile = path.join(bootstrapDir, "functions.php");

    await fsp.mkdir(bootstrapDir, { recursive: true });
    await fsp.writeFile(
      path.join(root, "composer.json"),
      JSON.stringify({ autoload: { files: ["bootstrap/functions.php"] } }, null, 2),
      "utf8",
    );
    await fsp.writeFile(
      bootstrapFile,
      ["<?php", "", "function shared_helper(): string", "{", "    return 'ok';", "}", ""].join("\n"),
      "utf8",
    );
    await fsp.writeFile(consumerFile, ["<?php", "", "$value = shared_helper();", ""].join("\n"), "utf8");

    const consumerPath = consumerFile.replace(/\\/g, "/");
    const bootstrapPath = bootstrapFile.replace(/\\/g, "/");
    const graph = await collectGraph(root, [consumerPath, bootstrapPath]);
    expect(graph.edges.some((edge) => edge.from === consumerPath && edge.to.type === "file" && edge.to.path === bootstrapPath)).toBe(true);

    const index = await buildProjectIndex(root);
    const result = await goToDefinition(index, {
      file: consumerPath,
      line: 3,
      column: 12,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(bootstrapPath);
      expect(result.definition.range.start.line).toBe(3);
    }
  });
});
