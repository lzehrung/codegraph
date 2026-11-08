import fs from "node:fs/promises";
import { afterAll, describe, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import { PYTHON_DOTTED_IMPORT_FILES, expectPythonDottedImports } from "./helpers/python-dotted-import-fixture.js";
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
});
