import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../src/agent/session.js";

async function mkRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-session-"));
  await fs.writeFile(path.join(root, "util.ts"), "export function add(a: number, b: number) { return a + b; }\n");
  await fs.writeFile(path.join(root, "main.ts"), "import { add } from './util';\nexport const total = add(1, 2);\n");
  await fs.writeFile(path.join(root, "schema.sql"), "CREATE TABLE public.users (id int primary key);\n");
  return root;
}

describe("agent session", () => {
  it("loads index, graph, symbol graph, and SQL files once for repeated agent operations", async () => {
    const root = await mkRepo();
    const session = createAgentSession({ root });

    const first = await session.loadProject();
    const second = await session.loadProject();

    expect(second).toBe(first);
    expect(first.files.some((file) => file.endsWith("schema.sql"))).toBeTruthy();
    expect(first.symbolGraph.nodes.size).toBeGreaterThan(0);
    expect(first.fileGraph.nodes.size).toBeGreaterThan(0);
    expect(first.fileGraph).toBe(first.index.graph);
  });

  it("does not cache failed project loads", async () => {
    const root = path.join(os.tmpdir(), `cg-agent-session-retry-${Date.now()}`);
    const session = createAgentSession({ root });

    await expect(session.loadProject()).rejects.toThrow(/Project root does not exist or is not readable:/);

    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "index.ts"), "export const value = 1;\n");

    const snapshot = await session.loadProject();

    expect(snapshot.files.some((file) => file.endsWith("index.ts"))).toBe(true);
  });

  it("preserves explicit discovery globRoot when loading a child root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-agent-session-child-root-"));
    const testsRoot = path.join(root, "tests");
    const keptFile = path.join(testsRoot, "unit", "app.test.ts");
    const ignoredFile = path.join(testsRoot, "samples", "fixture.ts");

    await fs.mkdir(path.dirname(keptFile), { recursive: true });
    await fs.mkdir(path.dirname(ignoredFile), { recursive: true });
    await fs.writeFile(keptFile, "export const kept = 1;\n", "utf8");
    await fs.writeFile(ignoredFile, "export const ignored = 1;\n", "utf8");

    const session = createAgentSession({
      root: testsRoot,
      useConfig: false,
      discovery: {
        globRoot: root,
        includeGlobs: ["tests/**/*.ts"],
        ignoreGlobs: ["tests/samples/**"],
        useGitignore: false,
      },
    });

    const snapshot = await session.loadProject();
    const files = snapshot.files.map((file) => file.replace(/\\/g, "/"));

    expect(files).toContain(keptFile.replace(/\\/g, "/"));
    expect(files).not.toContain(ignoredFile.replace(/\\/g, "/"));
  });
});
