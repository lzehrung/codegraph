import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "../src/agent/session.js";
import { createCodegraphMcpHandlers, listCodegraphMcpTools } from "../src/mcp/server.js";

function countingSession(session: AgentSession): { session: AgentSession; loads: () => number } {
  let cached: Promise<AgentProjectSnapshot> | undefined;
  let loadCount = 0;
  return {
    session: {
      loadProject: async () => {
        if (!cached) {
          loadCount += 1;
          cached = session.loadProject();
        }
        return await cached;
      },
      invalidate: () => {
        cached = undefined;
        session.invalidate();
      },
    },
    loads: () => loadCount,
  };
}

describe("codegraph MCP handlers", () => {
  it("reuses one session across search, get_symbol, refs, and query_sqlite handlers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    await fs.writeFile(
      path.join(root, "api.ts"),
      "import { validateUser } from './auth';\nexport const ok = validateUser(1);\n",
    );

    const handlers = createCodegraphMcpHandlers({ root });
    const search = await handlers.search({ query: "validate user", limit: 5 });
    const first = search.results[0];

    expect(first?.handle).toBeTruthy();

    const symbol = await handlers.get_symbol({ handle: first!.handle });
    expect(symbol.label).toContain("validateUser");

    const refs = await handlers.refs({ handle: first!.handle });
    expect(refs.references.some((ref) => ref.file === "api.ts")).toBeTruthy();
  });

  it("bounds refs by handle with the refs limit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-refs-limit-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    await fs.writeFile(
      path.join(root, "api.ts"),
      "import { validateUser } from './auth';\nexport const ok = validateUser(1);\n",
    );
    await fs.writeFile(
      path.join(root, "other.ts"),
      "import { validateUser } from './auth';\nexport const ok = validateUser(2);\n",
    );

    const handlers = createCodegraphMcpHandlers({ root });
    const search = await handlers.search({ query: "validate user", limit: 5 });
    const first = search.results[0];
    expect(first?.handle).toBeTruthy();

    const refs = await handlers.refs({ handle: first!.handle, limit: 1 });
    expect(refs.references).toHaveLength(1);
  });

  it("advertises refs as either handle or file position input", () => {
    const refsTool = listCodegraphMcpTools().find((tool) => tool.name === "refs");
    expect(refsTool?.inputSchema).toEqual(
      expect.objectContaining({
        oneOf: [
          expect.objectContaining({
            required: ["handle"],
            not: expect.objectContaining({
              anyOf: [{ required: ["file"] }, { required: ["line"] }, { required: ["column"] }],
            }),
          }),
          expect.objectContaining({
            required: ["file", "line", "column"],
            not: { required: ["handle"] },
          }),
        ],
      }),
    );
  });

  it("keeps query_sqlite read-only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");

    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await handlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true, graphJson: true });

    await expect(handlers.query_sqlite({ query: "DELETE FROM symbols RETURNING name;" })).rejects.toThrow(/read-only/i);
  });

  it("bounds query_sqlite rows for MCP responses", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-limit-"));
    await fs.writeFile(path.join(root, "one.ts"), "export const one = 1;\n");
    await fs.writeFile(path.join(root, "two.ts"), "export const two = 2;\n");

    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await handlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true });

    const result = await handlers.query_sqlite({ query: "SELECT path FROM files ORDER BY path;", limit: 1 });

    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBeTruthy();
    expect(result.rowLimit).toBe(1);
  });

  it("bounds query_sqlite bytes for MCP responses", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-bytes-"));
    await fs.writeFile(path.join(root, "one.ts"), "export const one = 1;\n");

    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await handlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true });

    const result = await handlers.query_sqlite({ query: "SELECT hex(randomblob(300000)) AS big;" });

    expect(result.byteLimit).toBe(200000);
    expect(result.truncated).toBeTruthy();
    expect(result.rows).toHaveLength(1);
    expect(String(result.rows[0]?.[0]).length).toBeLessThan(9000);
  });

  it("disables artifact builds by default and in explicit read-only mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-readonly-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");

    const defaultHandlers = createCodegraphMcpHandlers({ root });
    await expect(defaultHandlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true })).rejects.toThrow(
      /read-only/i,
    );

    const readOnlyHandlers = createCodegraphMcpHandlers({ root, readOnly: true });
    await expect(readOnlyHandlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true })).rejects.toThrow(
      /read-only/i,
    );
  });

  it("rejects artifact paths outside the root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-artifact-root-"));
    const outside = path.resolve(root, "..", "outside.sqlite");

    await expect(
      (async () => {
        const handlers = createCodegraphMcpHandlers({ root, artifactPath: outside });
        await handlers.query_sqlite({ query: "select 1" });
      })(),
    ).rejects.toThrow(/outside project root/);

    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await expect(
      handlers.artifact_build({ outDir: path.resolve(root, "..", "outside"), sqlite: true }),
    ).rejects.toThrow(/outside project root/);
  });

  it("rejects get_file paths outside the root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-"));
    await expect(
      (async () => {
        const handlers = createCodegraphMcpHandlers({ root });
        await handlers.get_file({ file: path.resolve(root, "..", "outside.ts") });
      })(),
    ).rejects.toThrow(/outside project root/);
  });

  it("rejects get_file paths that escape through a directory link", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-outside-"));
    await fs.writeFile(path.join(outside, "secret.txt"), "outside\n");
    const linkPath = path.join(root, "linked");
    try {
      await fs.symlink(outside, linkPath, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const handlers = createCodegraphMcpHandlers({ root });

    await expect(handlers.get_file({ file: path.join("linked", "secret.txt") })).rejects.toThrow(
      /outside project root/,
    );
  });

  it("bounds get_file reads before returning content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-bound-"));
    await fs.writeFile(path.join(root, "large.txt"), "abcdef", "utf8");
    const handlers = createCodegraphMcpHandlers({ root });

    const result = await handlers.get_file({ file: "large.txt", maxBytes: 5 });

    expect(result).toEqual({
      file: "large.txt",
      text: "abcde",
      truncated: true,
    });
  });

  it("accepts get_file paths through a symlinked root realpath", async () => {
    const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-real-file-root-"));
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-link-parent-"));
    const linkedRoot = path.join(parent, "repo-link");
    try {
      await fs.symlink(realRoot, linkedRoot, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const realFile = path.join(realRoot, "auth.ts");
    await fs.writeFile(realFile, "export const ok = 1;\n", "utf8");
    const handlers = createCodegraphMcpHandlers({ root: linkedRoot });

    const result = await handlers.get_file({ file: realFile });

    expect(result.file).toBe("auth.ts");
    expect(result.text).toContain("export const ok");
    expect(result.truncated).toBe(false);
  });

  it("rejects artifact output directories that escape through a directory link", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-artifact-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-artifact-outside-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n");
    const linkPath = path.join(root, "linked-out");
    try {
      await fs.symlink(outside, linkPath, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });

    await expect(handlers.artifact_build({ outDir: linkPath, sqlite: true, force: true })).rejects.toThrow(
      /outside project root/,
    );
  });

  it("reuses one session snapshot across search and refs follow-up calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-session-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    await fs.writeFile(
      path.join(root, "api.ts"),
      "import { validateUser } from './auth';\nexport const ok = validateUser(1);\n",
    );
    const counted = countingSession(createAgentSession({ root }));
    const handlers = createCodegraphMcpHandlers({ root, session: counted.session });

    const search = await handlers.search({ query: "validate user", limit: 5 });
    const first = search.results[0];
    expect(first?.handle).toBeTruthy();
    await handlers.refs({ handle: first!.handle });

    expect(counted.loads()).toBe(1);
  });

  it("uses the MCP session snapshot when artifact_build is enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-artifact-session-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
    const counted = countingSession(createAgentSession({ root }));
    const handlers = createCodegraphMcpHandlers({ root, readOnly: false, session: counted.session });

    await handlers.search({ query: "validate user", limit: 5 });
    await fs.writeFile(path.join(root, "late.ts"), "export const late = 1;\n");
    await handlers.artifact_build({ outDir: path.join(root, "out"), graphJson: true });

    const graph = JSON.parse(await fs.readFile(path.join(root, "out", "graph.json"), "utf8")) as {
      graph: { files: string[] };
    };
    expect(graph.graph.files.some((file) => file.endsWith("late.ts"))).toBe(false);
    expect(counted.loads()).toBe(1);
  });

  it("omits stale files from an in-repo artifact output directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-artifact-ignore-"));
    const outDir = path.join(root, "out");
    await fs.mkdir(outDir);
    await fs.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n");
    await fs.writeFile(path.join(outDir, "old.ts"), "export const stale = true;\n");
    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });

    await handlers.artifact_build({ outDir, graphJson: true, force: true });

    const graph = JSON.parse(await fs.readFile(path.join(outDir, "graph.json"), "utf8")) as {
      graph: { files: string[] };
    };
    expect(graph.graph.files.some((file) => file.includes("/out/") || file.endsWith("/out/old.ts"))).toBe(false);
  });

  it("omits stale output files when the MCP root is a directory link", async () => {
    const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-real-root-"));
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-root-link-parent-"));
    const linkedRoot = path.join(parent, "repo-link");
    try {
      await fs.symlink(realRoot, linkedRoot, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const outDir = path.join(linkedRoot, "out");
    await fs.mkdir(outDir);
    await fs.writeFile(path.join(linkedRoot, "auth.ts"), "export const ok = 1;\n");
    await fs.writeFile(path.join(outDir, "old.ts"), "export const stale = true;\n");
    const handlers = createCodegraphMcpHandlers({ root: linkedRoot, readOnly: false });

    await handlers.artifact_build({ outDir, graphJson: true, force: true });

    const graph = JSON.parse(await fs.readFile(path.join(outDir, "graph.json"), "utf8")) as {
      graph: { files: string[] };
    };
    expect(graph.graph.files.some((file) => file.includes("/out/") || file.endsWith("/out/old.ts"))).toBe(false);
  });

  it("accepts artifact paths and output directories through a symlinked root realpath", async () => {
    const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-real-artifact-root-"));
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-artifact-link-parent-"));
    const linkedRoot = path.join(parent, "repo-link");
    try {
      await fs.symlink(realRoot, linkedRoot, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    await fs.writeFile(path.join(linkedRoot, "auth.ts"), "export const ok = 1;\n");
    const realOutDir = path.join(realRoot, "out");
    await fs.mkdir(realOutDir);
    await fs.writeFile(path.join(realOutDir, "old.ts"), "export const stale = true;\n");
    const buildHandlers = createCodegraphMcpHandlers({ root: linkedRoot, readOnly: false });

    await buildHandlers.artifact_build({ outDir: realOutDir, sqlite: true, graphJson: true, force: true });

    const graph = JSON.parse(await fs.readFile(path.join(realOutDir, "graph.json"), "utf8")) as {
      graph: { files: string[] };
    };
    expect(graph.graph.files.some((file) => file.includes("/out/") || file.endsWith("/out/old.ts"))).toBe(false);

    const readHandlers = createCodegraphMcpHandlers({
      root: linkedRoot,
      artifactPath: path.join(realOutDir, "codegraph.sqlite"),
    });
    const result = await readHandlers.query_sqlite({ query: "select path from files order by path" });
    const paths = result.rows.map((row) => normalizeSqlitePath(row[0]));

    expect(paths.some((file) => file.endsWith("auth.ts"))).toBeTruthy();
    expect(paths.some((file) => file.includes("/out/") || file.endsWith("/out/old.ts"))).toBe(false);
  });
});

function normalizeSqlitePath(value: unknown): string {
  return typeof value === "string" ? value.replace(/\\/g, "/") : "";
}

function isSymlinkUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP")
  );
}
