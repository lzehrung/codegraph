import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildProjectIndex, findReferences, goToDefinition } from "../src/index.js";
import { mkTmpDir } from "./helpers/filesystem.js";

// Class field declarations (public and `#private`) were absent from every
// language's native `locals` query -- only method-like declarations were
// queried -- so fields resolved to zero definitions. This covers the
// structural supplement in src/indexer/locals-and-exports.ts that fixes it.

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

type FieldCase = {
  label: string;
  file: string;
  source: string;
  declarationLine: number;
  declarationColumn: number;
  expectedName: string;
};

const fieldCases: FieldCase[] = [
  {
    label: "TypeScript public class field",
    file: "widget.ts",
    source: [
      "export class Widget {",
      "  size: number = 0;",
      "  grow(): void {",
      "    this.size += 1;",
      "  }",
      "}",
      "",
    ].join("\n"),
    declarationLine: 2,
    declarationColumn: 3,
    expectedName: "size",
  },
  {
    label: "TypeScript private class field",
    file: "counter.ts",
    source: [
      "export class Counter {",
      "  #count: number = 0;",
      "  increment(): void {",
      "    this.#count += 1;",
      "  }",
      "}",
      "",
    ].join("\n"),
    declarationLine: 2,
    declarationColumn: 3,
    expectedName: "#count",
  },
  {
    label: "TSX public class field",
    file: "widget.tsx",
    source: ["export class Widget {", "  size: number = 0;", "}", ""].join("\n"),
    declarationLine: 2,
    declarationColumn: 3,
    expectedName: "size",
  },
  {
    label: "JavaScript public class field",
    file: "widget.js",
    source: ["export class Widget {", "  size = 0;", "}", ""].join("\n"),
    declarationLine: 2,
    declarationColumn: 3,
    expectedName: "size",
  },
  {
    label: "JavaScript private class field",
    file: "counter.js",
    source: ["export class Counter {", "  #count = 0;", "}", ""].join("\n"),
    declarationLine: 2,
    declarationColumn: 3,
    expectedName: "#count",
  },
];

describe("class field locals", () => {
  it.each(fieldCases)("indexes $label as a navigable variable definition", async (testCase) => {
    const root = await mkTmpDir("cg-class-field-");
    roots.push(root);
    await fs.writeFile(path.join(root, testCase.file), testCase.source, "utf8");

    const index = await buildProjectIndex(root, { cache: "off" });
    const references = await findReferences(index, {
      file: path.join(root, testCase.file).replace(/\\/g, "/"),
      line: testCase.declarationLine,
      column: testCase.declarationColumn,
    });

    expect(references.status).toBe("ok");
    if (references.status !== "ok") return;
    expect(references.definition.localName).toBe(testCase.expectedName);
    expect(references.definition.kind).toBe("variable");
  });

  it("resolves goto from a constructed-receiver field access to the field declaration", async () => {
    const root = await mkTmpDir("cg-class-field-receiver-");
    roots.push(root);
    const file = path.join(root, "widget.ts");
    await fs.writeFile(
      file,
      [
        "export class Widget {",
        "  size: number = 0;",
        "}",
        "",
        "const w = new Widget();",
        "console.log(w.size);",
        "",
      ].join("\n"),
      "utf8",
    );

    const index = await buildProjectIndex(root, { cache: "off" });
    const result = await goToDefinition(index, { file: file.replace(/\\/g, "/"), line: 6, column: 16 });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.definition.localName).toBe("size");
    expect(result.definition.range.start.line).toBe(2);
  });
});
