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
  type ProjectIndex,
} from "../../src/index.js";
import { supportById } from "../../src/languages.js";
import { resolveModuleSpecifierEdges } from "../../src/graphs/edge-resolution.js";
import { resolveSpecifierTargets } from "../../src/util/resolution/specifier-targets.js";
import { isNativeTreeSitterAvailable, runNativeLanguageQueries } from "../../src/native/tree-sitter-native.js";
import { extractScssFacts } from "../../src/scss/syntax.js";
import { previewRenameWithSession } from "../../src/agent/rename-preview.js";
import { createAgentSession } from "../../src/agent/session.js";
import { workspaceSymbolsWithSession } from "../../src/agent/workspace-symbols.js";
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

it("resolves a directory to its index partial, with or without the underscore", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-scss-directory-index-"));
  const mainFile = path.join(root, "main.scss").replace(/\\/g, "/");
  const partialIndex = path.join(root, "lib", "_index.scss").replace(/\\/g, "/");
  const plainIndex = path.join(root, "plain", "index.scss").replace(/\\/g, "/");
  await fsp.mkdir(path.join(root, "lib"), { recursive: true });
  await fsp.mkdir(path.join(root, "plain"), { recursive: true });
  await Promise.all([
    fsp.writeFile(mainFile, '@use "lib";\n@use "plain";\n@use "./empty";\n', "utf8"),
    fsp.writeFile(partialIndex, "$a: 1;\n", "utf8"),
    fsp.writeFile(plainIndex, "$b: 2;\n", "utf8"),
    fsp.mkdir(path.join(root, "empty"), { recursive: true }),
  ]);
  try {
    const graph = await collectGraph(root, [mainFile, partialIndex, plainIndex]);
    const targets = new Map(
      graph.edges
        .filter((edge) => edge.from === mainFile)
        .map((edge) => [edge.raw, edge.to.type === "file" ? edge.to.path : edge.to.type] as const),
    );
    expect(targets.get("lib")).toBe(partialIndex);
    expect(targets.get("plain")).toBe(plainIndex);
    // A directory without an index file is no module.
    expect(targets.get("./empty")).toBe("external");
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
it("resolves an SCSS partial for a source-kind specifier and keeps a document-kind url external", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-scss-source-partial-"));
  const mainFile = path.join(root, "main.scss");
  const partialFile = path.join(root, "_variables.scss");
  const documentPartial = path.join(root, "_icons.scss");
  const wrongPartial = path.join(root, "_variables.ts");
  await Promise.all([
    fsp.writeFile(mainFile, '@use "variables";\n', "utf8"),
    fsp.writeFile(partialFile, "$color: red;\n", "utf8"),
    fsp.writeFile(documentPartial, ".icon { color: red; }\n", "utf8"),
    fsp.writeFile(wrongPartial, "export const color = 1;\n", "utf8"),
  ]);
  try {
    const support = supportById("scss");
    if (!support) throw new Error("missing scss support");
    const context = {
      support,
      file: mainFile,
      projectRoot: root,
      workspaceConfig: undefined,
      matchPath: undefined,
    };
    const graphEdges = await resolveModuleSpecifierEdges({ spec: "./variables", resolutionKind: "source" }, context);
    const graphBases = (graphEdges ?? [])
      .filter((edge) => edge.to.type === "file")
      .map((edge) => (edge.to.type === "file" ? path.basename(edge.to.path) : ""));
    const binding = await resolveSpecifierTargets(mainFile, "./variables", "scss", {
      projectRoot: root,
      resolutionKind: "source",
    });
    const bindingBases = binding.files.map((file) => path.basename(file));
    const documentEdges = await resolveModuleSpecifierEdges({ spec: "./icons", resolutionKind: "document" }, context);
    const documentBinding = await resolveSpecifierTargets(mainFile, "./icons", "scss", {
      projectRoot: root,
      resolutionKind: "document",
    });

    expect(graphBases).toEqual(["_variables.scss"]);
    expect(graphBases).not.toContain("_variables.ts");
    expect(bindingBases).toEqual(["_variables.scss"]);
    expect(bindingBases).not.toContain("_variables.ts");
    expect(documentEdges?.map((edge) => edge.to)).toEqual([{ type: "external", name: "./icons" }]);
    expect(documentBinding.files).toEqual([]);
    expect(documentBinding.externalName).toBe("./icons");
    expect(documentBinding.files.map((file) => path.basename(file))).not.toContain("_icons.scss");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

it("keeps a stylesheet @use and a same-spelled document url() as separate dependencies", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-scss-same-spelling-"));
  try {
    await Promise.all([
      fsp.writeFile(path.join(root, "_icons.scss"), "$size: 1px;\n", "utf8"),
      fsp.writeFile(path.join(root, "use-first.scss"), '@use "icons";\n.a { background: url("icons"); }\n', "utf8"),
      fsp.writeFile(path.join(root, "url-first.scss"), '.b { background: url("icons"); }\n@use "icons";\n', "utf8"),
    ]);
    const index = await buildProjectIndex(root, { cache: "off" });
    for (const file of ["use-first.scss", "url-first.scss"]) {
      const targets = index.graph.edges
        .filter((edge) => path.basename(edge.from) === file)
        .map((edge) => (edge.to.type === "file" ? `file:${path.basename(edge.to.path)}` : `external:${edge.to.name}`))
        .sort();
      // The stylesheet edge reaches the partial; the document URL stays external and never binds it.
      expect(targets, file).toEqual(["external:icons", "file:_icons.scss"]);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

function modulePosition(source: string, needle: string, occurrence = 0): { line: number; column: number } {
  let from = 0;
  let at = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    at = source.indexOf(needle, from);
    if (at < 0) throw new Error(`Missing ${needle}`);
    from = at + needle.length;
  }
  const line = source.slice(0, at).split("\n").length;
  const column = at - source.lastIndexOf("\n", Math.max(0, at - 1));
  return { line, column: at === 0 ? 1 : column };
}

function refKeys(root: string, references: { file: string; range: { start: { line: number } } }[]): string[] {
  return references.map((reference) => `${path.basename(reference.file)}:${reference.range.start.line}`).sort();
}

describe("SCSS module navigation", () => {
  const basic = path.resolve("tests/samples/scss-modules/basic");
  const forward = path.resolve("tests/samples/scss-modules/forward");

  it.runIf(isNativeTreeSitterAvailable())("resolves @use, @import, as *, hyphens, and not decoys", async () => {
    const index = await buildProjectIndex(basic, { cache: "off" });
    const colors = path.join(basic, "_colors.scss");
    const main = path.join(basic, "main.scss");
    const legacy = path.join(basic, "legacy.scss");
    const other = path.join(basic, "other.scss");
    const math = path.join(basic, "math.scss");
    const colorsSource = await fsp.readFile(colors, "utf8");
    const mainSource = await fsp.readFile(main, "utf8");
    const legacySource = await fsp.readFile(legacy, "utf8");
    const otherSource = await fsp.readFile(other, "utf8");
    const mathSource = await fsp.readFile(math, "utf8");
    const primary = modulePosition(colorsSource, "$primary");
    const refs = await findReferences(index, { file: colors, ...primary });
    expect(refs.status).toBe("ok");
    if (refs.status !== "ok") return;
    expect(refs.referenceCoverage?.state).toBe("complete");
    expect(refKeys(basic, refs.references)).toEqual(
      [
        "_colors.scss:1",
        "_colors.scss:17",
        "_colors.scss:20",
        "_colors.scss:21",
        "main.scss:5",
        "legacy.scss:4",
        "star.scss:4",
        "with.scss:1",
      ].sort(),
    );

    const namespaced = modulePosition(mainSource, "$primary");
    const fromNamespace = await goToDefinition(index, { file: main, ...namespaced });
    expect(fromNamespace.status).toBe("ok");
    if (fromNamespace.status === "ok") expect(path.basename(fromNamespace.definition.file)).toBe("_colors.scss");

    const alias = modulePosition(mainSource, "c.pad");
    const fromAlias = await goToDefinition(index, { file: main, line: alias.line, column: alias.column + 2 });
    expect(fromAlias.status).toBe("ok");
    if (fromAlias.status === "ok") {
      expect(path.basename(fromAlias.definition.file)).toBe("_colors.scss");
      expect(fromAlias.definition.localName).toBe("pad");
    }

    const legacyUse = modulePosition(legacySource, "$primary");
    const fromLegacy = await goToDefinition(index, { file: legacy, ...legacyUse });
    expect(fromLegacy.status).toBe("ok");
    if (fromLegacy.status === "ok") expect(path.basename(fromLegacy.definition.file)).toBe("_colors.scss");

    const folded = modulePosition(mainSource, "$primary_color");
    const fromFolded = await goToDefinition(index, { file: main, ...folded });
    expect(fromFolded.status).toBe("ok");
    if (fromFolded.status === "ok") expect(fromFolded.definition.localName).toBe("$primary-color");

    const decoy = modulePosition(otherSource, "$primary");
    const fromDecoy = await goToDefinition(index, { file: other, ...decoy });
    expect(fromDecoy.status).toBe("ok");
    if (fromDecoy.status === "ok") expect(path.basename(fromDecoy.definition.file)).toBe("other.scss");

    const builtin = modulePosition(mathSource, "div");
    const fromBuiltin = await goToDefinition(index, { file: math, ...builtin });
    expect(fromBuiltin.status).toBe("not_found");

    const divDecl = modulePosition(colorsSource, "div");
    const divRefs = await findReferences(index, { file: colors, ...divDecl });
    expect(divRefs.status).toBe("ok");
    if (divRefs.status === "ok") {
      expect(divRefs.references.some((reference) => path.basename(reference.file) === "math.scss")).toBe(false);
      expect(divRefs.references.some((reference) => path.basename(reference.file) === "other.scss")).toBe(false);
    }

    const extendSource = await fsp.readFile(path.join(basic, "extend.scss"), "utf8");
    const extendUse = modulePosition(extendSource, "ph");
    const fromExtend = await goToDefinition(index, { file: path.join(basic, "extend.scss"), ...extendUse });
    expect(fromExtend.status).toBe("ok");
    if (fromExtend.status === "ok") {
      expect(path.basename(fromExtend.definition.file)).toBe("_colors.scss");
      expect(fromExtend.definition.localName).toBe("ph");
    }
  });

  it.runIf(isNativeTreeSitterAvailable())("applies @forward prefix, show, and hide", async () => {
    const index = await buildProjectIndex(forward, { cache: "off" });
    const sourceFile = path.join(forward, "_source.scss");
    const source = await fsp.readFile(sourceFile, "utf8");
    const pad = modulePosition(source, "pad");
    const refs = await findReferences(index, { file: sourceFile, ...pad });
    expect(refs.status).toBe("ok");
    if (refs.status !== "ok") return;
    expect(refs.referenceCoverage?.state).toBe("complete");
    expect(refKeys(forward, refs.references)).toEqual(
      ["_source.scss:2", "agg.scss:1", "user.scss:5", "hider.scss:1"].sort(),
    );

    const skip = modulePosition(source, "skip");
    const skipRefs = await findReferences(index, { file: sourceFile, ...skip });
    expect(skipRefs.status).toBe("ok");
    if (skipRefs.status === "ok") {
      expect(refKeys(forward, skipRefs.references)).toEqual(["_source.scss:5", "hide-user.scss:4"].sort());
    }

    const user = await fsp.readFile(path.join(forward, "user.scss"), "utf8");
    const ink = modulePosition(user, "$theme-ink");
    const fromInk = await goToDefinition(index, { file: path.join(forward, "user.scss"), ...ink });
    expect(fromInk.status).toBe("ok");
    if (fromInk.status === "ok") expect(fromInk.definition.localName).toBe("$ink");
  });

  it.runIf(isNativeTreeSitterAvailable())(
    "reports partial coverage for an unresolved URL and meta.load-css",
    async () => {
      const urlRoot = path.resolve("tests/samples/scss-modules/partial-url");
      const urlIndex = await buildProjectIndex(urlRoot, { cache: "off" });
      const urlFile = path.join(urlRoot, "_colors.scss");
      const urlSource = await fsp.readFile(urlFile, "utf8");
      const urlPrimary = await findReferences(urlIndex, { file: urlFile, ...modulePosition(urlSource, "$primary") });
      expect(urlPrimary.status).toBe("ok");
      if (urlPrimary.status === "ok") {
        expect(urlPrimary.referenceCoverage?.state).toBe("partial");
        expect(urlPrimary.referenceCoverage?.reasons).toContain("strategy_unavailable");
        expect(urlPrimary.references.some((reference) => path.basename(reference.file) === "user.scss")).toBe(true);
      }

      const metaRoot = path.resolve("tests/samples/scss-modules/partial-meta");
      const metaIndex = await buildProjectIndex(metaRoot, { cache: "off" });
      const metaFile = path.join(metaRoot, "_colors.scss");
      const metaSource = await fsp.readFile(metaFile, "utf8");
      const metaRefs = await findReferences(metaIndex, { file: metaFile, ...modulePosition(metaSource, "$primary") });
      expect(metaRefs.status).toBe("ok");
      if (metaRefs.status === "ok") {
        expect(metaRefs.referenceCoverage?.state).toBe("partial");
        expect(metaRefs.referenceCoverage?.reasons).toContain("strategy_unavailable");
      }
    },
  );

  it.runIf(isNativeTreeSitterAvailable())(
    "renames only the member and collides on a visible same-kind name",
    async () => {
      const session = createAgentSession({ root: basic, freshness: { policy: "check" } });
      const symbols = await workspaceSymbolsWithSession(session, { root: basic, query: "$primary" });
      const primary = symbols.symbols.find(
        (symbol) => symbol.name === "$primary" && symbol.location.file.endsWith("_colors.scss"),
      );
      expect(primary).toBeDefined();
      const renamed = await previewRenameWithSession(session, {
        root: basic,
        handle: primary!.handle,
        newName: "$accent",
      });
      expect(renamed.safe).toBe(true);
      expect(renamed.edits.map((edit) => edit.oldText).every((text) => text === "$primary")).toBe(true);
      expect(renamed.edits.map((edit) => edit.newText).every((text) => text === "$accent")).toBe(true);
      expect(renamed.edits.map((edit) => path.basename(edit.file)).sort()).toEqual(
        [
          "_colors.scss",
          "_colors.scss",
          "_colors.scss",
          "_colors.scss",
          "legacy.scss",
          "main.scss",
          "star.scss",
          "with.scss",
        ].sort(),
      );
      const mainEdit = renamed.edits.find((edit) => edit.file.endsWith("main.scss"));
      const mainSource = await fsp.readFile(path.join(basic, "main.scss"), "utf8");
      const mainLine = mainSource.split("\n")[mainEdit!.range.start.line - 1] ?? "";
      expect(mainLine[mainEdit!.range.start.column - 2]).toBe(".");
      expect(
        mainLine.slice(mainEdit!.range.start.column - 1, mainEdit!.range.start.column - 1 + mainEdit!.oldText.length),
      ).toBe("$primary");

      const collision = await previewRenameWithSession(session, {
        root: basic,
        handle: primary!.handle,
        newName: "$primary-color",
      });
      expect(collision.safe).toBe(false);
      expect(collision.conflicts.some((conflict) => conflict.reason === "name_collision")).toBe(true);

      const forwardSession = createAgentSession({ root: forward, freshness: { policy: "check" } });
      const mixins = await workspaceSymbolsWithSession(forwardSession, { root: forward, query: "pad" });
      const pad = mixins.symbols.find(
        (symbol) => symbol.name === "pad" && symbol.location.file.endsWith("_source.scss"),
      );
      const mixinRename = await previewRenameWithSession(forwardSession, {
        root: forward,
        handle: pad!.handle,
        newName: "inset",
      });
      expect(mixinRename.safe).toBe(true);
      expect(mixinRename.edits.every((edit) => edit.oldText === "pad" && edit.newText === "inset")).toBe(true);
      const userEdit = mixinRename.edits.find((edit) => edit.file.endsWith("user.scss"));
      const userSource = await fsp.readFile(path.join(forward, "user.scss"), "utf8");
      const userLine = userSource.split("\n")[userEdit!.range.start.line - 1] ?? "";
      expect(userLine.slice(userEdit!.range.start.column - 1 - "theme-".length, userEdit!.range.start.column - 1)).toBe(
        "theme-",
      );
      expect(mixinRename.edits.some((edit) => edit.file.endsWith("hide-user.scss"))).toBe(false);
      // The `show` entry (`theme-pad`) and the `hide` entry (`pad`) name the mixin too.
      expect(mixinRename.edits.map((edit) => path.basename(edit.file)).sort()).toEqual([
        "_source.scss",
        "agg.scss",
        "hider.scss",
        "user.scss",
      ]);
    },
  );
});

type ScssProject = {
  root: string;
  index: ProjectIndex;
  relative: (file: string) => string;
  position: (
    name: string,
    needle: string,
    occurrence?: number,
    delta?: number,
  ) => { file: string; line: number; column: number };
};

async function withScssProject(
  files: Record<string, string>,
  run: (project: ScssProject) => Promise<void>,
): Promise<void> {
  const root = (await fsp.mkdtemp(path.join(os.tmpdir(), "cg-scss-module-"))).replace(/\\/g, "/");
  try {
    for (const [name, text] of Object.entries(files)) {
      const target = path.join(root, name);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, text, "utf8");
    }
    const index = await buildProjectIndex(root, { cache: "off" });
    await run({
      root,
      index,
      relative: (file) => path.relative(root, file).replace(/\\/g, "/"),
      position: (name, needle, occurrence = 0, delta = 0) => {
        const text = files[name];
        if (text === undefined) throw new Error(`Missing fixture file ${name}`);
        const found = modulePosition(text, needle, occurrence);
        return { file: `${root}/${name}`, line: found.line, column: found.column + delta };
      },
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

/** `file:line` of the definition a position resolves to, or the failure status. */
async function scssGoto(
  project: ScssProject,
  name: string,
  needle: string,
  occurrence = 0,
  delta = 0,
): Promise<string> {
  const result = await goToDefinition(project.index, project.position(name, needle, occurrence, delta));
  if (result.status !== "ok") return result.status;
  return `${project.relative(result.definition.file)}:${result.definition.range.start.line}`;
}

async function scssRefs(project: ScssProject, name: string, needle: string, occurrence = 0, delta = 0) {
  const result = await findReferences(project.index, project.position(name, needle, occurrence, delta));
  if (result.status !== "ok") throw new Error(`findReferences did not resolve: ${result.reason}`);
  const sites = result.references
    .map((reference) => `${project.relative(reference.file)}:${reference.range.start.line}`)
    .sort();
  return { sites, coverage: result.referenceCoverage };
}

async function previewScssRename(
  project: ScssProject,
  name: string,
  inFile: string,
  newName: string,
  options: { includeComments?: boolean } = {},
) {
  const session = createAgentSession({ root: project.root, freshness: { policy: "check" } });
  try {
    const symbols = await workspaceSymbolsWithSession(session, { root: project.root, query: name });
    const target = symbols.symbols.find((symbol) => symbol.name === name && symbol.location.file.endsWith(inFile));
    if (!target) throw new Error(`Missing symbol ${name} in ${inFile}`);
    return await previewRenameWithSession(session, { root: project.root, handle: target.handle, newName, ...options });
  } finally {
    session.invalidate();
  }
}

describe("SCSS module navigation: lexing, scopes, forwards, imports, and coverage", () => {
  const native = isNativeTreeSitterAvailable();

  it.runIf(native)("keeps declarations that follow an apostrophe in a // comment", async () => {
    await withScssProject(
      {
        "_colors.scss":
          "// Bootstrap's palette: an apostrophe in a line comment opens no string\n$primary: red;\n$later: blue;\n.swatch { color: $primary; }\n",
        "main.scss":
          '// don\'t edit by hand\n@use "colors";\n.a { color: colors.$primary; border-color: colors.$later; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "$later")).toBe("_colors.scss:3");
        const primary = await scssRefs(project, "_colors.scss", "$primary");
        expect(primary.sites).toEqual(["_colors.scss:2", "_colors.scss:4", "main.scss:3"]);
        expect(primary.coverage?.state).toBe("complete");
      },
    );
  });

  it.runIf(native)("reads an unquoted url(http://...) as one token that hides no later declaration", async () => {
    await withScssProject(
      {
        "_theme.scss": ".a { background: url(http://example.com/a.png); }\n$later: 1px;\n",
        "main.scss": '@use "theme";\n.b { width: theme.$later; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "$later")).toBe("_theme.scss:2");
      },
    );
  });

  it("scans an unquoted url(...) as one token, whatever quote or comment opener it holds", () => {
    const facts = extractScssFacts(
      ".a { b: url(a/*b.png); c: url(//cdn.example.com/x.png); d: url( data:image/png;base64,AA//BB== ); }\n$later: 1px;\n.e { w: $later; }\n",
    );
    expect(facts.declarations.map((declaration) => declaration.name)).toEqual(["$later"]);
    expect(facts.uses.map((use) => use.text)).toEqual(["$later"]);
  });

  it("reads only a quoted Sass import as a load, and leaves every plain CSS import form out", () => {
    const facts = extractScssFacts(
      [
        '@import "a", "b";',
        "@import url(plain.css);",
        '@import "plain.css";',
        '@import "//cdn.example.com/x";',
        '@import "https://fonts.example.com/css";',
        '@import "media" screen and (min-width: 40em);',
        '@import "dynamic-#{$name}";',
        '@import "last";',
        "",
      ].join("\n"),
    );
    expect(facts.loads.map((load) => `${load.kind}:${load.url}`)).toEqual(["import:a", "import:b", "import:last"]);
  });

  it.runIf(native)(
    "does not treat parameters, loop variables, using parameters, or keyword names as module members",
    async () => {
      const vars = [
        "$size: 1px;",
        "$gap: 2px;",
        "$primary: red;",
        "@mixin box($w, $size: 2px, $gap: $size) {",
        "  width: $w;",
        "  height: $size;",
        "  margin: $gap;",
        "}",
        "@function dbl($size) {",
        "  @return $size * 2;",
        "}",
        "@mixin wrap($n) {",
        "  @content($n);",
        "}",
        "",
      ].join("\n");
      const star = [
        '@use "vars" as *;',
        ".a {",
        "  @include box(1px, $size: 3px);",
        "  width: $size;",
        "  height: dbl($size: 2);",
        "  @each $primary in red, blue {",
        "    color: $primary;",
        "  }",
        "  @for $gap from 1 through 2 {",
        "    margin: $gap;",
        "  }",
        "  @include wrap(1) using ($gap) {",
        "    padding: $gap;",
        "  }",
        "}",
        "",
      ].join("\n");
      await withScssProject({ "_vars.scss": vars, "star.scss": star }, async (project) => {
        // Only the plain use on line 4 of star.scss names the module variable.
        expect(await scssGoto(project, "star.scss", "width: $size", 0, "width: ".length)).toBe("_vars.scss:1");
        const size = await scssRefs(project, "_vars.scss", "$size");
        expect(size.sites).toEqual(["_vars.scss:1", "star.scss:4"]);
        expect(size.coverage?.state).toBe("complete");
        expect((await scssRefs(project, "_vars.scss", "$gap")).sites).toEqual(["_vars.scss:2"]);
        expect((await scssRefs(project, "_vars.scss", "$primary")).sites).toEqual(["_vars.scss:3"]);

        const moduleLevel = ["_vars.scss:1", "_vars.scss:2", "_vars.scss:3"];
        const localSites: Array<[string, string, number]> = [
          ["star.scss", "color: $primary", "color: ".length],
          ["star.scss", "margin: $gap", "margin: ".length],
          ["star.scss", "padding: $gap", "padding: ".length],
          ["star.scss", "$size: 3px", 0],
          ["star.scss", "($size: 2", 1],
          ["_vars.scss", "$gap: $size", "$gap: ".length],
          ["_vars.scss", "height: $size", "height: ".length],
          ["_vars.scss", "margin: $gap", "margin: ".length],
          ["_vars.scss", "@return $size", "@return ".length],
        ];
        for (const [name, needle, delta] of localSites) {
          expect(moduleLevel, `${name} ${needle}`).not.toContain(await scssGoto(project, name, needle, 0, delta));
        }

        const renamed = await previewScssRename(project, "$size", "_vars.scss", "$extent");
        expect(renamed.safe).toBe(true);
        expect(renamed.edits.map((edit) => `${edit.file}:${edit.range.start.line}`).sort()).toEqual([
          "_vars.scss:1",
          "star.scss:4",
        ]);
      });
    },
  );

  it.runIf(native)("treats repeated top-level assignments of one name as one variable", async () => {
    await withScssProject(
      {
        "_theme.scss": "$accent: 10px !default;\n$accent: $accent * 2;\n",
        "main.scss": '@use "theme";\n.a { width: theme.$accent; }\n',
        "local.scss": "$z: 1px !default;\n$z: $z * 2;\n.b { width: $z; }\n",
      },
      async (project) => {
        expect(await scssGoto(project, "local.scss", "$z; }")).toBe("local.scss:1");
        expect(await scssGoto(project, "local.scss", "$z * 2")).toBe("local.scss:1");
        const union = ["local.scss:1", "local.scss:2", "local.scss:2", "local.scss:3"];
        const fromFirst = await scssRefs(project, "local.scss", "$z");
        const fromSecond = await scssRefs(project, "local.scss", "$z: $z");
        expect(fromFirst.sites).toEqual(union);
        expect(fromSecond.sites).toEqual(union);
        expect(fromFirst.coverage?.state).toBe("complete");
        expect(fromSecond.coverage?.state).toBe("complete");

        expect(await scssGoto(project, "main.scss", "$accent")).toBe("_theme.scss:1");
        const crossFile = await scssRefs(project, "_theme.scss", "$accent: $accent");
        expect(crossFile.sites).toEqual(["_theme.scss:1", "_theme.scss:2", "_theme.scss:2", "main.scss:2"]);
        expect(crossFile.coverage?.state).toBe("complete");

        const renamed = await previewScssRename(project, "$accent", "_theme.scss", "$tone");
        expect(renamed.safe).toBe(true);
        expect(renamed.edits.map((edit) => `${edit.file}:${edit.range.start.line}`).sort()).toEqual([
          "_theme.scss:1",
          "_theme.scss:2",
          "_theme.scss:2",
          "main.scss:2",
        ]);
      },
    );
  });

  it.runIf(native)("keeps an assignment inside a top-level @if on the file variable", async () => {
    const main = [
      "$z: 1px;",
      "@if true {",
      "  $z: 2px;",
      "  .a { width: $z; }",
      "}",
      ".b { width: $z; }",
      ".c {",
      "  $z: 3px;",
      "  margin: $z;",
      "}",
      "",
    ].join("\n");
    await withScssProject({ "main.scss": main }, async (project) => {
      const refs = await scssRefs(project, "main.scss", "$z");
      // A variable assigned inside a style rule is a new local; the @if block shares the file scope.
      expect(refs.sites).toEqual(["main.scss:1", "main.scss:3", "main.scss:4", "main.scss:6"]);
    });
  });

  it.runIf(native)("compares forward show and hide lists with the exposed names", async () => {
    await withScssProject(
      {
        "_s.scss": "$pad: 1px;\n@mixin pad { padding: $pad; }\n",
        "agg.scss": '@forward "s" show pad;\n',
        "m.scss": '@use "agg";\n.a { @include agg.pad; }\n',
        "pre.scss": '@forward "s" as t-* hide $pad;\n',
        "m2.scss": '@use "pre";\n.a { b: pre.$t-pad; }\n',
      },
      async (project) => {
        // A bare `show pad` names the mixin, never the variable `$pad`.
        const mixin = await scssRefs(project, "_s.scss", "@mixin pad", 0, "@mixin ".length);
        expect(mixin.sites).toEqual(["_s.scss:2", "agg.scss:1", "m.scss:2"]);
        // `hide $pad` under the prefix `t-` compares `$t-pad`, so it hides nothing.
        const variable = await scssRefs(project, "_s.scss", "$pad");
        expect(variable.sites).toEqual(["_s.scss:1", "_s.scss:2", "m2.scss:2"]);
        expect(await scssGoto(project, "m2.scss", "$t-pad")).toBe("_s.scss:1");
      },
    );
  });

  it.runIf(native)("does not resolve a name that show or hide removed from the module", async () => {
    // dart-sass rejects every use below. The lookup must miss instead of reaching the removed member.
    await withScssProject(
      {
        "_s.scss": "$pad: 1px;\n@mixin pad { padding: $pad; }\n@mixin skip { margin: 0; }\n",
        "agg.scss": '@forward "s" show pad;\n',
        "hider.scss": '@forward "s" hide skip;\n',
        "m.scss": '@use "agg";\n@use "hider";\n.a { b: agg.$pad; @include hider.skip; @include agg.skip; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "m.scss", "agg.$pad", 0, "agg.".length)).toBe("not_found");
        expect(await scssGoto(project, "m.scss", "hider.skip", 0, "hider.".length)).toBe("not_found");
        expect(await scssGoto(project, "m.scss", "agg.skip", 0, "agg.".length)).toBe("not_found");
      },
    );
  });

  it.runIf(native)("sees through @import of a forwarder and @use of an importer, without privacy", async () => {
    await withScssProject(
      {
        "_a.scss": "$x: 1px;\n$-secret: 2px;\n@mixin pad { padding: 1px; }\n",
        "_fwd.scss": '@forward "a";\n',
        "legacy.scss": '@import "fwd";\n.o { width: $x; @include pad; }\n',
        "_base.scss": "$bvar: 1px;\n",
        "_imp.scss": '@import "base";\n',
        "use-imp.scss": '@use "imp" as c;\n.b { width: c.$bvar; }\n',
        "legacy2.scss": '@import "a";\n.p { width: $-secret; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "legacy.scss", "$x")).toBe("_a.scss:1");
        expect(await scssGoto(project, "legacy.scss", "pad")).toBe("_a.scss:3");
        expect(await scssGoto(project, "use-imp.scss", "$bvar")).toBe("_base.scss:1");
        expect(await scssGoto(project, "legacy2.scss", "$-secret")).toBe("_a.scss:2");
        const x = await scssRefs(project, "_a.scss", "$x");
        expect(x.sites).toEqual(["_a.scss:1", "legacy.scss:2"]);
        expect(x.coverage?.state).toBe("complete");
        const secret = await scssRefs(project, "_a.scss", "$-secret");
        expect(secret.sites).toEqual(["_a.scss:2", "legacy2.scss:2"]);
      },
    );
    // dart-sass rejects this program: a member whose name starts with `-` is private to its module.
    await withScssProject(
      {
        "_a.scss": "$-secret: 2px;\n",
        "private.scss": '@use "a";\n.p { width: a.$-secret; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "private.scss", "$-secret")).toBe("not_found");
      },
    );
  });

  it.runIf(native)("resolves a directory index module and counts its consumers", async () => {
    await withScssProject(
      {
        "lib/_index.scss": "$primary: red;\n",
        "main.scss": '@use "lib";\n.a { color: lib.$primary; }\n',
        "rel.scss": '@use "./lib";\n.b { color: lib.$primary; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "$primary")).toBe("lib/_index.scss:1");
        const refs = await scssRefs(project, "lib/_index.scss", "$primary");
        expect(refs.sites).toEqual(["lib/_index.scss:1", "main.scss:2", "rel.scss:2"]);
        expect(refs.coverage?.state).toBe("complete");
      },
    );
  });

  it.runIf(native)("reports partial coverage when a Vue or Svelte style block may load the module", async () => {
    await withScssProject(
      {
        "_colors.scss": "$primary: red;\n",
        "main.scss": '@use "colors";\n.a { color: colors.$primary; }\n',
        "Comp.vue":
          '<template><div /></template>\n<style lang="scss">\n@use "./colors";\n.a { color: colors.$primary; }\n</style>\n',
        "Widget.svelte":
          '<div />\n<style lang="scss">\n  @use "./colors";\n  div { color: colors.$primary; }\n</style>\n',
      },
      async (project) => {
        const refs = await scssRefs(project, "_colors.scss", "$primary");
        expect(refs.sites).toContain("main.scss:2");
        expect(refs.coverage?.state).toBe("partial");
        expect(refs.coverage?.reasons).toContain("strategy_unavailable");
        expect(refs.coverage?.affectedFiles?.map((file) => project.relative(file)).sort()).toEqual([
          "Comp.vue",
          "Widget.svelte",
        ]);
      },
    );
  });

  it.runIf(native)("does not count a plain CSS @import as an unresolved Sass load", async () => {
    await withScssProject(
      {
        "_colors.scss": "$primary: red;\n",
        "css.scss":
          '@use "colors";\n@import url(foo.css);\n@import "foo.css";\n@import "https://fonts.example.com/css";\n@import "print" print;\n.a { color: colors.$primary; }\n',
      },
      async (project) => {
        const refs = await scssRefs(project, "_colors.scss", "$primary");
        expect(refs.sites).toEqual(["_colors.scss:1", "css.scss:6"]);
        expect(refs.coverage?.state).toBe("complete");
      },
    );
  });

  it.runIf(native)("does not count selector, unit, or file-name text as a module member use", async () => {
    await withScssProject(
      {
        "_button.scss": "@mixin primary { color: red; }\n",
        "main.scss": '@use "button";\nbutton.primary { color: blue; }\n.x { @include button.primary; width: 1.5em; }\n',
      },
      async (project) => {
        const refs = await scssRefs(project, "_button.scss", "primary");
        expect(refs.sites).toEqual(["_button.scss:1", "main.scss:3"]);
      },
    );
  });

  it.runIf(native)("resolves every target of an @extend list", async () => {
    await withScssProject(
      {
        "_base.scss": "%a { color: red; }\n%b { color: blue; }\n",
        "ext.scss": '@use "base";\n.x { @extend %a, %b; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "ext.scss", "%a", 0, 1)).toBe("_base.scss:1");
        expect(await scssGoto(project, "ext.scss", "%b", 0, 1)).toBe("_base.scss:2");
        const refs = await scssRefs(project, "_base.scss", "%b", 0, 1);
        expect(refs.sites).toEqual(["_base.scss:2", "ext.scss:2"]);
      },
    );
  });

  it.runIf(native)("records a !global declaration inside a block as a module member", async () => {
    await withScssProject(
      {
        "_c.scss": "@mixin init { $made: 1px !global; }\n@include init;\n",
        "glob.scss": '@use "c";\n.a { w: c.$made; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "glob.scss", "$made")).toBe("_c.scss:1");
      },
    );
  });

  it.runIf(native)("compares @use namespaces as written", async () => {
    // dart-sass rejects bad.scss: the namespaces `my_lib` and `my-lib` differ.
    await withScssProject(
      {
        "_my_lib.scss": "$x: 1px;\n",
        "ns.scss": '@use "my_lib";\n.a { w: my_lib.$x; }\n',
        "bad.scss": '@use "my_lib";\n.a { w: my-lib.$x; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "ns.scss", "$x")).toBe("_my_lib.scss:1");
        expect(await scssGoto(project, "bad.scss", "$x")).toBe("not_found");
      },
    );
  });

  it.runIf(native)("reports a name collision with a member that a scope seeing the renamed one declares", async () => {
    const colors = "$primary: red;\n$-secret: blue;\n$primary-color: green;\n";
    await withScssProject(
      {
        "_colors.scss": colors,
        "_other.scss": "$accent: blue;\n",
        "star.scss": '@use "colors" as *;\n@use "other" as *;\n.a { color: $primary; }\n',
      },
      async (project) => {
        // Two `as *` modules share one scope in star.scss.
        const collides = await previewScssRename(project, "$primary", "_colors.scss", "$accent");
        expect(collides.safe).toBe(false);
        expect(collides.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`)).toEqual([
          "name_collision:_other.scss",
        ]);
        const free = await previewScssRename(project, "$primary", "_colors.scss", "$tone");
        expect(free.safe).toBe(true);
        expect(free.conflicts).toEqual([]);
      },
    );
    await withScssProject(
      {
        "_colors.scss": colors,
        "_other.scss": "$accent: blue;\n",
        "legacy.scss": '@import "colors";\n@import "other";\n.a { color: $primary; }\n',
      },
      async (project) => {
        // @import merges both files into the global scope of legacy.scss.
        const collides = await previewScssRename(project, "$primary", "_colors.scss", "$accent");
        expect(collides.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`)).toEqual([
          "name_collision:_other.scss",
        ]);
      },
    );
    await withScssProject(
      {
        "_x.scss": "$x: 1px;\n",
        "_y.scss": "$y: 2px;\n",
        "agg.scss": '@forward "x";\n@forward "y";\n',
        "m.scss": '@use "agg";\n.a { w: agg.$x; }\n',
      },
      async (project) => {
        // The module agg.scss exposes both `$x` and `$y`, so the renamed `$x` would collide in it.
        const collides = await previewScssRename(project, "$x", "_x.scss", "$y");
        expect(collides.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`)).toEqual([
          "name_collision:_y.scss",
        ]);
        expect((await previewScssRename(project, "$x", "_x.scss", "$z")).safe).toBe(true);
      },
    );
    await withScssProject(
      { "_colors.scss": colors, "main.scss": '@use "colors";\n.a { color: colors.$primary; }\n' },
      async (project) => {
        // A private member of the declaring file and an equal spelling (`_` is `-`) both collide. A
        // private new name also hides the member from main.scss, which reads it through `@use`.
        const privateName = await previewScssRename(project, "$primary", "_colors.scss", "$-secret");
        expect(privateName.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`)).toEqual([
          "name_collision:_colors.scss",
          "invalid_identifier:main.scss",
        ]);
        const sameSpelling = await previewScssRename(project, "$primary", "_colors.scss", "$primary_color");
        expect(sameSpelling.conflicts.map((conflict) => conflict.reason)).toEqual(["name_collision"]);
      },
    );
  });

  it.runIf(native)("reports a local variable that would capture a renamed reference", async () => {
    await withScssProject(
      {
        "_colors.scss": "$primary: red;\n",
        "cap.scss":
          '@use "colors" as *;\n@mixin tint($gap) {\n  color: $primary;\n  margin: $gap;\n}\n.b { @include tint(1px); }\n',
      },
      async (project) => {
        const captured = await previewScssRename(project, "$primary", "_colors.scss", "$gap");
        expect(captured.safe).toBe(false);
        expect(captured.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`)).toEqual([
          "shadowing:cap.scss",
        ]);
        const free = await previewScssRename(project, "$primary", "_colors.scss", "$tone");
        expect(free.safe).toBe(true);
      },
    );
  });

  it.runIf(native)("keeps the scope collision check for a variable declared in a block", async () => {
    await withScssProject({ "m.scss": ".a { $x: 1px; $y: 2px; w: $x; }\n" }, async (project) => {
      // A block-level variable is no module member, so the generic scope check still applies.
      const collides = await previewScssRename(project, "$x", "m.scss", "$y");
      expect(collides.safe).toBe(false);
      expect(collides.conflicts.map((conflict) => conflict.reason)).toEqual(["name_collision"]);
      expect((await previewScssRename(project, "$x", "m.scss", "$z")).safe).toBe(true);
    });
  });

  it("extracts facts from a large file in linear time", () => {
    const lines: string[] = [];
    for (let index = 0; index < 4000; index += 1) {
      lines.push(
        `$var-${index}: ${index}px;`,
        `@mixin m${index}($a, $b: 1px, $c: $var-${index}) {`,
        "  width: $a; height: $b; margin: $c;",
        "}",
      );
    }
    const started = performance.now();
    const facts = extractScssFacts(lines.join("\n"));
    const elapsed = performance.now() - started;
    expect(facts.declarations).toHaveLength(8000);
    expect(elapsed).toBeLessThan(2000);
  });

  it.runIf(native)("finds references in a large module with many same-kind uses quickly", async () => {
    const declarations = 2000;
    const consumers = 8;
    const files: Record<string, string> = {
      "_vars.scss": `${Array.from({ length: declarations }, (_, index) => `$v${index}: ${index}px;`).join("\n")}\n`,
    };
    for (let consumer = 0; consumer < consumers; consumer += 1) {
      const uses = Array.from({ length: declarations }, (_, index) => `.c${index} { width: $v${index}; }`).join("\n");
      files[`consumer${consumer}.scss`] = `@use "vars" as *;\n${uses}\n`;
    }
    await withScssProject(files, async (project) => {
      const started = performance.now();
      const refs = await scssRefs(project, "_vars.scss", "$v5:");
      const elapsed = performance.now() - started;
      expect(refs.sites).toHaveLength(consumers + 1);
      expect(refs.coverage?.state).toBe("complete");
      expect(elapsed).toBeLessThan(4000);
    });
  });

  it.runIf(native)("builds the module model for hundreds of files without a graph scan per load", async () => {
    const files: Record<string, string> = {};
    for (let file = 0; file < 400; file += 1) {
      const loads: string[] = [];
      for (let back = 1; back <= 4 && back <= file; back += 1) loads.push(`@use "f${file - back}" as f${file - back};`);
      files[`_f${file}.scss`] = `${loads.join("\n")}\n$v${file}: ${file}px;\n`.replace(/^\n/, "");
    }
    files["main.scss"] = '@use "f399";\n.a { width: f399.$v399; }\n';
    await withScssProject(files, async (project) => {
      const started = performance.now();
      expect(await scssGoto(project, "main.scss", "$v399")).toBe("_f399.scss:5");
      expect(performance.now() - started).toBeLessThan(3000);
    });
  });
});

describe("SCSS module navigation: review follow-ups", () => {
  const native = isNativeTreeSitterAvailable();

  function lineOf(source: string, offset: number): number {
    return source.slice(0, offset).split("\n").length;
  }

  it.runIf(native)("reports a conflict when a private new name hides a member from @use and @forward", async () => {
    // dart-sass rejects `colors.$-accent`, `$-accent` through `as *`, and `f.$-accent` through
    // `@forward`: a name that starts with `-` or `_` is private to its module.
    const colors = "$primary: red;\n";
    const rejected: Array<[string, Record<string, string>, string]> = [
      [
        "namespace",
        { "_colors.scss": colors, "main.scss": '@use "colors";\n.a { color: colors.$primary; }\n' },
        "$-accent",
      ],
      ["star", { "_colors.scss": colors, "main.scss": '@use "colors" as *;\n.a { color: $primary; }\n' }, "$-accent"],
      [
        "underscore",
        { "_colors.scss": colors, "main.scss": '@use "colors";\n.a { color: colors.$primary; }\n' },
        "$_accent",
      ],
      [
        "forward",
        {
          "_colors.scss": colors,
          "_f.scss": '@forward "colors";\n',
          "main.scss": '@use "f";\n.a { color: f.$primary; }\n',
        },
        "$-accent",
      ],
    ];
    for (const [label, files, newName] of rejected) {
      await withScssProject(files, async (project) => {
        const renamed = await previewScssRename(project, "$primary", "_colors.scss", newName);
        expect(renamed.safe, label).toBe(false);
        expect(
          renamed.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`),
          label,
        ).toEqual(["invalid_identifier:main.scss"]);
      });
    }
    // The declaring file, `@import` (which has no privacy), and a `with` key keep access.
    const accepted: Array<[string, Record<string, string>]> = [
      ["same file", { "_colors.scss": "$primary: red;\n.a { color: $primary; }\n" }],
      ["legacy import", { "_colors.scss": colors, "main.scss": '@import "colors";\n.a { color: $primary; }\n' }],
      [
        "import chain",
        {
          "_colors.scss": colors,
          "_i.scss": '@import "colors";\n',
          "main.scss": '@import "i";\n.a { color: $primary; }\n',
        },
      ],
      [
        "configuration",
        {
          "_colors.scss": "$primary: red !default;\n.x { w: $primary; }\n",
          "main.scss": '@use "colors" with ($primary: blue);\n',
        },
      ],
    ];
    for (const [label, files] of accepted) {
      await withScssProject(files, async (project) => {
        const renamed = await previewScssRename(project, "$primary", "_colors.scss", "$-accent");
        expect(renamed.conflicts, label).toEqual([]);
        expect(renamed.safe, label).toBe(true);
      });
    }
  });

  it.runIf(native)("applies the privacy rule to placeholders too", async () => {
    // dart-sass: `@extend %-pub` fails through `@use` ("The target selector was not found") and works
    // through `@import`.
    const base = "%pub { color: red; }\n";
    await withScssProject(
      { "_base.scss": base, "main.scss": '@use "base";\n.a { @extend %pub; }\n' },
      async (project) => {
        const renamed = await previewScssRename(project, "pub", "_base.scss", "-pub");
        expect(renamed.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`)).toEqual([
          "invalid_identifier:main.scss",
        ]);
      },
    );
    await withScssProject(
      { "_base.scss": base, "main.scss": '@import "base";\n.a { @extend %pub; }\n' },
      async (project) => {
        expect((await previewScssRename(project, "pub", "_base.scss", "-pub")).conflicts).toEqual([]);
      },
    );
  });

  it.runIf(native)("resolves what a partial reads from the file that @imports it", async () => {
    // dart-sass runs an imported partial inside the scope of its importer: the `$primary` below is
    // the variable of main.scss, though _buttons.scss loads nothing.
    await withScssProject(
      {
        "main.scss": '$primary: red;\n@import "buttons";\n',
        "_buttons.scss": ".btn { color: $primary; }\n",
      },
      async (project) => {
        expect(await scssGoto(project, "_buttons.scss", "$primary")).toBe("main.scss:1");
        const refs = await scssRefs(project, "main.scss", "$primary");
        expect(refs.sites).toEqual(["_buttons.scss:1", "main.scss:1"]);
        expect(refs.coverage?.state).toBe("complete");
        const renamed = await previewScssRename(project, "$primary", "main.scss", "$accent");
        expect(renamed.edits.map((edit) => `${edit.file}:${edit.range.start.line}`).sort()).toEqual([
          "_buttons.scss:1",
          "main.scss:1",
        ]);
      },
    );
    // Siblings: what an earlier `@import` brought in is visible to the later partials, whatever the
    // kind of member, and a partial inherits the importer's `@use` namespaces as well.
    await withScssProject(
      {
        "_vars.scss":
          "$primary: red;\n@mixin pad { padding: 1px; }\n@function dbl($n) { @return $n * 2; }\n%card { margin: 0; }\n",
        "_buttons.scss": ".btn { color: $primary; @include pad; width: dbl(2px); @extend %card; }\n",
        "main.scss": '@import "vars";\n@import "buttons";\n',
      },
      async (project) => {
        expect(await scssGoto(project, "_buttons.scss", "$primary")).toBe("_vars.scss:1");
        expect(await scssGoto(project, "_buttons.scss", "pad")).toBe("_vars.scss:2");
        expect(await scssGoto(project, "_buttons.scss", "dbl")).toBe("_vars.scss:3");
        expect(await scssGoto(project, "_buttons.scss", "%card", 0, 1)).toBe("_vars.scss:4");
        const refs = await scssRefs(project, "_vars.scss", "$primary");
        expect(refs.sites).toEqual(["_buttons.scss:1", "_vars.scss:1"]);
        expect(refs.coverage?.state).toBe("complete");
      },
    );
    await withScssProject(
      {
        "_vars.scss": "$primary: red;\n",
        "_buttons.scss": ".btn { color: vars.$primary; }\n",
        "main.scss": '@use "vars";\n@import "buttons";\n',
      },
      async (project) => {
        expect(await scssGoto(project, "_buttons.scss", "$primary")).toBe("_vars.scss:1");
        expect((await scssRefs(project, "_vars.scss", "$primary")).sites).toEqual(["_buttons.scss:1", "_vars.scss:1"]);
      },
    );
  });

  it.runIf(native)("keeps the inherited scope to @import, and to what the importers prove", async () => {
    // `@use` runs the file in its own scope: dart-sass reports an undefined variable.
    await withScssProject(
      { "main.scss": '$primary: red;\n@use "buttons";\n', "_buttons.scss": ".btn { color: $primary; }\n" },
      async (project) => {
        expect(await scssGoto(project, "_buttons.scss", "$primary")).toBe("not_found");
        expect((await scssRefs(project, "main.scss", "$primary")).sites).toEqual(["main.scss:1"]);
      },
    );
    // Two importers that define the name differently: the partial belongs to both, so go-to-definition
    // stays unresolved and each variable reports the partial as not proved.
    await withScssProject(
      {
        "_buttons.scss": ".btn { color: $primary; }\n",
        "m1.scss": '$primary: red;\n@import "buttons";\n',
        "m2.scss": '$primary: blue;\n@import "buttons";\n',
      },
      async (project) => {
        expect(await scssGoto(project, "_buttons.scss", "$primary")).toBe("not_found");
        const refs = await scssRefs(project, "m1.scss", "$primary");
        expect(refs.sites).toEqual(["m1.scss:1"]);
        expect(refs.coverage?.state).toBe("partial");
        expect(refs.coverage?.affectedFiles?.map((file) => project.relative(file))).toEqual(["_buttons.scss"]);
      },
    );
    // One importer defines it and the other does not: the definition is still unique.
    await withScssProject(
      {
        "_buttons.scss": ".btn { color: $primary; }\n",
        "m1.scss": '$primary: red;\n@import "buttons";\n',
        "m2.scss": '$other: blue;\n@import "buttons";\n',
      },
      async (project) => {
        expect(await scssGoto(project, "_buttons.scss", "$primary")).toBe("m1.scss:1");
      },
    );
    // An importer with a load that did not resolve may define the name too.
    await withScssProject(
      {
        "main.scss": '$primary: red;\n@import "missing";\n@import "buttons";\n',
        "_buttons.scss": ".btn { color: $primary; }\n",
      },
      async (project) => {
        const refs = await scssRefs(project, "main.scss", "$primary");
        expect(refs.sites).toEqual(["_buttons.scss:1", "main.scss:1"]);
        expect(refs.coverage?.state).toBe("partial");
      },
    );
  });

  it.runIf(native)("checks every spelling of a member that a module forwards under two prefixes", async () => {
    const base = {
      "_c.scss": "$primary: red;\n",
      "main.scss": '@use "f";\n.a { w: f.$x-primary; h: f.$y-primary; }\n',
    };
    // The second spelling `$y-primary` becomes `$y-gap`, which the forwarding module declares.
    await withScssProject(
      { ...base, "_f.scss": '@forward "c" as x-*;\n@forward "c" as y-*;\n$y-gap: 1px;\n' },
      async (project) => {
        const renamed = await previewScssRename(project, "$primary", "_c.scss", "$gap");
        expect(renamed.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`)).toEqual([
          "name_collision:_f.scss",
        ]);
        expect((await previewScssRename(project, "$primary", "_c.scss", "$tone")).safe).toBe(true);
      },
    );
    await withScssProject(
      { ...base, "_f.scss": '@forward "c" as x-*;\n@forward "c" as y-*;\n$x-gap: 1px;\n' },
      async (project) => {
        const renamed = await previewScssRename(project, "$primary", "_c.scss", "$gap");
        expect(renamed.conflicts.map((conflict) => conflict.reason)).toEqual(["name_collision"]);
      },
    );
  });

  it.runIf(native)(
    "checks a capture by the name the use has after the rename, never for a namespaced use",
    async () => {
      // The forward prefix stays: `$theme-primary` becomes `$theme-gap`, which the parameter captures.
      await withScssProject(
        {
          "_c.scss": "$primary: red;\n",
          "_f.scss": '@forward "c" as theme-*;\n',
          "main.scss": '@use "f" as *;\n@mixin m($theme-gap) {\n  color: $theme-primary;\n  margin: $theme-gap;\n}\n',
        },
        async (project) => {
          const renamed = await previewScssRename(project, "$primary", "_c.scss", "$gap");
          expect(renamed.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`)).toEqual([
            "shadowing:main.scss",
          ]);
          expect((await previewScssRename(project, "$primary", "_c.scss", "$tone")).safe).toBe(true);
        },
      );
      // dart-sass compiles `c.$primary` beside a `$gap` parameter to the module variable: the
      // namespace names the module, so no local variable can capture it.
      await withScssProject(
        {
          "_c.scss": "$primary: red;\n",
          "main.scss": '@use "c";\n@mixin m($gap) {\n  color: c.$primary;\n  margin: $gap;\n}\n',
        },
        async (project) => {
          const renamed = await previewScssRename(project, "$primary", "_c.scss", "$gap");
          expect(renamed.conflicts).toEqual([]);
          expect(renamed.safe).toBe(true);
        },
      );
    },
  );

  it("reads a custom property value as literal CSS, except for interpolation", () => {
    // dart-sass: `--literal: $primary` stays the text `$primary`; `#{$primary}` is evaluated.
    const source = [
      "$primary: red;",
      ":root {",
      "  --literal: $primary;",
      "  --interp: #{$primary};",
      "  --call: calc(1px + #{$primary});",
      "  --object: { a: $primary; };",
      "  --#{$prefix}name: $primary;",
      "}",
      ".a { color: $primary; }",
      "",
    ].join("\n");
    const facts = extractScssFacts(source);
    // The interpolation in the name of the last property is code too, so `$prefix` is a read.
    expect(facts.uses.filter((use) => use.kind === "variable").map((use) => lineOf(source, use.nameStart))).toEqual([
      4, 5, 7, 9,
    ]);
    expect(facts.uses.filter((use) => use.kind === "function")).toEqual([]);
    expect(facts.declarations.map((declaration) => declaration.name)).toEqual(["$primary"]);
  });

  it.runIf(native)("lists no literal custom property text as a reference", async () => {
    const source = ":root {\n  --literal: $primary;\n  --interp: #{$primary};\n}\n";
    await withScssProject(
      { "_colors.scss": "$primary: red;\n", "main.scss": `@use "colors" as *;\n${source}` },
      async (project) => {
        const refs = await scssRefs(project, "_colors.scss", "$primary");
        expect(refs.sites).toEqual(["_colors.scss:1", "main.scss:4"]);
      },
    );
  });

  it.runIf(native)(
    "keeps go-to-definition and references in agreement for a variable that a nested block assigns",
    async () => {
      // dart-sass compiles this to `.outer .inner { width: 2 } .outer { height: 2 }`: the assignment in
      // `.inner` changes the variable of `.outer`. Go-to-definition names the nearest assignment (the
      // one in the same block as `width`), and the references of that definition list the use. Naming
      // the first assignment instead would leave the references of that assignment without the use.
      const source = [
        ".outer {",
        "  $x: 1;",
        "  .inner {",
        "    $x: 2;",
        "    width: $x;",
        "  }",
        "  height: $x;",
        "}",
        "",
      ].join("\n");
      await withScssProject({ "m.scss": source }, async (project) => {
        for (const needle of ["width: $x", "height: $x"]) {
          const position = project.position("m.scss", needle, 0, needle.indexOf("$"));
          const definition = await goToDefinition(project.index, position);
          expect(definition.status, needle).toBe("ok");
          if (definition.status !== "ok") continue;
          expect(definition.definition.range.start.line, needle).toBe(4);
          const refs = await findReferences(project.index, { def: definition.definition });
          expect(refs.status, needle).toBe("ok");
          if (refs.status !== "ok") continue;
          expect(
            refs.references.map((reference) => `${reference.range.start.line}:${reference.range.start.column}`),
            needle,
          ).toContain(`${position.line}:${position.column}`);
        }
      });
    },
  );

  it("reads the variables of a CSS import media query and url() interpolation, not a quoted URL", () => {
    // dart-sass keeps a quoted URL as raw text, evaluates the interpolation in `url(...)`, and
    // evaluates the expressions of a media query.
    const source = [
      "$bp: 40em;",
      "$asset: logo;",
      '@import "print.css" screen and (min-width: $bp);',
      '@import url("https://example.com/#{$asset}.css");',
      '@import "https://example.com/#{$asset}.css";',
      "@import url(https://example.com/#{$asset}.css);",
      "",
    ].join("\n");
    const facts = extractScssFacts(source);
    expect(facts.uses.filter((use) => use.kind === "variable").map((use) => lineOf(source, use.nameStart))).toEqual([
      3, 4, 6,
    ]);
    expect(facts.loads).toEqual([]);
  });

  it.runIf(native)("finds the reads inside CSS imports as references", async () => {
    const source = [
      "$bp: 40em;",
      "$asset: logo;",
      '@import "print.css" screen and (min-width: $bp);',
      '@import url("https://example.com/#{$asset}.css");',
      '@import "https://example.com/#{$asset}.css";',
      "",
    ].join("\n");
    await withScssProject({ "m.scss": source }, async (project) => {
      expect((await scssRefs(project, "m.scss", "$bp:")).sites).toEqual(["m.scss:1", "m.scss:3"]);
      expect((await scssRefs(project, "m.scss", "$asset:")).sites).toEqual(["m.scss:2", "m.scss:4"]);
    });
  });

  it("keeps an assignment to a loop variable off the file variable of the same name", () => {
    // dart-sass leaves `$x` at 0 after `@each $x in 1, 2 { $x: $x + 1; }`: the assignment changes
    // the loop variable. `@for` behaves the same.
    const facts = extractScssFacts(
      [
        "$x: 0;",
        "@each $x in 1, 2 {",
        "  $x: $x + 1;",
        "}",
        "$i: 5;",
        "@for $i from 1 through 2 {",
        "  $i: $i * 10;",
        "}",
        "@if true {",
        "  $x: 7;",
        "}",
        "",
      ].join("\n"),
    );
    // The assignment inside `@if` still changes the file variable, as dart-sass does.
    expect(facts.declarations.map((declaration) => `${declaration.name}@${declaration.range.start.line}`)).toEqual([
      "$x@1",
      "$i@5",
      "$x@10",
    ]);
  });

  it.runIf(native)("lists no loop variable assignment as a site of the file variable", async () => {
    const source = ["$i: 5;", "@for $i from 1 through 2 {", "  $i: $i * 10;", "}", ".z { h: $i; }", ""].join("\n");
    await withScssProject({ "m.scss": source }, async (project) => {
      const refs = await scssRefs(project, "m.scss", "$i:");
      expect(refs.sites).toEqual(["m.scss:1", "m.scss:5"]);
      const renamed = await previewScssRename(project, "$i", "m.scss", "$n");
      expect(renamed.edits.map((edit) => edit.range.start.line).sort()).toEqual([1, 5]);
    });
  });

  it.runIf(native)("lists an assignment inside @each as a site of the file variable", async () => {
    // The index holds no definition for an assignment in an `@each` body, yet it changes the file
    // variable (dart-sass: a flow-control block shares the file scope), so a rename must edit it.
    const source = ["$x: 0;", "@each $i in 1, 2 {", "  $x: $x + $i;", "}", ".z { w: $x; }", ""].join("\n");
    await withScssProject({ "m.scss": source }, async (project) => {
      const refs = await scssRefs(project, "m.scss", "$x:");
      expect(refs.sites).toEqual(["m.scss:1", "m.scss:3", "m.scss:3", "m.scss:5"]);
      const renamed = await previewScssRename(project, "$x", "m.scss", "$y");
      expect(renamed.edits.map((edit) => `${edit.range.start.line}:${edit.range.start.column}`).sort()).toEqual([
        "1:1",
        "3:3",
        "3:7",
        "5:9",
      ]);
    });
  });

  it.runIf(native)(
    "reports partial coverage when a file in the same @import scope declares the name again",
    async () => {
      // dart-sass compiles this to `.btn { color: blue } .after { color: blue }`: the partial assigns
      // the variable that its importer declared, so both declarations name one variable.
      await withScssProject(
        {
          "main.scss": '$primary: red;\n@import "buttons";\n.after { color: $primary; }\n',
          "_buttons.scss": "$primary: blue;\n.btn { color: $primary; }\n",
        },
        async (project) => {
          const refs = await scssRefs(project, "main.scss", "$primary");
          expect(refs.coverage?.state).toBe("partial");
          expect(refs.coverage?.affectedFiles?.map((file) => project.relative(file))).toEqual(["_buttons.scss"]);
          expect((await previewScssRename(project, "$primary", "main.scss", "$accent")).safe).toBe(false);
        },
      );
      // The common override pattern: the file imported first sets the value that `!default` yields to.
      await withScssProject(
        {
          "_vars.scss": "$primary: red !default;\n",
          "_overrides.scss": "$primary: blue;\n",
          "main.scss": '@import "overrides";\n@import "vars";\n',
        },
        async (project) => {
          const refs = await scssRefs(project, "_vars.scss", "$primary");
          expect(refs.coverage?.state).toBe("partial");
          expect(refs.coverage?.affectedFiles?.map((file) => project.relative(file))).toEqual(["_overrides.scss"]);
        },
      );
      // `@use` keeps the scopes apart: dart-sass compiles this to `color: red; w: blue`.
      await withScssProject(
        {
          "_colors.scss": "$primary: red;\n",
          "main.scss": '@use "colors";\n$primary: blue;\n.a { color: colors.$primary; w: $primary; }\n',
        },
        async (project) => {
          const refs = await scssRefs(project, "_colors.scss", "$primary");
          expect(refs.sites).toEqual(["_colors.scss:1", "main.scss:3"]);
          expect(refs.coverage?.state).toBe("complete");
        },
      );
    },
  );
});

describe("SCSS module navigation: second review follow-ups", () => {
  const native = isNativeTreeSitterAvailable();

  function lineOf(source: string, offset: number): number {
    return source.slice(0, offset).split("\n").length;
  }

  it.runIf(native)("checks the name an edit writes when a rename request has no sigil", async () => {
    // The edit writes `$y` for a request of `y`, so the block variable `$y` collides with it.
    const source = ".a { $x: 1px; $y: 2px; w: $x; }\n// $x here\n";
    await withScssProject({ "m.scss": source }, async (project) => {
      for (const newName of ["y", "$y"]) {
        const renamed = await previewScssRename(project, "$x", "m.scss", newName);
        expect(
          renamed.conflicts.map((conflict) => conflict.reason),
          newName,
        ).toEqual(["name_collision"]);
        expect(renamed.safe, newName).toBe(false);
      }
      // A free name is safe, and the comment edit takes the same spelling as the code edits.
      const free = await previewScssRename(project, "$x", "m.scss", "z", { includeComments: true });
      expect(free.conflicts).toEqual([]);
      expect(free.safe).toBe(true);
      expect(free.edits.map((edit) => edit.newText)).toEqual(["$z", "$z", "$z"]);
    });
  });

  it.runIf(native)(
    "reports partial coverage when a file assigns a variable that its `as *` module declares",
    async () => {
      // dart-sass compiles this to `.a { width: 2; v: 2 }`: the assignment assigns the variable of the
      // module (`get()` reads 2), so the two declarations name one variable.
      await withScssProject(
        {
          "_vars.scss": "$x: 1;\n@function get() { @return $x; }\n",
          "main.scss": '@use "vars" as *;\n$x: 2;\n.a { width: $x; v: get(); }\n',
        },
        async (project) => {
          for (const [file, needle] of [
            ["_vars.scss", "$x"],
            ["main.scss", "$x:"],
          ] as const) {
            const refs = await scssRefs(project, file, needle);
            expect(refs.coverage?.state, file).toBe("partial");
            expect(
              refs.coverage?.affectedFiles?.map((affected) => project.relative(affected)),
              file,
            ).toEqual(["main.scss"]);
            expect((await previewScssRename(project, "$x", file, "$y")).safe, file).toBe(false);
          }
        },
      );
      // A block variable assigns nothing (dart-sass: `.a { width: 2 } .b { width: 1 }`).
      await withScssProject(
        {
          "_vars.scss": "$x: 1;\n",
          "main.scss": '@use "vars" as *;\n.a { $x: 2; width: $x; }\n.b { width: $x; }\n',
        },
        async (project) => {
          const refs = await scssRefs(project, "_vars.scss", "$x");
          expect(refs.sites).toEqual(["_vars.scss:1", "main.scss:3"]);
          expect(refs.coverage?.state).toBe("complete");
        },
      );
      // A mixin of the same name hides the loaded one (dart-sass: `.a { margin: 2px }`).
      await withScssProject(
        {
          "_lib.scss": "@mixin pad { padding: 1px; }\n",
          "main.scss": '@use "lib" as *;\n@mixin pad { margin: 2px; }\n.a { @include pad; }\n',
        },
        async (project) => {
          const refs = await scssRefs(project, "_lib.scss", "pad");
          expect(refs.sites).toEqual(["_lib.scss:1"]);
          expect(refs.coverage?.state).toBe("complete");
        },
      );
    },
  );

  const PSEUDO_CLASS_SOURCE = [
    "@function is($x) { @return 1; }",
    "@function gap($x) { @return $x; }",
    ".a:is(.b):not(.c) > .d:has(e):nth-child(2n + 1) { margin:gap(4px); w: is(2); &:where(.f) { z: 1; } }",
    "@media (min-width:has(1)) { .g { w: 1; } }",
    "",
  ].join("\n");

  it("does not read a CSS functional pseudo-class in a selector as a function call", () => {
    // dart-sass keeps `:is(.b)` and `:has(e)` as selectors, and calls the user functions for
    // `gap(4px)` and `is(2)`. A declaration with no space after the colon is still a declaration.
    const facts = extractScssFacts(PSEUDO_CLASS_SOURCE);
    expect(
      facts.uses
        .filter((use) => use.kind === "function")
        .map((use) => `${use.text}@${lineOf(PSEUDO_CLASS_SOURCE, use.nameStart)}`),
    ).toEqual(["gap@3", "is@3", "has@4"]);
  });

  it.runIf(native)("lists only the call of a function that a selector pseudo-class also spells", async () => {
    await withScssProject({ "m.scss": PSEUDO_CLASS_SOURCE }, async (project) => {
      const refs = await scssRefs(project, "m.scss", "@function is", 0, "@function ".length);
      expect(refs.sites).toEqual(["m.scss:1", "m.scss:3"]);
    });
  });

  it.runIf(native)("keeps a consumer whose text cannot be read as a candidate that is never proved", async () => {
    await withScssProject(
      {
        "_c.scss": "$primary: red;\n",
        "main.scss": '@use "c";\n.a { w: c.$primary; }\n',
        "user.scss": '@use "c";\n.b { w: c.$primary; }\n',
      },
      async (project) => {
        // The graph knows that user.scss loads _c.scss. Removing the file makes its text unreadable.
        await fsp.rm(path.join(project.root, "user.scss"));
        const refs = await scssRefs(project, "_c.scss", "$primary");
        expect(refs.sites).toEqual(["_c.scss:1", "main.scss:2"]);
        expect(refs.coverage?.state).toBe("partial");
        expect(refs.coverage?.affectedFiles?.map((file) => project.relative(file))).toEqual(["user.scss"]);
      },
    );
  });

  it.runIf(native)("resolves a private variable that a with key configures", async () => {
    // dart-sass accepts `with ($-accent: blue)` for a private `!default` variable of the module,
    // though a read of `c.$-accent` is an error.
    await withScssProject(
      {
        "_c.scss": "$-accent: red !default;\n.x { w: $-accent; }\n",
        "main.scss": '@use "c" with ($-accent: blue);\n',
      },
      async (project) => {
        const refs = await scssRefs(project, "_c.scss", "$-accent");
        expect(refs.sites).toEqual(["_c.scss:1", "_c.scss:2", "main.scss:1"]);
        expect(refs.coverage?.state).toBe("complete");
        const renamed = await previewScssRename(project, "$-accent", "_c.scss", "$-tone");
        expect(renamed.safe).toBe(true);
        expect(renamed.edits.map((edit) => edit.file).sort()).toEqual(["_c.scss", "_c.scss", "main.scss"]);
      },
    );
  });

  it.runIf(native)("reports a name collision with a placeholder that another file extending it sees", async () => {
    // dart-sass compiles `@extend %b` to both placeholders when main.scss sees both modules
    // (`.x { color: red } .x { color: blue }`), so the rename changes what `.x` extends.
    const modules = { "_base.scss": "%a { color: red; }\n", "_other.scss": "%b { color: blue; }\n" };
    await withScssProject(
      { ...modules, "main.scss": '@use "base";\n@use "other";\n.x { @extend %a; }\n' },
      async (project) => {
        const renamed = await previewScssRename(project, "a", "_base.scss", "b");
        expect(renamed.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`)).toEqual([
          "name_collision:_other.scss",
        ]);
        expect(renamed.safe).toBe(false);
        expect((await previewScssRename(project, "a", "_base.scss", "c")).safe).toBe(true);
      },
    );
    // No file that extends `%a` sees _other.scss, so `b` stays free.
    await withScssProject(
      {
        ...modules,
        "main.scss": '@use "base";\n.x { @extend %a; }\n',
        "other-main.scss": '@use "other";\n.y { @extend %b; }\n',
      },
      async (project) => {
        const renamed = await previewScssRename(project, "a", "_base.scss", "b");
        expect(renamed.conflicts).toEqual([]);
        expect(renamed.safe).toBe(true);
      },
    );
  });

  it("reads a string or comment inside the interpolation of an unquoted url() as trivia", () => {
    // dart-sass evaluates the expression inside `#{...}`: a quoted `'$primary'` is text, and a `}`
    // inside a string or comment closes nothing.
    const reads = (source: string): string[] => extractScssFacts(source).uses.map((use) => use.text);
    expect(reads("$primary: red;\n.a { background: url(#{'$primary'}.svg); }\n")).toEqual([]);
    expect(reads("$base: img;\n.a { background: url(#{$base}/a.svg); }\n")).toEqual(["$base"]);
    expect(reads("$later: 1px;\n.a { background: url(#{'}'}x.svg); w: $later; }\n")).toEqual(["$later"]);
    expect(reads("$later: 1px;\n.a { background: url(#{/* } */ 'x'}.svg); w: $later; }\n")).toEqual(["$later"]);
  });

  it("marks an @import inside a rule or an at-rule block as nested", () => {
    const facts = extractScssFacts('@import "top";\n.a { @import "inner"; }\n@media print { @import "media"; }\n');
    expect(facts.loads.map((load) => `${load.url}:${load.nested}`)).toEqual(["top:false", "inner:true", "media:true"]);
  });

  it.runIf(native)("leaves the names a nested @import brings in unproven, and out of the file scope", async () => {
    // dart-sass declares what `.a { @import "vars"; }` imports inside `.a` only (`$x` is an error
    // outside the block), and this scan does not follow blocks, so no use of it is proved.
    await withScssProject(
      { "_vars.scss": "$x: 1;\n", "main.scss": '.a { @import "vars"; w: $x; }\n' },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "w: $x", 0, 3)).toBe("not_found");
        const refs = await scssRefs(project, "_vars.scss", "$x");
        expect(refs.coverage?.state).toBe("partial");
        expect(refs.coverage?.affectedFiles?.map((file) => project.relative(file))).toEqual(["main.scss"]);
      },
    );
    // The `$x` that `_lib.scss` imports inside `.a` is not a global of main.scss: `.b` reads the
    // variable of _other.scss (dart-sass: `.b { w: 2 }`).
    await withScssProject(
      {
        "_vars.scss": "$x: 1;\n",
        "_lib.scss": '.a { @import "vars"; }\n',
        "_other.scss": "$x: 2;\n",
        "main.scss": '@import "lib";\n@import "other";\n.b { w: $x; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "w: $x", 0, 3)).toBe("_other.scss:1");
      },
    );
  });
});

describe("SCSS module navigation: final review follow-ups", () => {
  const native = isNativeTreeSitterAvailable();

  function lineOf(source: string, offset: number): number {
    return source.slice(0, offset).split("\n").length;
  }

  it.runIf(native)("reads the member in the default of a parameter that has its name", async () => {
    // dart-sass: `box` reads the module `$size` in its default (`width: 1px`), a later default reads an
    // earlier parameter (`$b: $a` is 1), and an earlier default cannot read a later parameter (`$a: $b`
    // is the module `$b`, 9). The parameter hides the member only after its own default.
    const source = [
      "$size: 1px;",
      "$a: 9;",
      "$b: 8;",
      "@mixin box($size: $size) { width: $size; }",
      "@mixin two($a: 1, $b: $a) { w: $b; }",
      "@mixin later($a: $b, $b: 2) { w: $a; }",
      "@function f($size: if(true, $size, 0)) { @return $size; }",
      "@mixin lst($l: (1, 2), $a: $a) { w: $a; }",
      "",
    ].join("\n");
    await withScssProject({ "m.scss": source }, async (project) => {
      expect(await scssGoto(project, "m.scss", "$size: $size", 0, 7)).toBe("m.scss:1");
      expect(await scssGoto(project, "m.scss", "true, $size", 0, 6)).toBe("m.scss:1");
      expect(await scssGoto(project, "m.scss", "$a: $b", 0, 5)).toBe("m.scss:3");
      expect(await scssGoto(project, "m.scss", "$a: $a", 0, 4)).toBe("m.scss:2");
      // The body and a later default read the parameter, which has no definition to go to.
      expect(await scssGoto(project, "m.scss", "width: $size", 0, 7)).toBe("not_found");
      expect(await scssGoto(project, "m.scss", "$b: $a", 0, 5)).toBe("not_found");
      expect((await scssRefs(project, "m.scss", "$size:")).sites).toEqual(["m.scss:1", "m.scss:4", "m.scss:7"]);
      expect((await scssRefs(project, "m.scss", "$a: 9")).sites).toEqual(["m.scss:2", "m.scss:8"]);
      expect((await scssRefs(project, "m.scss", "$b: 8")).sites).toEqual(["m.scss:3", "m.scss:6"]);
      const renamed = await previewScssRename(project, "$size", "m.scss", "$gap");
      expect(renamed.edits.map((edit) => edit.range.start.line).sort()).toEqual([1, 4, 7]);
    });
  });

  it.runIf(native)("compares a placeholder as written, not with - and _ as one character", async () => {
    // dart-sass: `%foo-bar` and `%foo_bar` are two placeholders (`@extend %foo_bar` finds nothing in
    // the first file below), and `%_pub` is private under `@use` and open under `@import`.
    const facts = extractScssFacts("%a-b { c: d; }\n%a_b { c: e; }\n.x { @extend %a_b; }\n");
    expect(facts.declarations.map((declaration) => declaration.canonical)).toEqual(["a-b", "a_b"]);
    expect(facts.uses.map((use) => use.canonical)).toEqual(["a_b"]);
    const single = "%foo-bar { color: red; }\n.a { @extend %foo_bar; }\n.b { @extend %foo-bar; }\n";
    await withScssProject({ "m.scss": single }, async (project) => {
      expect(await scssGoto(project, "m.scss", "%foo_bar", 0, 1)).toBe("not_found");
      expect(await scssGoto(project, "m.scss", "%foo-bar;", 0, 1)).toBe("m.scss:1");
      const refs = await scssRefs(project, "m.scss", "%foo-bar {", 0, 1);
      expect(refs.sites).toEqual(["m.scss:1", "m.scss:3"]);
      expect(refs.coverage?.state).toBe("complete");
    });
    const both = "%foo_bar { color: red; }\n%foo-bar { color: blue; }\n.a { @extend %foo_bar; }\n";
    await withScssProject({ "m.scss": both }, async (project) => {
      expect(await scssGoto(project, "m.scss", "%foo_bar;", 0, 1)).toBe("m.scss:1");
      expect((await scssRefs(project, "m.scss", "%foo-bar {", 0, 1)).sites).toEqual(["m.scss:2"]);
    });
    await withScssProject(
      {
        "_b.scss": "%_pub { color: red; }\n",
        "use.scss": '@use "b";\n.a { @extend %_pub; }\n',
        "imp.scss": '@import "b";\n.a { @extend %_pub; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "use.scss", "%_pub", 0, 1)).toBe("not_found");
        expect(await scssGoto(project, "imp.scss", "%_pub", 0, 1)).toBe("_b.scss:1");
      },
    );
  });

  it.runIf(native)("collides a renamed placeholder with the placeholder that has the new spelling", async () => {
    const files = { "m.scss": "%foo-bar { color: red; }\n%foo_bar { color: blue; }\n.a { @extend %foo-bar; }\n" };
    await withScssProject(files, async (project) => {
      const renamed = await previewScssRename(project, "foo-bar", "m.scss", "foo_bar");
      expect(renamed.conflicts.map((conflict) => conflict.reason)).toEqual(["name_collision"]);
      expect(renamed.safe).toBe(false);
    });
    await withScssProject({ "m.scss": "%foo-bar { color: red; }\n.a { @extend %foo-bar; }\n" }, async (project) => {
      const renamed = await previewScssRename(project, "foo-bar", "m.scss", "foo_bar");
      expect(renamed.conflicts).toEqual([]);
      expect(renamed.edits.map((edit) => edit.newText)).toEqual(["foo_bar", "foo_bar"]);
    });
  });

  it.runIf(native)("checks a block variable name with - and _ as one character in the scope check", async () => {
    // dart-sass: `$foo-bar: 1; $foo_bar: 2;` assigns one variable, so a rename to the other spelling
    // collides with the variable of the same block.
    const source = ".a { $foo-bar: 1; $x: 2; w: $x; }\n.b { $foo_baz: 1; $y: 2; w: $y; }\n";
    await withScssProject({ "m.scss": source }, async (project) => {
      const underscore = await previewScssRename(project, "$x", "m.scss", "$foo_bar");
      expect(underscore.conflicts.map((conflict) => conflict.reason)).toEqual(["name_collision"]);
      const hyphen = await previewScssRename(project, "$y", "m.scss", "$foo-baz");
      expect(hyphen.conflicts.map((conflict) => conflict.reason)).toEqual(["name_collision"]);
      // A name that no scope uses is free.
      expect((await previewScssRename(project, "$x", "m.scss", "$other")).safe).toBe(true);
    });
  });

  it("reads meta.get-mixin and meta.module-mixins as dynamic lookups", () => {
    const facts = extractScssFacts(
      [
        '@use "sass:meta";',
        '@use "lib";',
        ".a {",
        '  @include meta.apply(meta.get-mixin("pad", "lib"));',
        '  $mixins: meta.module-mixins("lib");',
        "}",
        "",
      ].join("\n"),
    );
    expect(facts.dynamics.map((dynamic) => `${dynamic.form}:${dynamic.arg}`)).toEqual([
      "get-mixin:pad",
      "module-mixins:lib",
    ]);
  });

  it.runIf(native)("reports partial coverage for a file that looks a mixin up by name", async () => {
    const lib = "@mixin pad { padding: 1px; }\n";
    for (const lookup of ['meta.get-mixin("pad", "lib")', 'meta.module-mixins("lib")']) {
      await withScssProject(
        {
          "_lib.scss": lib,
          "main.scss": `@use "sass:meta";\n@use "lib";\n.a { @include lib.pad; x: ${lookup}; }\n`,
        },
        async (project) => {
          const refs = await scssRefs(project, "_lib.scss", "@mixin pad", 0, 7);
          expect(refs.sites, lookup).toEqual(["_lib.scss:1", "main.scss:3"]);
          expect(refs.coverage?.state, lookup).toBe("partial");
          expect(
            refs.coverage?.affectedFiles?.map((file) => project.relative(file)),
            lookup,
          ).toEqual(["main.scss"]);
        },
      );
    }
  });

  it.runIf(native)("reports partial coverage for a style block that loads a forwarding module by URL", async () => {
    // The graph does not resolve the URL of a style block (it reads `external`), and `_theme.scss`
    // forwards `_colors.scss`. The block reaches `$primary` through the stem `theme`, not `colors`.
    const vue = (url: string): string =>
      `<template><div /></template>\n<style lang="scss">\n@use "${url}";\n.a { color: theme.$primary; }\n</style>\n`;
    for (const url of ["./styles/theme", "@/styles/theme"]) {
      await withScssProject(
        {
          "styles/_colors.scss": "$primary: red;\n",
          "styles/_theme.scss": '@forward "colors";\n',
          "main.scss": '@use "styles/theme";\n.a { color: theme.$primary; }\n',
          "Comp.vue": vue(url),
        },
        async (project) => {
          const refs = await scssRefs(project, "styles/_colors.scss", "$primary");
          expect(refs.sites, url).toEqual(["main.scss:2", "styles/_colors.scss:1"]);
          expect(refs.coverage?.state, url).toBe("partial");
          expect(
            refs.coverage?.affectedFiles?.map((file) => project.relative(file)),
            url,
          ).toEqual(["Comp.vue"]);
        },
      );
    }
    // A module that only `@use`s `_colors.scss` hands nothing on, so a load of it reaches no member.
    await withScssProject(
      {
        "styles/_colors.scss": "$primary: red;\n",
        "styles/_theme.scss": '@use "colors";\n',
        "Comp.vue": vue("@/styles/theme"),
      },
      async (project) => {
        const refs = await scssRefs(project, "styles/_colors.scss", "$primary");
        expect(refs.sites).toEqual(["styles/_colors.scss:1"]);
        expect(refs.coverage?.state).toBe("complete");
      },
    );
  });

  it.runIf(native)("compares the scopes that a private member joins when it takes a public name", async () => {
    // A private member hides from `@use ... as *` and `@forward`, so today no scope of theirs lists it.
    // dart-sass rejects two members with one name in a scope, so the new name must be free there.
    const rename = async (files: Record<string, string>, name: string, inFile: string, newName: string) => {
      let reasons: string[] = [];
      await withScssProject(files, async (project) => {
        const renamed = await previewScssRename(project, name, inFile, newName);
        reasons = renamed.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`);
      });
      return reasons;
    };
    const colors = { "_c.scss": "$-accent: red;\n.x { w: $-accent; }\n" };
    expect(
      await rename(
        { ...colors, "main.scss": '@use "c" as *;\n$accent: 5;\n.a { w: $accent; }\n' },
        "$-accent",
        "_c.scss",
        "$accent",
      ),
    ).toEqual(["name_collision:main.scss"]);
    // The forward adds its prefix: `$-accent` becomes `$theme-accent` for the module that uses `f`.
    expect(
      await rename(
        {
          "_c.scss": "$-accent: red;\n",
          "_f.scss": '@forward "c" as theme-*;\n',
          "main.scss": '@use "f" as *;\n$theme-accent: 5;\n',
        },
        "$-accent",
        "_c.scss",
        "$accent",
      ),
    ).toEqual(["name_collision:main.scss"]);
    expect(
      await rename(
        {
          "_a.scss": "@mixin -pad { padding: 1px; }\n",
          "_b.scss": "@mixin pad { margin: 1px; }\n",
          "main.scss": '@use "a" as *;\n@use "b" as *;\n',
        },
        "-pad",
        "_a.scss",
        "pad",
      ),
    ).toEqual(["name_collision:_b.scss"]);
    // A scope without the new name, and a namespaced use (which never collides), stay free.
    expect(
      await rename({ ...colors, "main.scss": '@use "c" as *;\n$other: 5;\n' }, "$-accent", "_c.scss", "$accent"),
    ).toEqual([]);
    expect(
      await rename(
        { ...colors, "main.scss": '@use "c";\n$accent: 5;\n.a { w: $accent; }\n' },
        "$-accent",
        "_c.scss",
        "$accent",
      ),
    ).toEqual([]);
  });

  it.runIf(native)("keeps every read of a nested @import unproven, in the block and outside it", async () => {
    // dart-sass declares what `.a { @import "vars"; }` imports in `.a` only, and this scan does not
    // follow blocks: neither read of `$x` below goes to the module, and the references are partial.
    const main = '.a { @import "vars"; width: $x; } .b { width: $x; }\n';
    await withScssProject({ "_vars.scss": "$x: 1;\n", "main.scss": main }, async (project) => {
      expect(await scssGoto(project, "main.scss", "width: $x", 0, 7)).toBe("not_found");
      expect(await scssGoto(project, "main.scss", "width: $x", 1, 7)).toBe("not_found");
      const refs = await scssRefs(project, "_vars.scss", "$x");
      expect(refs.sites).toEqual(["_vars.scss:1"]);
      expect(refs.coverage?.state).toBe("partial");
      expect(refs.coverage?.affectedFiles?.map((file) => project.relative(file))).toEqual(["main.scss"]);
    });
    // A placeholder is global: dart-sass compiles `.b { @extend %ph; }` to `.a .b { color: red }`.
    await withScssProject(
      { "_ph.scss": "%ph { color: red; }\n", "main.scss": '.a { @import "ph"; }\n.b { @extend %ph; }\n' },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "%ph;", 0, 1)).toBe("_ph.scss:1");
      },
    );
  });

  it("reads a string or comment inside the interpolation of a quoted string as text", () => {
    // dart-sass evaluates the expression inside `#{...}`: a string in it is text, a comment is
    // dropped, and `$primary` beside them stays a read.
    const reads = (body: string): string[] => {
      const source = `$primary: red;\n.a { content: ${body}; }\n`;
      return extractScssFacts(source).uses.map((use) => `${use.text}@${lineOf(source, use.nameStart)}`);
    };
    expect(reads(`"#{'$primary'}"`)).toEqual([]);
    expect(reads(`'x #{"$primary"}'`)).toEqual([]);
    expect(reads(`"#{/* $primary */ 1}"`)).toEqual([]);
    expect(reads(`"a #{ "b #{'$primary'} c" } d"`)).toEqual([]);
    expect(reads(`"x #{$primary} y"`)).toEqual(["$primary@2"]);
    expect(reads(`"#{'$primary' + $primary}"`)).toEqual(["$primary@2"]);
  });

  it.runIf(native)("lists no string text in an interpolation as a reference, and renames no such text", async () => {
    const source = [
      "$primary: red;",
      ".a { content: \"#{'$primary'}\"; background: url(#{'$primary'}.svg); w: $primary; }",
      '.b { content: "x #{$primary} y"; background: url(#{$primary}.svg); }',
      "",
    ].join("\n");
    await withScssProject({ "m.scss": source }, async (project) => {
      const refs = await scssRefs(project, "m.scss", "$primary:");
      expect(refs.sites).toEqual(["m.scss:1", "m.scss:2", "m.scss:3", "m.scss:3"]);
      const renamed = await previewScssRename(project, "$primary", "m.scss", "$accent");
      expect(renamed.edits.map((edit) => `${edit.range.start.line}:${edit.range.start.column}`)).toEqual([
        "1:1",
        `2:${source.split("\n")[1]!.indexOf("w: $primary") + 4}`,
        `3:${source.split("\n")[2]!.indexOf("#{$primary} y") + 3}`,
        `3:${source.split("\n")[2]!.indexOf("url(#{$primary}") + 7}`,
      ]);
    });
  });
});

describe("SCSS module navigation: late review follow-ups", () => {
  const native = isNativeTreeSitterAvailable();

  function lineOf(source: string, offset: number): number {
    return source.slice(0, offset).split("\n").length;
  }

  /** The conflicts of a rename as `reason:file`. */
  async function conflictsOf(
    files: Record<string, string>,
    name: string,
    inFile: string,
    newName: string,
  ): Promise<string[]> {
    let reasons: string[] = [];
    await withScssProject(files, async (project) => {
      const renamed = await previewScssRename(project, name, inFile, newName);
      reasons = renamed.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`);
    });
    return reasons;
  }

  it.runIf(native)("reports a conflict when a forward hide list hides the new name from a read", async () => {
    // dart-sass: after `$x` becomes `$y`, `api.$y` is undefined, because `@forward "lib" hide $y` hides it.
    const lib = { "_lib.scss": "$x: 1;\n" };
    const api = (forward: string): Record<string, string> => ({ ...lib, "_api.scss": `${forward}\n` });
    const readThroughApi = { "main.scss": '@use "api";\n.a { w: api.$x; }\n' };
    const hidden = ["invalid_identifier:main.scss"];
    const rename = (files: Record<string, string>, newName = "$y", name = "$x", inFile = "_lib.scss") =>
      conflictsOf(files, name, inFile, newName);
    expect(await rename({ ...api('@forward "lib" hide $y;'), ...readThroughApi }), "namespace").toEqual(hidden);
    // A free name, and a hide list that names another kind of member, hide nothing.
    expect(await rename({ ...api('@forward "lib" hide $y;'), ...readThroughApi }, "$z"), "free name").toEqual([]);
    expect(await rename({ ...api('@forward "lib" hide y;'), ...readThroughApi }), "other kind").toEqual([]);
    // `@use ... as *` and `@import` read the same exposure.
    expect(
      await rename({ ...api('@forward "lib" hide $y;'), "main.scss": '@use "api" as *;\n.a { w: $x; }\n' }),
      "star",
    ).toEqual(hidden);
    expect(
      await rename({ ...api('@forward "lib" hide $y;'), "main.scss": '@import "api";\n.a { w: $x; }\n' }),
      "import",
    ).toEqual(hidden);
    // A list names the exposed spelling, so the prefix of the forward counts.
    const prefixed = { "main.scss": '@use "api";\n.a { w: api.$theme-x; }\n' };
    expect(await rename({ ...api('@forward "lib" as theme-* hide $theme-y;'), ...prefixed }), "prefix").toEqual(hidden);
    expect(await rename({ ...api('@forward "lib" as theme-* hide $y;'), ...prefixed }), "bare entry").toEqual([]);
    // `-` and `_` are one character in a list entry.
    expect(
      await conflictsOf(
        {
          "_lib.scss": "$foo-bar: 1;\n",
          "_api.scss": '@forward "lib" hide $foo_baz;\n',
          "main.scss": '@use "api";\n.a { w: api.$foo-bar; }\n',
        },
        "$foo-bar",
        "_lib.scss",
        "$foo-baz",
      ),
      "spelling",
    ).toEqual(hidden);
    // A list on an outer forward hides the member from the files that use the outer module.
    expect(
      await rename({
        ...lib,
        "_api.scss": '@forward "lib";\n',
        "_outer.scss": '@forward "api" as o-* hide $o-y;\n',
        "main.scss": '@use "outer";\n.a { w: outer.$o-x; }\n',
      }),
      "chain",
    ).toEqual(hidden);
    // Mixins and functions have their own lists.
    expect(
      await conflictsOf(
        {
          "_lib.scss": "@mixin pad { padding: 1px; }\n@function size() { @return 1px; }\n",
          "_api.scss": '@forward "lib" hide pad2, size2;\n',
          "main.scss": '@use "api";\n.a { @include api.pad; w: api.size(); }\n',
        },
        "pad",
        "_lib.scss",
        "pad2",
      ),
      "mixin",
    ).toEqual(hidden);
    expect(
      await conflictsOf(
        {
          "_lib.scss": "@function size() { @return 1px; }\n",
          "_api.scss": '@forward "lib" hide size2;\n',
          "main.scss": '@use "api";\n.a { w: api.size(); }\n',
        },
        "size",
        "_lib.scss",
        "size2",
      ),
      "function",
    ).toEqual(hidden);
    // Nothing reads the member through the forward, or a file reads it through another module.
    expect(await rename({ ...api('@forward "lib" hide $y;'), "main.scss": '@use "api";\n' }), "no read").toEqual([]);
    expect(
      await rename({ ...api('@forward "lib" hide $y;'), "main.scss": '@use "lib";\n.a { w: lib.$x; }\n' }),
      "other module",
    ).toEqual([]);
  });

  it.runIf(native)("keeps a show list in step with the renamed member", async () => {
    // dart-sass: `@forward "lib" show $y` and `api.$y` work once the show entry changes with `$x`.
    await withScssProject(
      {
        "_lib.scss": "$x: 1;\n",
        "_api.scss": '@forward "lib" show $x;\n',
        "main.scss": '@use "api";\n.a { w: api.$x; }\n',
      },
      async (project) => {
        const renamed = await previewScssRename(project, "$x", "_lib.scss", "$y");
        expect(renamed.conflicts).toEqual([]);
        expect(renamed.safe).toBe(true);
        expect(renamed.edits.map((edit) => edit.file).sort()).toEqual(["_api.scss", "_lib.scss", "main.scss"]);
      },
    );
  });

  it("reads the underscore spellings of the meta lookups as dynamic lookups", () => {
    // dart-sass reads `_` as `-` in a function or mixin name, so `meta.get_function` is `meta.get-function`.
    const facts = extractScssFacts(
      [
        '@use "sass:meta";',
        '@use "lib";',
        ".a {",
        '  @include meta.load_css("lib");',
        '  x: meta.get_function("pad");',
        '  y: meta.get_mixin("pad");',
        '  z: meta.module_variables("lib");',
        '  w: meta.module_functions("lib");',
        '  v: meta.module_mixins("lib");',
        '  u: meta.get-function("pad");',
        "}",
        "",
      ].join("\n"),
    );
    expect(facts.dynamics.map((dynamic) => `${dynamic.form}:${dynamic.arg}`)).toEqual([
      "load-css:lib",
      "get-function:pad",
      "get-mixin:pad",
      "module-variables:lib",
      "module-functions:lib",
      "module-mixins:lib",
      "get-function:pad",
    ]);
    expect(facts.uses.filter((use) => use.syntax === "call")).toEqual([]);
    // The namespace compares as written: `my_meta` and `my-meta` are two namespaces (dart-sass: "There
    // is no module with namespace my-meta" for the other one).
    const lookups = (source: string): string[] =>
      extractScssFacts(source).dynamics.map((dynamic) => `${dynamic.form}:${dynamic.arg}`);
    const calls = (source: string): string[] =>
      extractScssFacts(source).uses.map((use) => `${use.namespace}.${use.text}`);
    const underscore =
      '@use "sass:meta" as my_meta;\n.a { x: my_meta.get_function("a"); y: my-meta.get_function("b"); }\n';
    expect(lookups(underscore)).toEqual(["get-function:a"]);
    expect(calls(underscore)).toEqual(["my-meta.get_function"]);
    const hyphen = '@use "sass:meta" as my-meta;\n.a { x: my-meta.get_function("a"); y: my_meta.get_function("b"); }\n';
    expect(lookups(hyphen)).toEqual(["get-function:a"]);
    expect(calls(hyphen)).toEqual(["my_meta.get_function"]);
    // `sass:meta` loaded with `as *` is a lookup, and the call is not also a use. A bare
    // `get-function` / `get_function` is the legacy built-in too, unless this file already
    // declared that function.
    const star = extractScssFacts('@use "sass:meta" as *;\n.a { x: get_function("a"); y: module_mixins("b"); }\n');
    expect(star.dynamics.map((dynamic) => `${dynamic.form}:${dynamic.arg}`)).toEqual([
      "get-function:a",
      "module-mixins:b",
    ]);
    expect(star.uses.filter((use) => use.syntax === "call")).toEqual([]);
    const bare = extractScssFacts('.a { x: get_function("a"); }\n');
    expect(bare.dynamics.map((dynamic) => `${dynamic.form}:${dynamic.arg}`)).toEqual(["get-function:a"]);
    expect(bare.uses.filter((use) => use.syntax === "call").map((use) => use.text)).toEqual(["get_function"]);
  });

  it.runIf(native)("reports partial coverage for a file that looks a name up with an underscore spelling", async () => {
    const lib = "@function pad() { @return 1px; }\n@mixin box { padding: 1px; }\n";
    for (const lookup of ['meta.get_function("pad")', 'meta.get_mixin("box")', 'meta.module_functions("lib")']) {
      await withScssProject(
        {
          "_lib.scss": lib,
          "main.scss": `@use "sass:meta";\n@use "lib";\n.a { @include lib.box; w: lib.pad(); x: ${lookup}; }\n`,
        },
        async (project) => {
          const refs = await scssRefs(project, "_lib.scss", "@function pad", 0, "@function ".length);
          expect(refs.sites, lookup).toEqual(["_lib.scss:1", "main.scss:3"]);
          expect(refs.coverage?.state, lookup).toBe("partial");
          expect(
            refs.coverage?.affectedFiles?.map((file) => project.relative(file)),
            lookup,
          ).toEqual(["main.scss"]);
        },
      );
    }
  });

  const PLACEHOLDER_FORMS = [
    "@media screen {",
    "  %in-media { a: b; }",
    "  .m { @extend %in-media; }",
    "}",
    ".rule { %in-rule { c: d; } }",
    "@mixin m { %in-mixin { e: f; } }",
    ".list, %in-list { g: h; }",
    ".mid %in-selector .tail { i: j; }",
    "@at-root %at-root { k: l; }",
    "@at-root .scoped:not(.other) { n: o; }",
    "%top { m: n; }",
    ".use { @extend %top, %in-rule; width: 50%; margin: math.div(10, 3) % 2; }",
    "",
  ].join("\n");

  it("records a placeholder in the head of any style rule as a declaration", () => {
    // dart-sass extends a placeholder wherever its rule sits: in a media query, in another rule, in a
    // mixin that is included, in a selector list, and after `@at-root`.
    const facts = extractScssFacts(PLACEHOLDER_FORMS);
    expect(
      facts.declarations
        .filter((declaration) => declaration.kind === "placeholder")
        .map((declaration) => `${declaration.name}@${declaration.range.start.line}`),
    ).toEqual(["in-media@2", "in-rule@5", "in-mixin@6", "in-list@7", "in-selector@8", "at-root@9", "top@11"]);
    expect(facts.uses.filter((use) => use.kind === "placeholder").map((use) => use.text)).toEqual([
      "in-media",
      "top",
      "in-rule",
    ]);
    // The `:not(` of an `@at-root` selector is no call, and the `math.div(` of a value is one.
    expect(facts.uses.filter((use) => use.syntax === "call").map((use) => use.text)).toEqual(["div"]);
  });

  it.runIf(native)("resolves @extend to a placeholder that a media query, a rule, or a mixin declares", async () => {
    const files = {
      "m.scss": [
        "@media screen {",
        "  %in-media { a: b; }",
        "  .m { @extend %in-media; }",
        "}",
        ".rule { %in-rule { c: d; } }",
        ".r { @extend %in-rule; }",
        "@mixin mix { %in-mixin { e: f; } }",
        "@include mix;",
        ".x { @extend %in-mixin; }",
        "",
      ].join("\n"),
    };
    await withScssProject(files, async (project) => {
      expect(await scssGoto(project, "m.scss", "@extend %in-media", 0, 9)).toBe("m.scss:2");
      expect(await scssGoto(project, "m.scss", "@extend %in-rule", 0, 9)).toBe("m.scss:5");
      expect(await scssGoto(project, "m.scss", "@extend %in-mixin", 0, 9)).toBe("m.scss:7");
      for (const [needle, uses] of [
        ["%in-media {", ["m.scss:2", "m.scss:3"]],
        ["%in-rule {", ["m.scss:5", "m.scss:6"]],
        ["%in-mixin {", ["m.scss:7", "m.scss:9"]],
      ] as const) {
        const refs = await scssRefs(project, "m.scss", needle, 0, 1);
        expect(refs.sites, needle).toEqual(uses);
        expect(refs.coverage?.state, needle).toBe("complete");
      }
    });
    // Another file reaches the placeholder through `@use`, whatever block declares it.
    await withScssProject(
      {
        "_lib.scss": "@media screen {\n  %in-media { a: b; }\n}\n.rule { %in-rule { c: d; } }\n",
        "main.scss": '@use "lib";\n.a { @extend %in-rule; }\n@media screen { .b { @extend %in-media; } }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "@extend %in-rule", 0, 9)).toBe("_lib.scss:4");
        expect(await scssGoto(project, "main.scss", "@extend %in-media", 0, 9)).toBe("_lib.scss:2");
        const media = await scssRefs(project, "_lib.scss", "%in-media {", 0, 1);
        expect(media.sites).toEqual(["_lib.scss:2", "main.scss:3"]);
        expect(media.coverage?.state).toBe("complete");
      },
    );
  });

  it.runIf(native)("treats the placeholder that one file declares again as one placeholder", async () => {
    // dart-sass: `.x { @extend %btn }` extends both rules, `.x { a: b } @media screen { .x { c: d } }`.
    const source = "%btn { a: b; }\n@media screen { %btn { c: d; } }\n.x { @extend %btn; }\n";
    await withScssProject({ "m.scss": source }, async (project) => {
      expect(await scssGoto(project, "m.scss", "@extend %btn", 0, 9)).toBe("m.scss:1");
      for (const declaration of [0, 1]) {
        const refs = await scssRefs(project, "m.scss", "%btn {", declaration, 1);
        expect(refs.sites, `declaration ${declaration}`).toEqual(["m.scss:1", "m.scss:2", "m.scss:3"]);
        expect(refs.coverage?.state, `declaration ${declaration}`).toBe("complete");
      }
      // Renaming the placeholder renames the rule in the media query too.
      const renamed = await previewScssRename(project, "btn", "m.scss", "button");
      expect(renamed.conflicts).toEqual([]);
      expect(renamed.edits.map((edit) => `${edit.range.start.line}:${edit.oldText}->${edit.newText}`)).toEqual([
        "1:btn->button",
        "2:btn->button",
        "3:btn->button",
      ]);
    });
    // A mention in the middle of a selector has no index symbol. It is a site even when it comes first.
    const mid = ".z %mid .w { c: d; }\n%mid { a: b; }\n.q { @extend %mid; }\n";
    await withScssProject({ "m.scss": mid }, async (project) => {
      const refs = await scssRefs(project, "m.scss", "%mid {", 0, 1);
      expect(refs.sites).toEqual(["m.scss:1", "m.scss:2", "m.scss:3"]);
      const renamed = await previewScssRename(project, "mid", "m.scss", "center");
      expect(renamed.edits.map((edit) => `${edit.range.start.line}:${edit.range.start.column}`)).toEqual([
        "1:5",
        "2:2",
        "3:15",
      ]);
    });
    // Two files that declare the name stay ambiguous: the use may mean either one.
    await withScssProject(
      {
        "_a.scss": "%dup { a: b; }\n",
        "_b.scss": "@media screen { %dup { c: d; } }\n",
        "m.scss": '@use "a";\n@use "b";\n.x { @extend %dup; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "m.scss", "@extend %dup", 0, 9)).toBe("not_found");
        const refs = await scssRefs(project, "_a.scss", "%dup", 0, 1);
        expect(refs.coverage?.state).toBe("partial");
        expect(refs.coverage?.affectedFiles?.map((file) => project.relative(file))).toEqual(["m.scss"]);
      },
    );
  });

  it.runIf(native)("keeps the exact spelling of a placeholder in an @extend with !optional", async () => {
    // dart-sass: `%foo-bar` and `%foo_bar` are two placeholders, so `@extend %foo_bar !optional` finds none.
    const source =
      "%foo-bar { color: red; }\n.a { @extend %foo_bar !optional; }\n.b { @extend %foo-bar !optional; }\n.c { @extend %foo-bar; }\n";
    await withScssProject({ "m.scss": source }, async (project) => {
      expect(await scssGoto(project, "m.scss", "%foo_bar", 0, 1)).toBe("not_found");
      expect(await scssGoto(project, "m.scss", "%foo-bar !", 0, 1)).toBe("m.scss:1");
      const refs = await scssRefs(project, "m.scss", "%foo-bar {", 0, 1);
      expect(refs.sites).toEqual(["m.scss:1", "m.scss:3", "m.scss:4"]);
      const renamed = await previewScssRename(project, "foo-bar", "m.scss", "baz");
      expect(renamed.edits.map((edit) => edit.range.start.line)).toEqual([1, 3, 4]);
    });
    await withScssProject(
      {
        "_ph.scss": "%foo_bar { color: red; }\n",
        "main.scss": '@use "ph";\n.a { @extend %foo-bar !optional; }\n.b { @extend %foo_bar !optional; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "%foo-bar", 0, 1)).toBe("not_found");
        expect(await scssGoto(project, "main.scss", "%foo_bar", 0, 1)).toBe("_ph.scss:1");
        expect((await scssRefs(project, "_ph.scss", "%foo_bar", 0, 1)).sites).toEqual(["_ph.scss:1", "main.scss:3"]);
      },
    );
  });

  it("reads the expression of an interpolation as code and its strings and comments as text", () => {
    // dart-sass: a string inside `#{...}` is text, and the expression around it is evaluated, in a
    // quoted string, in an unquoted url(...), in a selector, in an attribute selector, and in a custom property.
    const reads = (body: string): string[] => {
      const source = `$primary: red;\n.a { ${body}; }\n`;
      return extractScssFacts(source).uses.map((use) => `${use.text}@${lineOf(source, use.nameStart)}`);
    };
    for (const literal of [
      "background: url(#{'$primary'}.svg)",
      'background: url(#{"$primary"}.svg)',
      "background: url( #{'$primary'} )",
      "content: \"#{'$primary'}\"",
      "content: '#{\"$primary\"}'",
      'content: "#{/* $primary */ 1}"',
      "--x: #{'$primary'}",
      "@debug \"#{'$primary'}\"",
      ".sel-#{'$primary'} { w: 1 }",
      "[data-x=\"#{'$primary'}\"] { w: 1 }",
    ]) {
      expect(reads(literal), literal).toEqual([]);
    }
    for (const code of [
      "background: url(#{$primary}.svg)",
      'content: "x #{$primary} y"',
      "content: \"#{ 'a' + '#{$primary}' }\"",
      ".sel-#{$primary} { w: 1 }",
    ]) {
      expect(reads(code), code).toEqual(["$primary@2"]);
    }
    expect(reads("background: url(#{map-get($primary, 'k')}.svg)"), "mixed").toEqual(["map-get@2", "$primary@2"]);
    expect(reads("background: url(#{foo('$primary')}.svg)"), "call").toEqual(["foo@2"]);
  });
});

describe("SCSS module navigation: import-only files, defaults, lookups, and selectors", () => {
  const native = isNativeTreeSitterAvailable();

  function lineOf(source: string, offset: number): number {
    return source.slice(0, offset).split("\n").length;
  }

  it("treats a bare get-function as dynamic unless this file already declared it", () => {
    // dart-sass: a bare get-function is the legacy built-in. A user function declared above the
    // call overrides it; one declared below does not own that earlier call.
    const bare = extractScssFacts('.a { x: get-function("pad"); y: get_function("pad"); }\n');
    expect(bare.dynamics.map((dynamic) => `${dynamic.form}:${dynamic.arg}`)).toEqual([
      "get-function:pad",
      "get-function:pad",
    ]);
    const before = extractScssFacts('@function get_function($name) { @return 5px; }\n.a { x: get-function("pad"); }\n');
    expect(before.dynamics).toEqual([]);
    expect(before.uses.filter((use) => use.syntax === "call").map((use) => use.text)).toEqual(["get-function"]);
    const after = extractScssFacts('.a { x: get-function("pad"); }\n@function get-function($name) { @return 5px; }\n');
    expect(after.dynamics.map((dynamic) => `${dynamic.form}:${dynamic.arg}`)).toEqual(["get-function:pad"]);
    expect(after.uses.filter((use) => use.syntax === "call").map((use) => use.text)).toEqual(["get-function"]);
  });

  it("keeps the next declaration when // sits inside url() in an interpolation", () => {
    // dart-sass compiles the rule and the following variable: url(http://...) has no comment.
    const source = '.x { content: "#{url(http://example.com/x.png)}"; }\n$later: 2;\n';
    const facts = extractScssFacts(source);
    expect(facts.declarations.map((declaration) => declaration.name)).toEqual(["$later"]);
    expect(facts.uses.map((use) => use.text)).toEqual([]);
    const nested = '$name: "a";\n.x { content: "#{url(http://example.com/#{$name}.png)}"; }\n$later: 2;\n';
    const nestedFacts = extractScssFacts(nested);
    expect(nestedFacts.declarations.map((declaration) => declaration.name)).toEqual(["$name", "$later"]);
    expect(nestedFacts.uses.map((use) => use.text)).toEqual(["$name"]);
    const hidden = '.x { content: "#{url(http://example.com/#{\"$name\"}.png)}"; }\n$later: 2;\n';
    const hiddenFacts = extractScssFacts(hidden);
    expect(hiddenFacts.declarations.map((declaration) => declaration.name)).toEqual(["$later"]);
    expect(hiddenFacts.uses).toEqual([]);
  });

  const SUPPORTS_SELECTOR = [
    "@function has($n) { @return $n; }",
    "@function selector($n) { @return 1px; }",
    ".a {",
    "  @supports selector(:has(*)) { width: has(1); }",
    "  @supports SELECTOR(:has(*)) { width: has(2); }",
    "  @supports (selector(:has(*))) { width: has(3); }",
    "  @supports selector(:is(:has(*))) { width: selector(4); }",
    "  @supports selector (:has(#{has(5)})) { width: has(6); }",
    "}",
    "@if has(7) { .b { w: 1; } }",
    "@if selector(8) { .c { w: 1; } }",
    "@media (min-width: has(9)) { .d { w: 1; } }",
    "",
  ].join("\n");

  it("does not read a pseudo-class inside @supports selector() as a Sass call", () => {
    // dart-sass keeps :has and :is inside selector() as CSS, and calls the user functions for
    // has(1) in the block, has(5) in the interpolation, @if has(7), and @if selector(8).
    const facts = extractScssFacts(SUPPORTS_SELECTOR);
    expect(
      facts.uses
        .filter((use) => use.kind === "function")
        .map((use) => `${use.text}@${lineOf(SUPPORTS_SELECTOR, use.nameStart)}`),
    ).toEqual(["has@4", "has@5", "has@6", "selector@7", "has@8", "has@8", "has@10", "selector@11", "has@12"]);
  });

  it.runIf(native)("prefers an import-only file for @import and not for @use or @forward", async () => {
    // dart-sass: @import "lib" and @import "lib.scss" load _lib.import.scss. @use and @forward load
    // _lib.scss. A directory's _index.import.scss is the same split.
    await withScssProject(
      {
        "_lib.import.scss": "$from-import: 1;\n",
        "_lib.scss": "$from-use: 2;\n",
        "legacy.scss": '@import "lib";\n.a { w: $from-import; }\n',
        "explicit.scss": '@import "lib.scss";\n.a { w: $from-import; }\n',
        "use.scss": '@use "lib";\n.a { w: lib.$from-use; }\n',
        "miss.scss": '@use "lib";\n.a { w: lib.$from-import; }\n',
        "fwd.scss": '@forward "lib";\n',
        "consumer.scss": '@use "fwd";\n.a { w: fwd.$from-use; }\n',
        "fwd-miss.scss": '@use "fwd";\n.a { w: fwd.$from-import; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "legacy.scss", "$from-import")).toBe("_lib.import.scss:1");
        expect(await scssGoto(project, "explicit.scss", "$from-import")).toBe("_lib.import.scss:1");
        expect(await scssGoto(project, "use.scss", "$from-use")).toBe("_lib.scss:1");
        expect(await scssGoto(project, "miss.scss", "$from-import")).toBe("not_found");
        expect(await scssGoto(project, "consumer.scss", "$from-use")).toBe("_lib.scss:1");
        expect(await scssGoto(project, "fwd-miss.scss", "$from-import")).toBe("not_found");
        const imported = await scssRefs(project, "_lib.import.scss", "$from-import");
        expect(imported.sites).toEqual(["_lib.import.scss:1", "explicit.scss:2", "legacy.scss:2"]);
        expect(imported.coverage?.state).toBe("complete");
        const used = await scssRefs(project, "_lib.scss", "$from-use");
        expect(used.sites).toEqual(["_lib.scss:1", "consumer.scss:2", "use.scss:2"]);
        expect(used.coverage?.state).toBe("complete");
      },
    );
    await withScssProject(
      {
        "lib/_index.import.scss": "$from-import: 1;\n",
        "lib/_index.scss": "$from-use: 2;\n",
        "legacy.scss": '@import "lib";\n.a { w: $from-import; }\n',
        "use.scss": '@use "lib";\n.a { w: lib.$from-use; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "legacy.scss", "$from-import"), "index import").toBe("lib/_index.import.scss:1");
        expect(await scssGoto(project, "use.scss", "$from-use"), "index use").toBe("lib/_index.scss:1");
      },
    );
    // Only the import-only file exists: @import loads it, and @use does not.
    await withScssProject(
      {
        "_only.import.scss": "$only: 1;\n",
        "legacy.scss": '@import "only";\n.a { w: $only; }\n',
        "use.scss": '@use "only";\n.a { w: only.$only; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "legacy.scss", "$only"), "only import").toBe("_only.import.scss:1");
        expect(await scssGoto(project, "use.scss", "$only"), "only use").toBe("not_found");
        const refs = await scssRefs(project, "_only.import.scss", "$only");
        expect(refs.sites).toEqual(["_only.import.scss:1", "legacy.scss:2"]);
        expect(refs.coverage?.state).toBe("complete");
      },
    );
    // Two import-only siblings: Sass cannot choose, so the @import is unresolved and both files
    // stay partial.
    await withScssProject(
      {
        "_lib.import.scss": "$from-partial: 1;\n",
        "lib.import.scss": "$from-plain: 2;\n",
        "main.scss": '@import "lib";\n.a { w: $from-partial; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "$from-partial"), "ambiguous").toBe("not_found");
        const partial = await scssRefs(project, "_lib.import.scss", "$from-partial");
        expect(partial.sites).toEqual(["_lib.import.scss:1"]);
        expect(partial.coverage?.state).toBe("partial");
        expect(partial.coverage?.affectedFiles?.map((file) => project.relative(file))).toEqual(["main.scss"]);
        const plain = await scssRefs(project, "lib.import.scss", "$from-plain");
        expect(plain.coverage?.state).toBe("partial");
        expect(plain.coverage?.affectedFiles?.map((file) => project.relative(file))).toEqual(["main.scss"]);
      },
    );
  });

  it.runIf(native)("treats a variable as configurable when any assignment uses !default", async () => {
    // dart-sass accepts with ($x: 2) for `$x: null; $x: 1 !default` and for `$x: 1; $x: 2 !default`.
    // `$y: 1` with no !default is not configurable.
    await withScssProject(
      {
        "_vars.scss": "$x: null;\n$x: 1 !default;\n.a { w: $x; }\n$y: 1;\n",
        "main.scss": '@use "vars" with ($x: 2, $y: 3);\n.b { w: vars.$x; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "($x", 0, 1)).toBe("_vars.scss:1");
        expect(await scssGoto(project, "main.scss", "$x", 1)).toBe("_vars.scss:1");
        expect(await scssGoto(project, "main.scss", "$y")).toBe("not_found");
        const refs = await scssRefs(project, "_vars.scss", "$x: null");
        expect(refs.sites).toEqual(["_vars.scss:1", "_vars.scss:2", "_vars.scss:3", "main.scss:1", "main.scss:2"]);
        expect(refs.coverage?.state).toBe("complete");
        const fromKey = await scssRefs(project, "main.scss", "($x", 0, 1);
        expect(fromKey.sites).toEqual(refs.sites);
        const plain = await scssRefs(project, "_vars.scss", "$y");
        expect(plain.sites).toEqual(["_vars.scss:4"]);
        expect(plain.coverage?.state).toBe("complete");
      },
    );
    await withScssProject(
      {
        "_vars.scss": "$x: 1;\n$x: 2 !default;\n",
        "main.scss": '@use "vars" with ($x: 9);\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "($x", 0, 1), "later default").toBe("_vars.scss:1");
        const refs = await scssRefs(project, "main.scss", "($x", 0, 1);
        expect(refs.sites).toEqual(["_vars.scss:1", "_vars.scss:2", "main.scss:1"]);
        expect(refs.coverage?.state).toBe("complete");
      },
    );
  });

  it.runIf(native)("treats a bare get-function as a dynamic lookup unless a user function is proved", async () => {
    for (const lookup of ['get-function("pad")', 'get_function("pad")']) {
      await withScssProject(
        {
          "_lib.scss": "@function pad() { @return 1px; }\n",
          "main.scss": `@use "lib";\n.a { w: lib.pad(); x: ${lookup}; }\n`,
        },
        async (project) => {
          const refs = await scssRefs(project, "_lib.scss", "@function pad", 0, "@function ".length);
          expect(refs.sites, lookup).toEqual(["_lib.scss:1", "main.scss:2"]);
          expect(refs.coverage?.state, lookup).toBe("partial");
          expect(
            refs.coverage?.affectedFiles?.map((file) => project.relative(file)),
            lookup,
          ).toEqual(["main.scss"]);
          const renamed = await previewScssRename(project, "pad", "_lib.scss", "inset");
          expect(renamed.safe, lookup).toBe(false);
          expect(
            renamed.unsafeSites.some((site) => site.reason === "unresolved_reference"),
            lookup,
          ).toBe(true);
        },
      );
    }
    // A function declared above the call owns it, so the string argument is not a lookup of pad.
    await withScssProject(
      {
        "m.scss":
          '@function get-function($name) { @return 5px; }\n@function pad() { @return 1px; }\n.a { w: get-function("pad"); x: pad(); }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "m.scss", 'get-function("pad")')).toBe("m.scss:1");
        const pad = await scssRefs(project, "m.scss", "@function pad", 0, "@function ".length);
        expect(pad.sites).toEqual(["m.scss:2", "m.scss:3"]);
        expect(pad.coverage?.state).toBe("complete");
        expect((await previewScssRename(project, "pad", "m.scss", "inset")).safe).toBe(true);
      },
    );
    // A function declared below the call does not own it.
    await withScssProject(
      {
        "m.scss":
          '@function pad() { @return 1px; }\n.a { w: get-function("pad"); }\n@function get-function($name) { @return 5px; }\n',
      },
      async (project) => {
        const fn = await scssRefs(project, "m.scss", "@function get-function", 0, "@function ".length);
        expect(fn.sites).toEqual(["m.scss:3"]);
        const pad = await scssRefs(project, "m.scss", "@function pad", 0, "@function ".length);
        expect(pad.coverage?.state).toBe("partial");
      },
    );
    // An imported function loaded with as * is proved, so pad's coverage stays complete.
    await withScssProject(
      {
        "_fns.scss": "@function get-function($name) { @return 7px; }\n@function pad() { @return 1px; }\n",
        "main.scss": '@use "fns" as *;\n.a { w: get_function("pad"); x: pad(); }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "get_function")).toBe("_fns.scss:1");
        const fn = await scssRefs(project, "_fns.scss", "@function get-function", 0, "@function ".length);
        expect(fn.sites).toEqual(["_fns.scss:1", "main.scss:2"]);
        expect(fn.coverage?.state).toBe("complete");
        const pad = await scssRefs(project, "_fns.scss", "@function pad", 0, "@function ".length);
        expect(pad.sites).toEqual(["_fns.scss:2", "main.scss:2"]);
        expect(pad.coverage?.state).toBe("complete");
        expect((await previewScssRename(project, "pad", "_fns.scss", "inset")).safe).toBe(true);
      },
    );
  });

  it.runIf(native)("does not rename a pseudo-class inside @supports selector()", async () => {
    await withScssProject({ "m.scss": SUPPORTS_SELECTOR }, async (project) => {
      const has = await scssRefs(project, "m.scss", "@function has", 0, "@function ".length);
      expect(has.sites).toEqual([
        "m.scss:1",
        "m.scss:10",
        "m.scss:12",
        "m.scss:4",
        "m.scss:5",
        "m.scss:6",
        "m.scss:8",
        "m.scss:8",
      ]);
      const selector = await scssRefs(project, "m.scss", "@function selector", 0, "@function ".length);
      expect(selector.sites).toEqual(["m.scss:11", "m.scss:2", "m.scss:7"]);
      const renamed = await previewScssRename(project, "has", "m.scss", "contains");
      expect(renamed.safe).toBe(true);
      const lines = SUPPORTS_SELECTOR.split("\n");
      const pseudo = new Set<string>();
      for (const [index, line] of lines.entries()) {
        let from = 0;
        while (from < line.length) {
          const at = line.indexOf(":has", from);
          if (at < 0) break;
          pseudo.add(`${index + 1}:${at + 2}`);
          from = at + 4;
        }
      }
      expect(renamed.edits.length).toBe(8);
      for (const edit of renamed.edits) {
        expect(edit.oldText).toBe("has");
        expect(pseudo.has(`${edit.range.start.line}:${edit.range.start.column}`)).toBe(false);
      }
    });
  });

  it.runIf(native)("reports a collision when a forward show list newly exposes the renamed member", async () => {
    // dart-sass: @forward "lib" show $y does not expose $x today. After $x becomes $y the show
    // entry admits it, and a star-load beside another $y is ambiguous.
    const collide = {
      "_lib.scss": "$x: 1;\n",
      "_agg.scss": '@forward "lib" show $y;\n',
      "_other.scss": "$y: 2;\n",
      "main.scss": '@use "agg" as *;\n@use "other" as *;\n.a { w: $x; }\n',
    };
    await withScssProject(collide, async (project) => {
      const renamed = await previewScssRename(project, "$x", "_lib.scss", "$y");
      expect(renamed.safe).toBe(false);
      expect(renamed.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`).sort()).toEqual([
        "name_collision:_other.scss",
      ]);
    });
    await withScssProject(
      {
        "_lib.scss": "$foo-baz: 1;\n",
        "_agg.scss": '@forward "lib" show $foo_bar;\n',
        "_other.scss": "$foo-bar: 2;\n",
        "main.scss": '@use "agg" as *;\n@use "other" as *;\n.a { w: $foo-baz; }\n',
      },
      async (project) => {
        const renamed = await previewScssRename(project, "$foo-baz", "_lib.scss", "$foo-bar");
        expect(renamed.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`)).toEqual([
          "name_collision:_other.scss",
        ]);
      },
    );
    await withScssProject(
      {
        "_lib.scss": "$x: 1;\n",
        "_agg.scss": '@forward "lib" as theme-* show $theme-y;\n',
        "_other.scss": "$theme-y: 2;\n",
        "main.scss": '@use "agg" as *;\n@use "other" as *;\n.a { w: $theme-x; }\n',
      },
      async (project) => {
        const renamed = await previewScssRename(project, "$x", "_lib.scss", "$y");
        expect(
          renamed.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`),
          "prefix",
        ).toEqual(["name_collision:_other.scss"]);
      },
    );
    // The show entry already names the member, so the rename edits it and the member stays exposed.
    await withScssProject(
      {
        ...collide,
        "_agg.scss": '@forward "lib" show $x;\n',
      },
      async (project) => {
        const renamed = await previewScssRename(project, "$x", "_lib.scss", "$y");
        expect(
          renamed.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`),
          "edited show",
        ).toEqual(["name_collision:_other.scss"]);
      },
    );
    // A namespaced consumer and a show list that names the new name, with no other $y, stay safe.
    // The show entry already spells $y, so it is not an edit.
    await withScssProject(
      {
        "_lib.scss": "$x: 1;\n",
        "_agg.scss": '@forward "lib" show $y;\n',
        "main.scss": '@use "agg";\n.a { w: agg.$x; }\n',
      },
      async (project) => {
        const renamed = await previewScssRename(project, "$x", "_lib.scss", "$y");
        expect(renamed.conflicts).toEqual([]);
        expect(renamed.safe).toBe(true);
        // `show $y` does not expose `$x` today, so `agg.$x` is not a reference and is not edited.
        expect(await scssGoto(project, "main.scss", "$x")).toBe("not_found");
        expect(renamed.edits.map((edit) => edit.file)).toEqual(["_lib.scss"]);
      },
    );
  });
});
describe("SCSS module navigation: semantic review regressions", () => {
  const native = isNativeTreeSitterAvailable();

  it.runIf(native)("does not send a differently spelled shadowing local to the module", async () => {
    for (const [moduleName, localName] of [
      ["$foo_bar", "$foo-bar"],
      ["$foo-bar", "$foo_bar"],
    ]) {
      await withScssProject(
        {
          "_colors.scss": moduleName + ": 1;\n",
          "main.scss": [
            '@use "colors" as *;',
            ".a { " + localName + ": 2; width: " + moduleName + "; }",
            ".b { width: " + moduleName + "; }",
            "",
          ].join("\n"),
        },
        async (project) => {
          expect(await scssGoto(project, "main.scss", "width: " + moduleName, 0, 7)).toBe("not_found");
          expect(await scssGoto(project, "main.scss", "width: " + moduleName, 1, 7)).toBe("_colors.scss:1");
          const refs = await scssRefs(project, "_colors.scss", moduleName);
          expect(refs.sites).toEqual(["_colors.scss:1", "main.scss:3"]);
          expect(refs.coverage?.state).toBe("complete");
        },
      );
    }
    for (const [moduleName, localName] of [
      ["$foo_bar", "$foo-bar"],
      ["$foo-bar", "$foo_bar"],
    ]) {
      await withScssProject(
        {
          "same.scss": [
            moduleName + ": 1;",
            ".a { " + localName + ": 2; width: " + moduleName + "; }",
            ".b { width: " + moduleName + "; }",
            "",
          ].join("\n"),
        },
        async (project) => {
          expect(await scssGoto(project, "same.scss", "width: " + moduleName, 0, 7)).toBe("not_found");
          expect(await scssGoto(project, "same.scss", "width: " + moduleName, 1, 7)).toBe("same.scss:1");
          expect((await scssRefs(project, "same.scss", moduleName)).sites).toEqual(["same.scss:1", "same.scss:3"]);
        },
      );
    }
  });

  it.runIf(native)("resolves real meta-named modules and inherited sass:meta lookups", async () => {
    await withScssProject(
      {
        "_helpers.scss": "@function get-function($value) { @return $value; }\n",
        "_meta.scss": "@function get-function($value) { @return $value; }\n",
        "alias.scss": '@use "helpers" as meta;\n.a { width: meta.get-function(1px); }\n',
        "default.scss": '@use "meta";\n.a { width: meta.get-function(2px); }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "alias.scss", "meta.get-function", 0, 5)).toBe("_helpers.scss:1");
        expect(await scssGoto(project, "default.scss", "meta.get-function", 0, 5)).toBe("_meta.scss:1");
        const helpers = await scssRefs(project, "_helpers.scss", "@function get-function", 0, 10);
        const meta = await scssRefs(project, "_meta.scss", "@function get-function", 0, 10);
        expect(helpers.sites).toEqual(["_helpers.scss:1", "alias.scss:2"]);
        expect(meta.sites).toEqual(["_meta.scss:1", "default.scss:2"]);
        expect(helpers.coverage?.state).toBe("complete");
        expect(meta.coverage?.state).toBe("complete");
      },
    );
    await withScssProject(
      {
        "_lib.scss": "@function pad() { @return 1px; }\n",
        "_partial.scss": '.a { width: m.get-function("pad"); }\n',
        "main.scss": '@use "sass:meta" as m;\n@use "lib";\n@import "partial";\n',
      },
      async (project) => {
        expect(await scssGoto(project, "_partial.scss", "m.get-function", 0, 2)).toBe("not_found");
        const refs = await scssRefs(project, "_lib.scss", "@function pad", 0, 10);
        expect(refs.sites).toEqual(["_lib.scss:1"]);
        expect(refs.coverage?.state).toBe("partial");
      },
    );
    await withScssProject(
      {
        "_lib.scss": "@function pad() { @return 1px; }\n",
        "_partial.scss": '$lookups: module-functions("lib");\n',
        "main.scss": '@use "sass:meta" as *;\n@use "lib";\n@import "partial";\n',
      },
      async (project) => {
        expect(await scssGoto(project, "_partial.scss", "module-functions")).toBe("not_found");
        const refs = await scssRefs(project, "_lib.scss", "@function pad", 0, 10);
        expect(refs.sites).toEqual(["_lib.scss:1"]);
        expect(refs.coverage?.state).toBe("partial");
      },
    );
    await withScssProject(
      {
        "_helpers.scss": "@function get-function($value) { @return $value; }\n",
        "_partial.scss": ".a { width: meta.get-function(1px); }\n",
        "main.scss": '@use "helpers" as meta;\n@import "partial";\n',
      },
      async (project) => {
        expect(await scssGoto(project, "_partial.scss", "meta.get-function", 0, 5)).toBe("_helpers.scss:1");
        const refs = await scssRefs(project, "_helpers.scss", "@function get-function", 0, 10);
        expect(refs.sites).toEqual(["_helpers.scss:1", "_partial.scss:1"]);
        expect(refs.coverage?.state).toBe("complete");
      },
    );
  });

  it.runIf(native)("excludes interpolated extend targets and marks both possible placeholders partial", async () => {
    const text = '@use "base";\n$suffix: "-large";\n.a { @extend %btn#{$suffix}; }\n.b { @extend %btn; }\n';
    expect(
      extractScssFacts(text)
        .uses.filter((use) => use.kind === "placeholder")
        .map((use) => use.text),
    ).toEqual(["btn"]);
    const other = [
      '$prefix: "x";',
      ".a { @extend #{$prefix}%btn; }",
      ".b { @extend %btn/* comment */#{$prefix}; }",
      "",
    ].join("\n");
    expect(extractScssFacts(other).uses.filter((use) => use.kind === "placeholder")).toEqual([]);
    await withScssProject(
      { "_base.scss": "%btn { color: red; }\n%btn-large { color: blue; }\n", "main.scss": text },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "%btn#", 0, 1)).toBe("not_found");
        expect(await scssGoto(project, "main.scss", "%btn;", 0, 1)).toBe("_base.scss:1");
        const candidates = [
          ["%btn {", ["_base.scss:1", "main.scss:4"]],
          ["%btn-large", ["_base.scss:2"]],
        ] as const;
        for (const [name, sites] of candidates) {
          const refs = await scssRefs(project, "_base.scss", name, 0, 1);
          expect(refs.sites).toEqual(sites);
          expect(refs.coverage?.state).toBe("partial");
          expect(refs.coverage?.affectedFiles?.map((file) => project.relative(file))).toEqual(["main.scss"]);
        }
        expect((await previewScssRename(project, "btn", "_base.scss", "button")).safe).toBe(false);
      },
    );
  });

  it.runIf(native)("allows forward show and hide member names before with", async () => {
    await withScssProject(
      {
        "_lib.scss": "@mixin show { color: red; }\n@mixin hide { color: blue; }\n$x: 1 !default;\n",
        "_api.scss": '@forward "lib" show show, hide with ($x: 2);\n',
        "_single.scss": '@forward "lib" show show with ($x: 2);\n',
        "_filtered.scss": '@forward "lib" hide hide;\n',
        "main.scss": [
          '@use "api";',
          '@use "filtered";',
          '@use "single";',
          ".a { @include api.show; @include api.hide; @include filtered.show; @include single.show; }",
          "",
        ].join("\n"),
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "api.show", 0, 4)).toBe("_lib.scss:1");
        expect(await scssGoto(project, "main.scss", "api.hide", 0, 4)).toBe("_lib.scss:2");
        expect(await scssGoto(project, "main.scss", "filtered.show", 0, 9)).toBe("_lib.scss:1");
        expect(await scssGoto(project, "main.scss", "single.show", 0, 7)).toBe("_lib.scss:1");
        const show = await scssRefs(project, "_lib.scss", "@mixin show", 0, 7);
        const hide = await scssRefs(project, "_lib.scss", "@mixin hide", 0, 7);
        expect(show.sites).toEqual([
          "_api.scss:1",
          "_lib.scss:1",
          "_single.scss:1",
          "main.scss:4",
          "main.scss:4",
          "main.scss:4",
        ]);
        expect(hide.sites).toEqual(["_api.scss:1", "_filtered.scss:1", "_lib.scss:2", "main.scss:4"]);
        expect(show.coverage?.state).toBe("complete");
        expect(hide.coverage?.state).toBe("complete");
      },
    );
  });
});

describe("SCSS module navigation: import order, call timing, flow, and placeholders", () => {
  const native = isNativeTreeSitterAvailable();

  it("records flow assignments, deferred calls, bracket lists, and interpolated placeholders", () => {
    const flow = '@import "vars";\n@if true {\n  $x: 2;\n}\n.a { w: $x; }\n';
    const flowFacts = extractScssFacts(flow);
    expect(flowFacts.flowAssignments.map((assignment) => assignment.canonical)).toEqual(["x"]);
    expect(flowFacts.locals.map((local) => local.spelling)).toEqual(["$x"]);
    expect(extractScssFacts('@import "vars";\n.a {\n  @if true { $x: 2; }\n  w: $x;\n}\n').flowAssignments).toEqual([]);
    expect(extractScssFacts('@if true { $x: 2; }\n@import "vars";\n').flowAssignments).toEqual([]);

    const listFacts = extractScssFacts("$size: 2px;\n@mixin box($values: [1, $size]) {\n  width: $size;\n}\n");
    expect(listFacts.locals.map((local) => local.spelling)).toEqual(["$values"]);
    expect(listFacts.uses.filter((use) => use.text === "$size")).toHaveLength(2);

    const paramFacts = extractScssFacts("@mixin box($size: [1, $size]) {\n  width: $size;\n}\n");
    const parameter = paramFacts.locals[0];
    expect(paramFacts.locals.map((local) => local.spelling)).toEqual(["$size"]);
    expect(
      paramFacts.uses
        .filter((use) => use.text === "$size")
        .map((use) => parameter !== undefined && use.nameStart < parameter.from),
    ).toEqual([true, false]);

    expect(
      extractScssFacts(".a { width: twice(2); }\n@function twice($x) { @return $x * 2; }\n").uses.find(
        (use) => use.text === "twice",
      )?.deferred,
    ).toBeUndefined();
    expect(
      extractScssFacts("@mixin m {\n  width: twice(2);\n}\n").uses.find((use) => use.text === "twice")?.deferred,
    ).toBe(true);

    const placeholderFacts = extractScssFacts("%btn { a: b; }\n%btn#{$suffix} { c: d; }\n#{$prefix}%btn { e: f; }\n");
    expect(
      placeholderFacts.declarations
        .filter((declaration) => declaration.kind === "placeholder")
        .map((declaration) => declaration.name),
    ).toEqual(["btn"]);
    expect(placeholderFacts.interpolatedPlaceholder).toBe(true);
  });

  it.runIf(native)("marks a differently spelled block local partial and leaves the module rename safe", async () => {
    for (const [moduleName, localName] of [
      ["$foo_bar", "$foo-bar"],
      ["$foo-bar", "$foo_bar"],
    ] as const) {
      const source = [
        moduleName + ": 1;",
        ".a {",
        "  " + localName + ": 2;",
        "  width: " + moduleName + ";",
        "}",
        ".b {",
        "  width: " + moduleName + ";",
        "}",
        "",
      ].join("\n");
      await withScssProject({ "same.scss": source }, async (project) => {
        expect(await scssGoto(project, "same.scss", "width: " + moduleName, 0, 7)).toBe("not_found");
        expect(await scssGoto(project, "same.scss", "width: " + moduleName, 1, 7)).toBe("same.scss:1");
        const moduleRefs = await scssRefs(project, "same.scss", moduleName);
        expect(moduleRefs.sites).toEqual(["same.scss:1", "same.scss:7"]);
        expect(moduleRefs.coverage?.state).toBe("complete");
        const localRefs = await scssRefs(project, "same.scss", localName);
        expect(localRefs.sites).toEqual(["same.scss:3"]);
        expect(localRefs.coverage?.state).toBe("partial");
        expect(localRefs.coverage?.reasons).toContain("name_equivalence_unavailable");
        expect((await previewScssRename(project, localName, "same.scss", "$gap")).safe).toBe(false);
        const renamed = await previewScssRename(project, moduleName, "same.scss", "$kept");
        expect(renamed.safe).toBe(true);
        expect(renamed.edits.map((edit) => edit.file + ":" + edit.range.start.line).sort()).toEqual([
          "same.scss:1",
          "same.scss:7",
        ]);
      });
    }
  });

  it.runIf(native)("does not let a directory import-only index override an ordinary file", async () => {
    await withScssProject(
      {
        "lib.scss": "$from-file: 1;\n",
        "lib/_index.import.scss": "$from-index: 2;\n",
        "main.scss": '@import "lib";\n.a { w: $from-file; }\n.b { w: $from-index; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "$from-file")).toBe("lib.scss:1");
        expect(await scssGoto(project, "main.scss", "$from-index")).toBe("not_found");
        const file = await scssRefs(project, "lib.scss", "$from-file");
        expect(file.sites).toEqual(["lib.scss:1", "main.scss:2"]);
        expect(file.coverage?.state).toBe("complete");
        const index = await scssRefs(project, "lib/_index.import.scss", "$from-index");
        expect(index.sites).toEqual(["lib/_index.import.scss:1"]);
        expect(index.sites).not.toContain("main.scss:3");
      },
    );
    await withScssProject(
      {
        "_lib.scss": "$from-partial: 1;\n",
        "lib/_index.import.scss": "$from-index: 2;\n",
        "main.scss": '@import "lib";\n.a { w: $from-partial; }\n.b { w: $from-index; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "$from-partial")).toBe("_lib.scss:1");
        expect(await scssGoto(project, "main.scss", "$from-index")).toBe("not_found");
        const partial = await scssRefs(project, "_lib.scss", "$from-partial");
        expect(partial.sites).toEqual(["_lib.scss:1", "main.scss:2"]);
        expect(partial.coverage?.state).toBe("complete");
      },
    );
  });

  it.runIf(native)("keeps an eager call before a function from owning that later function", async () => {
    const main = ".a { width: twice(2); }\n@function twice($x) { @return $x * 2; }\n.b { width: twice(2); }\n";
    await withScssProject({ "main.scss": main }, async (project) => {
      expect(await scssGoto(project, "main.scss", "twice", 0)).toBe("not_found");
      expect(await scssGoto(project, "main.scss", "twice", 2)).toBe("main.scss:2");
      const refs = await scssRefs(project, "main.scss", "@function twice", 0, "@function ".length);
      expect(refs.sites).toEqual(["main.scss:2", "main.scss:3"]);
      expect(refs.coverage?.state).toBe("complete");
      const renamed = await previewScssRename(project, "twice", "main.scss", "double");
      expect(renamed.safe).toBe(true);
      expect(renamed.edits.map((edit) => edit.range.start.line).sort()).toEqual([2, 3]);
    });
    await withScssProject(
      {
        "_lib.scss": "@function twice($x) { @return $x * 3; }\n",
        "main.scss":
          '@use "lib" as *;\n.a { width: twice(2); }\n@function twice($x) { @return $x * 2; }\n.b { width: twice(2); }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "twice", 0)).toBe("_lib.scss:1");
        expect(await scssGoto(project, "main.scss", "twice", 2)).toBe("main.scss:3");
        const lib = await scssRefs(project, "_lib.scss", "@function twice", 0, "@function ".length);
        expect(lib.sites).toEqual(["_lib.scss:1", "main.scss:2"]);
        expect(lib.coverage?.state).toBe("complete");
        const local = await scssRefs(project, "main.scss", "@function twice", 0, "@function ".length);
        expect(local.sites).toEqual(["main.scss:3", "main.scss:4"]);
        expect(local.coverage?.state).toBe("complete");
      },
    );
    await withScssProject(
      {
        "_lib.scss": "@function twice($x) { @return $x * 3; }\n",
        "main.scss":
          '@import "lib";\n.a { width: twice(2); }\n@function twice($x) { @return $x * 2; }\n.b { width: twice(2); }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "twice", 0)).toBe("_lib.scss:1");
        expect(await scssGoto(project, "main.scss", "twice", 2)).toBe("main.scss:3");
        const lib = await scssRefs(project, "_lib.scss", "@function twice", 0, "@function ".length);
        expect(lib.sites).toContain("main.scss:2");
        expect(lib.sites).not.toContain("main.scss:4");
        const local = await scssRefs(project, "main.scss", "@function twice", 0, "@function ".length);
        expect(local.sites).toEqual(["main.scss:3", "main.scss:4"]);
        expect(local.sites).not.toContain("main.scss:2");
        expect(lib.coverage?.state).toBe("partial");
        expect(local.coverage?.state).toBe("partial");
      },
    );
    await withScssProject(
      {
        "main.scss": "@mixin m {\n  width: twice(2);\n}\n.a { @include m; }\n@function twice($x) { @return $x * 2; }\n",
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "twice")).toBe("not_found");
        const refs = await scssRefs(project, "main.scss", "@function twice", 0, "@function ".length);
        expect(refs.sites).toEqual(["main.scss:5"]);
        expect(refs.coverage?.state).toBe("partial");
      },
    );
    await withScssProject(
      {
        "main.scss": "@function twice($x) { @return $x * 2; }\n@mixin m {\n  width: twice(2);\n}\n",
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "twice", 1)).toBe("main.scss:1");
        const refs = await scssRefs(project, "main.scss", "@function twice", 0, "@function ".length);
        expect(refs.sites).toEqual(["main.scss:1", "main.scss:3"]);
        expect(refs.coverage?.state).toBe("complete");
      },
    );
    await withScssProject(
      {
        "main.scss": "@mixin m($x: twice(1)) {\n  width: $x;\n}\n@function twice($n) { @return $n * 2; }\n",
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "twice", 0)).toBe("not_found");
        const refs = await scssRefs(project, "main.scss", "@function twice", 0, "@function ".length);
        expect(refs.sites).toEqual(["main.scss:4"]);
        expect(refs.coverage?.state).toBe("partial");
      },
    );
  });

  it.runIf(native)("joins a file-scope flow assignment to the imported variable", async () => {
    await withScssProject(
      {
        "_vars.scss": "$x: 1;\n",
        "main.scss": '@import "vars";\n@if true {\n  $x: 2;\n}\n.a { w: $x; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "$x", 0)).toBe("_vars.scss:1");
        expect(await scssGoto(project, "main.scss", "$x", 1)).toBe("_vars.scss:1");
        const refs = await scssRefs(project, "_vars.scss", "$x");
        expect(refs.sites).toEqual(["_vars.scss:1", "main.scss:3", "main.scss:5"]);
        expect(refs.coverage?.state).toBe("complete");
        const renamed = await previewScssRename(project, "$x", "_vars.scss", "$y");
        expect(renamed.safe).toBe(true);
        expect(renamed.edits.map((edit) => edit.file + ":" + edit.range.start.line).sort()).toEqual([
          "_vars.scss:1",
          "main.scss:3",
          "main.scss:5",
        ]);
      },
    );
    await withScssProject(
      {
        "_vars.scss": "$x: 1;\n",
        "main.scss": '@import "vars";\n.a {\n  @if true { $x: 2; }\n  w: $x;\n}\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "$x: 2", 0, 0)).toBe("main.scss:3");
        expect(await scssGoto(project, "main.scss", "w: $x", 0, 3)).toBe("_vars.scss:1");
        const refs = await scssRefs(project, "_vars.scss", "$x");
        expect(refs.sites).toEqual(["_vars.scss:1", "main.scss:4"]);
        expect(refs.coverage?.state).toBe("complete");
      },
    );
  });

  it.runIf(native)("reads a square-bracket list default as the outer variable", async () => {
    await withScssProject(
      {
        "main.scss": "$size: 2px;\n@mixin box($values: [1, $size]) {\n  width: $size;\n}\n",
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "$size", 1)).toBe("main.scss:1");
        expect(await scssGoto(project, "main.scss", "$size", 2)).toBe("main.scss:1");
        const refs = await scssRefs(project, "main.scss", "$size");
        expect(refs.sites).toEqual(["main.scss:1", "main.scss:2", "main.scss:3"]);
        expect(refs.coverage?.state).toBe("complete");
        const renamed = await previewScssRename(project, "$size", "main.scss", "$extent");
        expect(renamed.safe).toBe(true);
        expect(renamed.edits.map((edit) => edit.range.start.line).sort()).toEqual([1, 2, 3]);
      },
    );
  });

  it.runIf(native)("does not group an interpolated placeholder declaration under its static prefix", async () => {
    const main = [
      "%btn { a: b; }",
      "%btn#{$suffix} { c: d; }",
      "#{$prefix}%btn { e: f; }",
      ".x { @extend %btn; }",
      ".y { @extend %btn-large; }",
      "",
    ].join("\n");
    await withScssProject({ "main.scss": main }, async (project) => {
      expect(await scssGoto(project, "main.scss", "%btn#", 0, 1)).toBe("not_found");
      expect(await scssGoto(project, "main.scss", "#{$prefix}%btn", 0, 12)).toBe("not_found");
      expect(await scssGoto(project, "main.scss", "@extend %btn;", 0, 8)).toBe("main.scss:1");
      expect(await scssGoto(project, "main.scss", "%btn-large", 0, 1)).toBe("not_found");
      const refs = await scssRefs(project, "main.scss", "%btn {", 0, 1);
      expect(refs.sites).toEqual(["main.scss:1", "main.scss:4"]);
      expect(refs.coverage?.state).toBe("partial");
      expect((await previewScssRename(project, "btn", "main.scss", "button")).safe).toBe(false);
    });
  });
});

