import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCliProgressHandler, runWithCliRuntime } from "../src/cli/context.js";
import { createCliProgressDisplay, resolveCliProgressPresentation } from "../src/cli/progress.js";
import { buildProjectIndex } from "../src/index.js";
import * as configModule from "../src/config.js";
import * as mcpServer from "../src/mcp/server.js";
import { captureCli } from "./helpers/cli.js";

describe("CLI index progress", () => {
  it.each([
    ["auto", true, true, "interactive"],
    ["auto", false, false, "off"],
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

  it("clears an active interactive display when the CLI runtime fails", async () => {
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

    expect(chunks.join("").endsWith("\r\u001b[2K")).toBe(true);
  });

  it("automatically reports a required build only on interactive stderr", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-progress-"));
    await fsp.writeFile(path.join(root, "main.ts"), "export const value = 1;\n", "utf8");

    try {
      const interactive = await captureCli(["orient", "--root", root, "--cache", "off", "--json"], {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
      });
      expect(() => JSON.parse(interactive.stdout)).not.toThrow();
      expect(interactive.stderr).toContain("Building project index");
      expect(interactive.stderr).toContain("Built project index");

      const redirected = await captureCli(["orient", "--root", root, "--cache", "off", "--json"]);
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

  it("waits for real index progress instead of speculative preparation", async () => {
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
      expect(result.stderr).toContain("Building project index");
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
      expect(interactive.stderr).toContain("Building project index");
      expect(interactive.stderr).toContain("Built project index");

      // The prior `interactive` call against this same root already wrote a manifest,
      // so this second index build reuses it via the incremental path (an "update" pass)
      // instead of rebuilding from scratch (a "build" pass). `--cache off` still forces
      // the one tracked file to be reprocessed, since disabled caching means no cached
      // parse result can be trusted as unchanged.
      const forced = await captureCli(["index", "--root", root, "--cache", "off", "--progress"], {
        progressPreparationDelayMs: 0,
      });
      expect(forced.stderr).not.toContain("Preparing project index");
      expect(forced.stderr).toContain("[Progress] Updating project index.");

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
      expect(graphFile.stderr).toContain("Updating project index");
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

      expect(lazy.stderr).not.toContain("project index");
      expect(baseWarmup.stderr).not.toContain("Preparing project index");
      expect(symbolWarmup.stderr).not.toContain("Preparing project index");
      expect(serveSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ root }));
      expect(serveSpy.mock.calls[0]?.[0].warmup).toBeUndefined();
      expect(serveSpy).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          root,
          warmup: "base",
          buildOptions: expect.objectContaining({ onProgress: expect.any(Function) }),
        }),
      );
      expect(serveSpy).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          root,
          warmup: "symbols",
          buildOptions: expect.objectContaining({ onProgress: expect.any(Function) }),
        }),
      );
    } finally {
      serveSpy.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps warm cache hits quiet for representative index-backed commands", async () => {
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
        expect(cached.stderr, command.join(" ")).not.toContain("Preparing project index");
        expect(cached.stderr, command.join(" ")).not.toContain("Updating project index");
        expect(cached.stderr, command.join(" ")).not.toContain("Building project index");
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a CLI cache hit quiet and reports a stale-index update", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-update-progress-"));
    const file = path.join(root, "main.ts");
    const command = ["inspect", "--root", root, "--cache", "disk"];
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");

    try {
      await buildProjectIndex(root, { cache: "disk" });

      // A warm cache hit should not emit progress until the indexer has real work to report.
      const cached = await captureCli(command, {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
        progressPreparationDelayMs: 2000,
      });
      expect(() => JSON.parse(cached.stdout)).not.toThrow();
      expect(cached.stderr).not.toContain("project index");

      await fsp.writeFile(file, "export const changedValue = 22;\n", "utf8");
      const stale = await captureCli(command, {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
      });
      expect(() => JSON.parse(stale.stdout)).not.toThrow();
      expect(stale.stderr).toContain("Updating project index");
      expect(stale.stderr).toContain("Updated project index");
      expect(stale.stderr).not.toContain("Building project index");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
