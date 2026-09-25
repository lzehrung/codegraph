import fsp, { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectModuleSpecifiersFromSource } from "../../src/graphs.js";
import { buildProjectIndex, buildSymbolGraphDetailed, findReferences, goToDefinition } from "../../src/index.js";
import { parseFile } from "../../src/indexer.js";
import { supportById } from "../../src/languages.js";
import { fileIdentityKey, normalizePath } from "../../src/util/paths.js";
import { columnOf, writeFixtureFiles } from "./callable-consumer-fixtures.js";
import { exportedNameOf } from "../helpers/narrow.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { expectUnicodeSymbolRangeIdentity } from "./unicode-symbol-range.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import type { SyntaxNodeLike } from "../../src/languages/types.js";

function findFirstNode(root: SyntaxNodeLike, type: string, text: string): SyntaxNodeLike | null {
  if (root.type === type && root.text === text) return root;
  for (const child of root.namedChildren) {
    const found = findFirstNode(child, type, text);
    if (found) return found;
  }
  return null;
}

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
        "pub const shaped: Shape = .{};",
        "extern const external: u8;",
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
      expect(module?.locals.filter((symbol) => symbol.localName === "Shape")).toHaveLength(1);
      expect(module?.exports.map(exportedNameOf).sort()).toEqual(["flag", "shaped"]);
      expect(localKinds["Alias"]).toBe("type");
      expect(localKinds["external"]).toBe("variable");
      expect(localKinds["flag"]).toBe("variable");
      expect(localKinds["counter"]).toBe("variable");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Zig variable_declaration initializer references", () => {
  it("finds a reference to a declared symbol used as a bare initializer, keeping one declaration", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-zig-decl-init-"));
    const file = path.join(root, "scope.zig");
    const source = ["const original = 5;", "const alias = original;", ""].join("\n");
    await fsp.writeFile(file, source, "utf8");
    try {
      const index = await buildProjectIndex(root, { cache: "off" });

      // The initializer use of `original` in `const alias = original;` must be
      // returned as a reference, not swallowed as if it were itself a declaration.
      const references = await findReferences(index, { file, line: 1, column: 7 });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        expect(references.references.map((entry) => entry.range.start.line)).toEqual([1, 2]);
      }

      // Regression: only one declaration for `original` and one for `alias` -- the
      // initializer use must not create a phantom duplicate declaration.
      const module = index.byFile.get(fileIdentityKey(file));
      expect(module?.locals.filter((entry) => entry.localName === "original")).toHaveLength(1);
      expect(module?.locals.filter((entry) => entry.localName === "alias")).toHaveLength(1);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Zig unqualified member lookup", () => {
  it("does not resolve an unqualified call to a struct member", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-zig-member-scope-"));
    const file = path.join(root, "self.zig");
    const source = [
      "const Self = struct {",
      "    pub fn helper() void {}",
      "    pub fn caller() void {",
      "        helper();",
      "    }",
      "};",
      "",
    ].join("\n");
    try {
      await writeFile(file, source, "utf8");
      const index = await createTestIndexFromFiles(root, [file]);
      const parsed = await parseFile(file);
      const call = findFirstNode(parsed.tree.rootNode, "call_expression", "helper()");
      expect(call).not.toBeNull();
      const { row, column } = call!.startPosition;
      const result = await goToDefinition(index, {
        file: fileIdentityKey(file),
        line: row + 1,
        column: column + 1,
      });
      expect(result.status).toBe("not_found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Zig @import peer visibility", () => {
  // #378: a function reached through `@import` must resolve, be referenced, and produce a call
  // edge for both the one-argument case and the zero-argument control, while a same-named
  // function in a file that is never imported must stay out of all three results.
  const apiLines = [
    "pub fn target(value: i32) i32 {",
    "    return value;",
    "}",
    "",
    "pub fn zero_target() i32 {",
    "    return 0;",
    "}",
  ];
  const useLines = [
    'const api = @import("api.zig");',
    "",
    "pub fn caller() i32 {",
    "    return api.target(1);",
    "}",
    "",
    "pub fn zeroCaller() i32 {",
    "    return api.zero_target();",
    "}",
  ];
  const decoyLines = [
    "pub fn target(value: i32) i32 {",
    "    return value;",
    "}",
    "",
    "pub fn decoyCaller() i32 {",
    "    return target(1);",
    "}",
  ];

  it("resolves imported functions and excludes a same-named unimported file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cg-zig-import-peer-"));
    try {
      const paths = await writeFixtureFiles(root, {
        "api.zig": `${apiLines.join("\n")}\n`,
        "use.zig": `${useLines.join("\n")}\n`,
        "decoy.zig": `${decoyLines.join("\n")}\n`,
      });
      const index = await buildProjectIndex(root, { cache: "off" });
      const apiPath = paths["api.zig"]!;
      const usePath = paths["use.zig"]!;
      const decoyPath = paths["decoy.zig"]!;

      for (const [line, token, expectedLine] of [
        [4, "target", 1],
        [8, "zero_target", 5],
      ] as const) {
        const goto = await goToDefinition(index, {
          file: usePath,
          line,
          column: columnOf(useLines, line, token),
        });
        expect(goto.status, `use.zig:${line} must resolve`).toBe("ok");
        if (goto.status !== "ok") throw new Error("Expected the imported function declaration");
        expect(normalizePath(goto.definition.file)).toBe(apiPath);
        expect(goto.definition.range.start.line).toBe(expectedLine);
      }

      for (const [declLine, token, callLine] of [
        [1, "target", 4],
        [5, "zero_target", 8],
      ] as const) {
        const references = await findReferences(index, {
          file: apiPath,
          line: declLine,
          column: columnOf(apiLines, declLine, token),
        });
        expect(references.status).toBe("ok");
        if (references.status !== "ok") throw new Error("Expected imported function references");
        const sites = references.references.map(
          (reference) => `${normalizePath(reference.file)}:${reference.range.start.line}`,
        );
        expect(sites).toContain(`${usePath}:${callLine}`);
        expect(references.references.some((reference) => normalizePath(reference.file) === decoyPath)).toBe(false);
      }

      const graph = await buildSymbolGraphDetailed(index);
      for (const [caller, target] of [
        ["caller", "target"],
        ["zeroCaller", "zero_target"],
      ] as const) {
        const callerNode = [...graph.nodes.values()].find(
          (node) => node.name === caller && normalizePath(node.file) === usePath,
        );
        expect(callerNode, `${caller} must be indexed`).toBeDefined();
        const callTargets: string[] = [];
        for (const edge of graph.edges) {
          if (edge.label !== "calls" || edge.from !== callerNode!.id) continue;
          const node = graph.nodes.get(edge.to);
          if (node) {
            callTargets.push(`${normalizePath(node.file)}::${node.name}`);
          }
        }
        expect(callTargets).toContain(`${apiPath}::${target}`);
        expect(callTargets.some((candidate) => candidate.startsWith(`${decoyPath}::`))).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
