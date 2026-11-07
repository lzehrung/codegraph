import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProjectIndex, buildSymbolGraphDetailed, findReferences, goToDefinition } from "../../src/index.js";
import { collectLocalsAndExportsFromSource, parseFile } from "../../src/indexer.js";
import type { SymbolGraph } from "../../src/graphs/symbol-graph.js";
import { findImplementations, findTypeHierarchy } from "../../src/indexer/type-hierarchy.js";
import type { FindReferencesResult, ProjectIndex } from "../../src/indexer/types.js";
import { normalizePath } from "../../src/util/paths.js";
import { exportedNameOf } from "../helpers/narrow.js";
import { columnOf, writeFixtureFiles } from "./callable-consumer-fixtures.js";
import { SWIFT_QUOTED_SOURCES, swiftQuotedSite } from "../helpers/swift-quoted-fixture.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { expectUnicodeSymbolRangeIdentity } from "./unicode-symbol-range.js";

const definition: LanguageTestDefinition = {
  id: "swift",
  samples: [
    {
      name: "chunks Swift structures",
      sourceFile: "swift.sample.swift",
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 2 },
        { type: "class", name: "MyClass", startLine: 3, endLine: 7 },
        { type: "function", name: "method", startLine: 4, endLine: 6 },
        { type: "misc", startLine: 7, endLine: 8 },
        { type: "struct", name: "MyStruct", startLine: 9, endLine: 11 },
        { type: "property", name: "value", startLine: 10, endLine: 10 },
        { type: "misc", startLine: 11, endLine: 12 },
        { type: "protocol", name: "MyProtocol", startLine: 13, endLine: 16 },
        { type: "function", name: "topLevel", startLine: 17, endLine: 18 },
        { type: "type", name: "Alias", startLine: 19, endLine: 20 },
        { type: "enum", name: "SampleMode", startLine: 21, endLine: 25 },
        { type: "property", name: "topValue", startLine: 26, endLine: 26 },
      ],
    },
  ],
  parity: {
    sampleDir: "swift",
    exact: {
      dependencyGraph: [
        {
          from: "AdvancedUsage.swift",
          to: { type: "file", path: "StaticMembers.swift" },
        },
        {
          from: "main.swift",
          to: { type: "file", path: "Helpers.swift" },
        },
        {
          from: "main.swift",
          to: { type: "file", path: "Utils.swift" },
        },
      ],
      symbols: [
        {
          file: "Protocols.swift",
          symbols: [
            { name: "Worker", kind: "type" },
            { name: "name", kind: "variable" },
            { name: "act", kind: "function" },
            { name: "WorkerName", kind: "type" },
            { name: "WorkerImpl", kind: "class" },
            { name: "name", kind: "variable" },
            { name: "name", kind: "variable" },
            { name: "act", kind: "function" },
            { name: "index", kind: "variable" },
          ],
        },
        {
          file: "Extensions.swift",
          symbols: [{ name: "makeDefault", kind: "function" }],
        },
        {
          file: "Actors.swift",
          symbols: [
            { name: "Counter", kind: "class" },
            { name: "value", kind: "variable" },
            { name: "increment", kind: "function" },
          ],
        },
        {
          file: "StaticMembers.swift",
          symbols: [
            { name: "Status", kind: "type" },
            { name: "ready", kind: "variable" },
            { name: "done", kind: "variable" },
            { name: "UtilityFactory", kind: "class" },
            { name: "build", kind: "function" },
          ],
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition resolves UtilityFactory from imported static members file",
        file: "AdvancedUsage.swift",
        line: 4,
        column: 10,
        expectedDefinition: { file: "StaticMembers.swift", line: 6 },
      },
    ],
  },
};

runLanguageTests(definition);

