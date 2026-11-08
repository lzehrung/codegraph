import fs from "node:fs/promises";
import { afterAll, describe, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import { QUALIFIED_BASE_FIXTURES, expectQualifiedBases } from "./helpers/qualified-base-fixture.js";
import { writeFixtureFiles } from "./languages/callable-consumer-fixtures.js";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

describe("Qualified base classes resolve through their qualifier", () => {
  it.each(QUALIFIED_BASE_FIXTURES)(
    "binds $language bases by qualifier, never by a same-named decoy or the qualifier itself",
    async (fixture) => {
      const root = await mkTmpDir("cg-qualified-base-");
      roots.push(root);
      await writeFixtureFiles(root, fixture.files);
      const index = await buildProjectIndex(root, { cache: "off" });
      const graph = await buildSymbolGraphDetailed(index);
      await expectQualifiedBases(root, index, graph, fixture, "cold");
    },
  );
});
