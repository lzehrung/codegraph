import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";

import { buildProjectIndex, goToDefinition, type ProjectIndex } from "../src/index.js";

const projectRoot = path.resolve(process.cwd(), "tests", "samples", "json-imports");
const normalize = (p: string) => p.replace(/\\/g, "/");

describe("JSON module imports", () => {
  let index: ProjectIndex;
  const jsFile = normalize(path.join(projectRoot, "src", "index.js"));
  const jsonFile = normalize(path.join(projectRoot, "src", "data.json"));

  beforeAll(async () => {
    index = await buildProjectIndex(projectRoot);
  });

  it("creates stub modules with default exports for JSON files", () => {
    const jsonModule = index.byFile.get(jsonFile);
    expect(jsonModule).toBeDefined();
    expect(
      jsonModule?.exports.some(
        (e) => e.type === "local" && e.exportedAs === "default"
      )
    ).toBe(true);

    const jsModule = index.byFile.get(jsFile);
    expect(jsModule).toBeDefined();
    const defaultImport = jsModule?.imports.find(
      (imp) => imp.kind === "default" && imp.from.includes("./data.json")
    );
    expect(defaultImport?.resolved).toBe(jsonFile);
  });

  it("resolves go-to-definition for default JSON imports", async () => {
    const result = await goToDefinition(index, {
      file: jsFile,
      line: 1,
      column: 10,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe(jsonFile);
      expect(result.definition.localName).toBe("default");
    }
  });

  it("emits dependency edges pointing to JSON modules", () => {
    const hasEdge = index.graph.edges.some(
      (edge) => edge.to.type === "file" && edge.to.path === jsonFile
    );
    expect(hasEdge).toBe(true);
  });

  it("does not resolve named imports from JSON modules", async () => {
    const result = await goToDefinition(index, {
      file: jsFile,
      line: 8,
      column: 25,
    });
    expect(result.status).toBe("not_found");
  });
});

