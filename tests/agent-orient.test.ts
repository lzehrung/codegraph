import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../src/agent/session.js";
import { orientCodegraph, orientCodegraphWithSession } from "../src/agent/orient.js";
import * as duplicates from "../src/duplicates.js";
import * as symbolGraphBuild from "../src/graphs/symbol-graph-detailed.js";
import { countingSession } from "./helpers/agent.js";
import { runGit } from "./helpers/git.js";
import { mkTmpDir } from "./helpers/filesystem.js";

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

describe("agent orient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns compact orientation with file focus targets", async () => {
    const root = await mkTmpDir("cg-agent-orient-");
    await writeFile(root, "src/index.ts", "export { run } from './run';\n");
    await writeFile(root, "src/run.ts", "export function run() { return 1; }\n");

    const response = await orientCodegraph({ root, includeRoots: ["src"], budget: "small" });

    expect(response.schemaVersion).toBe(2);
    expect(response.summary.length).toBeGreaterThan(0);
    expect(response.tree.some((entry) => entry.path === "src/index.ts")).toBe(true);
    expect(response.focus.some((focus) => focus.file === "src/index.ts")).toBe(true);
    expect(response.recommendedNext.length).toBeGreaterThan(0);
  });

  it("quotes dash-prefixed file targets in follow-up commands", async () => {
    const root = await mkTmpDir("cg-agent-orient-dash-file-");
    await writeFile(root, "-entry.ts", "export const value = 1;\n");

    const response = await orientCodegraph({ root, includeRoots: ["."], budget: "small" });

    expect(response.focus[0]?.file).toBe("-entry.ts");
    expect(response.focus[0]?.followUps[0]).toBe("codegraph packet get ./-entry.ts --pretty");
  });

  it("disambiguates handle-like file targets in follow-up commands", async () => {
    const root = await mkTmpDir("cg-agent-orient-handle-like-file-");
    await writeFile(root, "file:entry.ts", "export const value = 1;\n");

    const response = await orientCodegraph({ root, includeRoots: ["."], budget: "small" });

    expect(response.focus[0]?.file).toBe("file:entry.ts");
    expect(response.focus[0]?.followUps[0]).toBe("codegraph packet get ./file:entry.ts --pretty");
  });

  it("does not build the detailed symbol graph for orientation", async () => {
    const root = await mkTmpDir("cg-agent-orient-skip-symbol-graph-");
    await writeFile(root, "src/index.ts", "export { run } from './run';\n");
    await writeFile(root, "src/run.ts", "export function run() { return 1; }\n");
    const counted = countingSession(createAgentSession({ root }));
    const symbolGraphSpy = vi.spyOn(symbolGraphBuild, "buildSymbolGraphDetailed");

    const response = await orientCodegraphWithSession(counted.session, {
      root,
      includeRoots: ["src"],
      budget: "small",
    });

    expect(response.tree.some((entry) => entry.path === "src/index.ts")).toBe(true);
    expect(symbolGraphSpy).not.toHaveBeenCalled();
    expect(counted.loads()).toBe(1);
  });

  it("treats dot include root as unscoped orientation", async () => {
    const root = await mkTmpDir("cg-agent-orient-dot-");
    await writeFile(root, "src/index.ts", "export const value = 1;\n");

    const response = await orientCodegraph({ root, includeRoots: ["."], budget: "small" });

    expect(response.tree.some((entry) => entry.path === "src/index.ts")).toBe(true);
    expect(response.focus.some((focus) => focus.file === "src/index.ts")).toBe(true);
    expect(response.omittedCounts.focusTargets).toBe(0);
    expect(response.recommendedNext.some((next) => next.command === "codegraph hotspots . --limit 20")).toBe(true);
    expect(
      response.recommendedNext.some((next) => next.command === "codegraph impact --base HEAD --head WORKTREE --pretty"),
    ).toBe(false);
    expect(
      response.recommendedNext.some(
        (next) => next.command === "codegraph review --base HEAD --head WORKTREE --summary",
      ),
    ).toBe(false);
  });

  it("recommends worktree review commands inside git repos", async () => {
    const root = await mkTmpDir("cg-agent-orient-git-");
    runGit(root, ["init"]);
    await writeFile(root, "src/index.ts", "export const value = 1;\n");

    const response = await orientCodegraph({ root, includeRoots: ["."], budget: "small" });

    expect(
      response.recommendedNext.some((next) => next.command === "codegraph impact --base HEAD --head WORKTREE --pretty"),
    ).toBe(true);
    expect(
      response.recommendedNext.some(
        (next) => next.command === "codegraph review --base HEAD --head WORKTREE --summary",
      ),
    ).toBe(true);
  });

  it("normalizes absolute include roots against the project root", async () => {
    const root = await mkTmpDir("cg-agent-orient-absolute-root-");
    await writeFile(root, "src/index.ts", "export const value = 1;\n");
    await writeFile(root, "docs/guide.md", "# Guide\n");

    const response = await orientCodegraph({ root, includeRoots: [path.join(root, "src")], budget: "small" });

    expect(response.tree.some((entry) => entry.path === "src/index.ts")).toBe(true);
    expect(response.tree.some((entry) => entry.path === "docs/guide.md")).toBe(false);
    expect(response.focus.some((focus) => focus.file === "src/index.ts")).toBe(true);
    expect(response.focus.some((focus) => focus.file === "docs/guide.md")).toBe(false);
  });

  it("prioritizes graph-central files over shallow root files", async () => {
    const root = await mkTmpDir("cg-agent-orient-hotspot-first-");
    await writeFile(root, "package.json", '{"name":"sample"}\n');
    await writeFile(root, "src/core.ts", "export function core() { return 1; }\n");
    await writeFile(root, "src/alpha.ts", "import { core } from './core';\nexport const alpha = core();\n");
    await writeFile(root, "src/beta.ts", "import { core } from './core';\nexport const beta = core();\n");
    await writeFile(root, "src/gamma.ts", "import { core } from './core';\nexport const gamma = core();\n");

    const response = await orientCodegraph({ root, includeRoots: ["."], budget: "small" });

    expect(response.focus[0]?.file).toBe("src/core.ts");
    expect(response.focus[0]?.kind).toBe("hotspot");
    expect(response.focus[0]?.followUps.some((followUp) => followUp.includes("codegraph explain src/core.ts"))).toBe(
      true,
    );
  });

  it("uses small budget to skip deep health analysis", async () => {
    const root = await mkTmpDir("cg-agent-orient-budget-");
    await writeFile(root, "src/first.ts", "export function first() { return 1; }\n");
    await writeFile(root, "src/second.ts", "export function second() { return 2; }\n");

    const response = await orientCodegraph({ root, includeRoots: ["src"], budget: "small" });

    expect(response.health.cycles).toBeNull();
    expect(response.health.unresolved).toBeNull();
    expect(response.health.duplicateGroups).toBeNull();
    expect(response.omittedCounts.healthAnalyses).toBe(3);
    expect(response.summary).toContain("Health analysis skipped for small budget.");
  });

  it("uses summary health by default for medium budgets without duplicate detection", async () => {
    const root = await mkTmpDir("cg-agent-orient-summary-health-");
    await writeFile(root, "src/first.ts", "export function first() { return 1; }\n");
    await writeFile(root, "src/second.ts", "import { first } from './first';\nexport const second = first();\n");
    const duplicateSpy = vi.spyOn(duplicates, "findDuplicates");

    const response = await orientCodegraph({ root, includeRoots: ["src"], budget: "medium" });

    expect(response.health.cycles).toBe(0);
    expect(response.health.unresolved).toBe(0);
    expect(response.health.duplicateGroups).toBeNull();
    expect(response.omittedCounts.healthAnalyses).toBe(1);
    expect(response.summary).toContain("0 cycle(s), 0 unresolved import group(s); duplicate health skipped.");
    expect(duplicateSpy).not.toHaveBeenCalled();
  });

  it("runs full duplicate health only when requested", async () => {
    const root = await mkTmpDir("cg-agent-orient-full-health-");
    await writeFile(root, "src/first.ts", "export function first() { return 1; }\n");
    await writeFile(root, "src/second.ts", "export function second() { return 2; }\n");
    const duplicateSpy = vi.spyOn(duplicates, "findDuplicates");

    const response = await orientCodegraph({ root, includeRoots: ["src"], budget: "medium", health: "full" });

    expect(response.health.cycles).toBe(0);
    expect(response.health.unresolved).toBe(0);
    expect(response.health.duplicateGroups).not.toBeNull();
    expect(response.omittedCounts.healthAnalyses).toBe(0);
    expect(duplicateSpy).toHaveBeenCalledTimes(1);
  });
});
