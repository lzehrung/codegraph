import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertFunnelResultV1 } from "../scripts/onboarding/funnel-contract-lib.mjs";
import { FUNNEL_EXPLORE_QUERY, runFunnelSmoke } from "../scripts/onboarding/run-funnel-smoke.mjs";
import { mkTmpDir } from "./helpers/filesystem.js";

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CommandOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
};

type CommandCall = {
  command: string;
  args: string[];
  options: CommandOptions;
};

async function createSourceCheckout(parent: string): Promise<string> {
  const root = path.join(parent, "source-checkout");
  await fsp.mkdir(path.join(root, "dist"), { recursive: true });
  await fsp.writeFile(path.join(root, "dist", "cli.js"), "export {};\n", "utf8");
  return root;
}

function successfulRunner(packageRoot: string, calls: CommandCall[]) {
  return async (command: string, args: string[], options: CommandOptions): Promise<CommandResult> => {
    calls.push({ command, args, options });
    const operation = args[1];
    if (operation === "version") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ name: "@lzehrung/codegraph", version: "9.8.7", packageRoot }),
        stderr: "",
      };
    }
    if (operation === "doctor") return { exitCode: 0, stdout: JSON.stringify({ schemaVersion: 1 }), stderr: "" };
    if (operation === "install") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          dryRun: true,
          installed: true,
          verified: false,
          changes: [{ action: "create", dryRun: true }],
        }),
        stderr: "",
      };
    }
    if (operation === "explore") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          query: FUNNEL_EXPLORE_QUERY,
          anchors: [{ file: "src/auth.ts" }],
        }),
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: `Unexpected command: ${command} ${args.join(" ")}` };
  };
}

describe("onboarding funnel smoke", () => {
  it("returns a stable successful FunnelResultV1 for a source checkout", async () => {
    const parent = await mkTmpDir("codegraph-funnel-schema-");
    const workspace = path.join(parent, "workspace");
    const sourceRoot = await createSourceCheckout(parent);
    const calls: CommandCall[] = [];
    try {
      const result = await runFunnelSmoke({
        channel: "source",
        root: sourceRoot,
        workspace,
        commandRunner: successfulRunner(sourceRoot, calls),
        mcpRunner: async () => ({ exitCode: 0 }),
      });

      expect(() => assertFunnelResultV1(result)).not.toThrow();
      expect(result).toMatchObject({
        schemaVersion: 1,
        scenario: "clean-home-source",
        channel: "source",
        status: "pass",
        version: "9.8.7",
      });
      expect(result.timings.steps.map((step: { name: string }) => step.name)).toContain("first-query");
      expect(result.timings.steps.map((step: { name: string }) => step.name)).toContain("warm-query");
      expect(result.timings.steps.map((step: { name: string }) => step.name)).toContain("mcp-handshake");
      expect(result.checks.every((check: { status: string }) => check.status === "pass")).toBe(true);
      expect(calls.map((call) => call.args[1])).toEqual(["version", "doctor", "install", "explore", "explore"]);
    } finally {
      await fsp.rm(parent, { recursive: true, force: true });
    }
  });

  it("isolates every command home, configuration, and cache path", async () => {
    const parent = await mkTmpDir("codegraph-funnel-isolation-");
    const workspace = path.join(parent, "workspace");
    const sourceRoot = await createSourceCheckout(parent);
    const calls: CommandCall[] = [];
    try {
      const result = await runFunnelSmoke({
        channel: "source",
        root: sourceRoot,
        workspace,
        baseEnv: { HOME: "C:/real-home", LOCALAPPDATA: "C:/real-cache", USERPROFILE: "C:/real-home" },
        commandRunner: successfulRunner(sourceRoot, calls),
        mcpRunner: async () => ({ exitCode: 0 }),
      });

      expect(result.status).toBe("pass");
      expect(calls.length).toBeGreaterThan(0);
      const options = calls[0].options;
      const env = options.env;
      expect(options.cwd).toBe(path.join(workspace, "runner"));
      expect(env?.HOME).toBe(path.join(workspace, "home"));
      expect(env?.USERPROFILE).toBe(path.join(workspace, "home"));
      expect(env?.XDG_CONFIG_HOME).toBe(path.join(workspace, "config"));
      expect(env?.XDG_CACHE_HOME).toBe(path.join(workspace, "cache"));
      expect(env?.LOCALAPPDATA).toBe(path.join(workspace, "local-app-data"));
      expect(env?.NPM_CONFIG_CACHE).toBe(path.join(workspace, "npm-cache"));
      expect(env?.NODE_COMPILE_CACHE).toBe(path.join(workspace, "node-compile-cache"));
      expect(env?.HOME).not.toBe("C:/real-home");
      await expect(fsp.readFile(path.join(workspace, "home", ".cursor", "mcp.json"), "utf8")).resolves.toBe(
        '{"mcpServers":{}}\n',
      );
    } finally {
      await fsp.rm(parent, { recursive: true, force: true });
    }
  });

  it("records a diagnostic and stable failure result when doctor fails", async () => {
    const parent = await mkTmpDir("codegraph-funnel-failure-");
    const workspace = path.join(parent, "workspace");
    const sourceRoot = await createSourceCheckout(parent);
    const calls: CommandCall[] = [];
    const runner = async (command: string, args: string[], options: CommandOptions): Promise<CommandResult> => {
      calls.push({ command, args, options });
      if (args[1] === "doctor") {
        return { exitCode: 23, stdout: "", stderr: "Bearer very-secret-token" };
      }
      return await successfulRunner(sourceRoot, [])(command, args, options);
    };
    try {
      const result = await runFunnelSmoke({ channel: "source", root: sourceRoot, workspace, commandRunner: runner });

      expect(() => assertFunnelResultV1(result)).not.toThrow();
      expect(result.status).toBe("fail");
      expect(result.checks).toContainEqual(expect.objectContaining({ name: "doctor", status: "fail", exitCode: 23 }));
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "doctor-command-failed",
          step: "doctor",
          exitCode: 23,
          stderr: "Bearer [REDACTED]",
        }),
      );
      expect(calls.map((call) => call.args[1])).toEqual(["version", "doctor"]);
    } finally {
      await fsp.rm(parent, { recursive: true, force: true });
    }
  });
});
