import path from "node:path";
import { expect } from "vitest";
import { runLanguageTests } from "./runner.js";
import type { LanguageTestDefinition } from "./types.js";
import { createTestIndexFromFiles } from "../test-utils.js";
import { fileIdentityKey } from "../../src/util/paths.js";
import { goToDefinition } from "../../src/index.js";

const definition: LanguageTestDefinition = {
  id: "javascript",
  samples: [
    {
      name: "chunks basic JavaScript structures",
      sourceFile: "javascript.sample.js",
      exactChunks: [
        { type: "comment", startLine: 1, endLine: 2 },
        { type: "imports", startLine: 3, endLine: 4 },
        { type: "module_var", name: "API_BASE_URL", startLine: 5, endLine: 6 },
        { type: "class", name: "Foo", startLine: 7, endLine: 18 },
        { type: "method", name: "constructor", startLine: 8, endLine: 10 },
        { type: "method", name: "bar", startLine: 12, endLine: 17 },
        { type: "misc", startLine: 18, endLine: 19 },
        { type: "comment", startLine: 20, endLine: 20 },
        { type: "function", name: "baz", startLine: 21, endLine: 23 },
      ],
    },
  ],
  parity: {
    sampleDir: "javascript",
    exact: {
      dependencyGraph: [
        {
          from: "dynamic-import.js",
          to: { type: "file", path: "helpers.js" },
        },
        {
          from: "main.js",
          to: { type: "file", path: "helpers.js" },
        },
        {
          from: "main.js",
          to: { type: "file", path: "utils.js" },
        },
        {
          from: "utils.js",
          to: { type: "file", path: "helpers.js" },
        },
      ],
      references: [
        {
          name: "find references for helpers.js helperFunction distinguishes the same-named utils.js export",
          file: "helpers.js",
          line: 1,
          column: 17,
          references: [
            { file: "helpers.js", line: 1 },
            { file: "helpers.js", line: 18 },
            { file: "main.js", line: 25 },
            { file: "main.js", line: 33 },
          ],
        },
        {
          name: "find references for UtilityClass.getValue resolves through the receiver",
          file: "utils.js",
          line: 10,
          column: 3,
          references: [
            { file: "main.js", line: 13 },
            { file: "utils.js", line: 10 },
          ],
        },
      ],
    },
  },
};

runLanguageTests(definition);

describe("CommonJS spread exports", () => {
  it("resolves static sources and reports unresolved spread sources", async () => {
    const fixturePath = path.resolve(process.cwd(), "tests", "samples", "language-regressions", "javascript");
    const baseFile = path.join(fixturePath, "spread-base.js").replace(/\\/g, "/");
    const barrelFile = path.join(fixturePath, "spread-exports.js").replace(/\\/g, "/");
    const consumerFile = path.join(fixturePath, "spread-consumer.js").replace(/\\/g, "/");
    const index = await createTestIndexFromFiles(fixturePath, [baseFile, barrelFile, consumerFile]);
    const barrel = index.byFile.get(fileIdentityKey(barrelFile));

    expect(barrel).toBeDefined();
    if (!barrel) return;
    expect(barrel.exports).toContainEqual({
      type: "exportStar",
      fromModule: baseFile,
      moduleSpecifier: "./spread-base",
      sourceSpecifier: "./spread-base",
    });
    expect(barrel.exports).toContainEqual({
      type: "namespaceReexport",
      exportedAs: "<unresolved cjs spread: dynamic>",
      fromModule: "<unresolved cjs spread: dynamic>",
    });
    expect(barrel.exports.map((entry) => (entry.type === "local" ? entry.exportedAs : entry.type))).toContain(
      "localFunction",
    );
    const baseResult = await goToDefinition(index, { file: consumerFile, line: 3, column: 2 });
    expect(baseResult.status).toBe("ok");
    if (baseResult.status === "ok") {
      expect(baseResult.definition.file).toBe(baseFile);
      expect(baseResult.definition.range.start.line).toBe(1);
    }
    const localResult = await goToDefinition(index, { file: consumerFile, line: 4, column: 2 });
    expect(localResult.status).toBe("ok");
    if (localResult.status === "ok") {
      expect(localResult.definition.file).toBe(barrelFile);
      expect(localResult.definition.range.start.line).toBe(3);
    }
  });
});