describe("SCSS module navigation: existence predicates and repeated flow assignments", () => {
  const native = isNativeTreeSitterAvailable();

  it("records existence predicates, repeated import assignments, and star-flow locals", () => {
    const meta = [
      '@use "sass:meta";',
      ".a {",
      '  a: meta.function-exists("pad", "lib");',
      '  b: meta.function_exists("pad", "lib");',
      '  c: meta.variable-exists("pad");',
      '  d: meta.variable_exists("pad");',
      '  e: meta.global-variable-exists("pad", "lib");',
      '  f: meta.global_variable_exists("pad");',
      '  g: meta.mixin-exists("pad");',
      '  h: meta.mixin_exists("pad");',
      "}",
      "",
    ].join("\n");
    expect(extractScssFacts(meta).dynamics.map((dynamic) => `${dynamic.form}:${dynamic.arg}`)).toEqual([
      "function-exists:pad",
      "function-exists:pad",
      "variable-exists:pad",
      "variable-exists:pad",
      "global-variable-exists:pad",
      "global-variable-exists:pad",
      "mixin-exists:pad",
      "mixin-exists:pad",
    ]);
    expect(extractScssFacts(meta).uses.filter((use) => use.syntax === "call")).toEqual([]);

    const bare = [
      ".a {",
      '  a: variable-exists("pad");',
      '  b: variable_exists("pad");',
      '  c: global-variable-exists("pad");',
      '  d: function-exists("pad");',
      '  e: function_exists("pad");',
      '  f: mixin-exists("pad");',
      '  g: mixin_exists("pad");',
      "}",
      "",
    ].join("\n");
    const bareFacts = extractScssFacts(bare);
    expect(bareFacts.dynamics.map((dynamic) => `${dynamic.form}:${dynamic.arg}:${dynamic.legacyBare}`)).toEqual([
      "variable-exists:pad:true",
      "variable-exists:pad:true",
      "global-variable-exists:pad:true",
      "function-exists:pad:true",
      "function-exists:pad:true",
      "mixin-exists:pad:true",
      "mixin-exists:pad:true",
    ]);
    expect(bareFacts.uses.filter((use) => use.syntax === "call").map((use) => use.text)).toEqual([
      "variable-exists",
      "variable_exists",
      "global-variable-exists",
      "function-exists",
      "function_exists",
      "mixin-exists",
      "mixin_exists",
    ]);

    const before = ["@function function_exists($name) { @return 5; }", '.a { w: function-exists("pad"); }', ""].join(
      "\n",
    );
    expect(extractScssFacts(before).dynamics).toEqual([]);
    const after = ['.a { w: mixin_exists("pad"); }', "@function mixin-exists($name) { @return 5; }", ""].join("\n");
    expect(extractScssFacts(after).dynamics.map((dynamic) => dynamic.form)).toEqual(["mixin-exists"]);
    const starOverride = [
      '@use "sass:meta" as *;',
      "@function variable-exists($name) { @return 5; }",
      '.a { w: variable-exists("pad"); }',
      "",
    ].join("\n");
    expect(extractScssFacts(starOverride).dynamics).toEqual([]);
    expect(
      extractScssFacts(starOverride)
        .uses.filter((use) => use.syntax === "call")
        .map((use) => use.text),
    ).toEqual(["variable-exists"]);
    const userMeta = ['@use "helpers" as meta;', '.a { w: meta.function-exists("pad"); }', ""].join("\n");
    expect(extractScssFacts(userMeta).dynamics).toEqual([]);
    expect(
      extractScssFacts(userMeta)
        .uses.filter((use) => use.syntax === "call")
        .map((use) => use.text),
    ).toEqual(["function-exists"]);

    const repeated = [
      '@import "vars";',
      "@if true {",
      "  $x: 2;",
      "  $x: 3;",
      "}",
      "@each $x in 1, 2 {",
      "  $x: 4;",
      "}",
      "@each $i in 1, 2 {",
      "  $x: $i;",
      "}",
      "",
    ].join("\n");
    const repeatedFacts = extractScssFacts(repeated);
    expect(repeatedFacts.flowAssignments.map((assignment) => assignment.canonical)).toEqual(["x", "x", "x"]);
    expect(repeatedFacts.locals.map((local) => local.spelling)).toEqual(["$x", "$x", "$x", "$x", "$i", "$x"]);

    const star = ['@use "vars" as *;', "@if true {", "  $x: 2;", "  $x: 3;", "}", ".b { w: $x; }", ""].join("\n");
    const starFacts = extractScssFacts(star);
    expect(starFacts.flowAssignments).toEqual([]);
    expect(starFacts.locals.map((local) => local.spelling)).toEqual(["$x", "$x"]);
  });

  it.runIf(native)("joins every file-scope import reassignment and keeps the loop variable", async () => {
    const main = [
      '@import "vars";',
      "@if true {",
      "  $x: 2;",
      "  $x: 3;",
      "  .a { w: $x; }",
      "}",
      "@each $x in 1, 2 {",
      "  $x: 4;",
      "}",
      "@each $i in 1, 2 {",
      "  $x: $i;",
      "}",
      ".b { w: $x; }",
      "",
    ].join("\n");
    await withScssProject({ "_vars.scss": "$x: 1;\n", "main.scss": main }, async (project) => {
      expect(await scssGoto(project, "main.scss", "$x: 2")).toBe("_vars.scss:1");
      expect(await scssGoto(project, "main.scss", "$x: 3")).toBe("_vars.scss:1");
      expect(await scssGoto(project, "main.scss", "w: $x", 0, 3)).toBe("_vars.scss:1");
      expect(await scssGoto(project, "main.scss", "$x: 4")).not.toBe("_vars.scss:1");
      expect(await scssGoto(project, "main.scss", "$x: $i")).toBe("_vars.scss:1");
      expect(await scssGoto(project, "main.scss", "w: $x", 1, 3)).toBe("_vars.scss:1");
      const refs = await scssRefs(project, "_vars.scss", "$x");
      expect(refs.sites).toEqual(
        ["_vars.scss:1", "main.scss:3", "main.scss:4", "main.scss:5", "main.scss:11", "main.scss:13"].sort(),
      );
      expect(refs.coverage?.state).toBe("complete");
      const renamed = await previewScssRename(project, "$x", "_vars.scss", "$y");
      expect(renamed.safe).toBe(true);
      expect(renamed.edits.map((edit) => edit.file + ":" + edit.range.start.line).sort()).toEqual(refs.sites);
    });
  });

  it.runIf(native)("keeps a star-loaded flow assignment as a local", async () => {
    // dart-sass: the assignment inside @if is a local (inner width 2) and does not change the
    // module variable (outer width 1, get() stays 1).
    const main = [
      '@use "vars" as *;',
      "@if true {",
      "  $x: 2;",
      "  .a { w: $x; }",
      "}",
      ".b { w: $x; v: get(); }",
      "",
    ].join("\n");
    await withScssProject(
      {
        "_vars.scss": ["$x: 1;", "@function get() { @return $x; }", ""].join("\n"),
        "main.scss": main,
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "$x: 2")).toBe("main.scss:3");
        expect(await scssGoto(project, "main.scss", "w: $x", 0, 3)).toBe("main.scss:3");
        expect(await scssGoto(project, "main.scss", "w: $x", 1, 3)).toBe("_vars.scss:1");
        const moduleRefs = await scssRefs(project, "_vars.scss", "$x");
        expect(moduleRefs.sites).toEqual(["_vars.scss:1", "_vars.scss:2", "main.scss:6"]);
        expect(moduleRefs.coverage?.state).toBe("complete");
        const moduleRename = await previewScssRename(project, "$x", "_vars.scss", "$y");
        expect(moduleRename.safe).toBe(true);
        expect(moduleRename.edits.map((edit) => edit.file + ":" + edit.range.start.line).sort()).toEqual(
          moduleRefs.sites,
        );
        const localRefs = await scssRefs(project, "main.scss", "$x: 2");
        expect(localRefs.sites).toEqual(["main.scss:3", "main.scss:4"]);
        expect(localRefs.coverage?.state).toBe("complete");
        const localRename = await previewScssRename(project, "$x", "main.scss", "$z");
        expect(localRename.safe).toBe(true);
        expect(localRename.edits.map((edit) => edit.range.start.line).sort()).toEqual([3, 4]);
      },
    );
  });

  it.runIf(native)("marks existence lookups partial for a local variable and a cross-file member", async () => {
    const block = [".a {", "  $pad: 1px;", '  w: variable-exists("pad");', "  width: $pad;", "}", ""].join("\n");
    await withScssProject({ "main.scss": block }, async (project) => {
      const refs = await scssRefs(project, "main.scss", "$pad");
      expect(refs.sites).toEqual(["main.scss:2", "main.scss:4"]);
      expect(refs.coverage?.state).toBe("partial");
      expect(refs.coverage?.reasons).toContain("strategy_unavailable");
      const renamed = await previewScssRename(project, "$pad", "main.scss", "$gap");
      expect(renamed.safe).toBe(false);
      expect(renamed.unsafeSites.some((site) => site.reason === "unresolved_reference")).toBe(true);
    });

    const outside = [
      ".a {",
      "  $pad: 1px;",
      "  width: $pad;",
      "}",
      ".b {",
      '  w: variable-exists("pad");',
      "}",
      "",
    ].join("\n");
    await withScssProject({ "main.scss": outside }, async (project) => {
      const refs = await scssRefs(project, "main.scss", "$pad");
      expect(refs.sites).toEqual(["main.scss:2", "main.scss:3"]);
      expect(refs.coverage?.state).toBe("complete");
      expect((await previewScssRename(project, "$pad", "main.scss", "$gap")).safe).toBe(true);
    });

    const globalOnly = [".a {", "  $pad: 1px;", '  w: global-variable-exists("pad");', "  width: $pad;", "}", ""].join(
      "\n",
    );
    await withScssProject({ "main.scss": globalOnly }, async (project) => {
      const refs = await scssRefs(project, "main.scss", "$pad");
      expect(refs.coverage?.state).toBe("complete");
      expect((await previewScssRename(project, "$pad", "main.scss", "$gap")).safe).toBe(true);
    });

    const spelled = [".a {", "  $foo_bar: 1;", '  w: variable-exists("foo-bar");', "  width: $foo_bar;", "}", ""].join(
      "\n",
    );
    await withScssProject({ "main.scss": spelled }, async (project) => {
      const refs = await scssRefs(project, "main.scss", "$foo_bar");
      expect(refs.coverage?.state).toBe("partial");
      expect((await previewScssRename(project, "$foo_bar", "main.scss", "$gap")).safe).toBe(false);
    });

    await withScssProject(
      { "main.scss": ["$pad: 1px;", '.a { w: variable_exists("pad"); width: $pad; }', ""].join("\n") },
      async (project) => {
        const refs = await scssRefs(project, "main.scss", "$pad");
        expect(refs.sites).toEqual(["main.scss:1", "main.scss:2"]);
        expect(refs.coverage?.state).toBe("partial");
        expect((await previewScssRename(project, "$pad", "main.scss", "$gap")).safe).toBe(false);
      },
    );

    const metaLocal = [
      '@use "sass:meta";',
      ".a {",
      "  $pad: 1px;",
      '  w: meta.variable-exists("pad");',
      "  width: $pad;",
      "}",
      "",
    ].join("\n");
    await withScssProject({ "main.scss": metaLocal }, async (project) => {
      const refs = await scssRefs(project, "main.scss", "$pad");
      expect(refs.coverage?.state).toBe("partial");
      expect((await previewScssRename(project, "$pad", "main.scss", "$gap")).safe).toBe(false);
    });

    for (const lookup of [
      'meta.function-exists("pad", "lib")',
      'meta.function_exists("pad", "lib")',
      'function-exists("pad")',
      'function_exists("pad")',
    ]) {
      const lines = [];
      if (lookup.startsWith("meta.")) lines.push('@use "sass:meta";');
      lines.push('@use "lib";', `.a { w: lib.pad(); x: ${lookup}; }`, "");
      await withScssProject(
        {
          "_lib.scss": "@function pad() { @return 1px; }\n",
          "main.scss": lines.join("\n"),
        },
        async (project) => {
          const refs = await scssRefs(project, "_lib.scss", "@function pad", 0, "@function ".length);
          expect(refs.sites, lookup).toContain("_lib.scss:1");
          expect(
            refs.sites.some((site) => site.startsWith("main.scss")),
            lookup,
          ).toBe(true);
          expect(refs.coverage?.state, lookup).toBe("partial");
          expect(refs.coverage?.reasons, lookup).toContain("strategy_unavailable");
          const renamed = await previewScssRename(project, "pad", "_lib.scss", "inset");
          expect(renamed.safe, lookup).toBe(false);
          expect(
            renamed.unsafeSites.some((site) => site.reason === "unresolved_reference"),
            lookup,
          ).toBe(true);
        },
      );
    }

    await withScssProject(
      {
        "_fns.scss": ["@function function-exists($name) { @return 7; }", "@function pad() { @return 1px; }", ""].join(
          "\n",
        ),
        "main.scss": ['@use "fns" as *;', '.a { w: function-exists("pad"); x: pad(); }', ""].join("\n"),
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "function-exists")).toBe("_fns.scss:1");
        const pad = await scssRefs(project, "_fns.scss", "@function pad", 0, "@function ".length);
        expect(pad.sites).toEqual(["_fns.scss:2", "main.scss:2"]);
        expect(pad.coverage?.state).toBe("complete");
        expect((await previewScssRename(project, "pad", "_fns.scss", "inset")).safe).toBe(true);
      },
    );

    await withScssProject(
      {
        "main.scss": [
          '@use "sass:meta" as *;',
          "@function variable-exists($name) { @return 5; }",
          "$pad: 1;",
          '.a { w: variable-exists("pad"); width: $pad; }',
          "",
        ].join("\n"),
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "variable-exists")).toBe("main.scss:2");
        const refs = await scssRefs(project, "main.scss", "$pad");
        expect(refs.coverage?.state).toBe("complete");
        expect((await previewScssRename(project, "$pad", "main.scss", "$gap")).safe).toBe(true);
      },
    );
  });
});

