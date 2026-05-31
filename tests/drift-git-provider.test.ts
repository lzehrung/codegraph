import path from "node:path";
import fsp from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeArchitectureDrift } from "../src/drift/index.js";
import { mkTmpDir } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";

async function writeFile(root: string, file: string, content: string): Promise<void> {
  const fullPath = path.join(root, file);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content, "utf8");
}

async function commitAll(root: string, message: string): Promise<string> {
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", message]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

describe("architecture drift git provider", () => {
  it("compares git refs without dirtying the worktree", async () => {
    const root = await mkTmpDir("cg-drift-git-");
    runGit(root, ["init"]);
    await writeFile(root, "src/a.ts", "import { b } from './b'; export function a() { return b(); }\n");
    await writeFile(root, "src/b.ts", "export function b() { return 1; }\n");
    await commitAll(root, "base");

    await writeFile(root, "src/b.ts", "import { a } from './a'; export function b() { return a(); }\n");
    await commitAll(root, "head");

    const beforeStatus = runGit(root, ["status", "--short"]);
    const report = await analyzeArchitectureDrift(root, {
      provider: "git",
      base: "HEAD~1",
      head: "HEAD",
      includeRoots: ["src"],
    });
    const afterStatus = runGit(root, ["status", "--short"]);

    expect(beforeStatus).toBe("");
    expect(afterStatus).toBe("");
    expect(report.findings).toContainEqual(expect.objectContaining({ kind: "new-cycle", severity: "error" }));
  });

  it("accepts WORKTREE as the head sentinel", async () => {
    const root = await mkTmpDir("cg-drift-worktree-");
    runGit(root, ["init"]);
    await writeFile(root, "src/a.ts", "import { b } from './b'; export function a() { return b(); }\n");
    await writeFile(root, "src/b.ts", "export function b() { return 1; }\n");
    await commitAll(root, "base");

    await writeFile(root, "src/b.ts", "import { a } from './a'; export function b() { return a(); }\n");

    const report = await analyzeArchitectureDrift(root, {
      provider: "git",
      base: "HEAD",
      head: "WORKTREE",
      includeRoots: ["src"],
    });

    expect(report.findings).toContainEqual(expect.objectContaining({ kind: "new-cycle", severity: "error" }));
  });
});
