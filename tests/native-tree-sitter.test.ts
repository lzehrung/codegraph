import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isJsFallbackAvailable, parseWithJsLanguage } from "../src/jsFallback.js";
import { collectImportsForFile, collectLocalsAndExportsFromSource, parseFile } from "../src/indexer.js";
import { languageForFile, supportForFile } from "../src/languages.js";
import { collectModuleSpecifiersFromSource } from "../src/graphs.js";
import { isNativeTreeSitterAvailable } from "../src/native/treeSitterNative.js";

const nativeDescribe = isNativeTreeSitterAvailable() ? describe : describe.skip;
const jsFallbackDescribe = isJsFallbackAvailable() ? describe : describe.skip;
const sampleRoot = path.resolve(process.cwd(), "tests", "samples");
const slowNativeParityTimeoutMs = 30000;
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-native-"));
  tempDirs.push(dir);
  return dir;
}

function simplifyImports(imports: Awaited<ReturnType<typeof collectImportsForFile>>): unknown[] {
  return imports.map((entry) => ({
    ...entry,
    resolved: typeof entry.resolved === "string" ? entry.resolved.replace(/\\/g, "/") : entry.resolved,
  }));
}

function simplifyModuleIndex(index: ReturnType<typeof collectLocalsAndExportsFromSource>): unknown {
  return {
    locals: index.locals.map((local) => ({
      localName: local.localName,
      kind: local.kind,
    })),
    exports: index.exports.map((entry) => {
      if (entry.type === "local") {
        return {
          type: entry.type,
          exportedAs: entry.exportedAs,
          localName: entry.target.localName,
          kind: entry.target.kind,
        };
      }
      if (entry.type === "reexport") {
        return {
          type: entry.type,
          exportedAs: entry.exportedAs,
          fromModule: entry.fromModule,
          sourceSpecifier: entry.sourceSpecifier,
          typeOnly: entry.typeOnly ?? false,
        };
      }
      if (entry.type === "namespaceReexport") {
        return {
          type: entry.type,
          exportedAs: entry.exportedAs,
          fromModule: entry.fromModule,
          typeOnly: entry.typeOnly ?? false,
        };
      }
      return {
        type: entry.type,
        fromModule: entry.fromModule,
        sourceSpecifier: entry.sourceSpecifier,
        typeOnly: entry.typeOnly ?? false,
      };
    }),
  };
}

function sampleFile(...parts: string[]): string {
  return path.join(sampleRoot, ...parts);
}

async function parseWithJsTreeSitter(file: string) {
  const parsed = await parseFile(file);
  const lang = languageForFile(file);
  const tree = parseWithJsLanguage(parsed.source, lang);
  return {
    ...parsed,
    tree,
    lang,
  };
}

async function expectNativeImportParity(projectDir: string, relativeFile: string): Promise<void> {
  const projectRoot = sampleFile(projectDir);
  const file = path.join(projectRoot, relativeFile);
  const nativeParsed = await parseFile(file);
  const jsParsed = await parseWithJsTreeSitter(file);
  expect(nativeParsed.nativeQueries).not.toBeNull();

  const nativeImports = await collectImportsForFile(file, projectRoot, {
    source: nativeParsed.source,
    sup: nativeParsed.sup,
    lang: nativeParsed.lang,
    nativeQueries: nativeParsed.nativeQueries,
  });
  const jsImports = await collectImportsForFile(file, projectRoot, {
    source: jsParsed.source,
    tree: jsParsed.tree,
    sup: jsParsed.sup,
    lang: jsParsed.lang,
    nativeMode: "off",
  });

  expect(simplifyImports(nativeImports)).toEqual(simplifyImports(jsImports));
}

async function expectNativeModuleIndexParity(relativeFile: string): Promise<void> {
  const file = sampleFile(relativeFile);
  const nativeParsed = await parseFile(file);
  const jsParsed = await parseWithJsTreeSitter(file);
  expect(nativeParsed.nativeQueries).not.toBeNull();

  const nativeIndex = collectLocalsAndExportsFromSource(
    file,
    nativeParsed.source,
    nativeParsed.sup,
    nativeParsed.lang,
    [],
    {
      tree: nativeParsed.tree,
      nativeQueries: nativeParsed.nativeQueries,
    },
  );
  const jsIndex = collectLocalsAndExportsFromSource(file, jsParsed.source, jsParsed.sup, jsParsed.lang, [], {
    tree: jsParsed.tree,
    nativeMode: "off",
  });

  expect(simplifyModuleIndex(nativeIndex)).toEqual(simplifyModuleIndex(jsIndex));
}

