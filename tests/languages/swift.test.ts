import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProjectIndex } from "../../src/index.js";
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
