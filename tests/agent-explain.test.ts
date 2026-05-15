import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { explainCodegraphTarget } from "../src/agent/explain.js";
import { searchCodegraph } from "../src/agent/search.js";

async function mkRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-explain-"));
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

describe("agent explain", () => {
  it("explains a file with symbols, dependencies, reverse dependencies, and follow-ups", async () => {
    const root = await mkRepo();
    const explanation = await explainCodegraphTarget({ root, target: "auth.ts" });

    expect(explanation.schemaVersion).toBe(1);
    expect(explanation.target.file).toBe("auth.ts");
    expect(explanation.symbols.some((symbol) => symbol.name === "validateUser")).toBeTruthy();
    expect(explanation.reverseDependencies.some((entry) => entry.file === "api.ts")).toBeTruthy();
    expect(explanation.followUps.some((cmd) => cmd.includes("codegraph refs"))).toBeTruthy();
  });

  it("explains a symbol with references and stable follow-ups", async () => {
    const root = await mkRepo();
    const explanation = await explainCodegraphTarget({ root, target: "validateUser", maxSnippets: 5 });

    expect(explanation.target.kind).toBe("symbol");
    expect(explanation.references.some((reference) => reference.file === "api.ts")).toBeTruthy();
    expect(
      explanation.snippets.some((snippet) => snippet.file === "api.ts" && snippet.text.includes("validateUser")),
    ).toBeTruthy();
    expect(explanation.followUps.some((cmd) => cmd.includes("codegraph goto auth.ts"))).toBeTruthy();
  });

  it("resolves portable symbol handles returned by search", async () => {
    const root = await mkRepo();
    const search = await searchCodegraph({ root, query: "validate user", mode: "symbol", limit: 5 });
    const handle = search.results.find((result) => result.label === "validateUser")?.handle;

    expect(handle).toBeDefined();
    expect(handle).not.toContain(root.replace(/\\/g, "/"));

    const explanation = await explainCodegraphTarget({ root, target: handle ?? "" });

    expect(explanation.target.kind).toBe("symbol");
    expect(explanation.target.label).toBe("validateUser");
    expect(explanation.target.handle).toBe(handle);
  });

  it("resolves chunk and graph handles returned by search to file explanations", async () => {
    const root = await mkRepo();
    const textSearch = await searchCodegraph({ root, query: "return id", mode: "text", limit: 5 });
    const chunkResult = textSearch.results.find((result) => result.kind === "chunk");
    expect(chunkResult?.handle).toBeDefined();

    const chunkExplanation = await explainCodegraphTarget({ root, target: chunkResult?.handle ?? "" });
    expect(chunkExplanation.target.kind).toBe("file");
    expect(chunkExplanation.target.file).toBe(chunkResult?.file);

    const graphSearch = await searchCodegraph({
      root,
      query: "api",
      mode: "graph",
      from: "auth.ts",
      depth: 1,
      limit: 5,
    });
    const graphHandle = graphSearch.results.find((result) => result.kind === "graph_node")?.handle;
    expect(graphHandle).toBeDefined();

    const graphExplanation = await explainCodegraphTarget({ root, target: graphHandle ?? "" });
    expect(graphExplanation.target.kind).toBe("file");
    expect(graphExplanation.target.file).toBe("api.ts");
  });

  it("explains SQL objects without claiming current-schema reconstruction", async () => {
    const root = await mkRepo();
    const explanation = await explainCodegraphTarget({ root, target: "public.users" });

    expect(explanation.target.kind).toBe("sql_object");
    expect(explanation.relatedSqlObjects).toContainEqual(
      expect.objectContaining({
        name: "active_users",
        relation: "incoming:reads_from",
      }),
    );
    expect(explanation.summary.join(" ")).not.toContain("current schema");
  });

  it("does not infer SQL relations from ambiguous unqualified object names", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-explain-sql-ambiguous-"));
    await fs.writeFile(path.join(root, "public.sql"), "CREATE TABLE public.users (id int primary key);\n");
    await fs.writeFile(path.join(root, "private.sql"), "CREATE TABLE private.users (id int primary key);\n");
    await fs.writeFile(path.join(root, "view.sql"), "CREATE VIEW active_users AS SELECT id FROM users;\n");

    const explanation = await explainCodegraphTarget({ root, target: "public.users" });

    expect(explanation.relatedSqlObjects).not.toContainEqual(
      expect.objectContaining({
        name: "active_users",
        relation: "incoming:reads_from",
      }),
    );
  });

  it("does not resolve ambiguous unqualified SQL object targets by basename", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-explain-sql-target-ambiguous-"));
    await fs.writeFile(path.join(root, "public.sql"), "CREATE TABLE public.users (id int primary key);\n");
    await fs.writeFile(path.join(root, "private.sql"), "CREATE TABLE private.users (id int primary key);\n");

    const explanation = await explainCodegraphTarget({ root, target: "users" });

    expect(explanation.target.kind).toBe("not_found");
  });

  it("does not attribute unrelated same-file SQL outgoing relations to a target object", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-explain-sql-target-"));
    await fs.writeFile(
      path.join(root, "schema.sql"),
      [
        "CREATE TABLE public.users (id int primary key);",
        "CREATE TABLE public.audit_log (user_id int);",
        "CREATE VIEW audit_users AS SELECT user_id FROM public.audit_log;",
        "",
      ].join("\n"),
      "utf8",
    );

    const explanation = await explainCodegraphTarget({ root, target: "public.users", maxRelatedSqlObjects: 20 });

    expect(explanation.relatedSqlObjects).not.toContainEqual(
      expect.objectContaining({
        name: "public.audit_log",
        relation: "outgoing:reads_from",
      }),
    );
    expect(explanation.relatedSqlObjects).toContainEqual(
      expect.objectContaining({
        name: "public.audit_log",
        relation: "same_file",
      }),
    );
  });

  it("does not attribute unrelated same-file SQL incoming relations to a target object", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-explain-sql-incoming-"));
    await fs.writeFile(path.join(root, "schema.sql"), "CREATE TABLE public.users (id int primary key);\n", "utf8");
    await fs.writeFile(path.join(root, "audit.sql"), "CREATE TABLE public.audit_log (user_id int);\n", "utf8");
    await fs.writeFile(
      path.join(root, "views.sql"),
      [
        "CREATE VIEW active_users AS SELECT id FROM public.users;",
        "CREATE VIEW audit_users AS SELECT user_id FROM public.audit_log;",
        "",
      ].join("\n"),
      "utf8",
    );

    const explanation = await explainCodegraphTarget({ root, target: "public.users", maxRelatedSqlObjects: 20 });

    expect(explanation.relatedSqlObjects).toContainEqual(
      expect.objectContaining({
        name: "active_users",
        relation: "incoming:reads_from",
      }),
    );
    expect(explanation.relatedSqlObjects).not.toContainEqual(
      expect.objectContaining({
        name: "audit_users",
        relation: "incoming:reads_from",
      }),
    );
  });

  it("bounds dependency and snippet output", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "other.ts"),
      "import { validateUser } from './auth';\nexport const ok = validateUser(2);\n",
    );

    const explanation = await explainCodegraphTarget({
      root,
      target: "validateUser",
      maxDependencies: 1,
      maxSnippets: 1,
    });

    expect(explanation.reverseDependencies.length).toBeLessThanOrEqual(1);
    expect(explanation.references.length).toBeLessThanOrEqual(1);
    expect(explanation.snippets.length).toBeLessThanOrEqual(1);
    expect(explanation.limits.references).toBe(1);
    expect(explanation.limits.relatedSqlObjects).toBe(1);
    expect(explanation.omittedCounts.reverseDependencies).toBe(1);
    expect(explanation.omittedCounts.references).toBeGreaterThan(0);
    expect(explanation.omittedCounts.snippets).toBeGreaterThan(0);
  });

  it("bounds file symbols and reports omitted counts", async () => {
    const root = await mkRepo();
    await fs.writeFile(
      path.join(root, "many.ts"),
      Array.from({ length: 80 }, (_, index) => `export const symbol${index} = ${index};`).join("\n"),
    );

    const explanation = await explainCodegraphTarget({ root, target: "many.ts", maxSymbols: 12 });

    expect(explanation.symbols).toHaveLength(12);
    expect(explanation.limits.symbols).toBe(12);
    expect(explanation.omittedCounts.symbols).toBeGreaterThan(0);
  });

  it("includes compact review tasks and candidate tests in changed context", async () => {
    const root = await mkRepo();
    await fs.writeFile(path.join(root, "auth.test.ts"), "import { validateUser } from './auth';\nvalidateUser(1);\n");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "test@example.com"]);
    runGit(root, ["config", "user.name", "Test User"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "initial"]);
    await fs.writeFile(path.join(root, "auth.ts"), "export function validateUser(id: number) { return id >= 0; }\n");

    const explanation = await explainCodegraphTarget({
      root,
      target: "validateUser",
      includeChangedContext: true,
      base: "HEAD",
      head: "WORKTREE",
    });

    const reviewTask = explanation.changedContext?.reviewTasks[0];
    expect(typeof reviewTask?.id).toBe("string");
    expect(typeof reviewTask?.reason).toBe("string");
    expect(typeof reviewTask?.summary).toBe("string");
    expect(explanation.changedContext?.candidateTests).toContainEqual(
      expect.objectContaining({
        file: "auth.test.ts",
      }),
    );
    const candidate = explanation.changedContext?.candidateTests.find((entry) => entry.file === "auth.test.ts");
    expect(typeof candidate?.confidence).toBe("string");
  });
});

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
