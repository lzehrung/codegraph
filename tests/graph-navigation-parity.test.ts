import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProjectIndex } from "../src/index.js";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { isNativeTreeSitterAvailable } from "../src/native/tree-sitter-native.js";
import { collectGraphNavigationMismatches, type GraphNavigationMismatch } from "./helpers/graph-navigation-parity.js";

// The detailed graph needs the native parser; every sample set is read-only.
const suite = isNativeTreeSitterAvailable() ? describe : describe.skip;

const SAMPLE_SETS = [
  "c",
  "cpp",
  "csharp",
  "go",
  "java",
  "javascript",
  "kotlin",
  "language-regressions",
  "php",
  "python",
  "python_ns",
  "ruby",
  "rust",
  "swift",
  "tsx",
  "typescript",
  "zig",
];

/**
 * One directory per call form that has diverged between goto and the graph. Each directory is
 * its own project root, so its files never interact with another case.
 */
const CORPUS_ROOT = path.resolve(process.cwd(), "tests", "samples", "graph-navigation-parity");
const CORPUS_CASES = fs.existsSync(CORPUS_ROOT)
  ? fs
      .readdirSync(CORPUS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : [];

async function mismatchesAt(root: string): Promise<GraphNavigationMismatch[]> {
  const index = await buildProjectIndex(root, { cache: "off", native: "on" });
  const graph = await buildSymbolGraphDetailed(index);
  return collectGraphNavigationMismatches(index, graph, root);
}

suite("goToDefinition and the detailed graph agree on every call site", () => {
  it.each(SAMPLE_SETS)("tests/samples/%s", async (sampleSet) => {
    expect(await mismatchesAt(path.resolve(process.cwd(), "tests", "samples", sampleSet))).toEqual([]);
  });
  it.each(CORPUS_CASES)("tests/samples/graph-navigation-parity/%s", async (caseName) => {
    expect(await mismatchesAt(path.join(CORPUS_ROOT, caseName))).toEqual([]);
  });
});
