import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProjectIndex, buildSymbolGraphDetailed, findReferences, goToDefinition } from "../../src/index.js";
import { collectLocalsAndExportsFromSource, parseFile } from "../../src/indexer.js";
import { normalizePath } from "../../src/util/paths.js";
import { exportedNameOf } from "../helpers/narrow.js";
import { columnOf, writeFixtureFiles } from "./callable-consumer-fixtures.js";
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
          symbols: [
            { name: "WorkerImpl", kind: "class" },
            { name: "makeDefault", kind: "function" },
          ],
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
    const peerLines = ["extension Box where T == Int { func extra() {} }"];
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
});
