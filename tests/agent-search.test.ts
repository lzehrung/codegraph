import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "../src/agent/session.js";
import { searchCodegraph, searchCodegraphWithSession } from "../src/agent/search.js";

async function mkRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-search-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(
    path.join(root, "src", "auth.ts"),
    [
      "export function validateUser(token: string) {",
      "  return token.length > 0;",
      "}",
      "",
      "export function revokeSession(sessionId: string) {",
      "  return sessionId.length > 0;",
      "}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "src", "api.ts"),
    "import { validateUser } from './auth';\nexport function handleLogin(token: string) { return validateUser(token); }\n",
  );
  await fs.writeFile(
    path.join(root, "schema.sql"),
    "CREATE TABLE public.users (id int primary key, email text);\nCREATE VIEW active_users AS SELECT id FROM public.users;\n",
  );
  return root;
}

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

describe("agent search", () => {
  it("ranks exact symbol, path, chunk, and graph evidence with follow-up commands", async () => {
    const root = await mkRepo();
    const response = await searchCodegraph({ root, query: "validate user auth", mode: "hybrid", limit: 5 });

    expect(response.schemaVersion).toBe(1);
    expect(response.results[0]?.label).toContain("validateUser");
    expect(response.results[0]?.rankReasons.length).toBeGreaterThan(0);
    expect(response.results[0]?.handle).not.toContain(root.replace(/\\/g, "/"));
    expect(response.results[0]?.evidence.some((entry) => entry.source === "symbol")).toBeTruthy();
    expect(response.results[0]?.neighbors.some((entry) => entry.file?.endsWith("src/api.ts"))).toBeTruthy();
    expect(response.results[0]?.followUps.some((cmd) => cmd.includes("codegraph refs"))).toBeTruthy();
    expect(response.results.some((result) => result.file.endsWith("src/auth.ts"))).toBeTruthy();
  });

  it("includes SQL object results from .sql language support", async () => {
    const root = await mkRepo();
    const response = await searchCodegraph({ root, query: "public users", mode: "sql", limit: 5 });

    expect(response.results.some((result) => result.kind === "sql_object" && result.label.includes("public.users"))).toBeTruthy();
    expect(response.results.every((result) => result.score > 0)).toBeTruthy();
    expect(response.results.every((result) => !result.handle.includes(root.replace(/\\/g, "/")))).toBeTruthy();
  });

  it("returns deterministic ordering for equal path matches", async () => {
    const root = await mkRepo();
    await fs.writeFile(path.join(root, "src", "account-alpha.ts"), "export const accountAlpha = 1;\n");
    await fs.writeFile(path.join(root, "src", "account-beta.ts"), "export const accountBeta = 1;\n");

    const first = await searchCodegraph({ root, query: "account", mode: "path", limit: 10 });
    const second = await searchCodegraph({ root, query: "account", mode: "path", limit: 10 });

    expect(second.results.map((result) => result.handle)).toEqual(first.results.map((result) => result.handle));
  });

  it("boosts matches reachable from a graph anchor", async () => {
    const root = await mkRepo();
    const anchorSearch = await searchCodegraph({ root, query: "auth", mode: "path", limit: 5 });
    const authHandle = anchorSearch.results.find((result) => result.file === "src/auth.ts")?.handle;
    expect(authHandle).toBeDefined();

    const response = await searchCodegraph({
      root,
      query: "handle login",
      mode: "graph",
      from: authHandle ?? "",
      depth: 1,
      limit: 5,
    });

    const loginResult = response.results.find((result) => result.label.includes("handleLogin"));
    expect(loginResult?.file).toBe("src/api.ts");
    expect(loginResult?.evidence.some((entry) => entry.source === "graph" && entry.label === "imported_by")).toBeTruthy();
    expect(loginResult?.rankReasons).toContain("graph neighborhood match at depth 1");
  });

  it("returns an empty result set for unmatched queries", async () => {
    const root = await mkRepo();
    const response = await searchCodegraph({ root, query: "zzzz-unmatched-domain", limit: 5 });

    expect(response.results).toEqual([]);
  });

  it("loads one project snapshot for a search call", async () => {
    const root = await mkRepo();
    const counted = countingSession(createAgentSession({ root }));

    await searchCodegraphWithSession(counted.session, { root, query: "validate user", mode: "hybrid", limit: 5 });

    expect(counted.loads()).toBe(1);
  });

  it("caps result count and per-result packet arrays with omission counts", async () => {
    const root = await mkRepo();
    for (let i = 0; i < 30; i += 1) {
      await fs.writeFile(
        path.join(root, "src", `consumer-${i}.ts`),
        `import { validateUser } from './auth';\nexport const consumer${i} = validateUser(${i});\n`,
      );
    }
    for (let i = 0; i < 120; i += 1) {
      await fs.writeFile(path.join(root, "src", `account-${i}.ts`), `export const account${i} = ${i};\n`);
    }

    const response = await searchCodegraph({ root, query: "account validate user", mode: "hybrid", limit: 500 });
    const validateResult = response.results.find((result) => result.label === "validateUser");

    expect(response.results.length).toBeLessThanOrEqual(100);
    expect(response.resultCount).toBe(response.results.length);
    expect(response.totalCandidates).toBeGreaterThan(response.resultCount);
    expect(response.omittedCounts.results).toBeGreaterThan(0);
    expect(response.limits.results).toBe(100);
    expect(validateResult?.neighbors.length).toBeLessThanOrEqual(response.limits.neighborsPerResult);
    expect(validateResult?.omittedCounts.neighbors).toBeGreaterThan(0);
    expect(validateResult?.evidence.length).toBeLessThanOrEqual(response.limits.evidencePerResult);
    expect(validateResult?.followUps.length).toBeLessThanOrEqual(response.limits.followUpsPerResult);
  });

  it("does not discover files that escape the root through a directory link", async () => {
    const root = await mkRepo();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-search-outside-"));
    await fs.writeFile(path.join(outside, "secret.ts"), "export const outsideSecretNeedle = true;\n");
    try {
      await fs.symlink(outside, path.join(root, "linked"), "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const response = await searchCodegraph({ root, query: "outside secret needle", mode: "text", limit: 10 });

    expect(response.results).toEqual([]);
  });
});

function isSymlinkUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP")
  );
}
