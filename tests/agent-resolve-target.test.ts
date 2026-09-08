import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { explainCodegraphTargetWithSession, resolveCodegraphTargetWithSession } from "../src/agent/explain.js";
import { createAgentSession, type AgentSession } from "../src/agent/session.js";
import { searchCodegraphWithSession } from "../src/agent/search.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const tempRoots = createTempRootRegistry();
const sessions: AgentSession[] = [];

async function mkRepo(): Promise<string> {
  const root = await tempRoots.create("cg-resolve-target-");
  await fs.writeFile(
    path.join(root, "users.sql"),
    "CREATE TABLE public.users (id int primary key);\nCREATE VIEW active_users AS SELECT id FROM public.users;\n",
  );
  await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id > 0; }\n");
  await fs.writeFile(
    path.join(root, "api.ts"),
    "import { validateUser } from './auth';\nexport function handler(id: number) { return validateUser(id); }\n",
  );
  return root;
}

describe("resolveCodegraphTargetWithSession", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const session of sessions.splice(0)) session.invalidate();
    await tempRoots.cleanup();
  });

  it("matches explainCodegraphTargetWithSession's target for file, symbol, and SQL object handle forms", async () => {
    const root = await mkRepo();
    const session = createAgentSession({ root });
    sessions.push(session);

    for (const target of ["auth.ts", "validateUser", "public.users"]) {
      const full = await explainCodegraphTargetWithSession(session, { root, target });
      const lightweight = await resolveCodegraphTargetWithSession(session, { target });
      expect(lightweight).toEqual(full.target);
    }
  });

  it("matches explainCodegraphTargetWithSession's target for a portable symbol handle", async () => {
    const root = await mkRepo();
    const session = createAgentSession({ root });
    sessions.push(session);
    const search = await searchCodegraphWithSession(session, {
      root,
      query: "validate user",
      mode: "symbol",
      limit: 5,
    });
    const handle = search.results.find((result) => result.label === "validateUser")?.handle;
    expect(handle).toBeTruthy();

    const full = await explainCodegraphTargetWithSession(session, { root, target: handle ?? "" });
    const lightweight = await resolveCodegraphTargetWithSession(session, { target: handle ?? "" });

    expect(lightweight).toEqual(full.target);
    expect(lightweight.kind).toBe("symbol");
    expect(lightweight.handle).toBe(handle);
  });

  it("matches explainCodegraphTargetWithSession's not_found behavior for unresolved and ambiguous names", async () => {
    const root = await tempRoots.create("cg-resolve-target-ambiguous-");
    await fs.writeFile(path.join(root, "public.sql"), "CREATE TABLE public.users (id int primary key);\n");
    await fs.writeFile(path.join(root, "private.sql"), "CREATE TABLE private.users (id int primary key);\n");
    const session = createAgentSession({ root });
    sessions.push(session);

    for (const target of ["users", "does-not-exist"]) {
      const full = await explainCodegraphTargetWithSession(session, { root, target });
      const lightweight = await resolveCodegraphTargetWithSession(session, { target });
      expect(lightweight).toEqual(full.target);
      expect(lightweight.kind).toBe("not_found");
    }
  });

  it("resolves a SQL object target on a warm session without re-reading SQL source files", async () => {
    const root = await mkRepo();
    const session = createAgentSession({ root });
    sessions.push(session);
    await session.loadProject();

    const readSpy = vi.spyOn(fs, "readFile");
    const target = await resolveCodegraphTargetWithSession(session, { target: "public.users" });

    expect(target.kind).toBe("sql_object");
    expect(readSpy.mock.calls.some((call) => String(call[0]).toLowerCase().endsWith(".sql"))).toBe(false);

    readSpy.mockClear();
    const full = await explainCodegraphTargetWithSession(session, { root, target: "public.users" });
    expect(full.target).toEqual(target);
    expect(readSpy.mock.calls.some((call) => String(call[0]).toLowerCase().endsWith(".sql"))).toBe(true);
  });
});
