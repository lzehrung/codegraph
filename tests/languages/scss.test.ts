import path from "node:path";
import { expect, it } from "vitest";
import { collectModuleSpecifiersFromSource } from "../../src/graphs.js";
import { collectGraph, collectLocalsAndExportsFromSource } from "../../src/index.js";
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
