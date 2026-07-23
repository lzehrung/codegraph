import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/agent/session.js";
import { listCandidateTestFiles } from "../../src/impact/context.js";
import { normalizePath } from "../../src/util/paths.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";

const definition: LanguageTestDefinition = {
  id: "cpp",
  samples: [
    {
      name: "chunks C++ structures",
      sourceFile: "cpp.sample.cpp",
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "class" && c.name === "MyClass")).toBe(true);
        expect(chunks.some((c) => c.type === "struct" && c.name === "MyStruct")).toBe(true);
        expect(chunks.some((c) => c.type === "enum" && c.name === "MyMode")).toBe(true);
        expect(chunks.some((c) => c.type === "function" && c.name === "add")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "cpp",
    dependencyGraph: [
      { from: "main.cpp", to: { type: "file", path: "utils.hpp" } },
      { from: "main.cpp", to: { type: "file", path: "helpers.hpp" } },
      { from: "namespace-usage.cpp", to: { type: "file", path: "namespaces.hpp" } },
    ],
    symbols: [
      {
        file: "advanced.hpp",
        includes: [
          { name: "demo" },
          { name: "Mode", kind: "type" },
          { name: "Fast", kind: "variable" },
          { name: "Slow", kind: "variable" },
          { name: "Count" },
          { name: "Engine" },
          { name: "combine" },
        ],
      },
      {
        file: "namespaces.hpp",
        includes: [{ name: "toolkit" }, { name: "Widget" }, { name: "buildWidget" }],
      },
      {
        file: "templates.hpp",
        includes: [{ name: "Holder" }, { name: "compute" }],
      },
    ],
    goToDefinition: [
      {
        name: "go to definition resolves namespace-qualified Widget alias target",
        file: "namespace-usage.cpp",
        line: 4,
        column: 12,
        expectedDefinition: { file: "namespaces.hpp", line: 4 },
      },
    ],
    references: [
      {
        name: "find references for Widget includes namespace alias usage",
        file: "namespaces.hpp",
        line: 4,
        column: 7,
        minimumCount: 2,
      },
    ],
  },
};

runLanguageTests(definition);

describe("C++ configured include roots", () => {
  it("loads Gunship-shaped resolution hints and ranks linked and changed tests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-gunship-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-outside-"));
    const privateRoot = path.join(root, "Source", "Gunship", "Private");
    const model = path.join(privateRoot, "Damage", "Simulation", "GunshipDamageModel.h");
    const test = path.join(privateRoot, "Damage", "Tests", "DamageModelTests.cpp");
    const escapingTest = path.join(privateRoot, "Damage", "Tests", "EscapingHintTests.cpp");
    const outsideHeader = path.join(outside, "Secret.h");
    try {
      await fs.mkdir(path.dirname(model), { recursive: true });
      await fs.mkdir(path.dirname(test), { recursive: true });
      await fs.writeFile(model, "class GunshipDamageModel {};\n", "utf8");
      await fs.writeFile(
        test,
        '#include "Damage/Simulation/GunshipDamageModel.h"\nGunshipDamageModel model;\n',
        "utf8",
      );
      await fs.writeFile(escapingTest, '#include "Secret.h"\n', "utf8");
      await fs.writeFile(outsideHeader, "class Secret {};\n", "utf8");
      await fs.writeFile(
        path.join(root, "codegraph.config.json"),
        JSON.stringify({
          graph: {
            resolutionHints: ["Source/Gunship/Private", `../${path.basename(outside)}`],
          },
        }),
        "utf8",
      );

      const snapshot = await createAgentSession({
        root,
        buildOptions: { cache: "memory" },
      }).loadProject({ symbolGraph: "skip" });
      const normalizedModel = normalizePath(model);
      const normalizedTest = normalizePath(test);
      const normalizedOutside = normalizePath(outsideHeader);

      expect(snapshot.fileGraph.edges).toContainEqual(
        expect.objectContaining({
          from: normalizedTest,
          to: { type: "file", path: normalizedModel },
        }),
      );
      expect(
        snapshot.fileGraph.edges.some((edge) => edge.to.type === "file" && edge.to.path === normalizedOutside),
      ).toBe(false);

      expect(listCandidateTestFiles(snapshot.index, [normalizedTest], [], { projectRoot: root })).toContainEqual({
        file: normalizedTest,
        confidence: "high",
        reason: "changedTest",
      });
      expect(
        listCandidateTestFiles(snapshot.index, [normalizedModel], [`${normalizedModel}::GunshipDamageModel::0`], {
          projectRoot: root,
        }),
      ).toContainEqual({
        file: normalizedTest,
        confidence: "high",
        reason: "importsChanged",
      });

      const sparseIndex = {
        ...snapshot.index,
        graph: { ...snapshot.index.graph, edges: [] },
        graphAdjacency: undefined,
      };
      expect(
        listCandidateTestFiles(sparseIndex, [normalizedModel], [`${normalizedModel}::GunshipDamageModel::0`], {
          projectRoot: root,
        }),
      ).toContainEqual({
        file: normalizedTest,
        confidence: "high",
        reason: "symbolReference",
      });
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});
