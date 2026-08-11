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

  it("loads artifact cycles in deterministic key order", async () => {
    const root = await mkTmpDir("cg-drift-artifact-cycles-");
    await writeFile(
      root,
      "manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        graphJsonSchema: "codegraph.graph-json",
        artifacts: { graphJson: "graph.json" },
      }),
    );
    await writeFile(
      root,
      "graph.json",
      JSON.stringify({
        schemaVersion: 2,
        format: "codegraph.graph-json",
        files: ["z/a.ts", "z/b.ts", "a/a.ts", "a/b.ts"],
        fileEdges: [
          { from: "z/a.ts", to: { type: "file", path: "z/b.ts" }, raw: "./b" },
          { from: "z/b.ts", to: { type: "file", path: "z/a.ts" }, raw: "./a" },
          { from: "a/a.ts", to: { type: "file", path: "a/b.ts" }, raw: "./b" },
          { from: "a/b.ts", to: { type: "file", path: "a/a.ts" }, raw: "./a" },
        ],
        symbols: [],
        symbolEdges: [],
        graph: {
          files: ["z/a.ts", "z/b.ts", "a/a.ts", "a/b.ts"],
          fileEdges: [
            { from: "z/a.ts", to: { type: "file", path: "z/b.ts" }, raw: "./b" },
            { from: "z/b.ts", to: { type: "file", path: "z/a.ts" }, raw: "./a" },
            { from: "a/a.ts", to: { type: "file", path: "a/b.ts" }, raw: "./b" },
            { from: "a/b.ts", to: { type: "file", path: "a/a.ts" }, raw: "./a" },
          ],
          symbols: [],
          symbolEdges: [],
        },
      }),
    );

    const snapshot = await loadArchitectureSnapshotFromArtifact(root);

    expect(snapshot.cycles.map((cycle) => cycle.key)).toEqual(["a/a.ts\u0000a/b.ts", "z/a.ts\u0000z/b.ts"]);
  });

  it("builds distinct artifact cycle keys for ambiguous filenames", async () => {
    const root = await mkTmpDir("cg-drift-artifact-cycle-keys-");
    await writeFile(
      root,
      "manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        graphJsonSchema: "codegraph.graph-json",
        artifacts: { graphJson: "graph.json" },
      }),
    );
    await writeFile(
      root,
      "graph.json",
      JSON.stringify({
        schemaVersion: 2,
        format: "codegraph.graph-json",
        graph: {
          files: ["src/a.d.ts->b.ts", "src/c.ts", "src/a.d.ts", "b.ts->src/d.ts"],
          fileEdges: [
            { from: "src/a.d.ts->b.ts", to: { type: "file", path: "src/c.ts" }, raw: "./c" },
            { from: "src/c.ts", to: { type: "file", path: "src/a.d.ts->b.ts" }, raw: "./a.d.ts->b" },
            { from: "src/a.d.ts", to: { type: "file", path: "b.ts->src/d.ts" }, raw: "../b.ts->src/d" },
            { from: "b.ts->src/d.ts", to: { type: "file", path: "src/a.d.ts" }, raw: "../src/a.d" },
          ],
          symbols: [],
        },
      }),
    );

    const snapshot = await loadArchitectureSnapshotFromArtifact(root);

    expect(snapshot.cycles).toHaveLength(2);
    expect(new Set(snapshot.cycles.map((cycle) => cycle.key)).size).toBe(2);
  });

  it("loads artifact hotspots in file order", async () => {
    const root = await mkTmpDir("cg-drift-artifact-hotspots-");
    await writeFile(
      root,
      "manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        graphJsonSchema: "codegraph.graph-json",
        artifacts: { graphJson: "graph.json" },
      }),
    );
    await writeFile(
      root,
      "graph.json",
      JSON.stringify({
        schemaVersion: 2,
        format: "codegraph.graph-json",
        graph: {
          files: ["z.ts", "a.ts", "m.ts"],
          fileEdges: [
            { from: "z.ts", to: { type: "file", path: "a.ts" }, raw: "./a" },
            { from: "z.ts", to: { type: "file", path: "m.ts" }, raw: "./m" },
            { from: "m.ts", to: { type: "file", path: "a.ts" }, raw: "./a" },
          ],
          symbols: [],
        },
      }),
    );

    const snapshot = await loadArchitectureSnapshotFromArtifact(root);

    expect(snapshot.hotspots.map((entry) => entry.file)).toEqual(["a.ts", "m.ts", "z.ts"]);
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

    expect(report.root.replace(/\\/g, "/")).toBe(root.replace(/\\/g, "/"));
    expect(report.base.ref).toBe(`artifact:${outDir.replace(/\\/g, "/")}`);
    expect(report.base.root.replace(/\\/g, "/")).toBe(outDir.replace(/\\/g, "/"));
    expect(report.head.root.replace(/\\/g, "/")).toBe(root.replace(/\\/g, "/"));
  });

  it("reports a type-only artifact edge becoming runtime in the current checkout", async () => {
    const root = await mkTmpDir("cg-drift-artifact-type-only-");
    await writeFile(root, "src/b.ts", "export function b() { return 1; }\nexport type B = number;\n");
    await writeFile(root, "src/a.ts", "import type { B } from './b';\nexport function a(value: B) { return value; }\n");
    const outDir = path.join(root, "baseline");
    await buildCodegraphArtifact({ root, outDir, graphJson: true });

    const baseline = await loadArchitectureSnapshotFromArtifact(outDir);
    expect(baseline.graphEdges.some((edge) => edge.typeOnly)).toBe(true);

    await writeFile(root, "src/a.ts", "import { b } from './b';\nexport function a() { return b(); }\n");
    const report = await analyzeArchitectureDrift(root, { baseArtifact: outDir, head: ".", includeRoots: ["src"] });

    const finding = report.findings.find((entry) => entry.kind === "graph-edge-type-changed");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
    expect(report.findings.some((entry) => entry.kind === "graph-edge-added")).toBe(false);
    expect(report.findings.some((entry) => entry.kind === "graph-edge-removed")).toBe(false);
  });

  it("rejects a version-1 artifact instead of misreading its drift edges", async () => {
    const root = await mkTmpDir("cg-drift-artifact-legacy-");
    await writeFile(
      root,
      "manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        graphJsonSchema: "codegraph.graph-json",
        artifacts: { graphJson: "graph.json" },
      }),
    );
    await writeFile(
      root,
      "graph.json",
      JSON.stringify({
        schemaVersion: 1,
        format: "codegraph.graph-json",
        graph: {
          files: ["src/a.ts", "src/b.ts"],
          fileEdges: [{ from: "src/a.ts", to: { type: "file", path: "src/b.ts" }, raw: "./b" }],
          symbols: [],
        },
      }),
    );

    await expect(loadArchitectureSnapshotFromArtifact(root)).rejects.toThrow(
      "schema version 1 is unsupported; regenerate the drift baseline with schema version 2",
    );
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

  it("rejects combining base and baseArtifact in the library API", async () => {
    const root = await mkTmpDir("cg-drift-artifact-reject-base-and-artifact-");
    await writeFile(root, "src/a.ts", "export function a() { return 1; }\n");
    const outDir = path.join(root, "baseline");
    await buildCodegraphArtifact({ root, outDir, graphJson: true });

    await expect(
      analyzeArchitectureDrift(root, { base: "HEAD", baseArtifact: outDir, includeRoots: ["src"] }),
    ).rejects.toThrow("cannot combine");
  });

  it("does not report unresolved-import drift for declared package imports from graph-json artifacts", async () => {
    const root = await mkTmpDir("cg-drift-artifact-unresolved-");
    await writeFile(
      root,
      "package.json",
      '{\n  "name": "artifact-unresolved",\n  "dependencies": { "left-pad": "1.3.0" }\n}\n',
    );
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
    await writeFile(root, "src/a.ts", "function helper() { return 1; }\nexport function a() { return helper(); }\n");
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
