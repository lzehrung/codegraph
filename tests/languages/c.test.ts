import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { C_SUPPORT, CPP_SUPPORT, KOTLIN_SUPPORT, type LanguageSupport } from "../../src/languages.js";
import { collectModuleSpecifiersFromSource } from "../../src/graphs.js";
import { buildProjectIndex, buildScopeIndexFromSource, findReferences, goToDefinition } from "../../src/index.js";
import { collectImportsForFile } from "../../src/indexer.js";
import { collectLocalsAndExportsFromSource } from "../../src/indexer/locals-and-exports.js";
import { getNativeQueryExecution } from "../../src/native/tree-sitter-native.js";

import { fileIdentityKey, normalizePath } from "../../src/util/paths.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

function moduleFromSource(file: string, source: string, support: LanguageSupport) {
  const native = getNativeQueryExecution(source, support);
  return collectLocalsAndExportsFromSource(file, source, support, [], { nativeQueries: native.results });
}

function localIdentity(source: string, support: LanguageSupport): string[] {
  return moduleFromSource("probe.c", source, support)
    .locals.map((local) => `${local.kind}:${local.localName}:${local.range.start.index}:${local.range.end.index}`)
    .sort();
}

function collectCFamilyNames(file: string, source: string, support: LanguageSupport) {
  const nativeQueries = getNativeQueryExecution(source, support).results;
  const module = collectLocalsAndExportsFromSource(file, source, support, [], { nativeQueries });
  return {
    exports: module.exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : [])),
    locals: module.locals.map((entry) => entry.localName),
  };
}
function moduleFromNativeQueriesWithoutTree(file: string, source: string, support: LanguageSupport) {
  const nativeQueries = getNativeQueryExecution(source, support).results;
  return collectLocalsAndExportsFromSource(file, source, support, [], { nativeQueries, nativeMode: "off" });
}

const definition: LanguageTestDefinition = {
  id: "c",
  samples: [
    {
      name: "chunks C structures",
      sourceFile: "c.sample.c",
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 2 },
        { type: "type", name: "MyStruct", startLine: 3, endLine: 5 },
        { type: "struct", name: "MyStruct", startLine: 3, endLine: 5 },
        { type: "misc", startLine: 5, endLine: 6 },
        { type: "enum", name: "Status", startLine: 7, endLine: 11 },
        { type: "function", name: "add", startLine: 12, endLine: 15 },
        { type: "macro", name: "MAX_VALUE", startLine: 16, endLine: 17 },
      ],
    },
  ],
  parity: {
    sampleDir: "c",
    exact: {
      dependencyGraph: [
        {
          from: "advanced-use.c",
          to: { type: "file", path: "function-pointers.h" },
        },
        {
          from: "main.c",
          to: { type: "file", path: "helpers.h" },
        },
        {
          from: "main.c",
          to: { type: "file", path: "utils.h" },
        },
      ],
      symbols: [
        {
          file: "advanced.h",
          symbols: [
            { name: "DEFAULT_COUNT", kind: "variable" },
            // Query-driven locals (aligned with C++) index the struct tag and the typedef name.
            { name: "AdvancedOptions", kind: "class" },
            { name: "AdvancedOptions", kind: "type" },
            { name: "count", kind: "variable" },
            { name: "Mode", kind: "type" },
            { name: "MODE_FAST", kind: "variable" },
            { name: "MODE_SLOW", kind: "variable" },
            { name: "run_advanced", kind: "function" },
            { name: "options", kind: "variable" },
          ],
        },
        {
          file: "function-pointers.h",
          symbols: [
            // A function-pointer typedef name is a `type`: the name sits inside a declarator chain,
            // so it used to be classified as a variable by the scope walk.
            { name: "Comparator", kind: "type" },
            { name: "left", kind: "variable" },
            { name: "right", kind: "variable" },
            { name: "AdvancedState", kind: "type" },
            { name: "STATE_READY", kind: "variable" },
            { name: "STATE_DONE", kind: "variable" },
            { name: "compare_values", kind: "function" },
            { name: "left", kind: "variable" },
            { name: "right", kind: "variable" },
          ],
        },
      ],
      references: [
        {
          name: "find references for function-pointer typedef",
          file: "function-pointers.h",
          line: 3,
          column: 15,
          references: [
            { file: "function-pointers.h", line: 3 },
            { file: "advanced-use.c", line: 4 },
          ],
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition resolves function-pointer typedef",
        file: "advanced-use.c",
        line: 4,
        column: 3,
        expectedDefinition: { file: "function-pointers.h", line: 3 },
      },
    ],
  },
};

