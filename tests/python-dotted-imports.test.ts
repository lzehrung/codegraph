import fs from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import { PYTHON_DOTTED_IMPORT_FILES, expectPythonDottedImports } from "./helpers/python-dotted-import-fixture.js";
import {
  assertConsumerAgreement,
  buildConsumerAgreementFixture,
  disposeConsumerAgreementFixture,
  findDetailedNode,
  hasDetailedEdge,
} from "./helpers/consumer-agreement.js";
import { findReferences, goToDefinition } from "../src/indexer/navigation.js";
import { writeFixtureFiles } from "./languages/callable-consumer-fixtures.js";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

describe("Python unaliased dotted imports", () => {
  it("name the package, then each submodule, across go-to-definition, references, and the detailed graph", async () => {
    const root = await mkTmpDir("cg-python-dotted-import-");
    roots.push(root);
    await writeFixtureFiles(root, PYTHON_DOTTED_IMPORT_FILES);
    const index = await buildProjectIndex(root, { cache: "off" });
    const graph = await buildSymbolGraphDetailed(index);
    await expectPythonDottedImports(root, index, graph, "cold");
  });

  it("keeps annotated local classes and imported classes distinct from shadowed receiver names", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-python-typed-parameter-", {
      "other.py": ["class Box:", "    def run(self):", '        return "other"', ""].join("\n"),
      "star_mod.py": ["class Box:", "    def run(self):", '        return "star"', ""].join("\n"),
      "star_then_explicit.py": [
        "from star_mod import *",
        "from other import Box",
        "def star_then_explicit(item: Box):",
        "    return item.run()",
        "",
      ].join("\n"),
      "explicit_then_star.py": [
        "from other import Box",
        "from star_mod import *",
        "def explicit_then_star(item: Box):",
        "    return item.run()",
        "",
      ].join("\n"),
      "positioned.py": [
        "from other import Box",
        "def first(item: Box):",
        "    return item.run()",
        "from star_mod import *",
        "def second(item: Box):",
        "    return item.run()",
        "",
      ].join("\n"),
      "nested_import.py": [
        "from star_mod import *",
        "def outer():",
        "    from other import Box",
        "    def nested_import(item: Box):",
        "        return item.run()",
        "    return nested_import",
        "",
      ].join("\n"),
      "nested_runtime.py": [
        "from other import Box",
        "def outer():",
        "    def nested_runtime(item: Box):",
        "        return item.run()",
        "    return nested_runtime",
        "from star_mod import *",
        "",
      ].join("\n"),
      "class_then_star.py": [
        "class Box:",
        "    def run(self):",
        '        return "local"',
        "from star_mod import *",
        "def class_then_star(item: Box):",
        "    return item.run()",
        "",
      ].join("\n"),
      "star_then_class.py": [
        "from star_mod import *",
        "class Box:",
        "    def run(self):",
        '        return "local"',
        "def star_then_class(item: Box):",
        "    return item.run()",
        "",
      ].join("\n"),
      "local_wins.py": [
        "from other import Box",
        "class Box:",
        "    def run(self):",
        '        return "local"',
        "def local(item: Box):",
        "    return item.run()",
        "def default(item: Box = Box()):",
        "    return item.run()",
        "def same_name(Box: Box):",
        "    return Box.run()",
        "",
      ].join("\n"),
      "import_wins.py": [
        "class Box:",
        "    def run(self):",
        '        return "local"',
        "from other import Box",
        "def imported(item: Box):",
        "    return item.run()",
        "",
      ].join("\n"),
      "no_import.py": [
        "class Tool:",
        "    def run(self):",
        '        return "local"',
        "def shadow(Tool):",
        "    return Tool.run()",
        "",
      ].join("\n"),
      "nested.py": [
        "class Tool:",
        "    def run(self):",
        '        return "local"',
        "def outer(Tool):",
        "    def inner(item: Tool):",
        "        return item.run()",
        "    return inner",
        "",
      ].join("\n"),
    });
    try {
      for (const site of [
        { file: "local_wins.py", line: 6, declaration: "local_wins.py", declarationLine: 3, caller: "local" },
        { file: "local_wins.py", line: 10, declaration: "local_wins.py", declarationLine: 3, caller: "same_name" },
        { file: "import_wins.py", line: 6, declaration: "other.py", declarationLine: 2, caller: "imported" },
        { file: "positioned.py", line: 3, declaration: "other.py", declarationLine: 2, caller: "first" },
        { file: "positioned.py", line: 6, declaration: "star_mod.py", declarationLine: 2, caller: "second" },
        { file: "nested_import.py", line: 5, declaration: "other.py", declarationLine: 2, caller: "nested_import" },
        {
          file: "nested_runtime.py",
          line: 4,
          declaration: "star_mod.py",
          declarationLine: 2,
          caller: "nested_runtime",
        },
        {
          file: "star_then_explicit.py",
          line: 4,
          declaration: "other.py",
          declarationLine: 2,
          caller: "star_then_explicit",
        },
        {
          file: "explicit_then_star.py",
          line: 4,
          declaration: "star_mod.py",
          declarationLine: 2,
          caller: "explicit_then_star",
        },
        {
          file: "class_then_star.py",
          line: 6,
          declaration: "star_mod.py",
          declarationLine: 2,
          caller: "class_then_star",
        },
        {
          file: "star_then_class.py",
          line: 6,
          declaration: "star_then_class.py",
          declarationLine: 3,
          caller: "star_then_class",
        },
      ]) {
        await assertConsumerAgreement(fixture, {
          file: site.file,
          line: site.line,
          token: "run",
          expected: { file: site.declaration, line: site.declarationLine },
          edges: [{ label: "calls", from: { file: site.file, name: site.caller } }],
        });
      }
      for (const [file, excludedLine] of [
        ["other.py", 6],
        ["star_mod.py", 3],
      ] as const) {
        const refs = await findReferences(fixture.index, { file: fixture.paths[file]!, line: 2, column: 9 });
        expect(refs.status).toBe("ok");
        if (refs.status === "ok") {
          const wrongTarget = refs.references.some(
            (reference) =>
              reference.file.replace(/\\/g, "/") === fixture.paths["positioned.py"] &&
              reference.range.start.line === excludedLine,
          );
          expect(wrongTarget).toBe(false);
        }
      }
      const annotation = await goToDefinition(fixture.index, {
        file: fixture.paths["local_wins.py"]!,
        line: 7,
        column: 19,
      });
      expect(annotation.status).toBe("ok");
      if (annotation.status === "ok") expect(annotation.definition.range.start.line).toBe(2);
      const shadowed = await goToDefinition(fixture.index, {
        file: fixture.paths["no_import.py"]!,
        line: 5,
        column: 17,
      });
      expect(shadowed.status).toBe("not_found");
      const caller = findDetailedNode(fixture, "no_import.py", "shadow");
      const decoy = findDetailedNode(fixture, "no_import.py", "run");
      expect(hasDetailedEdge(fixture, caller.id, decoy.id, "calls")).toBe(false);
      const references = await findReferences(fixture.index, {
        file: fixture.paths["no_import.py"]!,
        line: 2,
        column: 9,
      });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        const shadowUse = references.references.some(
          (reference) =>
            reference.file.replace(/\\/g, "/") === fixture.paths["no_import.py"] && reference.range.start.line === 5,
        );
        expect(shadowUse).toBe(false);
      }
      const nested = await goToDefinition(fixture.index, {
        file: fixture.paths["nested.py"]!,
        line: 6,
        column: 21,
      });
      expect(nested.status).toBe("not_found");
      const nestedCaller = findDetailedNode(fixture, "nested.py", "inner");
      const nestedDecoy = findDetailedNode(fixture, "nested.py", "run");
      expect(hasDetailedEdge(fixture, nestedCaller.id, nestedDecoy.id, "calls")).toBe(false);
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });
});
