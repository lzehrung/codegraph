import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { explainCodegraphTarget } from "../src/agent/explain.js";

async function mkRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-explain-"));
  await fs.writeFile(path.join(root, "users.sql"), "CREATE TABLE public.users (id int primary key);\n");
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
    expect(explanation.snippets.some((snippet) => snippet.file === "api.ts" && snippet.text.includes("validateUser"))).toBeTruthy();
    expect(explanation.followUps.some((cmd) => cmd.includes("codegraph goto auth.ts"))).toBeTruthy();
  });

  it("explains SQL objects without claiming current-schema reconstruction", async () => {
    const root = await mkRepo();
    const explanation = await explainCodegraphTarget({ root, target: "public.users" });

    expect(explanation.target.kind).toBe("sql_object");
    expect(explanation.relatedSqlObjects.some((entry) => entry.name === "public.users")).toBeTruthy();
    expect(explanation.summary.join(" ")).not.toContain("current schema");
  });

  it("bounds dependency and snippet output", async () => {
    const root = await mkRepo();
    await fs.writeFile(path.join(root, "other.ts"), "import { validateUser } from './auth';\nexport const ok = validateUser(2);\n");

    const explanation = await explainCodegraphTarget({
      root,
      target: "validateUser",
      maxDependencies: 1,
      maxSnippets: 1,
    });

    expect(explanation.reverseDependencies.length).toBeLessThanOrEqual(1);
    expect(explanation.snippets.length).toBeLessThanOrEqual(1);
  });
});