runLanguageTests(definition);

function cFamilyIncludeCaptureTexts(
  source: string,
  support: LanguageSupport,
  kind: "imports" | "importBindings",
): string[] {
  const results = getNativeQueryExecution(source, support).results;
  const matches = kind === "imports" ? results?.imports : results?.importBindings;
  return (matches ?? []).flatMap((match) =>
    match.captures.filter((capture) => capture.name === "from").map((capture) => capture.text),
  );
}

describe("C quoted include resolution and same-file references", () => {
  it("resolves bare and subdirectory quoted includes while preserving explicit and angle forms", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-c-quoted-includes-"));
    const siblingHeader = path.join(root, "lib.h");
    const nestedHeader = path.join(root, "inc", "lib.h");
    const bareFile = path.join(root, "main-bare.c");
    const nestedFile = path.join(root, "main-subdirectory.c");
    const relativeFile = path.join(root, "main-relative.c");
    const angleFile = path.join(root, "main-angle.c");
    const bareSource = '#include "lib.h"\nint main(void) { return helper(1); }\n';
    const nestedSource = '#include "inc/lib.h"\nint main(void) { return nested_helper(1); }\n';
    const relativeSource = '#include "./lib.h"\nint main(void) { return helper(1); }\n';
    try {
      await mkdir(path.dirname(nestedHeader), { recursive: true });
      await Promise.all([
        writeFile(siblingHeader, "int helper(int a);\n", "utf8"),
        writeFile(nestedHeader, "int nested_helper(int a);\n", "utf8"),
        writeFile(bareFile, bareSource, "utf8"),
        writeFile(nestedFile, nestedSource, "utf8"),
        writeFile(relativeFile, relativeSource, "utf8"),
        writeFile(angleFile, "#include <lib.h>\nint main(void) { return 0; }\n", "utf8"),
      ]);

      const index = await buildProjectIndex(root, { cache: "off" });
      const importTarget = (file: string) => index.byFile.get(fileIdentityKey(file))?.imports[0]?.resolved;
      expect(importTarget(bareFile)).toBe(normalizePath(siblingHeader));
      expect(importTarget(nestedFile)).toBe(normalizePath(nestedHeader));
      expect(importTarget(relativeFile)).toBe(normalizePath(siblingHeader));
      expect(importTarget(angleFile)).toEqual({ external: "<lib.h>" });

      const bareCallColumn = bareSource.split("\n")[1]!.indexOf("helper") + 1;
      const bareGoto = await goToDefinition(index, { file: bareFile, line: 2, column: bareCallColumn });
      expect(bareGoto.status).toBe("ok");
      if (bareGoto.status === "ok") {
        expect(bareGoto.definition.file).toBe(normalizePath(siblingHeader));
        expect(bareGoto.definition.range.start.line).toBe(1);
      }

      const siblingRefs = await findReferences(index, { file: siblingHeader, line: 1, column: 5 });
      expect(siblingRefs.status).toBe("ok");
      if (siblingRefs.status === "ok") {
        expect(
          siblingRefs.references.map((reference) => ({
            file: normalizePath(reference.file),
            line: reference.range.start.line,
            column: reference.range.start.column,
          })),
        ).toEqual(
          expect.arrayContaining([
            { file: normalizePath(siblingHeader), line: 1, column: 5 },
            { file: normalizePath(bareFile), line: 2, column: bareCallColumn },
          ]),
        );
      }

      const nestedCallColumn = nestedSource.split("\n")[1]!.indexOf("nested_helper") + 1;
      const nestedGoto = await goToDefinition(index, { file: nestedFile, line: 2, column: nestedCallColumn });
      expect(nestedGoto.status).toBe("ok");
      if (nestedGoto.status === "ok") {
        expect(nestedGoto.definition.file).toBe(normalizePath(nestedHeader));
        expect(nestedGoto.definition.range.start.line).toBe(1);
      }

      const nestedRefs = await findReferences(index, { file: nestedHeader, line: 1, column: 5 });
      expect(nestedRefs.status).toBe("ok");
      if (nestedRefs.status === "ok") {
        expect(
          nestedRefs.references.map((reference) => ({
            file: normalizePath(reference.file),
            line: reference.range.start.line,
            column: reference.range.start.column,
          })),
        ).toEqual(
          expect.arrayContaining([
            { file: normalizePath(nestedHeader), line: 1, column: 5 },
            { file: normalizePath(nestedFile), line: 2, column: nestedCallColumn },
          ]),
        );
      }

      const relativeCallColumn = relativeSource.split("\n")[1]!.indexOf("helper") + 1;
      const relativeGoto = await goToDefinition(index, { file: relativeFile, line: 2, column: relativeCallColumn });
      expect(relativeGoto.status).toBe("ok");
      if (relativeGoto.status === "ok") {
        expect(relativeGoto.definition.file).toBe(normalizePath(siblingHeader));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not resolve an identifier include macro to a sibling decoy file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-c-include-macro-decoy-"));
    const decoy = path.join(root, "HEADER");
    const file = path.join(root, "main.c");
    const source = ['#define HEADER "x.h"', "#include HEADER", "int main(void) { return 0; }", ""].join("\n");
    try {
      await writeFile(decoy, "int decoy(void);\n", "utf8");
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const imports = index.byFile.get(fileIdentityKey(file))?.imports ?? [];
      expect(imports.map((entry) => entry.from)).toEqual(["HEADER"]);
      expect(imports.map((entry) => entry.resolved)).toEqual([{ external: "HEADER" }]);
      expect(imports.map((entry) => entry.resolved)).not.toContain(normalizePath(decoy));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies a quoted and a macro include of the same text per occurrence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-c-include-form-per-occurrence-"));
    const header = path.join(root, "HEADER");
    const file = path.join(root, "main.c");
    const source = ['#include "HEADER"', "#include HEADER", "int main(void) { return 0; }", ""].join("\n");
    try {
      await writeFile(header, "int decoy(void);\n", "utf8");
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const imports = index.byFile.get(fileIdentityKey(file))?.imports ?? [];
      expect(imports.map((entry) => entry.from)).toEqual(["HEADER", "HEADER"]);
      expect(imports.map((entry) => entry.resolved)).toEqual([normalizePath(header), { external: "HEADER" }]);

      const fileEdges = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file));
      expect(fileEdges).toContainEqual(expect.objectContaining({ to: { type: "file", path: normalizePath(header) } }));
      expect(fileEdges).toContainEqual(expect.objectContaining({ to: { type: "external", name: "HEADER" } }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves an angle include through resolution hints and keeps it external without them", async () => {
    const hintRoot = await mkdtemp(path.join(os.tmpdir(), "cg-c-angle-hints-"));
    const plainRoot = await mkdtemp(path.join(os.tmpdir(), "cg-c-angle-no-hints-"));
    try {
      const hintDir = path.join(hintRoot, "include");
      const hintHeader = path.join(hintDir, "lib.h");
      const hintFile = path.join(hintRoot, "main.c");
      const source = "#include <lib.h>\nint main(void) { return helper(1); }\n";
      await mkdir(hintDir, { recursive: true });
      await writeFile(hintHeader, "int helper(int a);\n", "utf8");
      await writeFile(hintFile, source, "utf8");

      const index = await buildProjectIndex(hintRoot, { cache: "off", graph: { resolutionHints: ["include"] } });
      expect(index.byFile.get(fileIdentityKey(hintFile))?.imports[0]?.resolved).toBe(normalizePath(hintHeader));
      expect(
        index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(hintFile)),
      ).toContainEqual(expect.objectContaining({ to: { type: "file", path: normalizePath(hintHeader) } }));

      const callColumn = source.split("\n")[1]!.indexOf("helper") + 1;
      const gotoResult = await goToDefinition(index, { file: hintFile, line: 2, column: callColumn });
      expect(gotoResult.status).toBe("ok");
      if (gotoResult.status === "ok") {
        expect(gotoResult.definition.file).toBe(normalizePath(hintHeader));
      }
      const refs = await findReferences(index, { file: hintHeader, line: 1, column: 5 });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references.map((reference) => normalizePath(reference.file))).toEqual(
          expect.arrayContaining([normalizePath(hintHeader), normalizePath(hintFile)]),
        );
      }

      const plainFile = path.join(plainRoot, "main.c");
      await writeFile(plainFile, source, "utf8");
      const plainIndex = await buildProjectIndex(plainRoot, { cache: "off" });
      expect(plainIndex.byFile.get(fileIdentityKey(plainFile))?.imports[0]?.resolved).toEqual({ external: "<lib.h>" });
      expect(
        plainIndex.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(plainFile)),
      ).toContainEqual(expect.objectContaining({ to: { type: "external", name: "<lib.h>" } }));
    } finally {
      await rm(hintRoot, { recursive: true, force: true });
      await rm(plainRoot, { recursive: true, force: true });
    }
  });

  it("resolves a quoted extensionless include to the exact sibling file and not a same-stem script", async () => {
    const hitRoot = await mkdtemp(path.join(os.tmpdir(), "cg-c-quoted-config-hit-"));
    const missRoot = await mkdtemp(path.join(os.tmpdir(), "cg-c-quoted-config-miss-"));
    try {
      const configFile = path.join(hitRoot, "config");
      const hitFile = path.join(hitRoot, "main.c");
      await writeFile(configFile, "int cfg(void);\n", "utf8");
      await writeFile(hitFile, '#include "config"\nint main(void) { return 0; }\n', "utf8");
      const hitIndex = await buildProjectIndex(hitRoot, { cache: "off" });
      expect(hitIndex.byFile.get(fileIdentityKey(hitFile))?.imports[0]?.resolved).toBe(normalizePath(configFile));

      const missFile = path.join(missRoot, "main.c");
      const tsDecoy = path.join(missRoot, "config.ts");
      const jsDecoy = path.join(missRoot, "config.js");
      await writeFile(tsDecoy, "export const decoy = 1;\n", "utf8");
      await writeFile(jsDecoy, "export const decoy = 2;\n", "utf8");
      await writeFile(missFile, '#include "config"\nint main(void) { return 0; }\n', "utf8");
      const missIndex = await buildProjectIndex(missRoot, { cache: "off" });
      const resolved = missIndex.byFile.get(fileIdentityKey(missFile))?.imports[0]?.resolved;
      expect(resolved).toEqual({ external: "config" });
      expect(resolved).not.toBe(normalizePath(tsDecoy));
      expect(resolved).not.toBe(normalizePath(jsDecoy));
    } finally {
      await rm(hitRoot, { recursive: true, force: true });
      await rm(missRoot, { recursive: true, force: true });
    }
  });

  it("keeps an unresolved quoted include external when hints, workspace, and node_modules could bind decoys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-c-quoted-config-decoys-"));
    try {
      const file = path.join(root, "main.c");
      await writeFile(file, '#include "config"\nint main(void) { return 0; }\n', "utf8");
      await writeFile(path.join(root, "config.ts"), "export const decoy = 1;\n", "utf8");
      await mkdir(path.join(root, "config"), { recursive: true });
      await writeFile(path.join(root, "config", "index.ts"), "export const decoy = 2;\n", "utf8");
      await mkdir(path.join(root, "node_modules", "config"), { recursive: true });
      await writeFile(
        path.join(root, "node_modules", "config", "package.json"),
        JSON.stringify({ name: "config", main: "index.ts" }),
        "utf8",
      );
      await writeFile(path.join(root, "node_modules", "config", "index.ts"), "export const decoy = 3;\n", "utf8");
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ private: true, workspaces: ["packages/*"] }),
        "utf8",
      );
      await mkdir(path.join(root, "packages", "config"), { recursive: true });
      await writeFile(
        path.join(root, "packages", "config", "package.json"),
        JSON.stringify({ name: "config", main: "index.ts" }),
        "utf8",
      );
      await writeFile(path.join(root, "packages", "config", "index.ts"), "export const decoy = 4;\n", "utf8");

      const index = await buildProjectIndex(root, {
        cache: "off",
        graph: { resolutionHints: ["."], resolveNodeModules: true },
      });
      const resolved = index.byFile.get(fileIdentityKey(file))?.imports[0]?.resolved;
      expect(resolved).toEqual({ external: "config" });
      const fileEdges = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file));
      expect(fileEdges).toContainEqual(expect.objectContaining({ to: { type: "external", name: "config" } }));
      expect(fileEdges.some((edge) => edge.to.type === "file")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a quoted include through an exact file in a configured include root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-c-quoted-config-hint-"));
    try {
      const includeDir = path.join(root, "include");
      const hintFile = path.join(includeDir, "config");
      const file = path.join(root, "main.c");
      await mkdir(includeDir, { recursive: true });
      await writeFile(hintFile, "int cfg(void);\n", "utf8");
      await writeFile(file, '#include "config"\nint main(void) { return 0; }\n', "utf8");

      const index = await buildProjectIndex(root, { cache: "off", graph: { resolutionHints: ["include"] } });
      expect(index.byFile.get(fileIdentityKey(file))?.imports[0]?.resolved).toBe(normalizePath(hintFile));
      const fileEdges = index.graph.edges.filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file));
      expect(fileEdges).toContainEqual(
        expect.objectContaining({ to: { type: "file", path: normalizePath(hintFile) } }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("attaches C calls to one enclosing function binding despite a local decoy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-c-same-file-refs-"));
    const file = path.join(root, "main.c");
    const source = [
      "int helper(void) { return 1; }",
      "int run(void) { return helper(); }",
      "int decoy_host(void) {",
      "  int helper = 2;",
      "  return helper;",
      "}",
      "",
    ].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const scope = buildScopeIndexFromSource(file, source, C_SUPPORT);
      const functionBindings = scope.all.filter((binding) => binding.kind === "function");
      expect(functionBindings.map((binding) => binding.def?.start.index).sort((left, right) => left! - right!)).toEqual(
        [source.indexOf("helper"), source.indexOf("run"), source.indexOf("decoy_host")].sort(
          (left, right) => left - right,
        ),
      );

      const callColumn = source.split("\n")[1]!.indexOf("helper") + 1;
      const gotoResult = await goToDefinition(index, { file, line: 2, column: callColumn });
      expect(gotoResult.status).toBe("ok");
      if (gotoResult.status === "ok") {
        expect(gotoResult.definition.range.start.line).toBe(1);
        expect(gotoResult.definition.range.start.column).toBe(5);
      }

      const refs = await findReferences(index, { file, line: 1, column: 5 });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(
          refs.references.map((reference) => ({
            file: normalizePath(reference.file),
            line: reference.range.start.line,
            column: reference.range.start.column,
          })),
        ).toEqual([
          { file: normalizePath(file), line: 1, column: 5 },
          { file: normalizePath(file), line: 2, column: callColumn },
        ]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps parameters navigable after the function name registers in the enclosing scope", async () => {
    // The declarator chain that carries a C function name also carries its parameter list, so a
    // fix that hides `function_declarator` from the child walk silently drops every parameter
    // binding while function-name references keep working.
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-c-parameter-scope-"));
    const file = path.join(root, "main.c");
    const source = ["int helper(int value) {", "  return value + 1;", "}", ""].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const scope = buildScopeIndexFromSource(file, source, C_SUPPORT);
      expect(scope.all.filter((binding) => binding.kind === "param").map((binding) => binding.name)).toEqual(["value"]);

      const useColumn = source.split("\n")[1]!.indexOf("value") + 1;
      const gotoResult = await goToDefinition(index, { file, line: 2, column: useColumn });
      expect(gotoResult.status).toBe("ok");
      if (gotoResult.status === "ok") {
        expect(gotoResult.definition.range.start.line).toBe(1);
        expect(gotoResult.definition.localName).toBe("value");
      }

      const refs = await findReferences(index, { file, line: 1, column: source.indexOf("value") + 1 });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references.map((reference) => reference.range.start.line)).toEqual([1, 2]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("C native queries", () => {
  it("keeps literal and identifier includes and rejects function-like include macros", async () => {
    const isolatedMacro = '#include MACRO("x.h")\n#define HAS_FOO 1\n';
    expect(cFamilyIncludeCaptureTexts(isolatedMacro, C_SUPPORT, "imports")).toEqual([]);
    expect(cFamilyIncludeCaptureTexts(isolatedMacro, C_SUPPORT, "importBindings")).toEqual([]);

    const source = [
      '#include "x.h"',
      "#include <stdio.h>",
      "#include HEADER",
      '#include MACRO("x.h")',
      "int keep(void) { return 1; }",
      "",
    ].join("\n");
    const expectedCaptures = ['"x.h"', "<stdio.h>", "HEADER"];
    const expectedSpecs = ["x.h", "<stdio.h>", "HEADER"];

    for (const support of [C_SUPPORT, CPP_SUPPORT]) {
      const imports = cFamilyIncludeCaptureTexts(source, support, "imports");
      const froms = cFamilyIncludeCaptureTexts(source, support, "importBindings");
      expect(imports).toEqual(expectedCaptures);
      expect(froms).toEqual(expectedCaptures);
      expect(imports).not.toContain("keep(void)");
      expect(froms).not.toContain("keep(void)");
      expect(collectModuleSpecifiersFromSource(support, source).map((entry) => entry.spec)).toEqual(expectedSpecs);
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "cg-c-include-forms-"));
    const file = path.join(root, "probe.c");
    try {
      await writeFile(file, source, "utf8");
      const imports = await collectImportsForFile(file, root, { source, sup: C_SUPPORT });
      expect(imports.map((entry) => entry.from)).toEqual(expectedSpecs);
      expect(imports.map((entry) => entry.kind)).toEqual(["star", "star", "star"]);
      expect(imports.map((entry) => entry.from)).not.toContain("keep(void)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exports only external non-static file-scope declarations", () => {
    // The exports query is intentionally unanchored so include-guarded headers still match; the
    // function-body filter is `exportScopeBlockers`, so this has to be asserted end to end.
    const source = [
      "#ifndef DEMO_H",
      "#define DEMO_H",
      "static int helper;",
      "static int helper_fn(void) { return 0; }",
      "int top;",
      "int f() { int sum = 0; return sum; }",
      "int static_count = 1;",
      "int ready(void) { static int once = 0; return once; }",
      "#endif",
      "",
    ].join("\n");
    const exported = moduleFromSource("probe.c", source, C_SUPPORT)
      .exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []))
      .sort();

    expect(exported).toEqual(["DEMO_H", "f", "ready", "static_count", "top"]);
    expect(exported).not.toContain("helper");
    expect(exported).not.toContain("helper_fn");
  });
});

describe("C export de-duplication", () => {
  it("exports typedef struct X {} X once", () => {
    const source = "typedef struct X { int v; } X;\n";
    const exports = moduleFromSource("once.c", source, C_SUPPORT).exports.filter(
      (entry) => entry.type === "local" && entry.exportedAs === "X",
    );
    expect(exports).toHaveLength(1);
  });

  it("collapses struct tag and typedef export rows that resolve to the same local", () => {
    const source = "struct Quad { int a; };\ntypedef struct Quad Quad;\n";
    const exports = moduleFromSource("dup.c", source, C_SUPPORT).exports.filter(
      (entry) => entry.type === "local" && entry.exportedAs === "Quad",
    );
    expect(exports).toHaveLength(1);
  });
});

describe("C vs C++ query-driven locals", () => {
  it("indexes the same locals for a representative C translation unit parsed as C or C++", () => {
    const source = [
      "#define MAX 8",
      "#define ADD(a, b) ((a) + (b))",
      "typedef struct Point { int x; int y; } Point;",
      "enum Color { RED, GREEN };",
      "int global_count;",
      "int add(int left, int right) { int sum = left + right; return sum; }",
    ].join("\n");
    expect(localIdentity(source, C_SUPPORT)).toEqual(localIdentity(source, CPP_SUPPORT));
  });

  it("follows nested typedef declarators without indexing parameter type uses", () => {
    const source = [
      "typedef int **PP;",
      "typedef int Vector[8];",
      "typedef int (*Handlers[])(int);",
      "typedef PP (*Factory)(Vector value);",
    ].join("\n");
    for (const support of [C_SUPPORT, CPP_SUPPORT]) {
      const mod = moduleFromSource("types.h", source, support);
      const aliases = mod.locals.filter((local) => local.kind === "type");
      expect(aliases.map((local) => local.localName).sort()).toEqual(["Factory", "Handlers", "PP", "Vector"]);
      expect(aliases.map((local) => source.slice(local.range.start.index, local.range.end.index))).toEqual(
        aliases.map((local) => local.localName),
      );
      expect(mod.exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : [])).sort()).toEqual([
        "Factory",
        "Handlers",
        "PP",
        "Vector",
      ]);
    }
  });

  it("exports the same header prototypes, globals, and structs as C++", () => {
    const source = "void prototype(int value);\nint counter;\nstruct Pair { int a; };";
    const cNames = collectCFamilyNames("probe.h", source, C_SUPPORT);
    const cppNames = collectCFamilyNames("probe.hpp", source, CPP_SUPPORT);

    expect(cNames.exports).toEqual(expect.arrayContaining(["prototype", "counter", "Pair"]));
    expect(cppNames.exports).toEqual(expect.arrayContaining(["prototype", "counter", "Pair"]));
    expect(cNames.locals).toEqual(expect.arrayContaining(["prototype", "counter", "Pair"]));
    expect(cppNames.locals).toEqual(expect.arrayContaining(["prototype", "counter", "Pair"]));
    expect([...cNames.exports].sort()).toEqual([...cppNames.exports].sort());
  });

  it("exports include-guarded declarations", () => {
    const source = "struct Pair { int a; };\nenum Mode { ON };\n#ifndef GUARD_H\nint guarded;\n#endif";
    const names = collectCFamilyNames("probe.h", source, C_SUPPORT);

    expect(names.exports).toEqual(expect.arrayContaining(["Pair", "Mode", "ON", "guarded"]));
    expect(names.exports.filter((name) => name === "guarded")).toEqual(["guarded"]);
    expect(names.locals).toEqual(expect.arrayContaining(["Pair", "Mode", "ON", "guarded"]));
    expect(names.exports).not.toContain("a");
  });

  it("keeps nested struct tags local while the outer struct stays exported", () => {
    const names = collectCFamilyNames("probe.h", "struct Outer { struct Inner { int x; }; };", C_SUPPORT);
    expect(names.exports).toEqual(expect.arrayContaining(["Outer"]));
    expect(names.exports).not.toContain("Inner");
    expect(names.exports).not.toContain("x");
    expect(names.locals).toEqual(expect.arrayContaining(["Outer", "Inner", "x"]));
  });
});

