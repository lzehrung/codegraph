import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import { findReferences, goToDefinition } from "../src/indexer/navigation.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import { QUALIFIED_BASE_FIXTURES, expectQualifiedBases, lines, positionOf } from "./helpers/qualified-base-fixture.js";
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

  it("leaves an unproven reopened Ruby root unresolved instead of selecting an enclosing decoy", async () => {
    const root = await mkTmpDir("cg-ruby-unproven-reopening-");
    roots.push(root);
    const files = {
      "unknown.rb": lines(
        "module Outer",
        "  module Lib",
        "    class Base; end",
        "  end",
        "  module Missing::Inner",
        "    class Child < Lib::Base; end",
        "  end",
        "  module ::Missing::Inner",
        "    class Absolute < Lib::Base; end",
        "  end",
        "end",
      ),
    };
    await writeFixtureFiles(root, files);
    const index = await buildProjectIndex(root, { cache: "off" });
    for (const occurrence of [0, 1]) {
      const result = await goToDefinition(index, {
        file: path.join(root, "unknown.rb"),
        ...positionOf(files, { file: "unknown.rb", marker: "Lib::Base", occurrence, offset: 5 }),
      });
      expect(result.status).toBe("not_found");
    }
    const refs = await findReferences(index, {
      file: path.join(root, "unknown.rb"),
      ...positionOf(files, { file: "unknown.rb", marker: "Base" }),
    });
    expect(refs.status).toBe("ok");
    if (refs.status !== "ok") return;
    expect(refs.references.map((reference) => reference.range.start.line)).not.toContain(6);
    expect(refs.references.map((reference) => reference.range.start.line)).not.toContain(9);
    expect(refs.referenceCoverage.state).toBe("partial");
    const graph = await buildSymbolGraphDetailed(index);
    const edges = graph.edges.filter((edge) => {
      const from = graph.nodes.get(edge.from);
      return edge.label === "extends" && (from?.name === "Child" || from?.name === "Absolute");
    });
    expect(edges).toEqual([]);
  });
});
