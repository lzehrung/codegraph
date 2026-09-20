import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import { expect, describe, it } from "vitest";
import { collectModuleSpecifiersFromSource } from "../../src/graphs.js";
import { collectImportsForFile } from "../../src/indexer/imports.js";
import {
  buildProjectIndex,
  collectGraph,
  collectLocalsAndExportsFromSource,
  findReferences,
  goToDefinition,
} from "../../src/index.js";
import { supportById } from "../../src/languages.js";
import { isNativeTreeSitterAvailable, runNativeLanguageQueries } from "../../src/native/tree-sitter-native.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "scss",
  samples: [
    {
      name: "chunks SCSS structures",
      sourceFile: "scss.sample.scss",
      exactChunks: [
        { type: "comment", startLine: 1, endLine: 1 },
        { type: "misc", startLine: 1, endLine: 5 },
        { type: "mixin", startLine: 6, endLine: 12 },
        { type: "rule", startLine: 13, endLine: 20 },
        { type: "rule", startLine: 17, endLine: 19 },
        { type: "misc", startLine: 20, endLine: 21 },
        { type: "function", startLine: 22, endLine: 24 },
      ],
    },
  ],
  parity: {
    sampleDir: "scss",
    exact: {
      dependencyGraph: [
        {
          from: "extensionless-forward.scss",
          to: { type: "file", path: "_tokens.scss" },
        },
        {
          from: "extensionless-import.scss",
          to: { type: "file", path: "_tokens.scss" },
        },
        {
          from: "forward.scss",
          to: { type: "file", path: "_mixins.scss" },
        },
        {
          from: "forward.scss",
          to: { type: "file", path: "_variables.scss" },
        },
        {
          from: "main.scss",
          to: { type: "external", name: "./icons" },
        },
        {
          from: "main.scss",
          to: { type: "external", name: "./missing" },
        },
        {
          from: "main.scss",
          to: { type: "file", path: "_mixins.scss" },
        },
        {
          from: "main.scss",
          to: { type: "file", path: "_tokens.scss" },
        },
        {
          from: "main.scss",
          to: { type: "file", path: "_variables.scss" },
        },
        {
          from: "main.scss",
          to: { type: "file", path: "theme.scss" },
        },
        {
          from: "uppercase-extension-import.scss",
          to: { type: "file", path: "_tokens.scss" },
        },
        {
          from: "use-partials.scss",
          to: { type: "external", name: "cdn-texture" },
        },
        {
          from: "use-partials.scss",
          to: { type: "file", path: "_mixins.scss" },
        },
        {
          from: "use-partials.scss",
          to: { type: "file", path: "_variables.scss" },
        },
      ],
      symbols: [
        {
          file: "_mixins.scss",
          symbols: [{ name: "center", kind: "function" }],
        },
        {
          file: "_tokens.scss",
          symbols: [{ name: "$spacing", kind: "variable" }],
        },
        {
          file: "_variables.scss",
          symbols: [
            { name: "$primary-color", kind: "variable" },
            { name: "primary", kind: "variable" },
          ],
        },
      ],
      references: [
        {
          name: "find references is not available on a CSS property",
          file: "_variables.scss",
          line: 4,
          column: 3,
          expectedStatus: "not_found",
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition is not available on a CSS property",
        file: "_variables.scss",
        line: 4,
        column: 3,
        expectedStatus: "not_found",
      },
    ],
    absentDependencyGraph: [
      {
        from: "extensionless-forward.scss",
        to: { type: "file", path: "_tokens.ts" },
      },
      {
        from: "extensionless-import.scss",
        to: { type: "file", path: "_tokens.ts" },
      },
      {
        from: "main.scss",
        to: { type: "file", path: "_icons.scss" },
      },
      {
        from: "main.scss",
        to: { type: "file", path: "_tokens.ts" },
      },
      {
        from: "main.scss",
        to: { type: "file", path: "theme.ts" },
      },
    ],
  },
};

runLanguageTests(definition);

it.runIf(isNativeTreeSitterAvailable())("captures SCSS mixin, function, and variable names", () => {
  const support = supportById("scss")!;
  const source = `$brand: #333;
@mixin flex-center {
  display: flex;
}
@function double($n) {
  @return $n * 2;
}
`;
  const nativeQueries = runNativeLanguageQueries(source, support);
  expect(nativeQueries).not.toBeNull();
  const moduleIndex = collectLocalsAndExportsFromSource("theme.scss", source, support, [], {
    ...(nativeQueries ? { nativeQueries } : {}),
  });
  const localNames = moduleIndex.locals.map((symbol) => symbol.localName).sort();
  const exportNames = moduleIndex.exports
    .filter((entry): entry is typeof entry & { type: "local" } => entry.type === "local")
    .map((entry) => entry.exportedAs)
    .sort();
  expect(localNames).toEqual(["$brand", "double", "flex-center"]);
  expect(exportNames).toEqual(["$brand", "double", "flex-center"]);
});

