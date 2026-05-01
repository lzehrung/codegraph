import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import * as codegraph from "../src/index.js";
import {
  tool_listProjectFiles,
  tool_getGraph,
  tool_getDependencies,
  tool_getReverseDependencies,
  tool_getHotspots,
  tool_getFileOverview,
  tool_goToDefinition,
  tool_findReferences,
  tool_findSymbol,
  tool_impactFromDiffText,
} from "../src/agent-tools.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Agent Tools", () => {
  const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");

  it("tool_listProjectFiles should list files", async () => {
    const result = await tool_listProjectFiles(samplePath);
    expect(result.status).toBe("ok");
    expect(result.files).toBeDefined();
    expect(result.files?.every((file) => !path.isAbsolute(file))).toBe(true);
    expect(result.files!.some((f) => f.replace(/\\/g, "/").endsWith("main.ts"))).toBe(true);
  });

  it("tool_getGraph should return graph", async () => {
    const result = await tool_getGraph(samplePath);
    expect(result.status).toBe("ok");
    expect(result.graph).toBeDefined();
    expect(result.graph!.nodes.length).toBeGreaterThan(0);
    expect(result.graph!.edges).toBeDefined();
    expect(result.graph?.nodes.every((node) => !path.isAbsolute(node))).toBe(true);
    expect(
      result.graph?.edges.every(
        (edge) => !path.isAbsolute(edge.from) && (edge.to.type !== "file" || !path.isAbsolute(edge.to.path)),
      ),
    ).toBe(true);
  });

  it("tool_getGraph accepts explicit native mode overrides", async () => {
    const result = await tool_getGraph(samplePath, { native: "off" });
    expect(result.status).toBe("ok");
    expect(result.graph).toBeDefined();
    expect(result.graph!.nodes.length).toBeGreaterThan(0);
  });

  it("tool_getDependencies returns bounded normalized dependencies", async () => {
    const result = await tool_getDependencies(samplePath, "main.ts", { depth: 1, limit: 5 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.file).toBe("main.ts");
      expect(result.dependencies.some((entry) => entry.file === "utils.ts" && entry.depth === 1)).toBe(true);
      expect(result.dependencies.every((entry) => !path.isAbsolute(entry.file))).toBe(true);
      expect(result.truncated).toBe(false);
    }
  });

  it("tool_getDependencies distinguishes existing but unindexed files", async () => {
    const root = await mkTmpDir("dg-agent-deps-unindexed-");
    await fsp.writeFile(path.join(root, "main.ts"), "export const value = 1;\n", "utf8");
    await fsp.writeFile(path.join(root, "notes.txt"), "plain text\n", "utf8");

    const result = await tool_getDependencies(root, "notes.txt");
    expect(result.status).toBe("not_found");
    if (result.status === "not_found") {
      expect(result.file).toBe("notes.txt");
      expect(result.reason).toBe("file_not_indexed");
      expect(result.error).toContain("not indexed");
    }
  });

  it("tool_getDependencies clamps non-positive limits to empty bounded results", async () => {
    const dependenciesResult = await tool_getDependencies(samplePath, "main.ts", { depth: 1, limit: -1 });
    expect(dependenciesResult.status).toBe("ok");
    if (dependenciesResult.status === "ok") {
      expect(dependenciesResult.dependencies).toEqual([]);
      expect(dependenciesResult.truncated).toBe(true);
    }

    const reverseDependenciesResult = await tool_getReverseDependencies(samplePath, "utils.ts", {
      depth: 1,
      limit: -1,
    });
    expect(reverseDependenciesResult.status).toBe("ok");
    if (reverseDependenciesResult.status === "ok") {
      expect(reverseDependenciesResult.dependents).toEqual([]);
      expect(reverseDependenciesResult.truncated).toBe(true);
    }
  });

  it("tool_getReverseDependencies returns bounded normalized dependents", async () => {
    const result = await tool_getReverseDependencies(samplePath, "utils.ts", { depth: 1, limit: 5 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.file).toBe("utils.ts");
      expect(result.dependents.some((entry) => entry.file === "main.ts" && entry.depth === 1)).toBe(true);
      expect(result.dependents.every((entry) => !path.isAbsolute(entry.file))).toBe(true);
      expect(result.truncated).toBe(false);
    }
  });

  it("tool_getHotspots returns ranked bounded hotspots", async () => {
    const result = await tool_getHotspots(samplePath, { limit: 3 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.hotspots.length).toBeLessThanOrEqual(3);
      expect(result.hotspots.every((entry) => !path.isAbsolute(entry.file))).toBe(true);
      expect(result.hotspots.every((entry) => typeof entry.score === "number")).toBe(true);
      expect(result.hotspots.some((entry) => entry.file === "utils.ts")).toBe(true);
    }
  });

  it("tool_getHotspots ignores non-finite limits", async () => {
    const baseline = await tool_getHotspots(samplePath);
    const withNaN = await tool_getHotspots(samplePath, { limit: Number.NaN });
    const withInfinity = await tool_getHotspots(samplePath, { limit: Number.POSITIVE_INFINITY });
    expect(baseline).toEqual(withNaN);
    expect(baseline).toEqual(withInfinity);
  });

  it("tool_getFileOverview returns structured overviews", async () => {
    const result = await tool_getFileOverview(samplePath, "main.ts");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.file).toBe("main.ts");
      expect(result.hasSymbols).toBe(true);
      expect(Array.isArray(result.overview.imports)).toBe(true);
      expect(Array.isArray(result.overview.definitions)).toBe(true);
      expect(result.overview.imports.length).toBeGreaterThan(0);
      expect(result.overview.imports.some((entry) => entry.from === "./utils")).toBe(true);
      expect(result.overview.imports.every((entry) => !entry.resolved || !path.isAbsolute(entry.resolved))).toBe(true);
      expect(result.overview.imports.some((entry) => entry.resolved === "utils.ts")).toBe(true);
      expect(result.overview.definitions.some((entry) => entry.name === "main")).toBe(true);
      expect(typeof result.renderedOverview).toBe("string");
      expect(result.renderedOverview).toContain("# Overview of main.ts");
    }
  });

  it("tool_getFileOverview distinguishes files with no symbols", async () => {
    const root = await mkTmpDir("dg-agent-overview-");
    await fsp.writeFile(path.join(root, "empty.ts"), "\n", "utf8");

    const result = await tool_getFileOverview(root, "empty.ts");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.file).toBe("empty.ts");
      expect(result.hasSymbols).toBe(false);
      expect(result.overview.imports).toEqual([]);
      expect(result.overview.definitions).toEqual([]);
      expect(result.renderedOverview).toContain("No symbols found.");
    }
  });

  it("tool_getFileOverview and tool_findSymbol keep shadowed locals distinct from exported definitions", async () => {
    const root = await mkTmpDir("dg-agent-shadowed-exports-");
    await fsp.writeFile(
      path.join(root, "main.ts"),
      "export const value = 1;\nfunction demo() { const value = 2; return value; }\n",
      "utf8",
    );

    const overview = await tool_getFileOverview(root, "main.ts");
    expect(overview.status).toBe("ok");
    if (overview.status === "ok") {
      const exportedValue = overview.overview.definitions.find((entry) => entry.name === "value" && entry.line === 1);
      const shadowedValue = overview.overview.definitions.find((entry) => entry.name === "value" && entry.line === 2);
      expect(exportedValue?.exported).toBe(true);
      expect(shadowedValue?.exported).toBe(false);
    }

    const symbols = await tool_findSymbol(root, "value");
    expect(symbols.status).toBe("ok");
    if (symbols.status === "ok") {
      const exportedValue = symbols.matches.find((entry) => entry.name === "value" && entry.line === 1);
      const shadowedValue = symbols.matches.find((entry) => entry.name === "value" && entry.line === 2);
      expect(exportedValue?.exported).toBe(true);
      expect(shadowedValue?.exported).toBe(false);
    }
  });

  it("tool_getFileOverview returns not_found for missing files", async () => {
    const result = await tool_getFileOverview(samplePath, "missing.ts");
    expect(result.status).toBe("not_found");
    if (result.status === "not_found") {
      expect(result.file).toBe("missing.ts");
      expect(result.reason).toBe("file_not_found");
    }
  });

  it("tool_getFileOverview returns structured errors for invalid roots", async () => {
    const result = await tool_getFileOverview("Z:/definitely-missing-codegraph-root", "main.ts");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("Project root does not exist or is not readable");
    }
  });

  it("tool_getFileOverview rejects files outside the project root", async () => {
    const buildSpy = vi.spyOn(codegraph, "buildProjectIndex");
    try {
      const result = await tool_getFileOverview(samplePath, path.resolve("README.md"));
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.reason).toBe("outside_project_root");
        expect(result.error).toContain("outside project root");
      }
      expect(buildSpy).not.toHaveBeenCalled();
    } finally {
      buildSpy.mockRestore();
    }
  });

  it("tool_goToDefinition should find definition", async () => {
    const mainFile = path.join(samplePath, "main.ts");
    // Line 7, column 25 is helperFunction() call which is imported from utils.ts
    const result = await tool_goToDefinition(samplePath, mainFile, 7, 25);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe("utils.ts");
      expect(result.definition.range.start.line).toBe(1);
      expect(path.isAbsolute(result.definition.file)).toBe(false);
      expect(path.isAbsolute(result.via?.importedFrom ?? "")).toBe(false);
      expect(typeof result.via?.exportedName).toBe("string");
      expect(result.provenance?.resolution).toBe("namespace");
      expect(result.provenance?.confidence).toBe("medium");
    }
  });

  it("tool_findReferences should find references", async () => {
    const utilsFile = path.join(samplePath, "utils.ts");
    // Line 1, column 17 is helperFunction definition
    const result = await tool_findReferences(samplePath, utilsFile, 1, 17);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition?.file).toBe("utils.ts");
      expect(result.references.length).toBeGreaterThan(0);
      expect(result.references.every((reference) => !path.isAbsolute(reference.file))).toBe(true);
      const firstImportReference = result.references.find((reference) => reference.via?.import);
      expect(firstImportReference?.via?.import?.resolved).toBe("utils.ts");
      expect(result.references.every((reference) => typeof reference.range.start.line === "number")).toBe(true);
      expect(result.provenance?.resolution).toBe("exact");
      expect(result.provenance?.confidence).toBe("high");
    }
  });

  it("tool_goToDefinition handles relative paths", async () => {
    const result = await tool_goToDefinition(samplePath, "main.ts", 7, 25);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe("utils.ts");
    }
  });

  it("tool_goToDefinition rejects files outside the project root", async () => {
    const buildSpy = vi.spyOn(codegraph, "buildProjectIndex");
    try {
      const result = await tool_goToDefinition(samplePath, path.resolve("README.md"), 1, 1);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.reason).toBe("outside_project_root");
        expect(result.error).toContain("outside project root");
      }
      expect(buildSpy).not.toHaveBeenCalled();
    } finally {
      buildSpy.mockRestore();
    }
  });

  it("tool_findReferences rejects files outside the project root", async () => {
    const buildSpy = vi.spyOn(codegraph, "buildProjectIndex");
    try {
      const result = await tool_findReferences(samplePath, path.resolve("README.md"), 1, 1);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.reason).toBe("outside_project_root");
        expect(result.error).toContain("outside project root");
      }
      expect(buildSpy).not.toHaveBeenCalled();
    } finally {
      buildSpy.mockRestore();
    }
  });

  it("tool_findSymbol returns structured matches", async () => {
    const result = await tool_findSymbol(samplePath, "helperFunction");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.some((match) => match.name === "helperFunction")).toBe(true);
      const firstMatch = result.matches[0];
      expect(firstMatch?.name).toBe("helperFunction");
      expect(firstMatch?.kind).toBe("function");
      expect(["helpers.ts", "utils.ts"]).toContain(firstMatch?.file);
      expect(typeof firstMatch?.line).toBe("number");
      expect(path.isAbsolute(firstMatch?.file ?? "")).toBe(false);
      expect(typeof firstMatch?.id).toBe("string");
      expect(firstMatch?.range?.start.line).toBe(firstMatch?.line);
      expect(typeof firstMatch?.exported).toBe("boolean");
      expect(firstMatch?.exactMatch).toBe(true);
      expect(firstMatch?.matchKind).toBe("exact");
    }
  });

  it("tool_impactFromDiffText returns full impact reports for agents", async () => {
    const diffText = `diff --git a/utils.ts b/utils.ts
index 1111111..2222222 100644
--- a/utils.ts
+++ b/utils.ts
@@ -1,3 +1,3 @@
-export function helperFunction() {
+export function helperFunction() {
   return "Hello from helper";
 }
`;

    const result = await tool_impactFromDiffText(samplePath, diffText);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.report).toBeDefined();
      expect("changedFiles" in result.report!).toBe(true);
      expect("changedSymbols" in result.report!).toBe(true);
      expect("impacted" in result.report!).toBe(true);
      expect("surfaceArea" in result.report!).toBe(true);
      expect("graph" in result.report!).toBe(true);
      expect(result.report?.schemaVersion).toBe(1);
      expect(result.report?.format).toBe("full");
    }
  });

  it("tool_impactFromDiffText returns compact impact reports with explicit format metadata", async () => {
    const diffText = `diff --git a/utils.ts b/utils.ts
index 1111111..2222222 100644
--- a/utils.ts
+++ b/utils.ts
@@ -1,3 +1,3 @@
-export function helperFunction() {
+export function helperFunction() {
   return "Hello from helper";
 }
`;

    const result = await tool_impactFromDiffText(samplePath, diffText, { compact: true });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.report).toBeDefined();
      expect(result.report?.schemaVersion).toBe(1);
      expect(result.report?.format).toBe("compact");
      expect("files" in result.report!).toBe(true);
    }
  });

  it("tool_findSymbol returns structured errors for invalid roots", async () => {
    const result = await tool_findSymbol("Z:/definitely-missing-codegraph-root", "helperFunction");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("Project root does not exist or is not readable");
    }
  });
});
