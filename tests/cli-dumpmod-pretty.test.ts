import { describe, expect, it } from "vitest";
import { SymbolKind } from "../src/indexer/types.js";
import { formatDumpmodOutput } from "../src/cli/navigation.js";

describe("dumpmod pretty formatting", () => {
  const root = "E:/proj";

  it("renders every export union variant including type-only suffixes", () => {
    const output = formatDumpmodOutput(root, {
      file: "E:/proj/src/mod.ts",
      locals: [{ name: "helper", kind: SymbolKind.Function, start: { line: 2, column: 0, index: 0 } }],
      imports: [],
      exports: [
        {
          type: "local",
          exportedAs: "helper",
          def: { name: "helper", kind: SymbolKind.Function, start: { line: 2, column: 0, index: 0 } },
        },
        {
          type: "reexport",
          exportedAs: "Foo",
          fromModule: "./foo",
          sourceSpecifier: "Foo",
          typeOnly: true,
        },
        {
          type: "reexport",
          exportedAs: "Bar",
          fromModule: "./bar",
          sourceSpecifier: "Bar",
        },
        {
          type: "namespaceReexport",
          exportedAs: "ns",
          fromModule: "./ns",
          typeOnly: true,
        },
        {
          type: "exportStar",
          fromModule: "./star",
          typeOnly: true,
        },
        {
          type: "exportStar",
          fromModule: "./star-runtime",
        },
      ],
    });

    expect(output).toContain("File: src/mod.ts");
    expect(output).toContain("- local function helper as helper @ 2:0");
    expect(output).toContain("- reexport Foo from ./foo (type-only)");
    expect(output).toContain("- reexport Bar from ./bar");
    expect(output).not.toContain("- reexport Bar from ./bar (type-only)");
    expect(output).toContain("- namespace ns from ./ns (type-only)");
    expect(output).toContain("- export * from ./star (type-only)");
    expect(output).toContain("- export * from ./star-runtime");
  });

  it("renders empty locals and exports as (none)", () => {
    const output = formatDumpmodOutput(root, {
      file: "E:/proj/empty.ts",
      locals: [],
      imports: [],
      exports: [],
    });
    expect(output).toContain("Locals:\n- (none)");
    expect(output).toContain("Exports:\n- (none)");
  });
});
