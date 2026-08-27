import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCliProgressHandler, runWithCliRuntime } from "../src/cli/context.js";
import { createCliProgressDisplay, resolveCliProgressPresentation } from "../src/cli/progress.js";
import { buildProjectIndex } from "../src/index.js";
import * as configModule from "../src/config.js";
import * as mcpServer from "../src/mcp/server.js";
import { normalizePath } from "../src/util/paths.js";
import { captureCli } from "./helpers/cli.js";
import { runGit } from "./helpers/git.js";

describe("CLI index progress", () => {
  it.each([
    ["auto", true, true, "interactive"],
    ["auto", false, false, "log"],
    ["always", true, true, "interactive"],
    ["always", false, false, "log"],
    ["never", true, true, "off"],
    ["auto", true, false, "log"],
  ] as const)("resolves %s policy for terminal capabilities", (policy, stderrIsTTY, controlSequences, expected) => {
    expect(
      resolveCliProgressPresentation({
        policy,
        stderrIsTTY,
        terminalSupportsControlSequences: controlSequences,
      }),
    ).toBe(expected);
  });

  it("delays automatic redirected progress and emits a heartbeat for slow index work", async () => {
    const chunks: string[] = [];
    vi.useFakeTimers();

    try {
      const display = createCliProgressDisplay({
        presentation: "log",
        write: (chunk) => chunks.push(chunk),
        delayMs: 1_000,
      });
      display.update({
        type: "progress",
        phase: "start",
        mode: "check",
        message: "Checking project index",
        current: 0,
        total: 10,
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(chunks).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_001);
      expect(chunks.join("")).toContain("[Progress] Checking project index.");
      expect(chunks.join("")).toContain("[Progress] Checking project index: 0/10 files.");

      display.update({
        type: "progress",
        phase: "complete",
        mode: "check",
        message: "Index checked",
        current: 10,
        total: 10,
        elapsedMs: 2_000,
      });
      expect(chunks.join("")).toContain("[Progress] Checked project index: 10 files in 2.0s.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders and completes an interactive build without writing file paths", () => {
    const chunks: string[] = [];
    const display = createCliProgressDisplay({ presentation: "interactive", write: (chunk) => chunks.push(chunk) });

    display.update({
      type: "progress",
      phase: "start",
      mode: "build",
      message: "Building project index",
      current: 0,
      total: 0,
    });
    display.update({
      type: "progress",
      phase: "update",
      mode: "build",
      message: "Indexed /private/project/secret.ts",
      current: 1,
      total: 2,
    });
    display.update({
      type: "progress",
      phase: "complete",
      mode: "build",
      message: "Index ready",
      current: 2,
      total: 2,
      elapsedMs: 1_250,
    });
    display.dispose();

    const output = chunks.join("");
    expect(output).toContain("Building project index");
    expect(output).toContain("Built project index: 2 files in 1.3s.");
    expect(output).not.toContain("secret.ts");
  });

  it("uses newline-delimited output without control sequences in log mode", () => {
    const chunks: string[] = [];
    const display = createCliProgressDisplay({ presentation: "log", write: (chunk) => chunks.push(chunk) });

    display.update({
      type: "progress",
      phase: "start",
      mode: "update",
      message: "Updating project index",
      current: 0,
      total: 1,
    });
    display.update({
      type: "progress",
      phase: "update",
      mode: "update",
      message: "Indexed main.ts",
      current: 1,
      total: 1,
    });
    display.update({
      type: "progress",
      phase: "complete",
      mode: "update",
      message: "Index ready",
      current: 3,
      total: 3,
      elapsedMs: 25,
    });

    const output = chunks.join("");
    expect(output).toContain("[Progress] Updating project index.\n");
    expect(output).toContain("[Progress] 1/1 files processed.\n");
    expect(output).toContain("[Progress] Updated project index: 3 files in 25ms.\n");
    expect(output).not.toContain("\u001b[");
    expect(output).not.toContain("\r");
  });

  it("renders truthful index-check progress for warm cache validation", () => {
    const chunks: string[] = [];
    const display = createCliProgressDisplay({ presentation: "log", write: (chunk) => chunks.push(chunk) });

    display.update({
      type: "progress",
      phase: "start",
      mode: "check",
      message: "Checking project index",
      current: 0,
      total: 0,
    });
    display.update({
      type: "progress",
      phase: "complete",
      mode: "check",
      message: "Checked project index",
      current: 2,
      total: 2,
      elapsedMs: 125,
    });

    expect(chunks.join("")).toBe(
      "[Progress] Checking project index.\n[Progress] Checked project index: 2 files in 125ms.\n",
    );
  });

  it("does not render delayed automatic progress when the CLI runtime fails quickly", async () => {
    const chunks: string[] = [];

    await expect(
      runWithCliRuntime(
        {
          stderr: (chunk) => chunks.push(chunk),
          stderrIsTTY: () => true,
          terminalSupportsControlSequences: () => true,
        },
        async () => {
          const progress = createCliProgressHandler("auto");
          if (!progress) throw new Error("Expected interactive progress");
          progress({
            type: "progress",
            phase: "start",
            mode: "build",
            message: "Building project index",
            current: 0,
            total: 1,
          });
          throw new Error("synthetic build failure");
        },
      ),
    ).rejects.toThrow("synthetic build failure");

    expect(chunks).toEqual([]);
  });

  it("keeps fast automatic redirected JSON commands quiet", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-progress-"));
    await fsp.writeFile(path.join(root, "main.ts"), "export const value = 1;\n", "utf8");

    try {
      const interactive = await captureCli(["orient", "--root", root, "--cache", "off", "--json"], {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
      });
      expect(() => JSON.parse(interactive.stdout)).not.toThrow();
      expect(interactive.stderr).toBe("");

      const redirected = await captureCli(["orient", "--root", root, "--cache", "off", "--json"]);
      expect(() => JSON.parse(redirected.stdout)).not.toThrow();
      expect(redirected.stderr).toBe("");

      const forced = await captureCli(["orient", "--root", root, "--cache", "off", "--json", "--progress"]);
      expect(forced.stderr).toContain("[Progress]");
      expect(forced.stderr).not.toContain("\u001b[");
      expect(() => JSON.parse(forced.stdout)).not.toThrow();
      expect(forced.stdout).not.toContain("[Progress]");

      const suppressed = await captureCli(["orient", "--root", root, "--cache", "off", "--json", "--no-progress"], {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
      });
      expect(suppressed.stderr).toBe("");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not claim index work while project config loading is delayed", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-config-progress-"));
    await fsp.writeFile(path.join(root, "main.ts"), "export const value = 1;\n", "utf8");
    const enteredConfigLoad = Promise.withResolvers<void>();
    const releaseConfigLoad = Promise.withResolvers<void>();
    const loadCodegraphConfig = configModule.loadCodegraphConfig;
    const configSpy = vi.spyOn(configModule, "loadCodegraphConfig").mockImplementation(async (projectRoot) => {
      enteredConfigLoad.resolve();
      await releaseConfigLoad.promise;
      return await loadCodegraphConfig(projectRoot);
    });
    let liveStderr = "";
    vi.useFakeTimers();

    try {
      const resultPromise = captureCli(["index", "--root", root, "--cache", "off"], {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
        onStderr: (chunk) => {
          liveStderr += chunk;
        },
      });
      await enteredConfigLoad.promise;
      await vi.advanceTimersByTimeAsync(100);
      expect(liveStderr).not.toContain("Preparing project index");
      expect(liveStderr).not.toContain("Building project index");

      vi.useRealTimers();
      releaseConfigLoad.resolve();
      const result = await resultPromise;
      expect(result.stderr).toBe("");
    } finally {
      releaseConfigLoad.resolve();
      vi.useRealTimers();
      configSpy.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reports real index work and honors progress policy", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-real-progress-"));
    await fsp.writeFile(path.join(root, "main.ts"), "export const value = 1;\n", "utf8");

    try {
      const interactive = await captureCli(["index", "--root", root, "--cache", "off"], {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
        progressPreparationDelayMs: 0,
      });
      expect(interactive.stderr).not.toContain("Preparing project index");
      expect(interactive.stderr).toBe("");

      // Cache-off builds are hermetic: the prior call did not persist a manifest,
      // so every invocation reports a fresh build.
      const forced = await captureCli(["index", "--root", root, "--cache", "off", "--progress"], {
        progressPreparationDelayMs: 0,
      });
      expect(forced.stderr).not.toContain("Preparing project index");
      expect(forced.stderr).toContain("[Progress] Building project index.");

      const suppressed = await captureCli(["index", "--root", root, "--cache", "off", "--no-progress"], {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
        progressPreparationDelayMs: 0,
      });
      expect(suppressed.stderr).toBe("");

      const directGraph = await captureCli(["graph", "--root", root, "--json"], {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
        progressPreparationDelayMs: 0,
      });
      expect(directGraph.stderr).not.toContain("project index");
      expect(() => JSON.parse(directGraph.stdout)).not.toThrow();

      const plainFile = await captureCli(["file", "main.ts", "--root", root, "--json"], {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
        progressPreparationDelayMs: 0,
      });
      expect(plainFile.stderr).not.toContain("project index");
      expect(() => JSON.parse(plainFile.stdout)).not.toThrow();

      const graphFile = await captureCli(
        ["file", "main.ts", "--root", root, "--json", "--include-graph-context", "--cache", "off"],
        {
          stderrIsTTY: true,
          terminalSupportsControlSequences: true,
          progressPreparationDelayMs: 0,
        },
      );
      expect(graphFile.stderr).not.toContain("Preparing project index");
      expect(graphFile.stderr).not.toContain("project index");
      expect(() => JSON.parse(graphFile.stdout)).not.toThrow();

      const pathSearch = await captureCli(["search", "main", "--root", root, "--mode", "path", "--json"], {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
        progressPreparationDelayMs: 0,
      });
      expect(pathSearch.stderr).not.toContain("project index");
      expect(() => JSON.parse(pathSearch.stdout)).not.toThrow();

      const textSearch = await captureCli(["search", "value", "--root", root, "--mode", "text", "--json"], {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
        progressPreparationDelayMs: 0,
      });
      expect(textSearch.stderr).not.toContain("Preparing project index");
      expect(() => JSON.parse(textSearch.stdout)).not.toThrow();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps MCP startup quiet unless warmup performs real index work", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-mcp-preparation-"));
    const serveSpy = vi.spyOn(mcpServer, "serveCodegraphMcp").mockResolvedValue();

    try {
      const captureOptions = {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
        progressPreparationDelayMs: 0,
      };
      const lazy = await captureCli(["mcp", "serve", "--root", root], captureOptions);
      const baseWarmup = await captureCli(["mcp", "serve", "--root", root, "--warmup"], captureOptions);
      const symbolWarmup = await captureCli(["mcp", "serve", "--root", root, "--warmup-symbols"], captureOptions);
      const normalizedRoot = normalizePath(root);
      const expectedBuildOptions = expect.objectContaining({
        discovery: {},
        onProgress: expect.any(Function),
      });

      expect(lazy.stderr).not.toContain("project index");
      expect(baseWarmup.stderr).not.toContain("Preparing project index");
      expect(symbolWarmup.stderr).not.toContain("Preparing project index");
      expect(serveSpy).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ root: normalizedRoot, buildOptions: expectedBuildOptions }),
      );
      expect(serveSpy.mock.calls[0]?.[0].warmup).toBeUndefined();
      expect(serveSpy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          root: normalizedRoot,
          warmup: "base",
          buildOptions: expectedBuildOptions,
        }),
      );
      expect(serveSpy).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          root: normalizedRoot,
          warmup: "symbols",
          buildOptions: expectedBuildOptions,
        }),
      );
    } finally {
      serveSpy.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reports index checks without build/update progress for representative warm cache hits", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-warm-progress-"));
    const file = path.join(root, "main.ts");
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");

    try {
      await captureCli(["orient", "--root", root, "--cache", "disk", "--json"], {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
      });

      const commands = [
        ["orient", "--root", root, "--cache", "disk", "--json", "--progress"],
        ["inspect", "--root", root, "--cache", "disk", "--json", "--progress"],
        ["search", "value", "--root", root, "--cache", "disk", "--mode", "text", "--json", "--progress"],
        ["symbols", "value", "--root", root, "--cache", "disk", "--json", "--progress"],
      ];

      for (const command of commands) {
        const cached = await captureCli(command, { progressPreparationDelayMs: 0 });
        expect(() => JSON.parse(cached.stdout)).not.toThrow();
        expect(cached.stderr, command.join(" ")).toContain("Checking project index");
        expect(cached.stderr, command.join(" ")).toContain("Checked project index");
        expect(cached.stderr, command.join(" ")).not.toContain("Preparing project index");
        expect(cached.stderr, command.join(" ")).not.toContain("Updating project index");
        expect(cached.stderr, command.join(" ")).not.toContain("Building project index");
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["inspect", "hotspots"] as const)(
    "%s reuses a Git-backed child-root snapshot across unchanged and native-runtime checks",
    async (command) => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), `codegraph-cli-${command}-child-snapshot-`));
      const srcDir = path.join(root, "src");
      const sourceFile = path.join(srcDir, "a.ts");
      await fsp.mkdir(srcDir, { recursive: true });
      await fsp.writeFile(sourceFile, "import { b } from './b';\nexport const a = b;\n", "utf8");
      await fsp.writeFile(path.join(srcDir, "b.ts"), "export const b = 1;\n", "utf8");
      await fsp.writeFile(
        path.join(root, "outside.ts"),
        "import { a } from './src/a';\nexport const outside = a;\n",
        "utf8",
      );
      runGit(root, ["init"]);
      runGit(root, ["add", "."]);
      runGit(root, ["commit", "-m", "initial"]);

      const commandArgs = (cache: "off" | "disk", progress: boolean, nativeMode?: "off"): string[] => {
        const args = [command, "--root", root, srcDir, "--limit", "10", "--cache", cache, "--json"];
        if (progress) args.push("--progress");
        if (nativeMode) args.push("--native", nativeMode);
        return args;
      };
      const readScopedResult = (stdout: string): unknown => {
        if (command === "hotspots") {
          return JSON.parse(stdout) as Array<{ file: string; fanIn: number; fanOut: number; score: number }>;
        }
        const report = JSON.parse(stdout) as {
          files: { total: number; byLanguage: Record<string, number> };
          hotspots: Array<{ file: string; fanIn: number; fanOut: number; score: number }>;
          unresolved: { total: number; top: Array<{ name: string; importerCount: number }> };
          cycles: { total: number; top: Array<{ files: string[]; priorityScore: number; size: number }> };
        };
        return {
          files: report.files,
          hotspots: report.hotspots,
          unresolved: report.unresolved,
          cycles: report.cycles,
        };
      };
      const expectSnapshotOnlyProgress = (stderr: string): void => {
        expect(stderr).toContain("Checking project index");
        expect(stderr).toContain("Checked project index");
        expect(stderr).not.toContain("files processed");
        expect(stderr).not.toContain("Updating project index");
        expect(stderr).not.toContain("Building project index");
      };

      try {
        await buildProjectIndex(root, { cache: "disk" });
        const cold = await captureCli(commandArgs("off", false));
        await buildProjectIndex(root, { cache: "disk" });

        const firstWarm = await captureCli(commandArgs("disk", true), { progressPreparationDelayMs: 0 });
        const secondWarm = await captureCli(commandArgs("disk", true), { progressPreparationDelayMs: 0 });
        expectSnapshotOnlyProgress(firstWarm.stderr);
        expectSnapshotOnlyProgress(secondWarm.stderr);

        const coldScoped = readScopedResult(cold.stdout);
        const warmScoped = readScopedResult(firstWarm.stdout);
        expect(warmScoped).toEqual(coldScoped);
        expect(readScopedResult(secondWarm.stdout)).toEqual(warmScoped);
        const manifestPath = path.join(root, ".codegraph-cache", "index-v1", "manifest.json");
        const legacyManifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as {
          buildOptions?: { nativeRuntimeFingerprint?: string };
        };
        if (!legacyManifest.buildOptions) throw new Error("Expected persisted build options");
        delete legacyManifest.buildOptions.nativeRuntimeFingerprint;
        await fsp.writeFile(manifestPath, JSON.stringify(legacyManifest), "utf8");
        const migrated = await captureCli(commandArgs("disk", true), { progressPreparationDelayMs: 0 });
        expect(migrated.stderr).toContain("Building project index");
        expect(migrated.stderr).toContain("Built project index");
        expect(readScopedResult(migrated.stdout)).toEqual(warmScoped);

        const switched = await captureCli(commandArgs("disk", true, "off"), { progressPreparationDelayMs: 0 });
        expect(switched.stderr).toContain("Building project index");
        expect(switched.stderr).toContain("Built project index");
        const switchedScoped = readScopedResult(switched.stdout);
        const nativeOffCold = await captureCli(commandArgs("off", false, "off"));
        expect(switchedScoped).toEqual(readScopedResult(nativeOffCold.stdout));
        await buildProjectIndex(root, { cache: "disk", native: "off" });
        const secondNativeOff = await captureCli(commandArgs("disk", true, "off"), { progressPreparationDelayMs: 0 });
        expectSnapshotOnlyProgress(secondNativeOff.stderr);
        expect(readScopedResult(secondNativeOff.stdout)).toEqual(switchedScoped);

        await fsp.writeFile(sourceFile, "export const a = 2;\n", "utf8");
        const stale = await captureCli(commandArgs("disk", true, "off"), { progressPreparationDelayMs: 0 });
        expect(stale.stderr).toContain("Updating project index");
        expect(stale.stderr).toContain("Updated project index");
        const staleScoped = readScopedResult(stale.stdout);
        expect(staleScoped).not.toEqual(switchedScoped);

        const changedCold = await captureCli(commandArgs("off", false, "off"));
        expect(staleScoped).toEqual(readScopedResult(changedCold.stdout));
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("reports a warm cache check and a stale-index update", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-update-progress-"));
    const file = path.join(root, "main.ts");
    const command = ["inspect", "--root", root, "--cache", "disk", "--json"];
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");

    try {
      await buildProjectIndex(root, { cache: "disk" });

      // A warm cache hit reports cache validation without claiming build/update work.
      const cached = await captureCli(command, {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
        progressPreparationDelayMs: 2000,
      });
      expect(() => JSON.parse(cached.stdout)).not.toThrow();
      expect(cached.stderr).not.toContain("Checking project index");
      expect(cached.stderr).not.toContain("Checked project index");
      expect(cached.stderr).not.toContain("Building project index");
      expect(cached.stderr).not.toContain("Updating project index");

      await fsp.writeFile(file, "export const changedValue = 22;\n", "utf8");
      const stale = await captureCli(command, {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
      });
      expect(() => JSON.parse(stale.stdout)).not.toThrow();
      expect(stale.stderr).not.toContain("Updating project index");
      expect(stale.stderr).not.toContain("Updated project index");
      expect(stale.stderr).not.toContain("Building project index");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
