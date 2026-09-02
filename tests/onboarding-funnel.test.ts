import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeCandidateFile } from "../scripts/certification/package-contract-lib.mjs";
import { currentNativeTargetSuffix } from "../scripts/certification/package-smoke-lib.mjs";
import { assertFunnelResultV1, currentFunnelTarget } from "../scripts/onboarding/funnel-contract-lib.mjs";
import {
  assertMcpSearchToolResult,
  FUNNEL_DOCTOR_INSTALL_BUDGET_MS,
  FUNNEL_EXPLORE_QUERY,
  FUNNEL_PACKAGE_SETUP_TIMEOUT_MS,
  runFunnelSmoke,
} from "../scripts/onboarding/run-funnel-smoke.mjs";
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

type McpInvocation = {
  args: string[];
  command: string;
  env: Record<string, string | undefined>;
  fixtureDirectory: string;
  rootVersion: string;
  timeoutMs: number;
};

type RunnerBehavior = {
  corruptUnrelatedConfigOnApply?: boolean;
  doctorOrigin?: Record<string, unknown>;
};

type ReleaseCandidate = {
  manifestPath: string;
  paths: string[];
};

type CandidateInput = {
  contents: string;
  file: string;
  package: string;
  target?: string;
};

type StandaloneFixture = {
  archiveEntries: string[];
  archivePath: string;
  bundleRoot: string;
  target: string;
};

async function createSourceCheckout(parent: string): Promise<string> {
  const root = path.join(parent, "source-checkout");
  await fsp.mkdir(path.join(root, "dist"), { recursive: true });
  await fsp.writeFile(path.join(root, "dist", "cli.js"), "export {};\n", "utf8");
  return root;
}

function requiredNativeTarget(): string {
  const target = currentNativeTargetSuffix();
  if (!target) throw new Error("Current host has no supported native target.");
  return target;
}