describe("Swift quoted member references", () => {
  it("includes a backtick keyword receiver use and excludes another owner's member", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-quoted-member-"));
    try {
      const main = ["struct Demo {", "  func `class`() {}", "  func run() { self.`class`() }", "}"];
      const other = ["struct Other {", "  func `class`() {}", "  func runOther() { self.`class`() }", "}"];
      const paths = await writeFixtureFiles(root, {
        "Demo.swift": `${main.join("\n")}\n`,
        "Other.swift": `${other.join("\n")}\n`,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const declaration = { file: paths["Demo.swift"]!, line: 2, column: columnOf(main, 2, "`class`") };
      const use = { file: paths["Demo.swift"]!, line: 3, column: columnOf(main, 3, "`class`") };
      const result = await findReferences(index, declaration);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Expected Swift member references");
      expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
      expect(
        result.references.map((reference) => ({
          file: reference.file,
          line: reference.range.start.line,
          column: reference.range.start.column,
        })),
      ).toEqual(expect.arrayContaining([declaration, use]));
      expect(result.references.some((reference) => reference.file === paths["Other.swift"])).toBe(false);

      const goto = await goToDefinition(index, use);
      expect(goto.status).toBe("ok");
      if (goto.status !== "ok") throw new Error("Expected the Swift member definition");
      expect(goto.definition.file).toBe(declaration.file);
      expect(goto.definition.range.start.line).toBe(declaration.line);
      const graph = await buildSymbolGraphDetailed(index);
      const caller = [...graph.nodes.values()].find((node) => node.file === declaration.file && node.name === "run");
      const targets = graph.edges.flatMap((edge) => {
        if (edge.from !== caller?.id || edge.label !== "calls") return [];
        const target = graph.nodes.get(edge.to);
        return target ? [`${target.file}::${target.name}`] : [];
      });
      expect(targets).toContain(`${declaration.file}::\`class\``);
      expect(targets).not.toContain(`${paths["Other.swift"]}::\`class\``);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift quoted and plain identifier identity", () => {
  it("resolves both spellings for functions, types, self members, imports, and extensions without decoy edges", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-quoted-identity-"));
    try {
      const paths = await writeFixtureFiles(root, SWIFT_QUOTED_SOURCES);
      const site = (name: string, line: number, token: string, occurrence = 0) =>
        swiftQuotedSite(paths, name, line, token, occurrence);
      const index = await buildProjectIndex(root, { cache: "off" });
      const cases = [
        [site("Api.swift", 5, "helper"), "Api.swift", 4],
        [site("Api.swift", 5, "helper", 1), "Api.swift", 4],
        [site("Api.swift", 9, "`helper`"), "Api.swift", 8],
        [site("Use.swift", 4, "top"), "Api.swift", 1],
        [site("Use.swift", 5, "`top`"), "Api.swift", 1],
        [site("Use.swift", 6, "regular"), "Api.swift", 2],
        [site("Use.swift", 7, "`regular`"), "Api.swift", 2],
        [site("Use.swift", 10, "Widget"), "Api.swift", 3],
        [site("Use.swift", 13, "`Widget`"), "Api.swift", 3],
        [site("Use.swift", 11, "helper"), "Api.swift", 4],
        [site("Use.swift", 12, "`helper`"), "Api.swift", 4],
        [site("Use.swift", 16, "`helper`"), "Api.swift", 8],
        [site("Imports.swift", 1, "`Widget`"), "Api.swift", 3],
        [site("Imports.swift", 2, "`top`"), "Api.swift", 1],
        [site("Imports.swift", 3, "helper"), "Api.swift", 4],
        [site("Extension.swift", 1, "Widget"), "Api.swift", 3],
        [site("Extension.swift", 4, "`Plain`"), "Api.swift", 7],
        [site("Extension.swift", 2, "`helper`"), "Api.swift", 4],
        [site("Extension.swift", 5, "helper"), "Api.swift", 8],
        [site("Api.swift", 13, "`class`"), "Api.swift", 12],
        [site("Api.swift", 16, "`default`"), "Api.swift", 15],
        [site("Other.swift", 4, "helper"), "Other.swift", 2],
        [site("Other.swift", 4, "`default`"), "Other.swift", 5],
        [site("Api.swift", 19, "`plainOnly`"), "Api.swift", 18],
        [site("Use.swift", 18, "`plainOnly`"), "Api.swift", 18],
        [site("Other.swift", 6, "plainOnly"), "Other.swift", 6],
      ] as const;
      for (const [use, name, line] of cases) {
        const result = await goToDefinition(index, use);
        expect(result.status, `${use.file}:${use.line}:${use.column}`).toBe("ok");
        if (result.status !== "ok") continue;
        expect(result.definition.file).toBe(paths[name]);
        expect(result.definition.range.start.line).toBe(line);
      }

      const graph = await buildSymbolGraphDetailed(index);
      const targets = (name: string, fromFile: string) => {
        const caller = [...graph.nodes.values()].find((node) => node.file === paths[fromFile] && node.name === name);
        expect(caller).toBeDefined();
        return graph.edges.flatMap((edge) => {
          if (edge.from !== caller?.id || (edge.label !== "calls" && edge.label !== "instantiates")) return [];
          const callee = graph.nodes.get(edge.to);
          return callee ? [`${edge.label}:${callee.file}:${callee.name}`] : [];
        });
      };
      expect(targets("invokeQuoted", "Api.swift")).toEqual([
        `calls:${paths["Api.swift"]}:\`helper\``,
        `calls:${paths["Api.swift"]}:\`helper\``,
        `calls:${paths["Api.swift"]}:\`helper\``,
      ]);
      expect(targets("invokePlain", "Api.swift")).toEqual([`calls:${paths["Api.swift"]}:helper`]);
      expect(targets("invokeSolo", "Api.swift")).toEqual([`calls:${paths["Api.swift"]}:plainOnly`]);
      expect(targets("useSolo", "Use.swift").sort()).toEqual(
        [`calls:${paths["Api.swift"]}:plainOnly`, `instantiates:${paths["Api.swift"]}:Solo`].sort(),
      );
      expect(targets("useFunctions", "Use.swift").sort()).toEqual(
        [
          `calls:${paths["Api.swift"]}:\`top\``,
          `calls:${paths["Api.swift"]}:\`top\``,
          `calls:${paths["Api.swift"]}:regular`,
          `calls:${paths["Api.swift"]}:regular`,
        ].sort(),
      );
      expect(targets("useTypes", "Use.swift").sort()).toEqual(
        [
          `instantiates:${paths["Api.swift"]}:\`Widget\``,
          `instantiates:${paths["Api.swift"]}:\`Widget\``,
          `instantiates:${paths["Api.swift"]}:Plain`,
          `calls:${paths["Api.swift"]}:\`helper\``,
          `calls:${paths["Api.swift"]}:\`helper\``,
          `calls:${paths["Api.swift"]}:\`helper\``,
          `calls:${paths["Api.swift"]}:helper`,
        ].sort(),
      );
      expect(targets("imported", "Imports.swift").sort()).toEqual(
        [
          `calls:${paths["Api.swift"]}:\`top\``,
          `instantiates:${paths["Api.swift"]}:\`Widget\``,
          `calls:${paths["Api.swift"]}:\`helper\``,
        ].sort(),
      );
      expect(targets("extensionUse", "Extension.swift")).toEqual([`calls:${paths["Api.swift"]}:\`helper\``]);
      expect(targets("extensionPlain", "Extension.swift")).toEqual([`calls:${paths["Api.swift"]}:helper`]);
      expect(targets("invokeKeyword", "Api.swift")).toEqual([`calls:${paths["Api.swift"]}:\`class\``]);
      expect(targets("invokeDefault", "Api.swift")).toEqual([`calls:${paths["Api.swift"]}:\`default\``]);
      for (const [name, file] of [
        ["invokeQuoted", "Api.swift"],
        ["useTypes", "Use.swift"],
        ["imported", "Imports.swift"],
        ["extensionUse", "Extension.swift"],
        ["extensionPlain", "Extension.swift"],
        ["invokeSolo", "Api.swift"],
        ["useSolo", "Use.swift"],
      ] as const) {
        expect(targets(name, file).some((target) => target.includes(paths["Other.swift"]!))).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift associated types and export scope", () => {
  it("indexes protocol associated types, macros, and operators", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-associated-"));
    const file = path.join(root, "example.swift");
    const source = `protocol Worker {
  associatedtype Item
  func act()
}

macro stringify(_ value: Int) = #externalMacro(module: "M", type: "T")

infix operator **
`;
    try {
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const mod = [...index.byFile.values()][0]!;
      const locals = mod.locals.map((local) => `${local.kind}:${local.localName}`);
      const exports = mod.exports.flatMap((entry) =>
        entry.type === "local" ? [`${entry.target.kind}:${entry.exportedAs}`] : [],
      );
      expect(locals).toEqual(
        expect.arrayContaining(["type:Worker", "type:Item", "function:act", "function:stringify", "function:**"]),
      );
      expect(exports).toEqual(
        expect.arrayContaining(["type:Worker", "type:Item", "function:act", "function:stringify", "function:**"]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps function-body lets and nested funcs as locals, not exports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-export-scope-"));
    const file = path.join(root, "example.swift");
    const source = `struct Container {
  func method() {}
  let member = 1
}

func outer() {
  let innerVar = 1
  func nested() {
    _ = innerVar
  }
}

let topValue = 2
func topLevel() {}
`;
    try {
      await writeFile(file, source, "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const mod = [...index.byFile.values()][0]!;
      const locals = mod.locals.map((local) => local.localName);
      const exports = mod.exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : []));
      expect(locals).toEqual(
        expect.arrayContaining([
          "Container",
          "method",
          "member",
          "outer",
          "innerVar",
          "nested",
          "topValue",
          "topLevel",
        ]),
      );
      expect(exports).toEqual(
        expect.arrayContaining(["Container", "method", "member", "outer", "topValue", "topLevel"]),
      );
      expect(exports).not.toContain("innerVar");
      expect(exports).not.toContain("nested");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not export members of a function-local type", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-local-type-"));
    const file = path.join(root, "example.swift");
    await writeFile(
      file,
      ["func outer() {", "    struct Local {", "        func hidden() {}", "    }", "}", "func keep() {}", ""].join(
        "\n",
      ),
      "utf8",
    );
    try {
      const parsed = await parseFile(file);
      const mod = collectLocalsAndExportsFromSource(file, parsed.source, parsed.sup, [], {
        ...(parsed.nativeQueries === undefined ? {} : { nativeQueries: parsed.nativeQueries }),
      });
      const localNames = mod.locals.map((entry) => entry.localName);
      const exportedNames = mod.exports.map(exportedNameOf);
      expect(localNames).toEqual(expect.arrayContaining(["outer", "Local", "hidden", "keep"]));
      expect(exportedNames).toEqual(expect.arrayContaining(["outer", "keep"]));
      expect(exportedNames).not.toContain("hidden");
      expect(exportedNames).not.toContain("Local");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not export members of a closure-local type", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-closure-type-"));
    const file = path.join(root, "example.swift");
    await writeFile(
      file,
      [
        "class Outer {",
        "    class Inner {",
        "        func deep() {}",
        "    }",
        "}",
        "let handler = {",
        "    struct Local {",
        "        func hidden() {}",
        "    }",
        "}",
        "func keep() {}",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      const parsed = await parseFile(file);
      const mod = collectLocalsAndExportsFromSource(file, parsed.source, parsed.sup, [], {
        ...(parsed.nativeQueries === undefined ? {} : { nativeQueries: parsed.nativeQueries }),
      });
      const localNames = mod.locals.map((entry) => entry.localName);
      const exportedNames = mod.exports.map(exportedNameOf);
      expect(localNames).toEqual(expect.arrayContaining(["handler", "Local", "hidden", "keep", "deep"]));
      expect(exportedNames).toEqual(expect.arrayContaining(["handler", "keep", "Outer", "Inner", "deep"]));
      expect(exportedNames).not.toContain("hidden");
      expect(exportedNames).not.toContain("Local");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift Unicode symbol ranges (C11)", () => {
  it("publishes a UTF-16 string index for a function name preceded by multibyte text", async () => {
    await expectUnicodeSymbolRangeIdentity({
      fileName: "widget.swift",
      source: "// café ☕ prüfung\n/* über */ func créer() -> Int {\n\treturn 1\n}\n",
      symbolName: "créer",
    });
  });
});

describe("Swift same-module and shared-owner visibility", () => {
  // #378: Swift files in one module see each other's top-level declarations without an import,
  // and an extension in another file is the same owner as the type it extends.
  it("resolves a same-module sibling function and excludes a same-named member elsewhere", async () => {
    const apiLines = ["func target(_ value: Int) -> Int { return value }"];
    const useLines = ["func caller() -> Int { return target(1) }"];
    const decoyLines = [
      "class Decoy {",
      "  func target(_ value: Int) -> Int { return 0 }",
      "}",
      "",
      "func decoyCaller(d: Decoy) -> Int { return d.target(1) }",
    ];
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-module-peer-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "Api.swift": `${apiLines.join("\n")}\n`,
        "Use.swift": `${useLines.join("\n")}\n`,
        "Decoy.swift": `${decoyLines.join("\n")}\n`,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const apiPath = paths["Api.swift"]!;
      const usePath = paths["Use.swift"]!;
      const decoyPath = paths["Decoy.swift"]!;

      const goto = await goToDefinition(index, {
        file: usePath,
        line: 1,
        column: columnOf(useLines, 1, "target"),
      });
      expect(goto.status).toBe("ok");
      if (goto.status !== "ok") throw new Error("Expected the same-module function declaration");
      expect(normalizePath(goto.definition.file)).toBe(apiPath);
      expect(goto.definition.range.start.line).toBe(1);

      const references = await findReferences(index, {
        file: apiPath,
        line: 1,
        column: columnOf(apiLines, 1, "target"),
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected same-module function references");
      const sites = references.references.map(
        (reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`,
      );
      expect(sites).toContain(`${usePath}:1`);
      expect(references.references.some((reference) => normalizePath(reference.file) === decoyPath)).toBe(false);

      const graph = await buildSymbolGraphDetailed(index);
      const callerNode = [...graph.nodes.values()].find(
        (node) => node.name === "caller" && normalizePath(node.file) === usePath,
      );
      expect(callerNode).toBeDefined();
      const callTargets: string[] = [];
      for (const edge of graph.edges) {
        if (edge.label !== "calls" || edge.from !== callerNode!.id) continue;
        const node = graph.nodes.get(edge.to);
        if (node) {
          callTargets.push(`${normalizePath(node.file)}::${node.name}`);
        }
      }
      expect(callTargets).toContain(`${apiPath}::target`);
      expect(callTargets.some((target) => target.startsWith(`${decoyPath}::`))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("connects an extension member call to the base type in another file", async () => {
    const baseLines = ["struct Box {", "  func helper() {}", "}"];
    const extensionLines = ["extension Box {", "  func use() { self.helper() }", "}"];
    const decoyLines = [
      "struct Other {",
      "  func helper() {}",
      "}",
      "",
      "extension Other {",
      "  func useOther() { self.helper() }",
      "}",
    ];
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-extension-owner-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "A.swift": `${baseLines.join("\n")}\n`,
        "B.swift": `${extensionLines.join("\n")}\n`,
        "C.swift": `${decoyLines.join("\n")}\n`,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const basePath = paths["A.swift"]!;
      const extensionPath = paths["B.swift"]!;
      const decoyPath = paths["C.swift"]!;

      const goto = await goToDefinition(index, {
        file: extensionPath,
        line: 2,
        column: columnOf(extensionLines, 2, "helper"),
      });
      expect(goto.status).toBe("ok");
      if (goto.status !== "ok") throw new Error("Expected the extended-type member declaration");
      expect(normalizePath(goto.definition.file)).toBe(basePath);
      expect(goto.definition.range.start.line).toBe(2);

      const references = await findReferences(index, {
        file: basePath,
        line: 2,
        column: columnOf(baseLines, 2, "helper"),
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected extended-type member references");
      const sites = references.references.map(
        (reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`,
      );
      expect(sites).toContain(`${extensionPath}:2`);
      expect(references.references.some((reference) => normalizePath(reference.file) === decoyPath)).toBe(false);

      const graph = await buildSymbolGraphDetailed(index);
      const useNode = [...graph.nodes.values()].find(
        (node) => node.name === "use" && normalizePath(node.file) === extensionPath,
      );
      expect(useNode).toBeDefined();
      const callTargets: string[] = [];
      for (const edge of graph.edges) {
        if (edge.label !== "calls" || edge.from !== useNode!.id) continue;
        const node = graph.nodes.get(edge.to);
        if (node) {
          callTargets.push(`${normalizePath(node.file)}::${node.name}`);
        }
      }
      expect(callTargets).toContain(`${basePath}::helper`);
      expect(callTargets.some((target) => target.startsWith(`${decoyPath}::`))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes cross-file hidden extension members and keeps visible and same-file members", async () => {
    const baseLines = ["struct Box {", "  func use() { self.hidden(); self.shown(); self.masked() }", "}"];
    const extensionLines = [
      "extension Box {",
      "  fileprivate func hidden() {}",
      "  func shown() {}",
      "  func sameFile() { self.hidden() }",
      "}",
      "private extension Box {",
      "  func masked() {}",
      "  func samePrivateExtension() { self.masked() }",
      "}",
    ];
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-extension-visibility-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "A.swift": `${baseLines.join("\n")}\n`,
        "B.swift": `${extensionLines.join("\n")}\n`,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const basePath = paths["A.swift"]!;
      const extensionPath = paths["B.swift"]!;

      const hiddenGoto = await goToDefinition(index, {
        file: basePath,
        line: 2,
        column: columnOf(baseLines, 2, "hidden"),
      });
      expect(hiddenGoto.status).toBe("not_found");

      const shownGoto = await goToDefinition(index, {
        file: basePath,
        line: 2,
        column: columnOf(baseLines, 2, "shown"),
      });
      expect(shownGoto.status).toBe("ok");
      if (shownGoto.status !== "ok") throw new Error("Expected the visible extension member");
      expect(normalizePath(shownGoto.definition.file)).toBe(extensionPath);
      expect(shownGoto.definition.range.start.line).toBe(3);

      const maskedGoto = await goToDefinition(index, {
        file: basePath,
        line: 2,
        column: columnOf(baseLines, 2, "masked"),
      });
      expect(maskedGoto.status).toBe("not_found");

      const sameFileGoto = await goToDefinition(index, {
        file: extensionPath,
        line: 4,
        column: columnOf(extensionLines, 4, "hidden"),
      });
      expect(sameFileGoto.status).toBe("ok");
      if (sameFileGoto.status !== "ok") throw new Error("Expected the same-file private member");
      expect(normalizePath(sameFileGoto.definition.file)).toBe(extensionPath);
      expect(sameFileGoto.definition.range.start.line).toBe(2);

      const sameMaskedGoto = await goToDefinition(index, {
        file: extensionPath,
        line: 8,
        column: columnOf(extensionLines, 8, "masked"),
      });
      expect(sameMaskedGoto.status).toBe("ok");
      if (sameMaskedGoto.status !== "ok") throw new Error("Expected the same-file private extension member");
      expect(normalizePath(sameMaskedGoto.definition.file)).toBe(extensionPath);
      expect(sameMaskedGoto.definition.range.start.line).toBe(7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps constrained extension members off unproven receivers but resolves proven peers", async () => {
    const baseLines = [
      "struct Box<T> {",
      "  func plain() {}",
      "  func use() { self.constrainedOnly(); self.plain() }",
      "  func bareUse() { constrainedOnly(); plain() }",
      "  fileprivate func hidden() {}",
      "}",
      "extension Box where T == Int { func localOnly() {} }",
    ];
    const intLines = [
      "extension Box where T == Int {",
      "  func constrainedOnly() {}",
      "  func invoke() { self.constrainedOnly(); self.plain(); self.extra(); self.stringOnly(); self.hidden() }",
      "  func bareInvoke() { plain(); extra(); stringOnly() }",
      "  func localShadow() { func extra() {}; extra() }",
      "}",
      "extension Box where T == String { func stringOnly() {} }",
      "func extra() {}",
    ];
    const peerLines = ["extension Box where T /* same requirement */  ==  Int { func extra() {} }"];
    const plainLines = ["extension Box {", "  func invoke() { self.plain(); self.constrainedOnly() }", "}"];
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-constrained-owner-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "A.swift": `${baseLines.join("\n")}\n`,
        "B.swift": `${intLines.join("\n")}\n`,
        "C.swift": `${peerLines.join("\n")}\n`,
        "D.swift": `${plainLines.join("\n")}\n`,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const basePath = paths["A.swift"]!;
      const intPath = paths["B.swift"]!;
      const peerPath = paths["C.swift"]!;
      const plainPath = paths["D.swift"]!;
      for (const [file, lines, line, member] of [
        [basePath, baseLines, 3, "constrainedOnly"],
        [basePath, baseLines, 4, "constrainedOnly"],
        [plainPath, plainLines, 2, "constrainedOnly"],
        [intPath, intLines, 3, "stringOnly"],
        [intPath, intLines, 3, "hidden"],
        [intPath, intLines, 4, "stringOnly"],
      ] as const) {
        const result = await goToDefinition(index, { file, line, column: columnOf(lines, line, member) });
        expect(result.status).toBe("not_found");
      }
      for (const [file, lines, line, member, target, targetLine] of [
        [intPath, intLines, 3, "plain", basePath, 2],
        [intPath, intLines, 3, "constrainedOnly", intPath, 2],
        [intPath, intLines, 3, "extra", peerPath, 1],
        [intPath, intLines, 4, "plain", basePath, 2],
        [intPath, intLines, 4, "extra", peerPath, 1],
        [plainPath, plainLines, 2, "plain", basePath, 2],
        [basePath, baseLines, 4, "plain", basePath, 2],
      ] as const) {
        const result = await goToDefinition(index, { file, line, column: columnOf(lines, line, member) });
        expect(result.status, file + ":" + line + " " + member).toBe("ok");
        if (result.status !== "ok") throw new Error("Expected a proven Swift member");
        expect(normalizePath(result.definition.file), file + ":" + line + " " + member).toBe(target);
        expect(result.definition.range.start.line).toBe(targetLine);
      }
      const shadow = await goToDefinition(index, {
        file: intPath,
        line: 5,
        column: intLines[4]!.lastIndexOf("extra") + 1,
      });
      expect(shadow.status).toBe("ok");
      if (shadow.status !== "ok") throw new Error("Expected a method-local Swift function");
      expect(shadow.definition.range.start.line).toBe(5);
      const references = await findReferences(index, {
        file: intPath,
        line: 2,
        column: columnOf(intLines, 2, "constrainedOnly"),
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected constrained Swift member references");
      expect(
        references.references.some(
          (reference) => normalizePath(reference.file) === basePath && reference.range.start.line === 4,
        ),
      ).toBe(false);
      const nominalReferences = await findReferences(index, {
        file: basePath,
        line: 2,
        column: columnOf(baseLines, 2, "plain"),
      });
      expect(nominalReferences.status).toBe("ok");
      if (nominalReferences.status !== "ok") throw new Error("Expected visible nominal member references");
      expect(
        nominalReferences.references.some(
          (reference) => normalizePath(reference.file) === intPath && reference.range.start.line === 4,
        ),
      ).toBe(true);
      const graph = await buildSymbolGraphDetailed(index);
      const target = [...graph.nodes.values()].find(
        (node) => node.name === "constrainedOnly" && normalizePath(node.file) === intPath,
      );
      const nominal = [...graph.nodes.values()].find(
        (node) => node.name === "Box" && normalizePath(node.file) === basePath,
      );
      const baseUse = [...graph.nodes.values()].find(
        (node) => node.name === "use" && normalizePath(node.file) === basePath,
      );
      const bareUse = [...graph.nodes.values()].find(
        (node) => node.name === "bareUse" && normalizePath(node.file) === basePath,
      );
      const intInvoke = [...graph.nodes.values()].find(
        (node) => node.name === "invoke" && normalizePath(node.file) === intPath,
      );
      const intBareInvoke = [...graph.nodes.values()].find(
        (node) => node.name === "bareInvoke" && normalizePath(node.file) === intPath,
      );
      expect(target).toBeDefined();
      expect(nominal).toBeDefined();
      expect(baseUse).toBeDefined();
      expect(bareUse).toBeDefined();
      expect(intInvoke).toBeDefined();
      expect(intBareInvoke).toBeDefined();
      expect(
        graph.edges.some((edge) => edge.from === target!.id && edge.to === nominal!.id && edge.label === "member_of"),
      ).toBe(false);
      expect(
        graph.edges.some((edge) => edge.from === baseUse!.id && edge.to === target!.id && edge.label === "calls"),
      ).toBe(false);
      expect(
        graph.edges.some((edge) => edge.from === bareUse!.id && edge.to === target!.id && edge.label === "calls"),
      ).toBe(false);
      expect(
        graph.edges.some(
          (edge) => edge.from === bareUse!.id && graph.nodes.get(edge.to)?.name === "plain" && edge.label === "calls",
        ),
      ).toBe(true);
      const calls = graph.edges.filter((edge) => edge.from === intInvoke!.id && edge.label === "calls");
      expect(calls.some((edge) => edge.to === target!.id)).toBe(true);
      expect(
        calls.some((edge) => {
          const node = graph.nodes.get(edge.to);
          return node?.name === "plain" && normalizePath(node.file) === basePath;
        }),
      ).toBe(true);
      expect(
        calls.some((edge) => {
          const node = graph.nodes.get(edge.to);
          return node?.name === "extra" && normalizePath(node.file) === peerPath;
        }),
      ).toBe(true);
      expect(
        calls.some((edge) => {
          const node = graph.nodes.get(edge.to);
          return node?.name === "extra" && normalizePath(node.file) === intPath;
        }),
      ).toBe(false);
      expect(calls.some((edge) => graph.nodes.get(edge.to)?.name === "hidden")).toBe(false);
      const bareCalls = graph.edges.filter((edge) => edge.from === intBareInvoke!.id && edge.label === "calls");
      expect(
        bareCalls.some((edge) => {
          const node = graph.nodes.get(edge.to);
          return node?.name === "extra" && normalizePath(node.file) === peerPath;
        }),
      ).toBe(true);
      expect(
        bareCalls.some((edge) => {
          const node = graph.nodes.get(edge.to);
          return node?.name === "extra" && normalizePath(node.file) === intPath;
        }),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("shares constrained extension members across plain and quoted identifier tokens", async () => {
    const api = ["struct Box<T> {}", "extension Box where T == Int { func helper() {} }"];
    const use = ["extension `Box` where T == `Int` { func caller() { self.helper() } }"];
    const decoy = ["extension Box where T == String { func helper() {} }"];
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-quoted-constraint-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "Api.swift": `${api.join("\n")}\n`,
        "Use.swift": `${use.join("\n")}\n`,
        "Decoy.swift": `${decoy.join("\n")}\n`,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const apiPath = paths["Api.swift"]!;
      const usePath = paths["Use.swift"]!;
      const decoyPath = paths["Decoy.swift"]!;
      const result = await goToDefinition(index, {
        file: usePath,
        line: 1,
        column: columnOf(use, 1, "helper"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Expected the plain-constraint extension member");
      expect(normalizePath(result.definition.file)).toBe(apiPath);
      expect(result.definition.range.start.line).toBe(2);

      const references = await findReferences(index, {
        file: apiPath,
        line: 2,
        column: columnOf(api, 2, "helper"),
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected constrained extension references");
      expect(references.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
      expect(
        references.references.map((reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`),
      ).toEqual([`${apiPath}:2`, `${usePath}:1`]);
      expect(references.references.some((reference) => normalizePath(reference.file) === decoyPath)).toBe(false);

      const graph = await buildSymbolGraphDetailed(index);
      const caller = [...graph.nodes.values()].find(
        (node) => node.name === "caller" && normalizePath(node.file) === usePath,
      );
      expect(caller).toBeDefined();
      const targets = graph.edges
        .filter((edge) => edge.label === "calls" && edge.from === caller!.id)
        .map((edge) => graph.nodes.get(edge.to))
        .filter((node) => node !== undefined);
      expect(targets.map((node) => `${normalizePath(node.file)}:${node.name}`)).toEqual([`${apiPath}:helper`]);
      expect(targets.some((node) => normalizePath(node.file) === decoyPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift inherited methods named like types", () => {
  it("calls an inherited method that shares a module type's name instead of constructing the type", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-method-named-like-type-"));
    try {
      const lines = [
        "class Foo {}",
        "class Base {",
        "  func Foo() -> Int { return 1 }",
        "}",
        "class Derived: Base {",
        "  func use() -> Int { return Foo() }",
        "}",
        "",
      ];
      const file = normalizePath(path.join(root, "a.swift"));
      await writeFile(file, lines.join("\n"));
      const index = await buildProjectIndex(root, { cache: "off" });
      const goto = await goToDefinition(index, { file, line: 6, column: lines[5]!.indexOf("Foo") + 1 });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(3);
      const graph = await buildSymbolGraphDetailed(index);
      const edges = graph.edges
        .filter((edge) => edge.label === "calls" || edge.label === "instantiates")
        .map((edge) => `${edge.label} ${graph.nodes.get(edge.to)?.kind}`);
      expect(edges).toEqual(["calls function"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift bare member overloads", () => {
  it("chooses the overload a receiverless call's argument count accepts in goto and the graph", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-bare-overload-"));
    try {
      const lines = [
        "class Box {",
        "  func pick(_ a: Int) -> Int { return a }",
        "  func pick(_ a: Int, _ b: Int) -> Int { return a + b }",
        "  func use() -> Int { return pick(1) }",
        "}",
        "",
      ];
      const file = normalizePath(path.join(root, "a.swift"));
      await writeFile(file, lines.join("\n"));
      const index = await buildProjectIndex(root, { cache: "off" });
      const callLine = lines.findIndex((line) => line.includes("(1)")) + 1;
      const goto = await goToDefinition(index, {
        file,
        line: callLine,
        column: lines[callLine - 1]!.lastIndexOf("(1)") - 3,
      });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.range.start.line).toBe(2);
      const graph = await buildSymbolGraphDetailed(index);
      const targets = graph.edges
        .filter((edge) => edge.label === "calls")
        .map((edge) => edge.to.slice(edge.to.lastIndexOf("::") + 2));
      const expectedStart = lines.slice(0, 2 - 1).join("\n").length + 1 + lines[2 - 1]!.search(/(pick|Pick)\(/);
      expect(targets).toEqual([String(expectedStart)]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift overload declarations", () => {
  it("resolves each overload's own declaration to itself, and calls by argument count", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-own-overload-"));
    try {
      const lines = [
        "struct Box {",
        "  func pick(_ a: Int) -> Int { return a }",
        "  func pick(_ a: Int, _ b: Int) -> Int { return a + b }",
        "  func one() -> Int { return pick(1) }",
        "  func two() -> Int { return pick(1, 2) }",
        "}",
        "",
      ];
      const file = normalizePath(path.join(root, "Box.swift"));
      await writeFile(file, lines.join("\n"));
      const index = await buildProjectIndex(root, { cache: "off" });
      const gotoLine = async (line: number) => {
        const column = lines[line - 1]!.indexOf("pick") + 1;
        const result = await goToDefinition(index, { file, line, column });
        return result.status === "ok" ? result.definition.range.start.line : null;
      };
      expect(await gotoLine(2)).toBe(2);
      expect(await gotoLine(3)).toBe(3);
      expect(await gotoLine(4)).toBe(2);
      expect(await gotoLine(5)).toBe(3);
      const referenceLines = async (line: number) => {
        const result = await findReferences(index, { file, line, column: lines[line - 1]!.indexOf("pick") + 1 });
        if (result.status !== "ok") throw new Error("Expected references");
        return result.references.map((reference) => reference.range.start.line).sort((left, right) => left - right);
      };
      expect(await referenceLines(2)).toEqual([2, 4]);
      expect(await referenceLines(3)).toEqual([3, 5]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift typealias member receivers", () => {
  it("follows a locally declared typealias chain to a sibling nominal type, not a same-named decoy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-typealias-chain-"));
    try {
      const useLines = [
        "typealias Fast = Calculator",
        "typealias Faster = Fast",
        "func call() -> Int { return Faster.sum(a: 1, b: 2) }",
      ];
      const paths = await writeFixtureFiles(root, {
        "Calculator.swift": "enum Calculator { static func sum(a: Int, b: Int) -> Int { a + b } }",
        "Other.swift": "enum Other { static func sum(a: Int, b: Int) -> Int { -1 } }",
        "Use.swift": useLines.join("\n"),
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const result = await goToDefinition(index, {
        file: paths["Use.swift"]!,
        line: 3,
        column: columnOf(useLines, 3, "sum"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Expected aliased nominal member");
      expect(normalizePath(result.definition.file)).toBe(paths["Calculator.swift"]);
      const references = await findReferences(index, {
        file: result.definition.file,
        line: result.definition.range.start.line,
        column: result.definition.range.start.column,
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected aliased member references");
      expect(new Set(references.references.map((ref) => normalizePath(ref.file)))).toEqual(
        new Set([paths["Calculator.swift"], paths["Use.swift"]]),
      );
      const graph = await buildSymbolGraphDetailed(index);
      const targets = graph.edges
        .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === "call")
        .map((edge) => normalizePath(graph.nodes.get(edge.to)!.file));
      expect(targets).toEqual([paths["Calculator.swift"]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift inherited member lookup", () => {
  it("reaches a grandparent through empty subclasses without binding to a decoy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-grandparent-"));
    try {
      const lines = ["func call() -> Int { return Derived().run() }"];
      const paths = await writeFixtureFiles(root, {
        "Grand.swift": "class Grand { func run() -> Int { 1 } }",
        "Base.swift": "class Base: Grand {}",
        "Derived.swift": "class Derived: Base {}",
        "Decoy.swift": "class Decoy { func run() -> Int { -1 } }",
        "Use.swift": lines.join("\n"),
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const result = await goToDefinition(index, {
        file: paths["Use.swift"]!,
        line: 1,
        column: columnOf(lines, 1, "run"),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("Expected inherited Swift member");
      expect(normalizePath(result.definition.file)).toBe(paths["Grand.swift"]);
      const graph = await buildSymbolGraphDetailed(index);
      const targets = graph.edges
        .filter((edge) => edge.label === "calls" && graph.nodes.get(edge.from)?.name === "call")
        .map((edge) => normalizePath(graph.nodes.get(edge.to)!.file));
      expect(targets).toEqual([paths["Grand.swift"]]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift construction inside extensions", () => {
  it("constructs the nominal type inside its extension, not an identically named type elsewhere", async () => {
    const sample = path.resolve("tests/samples/graph-navigation-parity/swift-constructor-call");
    const useSource = await readFile(path.join(sample, "Use.swift"), "utf8");
    const useLines = useSource.split("\n");
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-extension-construction-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "Use.swift": useSource,
        "Types.swift": await readFile(path.join(sample, "Types.swift"), "utf8"),
        "other/Worker.swift": "struct Worker { init(name: String) {} }",
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const direct = await goToDefinition(index, {
        file: paths["Use.swift"]!,
        line: 11,
        column: columnOf(useLines, 11, "Worker(name:"),
      });
      const extension = await goToDefinition(index, {
        file: paths["Use.swift"]!,
        line: 21,
        column: columnOf(useLines, 21, "Worker(name:"),
      });
      expect(direct.status).toBe("ok");
      expect(extension.status).toBe("ok");
      if (direct.status !== "ok" || extension.status !== "ok") throw new Error("Expected nominal type construction");
      expect(normalizePath(extension.definition.file)).toBe(normalizePath(direct.definition.file));
      expect(extension.definition.range.start).toEqual(direct.definition.range.start);
      expect(normalizePath(extension.definition.file)).toBe(paths["Types.swift"]);
      expect(extension.definition.range.start.line).toBe(6);
      expect(normalizePath(extension.definition.file)).not.toBe(paths["other/Worker.swift"]);

      const graph = await buildSymbolGraphDetailed(index);
      const factory = [...graph.nodes.values()].find(
        (node) => node.name === "makeDefault" && normalizePath(node.file) === paths["Use.swift"],
      );
      expect(factory).toBeDefined();
      const constructions = graph.edges
        .filter((edge) => edge.from === factory?.id && edge.label === "instantiates")
        .map((edge) => normalizePath(graph.nodes.get(edge.to)!.file));
      expect(constructions).toEqual([paths["Types.swift"]]);
      expect(constructions).not.toContain(paths["other/Worker.swift"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift extension header type references", () => {
  it("navigates to the nominal type and keeps extension members and conformance connected", async () => {
    const models = [
      "protocol Proto {}",
      "struct Widget { func original() {} }",
      "extension Widget { func sameFile() {} }",
      "struct Outer { struct Inner {} }",
    ];
    const extensions = [
      "import Models",
      "extension Widget: Proto {",
      "  func added() { self.original() }",
      "}",
      "extension String { func builtIn() {} }",
      "extension Outer.Inner { func nested() {} }",
    ];
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-extension-header-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "Models.swift": `${models.join("\n")}\n`,
        "Extensions.swift": `${extensions.join("\n")}\n`,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const model = paths["Models.swift"]!;
      const extension = paths["Extensions.swift"]!;
      for (const [file, lines, line] of [
        [model, models, 3],
        [extension, extensions, 2],
      ] as const) {
        const result = await goToDefinition(index, { file, line, column: columnOf(lines, line, "Widget") });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error("Expected the nominal Widget declaration");
        expect(normalizePath(result.definition.file)).toBe(model);
        expect(result.definition.range.start.line).toBe(2);
      }
      const member = await goToDefinition(index, {
        file: extension,
        line: 3,
        column: columnOf(extensions, 3, "original"),
      });
      expect(member.status).toBe("ok");
      if (member.status !== "ok") throw new Error("Expected an extension member call to resolve");
      expect(normalizePath(member.definition.file)).toBe(model);
      expect(member.definition.range.start.line).toBe(2);
      const builtIn = await goToDefinition(index, {
        file: extension,
        line: 5,
        column: columnOf(extensions, 5, "String"),
      });
      expect(builtIn.status).toBe("not_found");
      // The leading segment of a dotted owner is an ordinary type use; its nested suffix has no proof.
      const outer = await goToDefinition(index, {
        file: extension,
        line: 6,
        column: columnOf(extensions, 6, "Outer"),
      });
      expect(outer.status).toBe("ok");
      if (outer.status !== "ok") throw new Error("Expected the leading owner segment to resolve");
      expect(normalizePath(outer.definition.file)).toBe(model);
      expect(outer.definition.range.start.line).toBe(4);
      const inner = await goToDefinition(index, {
        file: extension,
        line: 6,
        column: columnOf(extensions, 6, "Inner"),
      });
      expect(inner).toEqual({ status: "not_found", reason: "Unresolved qualified type" });
      const missingRefs = await findReferences(index, {
        file: extension,
        line: 5,
        column: columnOf(extensions, 5, "String"),
      });
      expect(missingRefs.status).toBe("not_found");

      const references = await findReferences(index, {
        file: model,
        line: 2,
        column: columnOf(models, 2, "Widget"),
      });
      expect(references.status).toBe("ok");
      if (references.status !== "ok") throw new Error("Expected extension header references");
      expect(references.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
      expect(
        references.references
          .map((reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`)
          .sort(),
      ).toEqual([`${model}:2`, `${model}:3`, `${extension}:2`].sort());
      const headerRefs = await findReferences(index, {
        file: extension,
        line: 2,
        column: columnOf(extensions, 2, "Widget"),
      });
      expect(headerRefs).toEqual(references);

      const graph = await buildSymbolGraphDetailed(index);
      const nominal = [...graph.nodes.values()].find(
        (node) => node.name === "Widget" && normalizePath(node.file) === model,
      );
      const protocol = [...graph.nodes.values()].find(
        (node) => node.name === "Proto" && normalizePath(node.file) === model,
      );
      const owner = [...graph.nodes.values()].find(
        (node) => node.name === "Widget" && normalizePath(node.file) === extension,
      );
      expect(nominal).toBeDefined();
      expect(protocol).toBeDefined();
      expect(owner).toBeDefined();
      expect(
        graph.edges.some((edge) => edge.from === owner!.id && edge.to === nominal!.id && edge.label === "uses"),
      ).toBe(true);
      expect(
        graph.edges.some(
          (edge) => edge.from === nominal!.id && edge.to === protocol!.id && edge.label === "implements",
        ),
      ).toBe(true);
      expect(graph.edges.some((edge) => edge.from === owner!.id && edge.to === protocol!.id)).toBe(false);
      expect(
        graph.edges.some(
          (edge) =>
            edge.label === "uses" &&
            graph.nodes.get(edge.from)?.name === "String" &&
            normalizePath(graph.nodes.get(edge.from)?.file ?? "") === extension,
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes the same-named type in another directory without claiming a complete module boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-extension-decoy-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "Models.swift": "protocol Proto {}\nstruct Widget {}\n",
        "Extensions.swift": "import Models\nextension Widget: Proto { func added() {} }\n",
        "Other/Widget.swift": "struct Widget {}\n",
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const header = await goToDefinition(index, { file: paths["Extensions.swift"]!, line: 2, column: 11 });
      expect(header.status).toBe("ok");
      if (header.status !== "ok") throw new Error("Expected the imported nominal type");
      expect(normalizePath(header.definition.file)).toBe(paths["Models.swift"]);
      expect(normalizePath(header.definition.file)).not.toBe(paths["Other/Widget.swift"]);
      const refs = await findReferences(index, { file: paths["Models.swift"]!, line: 2, column: 8 });
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") throw new Error("Expected module-scoped references");
      expect(refs.references.map((reference) => normalizePath(reference.file)).sort()).toEqual(
        [paths["Models.swift"], paths["Extensions.swift"]].sort(),
      );
      expect(refs.references.some((reference) => normalizePath(reference.file) === paths["Other/Widget.swift"])).toBe(
        false,
      );
      expect(refs.referenceCoverage).toEqual({
        scope: "indexed_candidates",
        state: "partial",
        reasons: ["strategy_unavailable"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves class, struct, enum, and protocol extension headers as type uses", async () => {
    const names = ["ClassWidget", "StructWidget", "EnumWidget", "ProtocolWidget"] as const;
    const lines = [
      "class ClassWidget {}",
      "struct StructWidget {}",
      "enum EnumWidget { case value }",
      "protocol ProtocolWidget {}",
      ...names.map((name) => `extension ${name} {}`),
    ];
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-extension-kinds-"));
    try {
      const paths = await writeFixtureFiles(root, { "Types.swift": `${lines.join("\n")}\n` });
      const index = await buildProjectIndex(root, { cache: "off" });
      const file = paths["Types.swift"]!;
      for (const [position, name] of names.entries()) {
        const line = names.length + position + 1;
        const result = await goToDefinition(index, { file, line, column: columnOf(lines, line, name) });
        expect(result.status, name).toBe("ok");
        if (result.status !== "ok") throw new Error(`Expected a type declaration for ${name}`);
        expect(normalizePath(result.definition.file)).toBe(file);
        expect(result.definition.range.start.line).toBe(position + 1);
        const refs = await findReferences(index, {
          file,
          line: position + 1,
          column: columnOf(lines, position + 1, name),
        });
        expect(refs.status, name).toBe("ok");
        if (refs.status !== "ok") throw new Error(`Expected extension references for ${name}`);
        expect(refs.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
        expect(refs.references.map((reference) => reference.range.start.line)).toEqual([position + 1, line]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift protocol extension default-method graph ownership", () => {
  it("preserves calls from struct and class conformers without reaching a same-named decoy protocol", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-protocol-extension-calls-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "Types.swift": [
          "protocol Relay { func send() }",
          "extension Relay { func announce() { send() } }",
          "struct Labelled: Relay { func send() {} }",
          "class Tagged: Relay { func send() {} }",
        ].join("\n"),
        "Calls.swift": [
          "import Types",
          "func useStruct(_ value: Labelled) { value.announce() }",
          "func useClass(_ value: Tagged) { value.announce() }",
        ].join("\n"),
        "other/Decoy.swift": [
          "protocol Relay { func send() }",
          "extension Relay { func announce() { send() } }",
          "struct Labelled: Relay { func send() {} }",
          "func useDecoy(_ value: Labelled) { value.announce() }",
        ].join("\n"),
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      const symbol = (file: string, name: string) =>
        [...graph.nodes.values()].find((node) => normalizePath(node.file) === paths[file] && node.name === name);
      const protocol = [...graph.nodes.values()].find(
        (node) => normalizePath(node.file) === paths["Types.swift"] && node.name === "Relay" && node.kind === "type",
      );
      const extension = [...graph.nodes.values()].find(
        (node) => normalizePath(node.file) === paths["Types.swift"] && node.name === "Relay" && node.kind === "class",
      );
      const announcement = symbol("Types.swift", "announce");
      const decoyProtocol = [...graph.nodes.values()].find(
        (node) =>
          normalizePath(node.file) === paths["other/Decoy.swift"] && node.name === "Relay" && node.kind === "type",
      );
      const decoyAnnouncement = symbol("other/Decoy.swift", "announce");
      const labelled = symbol("Types.swift", "Labelled");
      const tagged = symbol("Types.swift", "Tagged");
      const decoyLabelled = symbol("other/Decoy.swift", "Labelled");
      const useStruct = symbol("Calls.swift", "useStruct");
      const useClass = symbol("Calls.swift", "useClass");
      const useDecoy = symbol("other/Decoy.swift", "useDecoy");
      for (const target of [
        protocol,
        extension,
        announcement,
        decoyProtocol,
        decoyAnnouncement,
        labelled,
        tagged,
        decoyLabelled,
        useStruct,
        useClass,
        useDecoy,
      ]) {
        expect(target).toBeDefined();
      }
      expect(
        graph.edges.some((edge) => edge.from === extension!.id && edge.to === protocol!.id && edge.label === "uses"),
      ).toBe(true);
      expect(
        graph.edges.some(
          (edge) => edge.from === announcement!.id && edge.to === protocol!.id && edge.label === "member_of",
        ),
      ).toBe(true);
      for (const [caller, target] of [
        [useStruct!, announcement!],
        [useClass!, announcement!],
        [useDecoy!, decoyAnnouncement!],
      ] as const) {
        expect(
          graph.edges.filter((edge) => edge.from === caller.id && edge.label === "calls").map((edge) => edge.to),
        ).toEqual([target.id]);
      }
      for (const conformer of [labelled!, tagged!]) {
        const supers = findTypeHierarchy(graph, conformer.id, "super");
        expect(supers.status).toBe("ok");
        if (supers.status !== "ok") throw new Error("Expected Swift protocol conformance");
        expect(supers.relations.map((relation) => [relation.targetId, relation.relation])).toContainEqual([
          protocol!.id,
          "implements",
        ]);
        expect(supers.relations.some((relation) => relation.targetId === decoyProtocol!.id)).toBe(false);
        expect(
          graph.edges.some(
            (edge) => edge.from === conformer.id && edge.to === protocol!.id && edge.label === "extends",
          ),
        ).toBe(false);
      }
      const subtypes = findTypeHierarchy(graph, protocol!.id, "sub");
      expect(subtypes.status).toBe("ok");
      if (subtypes.status !== "ok") throw new Error("Expected Swift conforming types");
      expect(subtypes.relations.map((relation) => relation.targetId).sort()).toEqual([labelled!.id, tagged!.id].sort());
      expect(subtypes.relations.map((relation) => relation.relation)).toEqual(["implements", "implements"]);
      const decoySubtypes = findTypeHierarchy(graph, decoyProtocol!.id, "sub");
      expect(decoySubtypes.status).toBe("ok");
      if (decoySubtypes.status !== "ok") throw new Error("Expected separate decoy conformer");
      expect(decoySubtypes.relations.map((relation) => relation.targetId)).toEqual([decoyLabelled!.id]);
      expect(decoySubtypes.relations.map((relation) => relation.relation)).toEqual(["implements"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Swift extension headers: type namespace, aliases, and dotted owners", () => {
  const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;
  const complete = { scope: "indexed_candidates", state: "complete" } as const;

  async function withProject(
    files: Readonly<Record<string, string>>,
    run: (project: { index: ProjectIndex; paths: Record<string, string> }) => Promise<void>,
  ): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-swift-extension-header-"));
    try {
      const paths = await writeFixtureFiles(root, files);
      await run({ index: await buildProjectIndex(root, { cache: "off" }), paths });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  function okRefs(result: FindReferencesResult) {
    if (result.status !== "ok") throw new Error(`Expected references: ${result.reason}`);
    return result;
  }

  function sites(result: FindReferencesResult): string[] {
    return okRefs(result)
      .references.map((reference) => `${path.basename(reference.file)}:${reference.range.start.line}`)
      .sort();
  }

  function find(graph: SymbolGraph, file: string, name: string, kind: string) {
    return [...graph.nodes.values()].find(
      (node) => normalizePath(node.file) === file && node.name === name && node.kind === kind,
    );
  }

  function edgeKeys(graph: SymbolGraph, label: string): string[] {
    return graph.edges
      .filter((edge) => edge.label === label)
      .map((edge) => {
        const from = graph.nodes.get(edge.from);
        const to = graph.nodes.get(edge.to);
        return `${path.basename(from?.file ?? "")}:${from?.name}->${path.basename(to?.file ?? "")}:${to?.name}`;
      })
      .sort();
  }

  function supers(graph: SymbolGraph, id: string): Array<[string, string]> {
    const hierarchy = findTypeHierarchy(graph, id, "super");
    if (hierarchy.status !== "ok") throw new Error("Expected a Swift hierarchy");
    return hierarchy.relations.map((relation) => [relation.targetId, relation.relation]);
  }

  it("never binds an extension header to a same-named function in another file", async () => {
    await withProject(
      {
        "Factory.swift": lines("import Foundation", "func URL(_ number: Int) -> Int { return number }"),
        "Extension.swift": lines("import Foundation", "extension URL { func custom() {} }"),
      },
      async ({ index, paths }) => {
        const header = await goToDefinition(index, { file: paths["Extension.swift"]!, line: 2, column: 11 });
        expect(header.status).toBe("not_found");
        const refs = await findReferences(index, { file: paths["Factory.swift"]!, line: 2, column: 6 });
        expect(sites(refs)).toEqual(["Factory.swift:2"]);
        expect(okRefs(refs).referenceCoverage).toEqual(complete);
        expect(edgeKeys(await buildSymbolGraphDetailed(index), "uses")).toEqual([]);
      },
    );
  });

  it("keeps same-file function references clean and resolves the type beside a function decoy elsewhere", async () => {
    await withProject(
      {
        "One.swift": lines(
          "import Foundation",
          "func URL(_ number: Int) -> Int { return number }",
          "extension URL { func custom() {} }",
        ),
      },
      async ({ index, paths }) => {
        const header = await goToDefinition(index, { file: paths["One.swift"]!, line: 3, column: 11 });
        expect(header.status).toBe("not_found");
        const refs = await findReferences(index, { file: paths["One.swift"]!, line: 2, column: 6 });
        expect(sites(refs)).toEqual(["One.swift:2"]);
        expect(okRefs(refs).referenceCoverage).toEqual(complete);
      },
    );
    await withProject(
      {
        "Types.swift": lines("struct Widget {}"),
        "Extension.swift": lines("extension Widget { func added() {} }"),
        "Other/Factory.swift": lines("func Widget(_ number: Int) -> Int { number }"),
      },
      async ({ index, paths }) => {
        const header = await goToDefinition(index, { file: paths["Extension.swift"]!, line: 1, column: 11 });
        expect(header.status).toBe("ok");
        if (header.status !== "ok") throw new Error("Expected the type");
        expect(normalizePath(header.definition.file)).toBe(paths["Types.swift"]);
        const typeRefs = await findReferences(index, { file: paths["Types.swift"]!, line: 1, column: 8 });
        expect(sites(typeRefs)).toEqual(["Extension.swift:1", "Types.swift:1"]);
        const functionRefs = await findReferences(index, { file: paths["Other/Factory.swift"]!, line: 1, column: 6 });
        expect(sites(functionRefs)).toEqual(["Factory.swift:1"]);
        expect(edgeKeys(await buildSymbolGraphDetailed(index), "uses")).toEqual([
          "Extension.swift:Widget->Types.swift:Widget",
        ]);
      },
    );
  });

  it("gives typealias extension conformance to the nominal type, or to nothing when unproven", async () => {
    await withProject(
      {
        "Types.swift": lines(
          "protocol P {}",
          "struct Widget {}",
          "struct Box<Element> {}",
          "struct Outer { struct Widget {} }",
        ),
        "Aliases.swift": lines(
          "typealias Inner = Widget",
          "typealias Alias = Inner",
          "typealias IntBox = Box<Int>",
          "typealias Nested = Outer.Widget",
          "typealias Missing = Elsewhere",
        ),
        "Extension.swift": lines("extension Alias: P {}"),
        "Unproven.swift": lines("extension IntBox: P {}", "extension Nested: P {}", "extension Missing: P {}"),
        "Other/Widget.swift": lines("struct Widget {}"),
      },
      async ({ index, paths }) => {
        const header = await goToDefinition(index, { file: paths["Extension.swift"]!, line: 1, column: 11 });
        expect(header.status).toBe("ok");
        if (header.status !== "ok") throw new Error("Expected the alias");
        expect(normalizePath(header.definition.file)).toBe(paths["Aliases.swift"]);
        expect(header.definition.range.start.line).toBe(2);

        const graph = await buildSymbolGraphDetailed(index);
        expect(edgeKeys(graph, "implements")).toEqual(["Types.swift:Widget->Types.swift:P"]);
        expect(edgeKeys(graph, "extends")).toEqual([]);
        expect(edgeKeys(graph, "uses")).toEqual(
          [
            "Extension.swift:Alias->Aliases.swift:Alias",
            "Unproven.swift:IntBox->Aliases.swift:IntBox",
            "Unproven.swift:Missing->Aliases.swift:Missing",
            "Unproven.swift:Nested->Aliases.swift:Nested",
          ].sort(),
        );
        const protocol = find(graph, paths["Types.swift"]!, "P", "type");
        const nominal = find(graph, paths["Types.swift"]!, "Widget", "class");
        const alias = find(graph, paths["Aliases.swift"]!, "Alias", "type");
        const decoy = find(graph, paths["Other/Widget.swift"]!, "Widget", "class");
        for (const target of [protocol, nominal, alias, decoy]) expect(target).toBeDefined();
        expect(supers(graph, nominal!.id)).toEqual([[protocol!.id, "implements"]]);
        expect(supers(graph, alias!.id)).toEqual([]);
        expect(supers(graph, decoy!.id)).toEqual([]);
        const implementations = findImplementations(index, graph, protocol!.id);
        expect(implementations.status).toBe("ok");
        if (implementations.status !== "ok") throw new Error("Expected the aliased implementation");
        expect(implementations.implementations.map((match) => match.symbolId)).toEqual([nominal!.id]);
      },
    );
  });

  it("follows typealiases to the class or protocol they provably name in base clauses", async () => {
    await withProject(
      {
        "Types.swift": lines(
          "class Base {}",
          "typealias Alias = Base",
          "class Sub: Alias {}",
          "class Direct: Base {}",
          "protocol Proto {}",
          "typealias ProtoAlias = Proto",
        ),
        "Conform.swift": lines(
          "struct Conforming: Proto {}",
          "class Mixed: Base, Proto {}",
          "struct ViaAlias: ProtoAlias {}",
          "class MixedAlias: Alias, ProtoAlias {}",
        ),
        "Unproven.swift": lines(
          "class Generic<Element> {}",
          "struct Outer { class Inner {} }",
          "typealias IntGeneric = Generic<Int>",
          "typealias Nested = Outer.Inner",
          "typealias Missing = Elsewhere",
          "class FromGeneric: IntGeneric {}",
          "class FromNested: Nested {}",
          "class FromMissing: Missing {}",
        ),
        "Other/Base.swift": lines("class Base {}"),
      },
      async ({ index, paths }) => {
        const graph = await buildSymbolGraphDetailed(index);
        expect(edgeKeys(graph, "extends")).toEqual(
          [
            "Conform.swift:Mixed->Types.swift:Base",
            "Conform.swift:MixedAlias->Types.swift:Base",
            "Types.swift:Direct->Types.swift:Base",
            "Types.swift:Sub->Types.swift:Base",
          ].sort(),
        );
        expect(edgeKeys(graph, "implements")).toEqual(
          [
            "Conform.swift:Conforming->Types.swift:Proto",
            "Conform.swift:Mixed->Types.swift:Proto",
            "Conform.swift:MixedAlias->Types.swift:Proto",
            "Conform.swift:ViaAlias->Types.swift:Proto",
          ].sort(),
        );
        const base = find(graph, paths["Types.swift"]!, "Base", "class");
        const protocol = find(graph, paths["Types.swift"]!, "Proto", "type");
        const sub = find(graph, paths["Types.swift"]!, "Sub", "class");
        const mixedAlias = find(graph, paths["Conform.swift"]!, "MixedAlias", "class");
        const decoy = find(graph, paths["Other/Base.swift"]!, "Base", "class");
        for (const target of [base, protocol, sub, mixedAlias, decoy]) expect(target).toBeDefined();
        // An alias is never a hierarchy node: the class or protocol it names is the supertype.
        expect(supers(graph, sub!.id)).toEqual([[base!.id, "extends"]]);
        expect(supers(graph, mixedAlias!.id)).toEqual([
          [base!.id, "extends"],
          [protocol!.id, "implements"],
        ]);
        expect(supers(graph, decoy!.id)).toEqual([]);
        // A generic specialization, a nested type, and an unindexed type prove no base, so they add no edge.
        for (const name of ["FromGeneric", "FromNested", "FromMissing"]) {
          const unproven = find(graph, paths["Unproven.swift"]!, name, "class");
          expect(unproven, name).toBeDefined();
          expect(supers(graph, unproven!.id), name).toEqual([]);
        }
        const subtypes = findTypeHierarchy(graph, base!.id, "sub");
        if (subtypes.status !== "ok") throw new Error("Expected the base class subtypes");
        expect(subtypes.relations.map((relation) => graph.nodes.get(relation.targetId)?.name).sort()).toEqual([
          "Direct",
          "Mixed",
          "MixedAlias",
          "Sub",
        ]);
      },
    );
  });

  it("resolves the leading segment of a dotted extension owner and leaves its nested suffix unproven", async () => {
    await withProject(
      {
        "Models.swift": lines("struct Outer { struct Inner {} }"),
        "Extension.swift": lines("extension Outer.Inner { func nested() {} }"),
      },
      async ({ index, paths }) => {
        const outer = await goToDefinition(index, { file: paths["Extension.swift"]!, line: 1, column: 11 });
        expect(outer.status).toBe("ok");
        if (outer.status !== "ok") throw new Error("Expected the leading owner segment");
        expect(normalizePath(outer.definition.file)).toBe(paths["Models.swift"]);
        const suffix = await goToDefinition(index, { file: paths["Extension.swift"]!, line: 1, column: 17 });
        expect(suffix).toEqual({ status: "not_found", reason: "Unresolved qualified type" });

        const outerRefs = await findReferences(index, { file: paths["Models.swift"]!, line: 1, column: 8 });
        expect(sites(outerRefs)).toEqual(["Extension.swift:1", "Models.swift:1"]);
        expect(okRefs(outerRefs).referenceCoverage).toEqual(complete);
        const innerRefs = okRefs(await findReferences(index, { file: paths["Models.swift"]!, line: 1, column: 23 }));
        expect(innerRefs.references.map((reference) => path.basename(reference.file))).toEqual(["Models.swift"]);
        expect(innerRefs.referenceCoverage.state).toBe("partial");
        expect(innerRefs.referenceCoverage.reasons).toEqual(["strategy_unavailable"]);
        expect(innerRefs.referenceCoverage.affectedFiles?.map(normalizePath)).toEqual([paths["Extension.swift"]]);
        expect(edgeKeys(await buildSymbolGraphDetailed(index), "uses")).toEqual([]);
      },
    );
    const source = [
      "struct Inner {}",
      "struct Outer { struct Inner { func run() { nested() } } }",
      "extension Outer.Inner { func nested() {} }",
      "protocol P {}",
      "extension Outer.Inner: P {}",
    ];
    await withProject({ "A.swift": lines(...source) }, async ({ index, paths }) => {
      const file = paths["A.swift"]!;
      // The suffix is never a bare use: the top-level `Inner` keeps only its own declaration.
      expect(sites(await findReferences(index, { file, line: 1, column: 8 }))).toEqual(["A.swift:1"]);
      const outerRefs = await findReferences(index, { file, line: 2, column: 8 });
      expect(sites(outerRefs)).toEqual(["A.swift:2", "A.swift:3", "A.swift:5"]);
      expect(okRefs(outerRefs).referenceCoverage).toEqual(complete);
      // Members of the dotted extension stay reachable from the nested type through shared owner identity.
      const member = await goToDefinition(index, { file, line: 2, column: columnOf(source, 2, "nested") });
      expect(member.status).toBe("ok");
      if (member.status !== "ok") throw new Error("Expected the extension member");
      expect(member.definition.range.start.line).toBe(3);
      const graph = await buildSymbolGraphDetailed(index);
      expect(edgeKeys(graph, "uses")).toEqual([]);
      expect(edgeKeys(graph, "implements")).toEqual([]);
    });
  });
});
