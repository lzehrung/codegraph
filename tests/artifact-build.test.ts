import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodegraphArtifact, buildCodegraphArtifactWithSession } from "../src/agent/artifact.js";
import { createAgentSession, type AgentSession } from "../src/agent/session.js";
import { quoteShellArg } from "../src/agent/shell.js";
import { buildGraph } from "../docs/graph-visualization/graph-builder.js";
import { countingSession } from "./helpers/agent.js";
import { createArtifactOutputWithStaleFile, mkTmpDir, tryCreateDirectorySymlink } from "./helpers/filesystem.js";

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
    const firstGraphBytes = await fs.readFile(path.join(outDir, "graph.json"));
    await buildCodegraphArtifact({
      root,
      outDir,
      sqlite: true,
      graphJson: true,
      report: true,
      questions: true,
      force: true,
    });
    await expect(fs.readFile(path.join(outDir, "graph.json"))).resolves.toEqual(firstGraphBytes);

    const manifest = JSON.parse(await fs.readFile(artifact.manifestPath, "utf8")) as {
      schemaVersion: number;
      artifacts: Record<string, string>;
      sql: { supported: boolean; limitation: string; fileSignatures: { signed: number; skipped: number } };
    };
    const questions = JSON.parse(await fs.readFile(path.join(outDir, "questions.json"), "utf8")) as {
      questions: Array<{ id: string; command: string; handle?: string }>;
    };
    const graph = JSON.parse(await fs.readFile(path.join(outDir, "graph.json"), "utf8")) as {
      schemaVersion: number;
      format: string;
      files: string[];
      fileEdges: Array<{ from: string; to: { type: string; path?: string } }>;
      symbols: Array<{ id: string; file: string }>;
      symbolEdges: Array<{ from: string; to: string }>;
      graph: { files: string[] };
    };
    expect(manifest.sql.fileSignatures).toEqual({
      signed: expect.any(Number),
      skipped: expect.any(Number),
    });

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.artifacts.sqlite).toBe("codegraph.sqlite");
    expect(manifest.sql.supported).toBeTruthy();
    expect(manifest.sql.limitation).toContain("current-schema reconstruction");
    expect(graph.schemaVersion).toBe(2);
    expect(graph.format).toBe("codegraph.graph-json");
    expect(graph.files).toEqual(graph.graph.files);
    expect(graph.graph.files.some((file) => file.includes(root.replace(/\\/g, "/")))).toBe(false);
    const renderedGraph = buildGraph(graph, { includeSymbols: true, showExternal: false });
    expect(renderedGraph.size).toBeGreaterThan(0);
    expect(questions.questions.some((question) => question.command.includes("codegraph explain symbol:"))).toBeTruthy();
    expect(questions.questions.some((question) => question.command.includes("codegraph explain sql:"))).toBeTruthy();
    expect(
      questions.questions.every(
        (question) => question.handle === undefined || question.command.includes(question.handle),
      ),
    ).toBeTruthy();
  });

  it("adds the root-confined viewer handoff only when the report includes graph JSON", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-viewer-"));
    const graphOutDir = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-viewer-outside-"));
    const graphlessOutDir = path.join(root, "without-graph");
    await fs.writeFile(path.join(root, "source.ts"), "export const answer = 42;\n");

    await buildCodegraphArtifact({ root, outDir: graphOutDir, graphJson: true, report: true });
    await buildCodegraphArtifact({ root, outDir: graphlessOutDir, report: true });

    const graphReport = await fs.readFile(path.join(graphOutDir, "CODEGRAPH_REPORT.md"), "utf8");
    const graphlessReport = await fs.readFile(path.join(graphlessOutDir, "CODEGRAPH_REPORT.md"), "utf8");
    const viewerCommand = [
      "codegraph viewer",
      `--root ${quoteShellArg(graphOutDir)}`,
      `--graph ${quoteShellArg("graph.json")}`,
      "--open",
    ].join(" ");

    expect(graphReport).toContain(viewerCommand);
    expect(graphlessReport).not.toContain("codegraph viewer");
  });

  it("keeps graph-only symbol nodes as opaque graph IDs in portable graph JSON", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-graph-symbol-"));
    const outDir = path.join(root, "codegraph-out");
    await fs.writeFile(path.join(root, "source.ts"), "export const sharedValue = 1;\n");
    await fs.writeFile(
      path.join(root, "consumer.ts"),
      "import { sharedValue } from './source';\nexport const value = sharedValue;\n",
    );

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
    const operatorGraph = '{"operator":true}\n';
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
    await fs.writeFile(
      path.join(root, "api.ts"),
      "import { costCenter } from './cost$center';\nexport const value = costCenter;\n",
    );

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
    const { root, outDir } = await createArtifactOutputWithStaleFile({
      prefix: "cg-artifact-ignore-out-",
      outDirName: "codegraph-out",
      staleFileName: "old.json",
      staleContents: '{"old":true}\n',
    });
    await buildCodegraphArtifact({ root, outDir, force: true, graphJson: true });

    const graph = JSON.parse(await fs.readFile(path.join(outDir, "graph.json"), "utf8")) as {
      graph: { files: string[] };
    };
    expect(graph.graph.files.some((file) => file.includes("codegraph-out"))).toBe(false);
  });

  it("skips (rather than throws on) sqlite signatures for graph nodes discovery never indexed (A1)", async () => {
    // Reproduces probe V1/A1: an in-scope file imports a target that discovery excludes
    // (e.g. a gitignored directory), so the resolved import becomes a `fileGraph` node with
    // no entry in `fileSignatures`. At base commit a9c6b220 this threw
    // "SQLite artifact freshness signature is missing for <file>." for every such node
    // (`src/agent/artifact.ts:124`, confirmed unchanged via `git show a9c6b220:src/agent/artifact.ts`).
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-skip-signature-"));
    const outDir = path.join(root, "codegraph-out");
    await fs.mkdir(path.join(root, "ignored"), { recursive: true });
    await fs.writeFile(path.join(root, "ignored", "target.ts"), "export const value = 1;\n");
    await fs.writeFile(
      path.join(root, "main.ts"),
      "import { value } from './ignored/target';\nexport const result = value;\n",
    );

    const artifact = await buildCodegraphArtifact({
      root,
      outDir,
      sqlite: true,
      buildOptions: { discovery: { ignoreGlobs: ["ignored/**"] } },
    });

    expect(artifact.artifacts.sqlite).toBe("codegraph.sqlite");
    const manifest = JSON.parse(await fs.readFile(artifact.manifestPath, "utf8")) as {
      sql: { fileSignatures: { signed: number; skipped: number } };
    };
    expect(manifest.sql.fileSignatures.signed).toBe(1);
    expect(manifest.sql.fileSignatures.skipped).toBeGreaterThanOrEqual(1);
  });

  it("rejects SQLite artifacts when a manually fresh snapshot has no signature map", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-no-signature-map-"));
    const outDir = path.join(root, "codegraph-out");
    await fs.writeFile(path.join(root, "main.ts"), "export const value = 1;\n");
    const baseSession = createAgentSession({ root, freshness: { policy: "manual" } });
    const session: AgentSession = {
      loadProject: async (options) => {
        const snapshot = await baseSession.loadProject(options);
        const { fileSignatures: _fileSignatures, ...withoutSignatures } = snapshot;
        return withoutSignatures;
      },
      invalidate: () => undefined,
    };

    await expect(buildCodegraphArtifactWithSession(session, { root, outDir, sqlite: true })).rejects.toThrow(
      "SQLite artifact freshness signatures are unavailable.",
    );
    await expect(fs.stat(outDir)).rejects.toThrow();
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
    const root = await mkTmpDir("cg-artifact-linked-root-");
    const outside = await mkTmpDir("cg-artifact-linked-outside-");
    const outDir = path.join(root, "codegraph-out");
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n");
    await fs.writeFile(path.join(outside, "secret.ts"), "export const outsideSecretNeedle = true;\n");
    const symlinkCreated = await tryCreateDirectorySymlink(outside, path.join(root, "linked"));
    if (!symlinkCreated) {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(outside, { recursive: true, force: true }),
      ]);
      return;
    }

    await buildCodegraphArtifact({ root, outDir, graphJson: true });

    const graph = JSON.parse(await fs.readFile(path.join(outDir, "graph.json"), "utf8")) as {
      graph: { files: string[] };
    };
    expect(graph.graph.files.some((file) => file.includes("linked") || file.includes("secret.ts"))).toBe(false);
  });

  it("serializes byte-identically across builds with same-name overloads and same-label multiedges (G3)", async () => {
    // Reproduces the tie gap in `buildCodegraphGraphJson`'s symbol/edge sort (src/agent/artifact.ts):
    // sorting only by file+name (symbols) or from/to/label (edges) leaves same-name overloads and
    // same-label multiedges in Map insertion order, which is not guaranteed stable across builds.
    const source = [
      "export function foo(a: number): number;",
      "export function foo(a: string): string;",
      "export function foo(a: unknown): unknown {",
      "  return a;",
      "}",
      "export function bar(): unknown {",
      "  const first = foo(1);",
      "  const second = foo(2);",
      "  return first ?? second;",
      "}",
      "",
    ].join("\n");

    const buildOnce = async (): Promise<{ root: string; text: string }> => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-artifact-tie-keys-"));
      const outDir = path.join(root, "codegraph-out");
      await fs.writeFile(path.join(root, "overloads.ts"), source);
      await buildCodegraphArtifact({ root, outDir, graphJson: true });
      return { root, text: await fs.readFile(path.join(outDir, "graph.json"), "utf8") };
    };

    const [first, second] = await Promise.all([buildOnce(), buildOnce()]);
    // `symbolEdges[].site.file` carries the absolute source root, which legitimately differs
    // between two independent temp roots; strip it before comparing everything else byte-for-byte.
    const normalizeOwnRoot = (value: { root: string; text: string }) =>
      value.text.split(value.root.replace(/\\/g, "/")).join("<root>");
    expect(normalizeOwnRoot(first)).toBe(normalizeOwnRoot(second));

    const graph = JSON.parse(first.text) as {
      graph: {
        symbols: Array<{ name: string }>;
        symbolEdges: Array<{ from: string; to: string; label?: string }>;
      };
    };
    const fooSymbols = graph.graph.symbols.filter((symbol) => symbol.name === "foo");
    expect(fooSymbols.length).toBeGreaterThanOrEqual(1);
    const fooEdges = graph.graph.symbolEdges.filter((edge) => edge.label === "calls" || edge.to.includes("foo"));
    expect(fooEdges.length).toBeGreaterThanOrEqual(2);
  });
});
