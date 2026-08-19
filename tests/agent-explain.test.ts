import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { explainCodegraphTarget } from "../src/agent/explain.js";
import { formatAgentFollowUpAsCli } from "../src/agent/followUps.js";
import { searchCodegraph } from "../src/agent/search.js";
import { runGit } from "./helpers/git.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const tempRoots = createTempRootRegistry();
async function mkTmpDir(prefix: string): Promise<string> {
  return await tempRoots.create(prefix);
}
async function mkRepo(): Promise<string> {
  const root = await mkTmpDir("cg-agent-explain-");
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

const duplicateSource = `
export function normalizeInvoiceRows(rows: Array<{ amount: number; tax: number }>) {
  const totals: number[] = [];
  const labels: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    labels.push(label);
    totals.push(rounded);
  }
  const encoded = totals.map((value, index) => labels[index] + ":" + value.toFixed(2));
  return encoded.filter((value) => value.includes(":")).join(",");
}
`;

async function mkDuplicateRepo(): Promise<string> {
  const root = await mkTmpDir("cg-agent-explain-dups-");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src/a.ts"), duplicateSource);
  await fs.writeFile(path.join(root, "src/b.ts"), duplicateSource);
  return root;
}

async function mkManyReferenceRepo(): Promise<string> {
  const root = await mkTmpDir("cg-agent-explain-refs-");
  await fs.writeFile(path.join(root, "target.ts"), "export function sharedTarget() { return 1; }\n");
  for (let index = 0; index < 8; index += 1) {
    const name = `ref-${String(index).padStart(2, "0")}.ts`;
    await fs.writeFile(
      path.join(root, name),
      `import { sharedTarget } from './target';\nexport const value${index} = sharedTarget();\n`,
    );
  }
  return root;
}

async function mkManyDuplicateRepo(): Promise<string> {
  const root = await mkTmpDir("cg-agent-explain-many-dups-");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  for (const name of ["a", "b", "c", "d", "e", "f", "g"]) {
    await fs.writeFile(path.join(root, "src", `${name}.ts`), duplicateSource);
  }
  return root;
}

describe("agent explain", () => {
  afterEach(async () => {
    await tempRoots.cleanup();
  });
  it("explains a file with symbols, dependencies, reverse dependencies, and follow-ups", async () => {
    const root = await mkRepo();
    const explanation = await explainCodegraphTarget({ root, target: "auth.ts" });

    expect(explanation.schemaVersion).toBe(1);
    expect(explanation.target.file).toBe("auth.ts");
    expect(explanation.symbols.some((symbol) => symbol.name === "validateUser")).toBeTruthy();
    expect(explanation.reverseDependencies.some((entry) => entry.file === "api.ts")).toBeTruthy();
    expect(explanation.followUps.some((followUp) => followUp.tool === "refs")).toBeTruthy();
  });

  it("explains a symbol with references and stable follow-ups", async () => {
    const root = await mkRepo();
    const explanation = await explainCodegraphTarget({ root, target: "validateUser", maxSnippets: 5 });

    expect(explanation.target.kind).toBe("symbol");
    expect(explanation.references.some((reference) => reference.file === "api.ts")).toBeTruthy();
    expect(
      explanation.snippets.some((snippet) => snippet.file === "api.ts" && snippet.text.includes("validateUser")),
    ).toBeTruthy();
    expect(explanation.followUps.some((followUp) => followUp.tool === "goto")).toBeTruthy();
  });

  it("shell-quotes generated follow-up commands for path metacharacters", async () => {
    const root = await mkRepo();
    await fs.writeFile(path.join(root, "cost$center.ts"), "export const costCenter = 1;\n");

    const explanation = await explainCodegraphTarget({ root, target: "cost$center.ts" });

    const renderedFollowUps = explanation.followUps.map(formatAgentFollowUpAsCli);
    expect(renderedFollowUps).toContain("codegraph chunk 'cost$center.ts'");
    expect(renderedFollowUps).not.toContain('codegraph chunk "cost$center.ts"');
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
    const root = await mkTmpDir("cg-agent-explain-sql-ambiguous-");
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
    const root = await mkTmpDir("cg-agent-explain-sql-target-ambiguous-");
    await fs.writeFile(path.join(root, "public.sql"), "CREATE TABLE public.users (id int primary key);\n");
    await fs.writeFile(path.join(root, "private.sql"), "CREATE TABLE private.users (id int primary key);\n");

    const explanation = await explainCodegraphTarget({ root, target: "users" });

    expect(explanation.target.kind).toBe("not_found");
  });
  it("does not attribute unrelated same-file SQL outgoing relations to a target object", async () => {
    const root = await mkTmpDir("cg-agent-explain-sql-target-");
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
    const root = await mkTmpDir("cg-agent-explain-sql-incoming-");
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

  it("returns references sorted by file before truncation", async () => {
    const root = await mkManyReferenceRepo();
    const explanation = await explainCodegraphTarget({ root, target: "sharedTarget", maxReferences: 2 });

    expect(explanation.references).toHaveLength(2);
    expect(explanation.omittedCounts.references).toBeGreaterThan(0);
    expect(explanation.references.map((reference) => reference.file)).toEqual(["ref-00.ts", "ref-01.ts"]);
  });

  it("skips reference collection when reference and snippet limits are zero", async () => {
    const root = await mkRepo();
    const explanation = await explainCodegraphTarget({
      root,
      target: "validateUser",
      maxReferences: 0,
      maxSnippets: 0,
    });

    expect(explanation.references).toEqual([]);
    expect(explanation.snippets).toEqual([]);
    expect(explanation.limits.references).toBe(0);
    expect(explanation.limits.snippets).toBe(0);
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

  it("includes bounded duplicate context for file explanations", async () => {
    const root = await mkDuplicateRepo();

    const explanation = await explainCodegraphTarget({ root, target: "src/a.ts", maxDuplicates: 1 });

    expect(explanation.duplicates).toHaveLength(1);
    expect(explanation.limits.duplicates).toBe(1);
    expect(explanation.duplicates[0]?.left.file).toBe("src/a.ts");
    expect(explanation.duplicates[0]?.right.file).toBe("src/b.ts");
    expect(explanation.duplicates[0]?.left.handle).toContain("src%2Fa.ts");
    expect(explanation.duplicates[0]?.hint).toContain("Possible extraction candidate");
    const duplicateFollowUp = explanation.followUps.find((followUp) => followUp.tool === "duplicates");
    expect(duplicateFollowUp).toMatchObject({
      tool: "duplicates",
      arguments: { json: true, files: ["src/a.ts", "src/b.ts"] },
    });
  });

  it("includes only duplicate groups overlapping symbol explanations", async () => {
    const root = await mkDuplicateRepo();

    const explanation = await explainCodegraphTarget({
      root,
      target: "normalizeInvoiceRows",
      maxDuplicates: 1,
    });

    expect(explanation.target.kind).toBe("symbol");
    expect(explanation.duplicates).toHaveLength(1);
    expect(explanation.duplicates[0]?.left.name).toBe("normalizeInvoiceRows");
    expect(explanation.omittedCounts.duplicates).toBe(0);
  });

  it("summarizes duplicate variants that touch the explained file", async () => {
    const root = await mkManyDuplicateRepo();

    const explanation = await explainCodegraphTarget({ root, target: "src/g.ts", maxDuplicates: 5 });

    expect(explanation.duplicates.length).toBeGreaterThan(0);
    for (const duplicate of explanation.duplicates) {
      expect(duplicate.left.file === "src/g.ts" || duplicate.right.file === "src/g.ts").toBeTruthy();
    }
    const duplicateFollowUp = explanation.followUps.find((followUp) => followUp.tool === "duplicates");
    expect(duplicateFollowUp).toMatchObject({
      tool: "duplicates",
      arguments: { json: true, files: expect.arrayContaining(["src/g.ts"]) },
    });
  });
});