describe("SCSS module navigation: nested callables, legacy call, comments, and escapes", () => {
  it("excludes a nested mixin include from the outer mixin", async () => {
    const mixin = [
      "@mixin pad { color: red; }",
      ".a {",
      "  @include pad;",
      "  @mixin pad { color: blue; }",
      "  @include pad;",
      "}",
      ".b { @include pad; }",
      "",
    ].join("\n");
    const facts = extractScssFacts(mixin);
    const local = facts.callableLocals[0];
    expect(facts.callableLocals.map((entry) => entry.canonical)).toEqual(["pad"]);
    const includes = facts.uses.filter((use) => use.syntax === "include");
    expect(includes[0]?.nameStart).toBeLessThan(local?.from ?? 0);
    expect(includes[1]?.nameStart).toBeGreaterThanOrEqual(local?.from ?? 0);
    await withScssProject({ "main.scss": mixin }, async (project) => {
      const refs = await scssRefs(project, "main.scss", "@mixin pad", 0, "@mixin ".length);
      expect(refs.sites).toEqual(["main.scss:1", "main.scss:3", "main.scss:7"]);
      expect(refs.coverage?.state).toBe("complete");
      expect(await scssGoto(project, "main.scss", "@include pad", 0, "@include ".length)).toBe("main.scss:1");
      expect(await scssGoto(project, "main.scss", "@include pad", 1, "@include ".length)).toBe("not_found");
      expect(await scssGoto(project, "main.scss", "@include pad", 2, "@include ".length)).toBe("main.scss:1");
      const session = createAgentSession({ root: project.root, freshness: { policy: "check" } });
      try {
        const symbols = await workspaceSymbolsWithSession(session, { root: project.root, query: "pad" });
        const pos = project.position("main.scss", "pad", 0);
        const target = symbols.symbols.find(
          (symbol) => symbol.location.file.endsWith("main.scss") && symbol.location.range.start.line === pos.line,
        );
        if (!target) throw new Error("missing outer mixin");
        const renamed = await previewRenameWithSession(session, {
          root: project.root,
          handle: target.handle,
          newName: "cushion",
        });
        expect(renamed.safe).toBe(true);
        expect(renamed.edits.map((edit) => edit.range.start.line).sort()).toEqual([1, 3, 7]);
      } finally {
        session.invalidate();
      }
    });
  });
  it("excludes a nested function call from the outer function", async () => {
    const source = [
      "@function pad() { @return 1px; }",
      ".a {",
      "  width: pad();",
      "  @function pad() { @return 2px; }",
      "  width: pad();",
      "}",
      ".b { width: pad(); }",
      "",
    ].join("\n");
    await withScssProject({ "main.scss": source }, async (project) => {
      const refs = await scssRefs(project, "main.scss", "@function pad", 0, "@function ".length);
      expect(refs.sites).toEqual(["main.scss:1", "main.scss:3", "main.scss:7"]);
      expect(refs.coverage?.state).toBe("complete");
      expect(await scssGoto(project, "main.scss", "pad()", 1)).toBe("main.scss:1");
      expect(await scssGoto(project, "main.scss", "pad()", 3)).toBe("not_found");
      expect(await scssGoto(project, "main.scss", "pad()", 4)).toBe("main.scss:1");
    });
  });
  it("treats legacy call of a string name as a dynamic lookup", async () => {
    const dynamic = ["@function pad() { @return 1px; }", '.a { width: call("pad"); }', ""].join("\n");
    expect(extractScssFacts(dynamic).dynamics.map((entry) => entry.form + ":" + entry.arg)).toEqual(["call:pad"]);
    const owned = [
      "@function call($name) { @return 5px; }",
      "@function pad() { @return 1px; }",
      '.a { width: call("pad"); }',
      "",
    ].join("\n");
    expect(extractScssFacts(owned).dynamics).toEqual([]);
    await withScssProject({ "main.scss": dynamic }, async (project) => {
      const refs = await scssRefs(project, "main.scss", "pad");
      expect(refs.sites).toEqual(["main.scss:1"]);
      expect(refs.coverage?.state).toBe("partial");
      expect(refs.coverage?.reasons).toContain("strategy_unavailable");
      expect((await previewScssRename(project, "pad", "main.scss", "cushion")).safe).toBe(false);
    });
    await withScssProject({ "main.scss": owned }, async (project) => {
      const refs = await scssRefs(project, "main.scss", "@function pad", 0, "@function ".length);
      expect(refs.coverage?.state).toBe("complete");
      expect((await previewScssRename(project, "pad", "main.scss", "cushion")).safe).toBe(true);
      expect(await scssGoto(project, "main.scss", "call(")).toBe("main.scss:1");
    });
  });
  it("keeps a later call function from owning the earlier built-in", async () => {
    const source = [
      "@function pad() { @return 1px; }",
      '.a { width: call("pad"); }',
      "@function call($name) { @return 5px; }",
      "",
    ].join("\n");
    await withScssProject({ "main.scss": source }, async (project) => {
      const refs = await scssRefs(project, "main.scss", "@function pad", 0, "@function ".length);
      expect(refs.coverage?.state).toBe("partial");
      expect(await scssGoto(project, "main.scss", "call(")).toBe("not_found");
      const callRefs = await scssRefs(project, "main.scss", "@function call", 0, "@function ".length);
      expect(callRefs.sites).toEqual(["main.scss:3"]);
    });
  });
  it("does not flag a member when a star-loaded call function owns the call", async () => {
    const main = ['@use "fns" as *;', '.a { width: call("pad"); x: pad(); }', ""].join("\n");
    expect(extractScssFacts(main).dynamics.some((entry) => entry.form === "call" && entry.legacyBare)).toBe(true);
    await withScssProject(
      {
        "_fns.scss": "@function call($name) { @return 9px; }\n@function pad() { @return 1px; }\n",
        "main.scss": main,
      },
      async (project) => {
        const refs = await scssRefs(project, "_fns.scss", "@function pad", 0, "@function ".length);
        expect(refs.sites).toEqual(["_fns.scss:2", "main.scss:2"]);
        expect(refs.coverage?.state).toBe("complete");
        expect((await previewScssRename(project, "pad", "_fns.scss", "cushion")).safe).toBe(true);
      },
    );
  });
  it("treats meta.call of a string as a dynamic lookup", async () => {
    const source = [
      '@use "sass:meta";',
      "@function pad() { @return 1px; }",
      '.a { width: meta.call("pad"); }',
      "",
    ].join("\n");
    expect(extractScssFacts(source).dynamics.some((entry) => entry.form === "call" && entry.arg === "pad")).toBe(true);
    await withScssProject({ "main.scss": source }, async (project) => {
      const refs = await scssRefs(project, "main.scss", "@function pad", 0, "@function ".length);
      expect(refs.coverage?.state).toBe("partial");
      expect((await previewScssRename(project, "pad", "main.scss", "cushion")).safe).toBe(false);
    });
  });
  it("reads interpolation in a loud comment and ignores line comments", async () => {
    const source = [
      "$primary: red;",
      "/* before #{ $primary } after */",
      "// #{ $primary }",
      '/* #{ "$primary" } */',
      ".a { color: $primary; }",
      "",
    ].join("\n");
    const uses = extractScssFacts(source)
      .uses.filter((use) => use.kind === "variable")
      .map((use) => use.text);
    expect(uses).toEqual(["$primary", "$primary"]);
    await withScssProject({ "main.scss": source }, async (project) => {
      const refs = await scssRefs(project, "main.scss", "$primary");
      expect(refs.sites).toEqual(["main.scss:1", "main.scss:2", "main.scss:5"]);
      expect(refs.coverage?.state).toBe("complete");
      const renamed = await previewScssRename(project, "$primary", "main.scss", "$tone");
      expect(renamed.safe).toBe(true);
      expect(renamed.edits.map((edit) => edit.range.start.line).sort()).toEqual([1, 2, 5]);
    });
  });
  it("does not read a dollar escaped by an odd number of backslashes", async () => {
    const source = [
      "$x: 1;",
      ".a {",
      "  a: \\$x;",
      "  b: \\\\$x;",
      "  c: \\\\\\$x;",
      "  d: \\\\\\\\$x;",
      "  e: $x;",
      "}",
      "",
    ].join("\n");
    await withScssProject({ "main.scss": source }, async (project) => {
      const refs = await scssRefs(project, "main.scss", "$x");
      expect(refs.sites).toEqual(["main.scss:1", "main.scss:4", "main.scss:6", "main.scss:7"]);
      expect(refs.coverage?.state).toBe("complete");
      const renamed = await previewScssRename(project, "$x", "main.scss", "$z");
      expect(renamed.safe).toBe(true);
      expect(renamed.edits.map((edit) => edit.range.start.line).sort()).toEqual([1, 4, 6, 7]);
    });
  });
  it("resolves an underscore directory index", async () => {
    await withScssProject(
      {
        "_theme/_index.scss": "$tone: red;\n",
        "main.scss": '@use "./_theme";\n.a { color: theme.$tone; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "$tone")).toBe("_theme/_index.scss:1");
      },
    );
    await withScssProject(
      {
        "_theme.scss": "$tone: blue;\n",
        "_theme/_index.scss": "$tone: red;\n",
        "main.scss": '@use "./_theme";\n.a { color: theme.$tone; }\n',
      },
      async (project) => {
        expect(await scssGoto(project, "main.scss", "$tone")).toBe("_theme.scss:1");
      },
    );
  });
  it("records a namespaced url call when the argument is an unquoted token", async () => {
    const main = [
      '@use "lib";',
      ".a {",
      "  a: lib.url(plain);",
      "  b: lib.url($arg);",
      "  c: url(plain);",
      "}",
      "$arg: 1;",
      "",
    ].join("\n");
    const calls = extractScssFacts(main).uses.filter((use) => use.kind === "function" && use.text === "url");
    expect(calls.map((use) => use.namespace)).toEqual(["lib", "lib"]);
    await withScssProject(
      {
        "_lib.scss": "@function url($path) { @return $path; }\n",
        "main.scss": main,
      },
      async (project) => {
        const refs = await scssRefs(project, "_lib.scss", "url");
        expect(refs.sites).toEqual(["_lib.scss:1", "main.scss:3", "main.scss:4"]);
        expect(refs.coverage?.state).toBe("complete");
        expect((await previewScssRename(project, "url", "_lib.scss", "asset")).safe).toBe(true);
      },
    );
  });
  it("hides an outer mixin from an underscore spelling of the same nested name", async () => {
    const source = [
      "@mixin foo-bar { color: red; }",
      ".a {",
      "  @mixin foo_bar { color: blue; }",
      "  @include foo-bar;",
      "}",
      ".b { @include foo_bar; }",
      "",
    ].join("\n");
    await withScssProject({ "main.scss": source }, async (project) => {
      const refs = await scssRefs(project, "main.scss", "@mixin foo-bar", 0, "@mixin ".length);
      expect(refs.sites).toEqual(["main.scss:1", "main.scss:6"]);
      expect(refs.coverage?.state).toBe("complete");
      expect(await scssGoto(project, "main.scss", "@include foo-bar", 0, "@include ".length)).toBe("not_found");
      expect(await scssGoto(project, "main.scss", "@include foo_bar", 0, "@include ".length)).toBe("main.scss:1");
    });
  });
});
