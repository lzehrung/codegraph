import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { buildProjectIndex, goToDefinition, type ProjectIndex } from "../src/index.js";

const projectRoot = path.resolve(process.cwd(), "tests", "samples", "json-imports");
const normalize = (p: string) => p.replace(/\\/g, "/");

function positionOf(source: string, needle: string, occurrence = 1): { line: number; column: number } {
  let idx = -1;
  let start = 0;
  for (let count = 0; count < occurrence; count++) {
    idx = source.indexOf(needle, start);
    if (idx === -1) {
      throw new Error(`Cannot find occurrence ${occurrence} of "${needle}" in source`);
    }
    start = idx + needle.length;
  }

  let line = 1;
  let column = 1;
  for (let i = 0; i < idx; i++) {
    const char = source[i]!;
    if (char === "\n") {
      line++;
      column = 1;
      continue;
    }
    if (char === "\r") continue;
    column++;
  }
  return { line, column };
}

describe("JSON module imports", () => {
  let index: ProjectIndex;
  const jsFileAbsolute = path.join(projectRoot, "src", "index.js");
  const jsonFileAbsolute = path.join(projectRoot, "src", "data.json");
  const jsFile = normalize(jsFileAbsolute);
  const jsonFile = normalize(jsonFileAbsolute);
  const jsSource = fs.readFileSync(jsFileAbsolute, "utf8");
  const configImportPos = positionOf(jsSource, "config from");
  const configNameImportPos = positionOf(jsSource, "configName", 1);

  beforeAll(async () => {
    index = await buildProjectIndex(projectRoot);
  });

  it("creates stub modules with default exports for JSON files", () => {
    const jsonModule = index.byFile.get(jsonFile);
    expect(jsonModule).toBeDefined();
    expect(jsonModule?.exports.some((e) => e.type === "local" && e.exportedAs === "default")).toBe(true);

    const jsModule = index.byFile.get(jsFile);
    expect(jsModule).toBeDefined();
    const defaultImport = jsModule?.imports.find((imp) => imp.kind === "default" && imp.from.includes("./data.json"));
    expect(defaultImport?.resolved).toBe(jsonFile);
  });

  it("resolves go-to-definition for default JSON imports", async () => {
    const result = await goToDefinition(index, {
      file: jsFile,
      line: configImportPos.line,
      column: configImportPos.column,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(jsonFile);
      expect(result.definition.localName).toBe("default");
    }
  });

  it("emits dependency edges pointing to JSON modules", () => {
    const hasEdge = index.graph.edges.some((edge) => edge.to.type === "file" && edge.to.path === jsonFile);
    expect(hasEdge).toBe(true);
  });

  it("does not resolve named imports from JSON modules", async () => {
    const result = await goToDefinition(index, {
      file: jsFile,
      line: configNameImportPos.line,
      column: configNameImportPos.column,
    });
    expect(result.status).toBe("not_found");
  });
});
