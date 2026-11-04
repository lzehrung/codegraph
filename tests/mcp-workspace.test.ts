import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCodegraphMcpHandlers } from "../src/mcp/handlers.js";
import { isPlainRecord } from "../src/util/guards.js";
import { dispatchWorkspaceTool, parseWorkspaceQualifiedValue, qualifyWorkspaceValue } from "../src/mcp/workspace.js";
import { loadWorkspaceMcpConfig, type WorkspaceProject } from "../src/mcp/workspace-config.js";
import { mkTmpDir, tryCreateDirectorySymlink, tryCreateFileSymlink } from "./helpers/filesystem.js";

async function makeWorkspace(prefix: string): Promise<string> {
  const root = await mkTmpDir(prefix);
  await fs.mkdir(path.join(root, "projects", "app"), { recursive: true });
  await fs.mkdir(path.join(root, "projects", "lib"), { recursive: true });
  await fs.mkdir(path.join(root, "worktrees", "app-copy"), { recursive: true });
  return root;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Workspace test fixture is not JSON serializable.");
  await fs.writeFile(filePath, serialized, "utf8");
}

async function writeWorkspaceConfig(root: string, config: unknown): Promise<void> {
  await writeJsonFile(path.join(root, "workspace.json"), config);
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected a list of workspace results.");
  return value.map((item) => {
    if (!isPlainRecord(item)) throw new Error("Expected a workspace result object.");
    return item;
  });
}

