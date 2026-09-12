import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectModuleSpecifiersFromSource } from "../../src/graphs.js";
import { buildProjectIndex } from "../../src/index.js";
import { supportById } from "../../src/languages.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { exportedNameOf } from "../helpers/narrow.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { expectUnicodeSymbolRangeIdentity } from "./unicode-symbol-range.js";

const definition: LanguageTestDefinition = {
  id: "zig",
  samples: [
    {
      name: "chunks Zig functions and tests",
      sourceFile: "zig.sample.zig",
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 2 },
        { type: "function", name: "run", startLine: 3, endLine: 6 },
        { type: "test", name: '"basic"', startLine: 7, endLine: 9 },
      ],
    },
  ],
  parity: {
    sampleDir: "zig",
    exact: {
      dependencyGraph: [
        {
          from: "main.zig",
          to: { type: "external", name: "build_options" },
        },
        {
          from: "main.zig",
          to: { type: "external", name: "std" },
        },
        {
          from: "main.zig",
          to: { type: "file", path: "helpers.zig" },
        },
        {
          from: "main.zig",
          to: { type: "file", path: "math.zig" },
        },
      ],
      symbols: [
        {
          file: "helpers.zig",
          symbols: [{ name: "helper", kind: "function" }],
        },
        {
          file: "main.zig",
          symbols: [
            { name: "helpers", kind: "variable" },
            { name: "math", kind: "variable" },
            { name: "run", kind: "function" },
            { name: "value", kind: "variable" },
            { name: "_", kind: "variable" },
            { name: "value", kind: "variable" },
            { name: "std", kind: "variable" },
            { name: "build_options", kind: "variable" },
          ],
        },
        {
          file: "math.zig",
          symbols: [{ name: "Number", kind: "type" }],
        },
      ],
      references: [
        {
          name: "find references includes Zig imported helper member usage",
          file: "helpers.zig",
          line: 1,
          column: 8,
          references: [
            { file: "helpers.zig", line: 1 },
            { file: "main.zig", line: 5 },
          ],
        },
        {
          name: "find references includes Zig imported type member usage",
          file: "math.zig",
          line: 1,
          column: 11,
          references: [
            { file: "math.zig", line: 1 },
            { file: "main.zig", line: 5 },
          ],
        },
      ],
    },
    goToDefinition: [
      {
        name: "go to definition resolves Zig imported type members",
        file: "main.zig",
        line: 5,
        column: 23,
        expectedDefinition: { file: "math.zig", line: 1 },
      },
      {
        name: "go to definition resolves Zig imported function members",
        file: "main.zig",
        line: 5,
        column: 43,
        expectedDefinition: { file: "helpers.zig", line: 1 },
      },
    ],
  },
};

runLanguageTests(definition);

describe("Zig symbol ranges after preceding multibyte text (C11)", () => {
  // Zig identifiers are ASCII-only (an arbitrary identifier needs @"..." syntax), so this
  // uses an ASCII declaration name preceded by multibyte text on an earlier line and on the
  // same line, unlike the other languages' Unicode-identifier fixtures.
  it("publishes a UTF-16 string index for an ASCII function name preceded by multibyte text", async () => {
    await expectUnicodeSymbolRangeIdentity({
      fileName: "widget.zig",
      source: '// café ☕ prüfung\nconst greeting = "über"; fn create_widget() i32 {\n    return 1;\n}\n',
      symbolName: "create_widget",
    });
  });
});

it("captures @cImport but excludes unrelated builtins", () => {
  const support = supportById("zig")!;
  const specifiers = collectModuleSpecifiersFromSource(
    support,
    'const c = @cImport({ @cInclude("header.h"); });\nconst value = @intFromFloat(1.5);\nconst kind = @TypeOf("x");\n',
  );

  expect(specifiers.map((specifier) => specifier.spec)).toEqual(["@cImport"]);
});

describe("Zig declaration classification and exports", () => {
  it("keeps typed values variable-classified and function locals private", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-zig-declarations-"));
    const file = path.join(root, "scope.zig");
    await fsp.writeFile(
      file,
      [
        "const Shape = struct {};",
        "const Alias = error{}!u8;",
        "pub const flag: bool = true;",
        "var counter: i32 = 0;",
        "fn outer() void {",
        "  const inner = 1;",
        "  var local: i32 = 0;",
        "  _ = .{ inner, local };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      const index = await buildProjectIndex(root, { cache: "off" });
      const module = index.byFile.get(fileIdentityKey(file));
      const localKinds = Object.fromEntries(module?.locals.map((symbol) => [symbol.localName, symbol.kind]) ?? []);

      expect(localKinds["Shape"]).toBe("type");
      expect(localKinds["Alias"]).toBe("type");
      expect(localKinds["flag"]).toBe("variable");
      expect(localKinds["counter"]).toBe("variable");
      expect(module?.exports.map(exportedNameOf)).not.toContain("inner");
      expect(module?.exports.map(exportedNameOf)).not.toContain("local");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