function defaultDoctorOrigin(): Record<string, unknown> {
  return {
    mode: "workspace",
    packageName: "@lzehrung/codegraph-native",
    target: requiredNativeTarget(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(content: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error("Expected JSON object.");
  return parsed;
}

function cursorConfigPath(options: CommandOptions): string {
  const home = options.env?.HOME;
  if (typeof home !== "string" || !home) throw new Error("Expected isolated HOME.");
  return path.join(home, ".cursor", "mcp.json");
}

function cursorInstallChanges(options: CommandOptions, dryRun: boolean) {
  const configPath = cursorConfigPath(options);
  const skillRoot = path.join(path.dirname(configPath), "skills", "codegraph");
  return [
    { action: "create", dryRun, path: path.join(skillRoot, "SKILL.md"), target: "cursor" },
    { action: "create", dryRun, path: path.join(skillRoot, "CODEGRAPH_INSTALLED"), target: "cursor" },
    { action: "update", dryRun, path: configPath, target: "cursor" },
  ];
}

function cursorUninstallChanges(options: CommandOptions) {
  const configPath = cursorConfigPath(options);
  const skillRoot = path.join(path.dirname(configPath), "skills", "codegraph");
  return [
    { action: "delete", dryRun: false, path: path.join(skillRoot, "SKILL.md"), target: "cursor" },
    { action: "delete", dryRun: false, path: path.join(skillRoot, "CODEGRAPH_INSTALLED"), target: "cursor" },
    { action: "update", dryRun: false, path: configPath, target: "cursor" },
  ];
}

async function applyCursorConfig(options: CommandOptions, behavior: RunnerBehavior): Promise<void> {
  const configPath = cursorConfigPath(options);
  const config = parseJsonObject(await fsp.readFile(configPath, "utf8"));
  const servers = config.mcpServers;
  if (!isRecord(servers)) throw new Error("Expected mcpServers.");
  servers.codegraph = {
    args: ["mcp", "serve", "--root", ".", "--stdio"],
    command: "codegraph",
    type: "stdio",
  };
  if (behavior.corruptUnrelatedConfigOnApply) config.cursorSettings = { theme: "changed" };
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function removeCursorConfig(options: CommandOptions): Promise<void> {
  const configPath = cursorConfigPath(options);
  const config = parseJsonObject(await fsp.readFile(configPath, "utf8"));
  if (isRecord(config.mcpServers)) delete config.mcpServers.codegraph;
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function successfulRunner(packageRoot: string, calls: CommandCall[], behavior: RunnerBehavior = {}) {
  return async (command: string, args: string[], options: CommandOptions): Promise<CommandResult> => {
    calls.push({ command, args, options });
    if (command === "npm") {
      const prefixIndex = args.indexOf("--prefix");
      const prefix = args[prefixIndex + 1];
      if (!prefix) throw new Error("Expected npm --prefix.");
      const installedCliPath = path.join(prefix, "node_modules", "@lzehrung", "codegraph", "dist", "bin", "cli.js");
      const launcherPath = path.join(
        prefix,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "codegraph.cmd" : "codegraph",
      );
      await fsp.mkdir(path.dirname(installedCliPath), { recursive: true });
      await fsp.mkdir(path.dirname(launcherPath), { recursive: true });
      await fsp.writeFile(installedCliPath, "export {};\n", "utf8");
      await fsp.writeFile(launcherPath, "launcher\n", "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    const operation = args[1];
    if (operation === "version") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ name: "@lzehrung/codegraph", version: "9.8.7", packageRoot }),
        stderr: "",
      };
    }
    if (operation === "doctor") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          native: { available: true, origin: behavior.doctorOrigin ?? defaultDoctorOrigin() },
        }),
        stderr: "",
      };
    }
    if (operation === "install") {
      if (args.includes("--yes")) {
        await applyCursorConfig(options, behavior);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            changes: cursorInstallChanges(options, false),
            dryRun: false,
            installed: true,
            targets: ["cursor"],
            verified: true,
          }),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          changes: cursorInstallChanges(options, true),
          dryRun: true,
          installed: true,
          targets: ["cursor"],
          verified: false,
        }),
        stderr: "",
      };
    }
    if (operation === "uninstall") {
      await removeCursorConfig(options);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          changes: cursorUninstallChanges(options),
          dryRun: false,
          targets: ["cursor"],
          uninstalled: true,
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
          anchors: [{ file: "src/auth.ts" }, { file: "src/storage.ts" }],
          paths: [{ from: "src/auth.ts", to: "src/storage.ts", path: ["src/auth.ts", "src/storage.ts"] }],
          followUps: [{ tool: "get_file", arguments: { file: "src/auth.ts" } }],
        }),
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: `Unexpected command: ${command} ${args.join(" ")}` };
  };
}

async function createReleaseCandidate(parent: string): Promise<ReleaseCandidate> {
  const nativeTarget = currentNativeTargetSuffix();
  if (!nativeTarget) throw new Error("Current host has no supported native target.");
  const candidateDirectory = path.join(parent, "release-candidates");
  const candidates: CandidateInput[] = [
    { contents: "root", file: "packages/root.tgz", package: "@lzehrung/codegraph" },
    { contents: "core", file: "packages/core.tgz", package: "@lzehrung/codegraph-core" },
    { contents: "native-meta", file: "packages/native-meta.tgz", package: "@lzehrung/codegraph-native" },
    {
      contents: "native-target",
      file: "packages/native-target.tgz",
      package: `@lzehrung/codegraph-native-${nativeTarget}`,
      target: nativeTarget,
    },
  ];
  const files: Array<{ file: string; package: string; sha256: string; size: number; target?: string }> = [];
  for (const candidate of candidates) {
    const candidatePath = path.join(candidateDirectory, candidate.file);
    await fsp.mkdir(path.dirname(candidatePath), { recursive: true });
    await fsp.writeFile(candidatePath, candidate.contents, "utf8");
    const description = await describeCandidateFile(candidatePath);
    const entry = {
      file: candidate.file,
      package: candidate.package,
      sha256: description.sha256,
      size: description.size,
    };
    if (candidate.target) files.push({ ...entry, target: candidate.target });
    else files.push(entry);
  }
  const manifestPath = path.join(candidateDirectory, "release-candidate-manifest.json");
  await fsp.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        files,
        nativeVersion: "9.8.7",
        rootVersion: "9.8.7",
        schemaVersion: 1,
        sourceRevision: "a".repeat(40),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return {
    manifestPath,
    paths: candidates.map((candidate) => path.join(candidateDirectory, candidate.file)),
  };
}

