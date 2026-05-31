import path from "node:path";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildCodegraphArtifact } from "../src/agent/artifact.js";
import { analyzeArchitectureDrift, loadArchitectureSnapshotFromArtifact } from "../src/drift/index.js";
import { mkTmpDir } from "./helpers/filesystem.js";

async function writeFile(root: string, file: string, content: string): Promise<void> {
  const fullPath = path.join(root, file);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content, "utf8");
}

describe("architecture drift artifact baselines", () => {
  it("loads a manifest-backed graph artifact and ignores unrelated files", async () => {
    const root = await mkTmpDir("cg-drift-artifact-");
    await writeFile(root, "src/a.ts", "import { b } from './b'; export function a() { return b(); }\n");
    await writeFile(root, "src/b.ts", "export function b() { return 1; }\n");
    const outDir = path.join(root, "baseline");
    await buildCodegraphArtifact({ root, outDir, graphJson: true });
    await writeFile(outDir, "notes.txt", "operator notes\n");

    const snapshot = await loadArchitectureSnapshotFromArtifact(outDir);

    expect(snapshot.files.total).toBe(2);
    expect(snapshot.unresolved.total).toBe(0);
  });

  it("compares artifact baselines to the current checkout", async () => {
    const root = await mkTmpDir("cg-drift-artifact-head-");
    await writeFile(root, "src/a.ts", "import { b } from './b'; export function a() { return b(); }\n");
    await writeFile(root, "src/b.ts", "export function b() { return 1; }\n");
    const outDir = path.join(root, "baseline");
    await buildCodegraphArtifact({ root, outDir, graphJson: true });

    await writeFile(root, "src/b.ts", "import { a } from './a'; export function b() { return a(); }\n");
    const report = await analyzeArchitectureDrift(root, { baseArtifact: outDir, head: ".", includeRoots: ["src"] });

    expect(report.findings).toContainEqual(expect.objectContaining({ kind: "new-cycle" }));
  });

  it("rejects non-current heads when comparing against an artifact baseline", async () => {
    const root = await mkTmpDir("cg-drift-artifact-reject-head-");
    await writeFile(root, "src/a.ts", "export function a() { return 1; }\n");
    const outDir = path.join(root, "baseline");
    await buildCodegraphArtifact({ root, outDir, graphJson: true });

    await expect(
      analyzeArchitectureDrift(root, { baseArtifact: outDir, head: "HEAD~1", includeRoots: ["src"] }),
    ).rejects.toThrow("base-artifact");
  });

  it("does not report unresolved-import drift for declared package imports from graph-json artifacts", async () => {
    const root = await mkTmpDir("cg-drift-artifact-unresolved-");
    await writeFile(root, "package.json", '{\n  "name": "artifact-unresolved",\n  "dependencies": { "left-pad": "1.3.0" }\n}\n');
    await writeFile(root, "src/a.ts", 'import leftPad from "left-pad";\nexport const value = leftPad("a", 2);\n');
    const outDir = path.join(root, "baseline");
    await buildCodegraphArtifact({ root, outDir, graphJson: true });

    const report = await analyzeArchitectureDrift(root, { baseArtifact: outDir, head: ".", includeRoots: ["src"] });

    expect(report.findings.some((finding) => finding.kind === "unresolved-import")).toBe(false);
    expect(report.findings.some((finding) => finding.kind === "resolved-unresolved-import")).toBe(false);
  });

  it("rejects missing artifact manifest and graph files with clear errors", async () => {
    const missingManifest = await mkTmpDir("cg-drift-missing-manifest-");
    await expect(loadArchitectureSnapshotFromArtifact(missingManifest)).rejects.toThrow("Codegraph artifact manifest");

    const missingGraph = await mkTmpDir("cg-drift-missing-graph-");
    await fsp.writeFile(
      path.join(missingGraph, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        graphJsonSchema: "codegraph.graph-json",
        artifacts: { graphJson: "graph.json" },
      }),
      "utf8",
    );

    await expect(loadArchitectureSnapshotFromArtifact(missingGraph)).rejects.toThrow("Codegraph artifact graph.json");
  });

  it("does not invent API or duplicate drift from derived artifact baselines", async () => {
    const root = await mkTmpDir("cg-drift-artifact-derived-");
    await writeFile(
      root,
      "src/a.ts",
      "function helper() { return 1; }\nexport function a() { return helper(); }\n",
    );
    const outDir = path.join(root, "baseline");
    await buildCodegraphArtifact({ root, outDir, graphJson: true });

    await writeFile(
      root,
      "src/a.ts",
      "function renamedHelper() { return 1; }\nexport function a() { return renamedHelper(); }\n",
    );
    const report = await analyzeArchitectureDrift(root, { baseArtifact: outDir, head: ".", includeRoots: ["src"] });

    expect(report.findings.some((finding) => finding.kind === "public-api-addition")).toBe(false);
    expect(report.findings.some((finding) => finding.kind === "public-api-removal")).toBe(false);
    expect(report.findings.some((finding) => finding.kind === "duplicate-increase")).toBe(false);
    expect(report.findings.some((finding) => finding.kind === "duplicate-decrease")).toBe(false);
  });

  it("rejects directories without required artifact files", async () => {
    const root = await mkTmpDir("cg-drift-bad-artifact-");
    await fsp.writeFile(path.join(root, "manifest.json"), "{}\n", "utf8");

    await expect(loadArchitectureSnapshotFromArtifact(root)).rejects.toThrow("Codegraph artifact manifest");
  });
});