it.runIf(isNativeTreeSitterAvailable())("captures @use and @forward paths wrapped by as *", () => {
  const support = supportById("scss")!;
  const specifiers = collectModuleSpecifiersFromSource(
    support,
    '@use "./mixins" as *;\n@forward "./buttons" as btn-*;\n',
  );
  expect(specifiers.map((entry) => entry.spec).sort()).toEqual(["./buttons", "./mixins"]);
});

it("does not resolve stylesheet url assets as Sass partials", async () => {
  const samplePath = path.resolve(process.cwd(), "tests", "samples", "scss");
  const mainFile = path.join(samplePath, "main.scss").replace(/\\/g, "/");
  const partialFile = path.join(samplePath, "_icons.scss").replace(/\\/g, "/");
  const graph = await collectGraph(samplePath, [mainFile, partialFile]);

  expect(
    graph.edges.some((edge) => edge.from === mainFile && edge.to.type === "file" && edge.to.path === partialFile),
  ).toBe(false);
  expect(
    graph.edges.some((edge) => edge.from === mainFile && edge.to.type === "external" && edge.to.name === "./icons"),
  ).toBe(true);
});

it("prefers SCSS partials over non-stylesheet files with the same partial basename", async () => {
  const samplePath = path.resolve(process.cwd(), "tests", "samples", "scss");
  const mainFile = path.join(samplePath, "main.scss").replace(/\\/g, "/");
  const scssPartialFile = path.join(samplePath, "_tokens.scss").replace(/\\/g, "/");
  const tsPartialFile = path.join(samplePath, "_tokens.ts").replace(/\\/g, "/");
  const graph = await collectGraph(samplePath, [mainFile, scssPartialFile, tsPartialFile]);

  expect(
    graph.edges.some((edge) => edge.from === mainFile && edge.to.type === "file" && edge.to.path === scssPartialFile),
  ).toBe(true);
  expect(
    graph.edges.some((edge) => edge.from === mainFile && edge.to.type === "file" && edge.to.path === tsPartialFile),
  ).toBe(false);
});