describe("workspace MCP configuration and routing", () => {
  it("deduplicates physical aliases, keeps worktrees distinct, and reports only configured edges", async () => {
    const root = await makeWorkspace("codegraph-workspace-config-");
    try {
      const appRoot = path.join(root, "projects", "app");
      const worktreeRoot = path.join(root, "worktrees", "app-copy");
      const commonGitDir = path.join(root, ".git", "worktrees", "shared");
      await fs.writeFile(path.join(appRoot, ".git"), `gitdir: ${commonGitDir}\n`, "utf8");
      await fs.writeFile(path.join(worktreeRoot, ".git"), `gitdir: ${commonGitDir}\n`, "utf8");
      await writeWorkspaceConfig(root, {
        projects: [
          { id: "app", path: "projects/app" },
          { id: "app-alias", path: "projects/./app" },
          { id: "lib", path: "projects/lib" },
          { id: "app-worktree", path: "worktrees/app-copy" },
        ],
        dependencies: [
          { from: "app-alias", to: "lib" },
          { from: "lib", to: "app-worktree" },
        ],
      });

      const config = await loadWorkspaceMcpConfig(root, "workspace.json");
      expect(config.projects.map((project) => project.id)).toEqual(["app", "lib", "app-worktree"]);
      expect(config.projects[0]?.aliases).toEqual(["app-alias"]);
      expect(config.projects[0]?.root).not.toBe(config.projects[2]?.root);
      expect(config.dependencies).toEqual([
        { from: "app", to: "lib", configuredFrom: "app-alias", configuredTo: "lib" },
        { from: "lib", to: "app-worktree", configuredFrom: "lib", configuredTo: "app-worktree" },
      ]);

      let ownersStarted = false;
      const inventory = await dispatchWorkspaceTool(config, "workspace_projects", {}, async () => {
        ownersStarted = true;
        throw new Error("inventory must not start project owners");
      });
      expect(ownersStarted).toBe(false);
      expect(inventory).toMatchObject({
        projects: [
          { id: "app", path: "projects/app", aliases: ["app-alias"] },
          { id: "lib", path: "projects/lib", aliases: [] },
          { id: "app-worktree", path: "worktrees/app-copy", aliases: [] },
        ],
        dependencies: [
          {
            from: "app",
            to: "lib",
            evidence: {
              source: "workspace-config",
              relationship: "explicitly-configured",
              configuredFrom: "app-alias",
              configuredTo: "lib",
            },
          },
          {
            from: "lib",
            to: "app-worktree",
            evidence: {
              source: "workspace-config",
              relationship: "explicitly-configured",
              configuredFrom: "lib",
              configuredTo: "app-worktree",
            },
          },
        ],
        freshness: { state: "configuration-only", queried: false },
      });
      await expect(
        dispatchWorkspaceTool(config, "workspace_projects", { project: "app" }, async () => ({})),
      ).rejects.toThrow("does not accept arguments");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("revalidates deduplicated aliases while preserving caller-facing logical roots", async () => {
    const root = await makeWorkspace("codegraph-workspace-logical-");
    const aliasParent = await mkTmpDir("codegraph-workspace-alias-");
    const workspaceAlias = path.join(aliasParent, "selected");
    const projectAlias = path.join(root, "projects", "app-alias");
    let workspaceLinked = false;
    let projectLinked = false;
    try {
      workspaceLinked = await tryCreateDirectorySymlink(root, workspaceAlias);
      projectLinked = await tryCreateDirectorySymlink(path.join(root, "projects", "app"), projectAlias);
      if (!workspaceLinked || !projectLinked) return;
      const source = `export const physicalRootText = ${JSON.stringify(root)};\n`;
      const handle = "symbol:main.ts:physicalRootText:1:0";
      await fs.writeFile(path.join(root, "projects", "app", "main.ts"), source);
      await writeWorkspaceConfig(root, {
        projects: [
          { id: "app", path: "projects/app" },
          { id: "app-alias", path: "projects/app-alias" },
        ],
      });
      const config = await loadWorkspaceMcpConfig(workspaceAlias, "workspace.json");
      expect(config.projects.map((project) => project.id)).toEqual(["app"]);
      const readFile = vi.fn(async (project: WorkspaceProject) => ({
        root: project.root,
        content: await fs.readFile(path.join(project.root, "main.ts"), "utf8"),
        handle,
        freshness: { state: "fresh" },
      }));
      for (const input of [
        { project: "app-alias", file: "main.ts" },
        { project: "app-alias", file: qualifyWorkspaceValue("app", "main.ts") },
        { file: qualifyWorkspaceValue("app-alias", "main.ts") },
      ]) {
        const response = await dispatchWorkspaceTool(config, "get_file", input, readFile);
        expect(records(response.projects)).toMatchObject([
          {
            project: { id: "app", path: "projects/app-alias", aliases: ["app-alias"] },
            status: "ok",
            result: {
              root: path.join(workspaceAlias, "projects", "app-alias"),
              content: source,
              handle: qualifyWorkspaceValue("app", handle),
            },
          },
        ]);
        expect(response.coverage).toMatchObject({ selectedProjects: 1, complete: true });
      }
      expect(readFile).toHaveBeenCalledTimes(3);
      const canonical = await dispatchWorkspaceTool(
        config,
        "get_file",
        { project: "app", file: qualifyWorkspaceValue("app-alias", "main.ts") },
        readFile,
      );
      expect(records(canonical.projects)[0]).toMatchObject({
        project: { id: "app", path: "projects/app" },
        result: { root: path.join(workspaceAlias, "projects", "app"), content: source },
      });

      await fs.unlink(projectAlias);
      projectLinked = false;
      projectLinked = await tryCreateDirectorySymlink(path.join(root, "projects", "lib"), projectAlias);
      if (!projectLinked) throw new Error("Could not retarget the project alias.");
      const call = vi.fn(async () => ({ freshness: { state: "fresh" } }));
      for (const input of [
        { project: "app-alias", file: "main.ts" },
        { project: "app-alias", file: qualifyWorkspaceValue("app", "main.ts") },
        { project: "app", file: qualifyWorkspaceValue("app-alias", "main.ts") },
        { file: qualifyWorkspaceValue("app-alias", "main.ts") },
      ]) {
        const changed = await dispatchWorkspaceTool(config, "get_file", input, call);
        expect(records(changed.projects)[0]).toMatchObject({
          status: "error",
          error: expect.stringContaining("root changed"),
          coverage: { state: "failed" },
        });
        expect(changed.coverage).toEqual({
          selectedProjects: 1,
          completedProjects: 0,
          failedProjects: 1,
          complete: false,
        });
      }
      expect(call).not.toHaveBeenCalled();
      const unchanged = await dispatchWorkspaceTool(config, "get_file", { project: "app", file: "main.ts" }, readFile);
      expect(records(unchanged.projects)[0]).toMatchObject({
        status: "ok",
        result: {
          root: path.join(workspaceAlias, "projects", "app"),
          content: source,
          handle: qualifyWorkspaceValue("app", handle),
        },
      });
    } finally {
      if (projectLinked) await fs.unlink(projectAlias);
      if (workspaceLinked) await fs.unlink(workspaceAlias);
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(aliasParent, { recursive: true, force: true });
    }
  });

  it.each(["search", "workspace_symbols"])(
    "fails one canonical project when a configured alias changes during %s fanout",
    async (toolName) => {
      const root = await makeWorkspace("codegraph-workspace-alias-fanout-");
      const projectAlias = path.join(root, "projects", "app-alias");
      let linked = false;
      try {
        linked = await tryCreateDirectorySymlink(path.join(root, "projects", "app"), projectAlias);
        if (!linked) return;
        await writeWorkspaceConfig(root, {
          projects: [
            { id: "app", path: "projects/app" },
            { id: "app-alias", path: "projects/app-alias" },
            { id: "lib", path: "projects/lib" },
          ],
        });
        const config = await loadWorkspaceMcpConfig(root, "workspace.json");
        const collection = toolName === "search" ? "results" : "symbols";
        const call = vi.fn(async (project: WorkspaceProject) => ({
          root: project.root,
          [collection]: [{ handle: `symbol:main.ts:${project.id}:1:0` }],
          freshness: { state: "fresh" },
        }));
        const initial = await dispatchWorkspaceTool(config, toolName, { query: "needle" }, call);
        expect(call.mock.calls.map(([project]) => project.id).sort()).toEqual(["app", "lib"]);
        expect(records(initial.projects)).toMatchObject([
          {
            project: { id: "app", path: "projects/app", aliases: ["app-alias"] },
            status: "ok",
            result: { [collection]: [{ handle: qualifyWorkspaceValue("app", "symbol:main.ts:app:1:0") }] },
          },
          { project: { id: "lib" }, status: "ok" },
        ]);
        expect(initial.coverage).toEqual({
          selectedProjects: 2,
          completedProjects: 2,
          failedProjects: 0,
          complete: true,
        });

        await fs.unlink(projectAlias);
        linked = false;
        linked = await tryCreateDirectorySymlink(path.join(root, "projects", "lib"), projectAlias);
        if (!linked) throw new Error("Could not retarget the project alias.");
        call.mockClear();
        const changed = await dispatchWorkspaceTool(config, toolName, { query: "needle" }, call);
        expect(call.mock.calls.map(([project]) => project.id)).toEqual(["lib"]);
        expect(records(changed.projects)).toMatchObject([
          {
            project: { id: "app", path: "projects/app", aliases: ["app-alias"] },
            status: "error",
            error: expect.stringContaining("root changed"),
            coverage: { state: "failed" },
          },
          {
            project: { id: "lib" },
            status: "ok",
            result: { [collection]: [{ handle: qualifyWorkspaceValue("lib", "symbol:main.ts:lib:1:0") }] },
          },
        ]);
        expect(changed.coverage).toEqual({
          selectedProjects: 2,
          completedProjects: 1,
          failedProjects: 1,
          complete: false,
        });
      } finally {
        if (linked) await fs.unlink(projectAlias);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not let a secondary declaration bypass a changed canonical project root", async () => {
    const root = await makeWorkspace("codegraph-workspace-canonical-alias-");
    const projectAlias = path.join(root, "projects", "app-primary");
    let linked = false;
    try {
      linked = await tryCreateDirectorySymlink(path.join(root, "projects", "app"), projectAlias);
      if (!linked) return;
      await writeWorkspaceConfig(root, {
        projects: [
          { id: "app", path: "projects/app-primary" },
          { id: "app-alias", path: "projects/app" },
        ],
      });
      const config = await loadWorkspaceMcpConfig(root, "workspace.json");
      expect(config.projects.map((project) => project.id)).toEqual(["app"]);
      await fs.unlink(projectAlias);
      linked = false;
      linked = await tryCreateDirectorySymlink(path.join(root, "projects", "lib"), projectAlias);
      if (!linked) throw new Error("Could not retarget the canonical project alias.");
      const call = vi.fn(async () => ({ freshness: { state: "fresh" } }));
      for (const input of [
        { project: "app-alias", file: "main.ts" },
        { project: "app", file: qualifyWorkspaceValue("app-alias", "main.ts") },
        { file: qualifyWorkspaceValue("app-alias", "main.ts") },
      ]) {
        const changed = await dispatchWorkspaceTool(config, "get_file", input, call);
        expect(records(changed.projects)[0]).toMatchObject({
          status: "error",
          error: expect.stringContaining("root changed"),
        });
      }
      expect(call).not.toHaveBeenCalled();
    } finally {
      if (linked) await fs.unlink(projectAlias);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects config and project paths that leave the workspace physically", async () => {
    const root = await makeWorkspace("codegraph-workspace-confinement-");
    const outside = await mkTmpDir("codegraph-workspace-outside-");
    try {
      await writeJsonFile(path.join(outside, "workspace.json"), { projects: [{ id: "x", path: "." }] });
      await expect(
        loadWorkspaceMcpConfig(root, path.relative(root, path.join(outside, "workspace.json"))),
      ).rejects.toThrow("inside the workspace root");

      await writeWorkspaceConfig(root, { projects: [{ id: "outside", path: "../" + path.basename(outside) }] });
      await expect(loadWorkspaceMcpConfig(root, "workspace.json")).rejects.toThrow("stay inside the workspace root");

      const projectLink = path.join(root, "projects", "external");
      if (await tryCreateDirectorySymlink(outside, projectLink)) {
        await writeWorkspaceConfig(root, { projects: [{ id: "external", path: "projects/external" }] });
        await expect(loadWorkspaceMcpConfig(root, "workspace.json")).rejects.toThrow(
          "resolves outside the workspace root",
        );
      }

      const configLink = path.join(root, "external-workspace.json");
      if (await tryCreateFileSymlink(path.join(outside, "workspace.json"), configLink)) {
        await expect(loadWorkspaceMcpConfig(root, "external-workspace.json")).rejects.toThrow();
      }
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("fans search out with concurrency two and keeps deterministic per-project coverage and errors", async () => {
    const root = await makeWorkspace("codegraph-workspace-fanout-");
    try {
      await writeWorkspaceConfig(root, {
        projects: [
          { id: "app", path: "projects/app" },
          { id: "lib", path: "projects/lib" },
          { id: "worktree", path: "worktrees/app-copy" },
        ],
      });
      const config = await loadWorkspaceMcpConfig(root, "workspace.json");
      let active = 0;
      let maxActive = 0;
      const started: string[] = [];
      const firstWave = Promise.withResolvers<void>();
      const dispatched = dispatchWorkspaceTool(config, "search", { query: "needle", limit: 3 }, async (project) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started.push(project.id);
        try {
          if (started.length === 2) firstWave.resolve();
          await firstWave.promise;
          if (project.id === "worktree") throw new Error("project index unavailable");
          return {
            freshness: { state: "fresh" },
            omittedCounts: project.id === "app" ? { results: 2 } : { results: 0 },
            results: [{ handle: `symbol:${project.id}.ts:needle:1:0` }],
          };
        } finally {
          active -= 1;
        }
      });
      const response = await dispatched;
      const projectResults = records(response.projects);
      expect(maxActive).toBe(2);
      expect(started.sort()).toEqual(["app", "lib", "worktree"]);
      expect(projectResults.map((result) => (isPlainRecord(result.project) ? result.project.id : undefined))).toEqual([
        "app",
        "lib",
        "worktree",
      ]);
      expect(projectResults[0]).toMatchObject({
        status: "ok",
        result: { results: [{ handle: qualifyWorkspaceValue("app", "symbol:app.ts:needle:1:0") }] },
        coverage: { state: "partial", freshness: { state: "fresh" }, omittedCounts: { results: 2 } },
      });
      expect(projectResults[1]).toMatchObject({
        status: "ok",
        coverage: { state: "complete", freshness: { state: "fresh" }, omittedCounts: { results: 0 } },
      });
      expect(projectResults[2]).toMatchObject({
        status: "error",
        error: "project index unavailable",
        coverage: { state: "failed", freshness: { state: "unavailable" } },
      });
      expect(response).toMatchObject({
        errors: [{ project: { id: "worktree" }, error: "project index unavailable" }],
        coverage: { selectedProjects: 3, completedProjects: 2, failedProjects: 1, complete: false },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      message:
        "The Codegraph server at http://127.0.0.1:7331/mcp has an incompatible shared-owner configuration or runtime. Stop the owner, then reconnect.",
      expected:
        "The Codegraph server at http://127.0.0.1:7331/mcp has an incompatible shared-owner configuration or runtime. Stop the owner, then reconnect.",
    },
    {
      message: "ENOENT: no such file or directory, open '/private/work space/project.json'",
      expected: "ENOENT: no such file or directory, open '<path>'",
    },
    {
      message: 'EACCES: open "C:\\private work\\project.json" failed',
      expected: 'EACCES: open "<path>" failed',
    },
  ])("preserves actionable workspace errors while redacting file paths: $message", async ({ message, expected }) => {
    const root = await makeWorkspace("codegraph-workspace-errors-");
    try {
      await writeWorkspaceConfig(root, { projects: [{ id: "app", path: "projects/app" }] });
      const config = await loadWorkspaceMcpConfig(root, "workspace.json");
      const response = await dispatchWorkspaceTool(config, "workspace_symbols", { query: "needle" }, async () => {
        throw new Error(message);
      });
      expect(records(response.projects)[0]).toMatchObject({
        status: "error",
        error: expected,
        coverage: { state: "failed", freshness: { state: "unavailable" } },
      });
      expect(response.errors).toEqual([{ project: { id: "app", path: "projects/app", aliases: [] }, error: expected }]);
      expect(response.coverage).toEqual({
        selectedProjects: 1,
        completedProjects: 0,
        failedProjects: 1,
        complete: false,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports building owners as pending rather than completed search coverage", async () => {
    const root = await makeWorkspace("codegraph-workspace-pending-");
    try {
      await writeWorkspaceConfig(root, {
        projects: [
          { id: "app", path: "projects/app" },
          { id: "lib", path: "projects/lib" },
        ],
      });
      const config = await loadWorkspaceMcpConfig(root, "workspace.json");
      const pending = {
        status: "index_building",
        tool: "search",
        message: "Index is building.",
        retryAfterMs: 1000,
        waitedMs: 0,
        progress: { activity: "Building project index", elapsedMs: 10 },
      };
      const response = await dispatchWorkspaceTool(config, "search", { query: "needle" }, async (project) => {
        if (project.id === "app") return pending;
        return { results: [], freshness: { state: "fresh" }, omittedCounts: { results: 0 } };
      });
      expect(records(response.projects)).toMatchObject([
        { project: { id: "app" }, status: "index_building", result: pending, coverage: { state: "pending" } },
        { project: { id: "lib" }, status: "ok", coverage: { state: "complete" } },
      ]);
      expect(response.coverage).toEqual({
        selectedProjects: 2,
        completedProjects: 1,
        failedProjects: 0,
        complete: false,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { freshness: { state: "fresh" }, truncated: true, omitted: 2 },
    { freshness: { state: "fresh" }, referenceCoverage: { state: "partial", reasons: ["parse_error"] } },
    { freshness: { state: "fresh" }, omittedCounts: { results: 1 } },
    { freshness: { state: "fresh" }, analysis: { parserDegradedFiles: 1, nativeFilesFellBack: 0 } },
    { freshness: { state: "fresh" }, analysis: { parserDegradedFiles: 0, nativeFilesFellBack: 1 } },
    { results: [] },
  ])("preserves partial or unreported owner coverage: %j", async (answer) => {
    const root = await makeWorkspace("codegraph-workspace-partial-");
    try {
      await writeWorkspaceConfig(root, { projects: [{ id: "app", path: "projects/app" }] });
      const config = await loadWorkspaceMcpConfig(root, "workspace.json");
      const response = await dispatchWorkspaceTool(
        config,
        "refs",
        { project: "app", file: "main.ts", line: 1, column: 1 },
        async () => answer,
      );
      expect(records(response.projects)[0]).toMatchObject({ status: "ok", coverage: { state: "partial" } });
      expect(response.coverage).toMatchObject({ completedProjects: 1, complete: false });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("derives packet and explore coverage from nested evidence with fresh zero-omission outer metadata", async () => {
    const root = await makeWorkspace("codegraph-workspace-packet-coverage-");
    const projectRoot = await fs.realpath(path.join(root, "projects", "app"));
    const handlers = createCodegraphMcpHandlers({
      root: projectRoot,
      buildOptions: { cache: "off" },
      useConfig: false,
    });
    try {
      await fs.writeFile(
        path.join(projectRoot, "main.ts"),
        "export function needle(): number { return 1; }\nexport const value = needle();\n",
      );
      await writeWorkspaceConfig(root, { projects: [{ id: "app", path: "projects/app" }] });
      const config = await loadWorkspaceMcpConfig(root, "workspace.json");
      const symbols = await handlers.workspace_symbols({ query: "needle", limit: 1 });
      const handle = symbols.symbols[0]?.handle;
      if (!handle) throw new Error("Packet fixture symbol was not indexed.");
      const ownerPacket = await handlers.packet_get({ target: handle });
      const explanation = ownerPacket.packet;
      if (!("target" in explanation)) throw new Error("Expected an explanation packet.");
      expect(ownerPacket.freshness.state).toBe("fresh");
      expect(Object.values(ownerPacket.omittedCounts).every((count) => !count)).toBe(true);
      expect(explanation.analysis).toMatchObject({ parserDegradedFiles: 0, nativeFilesFellBack: 0 });
      expect(explanation.referenceCoverage?.state).toBe("complete");
      const ownerExplore = await handlers.explore({ query: "main.ts", includeSource: true });
      expect(ownerExplore.freshness.state).toBe("fresh");
      expect(Object.values(ownerExplore.omittedCounts).every((count) => !count)).toBe(true);

      for (const [label, parserDegradedFiles, nativeFilesFellBack, referenceState, complete] of [
        ["complete evidence", 0, 0, "complete", true],
        ["degraded parser", 1, 0, "complete", false],
        ["skipped native file", 0, 1, "complete", false],
        ["partial reference proof", 0, 0, "partial", false],
      ] as const) {
        const answer: typeof ownerPacket = {
          ...ownerPacket,
          packet: {
            ...explanation,
            analysis: { ...explanation.analysis, parserDegradedFiles, nativeFilesFellBack },
            referenceCoverage: { scope: "indexed_candidates", state: referenceState },
          },
        };
        const response = await dispatchWorkspaceTool(
          config,
          "packet_get",
          { project: "app", target: handle },
          async () => answer,
        );
        expect(records(response.projects)[0], label).toMatchObject({
          status: "ok",
          coverage: {
            state: complete ? "complete" : "partial",
            freshness: { state: "fresh" },
            omittedCounts: ownerPacket.omittedCounts,
          },
        });
        expect(response.coverage, label).toEqual({
          selectedProjects: 1,
          completedProjects: 1,
          failedProjects: 0,
          complete,
        });
        const exploreAnswer: typeof ownerExplore = { ...ownerExplore, packets: [answer] };
        const exploreResponse = await dispatchWorkspaceTool(
          config,
          "explore",
          { project: "app", query: "main.ts", includeSource: true },
          async () => exploreAnswer,
        );
        expect(records(exploreResponse.projects)[0], label).toMatchObject({
          status: "ok",
          coverage: { state: complete ? "complete" : "partial", omittedCounts: ownerExplore.omittedCounts },
        });
        expect(exploreResponse.coverage, label).toMatchObject({ completedProjects: 1, complete });
      }
      const fileView = ownerExplore.fileView;
      if (!fileView) throw new Error("Exact-file exploration did not include its file view.");
      const truncatedExplore: typeof ownerExplore = { ...ownerExplore, fileView: { ...fileView, truncated: true } };
      const truncatedResponse = await dispatchWorkspaceTool(
        config,
        "explore",
        { project: "app", query: "main.ts", includeSource: true },
        async () => truncatedExplore,
      );
      expect(records(truncatedResponse.projects)[0]).toMatchObject({ status: "ok", coverage: { state: "partial" } });
      expect(truncatedResponse.coverage).toMatchObject({ completedProjects: 1, complete: false });
    } finally {
      handlers.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves nested rename limits and degraded analysis in refactor plan coverage", async () => {
    const root = await makeWorkspace("codegraph-workspace-rename-coverage-");
    const projectRoot = await fs.realpath(path.join(root, "projects", "app"));
    const handlers = createCodegraphMcpHandlers({
      root: projectRoot,
      buildOptions: { cache: "off" },
      useConfig: false,
    });
    try {
      await fs.writeFile(
        path.join(projectRoot, "main.ts"),
        "export interface Contract { run(): void }\nexport class Worker implements Contract { run(): void {} }\n",
      );
      await writeWorkspaceConfig(root, { projects: [{ id: "app", path: "projects/app" }] });
      const config = await loadWorkspaceMcpConfig(root, "workspace.json");
      const symbols = await handlers.workspace_symbols({ query: "Contract", limit: 1 });
      const handle = symbols.symbols[0]?.handle;
      if (!handle) throw new Error("Refactor fixture interface was not indexed.");
      const ownerPlan = await handlers.refactor_plan({ handle, renameTo: "RenamedContract" });
      const rename = ownerPlan.rename;
      if (!rename) throw new Error("Refactor fixture did not include its rename preview.");
      expect(ownerPlan.freshness.state).toBe("fresh");
      expect(Object.values(ownerPlan.omittedCounts).every((count) => !count)).toBe(true);
      expect(ownerPlan.analysis).toMatchObject({ parserDegradedFiles: 0, nativeFilesFellBack: 0 });
      expect(ownerPlan.referenceCoverage?.state).toBe("complete");
      for (const [label, parserDegradedFiles, omittedEdits, complete] of [
        ["complete rename", 0, 0, true],
        ["degraded rename", 1, 0, false],
        ["bounded rename", 0, 1, false],
      ] as const) {
        const answer: typeof ownerPlan = {
          ...ownerPlan,
          rename: {
            ...rename,
            analysis: { ...rename.analysis, parserDegradedFiles },
            omittedCounts: { ...rename.omittedCounts, edits: omittedEdits },
          },
        };
        const response = await dispatchWorkspaceTool(
          config,
          "refactor_plan",
          { project: "app", handle, renameTo: "RenamedContract" },
          async () => answer,
        );
        expect(records(response.projects)[0], label).toMatchObject({
          status: "ok",
          coverage: { state: complete ? "complete" : "partial", omittedCounts: ownerPlan.omittedCounts },
        });
        expect(response.coverage, label).toMatchObject({ completedProjects: 1, complete });
      }
    } finally {
      handlers.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rebases alias packet, explore, and refactor metadata without changing physical-root source text", async () => {
    const root = await makeWorkspace("codegraph-workspace-envelope-roots-");
    const projectRoot = await fs.realpath(path.join(root, "projects", "app"));
    const projectAlias = path.join(root, "projects", "app-alias");
    const handlers = createCodegraphMcpHandlers({
      root: projectRoot,
      buildOptions: { cache: "off" },
      useConfig: false,
    });
    let linked = false;
    try {
      linked = await tryCreateDirectorySymlink(projectRoot, projectAlias);
      if (!linked) return;
      const source = [
        `export interface Contract { run(): void } // ${projectRoot}`,
        `export class Worker implements Contract { run(): void {} } // ${projectRoot}`,
        `export const metadata = ${JSON.stringify({ root: projectRoot, packet: { root: projectRoot } })};`,
        "",
      ].join("\n");
      await fs.writeFile(path.join(projectRoot, "main.ts"), source);
      await writeWorkspaceConfig(root, { projects: [{ id: "app", path: "projects/app-alias" }] });
      const config = await loadWorkspaceMcpConfig(root, "workspace.json");
      const symbols = await handlers.workspace_symbols({ query: "Contract", limit: 1 });
      const handle = symbols.symbols[0]?.handle;
      if (!handle) throw new Error("Alias fixture interface was not indexed.");
      const ownerPacket = await handlers.packet_get({ target: handle });
      const explanation = ownerPacket.packet;
      if (!("target" in explanation)) throw new Error("Expected an explanation packet.");
      expect(explanation.snippets.some((snippet) => snippet.text.includes(projectRoot))).toBe(true);
      const packetResponse = await dispatchWorkspaceTool(
        config,
        "packet_get",
        { project: "app", target: qualifyWorkspaceValue("app", handle) },
        async (_project, _toolName, arguments_) => {
          if (typeof arguments_.target !== "string") throw new Error("Missing routed packet target.");
          return await handlers.packet_get({ target: arguments_.target });
        },
      );
      expect(records(packetResponse.projects)[0]).toMatchObject({
        status: "ok",
        result: {
          root: projectAlias,
          packet: {
            root: projectAlias,
            snippets: explanation.snippets,
            target: { handle: qualifyWorkspaceValue("app", handle) },
          },
        },
      });

      const ownerPlan = await handlers.refactor_plan({ handle, renameTo: "RenamedContract", includeSource: true });
      expect(ownerPlan.references.some((reference) => reference.context?.includes(projectRoot))).toBe(true);
      const planResponse = await dispatchWorkspaceTool(
        config,
        "refactor_plan",
        {
          project: "app",
          handle: qualifyWorkspaceValue("app", handle),
          renameTo: "RenamedContract",
          includeSource: true,
        },
        async (_project, _toolName, arguments_) => {
          if (typeof arguments_.handle !== "string") throw new Error("Missing routed refactor handle.");
          return await handlers.refactor_plan({
            handle: arguments_.handle,
            renameTo: "RenamedContract",
            includeSource: true,
          });
        },
      );
      expect(records(planResponse.projects)[0]).toMatchObject({
        status: "ok",
        result: {
          root: projectAlias,
          references: ownerPlan.references,
          rename: { root: projectAlias, target: { handle: qualifyWorkspaceValue("app", handle) } },
        },
      });

      const ownerExplore = await handlers.explore({ query: "main.ts", includeSource: true });
      expect(ownerExplore.packets.map((packet) => packet.root)).toContain(projectRoot);
      if (!ownerExplore.fileView) throw new Error("Exact-file exploration did not include its file view.");
      expect(ownerExplore.fileView.content).toContain(projectRoot);
      const expectedPackets = ownerExplore.packets.map((packet) => {
        const payload = packet.packet;
        if (!("target" in payload)) throw new Error("Expected an exploration explanation packet.");
        return { root: projectAlias, packet: { root: projectAlias, snippets: payload.snippets } };
      });
      const exploreResponse = await dispatchWorkspaceTool(
        config,
        "explore",
        { project: "app", query: "main.ts", includeSource: true },
        async () => await handlers.explore({ query: "main.ts", includeSource: true }),
      );
      expect(records(exploreResponse.projects)[0]).toMatchObject({
        status: "ok",
        result: {
          packets: expectedPackets,
          fileView: { content: ownerExplore.fileView.content, text: ownerExplore.fileView.text },
        },
      });

      const otherRoot = path.join(root, "projects", "lib");
      const differentRoot = await dispatchWorkspaceTool(
        config,
        "packet_get",
        { project: "app", target: handle },
        async () => ({ ...ownerPacket, packet: { ...explanation, root: otherRoot } }),
      );
      expect(records(differentRoot.projects)[0]).toMatchObject({
        status: "ok",
        result: { root: projectAlias, packet: { root: otherRoot, snippets: explanation.snippets } },
      });
      expect(await fs.readFile(path.join(projectRoot, "main.ts"), "utf8")).toBe(source);
    } finally {
      handlers.dispose();
      if (linked) await fs.unlink(projectAlias);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps returned file and search follow-ups scoped to their originating project", async () => {
    const root = await makeWorkspace("codegraph-workspace-follow-ups-");
    try {
      await writeWorkspaceConfig(root, {
        projects: [
          { id: "app", path: "projects/app" },
          { id: "lib", path: "projects/lib" },
        ],
      });
      const config = await loadWorkspaceMcpConfig(root, "workspace.json");
      const response = await dispatchWorkspaceTool(config, "search", { query: "needle" }, async () => ({
        freshness: { state: "fresh" },
        followUps: [
          { tool: "get_file", arguments: { file: "main.ts" } },
          { tool: "refs", arguments: { file: "main.ts", line: 1, column: 1 } },
          { tool: "packet_get", arguments: { target: "main.ts" } },
          { tool: "search", arguments: { query: "next", mode: "symbol" } },
        ],
        data: { tool: "get_file", arguments: { file: "literal-data.ts" } },
      }));
      const visited: string[] = [];
      for (const group of records(response.projects)) {
        if (!isPlainRecord(group.result)) throw new Error("Missing project result.");
        expect(group.result.data).toEqual({ tool: "get_file", arguments: { file: "literal-data.ts" } });
        for (const followUp of records(group.result.followUps)) {
          if (typeof followUp.tool !== "string") throw new Error("Missing follow-up tool.");
          const next = await dispatchWorkspaceTool(config, followUp.tool, followUp.arguments, async (project) => {
            visited.push(project.id);
            return { freshness: { state: "fresh" } };
          });
          expect(next.coverage).toMatchObject({ selectedProjects: 1, failedProjects: 0 });
        }
      }
      expect(visited).toEqual(["app", "app", "app", "app", "lib", "lib", "lib", "lib"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a selected project replaced by an external directory alias before activation", async () => {
    const root = await makeWorkspace("codegraph-workspace-swap-");
    const outside = await mkTmpDir("codegraph-workspace-external-");
    const projectRoot = path.join(root, "projects", "app");
    let linked = false;
    try {
      await writeWorkspaceConfig(root, { projects: [{ id: "app", path: "projects/app" }] });
      const config = await loadWorkspaceMcpConfig(root, "workspace.json");
      await fs.rename(projectRoot, `${projectRoot}-original`);
      linked = await tryCreateDirectorySymlink(outside, projectRoot);
      if (!linked) return;
      let calls = 0;
      const response = await dispatchWorkspaceTool(config, "search", { query: "needle" }, async () => {
        calls += 1;
        return { results: [{ name: "outsideSecret" }], freshness: { state: "fresh" } };
      });
      expect(calls).toBe(0);
      expect(records(response.projects)[0]).toMatchObject({
        status: "error",
        error: expect.stringContaining("root changed or escaped"),
        coverage: { state: "failed" },
      });
      expect(response.coverage).toMatchObject({ completedProjects: 0, failedProjects: 1, complete: false });
    } finally {
      if (linked) await fs.unlink(projectRoot);
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("routes qualified paths and handles to one project and rejects escaping request paths", async () => {
    const root = await makeWorkspace("codegraph-workspace-route-");
    try {
      await writeWorkspaceConfig(root, {
        projects: [
          { id: "app", path: "projects/app" },
          { id: "lib", path: "projects/lib" },
        ],
      });
      const config = await loadWorkspaceMcpConfig(root, "workspace.json");
      const qualifiedPath = qualifyWorkspaceValue("lib", "src/main.ts");
      const routed: Array<{ projectId: string; toolName: string; arguments_: Record<string, unknown> }> = [];
      await dispatchWorkspaceTool(
        config,
        "get_file",
        { file: qualifiedPath },
        async (project, toolName, arguments_) => {
          routed.push({ projectId: project.id, toolName, arguments_ });
          return { file: arguments_.file, freshness: { state: "fresh" } };
        },
      );
      await dispatchWorkspaceTool(
        config,
        "get_symbol",
        { handle: qualifyWorkspaceValue("lib", "symbol:src/main.ts:main:1:0") },
        async (project, toolName, arguments_) => {
          routed.push({ projectId: project.id, toolName, arguments_ });
          return { handle: arguments_.handle, freshness: { state: "fresh" } };
        },
      );
      await dispatchWorkspaceTool(
        config,
        "workspace_symbols",
        { query: "main", fileGlob: qualifyWorkspaceValue("lib", "src/**/*.ts") },
        async (project, toolName, arguments_) => {
          routed.push({ projectId: project.id, toolName, arguments_ });
          return { symbols: [], freshness: { state: "fresh" } };
        },
      );
      expect(routed).toEqual([
        { projectId: "lib", toolName: "get_file", arguments_: { file: "src/main.ts" } },
        { projectId: "lib", toolName: "get_symbol", arguments_: { handle: "symbol:src/main.ts:main:1:0" } },
        { projectId: "lib", toolName: "workspace_symbols", arguments_: { query: "main", fileGlob: "src/**/*.ts" } },
      ]);
      expect(parseWorkspaceQualifiedValue(qualifiedPath)).toEqual({ projectId: "lib", value: "src/main.ts" });
      const unusualIdValue = qualifyWorkspaceValue("app::service", "symbol:src/main.ts:main:1:0");
      expect(parseWorkspaceQualifiedValue(unusualIdValue)).toEqual({
        projectId: "app::service",
        value: "symbol:src/main.ts:main:1:0",
      });

      let called = false;
      const escaped = await dispatchWorkspaceTool(
        config,
        "get_file",
        { project: "app", file: "../../outside.ts" },
        async () => {
          called = true;
          return {};
        },
      );
      expect(called).toBe(false);
      expect(records(escaped.errors)).toMatchObject([
        { project: { id: "app" }, error: "Project path escapes the selected project root." },
      ]);
      let handleCalled = false;
      const escapedHandle = await dispatchWorkspaceTool(
        config,
        "get_symbol",
        { handle: qualifyWorkspaceValue("app", "symbol:%2E%2E%2F..%2Foutside.ts:secret:1:0") },
        async () => {
          handleCalled = true;
          return {};
        },
      );
      expect(handleCalled).toBe(false);
      expect(records(escapedHandle.errors)).toMatchObject([
        { project: { id: "app" }, error: "Project path escapes the selected project root." },
      ]);

      await expect(
        dispatchWorkspaceTool(
          config,
          "get_file",
          { project: "app", file: qualifyWorkspaceValue("lib", "src/main.ts") },
          async () => ({}),
        ),
      ).rejects.toThrow("does not match qualified value");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
