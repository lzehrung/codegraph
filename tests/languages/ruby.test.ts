import path from "node:path";
import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { buildSymbolGraphDetailed } from "../../src/index.js";
import { collectDetailedDeclarations } from "../../src/graphs/symbol-graph-detailed/ast.js";
import { collectLocalsAndExportsFromSource, parseFile } from "../../src/indexer.js";
import { createTestIndexFromFiles } from "../test-utils.js";

const definition: LanguageTestDefinition = {
  id: "ruby",
  samples: [
    {
      name: "chunks Ruby structures",
      sourceFile: "ruby.sample.rb",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "module" && c.name === "MyModule")).toBe(true);
        expect(chunks.some((c) => c.type === "class" && c.name === "MyClass")).toBe(true);
        expect(chunks.some((c) => c.type === "method" && c.name === "my_method")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "ruby",
    dependencyGraph: [
      {
        from: "main.rb",
        to: { type: "file", path: "utils.rb" },
      },
      {
        from: "main.rb",
        to: { type: "file", path: "helpers.rb" },
      },
      {
        from: "consumer.rb",
        to: { type: "file", path: "namespaced.rb" },
      },
    ],
    symbols: [
      {
        file: "namespaced.rb",
        includes: [{ name: "Outer" }, { name: "Inner" }, { name: "Tool" }],
      },
      {
        file: ".regressions/struct_point.rb",
        includes: [{ name: "Point", kind: "class" }],
      },
    ],
    goToDefinition: [
      {
        name: "go to definition resolves namespaced class use",
        file: "consumer.rb",
        line: 3,
        column: 22,
        expectedDefinition: { file: "namespaced.rb", line: 5 },
      },
      {
        name: "go to definition resolves a Struct.new class assignment",
        file: ".regressions/struct_point.rb",
        line: 3,
        column: 9,
        expectedDefinition: { file: ".regressions/struct_point.rb", line: 1 },
      },
    ],
    references: [
      {
        name: "find references for namespaced class",
        file: "namespaced.rb",
        line: 5,
        column: 11,
        minimumCount: 2,
      },
      {
        name: "finds Struct.new class assignment references",
        file: ".regressions/struct_point.rb",
        line: 1,
        column: 1,
        minimumCount: 2,
      },
    ],
  },
};

runLanguageTests(definition);

describe("Ruby Struct.new declarations", () => {
  it("creates a synthetic detailed class node with class ownership", async () => {
    const samplePath = path.resolve(process.cwd(), "tests", "samples", "ruby");
    const file = path.join(samplePath, ".regressions", "struct_point.rb").replace(/\\/g, "/");
    const parsed = await parseFile(file);
    const module = collectLocalsAndExportsFromSource(file, parsed.source, parsed.sup, parsed.lang, [], {
      tree: parsed.tree,
      nativeQueries: parsed.nativeQueries,
    });
    const declarations = collectDetailedDeclarations(parsed.tree.rootNode, parsed.sup, parsed.source, module.locals);
    const pointClass = declarations.classNodes.find((node) => node.name === "Point");

    expect(pointClass?.def.kind).toBe("class");
    expect(pointClass?.node.type).toBe("assignment");

    const index = await createTestIndexFromFiles(samplePath, [file]);
    const graph = await buildSymbolGraphDetailed(index);
    expect(Array.from(graph.nodes.values())).toContainEqual(
      expect.objectContaining({ file, name: "Point", kind: "class" }),
    );
  });
});
