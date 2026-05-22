import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodegraphArtifact, buildCodegraphArtifactWithSession } from "../src/agent/artifact.js";
import { createAgentSession } from "../src/agent/session.js";
import { countingSession } from "./helpers/agent.js";
import { isSymlinkUnavailable } from "./helpers/filesystem.js";

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
    const questions = JSON.parse(await fs.readFile(path.join(outDir, "questions.json"), "utf8")) as {
      questions: Array<{ id: string; command: string; handle?: string }>;
    };
    const graph = JSON.parse(await fs.readFile(path.join(outDir, "graph.json"), "utf8")) as {
      schemaVersion: number;
      format: string;
      files: string[];
      graph: { files: string[] };
    };

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.artifacts.sqlite).toBe("codegraph.sqlite");
    expect(manifest.sql.supported).toBeTruthy();
    expect(manifest.sql.limitation).toContain("current-schema reconstruction");
    expect(graph.schemaVersion).toBe(1);
    expect(graph.format).toBe("codegraph.graph-json");
    expect(graph.files).toEqual(graph.graph.files);
    expect(graph.graph.files.some((file) => file.includes(root.replace(/\\/g, "/")))).toBe(false);
    expect(questions.questions.some((question) => question.command.includes("codegraph explain symbol:"))).toBeTruthy();
    expect(questions.questions.some((question) => question.command.includes("codegraph explain sql:"))).toBeTruthy();
    expect(
      questions.questions.every((question) => question.handle === undefined || question.command.includes(question.handle)),
    ).toBeTruthy();
  });

  it("keeps graph-only symbol nodes as opaque graph IDs in portable graph JSON", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-graph-symbol-"));
    const outDir = path.join(root, "codegraph-out");
    await fs.writeFile(path.join(root, "source.ts"), "export const sharedValue = 1;\n");
    await fs.writeFile(path.join(root, "consumer.ts"), "import { sharedValue } from './source';\nexport const value = sharedValue;\n");

    await buildCodegraphArtifact({ root, outDir, graphJson: true });

    const graph = JSON.parse(await fs.readFile(path.join(outDir, "graph.json"), "utf8")) as {
      graph: {
        symbols: Array<{ id: string; file: string; kind: string; name: string }>;
        symbolEdges: Array<{ from: string; to: string }>;
      };
    };
    const importNode = graph.graph.symbols.find(
      (symbol) => symbol.kind === "import" && symbol.name === "sharedValue" && symbol.file === "consumer.ts",
    );

    expect(importNode).toBeDefined();
    expect(importNode?.id.startsWith("symbol:")).toBe(false);
    expect(importNode?.id).not.toContain(root.replace(/\\/g, "/"));
    expect(graph.graph.symbolEdges.some((edge) => edge.from === importNode?.id)).toBeTruthy();
  });

  it("refuses to overwrite a non-empty output directory unless force is set and removes stale known artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-existing-"));
    const outDir = path.join(root, "codegraph-out");
    await fs.mkdir(outDir);
    await fs.writeFile(path.join(outDir, "keep.txt"), "operator data\n");
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n");

    await expect(buildCodegraphArtifact({ root, outDir })).rejects.toThrow(/non-empty output directory/);

    const artifact = await buildCodegraphArtifact({ root, outDir, force: true, questions: true });
    expect(artifact.artifacts.questions).toBe("questions.json");
    expect(await fs.readFile(path.join(outDir, "keep.txt"), "utf8")).toBe("operator data\n");

    await buildCodegraphArtifact({ root, outDir, force: true, sqlite: true });

    await expect(fs.stat(path.join(outDir, "questions.json"))).rejects.toThrow();
    expect(await fs.readFile(path.join(outDir, "keep.txt"), "utf8")).toBe("operator data\n");
    expect(await fs.stat(path.join(outDir, "codegraph.sqlite"))).toBeTruthy();
  });

  it("recovers a standalone stale Codegraph SQLite artifact without a manifest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-stale-sqlite-"));
    const outDir = path.join(root, "codegraph-out");
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n");

    await buildCodegraphArtifact({ root, outDir, sqlite: true });
    await fs.rm(path.join(outDir, "manifest.json"));

    await expect(buildCodegraphArtifact({ root, outDir, force: true, sqlite: true })).resolves.toMatchObject({
      artifacts: { sqlite: "codegraph.sqlite" },
    });
    await expect(fs.stat(path.join(outDir, "codegraph.sqlite"))).resolves.toBeTruthy();
  });

  it("preserves unrecognized reserved-name files when force is set and refuses conflicting writes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-reserved-"));
    const outDir = path.join(root, "codegraph-out");
    const operatorGraph = "{\"operator\":true}\n";
    await fs.mkdir(outDir);
    await fs.writeFile(path.join(outDir, "graph.json"), operatorGraph);
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n");

    await buildCodegraphArtifact({ root, outDir, force: true, questions: true });

    expect(await fs.readFile(path.join(outDir, "graph.json"), "utf8")).toBe(operatorGraph);
    await expect(buildCodegraphArtifact({ root, outDir, force: true, graphJson: true })).rejects.toThrow(
      /Refusing to overwrite unrecognized file/,
    );
    expect(await fs.readFile(path.join(outDir, "graph.json"), "utf8")).toBe(operatorGraph);
  });

  it("shell-quotes generated suggested question commands for handle metacharacters", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-quote-"));
    const outDir = path.join(root, "codegraph-out");
    await fs.writeFile(path.join(root, "cost$center.ts"), "export const costCenter = 1;\n");
    await fs.writeFile(path.join(root, "api.ts"), "import { costCenter } from './cost$center';\nexport const value = costCenter;\n");

    await buildCodegraphArtifact({ root, outDir, questions: true });

    const questions = JSON.parse(await fs.readFile(path.join(outDir, "questions.json"), "utf8")) as {
      questions: Array<{ command: string; handle?: string }>;
    };
    const question = questions.questions.find((entry) => entry.command.includes("cost$center.ts"));

    expect(question).toBeDefined();
    expect(question?.command).toContain("'cost$center.ts'");
    expect(question?.command).toContain("cost$center.ts");
    expect(question?.command).not.toContain('"cost$center.ts"');
  });

  it("keeps generated suggested question ids unique for aliased exports", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-question-ids-"));
    const outDir = path.join(root, "codegraph-out");
    await fs.writeFile(
      path.join(root, "index.ts"),
      "const impl = 1;\nexport { impl as a, impl as b, impl as c };\nexport const other = 2;\n",
    );
    await fs.writeFile(path.join(root, "consumer.ts"), "import { a } from './index';\nexport const value = a;\n");

    try {
      await buildCodegraphArtifact({ root, outDir, questions: true });

      const questions = JSON.parse(await fs.readFile(path.join(outDir, "questions.json"), "utf8")) as {
        questions: Array<{ id: string; handle?: string }>;
      };
      const ids = questions.questions.map((question) => question.id);
      const handles = questions.questions.map((question) => question.handle).filter((handle) => handle !== undefined);

      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(handles).size).toBe(handles.length);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not index stale files from an in-repo output directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-ignore-out-"));
    const outDir = path.join(root, "codegraph-out");
    await fs.mkdir(outDir);
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n");
    await fs.writeFile(path.join(outDir, "old.json"), "{\"old\":true}\n");

    await buildCodegraphArtifact({ root, outDir, force: true, graphJson: true });

    const graph = JSON.parse(await fs.readFile(path.join(outDir, "graph.json"), "utf8")) as { graph: { files: string[] } };
    expect(graph.graph.files.some((file) => file.includes("codegraph-out"))).toBe(false);
  });

  it("reuses one project snapshot for all selected artifact outputs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-session-"));
    const outDir = path.join(root, "codegraph-out");
    await fs.writeFile(path.join(root, "users.sql"), "CREATE TABLE public.users (id int primary key);\n");
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    const counted = countingSession(createAgentSession({ root }));

    await buildCodegraphArtifactWithSession(counted.session, {
      root,
      outDir,
      sqlite: true,
      graphJson: true,
      report: true,
      questions: true,
    });

    expect(counted.loads()).toBe(1);
  });

  it("does not include files that escape the root through a directory link", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-linked-root-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-linked-outside-"));
    const outDir = path.join(root, "codegraph-out");
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n");
    await fs.writeFile(path.join(outside, "secret.ts"), "export const outsideSecretNeedle = true;\n");
    try {
      await fs.symlink(outside, path.join(root, "linked"), "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    await buildCodegraphArtifact({ root, outDir, graphJson: true });

    const graph = JSON.parse(await fs.readFile(path.join(outDir, "graph.json"), "utf8")) as { graph: { files: string[] } };
    expect(graph.graph.files.some((file) => file.includes("linked") || file.includes("secret.ts"))).toBe(false);
  });
});