describe("export de-duplication for shadowed Kotlin vals", () => {
  it("keeps one export row when two patterns resolve to the same local", () => {
    const source = [
      "class Holder {",
      "    val name = 1",
      "    fun f() {",
      "        val name = 2",
      "    }",
      "}",
      "",
    ].join("\n");
    const exports = moduleFromSource("shadow.kt", source, KOTLIN_SUPPORT).exports.filter(
      (entry) => entry.type === "local" && entry.exportedAs === "name",
    );
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ type: "local", exportedAs: "name" });
    if (exports[0]?.type === "local") {
      expect(exports[0].target.range.start.line).toBe(2);
    }
  });
});

describe("C native queries without a projected tree", () => {
  it("keeps typedef and function-pointer typedef names from declarator captures", () => {
    const source = [
      "typedef int **PP;",
      "typedef int Vector[8];",
      "typedef int (*Handlers[])(int);",
      "typedef PP (*Factory)(Vector value);",
      "typedef int (*Comparator)(int, int);",
      "typedef int X;",
      "typedef int 名;",
      "typedef int (* /* note */ 回调)(int);",
    ].join("\n");
    const withTree = moduleFromSource("types.h", source, C_SUPPORT);
    const noTree = moduleFromNativeQueriesWithoutTree("types.h", source, C_SUPPORT);
    const typeNames = (mod: ReturnType<typeof moduleFromSource>) =>
      mod.locals
        .filter((local) => local.kind === "type")
        .map((local) => `${local.localName}:${local.range.start.index}:${local.range.end.index}`)
        .sort();
    expect(typeNames(noTree)).toEqual(typeNames(withTree));
    expect(typeNames(noTree)).toEqual([
      expect.stringMatching(/^Comparator:/),
      expect.stringMatching(/^Factory:/),
      expect.stringMatching(/^Handlers:/),
      expect.stringMatching(/^PP:/),
      expect.stringMatching(/^Vector:/),
      expect.stringMatching(/^X:/),
      expect.stringMatching(/^名:/),
      expect.stringMatching(/^回调:/),
    ]);
    expect(noTree.exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : [])).sort()).toEqual(
      withTree.exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : [])).sort(),
    );
    expect(
      source.slice(
        noTree.locals.find((local) => local.localName === "Comparator")!.range.start.index!,
        noTree.locals.find((local) => local.localName === "Comparator")!.range.end.index!,
      ),
    ).toBe("Comparator");
  });

  it("excludes function-local declarations while keeping include-guard and file-scope exports", () => {
    const source = [
      "#ifndef DEMO_H",
      "#define DEMO_H",
      "static int helper;",
      "static int helper_fn(void) { return 0; }",
      "int /* static is only a comment */ top;",
      "int f() { int hidden; struct Inner { int x; }; return hidden; }",
      "int static_count = 1;",
      "int ready(void) { static int once = 0; return once; }",
      "#endif",
      "",
    ].join("\n");
    const withTree = moduleFromSource("probe.c", source, C_SUPPORT)
      .exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []))
      .sort();
    const noTree = moduleFromNativeQueriesWithoutTree("probe.c", source, C_SUPPORT)
      .exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []))
      .sort();
    expect(noTree).toEqual(withTree);
    expect(noTree).toEqual(["DEMO_H", "f", "ready", "static_count", "top"]);
    expect(noTree).not.toContain("hidden");
    expect(noTree).not.toContain("Inner");
    expect(noTree).not.toContain("once");
    expect(noTree).not.toContain("helper");
    expect(noTree).not.toContain("helper_fn");
  });

  it("keeps C++ namespace members when the tree is absent", () => {
    const source =
      "namespace N { int ns_val; }\nint top;\nint f() { int hidden; return hidden; }\nauto run = []() { struct Local {}; int lambda_hidden; return 0; };\n";
    const noTree = moduleFromNativeQueriesWithoutTree("probe.hpp", source, CPP_SUPPORT)
      .exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []))
      .sort();
    expect(noTree).toEqual(expect.arrayContaining(["N", "ns_val", "top", "f"]));
    expect(noTree).not.toContain("hidden");
    expect(noTree).not.toContain("Local");
    expect(noTree).not.toContain("lambda_hidden");
    expect(noTree).toContain("run");
  });
});

