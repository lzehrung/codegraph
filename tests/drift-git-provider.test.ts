import path from "node:path";
import fsp from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
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

    expect(report.root.replace(/\\/g, "/")).toBe(root.replace(/\\/g, "/"));
    expect(report.base.ref).toBe("HEAD~1");
    expect(report.head.ref).toBe("HEAD");
    expect(report.base.root.replace(/\\/g, "/")).toBe(root.replace(/\\/g, "/"));
    expect(report.head.root.replace(/\\/g, "/")).toBe(root.replace(/\\/g, "/"));
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

  it("cleans up the base temp checkout when head materialization fails", async () => {
    const root = await mkTmpDir("cg-drift-git-cleanup-");
    const isolatedTmp = await mkTmpDir("cg-drift-isolated-tmp-");
    runGit(root, ["init"]);
    await writeFile(root, "src/a.ts", "export function a() { return 1; }\n");
    await commitAll(root, "base");

    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, tmpdir: () => isolatedTmp };
    });

    try {
      const { analyzeArchitectureDrift: analyzeWithMock } = await import("../src/drift/git.js");
      const beforeEntries = await fsp.readdir(isolatedTmp);
      await expect(
        analyzeWithMock(root, {
          provider: "git",
          base: "HEAD",
          head: "definitely-not-a-real-ref",
          includeRoots: ["src"],
        }),
      ).rejects.toThrow();
      const afterEntries = await fsp.readdir(isolatedTmp);
      expect(afterEntries).toEqual(beforeEntries);
    } finally {
      vi.doUnmock("node:os");
      vi.resetModules();
      await fsp.rm(isolatedTmp, { recursive: true, force: true });
    }
  });

  it("treats option-like refs as invalid revisions instead of checkout options", async () => {
    const root = await mkTmpDir("cg-drift-git-option-like-ref-");
    runGit(root, ["init"]);
    await writeFile(root, "src/a.ts", "export function a() { return 1; }\n");
    await commitAll(root, "base");

    await expect(
      analyzeArchitectureDrift(root, {
        provider: "git",
        base: "-h",
        head: "HEAD",
        includeRoots: ["src"],
      }),
    ).rejects.not.toThrow(/git checkout|switch branches|usage: git checkout/i);
  });

  it("preserves the original git error when cleanup fails", async () => {
    const root = await mkTmpDir("cg-drift-git-cleanup-error-");
    runGit(root, ["init"]);
    await writeFile(root, "src/a.ts", "export function a() { return 1; }\n");
    await commitAll(root, "base");

    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        rm: vi.fn(async () => {
          throw new Error("cleanup failed");
        }),
      };
    });

    try {
      const { analyzeArchitectureDrift: analyzeWithMock } = await import("../src/drift/git.js");
      await expect(
        analyzeWithMock(root, {
          provider: "git",
          base: "HEAD",
          head: "definitely-not-a-real-ref",
          includeRoots: ["src"],
        }),
      ).rejects.not.toThrow("cleanup failed");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});