async function standaloneFileRecord(root: string, relativePath: string) {
  const content = await fsp.readFile(path.join(root, relativePath));
  return {
    path: relativePath.replaceAll("\\", "/"),
    sha256: createHash("sha256").update(content).digest("hex"),
    size: content.byteLength,
  };
}

async function createStandaloneFixture(parent: string): Promise<StandaloneFixture> {
  const target = currentFunnelTarget();
  const nativeTarget = requiredNativeTarget();
  const bundleName = `codegraph-${target}`;
  const bundleRoot = path.join(parent, bundleName);
  const nodeName = target.startsWith("win32-") ? "node.exe" : "node";
  const nativePackage = `@lzehrung/codegraph-native-${nativeTarget}`;
  const nativePackageJson = path.join(
    bundleRoot,
    "node_modules",
    "@lzehrung",
    `codegraph-native-${nativeTarget}`,
    "package.json",
  );
  await fsp.mkdir(path.dirname(nativePackageJson), { recursive: true });
  await fsp.mkdir(path.join(bundleRoot, "dist"), { recursive: true });
  await fsp.copyFile(process.execPath, path.join(bundleRoot, nodeName));
  if (process.platform !== "win32") await fsp.chmod(path.join(bundleRoot, nodeName), 0o755);
  await fsp.writeFile(
    path.join(bundleRoot, "dist", "cli.js"),
    [
      "const command = process.argv[2];",
      'const report = { name: "@lzehrung/codegraph", version: "9.8.7", packageRoot: process.cwd() };',
      `const origin = { packageName: ${JSON.stringify(nativePackage)}, packageVersion: "9.8.7", target: ${JSON.stringify(nativeTarget)} };`,
      'if (command === "version") process.stdout.write(`${JSON.stringify(report)}\\n`);',
      'else if (command === "doctor") process.stdout.write(`${JSON.stringify({ package: report, native: { available: true, origin } })}\\n`);',
      "else process.exitCode = 1;",
      "",
    ].join("\n"),
    "utf8",
  );
  await fsp.writeFile(
    nativePackageJson,
    `${JSON.stringify({ name: nativePackage, version: "9.8.7" }, null, 2)}\n`,
    "utf8",
  );
  const files = await Promise.all(
    [
      nodeName,
      "dist/cli.js",
      path.join("node_modules", "@lzehrung", `codegraph-native-${nativeTarget}`, "package.json"),
    ].map(async (relativePath) => await standaloneFileRecord(bundleRoot, relativePath)),
  );
  await fsp.writeFile(
    path.join(bundleRoot, "manifest.json"),
    `${JSON.stringify(
      {
        channel: "standalone-preview",
        files,
        nativeSuffix: nativeTarget,
        nodeVersion: process.version,
        schemaVersion: 1,
        sourceRevision: null,
        target,
        version: "9.8.7",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const archivePath = path.join(parent, `${bundleName}.tar.gz`);
  await fsp.writeFile(archivePath, "fixture archive", "utf8");
  return {
    archiveEntries: [
      `${bundleName}/${nodeName}`,
      `${bundleName}/dist/cli.js`,
      `${bundleName}/node_modules/@lzehrung/codegraph-native-${nativeTarget}/package.json`,
      `${bundleName}/manifest.json`,
    ],
    archivePath,
    bundleRoot,
    target,
  };
}

function standaloneArchiveRunner(
  fixture: StandaloneFixture,
  packageRoot: string,
  calls: CommandCall[],
  behavior: RunnerBehavior,
) {
  const delegate = successfulRunner(packageRoot, calls, behavior);
  return async (command: string, args: string[], options: CommandOptions): Promise<CommandResult> => {
    if (command === "tar") {
      calls.push({ command, args, options });
      const operation = args[0] === "--force-local" ? args[1] : args[0];
      if (operation === "-tzf") return { exitCode: 0, stderr: "", stdout: `${fixture.archiveEntries.join("\n")}\n` };
      const destinationIndex = args.indexOf("-C");
      const destination = args[destinationIndex + 1];
      if (operation !== "-xzf" || !destination) throw new Error("Expected standalone archive extraction.");
      await fsp.cp(fixture.bundleRoot, path.join(destination, path.basename(fixture.bundleRoot)), { recursive: true });
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    return await delegate(command, args, options);
  };
}

describe("onboarding funnel smoke", () => {
  it("applies and removes only isolated Cursor state, then invokes the configured MCP entry", async () => {
    const parent = await mkTmpDir("codegraph-funnel-schema-");
    const workspace = path.join(parent, "workspace");
    const sourceRoot = await createSourceCheckout(parent);
    const calls: CommandCall[] = [];
    const mcpCalls: McpInvocation[] = [];
    try {
      const result = await runFunnelSmoke({
        channel: "source",
        root: sourceRoot,
        workspace,
        commandRunner: successfulRunner(sourceRoot, calls),
        mcpRunner: async (entry: McpInvocation) => {
          mcpCalls.push(entry);
          return { exitCode: 0 };
        },
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
      expect(result.timings.steps.map((step: { name: string }) => step.name)).toContain("uninstall");
      expect(result.checks.every((check: { status: string }) => check.status === "pass")).toBe(true);
      expect(calls.map((call) => call.args[1])).toEqual([
        "version",
        "doctor",
        "install",
        "install",
        "explore",
        "explore",
        "uninstall",
      ]);
      expect(calls.find((call) => call.args[1] === "explore")?.args[2]).toBe(
        "where does authentication reach storage?",
      );
      expect(mcpCalls).toEqual([
        expect.objectContaining({
          args: ["mcp", "serve", "--root", ".", "--stdio"],
          command: "codegraph",
          rootVersion: "9.8.7",
        }),
      ]);
      const sourceLauncher = path.join(
        workspace,
        "runner",
        process.platform === "win32" ? "codegraph.cmd" : "codegraph",
      );
      expect((await fsp.stat(sourceLauncher)).isFile()).toBe(true);
      expect(mcpCalls[0]?.env.PATH?.split(path.delimiter)[0]).toBe(path.join(workspace, "runner"));
      await expect(fsp.readFile(path.join(workspace, "home", ".cursor", "mcp.json"), "utf8")).resolves.toBe(
        `${JSON.stringify(
          {
            cursorSettings: { theme: "retain" },
            mcpServers: {
              unrelated: { args: ["--stdio"], command: "unrelated-mcp" },
            },
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await fsp.rm(parent, { recursive: true, force: true });
    }
  });

  it("selects package-native identity and runs the npm-created launcher", async () => {
    const parent = await mkTmpDir("codegraph-funnel-package-");
    const workspace = path.join(parent, "workspace");
    const nativeTarget = requiredNativeTarget();
    const candidates = await createReleaseCandidate(parent);
    const packageRoot = path.join(workspace, "npm-prefix", "node_modules", "@lzehrung", "codegraph");
    const calls: CommandCall[] = [];
    const mcpCalls: McpInvocation[] = [];
    try {
      const result = await runFunnelSmoke({
        artifact: candidates.manifestPath,
        channel: "package",
        workspace,
        commandRunner: successfulRunner(packageRoot, calls, {
          doctorOrigin: {
            packageName: `@lzehrung/codegraph-native-${nativeTarget}`,
            packageVersion: "9.8.7",
            target: nativeTarget,
          },
        }),
        mcpRunner: async (entry: McpInvocation) => {
          mcpCalls.push(entry);
          return { exitCode: 0 };
        },
      });

      expect(result.status).toBe("pass");
      const npmInstall = calls.find((call) => call.command === "npm");
      expect(npmInstall).toBeDefined();
      const byFileName = new Map(
        candidates.paths.map((candidatePath) => [path.basename(candidatePath), candidatePath]),
      );
      const funnelTarget = currentFunnelTarget();
      const [os, cpu] = funnelTarget.split("-");
      const cwd = path.join(workspace, "runner");
      const tarballArgs = [
        "../package-candidates/core.tgz",
        "../package-candidates/root.tgz",
        "../package-candidates/native-meta.tgz",
        "../package-candidates/native-target.tgz",
      ];
      expect(npmInstall?.options.cwd).toBe(cwd);
      expect(npmInstall?.args).toEqual([
        "install",
        "--ignore-scripts",
        "--package-lock=false",
        "--no-audit",
        "--prefer-offline",
        "--no-fund",
        "--no-save",
        "--prefix",
        path.join(workspace, "npm-prefix"),
        `--os=${os}`,
        `--cpu=${cpu}`,
        ...tarballArgs,
      ]);
      for (const spec of tarballArgs) {
        const original = byFileName.get(path.basename(spec));
        expect(original).toBeDefined();
        expect((await fsp.stat(path.resolve(cwd, spec))).isFile()).toBe(true);
        expect(await fsp.readFile(path.resolve(cwd, spec), "utf8")).toBe(await fsp.readFile(original ?? "", "utf8"));
      }
      expect(npmInstall?.options.timeoutMs).toBe(FUNNEL_PACKAGE_SETUP_TIMEOUT_MS);
      expect(result.checks).toContainEqual(expect.objectContaining({ name: "package-candidate", status: "pass" }));
      const packageLauncher = path.join(
        workspace,
        "npm-prefix",
        "node_modules",
        ".bin",
        process.platform === "win32" ? "codegraph.cmd" : "codegraph",
      );
      expect((await fsp.stat(packageLauncher)).isFile()).toBe(true);
      expect(mcpCalls[0]).toEqual(expect.objectContaining({ command: "codegraph" }));
      expect(mcpCalls[0]?.env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(packageLauncher));
    } finally {
      await fsp.rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects a package doctor origin that does not match the selected native candidate", async () => {
    const parent = await mkTmpDir("codegraph-funnel-native-origin-");
    const workspace = path.join(parent, "workspace");
    const nativeTarget = requiredNativeTarget();
    const candidates = await createReleaseCandidate(parent);
    const packageRoot = path.join(workspace, "npm-prefix", "node_modules", "@lzehrung", "codegraph");
    try {
      const result = await runFunnelSmoke({
        artifact: candidates.manifestPath,
        channel: "package",
        workspace,
        commandRunner: successfulRunner(packageRoot, [], {
          doctorOrigin: {
            packageName: "@lzehrung/codegraph-native-wrong",
            packageVersion: "9.8.7",
            target: nativeTarget,
          },
        }),
      });

      expect(result.status).toBe("fail");
      expect(result.checks).toContainEqual(expect.objectContaining({ name: "doctor-native", status: "fail" }));
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "doctor-native-origin-invalid",
          step: "doctor-native",
        }),
      );
    } finally {
      await fsp.rm(parent, { recursive: true, force: true });
    }
  });

  it("runs the standalone installer launcher and binds installed native package metadata", async () => {
    const parent = await mkTmpDir("codegraph-funnel-standalone-");
    const workspace = path.join(parent, "workspace");
    const fixture = await createStandaloneFixture(parent);
    const nativeTarget = requiredNativeTarget();
    const packageRoot = path.join(workspace, "standalone-install", "9.8.7");
    const calls: CommandCall[] = [];
    const mcpCalls: McpInvocation[] = [];
    try {
      const result = await runFunnelSmoke({
        artifact: fixture.archivePath,
        channel: "standalone",
        target: fixture.target,
        workspace,
        commandRunner: standaloneArchiveRunner(fixture, packageRoot, calls, {
          doctorOrigin: {
            packageName: `@lzehrung/codegraph-native-${nativeTarget}`,
            packageVersion: "9.8.7",
            target: nativeTarget,
          },
        }),
        mcpRunner: async (entry: McpInvocation) => {
          mcpCalls.push(entry);
          return { exitCode: 0 };
        },
      });

      expect(result.status).toBe("pass");
      const tarCalls = calls.filter((call) => call.command === "tar");
      expect(tarCalls.length).toBeGreaterThan(0);
      if (process.platform === "win32") {
        for (const call of tarCalls) expect(call.args[0]).toBe("--force-local");
      } else {
        for (const call of tarCalls) expect(call.args[0]).not.toBe("--force-local");
      }
      const standaloneLauncher = path.join(
        workspace,
        "standalone-bin",
        fixture.target.startsWith("win32-") ? "codegraph.cmd" : "codegraph",
      );
      expect((await fsp.stat(standaloneLauncher)).isFile()).toBe(true);
      expect(mcpCalls[0]).toEqual(expect.objectContaining({ command: "codegraph" }));
      expect(mcpCalls[0]?.env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(standaloneLauncher));
      expect(calls.map((call) => call.command)).toContain("tar");
    } finally {
      await fsp.rm(parent, { recursive: true, force: true });
    }
  });
  it("rejects a top-level MCP query string when text JSON results are empty", () => {
    expect(() =>
      assertMcpSearchToolResult({
        content: [{ text: JSON.stringify({ results: [{ label: "CertifiedPackageSymbol" }] }), type: "text" }],
      }),
    ).not.toThrow();
    expect(() =>
      assertMcpSearchToolResult({
        content: [{ text: JSON.stringify({ query: "CertifiedPackageSymbol", results: [] }), type: "text" }],
      }),
    ).toThrow("nonempty text JSON results entry");
  });

  it("fails the FunnelResult when doctor exceeds its documented duration budget", async () => {
    const parent = await mkTmpDir("codegraph-funnel-doctor-budget-");
    const workspace = path.join(parent, "workspace");
    const sourceRoot = await createSourceCheckout(parent);
    let now = 0;
    const runner = successfulRunner(sourceRoot, []);
    try {
      const result = await runFunnelSmoke({
        channel: "source",
        root: sourceRoot,
        workspace,
        now: () => now,
        commandRunner: async (command: string, args: string[], options: CommandOptions) => {
          if (args[1] === "doctor") now = FUNNEL_DOCTOR_INSTALL_BUDGET_MS + 1;
          return await runner(command, args, options);
        },
      });

      expect(result.status).toBe("fail");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "doctor-duration-budget-exceeded",
          step: "doctor",
        }),
      );
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
      expect(env?.PATH?.split(path.delimiter)[0]).toBe(path.join(workspace, "runner"));
      if (process.platform === "win32") expect(env?.TAR_OPTIONS).toBe("--force-local");
      else expect(env?.TAR_OPTIONS).toBeUndefined();
      const npmUserConfig = await fsp.readFile(path.join(workspace, "config", "npmrc"), "utf8");
      expect(npmUserConfig).toBe("audit=false\nfund=false\nupdate-notifier=false\n");
      expect(npmUserConfig).not.toContain("@lzehrung:registry");
    } finally {
      await fsp.rm(parent, { recursive: true, force: true });
    }
  });

  it("records a stable diagnostic when install changes unrelated isolated configuration", async () => {
    const parent = await mkTmpDir("codegraph-funnel-config-failure-");
    const workspace = path.join(parent, "workspace");
    const sourceRoot = await createSourceCheckout(parent);
    const calls: CommandCall[] = [];
    let mcpCalls = 0;
    try {
      const result = await runFunnelSmoke({
        channel: "source",
        root: sourceRoot,
        workspace,
        commandRunner: successfulRunner(sourceRoot, calls, { corruptUnrelatedConfigOnApply: true }),
        mcpRunner: async () => {
          mcpCalls += 1;
          return { exitCode: 0 };
        },
      });

      expect(() => assertFunnelResultV1(result)).not.toThrow();
      expect(result.status).toBe("fail");
      expect(result.checks).toContainEqual(expect.objectContaining({ name: "cursor-config-apply", status: "fail" }));
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "cursor-config-apply-invalid",
          message: "Cursor install changed unrelated isolated configuration.",
          step: "cursor-config-apply",
        }),
      );
      expect(calls.map((call) => call.args[1])).toEqual(["version", "doctor", "install", "install"]);
      expect(mcpCalls).toBe(0);
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