it("resolves bare Sass imports to sibling partials", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-scss-bare-import-"));
  const mainFile = path.join(root, "main.scss").replace(/\\/g, "/");
  const partialFile = path.join(root, "_variables.scss").replace(/\\/g, "/");
  await Promise.all([
    fsp.writeFile(mainFile, '@use "variables";\n@use "./missing";\n', "utf8"),
    fsp.writeFile(partialFile, "$color: red;\n", "utf8"),
  ]);
  try {
    const graph = await collectGraph(root, [mainFile, partialFile]);
    expect(
      graph.edges.some((edge) => edge.from === mainFile && edge.to.type === "file" && edge.to.path === partialFile),
    ).toBe(true);
    expect(
      graph.edges.some((edge) => edge.from === mainFile && edge.to.type === "external" && edge.to.name === "./missing"),
    ).toBe(true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("resolves a bare stylesheet import to the sibling partial, not a same-basename script", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-scss-binding-resolve-"));
  const mainFile = path.join(root, "main.scss");
  const partialFile = path.join(root, "_variables.scss");
  const scriptFile = path.join(root, "variables.ts");
  await Promise.all([
    fsp.writeFile(mainFile, '@use "variables";\n', "utf8"),
    fsp.writeFile(partialFile, "$color: red;\n", "utf8"),
    fsp.writeFile(scriptFile, "export const color = 1;\n", "utf8"),
  ]);
  try {
    const imports = await collectImportsForFile(mainFile, root);
    const stylesheet = imports.find((entry) => entry.from === "variables");
    expect(stylesheet).toBeDefined();
    expect(typeof stylesheet?.resolved).toBe("string");
    if (typeof stylesheet?.resolved === "string") {
      expect(path.basename(stylesheet.resolved)).toBe("_variables.scss");
      expect(path.basename(stylesheet.resolved)).not.toBe("variables.ts");
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

describe("SCSS same-file navigation", () => {
  function positionOf(source: string, needle: string, occurrence = 0): { line: number; column: number } {
    let from = 0;
    let index = -1;
    for (let count = 0; count <= occurrence; count += 1) {
      index = source.indexOf(needle, from);
      if (index < 0) {
        throw new Error(`missing ${needle}`);
      }
      from = index + needle.length;
    }
    const lineStart = source.lastIndexOf("\n", index - 1) + 1;
    return {
      line: source.slice(0, index).split("\n").length,
      column: index - lineStart + 1,
    };
  }

  it.runIf(isNativeTreeSitterAvailable())(
    "resolves declarations and same-file variable, mixin, and placeholder uses",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-scss-nav-"));
      const file = path.join(root, "theme.scss").replace(/\\/g, "/");
      const source = [
        "$brand: #333;",
        "",
        "@mixin center {",
        "  display: flex;",
        "}",
        "",
        "%placeholder {",
        "  color: inherit;",
        "}",
        "",
        ".box {",
        "  color: $brand;",
        "  @include center;",
        "  @extend %placeholder;",
        "}",
        "",
      ].join("\n");
      await fsp.writeFile(file, source, "utf8");
      try {
        const index = await buildProjectIndex(root, { cache: "off" });
        const brandDecl = positionOf(source, "$brand");
        const brandUse = positionOf(source, "$brand", 1);
        const mixinDecl = positionOf(source, "center");
        const mixinUse = positionOf(source, "center", 1);
        const placeholderDecl = positionOf(source, "placeholder");
        const placeholderUse = positionOf(source, "placeholder", 1);

        const brandFromDecl = await goToDefinition(index, { file, ...brandDecl });
        expect(brandFromDecl.status).toBe("ok");
        if (brandFromDecl.status === "ok") {
          expect(brandFromDecl.definition.range.start.line).toBe(brandDecl.line);
          expect(brandFromDecl.definition.localName).toBe("$brand");
        }

        const brandFromUse = await goToDefinition(index, { file, ...brandUse });
        expect(brandFromUse.status).toBe("ok");
        if (brandFromUse.status === "ok") {
          expect(brandFromUse.definition.range.start.line).toBe(brandDecl.line);
        }

        const mixinFromUse = await goToDefinition(index, { file, ...mixinUse });
        expect(mixinFromUse.status).toBe("ok");
        if (mixinFromUse.status === "ok") {
          expect(mixinFromUse.definition.range.start.line).toBe(mixinDecl.line);
          expect(mixinFromUse.definition.localName).toBe("center");
        }

        const placeholderFromUse = await goToDefinition(index, { file, ...placeholderUse });
        expect(placeholderFromUse.status).toBe("ok");
        if (placeholderFromUse.status === "ok") {
          expect(placeholderFromUse.definition.range.start.line).toBe(placeholderDecl.line);
        }

        const brandRefs = await findReferences(index, { file, ...brandDecl });
        expect(brandRefs.status).toBe("ok");
        if (brandRefs.status === "ok") {
          expect(brandRefs.references.map((entry) => entry.range.start.line).sort((a, b) => a - b)).toEqual([
            brandDecl.line,
            brandUse.line,
          ]);
        }

        const mixinRefs = await findReferences(index, { file, ...mixinDecl });
        expect(mixinRefs.status).toBe("ok");
        if (mixinRefs.status === "ok") {
          expect(mixinRefs.references.map((entry) => entry.range.start.line).sort((a, b) => a - b)).toEqual([
            mixinDecl.line,
            mixinUse.line,
          ]);
        }

        const placeholderRefs = await findReferences(index, { file, ...placeholderDecl });
        expect(placeholderRefs.status).toBe("ok");
        if (placeholderRefs.status === "ok") {
          expect(placeholderRefs.references.map((entry) => entry.range.start.line).sort((a, b) => a - b)).toEqual([
            placeholderDecl.line,
            placeholderUse.line,
          ]);
        }
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(isNativeTreeSitterAvailable())("does not resolve namespaced @use members", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-scss-ns-"));
    const themeFile = path.join(root, "theme.scss").replace(/\\/g, "/");
    const tokensFile = path.join(root, "_tokens.scss").replace(/\\/g, "/");
    const themeSource = ["$brand: blue;", '@use "./tokens" as b;', ".ns {", "  color: b.$brand;", "}", ""].join("\n");
    await Promise.all([
      fsp.writeFile(themeFile, themeSource, "utf8"),
      fsp.writeFile(tokensFile, "$brand: red;\n", "utf8"),
    ]);
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const namespaced = positionOf(themeSource, "b.$brand");
      const result = await goToDefinition(index, { file: themeFile, ...namespaced });
      expect(result.status).toBe("not_found");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(isNativeTreeSitterAvailable())("does not resolve a selector inside a comment or string", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-scss-lit-"));
    const file = path.join(root, "theme.scss").replace(/\\/g, "/");
    const source = [
      ".primary {",
      "  color: red;",
      "}",
      "/* .primary */",
      ".quoted {",
      '  content: ".primary";',
      "}",
      "",
    ].join("\n");
    await fsp.writeFile(file, source, "utf8");
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const decl = positionOf(source, "primary");
      const comment = positionOf(source, ".primary", 1);
      const quoted = positionOf(source, ".primary", 2);

      const commentGoto = await goToDefinition(index, { file, ...comment });
      expect(commentGoto.status).toBe("not_found");
      const quotedGoto = await goToDefinition(index, { file, ...quoted });
      expect(quotedGoto.status).toBe("not_found");

      const refs = await findReferences(index, { file, ...decl });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references.map((entry) => entry.range.start.line)).toEqual([decl.line]);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
