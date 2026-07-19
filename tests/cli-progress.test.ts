import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCliProgressHandler, runWithCliRuntime } from "../src/cli/context.js";
import { createCliProgressDisplay, resolveCliProgressPresentation } from "../src/cli/progress.js";
import { buildProjectIndex } from "../src/index.js";
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

  it("keeps a CLI cache hit quiet and reports a stale-index update", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-update-progress-"));
    const file = path.join(root, "main.ts");
    const command = ["inspect", "--root", root, "--cache", "disk"];
    await fsp.writeFile(file, "export const value = 1;\n", "utf8");

    try {
      await buildProjectIndex(root, { cache: "disk" });

      const cached = await captureCli(command, {
        stderrIsTTY: true,
        terminalSupportsControlSequences: true,
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
