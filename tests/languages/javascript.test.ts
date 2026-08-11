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
      expectedChunks: (chunks) => {
        expect(chunks.some((c) => c.type === "comment")).toBe(true);
        expect(chunks.some((c) => c.type === "imports")).toBe(true);
        expect(chunks.some((c) => c.type === "module_var" && c.name === "API_BASE_URL")).toBe(true);
        expect(chunks.some((c) => c.type === "class" && c.name === "Foo")).toBe(true);
        expect(chunks.some((c) => c.type === "method" && c.name === "bar")).toBe(true);
        expect(chunks.some((c) => c.type === "function" && c.name === "baz")).toBe(true);
      },
    },
  ],
  parity: {
    sampleDir: "javascript",
    dependencyGraph: [
      {
        from: "dynamic-import.js",
        to: { type: "file", path: "helpers.js" },
      },
    ],
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
    expect(
      barrel.exports.map((entry) => (entry.type === "local" ? entry.exportedAs : entry.type)),
    ).toContain("localFunction");
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
