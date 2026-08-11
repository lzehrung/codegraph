import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/agent/session.js";
import { listCandidateTestFiles } from "../../src/impact/context.js";
import { normalizePath } from "../../src/util/paths.js";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { C_SUPPORT, CPP_SUPPORT, supportForFile } from "../../src/languages.js";
import { parseSyntaxTree } from "@lzehrung/codegraph-native";

const definition: LanguageTestDefinition = {
  id: "cpp",
  samples: [
    {
      name: "chunks C++ structures",
      sourceFile: "cpp.sample.cpp",
      exactChunks: [
        { type: "misc", startLine: 1, endLine: 2 },
        { type: "namespace", name: "demo", startLine: 3, endLine: 17 },
        { type: "class", name: "MyClass", startLine: 4, endLine: 7 },
        { type: "function", name: "method", startLine: 6, endLine: 6 },
        { type: "struct", name: "MyStruct", startLine: 9, endLine: 11 },
        { type: "enum", name: "MyMode", startLine: 13, endLine: 16 },
        { type: "misc", startLine: 17, endLine: 19 },
        { type: "function", name: "add", startLine: 20, endLine: 22 },
      ],
    },
  ],
  parity: {
    sampleDir: "cpp",
    exact: {
      dependencyGraph: [
        {
          from: "main.cpp",
          to: { type: "file", path: "helpers.hpp" },
        },
        {
          from: "main.cpp",
          to: { type: "file", path: "utils.hpp" },
        },
        {
          from: "namespace-usage.cpp",
          to: { type: "file", path: "namespaces.hpp" },
        },
      ],
      symbols: [
        {
          file: "advanced.hpp",
          symbols: [
            { name: "demo", kind: "class" },
            { name: "Mode", kind: "type" },
            { name: "Fast", kind: "variable" },
            { name: "Slow", kind: "variable" },
            { name: "Count", kind: "type" },
            { name: "Engine", kind: "class" },
            { name: "run", kind: "function" },
            { name: "combine", kind: "function" },
            { name: "left", kind: "variable" },
            { name: "right", kind: "variable" },
          ],
        },
        {
          file: "namespaces.hpp",
          symbols: [
            { name: "toolkit", kind: "class" },
            { name: "Widget", kind: "class" },
            { name: "buildWidget", kind: "function" },
            { name: "aliases", kind: "class" },
          ],
        },
        {
          file: "templates.hpp",
          symbols: [
            { name: "Holder", kind: "class" },
            { name: "Holder", kind: "function" },
            { name: "value", kind: "variable" },
            { name: "get", kind: "function" },
            { name: "value_", kind: "variable" },
            { name: "compute", kind: "function" },
            { name: "value", kind: "variable" },
            { name: "compute", kind: "function" },
            { name: "value", kind: "variable" },
          ],
        },
      ],
      references: [
        {
          name: "find references for Widget includes namespace alias usage",
          file: "namespaces.hpp",
          line: 4,
          column: 7,
          exactCount: 2,
        },
      ],
    },
    absentDependencyGraph: [{ from: "module-import.cpp", to: { type: "external", name: "foo" } }],
    goToDefinition: [
      {
        name: "go to definition resolves namespace-qualified Widget alias target",
        file: "namespace-usage.cpp",
        line: 4,
        column: 12,
        expectedDefinition: { file: "namespaces.hpp", line: 4 },
      },
    ],
  },
};

runLanguageTests(definition);

describe("C++ language boundaries", () => {
  it("identifies .h headers with C++ syntax", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-cpp-header-language-"));
    const cppHeader = path.join(root, "widget.h");
    const cHeader = path.join(root, "widget_c.h");
    try {
      await fs.writeFile(cppHeader, "namespace widgets { class Widget {}; }\n", "utf8");
      await fs.writeFile(cHeader, "struct Widget { int value; };\n", "utf8");

      expect(supportForFile(cppHeader)).toBe(CPP_SUPPORT);
      expect(supportForFile(cHeader)).toBe(C_SUPPORT);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("documents the C++20 module grammar limitation", () => {
    const tree = parseSyntaxTree("export module foo;\nimport foo;\n", "cpp");
    const nodeTypes = tree.nodes.map((node) => node.nodeType);

    expect(nodeTypes).not.toContain("module_declaration");
    expect(nodeTypes).not.toContain("import_declaration");
  });
});

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
