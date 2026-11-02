import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { explainCodegraphTargetWithSession } from "../src/agent/explain.js";
import { searchCodegraphWithSession } from "../src/agent/search.js";
import { createAgentSession, type AgentSession } from "../src/agent/session.js";
import { createCodegraphMcpHandlers, type CodegraphMcpHandlers } from "../src/mcp/handlers.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const tempRoots = createTempRootRegistry();
const sessions: AgentSession[] = [];
const handlerSets: CodegraphMcpHandlers[] = [];

async function createProject(): Promise<{ root: string; session: AgentSession; handlers: CodegraphMcpHandlers }> {
  const root = await tempRoots.create("cg-mcp-refs-handle-");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(
    path.join(root, "src", "auth.ts"),
    "export function validateUser(id: number) { return id > 0; }\nexport function unusedHelper() { return 1; }\n",
  );
  const importers = [];
  for (let index = 0; index < 4; index += 1) {
    importers.push(
      fs.writeFile(
        path.join(root, "src", `consumer-${index}.ts`),
        `import { validateUser } from "./auth";\nexport const ok${index} = validateUser(${index});\nexport const again${index} = validateUser(${index + 10});\n`,
      ),
    );
  }
  await Promise.all(importers);
  const session = createAgentSession({ root });
  sessions.push(session);
  const handlers = createCodegraphMcpHandlers({ root, session });
  handlerSets.push(handlers);
  return { root, session, handlers };
}

async function symbolHandle(session: AgentSession, root: string, label: string): Promise<string> {
  const search = await searchCodegraphWithSession(session, { root, query: label, mode: "symbol", limit: 5 });
  const handle = search.results.find((result) => result.label === label)?.handle;
  if (!handle) throw new Error(`No handle for ${label}.`);
  return handle;
}

describe("refs by portable symbol handle", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const handlers of handlerSets.splice(0)) handlers.dispose();
    for (const session of sessions.splice(0)) session.invalidate();
    await tempRoots.cleanup();
  });

  it("answers with the references, limit, and omitted count of the full explanation", async () => {
    const { root, session, handlers } = await createProject();
    const handle = await symbolHandle(session, root, "validateUser");

    for (const limit of [undefined, 3, 1, 0]) {
      const explanation = await explainCodegraphTargetWithSession(session, {
        root,
        target: handle,
        ...(limit !== undefined ? { maxReferences: limit } : { maxReferences: 25 }),
      });
      const refs = await handlers.refs({ handle, ...(limit !== undefined ? { limit } : {}) });
      const omitted = explanation.omittedCounts.references;
      expect(refs.references, `limit ${limit}`).toEqual(explanation.references);
      expect(refs.limit).toBe(explanation.limits.references);
      expect(refs.omitted).toBe(omitted);
      expect(refs.totalSeen).toBe(explanation.references.length + omitted);
      expect(refs.truncated).toBe(omitted > 0);
      expect(refs.referenceCoverage).toEqual(explanation.referenceCoverage);
    }

    // Eight call sites and four import bindings exceed a limit of 3, so the comparison covered a truncated page.
    const truncated = await handlers.refs({ handle, limit: 3 });
    expect(truncated.references).toHaveLength(3);
    expect(truncated.truncated).toBe(true);
    expect(truncated.omitted).toBeGreaterThan(0);
  });

  it("finds the references the qualified file::name form finds", async () => {
    const { root, session, handlers } = await createProject();
    const handle = await symbolHandle(session, root, "validateUser");

    const byHandle = await handlers.refs({ handle, limit: 100 });
    const byPath = await handlers.refs({ handle: "src/auth.ts::validateUser", limit: 100 });

    const key = (reference: { file: string; range: { start: { line: number; column: number } } }): string =>
      `${reference.file}:${reference.range.start.line}:${reference.range.start.column}`;
    expect(byHandle.references.map(key).sort()).toEqual(byPath.references.map(key).sort());
    expect(byHandle.references.length).toBeGreaterThanOrEqual(8);
    expect(byHandle.referenceCoverage).toEqual(byPath.referenceCoverage);
  });

  it("reads neither the detailed symbol graph nor the duplicate analysis", async () => {
    const { root, session, handlers } = await createProject();
    const handle = await symbolHandle(session, root, "validateUser");
    const loadProject = vi.spyOn(session, "loadProject");
    const loadDuplicates = vi.spyOn(session, "loadDuplicateAnalysis");

    const refs = await handlers.refs({ handle });

    expect(refs.references.length).toBeGreaterThan(0);
    expect(loadDuplicates).not.toHaveBeenCalled();
    expect(loadProject.mock.calls.length).toBeGreaterThan(0);
    for (const [options] of loadProject.mock.calls) expect(options).toEqual({ symbolGraph: "skip" });
  });

  it("leaves a stale handle, a file target, and a bare name to the full explanation", async () => {
    const { root, session, handlers } = await createProject();
    const stale = (await symbolHandle(session, root, "validateUser")).replace(/:\d+:\d+$/, ":99:1");

    for (const target of [stale, "src/auth.ts", "validateUser"]) {
      const explanation = await explainCodegraphTargetWithSession(session, { root, target, maxReferences: 25 });
      const refs = await handlers.refs({ handle: target });
      expect(refs.references, target).toEqual(explanation.references);
      expect(refs.limit, target).toBe(explanation.limits.references);
      expect(refs.omitted, target).toBe(explanation.omittedCounts.references);
    }
    const staleRefs = await handlers.refs({ handle: stale });
    expect(staleRefs.references).toEqual([]);
    const named = await handlers.refs({ handle: "validateUser" });
    expect(named.references.length).toBeGreaterThan(0);
  });
});
