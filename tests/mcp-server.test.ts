import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "../src/agent/session.js";
import { createCodegraphMcpHandlers } from "../src/mcp/server.js";

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

  it("keeps query_sqlite read-only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-sqlite-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");

    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await handlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true, graphJson: true });

    await expect(handlers.query_sqlite({ query: "DELETE FROM symbols RETURNING name;" })).rejects.toThrow(/read-only/i);
  });

  it("disables artifact builds by default and in explicit read-only mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-readonly-"));
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");

    const defaultHandlers = createCodegraphMcpHandlers({ root });
    await expect(defaultHandlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true })).rejects.toThrow(/read-only/i);

    const readOnlyHandlers = createCodegraphMcpHandlers({ root, readOnly: true });
    await expect(readOnlyHandlers.artifact_build({ outDir: path.join(root, "out"), sqlite: true })).rejects.toThrow(/read-only/i);
  });

  it("rejects artifact paths outside the root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-artifact-root-"));
    const outside = path.resolve(root, "..", "outside.sqlite");

    await expect((async () => {
      const handlers = createCodegraphMcpHandlers({ root, artifactPath: outside });
      await handlers.query_sqlite({ query: "select 1" });
    })()).rejects.toThrow(/outside project root/);

    const handlers = createCodegraphMcpHandlers({ root, readOnly: false });
    await expect(handlers.artifact_build({ outDir: path.resolve(root, "..", "outside"), sqlite: true })).rejects.toThrow(
      /outside project root/,
    );
  });

  it("rejects get_file paths outside the root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-mcp-file-"));
    await expect((async () => {
      const handlers = createCodegraphMcpHandlers({ root });
      await handlers.get_file({ file: path.resolve(root, "..", "outside.ts") });
    })()).rejects.toThrow(/outside project root/);
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
});