describe("C function redeclarations", () => {
  it("shares call occurrences between a function prototype and definition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-c-prototype-references-"));
    try {
      const file = path.join(root, "probe.c").replace(/\\/g, "/");
      const source = [
        "int add(int left, int right);",
        "",
        "int run(void) {",
        "  return add(1, 2);",
        "}",
        "",
        "int add(int left, int right) {",
        "  return left + right;",
        "}",
        "",
      ].join("\n");
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });

      const prototypeReferences = await findReferences(index, { file, line: 1, column: 5 });
      expect(prototypeReferences.status).toBe("ok");
      if (prototypeReferences.status === "ok") {
        expect(prototypeReferences.references.map((reference) => reference.range.start.line).sort()).toEqual([1, 4]);
        expect(prototypeReferences.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
      }

      const definitionReferences = await findReferences(index, { file, line: 7, column: 5 });
      expect(definitionReferences.status).toBe("ok");
      if (definitionReferences.status === "ok") {
        expect(definitionReferences.references.map((reference) => reference.range.start.line).sort()).toEqual([4, 7]);
        expect(definitionReferences.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose incomplete C++ redeclaration occurrences", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-cpp-redeclaration-references-"));
    try {
      const file = path.join(root, "probe.cpp").replace(/\\/g, "/");
      const source = [
        "int add(int left, int right);",
        "int helper(void) { return add(1, 2); }",
        "int add(int left, int right) { return left + right; }",
        "int run(void) { return add(3, 4); }",
        "",
      ].join("\n");
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const scope = buildScopeIndexFromSource(file, source, CPP_SUPPORT);
      const bindings = scope.bindings.get("add") ?? [];
      expect(bindings).toHaveLength(2);
      expect(bindings.every((binding) => binding.occurrencesComplete === false)).toBe(true);

      const prototypeReferences = await findReferences(index, { file, line: 1, column: 5 });
      expect(prototypeReferences.status).toBe("ok");
      if (prototypeReferences.status === "ok") {
        expect(prototypeReferences.references.map((reference) => reference.range.start.line)).toEqual([1]);
        expect(prototypeReferences.referenceCoverage).toEqual({
          scope: "indexed_candidates",
          state: "partial",
          reasons: ["strategy_unavailable"],
        });
      }

      const definitionReferences = await findReferences(index, { file, line: 3, column: 5 });
      expect(definitionReferences.status).toBe("ok");
      if (definitionReferences.status === "ok") {
        expect(definitionReferences.references.map((reference) => reference.range.start.line)).toEqual([3]);
        expect(definitionReferences.referenceCoverage).toEqual({
          scope: "indexed_candidates",
          state: "partial",
          reasons: ["strategy_unavailable"],
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not assign same-file calls to C++ overloads by name alone", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-cpp-overload-references-"));
    try {
      const file = path.join(root, "probe.cpp").replace(/\\/g, "/");
      const source = [
        "int pick();",
        "int pick(int value);",
        "int zero(void) { return pick(); }",
        "int one(void) { return pick(1); }",
        "",
      ].join("\n");
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const zeroArityReferences = await findReferences(index, { file, line: 1, column: 5 });
      const oneArityReferences = await findReferences(index, { file, line: 2, column: 5 });
      expect(zeroArityReferences.status).toBe("ok");
      expect(oneArityReferences.status).toBe("ok");
      if (zeroArityReferences.status === "ok" && oneArityReferences.status === "ok") {
        expect([
          zeroArityReferences.references.map((reference) => reference.range.start.line),
          oneArityReferences.references.map((reference) => reference.range.start.line),
        ]).toEqual([[1], [2]]);
        expect(zeroArityReferences.referenceCoverage).toEqual({
          scope: "indexed_candidates",
          state: "partial",
          reasons: ["strategy_unavailable"],
        });
        expect(oneArityReferences.referenceCoverage).toEqual({
          scope: "indexed_candidates",
          state: "partial",
          reasons: ["strategy_unavailable"],
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
