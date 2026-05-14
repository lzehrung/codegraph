import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodegraphArtifact } from "../src/agent/artifact.js";

describe("artifact build", () => {
  it("writes sqlite, graph JSON, optional report, questions, and manifest from real project logic", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-"));
    const outDir = path.join(root, "codegraph-out");
    await fs.writeFile(path.join(root, "users.sql"), "CREATE TABLE public.users (id int primary key);\n");
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    await fs.writeFile(
      path.join(root, "api.ts"),
      "import { validateUser } from './auth';\nexport const ok = validateUser(1);\n",
    );

    const artifact = await buildCodegraphArtifact({
      root,
      outDir,
      sqlite: true,
      graphJson: true,
      report: true,
      questions: true,
    });

    expect(artifact.manifestPath.endsWith("manifest.json")).toBeTruthy();
    expect(await fs.stat(path.join(outDir, "codegraph.sqlite"))).toBeTruthy();
    expect(await fs.stat(path.join(outDir, "graph.json"))).toBeTruthy();
    expect(await fs.stat(path.join(outDir, "CODEGRAPH_REPORT.md"))).toBeTruthy();
    expect(await fs.stat(path.join(outDir, "questions.json"))).toBeTruthy();

    const manifest = JSON.parse(await fs.readFile(artifact.manifestPath, "utf8")) as {
      schemaVersion: number;
      artifacts: Record<string, string>;
      sql: { supported: boolean; limitation: string };
    };

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.artifacts.sqlite).toBe("codegraph.sqlite");
    expect(manifest.sql.supported).toBeTruthy();
    expect(manifest.sql.limitation).toContain("current-schema reconstruction");
  });

  it("refuses to overwrite a non-empty output directory unless force is set", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-existing-"));
    const outDir = path.join(root, "codegraph-out");
    await fs.mkdir(outDir);
    await fs.writeFile(path.join(outDir, "keep.txt"), "operator data\n");
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n");

    await expect(buildCodegraphArtifact({ root, outDir })).rejects.toThrow(/non-empty output directory/);

    const artifact = await buildCodegraphArtifact({ root, outDir, force: true, questions: true });
    expect(artifact.artifacts.questions).toBe("questions.json");
    expect(await fs.readFile(path.join(outDir, "keep.txt"), "utf8")).toBe("operator data\n");
  });

  it("does not index stale files from an in-repo output directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-ignore-out-"));
    const outDir = path.join(root, "codegraph-out");
    await fs.mkdir(outDir);
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n");
    await fs.writeFile(path.join(outDir, "old.json"), "{\"old\":true}\n");

    await buildCodegraphArtifact({ root, outDir, force: true, graphJson: true });

    const graph = JSON.parse(await fs.readFile(path.join(outDir, "graph.json"), "utf8")) as { files: string[] };
    expect(graph.files.some((file) => file.includes("codegraph-out"))).toBe(false);
  });
});