async function expectNativeModuleSpecifierParity(relativeFile: string): Promise<void> {
  const file = sampleFile(relativeFile);
  const parsed = await parseFile(file);
  expect(parsed.nativeQueries).not.toBeNull();

  const nativeSpecifiers = collectModuleSpecifiersFromSource(parsed.sup, parsed.lang, parsed.source, {
    tree: parsed.tree,
    nativeQueries: parsed.nativeQueries,
    file,
  });
  const jsSpecifiers = collectModuleSpecifiersFromSource(parsed.sup, parsed.lang, parsed.source, {
    tree: parsed.tree,
    file,
    native: "off",
  });

  expect(nativeSpecifiers).toEqual(jsSpecifiers);
}

jsFallbackDescribe("native tree-sitter integration", () => {
  it("matches JS import extraction with and without native query results", async () => {
    const projectRoot = await makeTempProject();
    const entry = path.join(projectRoot, "entry.js");
    await fs.writeFile(
      entry,
      [
        'import value, { helper as alias } from "./dep.js";',
        'import * as ns from "./ns.js";',
        'const { createThing: maker } = require("./cjs.js");',
        'const cjsDefault = require("./cjs-default.js");',
      ].join("\n"),
    );
    await fs.writeFile(path.join(projectRoot, "dep.js"), "export const helper = 1;\nexport default 1;\n");
    await fs.writeFile(path.join(projectRoot, "ns.js"), "export const nsValue = 1;\n");
    await fs.writeFile(path.join(projectRoot, "cjs.js"), "module.exports = { createThing() {} };\n");
    await fs.writeFile(path.join(projectRoot, "cjs-default.js"), "module.exports = () => 1;\n");

    const nativeParsed = await parseFile(entry);
    const jsParsed = await parseWithJsTreeSitter(entry);
    expect(nativeParsed.nativeQueries).not.toBeNull();

    const nativeImports = await collectImportsForFile(entry, projectRoot, {
      source: nativeParsed.source,
      sup: nativeParsed.sup,
      lang: nativeParsed.lang,
      nativeQueries: nativeParsed.nativeQueries,
    });
    const jsImports = await collectImportsForFile(entry, projectRoot, {
      source: jsParsed.source,
      tree: jsParsed.tree,
      sup: jsParsed.sup,
      lang: jsParsed.lang,
      nativeMode: "off",
    });

    expect(simplifyImports(nativeImports)).toEqual(simplifyImports(jsImports));
  });

  it("matches Python locals and exports with and without native query results", async () => {
    const projectRoot = await makeTempProject();
    const file = path.join(projectRoot, "module.py");
    await fs.writeFile(
      file,
      [
        '"""module docs"""',
        '__all__ = ["exported_function", "ExportedClass"]',
        "",
        "def exported_function():",
        "    return 1",
        "",
        "class ExportedClass:",
        "    pass",
        "",
        "def _private_function():",
        "    return 2",
      ].join("\n"),
    );

    const nativeParsed = await parseFile(file);
    const jsParsed = await parseWithJsTreeSitter(file);
    expect(nativeParsed.nativeQueries).not.toBeNull();

    const nativeIndex = collectLocalsAndExportsFromSource(
      file,
      nativeParsed.source,
      nativeParsed.sup,
      nativeParsed.lang,
      [],
      {
        tree: nativeParsed.tree,
        nativeQueries: nativeParsed.nativeQueries,
      },
    );
    const jsIndex = collectLocalsAndExportsFromSource(file, jsParsed.source, jsParsed.sup, jsParsed.lang, [], {
      tree: jsParsed.tree,
      nativeMode: "off",
    });

    expect(simplifyModuleIndex(nativeIndex)).toEqual(simplifyModuleIndex(jsIndex));
  });

  it("matches HTML module specifier extraction with and without native query results", async () => {
    const projectRoot = await makeTempProject();
    const file = path.join(projectRoot, "index.html");
    const source = [
      '<link rel="stylesheet" href="./styles.css" />',
      '<script type="module" src="./app.js"></script>',
      "<script>",
      '  import { mount } from "./inline.js";',
      "</script>",
    ].join("\n");
    await fs.writeFile(file, source);

    const parsed = await parseFile(file);
    expect(parsed.nativeQueries).not.toBeNull();
    const support = supportForFile(file);
    expect(support).toBeDefined();

    const nativeSpecifiers = collectModuleSpecifiersFromSource(parsed.sup, parsed.lang, source, {
      tree: parsed.tree,
      nativeQueries: parsed.nativeQueries,
      file,
    });
    const jsSpecifiers = collectModuleSpecifiersFromSource(parsed.sup, parsed.lang, source, {
      tree: parsed.tree,
      file,
      native: "off",
    });

    expect(nativeSpecifiers).toEqual(jsSpecifiers);
  });

  it("matches TypeScript export extraction for export assignment and classes", async () => {
    const projectRoot = await makeTempProject();
    const file = path.join(projectRoot, "module.ts");
    await fs.writeFile(
      file,
      [
        "class InternalClass {}",
        "export class ExportedClass {}",
        "const assigned = InternalClass;",
        "export = assigned;",
      ].join("\n"),
    );

    const nativeParsed = await parseFile(file);
    const jsParsed = await parseWithJsTreeSitter(file);
    expect(nativeParsed.nativeQueries).not.toBeNull();

    const nativeIndex = collectLocalsAndExportsFromSource(
      file,
      nativeParsed.source,
      nativeParsed.sup,
      nativeParsed.lang,
      [],
      {
        tree: nativeParsed.tree,
        nativeQueries: nativeParsed.nativeQueries,
      },
    );
    const jsIndex = collectLocalsAndExportsFromSource(file, jsParsed.source, jsParsed.sup, jsParsed.lang, [], {
      tree: jsParsed.tree,
      nativeMode: "off",
    });

    expect(simplifyModuleIndex(nativeIndex)).toEqual(simplifyModuleIndex(jsIndex));
  });

  it(
    "matches import extraction for representative compiled languages",
    async () => {
      const cases = [
        ["php", "main.php"],
        ["php", "grouped-consumer.php"],
        ["php", "composer-consumer.php"],
        ["go", "main.go"],
        ["go", "aliased-imports.go"],
        ["go", "aliased-types.go"],
        ["go", "dot-imports.go"],
        ["java", "main.java"],
        ["java", "WildcardImports.java"],
        ["java", "static-imports.java"],
        ["csharp", "Main.cs"],
        ["rust", "main.rs"],
        ["rust", "aliased-use.rs"],
        ["rust", "reexports.rs"],
        ["rust", "nested.rs"],
        ["kotlin", "main.kt"],
        ["kotlin", "Aliases.kt"],
        ["kotlin", "TypeConsumers.kt"],
        ["swift", "main.swift"],
        ["swift", "AdvancedUsage.swift"],
        ["zig", "main.zig"],
        ["c", "main.c"],
        ["c", "advanced-use.c"],
        ["cpp", "main.cpp"],
        ["cpp", "namespace-usage.cpp"],
        ["ruby", "main.rb"],
        ["ruby", "consumer.rb"],
        ["tsx", "App.tsx"],
        ["python", "relative-imports.py"],
        ["javascript", "mixed.js"],
      ] as const;

      for (const [projectDir, relativeFile] of cases) {
        await expectNativeImportParity(projectDir, relativeFile);
      }
    },
    slowNativeParityTimeoutMs,
  );

  it(
    "matches symbol extraction for representative compiled languages",
    async () => {
      const cases = [
        "php/utils.php",
        "php/src/Support/Toolbox.php",
        "php/src/Support/support_helper.php",
        "php/src/Domain/Service.php",
        "go/utils.go",
        "go/contracts.go",
        "java/utils/Utils.java",
        "java/NestedTypes.java",
        "csharp/Utils.cs",
        "csharp/AdvancedTypes.cs",
        "rust/utils.rs",
        "rust/models.rs",
        "rust/reexports.rs",
        "kotlin/utils/helperFunction.kt",
        "kotlin/Models.kt",
        "kotlin/utils/MoreTypes.kt",
        "swift/Utils.swift",
        "swift/Protocols.swift",
        "swift/StaticMembers.swift",
        "zig/helpers.zig",
        "zig/math.zig",
        "c/utils.h",
        "c/advanced.h",
        "c/function-pointers.h",
        "cpp/utils.hpp",
        "cpp/advanced.hpp",
        "cpp/namespaces.hpp",
        "javascript/mixed.js",
        "tsx/components/Button.tsx",
        "ruby/utils.rb",
        "ruby/namespaced.rb",
      ] as const;

      for (const relativeFile of cases) {
        await expectNativeModuleIndexParity(relativeFile);
      }
    },
    slowNativeParityTimeoutMs,
  );

  it(
    "matches module specifier extraction for stylesheet and component languages",
    async () => {
      const cases = [
        "php/main.php",
        "php/grouped-consumer.php",
        "php/composer-consumer.php",
        "css/main.css",
        "less/main.less",
        "less/secondary.less",
        "scss/use-partials.scss",
        "scss/forward.scss",
        "scss/extensionless-forward.scss",
        "scss/extensionless-import.scss",
        "vue/inline-script.vue",
        "vue/script-setup.vue",
        "vue/App.vue",
        "vue/ExternalScripts.vue",
        "vue/TsScript.vue",
        "svelte/inline-script.svelte",
        "svelte/reactive.svelte",
        "svelte/App.svelte",
        "svelte/ExternalScripts.svelte",
        "svelte/TypeScriptWidget.svelte",
        "html/modules.html",
      ] as const;

      for (const relativeFile of cases) {
        await expectNativeModuleSpecifierParity(relativeFile);
      }
    },
    slowNativeParityTimeoutMs,
  );
});
