import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { MAX_FILE_VIEW_BYTES, MAX_FILE_VIEW_LINES } from "../src/agent/fileView.js";
import { handleChunkCommand, type ChunkCommandContext } from "../src/cli/chunk.js";
import type { CliAgentCommandContext } from "../src/cli/context.js";
import { buildDoctorReport, findStaleNpmRetirementPaths } from "../src/cli/doctor.js";
import { handleGraphCommand, type GraphCommandContext } from "../src/cli/graph.js";
import { handleGraphDeltaCommand } from "../src/cli/graphDelta.js";
import { handleGraphQueryCommand, type GraphQueryCommandContext } from "../src/cli/graphQueries.js";
import { CLI_HELP_TEXT, FILE_HELP_TEXT, MCP_SERVE_HELP_TEXT, PACKET_HELP_TEXT } from "../src/cli/help.js";
import { handleImpactCommand, type ImpactCommandContext } from "../src/cli/impact.js";
import { handleInspectCommand, type InspectCommandContext } from "../src/cli/inspect.js";
import { handleGotoCommand, type NavigationCommandContext } from "../src/cli/navigation.js";
import { getCodegraphPackageIdentity, getCodegraphVersion } from "../src/cli/packageInfo.js";
import { handlePacketCommand } from "../src/cli/packet.js";
import { handleSearchCommand } from "../src/cli/search.js";
import { handleSkillCommand, type SkillCommandContext } from "../src/cli/skill.js";
import { handleSqlCommand } from "../src/cli/sql.js";
import { runCli } from "../src/cli.js";
import { captureCli } from "./helpers/cli.js";
import * as indexerBuild from "../src/indexer/build-index.js";
import type { ProjectIndex } from "../src/indexer.js";
import type { BuildOptions } from "../src/indexer/types.js";
import type { Graph } from "../src/types.js";
import { runGit } from "./helpers/git.js";
import { createTwoCommitCycleProject, mkTmpDir } from "./helpers/filesystem.js";

function readJsonRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function readJsonArray(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBeTruthy();
  return value as unknown[];
}

function runCliModuleGit(root: string, args: string[]): string {
  return runGit(root, args);
}

function createChunkContext(overrides: Partial<ChunkCommandContext>): ChunkCommandContext {
  return {
    positionals: [],
    getOpt: () => undefined,
    hasFlag: () => false,
    cwd: () => process.cwd(),
    writeJSONLine: () => {
      throw new Error("unexpected json output");
    },
    writeStderrLine: () => {
      throw new Error("unexpected stderr");
    },
    exit: (code) => {
      throw new Error(`chunk exit ${code}`);
    },
    ...overrides,
  };
}

function createAgentCommandContext(overrides: Partial<CliAgentCommandContext>): CliAgentCommandContext {
  const root = path.join(os.tmpdir(), "codegraph-agent-command-context").replace(/\\/g, "/");
  return {
    positionals: [],
    root,
    getOpt: () => undefined,
    hasFlag: () => false,
    writeJSONLine: () => {
      throw new Error("unexpected json output");
    },
    writeStdoutLine: () => {
      throw new Error("unexpected stdout");
    },
    writeStderrLine: () => {
      throw new Error("unexpected stderr");
    },
    exit: (code) => {
      throw new Error(`agent command exit ${code}`);
    },
    ...overrides,
  };
}

function createNavigationContext(overrides: Partial<NavigationCommandContext>): NavigationCommandContext {
  const projectRoot = path.join(os.tmpdir(), "codegraph-navigation-context").replace(/\\/g, "/");
  return {
    projectRootFs: projectRoot,
    discoveryOptions: {},
    positionals: [],
    getOpt: () => undefined,
    hasFlag: () => false,
    nativeMode: "auto",
    workerOpts: {},
    progressHandler: undefined,
    writeJSONLine: () => {
      throw new Error("unexpected json output");
    },
    writeStdoutLine: () => {
      throw new Error("unexpected stdout");
    },
    writeStderrLine: () => {
      throw new Error("unexpected stderr");
    },
    exit: (code) => {
      throw new Error(`navigation exit ${code}`);
    },
    ...overrides,
  };
}

function createInspectContext(overrides: Partial<InspectCommandContext>): InspectCommandContext {
  const projectRoot = path.join(os.tmpdir(), "codegraph-inspect-context").replace(/\\/g, "/");
  return {
    projectRootFs: projectRoot,
    includeRootsAbs: [projectRoot],
    discoveryOptions: {},
    graphOptions: undefined,
    nativeMode: "auto",
    workerOpts: {},
    progressHandler: undefined,
    getOpt: (name) => (name === "--cache" ? "off" : undefined),
    hasFlag: () => false,
    resolveFilesFromRoots: async () => [],
    writeJSONLine: () => undefined,
    writeStdoutLine: () => undefined,
    writeStderrLine: () => undefined,
    ...overrides,
  };
}

function createGraphContext(overrides: Partial<GraphCommandContext>): GraphCommandContext {
  const projectRoot = path.join(os.tmpdir(), "codegraph-graph-context").replace(/\\/g, "/");
  return {
    projectRootFs: projectRoot,
    discoveryOptions: {},
    nativeMode: "auto",
    workerOpts: {},
    progressHandler: undefined,
    graphFlags: {
      fast: false,
      resolveNodeModules: false,
      dynamicImportHeuristics: false,
      resolutionHints: [],
    },
    gitBase: undefined,
    gitHead: undefined,
    changedSince: undefined,
    reportEnabled: false,
    reportFile: undefined,
    showProgress: false,
    getOpt: () => undefined,
    hasFlag: () => false,
    cwd: () => projectRoot,
    resolveFiles: async () => [],
    resolveChangedFilesWithDeletes: async () => null,
    writeStdoutLine: () => {
      throw new Error("unexpected stdout");
    },
    setStderrFilePath: () => {},
    writeCommandReport: async () => {},
    maybeWriteNativeBackendStatus: () => {},
    ...overrides,
  };
}

function createGraphQueryContext(overrides: Partial<GraphQueryCommandContext>): GraphQueryCommandContext {
  const projectRoot = path.join(os.tmpdir(), "codegraph-graph-query-context").replace(/\\/g, "/");
  return {
    command: "deps",
    positionals: [],
    projectRootFs: projectRoot,
    projectRootAbs: projectRoot,
    getOpt: () => undefined,
    hasFlag: () => false,
    writeJSONLine: () => {
      throw new Error("unexpected json output");
    },
    writeStdoutLine: () => {
      throw new Error("unexpected stdout");
    },
    writeStderrLine: () => {
      throw new Error("unexpected stderr");
    },
    exit: (code) => {
      throw new Error(`graph query exit ${code}`);
    },
    listProjectFilesForScan: async () => [],
    collectGraph: async () => ({ nodes: new Set(), edges: [] }),
    buildProjectIndex: async () => {
      throw new Error("unexpected index build");
    },
    ...overrides,
  };
}

function createSkillContext(overrides: Partial<SkillCommandContext>): SkillCommandContext {
  return {
    positionals: [],
    getOpt: () => undefined,
    hasFlag: () => false,
    writeJSONLine: () => {
      throw new Error("unexpected json output");
    },
    writeStdoutLine: () => {
      throw new Error("unexpected stdout");
    },
    writeStderrLine: () => {
      throw new Error("unexpected stderr");
    },
    exit: (code) => {
      throw new Error(`skill exit ${code}`);
    },
    ...overrides,
  };
}

function createImpactContext(overrides: Partial<ImpactCommandContext>): ImpactCommandContext {
  const projectRoot = path.join(os.tmpdir(), "codegraph-impact-context").replace(/\\/g, "/");
  return {
    projectRootFs: projectRoot,
    discoveryOptions: {},
    getOpt: (name) => (name === "--provider" ? "raw" : undefined),
    hasFlag: () => false,
    parsedOptions: new Map(),
    nativeMode: "auto",
    workerOpts: {},
    graphOptions: undefined,
    progressHandler: undefined,
    readStdin: async () => "",
    writeJSONLine: () => {
      throw new Error("unexpected json output");
    },
    writeStdoutLine: () => {
      throw new Error("unexpected stdout");
    },
    writeStderrLine: () => {
      throw new Error("unexpected stderr");
    },
    exit: (code) => {
      throw new Error(`impact exit ${code}`);
    },
    ...overrides,
  };
}

describe("CLI command modules", () => {
  test("builds package identity used by version and doctor commands", () => {
    const identity = getCodegraphPackageIdentity();

    expect(identity.name).toBe("@lzehrung/codegraph");
    expect(getCodegraphVersion()).toBe(identity.version);
    expect(fs.existsSync(path.join(identity.packageRoot, "package.json"))).toBeTruthy();
  });

  test("runs version command in process without exiting", async () => {
    const result = await captureCli(["version"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(getCodegraphVersion());
  });

  test("lists cache verification and progress as build options in CLI help", () => {
    const buildOptions = CLI_HELP_TEXT.slice(
      CLI_HELP_TEXT.indexOf("Build Options:"),
      CLI_HELP_TEXT.indexOf("Analysis Output Options:"),
    );

    expect(buildOptions).toContain("--cache-strict");
    expect(buildOptions).toContain("--cache-verify");
    expect(buildOptions).toContain("--progress");
  });

  test("lists MCP as a top-level command in CLI help", () => {
    const commands = CLI_HELP_TEXT.slice(CLI_HELP_TEXT.indexOf("Commands:"), CLI_HELP_TEXT.indexOf("Graph Options:"));

    expect(commands).toContain("  mcp");
    expect(commands).toContain("Serve MCP tools for agent graph navigation");
  });

  test("lists all public top-level commands in CLI help", () => {
    const commands = CLI_HELP_TEXT.slice(CLI_HELP_TEXT.indexOf("Commands:"), CLI_HELP_TEXT.indexOf("Graph Options:"));

    for (const command of ["apisurface", "graph-delta", "grep", "index", "path", "sql", "unresolved"]) {
      expect(commands).toContain(`  ${command}`);
    }
  });

  test("lists explore before orient in unfamiliar repo guidance", () => {
    const unfamiliarRepoStart = CLI_HELP_TEXT.indexOf("Unfamiliar repo:");
    const examplesStart = CLI_HELP_TEXT.indexOf("Examples:", unfamiliarRepoStart);

    expect(unfamiliarRepoStart).toBeGreaterThanOrEqual(0);
    expect(examplesStart).toBeGreaterThan(unfamiliarRepoStart);

    const unfamiliarRepoGuidance = CLI_HELP_TEXT.slice(unfamiliarRepoStart, examplesStart);
    const exploreIndex = unfamiliarRepoGuidance.indexOf('codegraph explore "how does auth reach db?"');
    const orientIndex = unfamiliarRepoGuidance.indexOf("codegraph orient --root . --budget small --pretty");

    expect(exploreIndex).toBeGreaterThanOrEqual(0);
    expect(orientIndex).toBeGreaterThanOrEqual(0);
    expect(exploreIndex).toBeLessThan(orientIndex);
  });

  test("documents HTTP host and port options in MCP serve help", () => {
    expect(MCP_SERVE_HELP_TEXT).toContain("--port <number>");
    expect(MCP_SERVE_HELP_TEXT).toContain("--host <host>");
    expect(MCP_SERVE_HELP_TEXT).toContain("--stdio");
    expect(MCP_SERVE_HELP_TEXT).toMatch(/--warmup\s/);
    expect(MCP_SERVE_HELP_TEXT).toContain("--warmup-symbols");
    expect(MCP_SERVE_HELP_TEXT).toContain("--include-glob");
    expect(MCP_SERVE_HELP_TEXT).toContain("--ignore-glob");
    expect(MCP_SERVE_HELP_TEXT).toContain("orient");
    expect(MCP_SERVE_HELP_TEXT).toContain("packet_get");
    expect(MCP_SERVE_HELP_TEXT).toContain("refresh_index");
  });

  test("packet help documents accepted target shapes", () => {
    expect(PACKET_HELP_TEXT).toContain("file paths, symbol names, SQL object names");
    expect(PACKET_HELP_TEXT).toContain("file:/symbol:/chunk:/sql:/graph: handles");
    expect(PACKET_HELP_TEXT).not.toContain("CLI orient returns file handles");
  });

  test("install and uninstall help omit --json because output is always structured", async () => {
    for (const command of ["install", "uninstall"]) {
      const result = await captureCli([command, "--help"]);

      expect(result.exitCode, command).toBeUndefined();
      expect(result.stderr, command).toBe("");
      expect(result.stdout, command).toContain(`Usage: codegraph ${command}`);
      expect(result.stdout, command).not.toContain("--json");
    }
  });

  test("top-level help scopes output options to analysis commands", async () => {
    const result = await captureCli(["--help"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^Analysis Output Options:$/m);
    expect(result.stdout).not.toMatch(/^Output Options:$/m);

    const outputSectionStart = result.stdout.indexOf("Analysis Output Options:");
    const examplesStart = result.stdout.indexOf("Examples:", outputSectionStart);
    expect(outputSectionStart).toBeGreaterThanOrEqual(0);
    expect(examplesStart).toBeGreaterThan(outputSectionStart);

    const outputSection = result.stdout.slice(outputSectionStart, examplesStart);
    expect(outputSection).toContain("--json");
    expect(outputSection).toContain("Output analysis commands as JSON");
    expect(outputSection).not.toContain("Output as JSON (default)");

    const installerLines = result.stdout
      .split("\n")
      .filter((line) => /\bcodegraph (?:install|uninstall)\b|\b(?:install|uninstall)\s{2,}/.test(line));
    expect(installerLines.length).toBeGreaterThan(0);
    expect(installerLines.join("\n")).not.toContain("--json");
  });

  test("search command prints usage before running without a query", async () => {
    const stderr: string[] = [];

    await expect(
      handleSearchCommand(
        createAgentCommandContext({
          writeStderrLine: (message) => stderr.push(message),
        }),
      ),
    ).rejects.toThrow("agent command exit 2");

    expect(stderr.join("\n")).toContain("Usage: codegraph search");
  });

  test("search command rejects unsupported modes before searching", async () => {
    await expect(
      handleSearchCommand(
        createAgentCommandContext({
          positionals: ["auth"],
          getOpt: (name) => (name === "--mode" ? "invalid" : undefined),
        }),
      ),
    ).rejects.toThrow("Invalid --mode value");
  });

  test("packet command validates subcommand and target before lookup", async () => {
    const stderr: string[] = [];

    await expect(
      handlePacketCommand(
        createAgentCommandContext({
          positionals: ["show"],
          writeStderrLine: (message) => stderr.push(message),
        }),
      ),
    ).rejects.toThrow("agent command exit 2");

    expect(stderr.join("\n")).toContain("Usage: codegraph packet get <target>");
  });

  test("goto command validates positional shape before indexing", async () => {
    const stderr: string[] = [];

    await expect(
      handleGotoCommand(
        createNavigationContext({
          positionals: ["src/index.ts"],
          writeStderrLine: (message) => stderr.push(message),
        }),
      ),
    ).rejects.toThrow("navigation exit 2");

    expect(stderr).toEqual(["Usage: goto <file> <line> <column>"]);
  });

  test("graph command can write compact JSON to stdout without default files", async () => {
    const root = await mkTmpDir("dg-cli-graph-module-");
    const entryFile = path.join(root, "entry.ts");
    const stdout: string[] = [];
    const stderrFiles: Array<string | undefined> = [];
    await fsp.writeFile(entryFile, "export const value = 1;\n", "utf8");

    await handleGraphCommand(
      createGraphContext({
        projectRootFs: root,
        cwd: () => root,
        resolveFiles: async () => [entryFile.replace(/\\/g, "/")],
        hasFlag: (name) => name === "--stdout" || name === "--json",
        writeStdoutLine: (message) => stdout.push(message),
        setStderrFilePath: (filePath) => stderrFiles.push(filePath),
      }),
    );

    const graph = readJsonRecord(JSON.parse(stdout[0] ?? "{}"));
    expect(readJsonArray(graph.nodes)).toContain(entryFile.replace(/\\/g, "/"));
    expect(stderrFiles).toEqual([undefined]);
  });

  test("routes agent command help to command-specific usage text", async () => {
    const cases = [
      { args: ["search", "--help"], heading: "codegraph search", usage: 'Usage: codegraph search "<query>"' },
      {
        args: ["orient", "--help"],
        heading: "codegraph orient",
        usage: "Usage: codegraph orient [roots...]",
      },
      {
        args: ["packet", "--help"],
        heading: "codegraph packet",
        usage: "Usage: codegraph packet get <target>",
      },
      {
        args: ["explain", "--help"],
        heading: "codegraph explain",
        usage: "Usage: codegraph explain <file|symbol|sql-object|handle>",
      },
      {
        args: ["file", "--help"],
        heading: "codegraph file",
        usage: "Usage: codegraph file <path>",
      },
      { args: ["artifact", "--help"], heading: "codegraph artifact", usage: "Usage: codegraph artifact build" },
      { args: ["drift", "--help"], heading: "codegraph drift", usage: "Usage: codegraph drift [roots...]" },
      { args: ["mcp", "--help"], heading: "codegraph mcp", usage: "Usage: codegraph mcp serve" },
    ];

    for (const entry of cases) {
      const result = await captureCli(entry.args);

      expect([undefined, 0]).toContain(result.exitCode);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(entry.heading);
      expect(result.stdout).toContain(entry.usage);
      expect(result.stdout).not.toContain("Graph Options:");
    }
  });

  test("file help documents live-view bounds and opt-in context", async () => {
    const result = await captureCli(["file", "--help"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${FILE_HELP_TEXT.trimEnd()}\n`);
    for (const option of ["--offset", "--limit", "--max-bytes", "--include-graph-context", "--allow-sensitive"]) {
      expect(result.stdout, option).toContain(option);
    }
  });

  test("documents drift-specific flags and head semantics in drift help", async () => {
    const result = await captureCli(["drift", "--help"]);

    expect(result.stdout).toContain("--limit");
    expect(result.stdout).toContain("--hotspot-jump-threshold");
    expect(result.stdout).toContain("--head <ref>");
    expect(result.stdout).toContain("--graph-edges <mode>");
    expect(result.stdout).toContain("--public-api <mode>");
    expect(result.stdout).toContain("--compact-json");
    expect(result.stdout).toContain("with --base-artifact, only the current checkout is supported");
  });

  test("rejects ambiguous MCP serve transport flags before starting a server", async () => {
    const result = await captureCli(["mcp", "serve", "--stdio", "--port", "3000"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Choose either --stdio or --port");
  });

  test("rejects invalid MCP serve port values before starting a server", async () => {
    const result = await captureCli(["mcp", "serve", "--port", "abc"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid --port value");
  });

  test("rejects MCP serve host without HTTP transport", async () => {
    const result = await captureCli(["mcp", "serve", "--host", "127.0.0.1"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--host requires --port");
  });

  test("runs doctor command in process with captured JSON output", async () => {
    const result = await captureCli(["doctor"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    const report = readJsonRecord(JSON.parse(result.stdout));
    expect(report.package).toMatchObject({ name: "@lzehrung/codegraph" });
    expect(report.native).toBeTypeOf("object");
  });

  test("captures CLI usage exits in process", async () => {
    const result = await captureCli(["missing-command"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown command: missing-command");
  });

  test("rejects unknown command options before execution", async () => {
    const cases = [
      ["graph", "--root", ".", "./src", "--json", "--nonesuch"],
      ["inspect", "--root", ".", "./src", "--json", "--nonesuch"],
      ["duplicates", "--root", ".", "./src", "--nonesuch", "--limit", "0"],
      ["impact", "--provider", "raw", "--nonesuch"],
      ["search", "auth", "--nonesuch"],
      ["explain", "src/cli.ts", "--nonesuch"],
      ["packet", "get", "file:src%2Fcli.ts", "--nonesuch"],
    ];

    for (const args of cases) {
      const result = await captureCli(args);
      const command = args[0];

      expect(result.exitCode, command).toBe(2);
      expect(result.stdout, command).toBe("");
      expect(result.stderr, command).toContain(`Unknown option for ${command}: --nonesuch`);
    }
  });

  test("reports mistyped value options without treating values as roots", async () => {
    const result = await captureCli(["inspect", "--root", ".", "./src", "--limt", "1", "--json"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown option for inspect: --limt");
    expect(result.stderr).not.toContain("project root");
  });

  test("rejects unknown short command flags", async () => {
    const result = await captureCli(["search", "auth", "-z"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown option for search: -z");
  });

  test("file positional validation prints the complete help usage", async () => {
    const expectedUsage =
      "Usage: codegraph file <path> [--root <path>] [--offset <line>] [--limit <lines>] [--max-bytes <bytes>] [--include-graph-context] [--allow-sensitive] [--json | --pretty]";
    const helpUsage = FILE_HELP_TEXT.split("\n").find((line) => line.startsWith("Usage: "));
    const result = await captureCli(["file", "src/first.ts", "src/second.ts"]);

    expect(helpUsage).toBe(expectedUsage);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`Unexpected positional argument for file: src/second.ts\n${expectedUsage}\n`);
  });

  test("rejects unexpected positionals for commands without include roots", async () => {
    const cases = [
      {
        args: ["impact", "--provider", "raw", "stray-position", "--pretty"],
        expected: "Unexpected positional argument for impact: stray-position",
      },
      {
        args: ["graph-delta", "stray-position"],
        expected: "Unexpected positional argument for graph-delta: stray-position",
      },
    ];

    for (const entry of cases) {
      const result = await captureCli(entry.args);

      expect(result.exitCode, entry.args[0]).toBe(2);
      expect(result.stdout, entry.args[0]).toBe("");
      expect(result.stderr, entry.args[0]).toContain(entry.expected);
    }
  });

  test("reports impact positional validation when legacy root stat fails", async () => {
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("permission denied");
    });
    try {
      const result = await captureCli(["impact", "src", "--provider", "raw", "--pretty"]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Unexpected positional argument for impact: src");
    } finally {
      statSpy.mockRestore();
    }
  });

  test("keeps overlapping in-process CLI runs isolated by runtime context", async () => {
    const firstRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-runcli-first-"));
    const secondRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-runcli-second-"));
    await fsp.writeFile(path.join(firstRoot, "first.ts"), "export const first = 1;\n", "utf8");
    await fsp.writeFile(path.join(secondRoot, "second.ts"), "export const second = 2;\n", "utf8");

    try {
      await Promise.all([
        runCli(["graph"], {
          cwd: () => firstRoot,
          stdout: () => {
            throw new Error("unexpected first stdout");
          },
        }),
        runCli(["graph"], {
          cwd: () => secondRoot,
          stdout: () => {
            throw new Error("unexpected second stdout");
          },
        }),
      ]);

      const firstGraph = readJsonRecord(JSON.parse(await fsp.readFile(path.join(firstRoot, "codegraph.json"), "utf8")));
      const secondGraph = readJsonRecord(
        JSON.parse(await fsp.readFile(path.join(secondRoot, "codegraph.json"), "utf8")),
      );
      expect(JSON.stringify(firstGraph)).toContain("first.ts");
      expect(JSON.stringify(firstGraph)).not.toContain("second.ts");
      expect(JSON.stringify(secondGraph)).toContain("second.ts");
      expect(JSON.stringify(secondGraph)).not.toContain("first.ts");
    } finally {
      await Promise.all([
        fsp.rm(firstRoot, { recursive: true, force: true }),
        fsp.rm(secondRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test("builds doctor reports for explicit index artifact paths", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-doctor-module-"));
    const artifactPath = path.join(tempDir, "codegraph.json");
    await fsp.writeFile(artifactPath, "{}", "utf8");

    try {
      const report = buildDoctorReport(artifactPath);

      expect(report.package.name).toBe("@lzehrung/codegraph");
      expect(report.native.supportedLanguageIds.length).toBeGreaterThan(0);
      expect(report.native.origin).toBeDefined();
      expect(report.native.origin?.updateSafeForCurrentProcess).toBe(report.native.origin?.mode !== "package");
      expect(report.native.update).toMatchObject({
        restartRequired: false,
        runningVersion: report.package.version,
        installedVersion: report.package.version,
        staleRetirementPaths: [],
      });
      expect(report.indexArtifact?.type).toBe("jsonGraph");
      expect(report.indexArtifact?.exists).toBeTruthy();
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("bounds and normalizes stale npm retirement sibling diagnostics", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-doctor-retirement-"));
    const scopeRoot = path.join(root, "node_modules", "@lzehrung");
    const packageRoot = path.join(scopeRoot, "codegraph");
    await Promise.all([
      fsp.mkdir(packageRoot, { recursive: true }),
      fsp.mkdir(path.join(scopeRoot, ".codegraph-z"), { recursive: true }),
      fsp.mkdir(path.join(scopeRoot, ".codegraph-a"), { recursive: true }),
      fsp.mkdir(path.join(scopeRoot, "unrelated"), { recursive: true }),
    ]);

    try {
      expect(findStaleNpmRetirementPaths(packageRoot, 1)).toEqual([
        path.join(scopeRoot, ".codegraph-a").replace(/\\/g, "/"),
      ]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  test("builds doctor reports for agent artifact bundle directories", async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-doctor-artifact-bundle-"));
    const tempDir = path.join(tempRoot, "bundle");
    await fsp.mkdir(tempDir);
    await fsp.writeFile(path.join(tempRoot, "outside.sqlite"), "not in the bundle\n", "utf8");
    await fsp.writeFile(
      path.join(tempDir, "manifest.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          root: tempDir,
          outDir: tempDir,
          manifestPath: path.join(tempDir, "manifest.json"),
          artifacts: {
            sqlite: "../outside.sqlite",
            graphJson: "graph.json",
            report: "CODEGRAPH_REPORT.md",
            questions: "questions.json",
          },
          graphJsonSchema: "codegraph.graph-json",
        },
        null,
        2,
      ),
      "utf8",
    );
    await fsp.writeFile(path.join(tempDir, "graph.json"), '{"format":"codegraph.graph-json"}\n', "utf8");
    await fsp.writeFile(path.join(tempDir, "CODEGRAPH_REPORT.md"), "# Codegraph Report\n", "utf8");
    await fsp.writeFile(path.join(tempDir, "questions.json"), '{"format":"codegraph.questions"}\n', "utf8");

    try {
      const report = buildDoctorReport(tempDir);

      expect(report.indexArtifact?.type).toBe("artifactBundle");
      expect(report.indexArtifact?.exists).toBeTruthy();
      expect(report.indexArtifact?.details).toMatchObject({
        manifestPresent: true,
        sqlitePresent: false,
        graphJsonPresent: true,
        reportPresent: true,
        questionsPresent: true,
      });
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("runs SQL queries through the extracted sql command handler", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-sql-module-"));
    const dbPath = path.join(tempDir, "graph.sqlite");
    await fsp.writeFile(path.join(tempDir, "main.ts"), "export function helper() { return 1; }\n", "utf8");
    await captureCli(["graph", "--root", tempDir, "--sqlite", dbPath]);
    const jsonLines: unknown[] = [];

    try {
      await handleSqlCommand({
        getOpt: (name) => {
          if (name === "--db") return dbPath;
          if (name === "--query") return "SELECT name FROM symbols WHERE kind = 'function';";
          return undefined;
        },
        cwd: () => process.cwd(),
        writeJSONLine: (value) => jsonLines.push(value),
        writeStderrLine: () => {
          throw new Error("unexpected stderr");
        },
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
      });

      const result = readJsonRecord(jsonLines[0]);
      expect(result.columns).toEqual(["name"]);
      expect(result.rows).toEqual([["helper"]]);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("prints SQL usage and exits when required options are missing", async () => {
    const stderrLines: string[] = [];

    await expect(
      handleSqlCommand({
        getOpt: () => undefined,
        cwd: () => process.cwd(),
        writeJSONLine: () => {
          throw new Error("unexpected json output");
        },
        writeStderrLine: (message) => stderrLines.push(message),
        exit: (code) => {
          throw new Error(`sql exit ${code}`);
        },
      }),
    ).rejects.toThrow("sql exit 1");

    expect(stderrLines).toEqual(['Usage: sql --db <sqlite path> --query "SELECT ..."']);
  });

  test("resolves relative SQL database paths against the injected runtime cwd", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-sql-relative-"));
    const dbPath = path.join(tempDir, "graph.sqlite");
    await fsp.writeFile(path.join(tempDir, "main.ts"), "export const answer = 42;\n", "utf8");
    await captureCli(["graph", "--root", tempDir, "--sqlite", dbPath]);
    const jsonLines: unknown[] = [];

    try {
      await handleSqlCommand({
        getOpt: (name) => {
          if (name === "--sqlite") return "graph.sqlite";
          if (name === "--query") return "SELECT path FROM files ORDER BY path;";
          return undefined;
        },
        cwd: () => tempDir,
        writeJSONLine: (value) => jsonLines.push(value),
        writeStderrLine: () => {
          throw new Error("unexpected stderr");
        },
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
      });

      const result = readJsonRecord(jsonLines[0]);
      expect(result.columns).toEqual(["path"]);
      expect(JSON.stringify(result.rows)).toContain("main.ts");
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("writes graph delta output through the extracted graph-delta command handler", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-delta-module-"));
    const outputPath = path.join(tempDir, "delta.json");
    const sourcePath = path.join(tempDir, "main.ts");
    await fsp.writeFile(sourcePath, "import { helper } from './helper';\nhelper();\n", "utf8");
    await fsp.writeFile(path.join(tempDir, "helper.ts"), "export function helper() { return 1; }\n", "utf8");

    try {
      await handleGraphDeltaCommand({
        projectRootFs: tempDir,
        files: [sourcePath],
        getOpt: (name) => {
          if (name === "--output") return outputPath;
          return undefined;
        },
        hasFlag: () => false,
        cwd: () => process.cwd(),
        nativeMode: "auto",
        workerOpts: {},
        graphOptions: undefined,
        gitBase: undefined,
        gitHead: undefined,
        changedSince: undefined,
        writeJSONLine: () => {
          throw new Error("unexpected json stdout");
        },
      });

      const report = readJsonRecord(JSON.parse(await fsp.readFile(outputPath, "utf8")));
      expect(report.changedFiles).toEqual(["main.ts"]);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("inspect auto-enables native workers at the agent-session file threshold", async () => {
    const emptyIndex: ProjectIndex = {
      graph: { nodes: new Set<string>(), edges: [] },
      modules: new Map(),
      byFile: new Map(),
      exportCache: new Map(),
      scopeCache: new Map(),
    };
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockResolvedValue(emptyIndex);
    const largeFiles = Array.from({ length: 250 }, (_, index) => `file-${index}.ts`);
    const smallFiles = largeFiles.slice(1);

    try {
      await handleInspectCommand(createInspectContext({ resolveFilesFromRoots: async () => smallFiles }));
      await handleInspectCommand(createInspectContext({ resolveFilesFromRoots: async () => largeFiles }));

      expect(buildSpy.mock.calls[0]?.[1]?.useNativeWorkers).toBeUndefined();
      expect(buildSpy.mock.calls[1]?.[1]?.useNativeWorkers).toBe(true);
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("uses shared cache-mode validation in the extracted graph-delta command handler", async () => {
    await expect(
      handleGraphDeltaCommand({
        projectRootFs: process.cwd(),
        files: [],
        getOpt: (name) => (name === "--cache" ? "banana" : undefined),
        hasFlag: () => false,
        cwd: () => process.cwd(),
        nativeMode: "auto",
        workerOpts: {},
        graphOptions: undefined,
        gitBase: undefined,
        gitHead: undefined,
        changedSince: undefined,
        writeJSONLine: () => {
          throw new Error("unexpected json stdout");
        },
      }),
    ).rejects.toThrow('Invalid --cache value "banana". Expected one of: off, memory, disk.');
  });

  test("impact command retains parsed cache only when reference context is requested", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-impact-module-"));
    const sourcePath = path.join(tempDir, "feature.ts");
    const diffText = [
      "diff --git a/feature.ts b/feature.ts",
      "index 1111111..2222222 100644",
      "--- a/feature.ts",
      "+++ b/feature.ts",
      "@@ -1,3 +1,3 @@",
      " export function feature() {",
      "-  return 1;",
      "+  return 2;",
      " }",
      "",
    ].join("\n");
    const capturedIndexOptions: BuildOptions[] = [];
    const originalBuildProjectIndex = indexerBuild.buildProjectIndex;
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndex").mockImplementation(async (projectRoot, opts) => {
      if (opts) capturedIndexOptions.push(opts);
      return await originalBuildProjectIndex(projectRoot, opts);
    });

    try {
      await fsp.writeFile(sourcePath, "export function feature() {\n  return 2;\n}\n", "utf8");
      const baseContext = {
        projectRootFs: tempDir,
        readStdin: async () => diffText,
        writeJSONLine: () => undefined,
      } satisfies Partial<ImpactCommandContext>;

      await handleImpactCommand(createImpactContext(baseContext));
      await handleImpactCommand(
        createImpactContext({
          ...baseContext,
          getOpt: (name) => {
            if (name === "--provider") return "raw";
            if (name === "--ref-context") return "line";
            return undefined;
          },
        }),
      );

      expect(capturedIndexOptions[0]?.keepParsed).toBeUndefined();
      expect(capturedIndexOptions[1]?.keepParsed).toBe(true);
    } finally {
      buildSpy.mockRestore();
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("chunks files through the extracted chunk command handler", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-chunk-module-"));
    const filePath = path.join(tempDir, "sample.ts");
    await fsp.writeFile(filePath, "export function alpha() {\n  return 1;\n}\n", "utf8");
    const jsonLines: unknown[] = [];
    const stderrLines: string[] = [];

    try {
      await handleChunkCommand({
        positionals: [filePath],
        getOpt: () => undefined,
        hasFlag: () => false,
        cwd: () => process.cwd(),
        writeJSONLine: (value) => jsonLines.push(value),
        writeStderrLine: (message) => stderrLines.push(message),
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
      });

      expect(stderrLines).toEqual([]);
      expect(Array.isArray(jsonLines[0])).toBeTruthy();
      const chunks = jsonLines[0] as Array<Record<string, unknown>>;
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]?.filePath).toBe(filePath);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("runs chunk relative paths against the injected runtime cwd", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-chunk-cwd-"));
    const filePath = path.join(tempDir, "sample.ts");
    await fsp.writeFile(filePath, "export function beta() {\n  return 2;\n}\n", "utf8");

    try {
      const result = await captureCli(["chunk", "sample.ts", "--min-tokens", "1", "--max-tokens", "50"], {
        cwd: tempDir,
      });

      expect(result.exitCode).toBeUndefined();
      expect(result.stderr).toBe("");
      const chunks = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]?.filePath).toBe(filePath);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("prints chunk usage and exits when no input file is provided", async () => {
    const stderrLines: string[] = [];

    await expect(
      handleChunkCommand(
        createChunkContext({
          writeStderrLine: (message) => stderrLines.push(message),
        }),
      ),
    ).rejects.toThrow("chunk exit 2");

    expect(stderrLines).toContain("Usage: chunk <file-path> [options]");
    expect(stderrLines).toContain("  --text            Force text chunking mode");
  });

  test("rejects invalid chunk token bounds", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-chunk-invalid-bounds-"));
    const filePath = path.join(tempDir, "sample.ts");
    await fsp.writeFile(filePath, "export const value = 1;\n", "utf8");
    const stderrLines: string[] = [];

    try {
      await expect(
        handleChunkCommand(
          createChunkContext({
            positionals: ["sample.ts"],
            cwd: () => tempDir,
            getOpt: (name) => {
              if (name === "--min-tokens") return "100";
              if (name === "--max-tokens") return "50";
              return undefined;
            },
            writeStderrLine: (message) => stderrLines.push(message),
          }),
        ),
      ).rejects.toThrow("chunk exit 1");

      expect(stderrLines).toEqual([
        'Chunking failed: Invalid --max-tokens value "50". Expected a value greater than or equal to --min-tokens.',
      ]);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("forces text chunking with inferred data-file language ids", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-chunk-text-"));
    const filePath = path.join(tempDir, "sample.json");
    await fsp.writeFile(filePath, '{"name":"codegraph","enabled":true}\n', "utf8");
    const jsonLines: unknown[] = [];

    try {
      await handleChunkCommand(
        createChunkContext({
          positionals: ["sample.json"],
          cwd: () => tempDir,
          hasFlag: (name) => name === "--text",
          writeJSONLine: (value) => jsonLines.push(value),
        }),
      );

      const chunks = readJsonArray(jsonLines[0]).map(readJsonRecord);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0]?.languageId).toBe("json");
      expect(chunks[0]?.filePath).toBe(filePath);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reports chunk read failures through the command handler", async () => {
    const stderrLines: string[] = [];

    await expect(
      handleChunkCommand(
        createChunkContext({
          positionals: ["missing.ts"],
          cwd: () => path.join(os.tmpdir(), "codegraph-missing-chunk-root"),
          writeStderrLine: (message) => stderrLines.push(message),
        }),
      ),
    ).rejects.toThrow("chunk exit 1");

    expect(stderrLines[0]).toContain("Chunking failed:");
    expect(stderrLines[0]).toContain("missing.ts");
  });

  test("runs bounded JSON and pretty file views through the main CLI dispatcher", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-file-view-"));
    await fsp.writeFile(path.join(tempDir, "util.ts"), "export const first = 1;\nexport const second = 2;\n", "utf8");
    await fsp.writeFile(
      path.join(tempDir, "main.ts"),
      "import { second } from './util';\nexport const result = second;\n",
      "utf8",
    );

    try {
      const jsonResult = await captureCli([
        "file",
        "util.ts",
        "--root",
        tempDir,
        "--offset",
        "2",
        "--limit",
        "1",
        "--max-bytes",
        "8",
      ]);
      const jsonView = readJsonRecord(JSON.parse(jsonResult.stdout));

      expect(jsonResult).toMatchObject({ stderr: "", exitCode: undefined });
      expect(jsonView).toMatchObject({
        file: "util.ts",
        offset: 2,
        limit: 1,
        totalLines: 3,
        content: "2\texport c",
        text: "export c",
        truncated: true,
        page: { nextOffset: 3 },
      });
      expect(jsonView.graphContext).toBeUndefined();

      const prettyResult = await captureCli([
        "file",
        "util.ts",
        "--root",
        tempDir,
        "--offset",
        "2",
        "--limit",
        "1",
        "--max-bytes",
        "100",
        "--pretty",
      ]);
      expect(prettyResult).toEqual({
        stdout: [
          "File: util.ts",
          "Lines 2-2 of 3",
          "2\texport const second = 2;",
          "Next page: codegraph file util.ts --offset 3 --limit 1 --pretty",
          "",
        ].join("\n"),
        stderr: "",
        exitCode: undefined,
      });

      const contextualResult = await captureCli([
        "file",
        "util.ts",
        "--root",
        tempDir,
        "--limit",
        "1",
        "--max-bytes",
        "100",
        "--include-graph-context",
        "--json",
      ]);
      const contextualView = readJsonRecord(JSON.parse(contextualResult.stdout));
      const graphContext = readJsonRecord(contextualView.graphContext);
      expect(graphContext.usedBy).toEqual(["main.ts"]);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test.each([
    { option: "--limit", maximum: MAX_FILE_VIEW_LINES },
    { option: "--max-bytes", maximum: MAX_FILE_VIEW_BYTES },
  ])("rejects $option values above the file view bound", async ({ option, maximum }) => {
    const excessiveValue = maximum + 1;
    const result = await captureCli(["file", "util.ts", option, String(excessiveValue)]);

    expect(result).toEqual({
      stdout: "",
      stderr: `Invalid ${option} value "${excessiveValue}". Expected an integer from 1 to ${maximum}.\n`,
      exitCode: 1,
    });
  });

  test("redacts environment files through the CLI dispatcher unless sensitive access is explicit", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-sensitive-file-view-"));
    const sensitiveText = "API_TOKEN=dispatcher-secret\nUSER=alice\n";
    await fsp.writeFile(path.join(tempDir, ".env.local"), sensitiveText, "utf8");

    try {
      const redactedResult = await captureCli(["file", ".env.local", "--root", tempDir, "--json"]);
      const redactedView = readJsonRecord(JSON.parse(redactedResult.stdout));

      expect(redactedResult).toMatchObject({ stderr: "", exitCode: undefined });
      expect(redactedResult.stdout).not.toContain("dispatcher-secret");
      expect(redactedView).toMatchObject({
        file: ".env.local",
        text: "Sensitive environment values omitted.\nKeys: API_TOKEN, USER",
        content: "1\tSensitive environment values omitted.\n2\tKeys: API_TOKEN, USER",
        sensitive: { kind: "environment", redacted: true, allowSensitiveRequired: true },
      });

      const allowedResult = await captureCli(["file", ".env.local", "--root", tempDir, "--allow-sensitive", "--json"]);
      const allowedView = readJsonRecord(JSON.parse(allowedResult.stdout));

      expect(allowedResult).toMatchObject({ stderr: "", exitCode: undefined });
      expect(allowedView).toMatchObject({
        text: sensitiveText,
        content: "1\tAPI_TOKEN=dispatcher-secret\n2\tUSER=alice\n3\t",
        sensitive: { kind: "environment", redacted: false, allowSensitiveRequired: true },
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("runs graph exploration commands through the main CLI dispatcher", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-explore-"));
    await fsp.writeFile(path.join(tempDir, "util.ts"), "export function helper() { return 1; }\n", "utf8");
    await fsp.writeFile(
      path.join(tempDir, "main.ts"),
      "import { helper } from './util';\nimport missing from 'missing-pkg';\nexport function run() { return helper() + missing; }\n",
      "utf8",
    );

    try {
      const deps = await captureCli(["deps", "main.ts", "--root", tempDir, "--json"]);
      const rdeps = await captureCli(["rdeps", "util.ts", "--root", tempDir]);
      const graphPath = await captureCli(["path", "main.ts", "util.ts", "--root", tempDir]);
      const cycles = await captureCli(["cycles", "--root", tempDir]);
      const unresolved = await captureCli(["unresolved", "--root", tempDir, "--verbose"]);
      const apiSurface = await captureCli(["apisurface", "--root", tempDir]);

      expect(JSON.stringify(JSON.parse(deps.stdout))).toContain("util.ts");
      expect(rdeps.stdout).toContain("Reverse dependencies for util.ts:");
      expect(graphPath.stdout).toContain("main.ts");
      expect(graphPath.stdout).toContain("util.ts");
      expect(cycles.stdout).toContain("No dependency cycles found.");
      expect(unresolved.stdout).toContain("missing-pkg");
      expect(unresolved.stdout).toContain('as "missing-pkg"');
      expect(apiSurface.stdout).toContain("API Surface");
      expect(apiSurface.stdout).toContain("run");
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("runs drift through the main CLI dispatcher with policy exits", async () => {
    const tempDir = await createTwoCommitCycleProject("codegraph-cli-drift-", runCliModuleGit);
    try {
      const json = await captureCli([
        "drift",
        "src",
        "--root",
        tempDir,
        "--base",
        "HEAD~1",
        "--head",
        "HEAD",
        "--json",
      ]);
      const noFail = await captureCli([
        "drift",
        "src",
        "--root",
        tempDir,
        "--base",
        "HEAD~1",
        "--head",
        "HEAD",
        "--fail-on",
        "public-api-removal",
      ]);
      const fail = await captureCli([
        "drift",
        "src",
        "--root",
        tempDir,
        "--base",
        "HEAD~1",
        "--head",
        "HEAD",
        "--fail-on",
        "new-cycle",
      ]);

      expect(JSON.parse(json.stdout)).toMatchObject({ schemaVersion: 1 });
      expect(noFail.exitCode).toBeUndefined();
      expect(fail.exitCode).toBe(1);
      expect(fail.stdout).toContain("new-cycle");
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("parses space-separated cycle sort values through the main CLI dispatcher", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-cycle-sort-"));
    await fsp.writeFile(path.join(tempDir, "main.ts"), "export const value = 1;\n", "utf8");

    try {
      const result = await captureCli(["cycles", "--root", tempDir, "--sort", "recent", "--json"]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Invalid --sort value");
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("runs extracted graph query command handlers with injected graph dependencies", async () => {
    const projectRoot = path.join(os.tmpdir(), "codegraph-graph-query-handler").replace(/\\/g, "/");
    const mainPath = `${projectRoot}/main.ts`;
    const utilPath = `${projectRoot}/util.ts`;
    const stdoutLines: string[] = [];
    const jsonLines: unknown[] = [];
    const stderrLines: string[] = [];

    await handleGraphQueryCommand({
      command: "deps",
      positionals: ["main.ts"],
      projectRootFs: projectRoot,
      projectRootAbs: projectRoot,
      getOpt: () => undefined,
      hasFlag: (name) => name === "--json",
      writeJSONLine: (value) => jsonLines.push(value),
      writeStdoutLine: (message) => stdoutLines.push(message),
      writeStderrLine: (message) => stderrLines.push(message),
      exit: (code) => {
        throw new Error(`unexpected exit ${code}`);
      },
      listProjectFilesForScan: async () => [mainPath, utilPath],
      collectGraph: async () => ({
        nodes: new Set([mainPath, utilPath]),
        edges: [
          {
            from: mainPath,
            to: { type: "file", path: utilPath },
            raw: "./util",
          },
        ],
      }),
      buildProjectIndex: async () => {
        throw new Error("unexpected index build");
      },
    });

    expect(jsonLines).toEqual([[{ file: utilPath, depth: 1 }]]);
    expect(stdoutLines).toEqual([]);
    expect(stderrLines).toEqual([]);
  });

  test("loads graph query commands through the project index when no graph collector is injected", async () => {
    const projectRoot = path.join(os.tmpdir(), "codegraph-query-index").replace(/\\/g, "/");
    const mainPath = `${projectRoot}/main.ts`;
    const utilPath = `${projectRoot}/util.ts`;
    let listedFiles = false;
    let buildCount = 0;
    const graph: Graph = {
      nodes: new Set([mainPath, utilPath]),
      edges: [
        {
          from: mainPath,
          to: { type: "file", path: utilPath },
          raw: "./util",
        },
      ],
    };
    let edgeIterations = 0;
    const originalIterator = graph.edges[Symbol.iterator].bind(graph.edges);
    graph.edges[Symbol.iterator] = function (): ArrayIterator<Graph["edges"][number]> {
      edgeIterations += 1;
      return originalIterator();
    };
    const projectIndex: ProjectIndex = {
      graph,
      graphAdjacency: {
        forward: new Map([[mainPath, [utilPath]]]),
        reverse: new Map([[utilPath, [mainPath]]]),
      },
      modules: new Map(),
      byFile: new Map(),
      projectRoot,
      exportCache: new Map(),
      scopeCache: new Map(),
    };
    const cases: Array<{
      command: "deps" | "rdeps" | "path";
      positionals: string[];
      expected: unknown;
    }> = [
      {
        command: "deps",
        positionals: ["main.ts"],
        expected: [{ file: utilPath, depth: 1 }],
      },
      {
        command: "rdeps",
        positionals: ["util.ts"],
        expected: [{ file: mainPath, depth: 1 }],
      },
      {
        command: "path",
        positionals: ["main.ts", "util.ts"],
        expected: [mainPath, utilPath],
      },
    ];

    for (const entry of cases) {
      const jsonLines: unknown[] = [];
      await handleGraphQueryCommand({
        command: entry.command,
        positionals: entry.positionals,
        projectRootFs: projectRoot,
        projectRootAbs: projectRoot,
        getOpt: () => undefined,
        hasFlag: (name) => name === "--json",
        writeJSONLine: (value) => jsonLines.push(value),
        writeStdoutLine: () => {
          throw new Error("unexpected stdout");
        },
        writeStderrLine: () => {
          throw new Error("unexpected stderr");
        },
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
        listProjectFilesForScan: async () => {
          listedFiles = true;
          return [mainPath, utilPath];
        },
        buildProjectIndex: async () => {
          buildCount += 1;
          return projectIndex;
        },
      });

      expect(jsonLines).toEqual([entry.expected]);
    }

    expect(buildCount).toBe(cases.length);
    expect(listedFiles).toBe(false);
    expect(edgeIterations).toBe(0);
  });

  test("prints graph query usage for missing file arguments", async () => {
    const stderrLines: string[] = [];

    await expect(
      handleGraphQueryCommand(
        createGraphQueryContext({
          command: "deps",
          writeStderrLine: (message) => stderrLines.push(message),
        }),
      ),
    ).rejects.toThrow("graph query exit 2");

    expect(stderrLines).toEqual(["Usage: deps <file> [--depth N] [--json]"]);
  });

  test("rejects invalid graph query depth values before scanning the graph", async () => {
    const projectRoot = path.join(os.tmpdir(), "codegraph-query-depth").replace(/\\/g, "/");
    const invalidDepths = ["foo", "-1", "1.5"];

    for (const invalidDepth of invalidDepths) {
      const stderrLines: string[] = [];
      let scanned = false;

      await expect(
        handleGraphQueryCommand(
          createGraphQueryContext({
            command: "deps",
            positionals: ["main.ts"],
            projectRootFs: projectRoot,
            projectRootAbs: projectRoot,
            getOpt: (name) => (name === "--depth" ? invalidDepth : undefined),
            writeStderrLine: (message) => stderrLines.push(message),
            collectGraph: async () => {
              scanned = true;
              return { nodes: new Set(), edges: [] };
            },
          }),
        ),
      ).rejects.toThrow("graph query exit 2");

      expect(stderrLines).toEqual([`Invalid --depth value "${invalidDepth}". Expected a non-negative integer.`]);
      expect(scanned).toBe(false);
    }
  });

  test("writes text errors for graph query files outside the project root", async () => {
    const projectRoot = path.join(os.tmpdir(), "codegraph-query-root").replace(/\\/g, "/");
    const stdoutLines: string[] = [];

    await handleGraphQueryCommand(
      createGraphQueryContext({
        command: "rdeps",
        positionals: ["../outside.ts"],
        projectRootFs: projectRoot,
        projectRootAbs: projectRoot,
        writeStdoutLine: (message) => stdoutLines.push(message),
      }),
    );

    expect(stdoutLines).toHaveLength(1);
    expect(stdoutLines[0]).toContain("error: outside_project_root:");
    expect(stdoutLines[0]).toContain("outside.ts");
  });

  test("writes null JSON when no graph path exists", async () => {
    const projectRoot = path.join(os.tmpdir(), "codegraph-query-path").replace(/\\/g, "/");
    const fromPath = `${projectRoot}/from.ts`;
    const toPath = `${projectRoot}/to.ts`;
    const jsonLines: unknown[] = [];

    await handleGraphQueryCommand(
      createGraphQueryContext({
        command: "path",
        positionals: ["from.ts", "to.ts"],
        projectRootFs: projectRoot,
        projectRootAbs: projectRoot,
        hasFlag: (name) => name === "--json",
        writeJSONLine: (value) => jsonLines.push(value),
        collectGraph: async (): Promise<Graph> => ({
          nodes: new Set([fromPath, toPath]),
          edges: [],
        }),
      }),
    );

    expect(jsonLines).toEqual([null]);
  });

  test("rejects invalid cycle sort modes before scanning the graph", async () => {
    const stderrLines: string[] = [];

    await expect(
      handleGraphQueryCommand(
        createGraphQueryContext({
          command: "cycles",
          getOpt: (name) => (name === "--sort" ? "recent" : undefined),
          writeStderrLine: (message) => stderrLines.push(message),
        }),
      ),
    ).rejects.toThrow("graph query exit 2");

    expect(stderrLines).toEqual(["Invalid --sort value. Use one of: priority, size, fanin."]);
  });

  test("writes unresolved imports as JSON through the graph query handler", async () => {
    const projectRoot = path.join(os.tmpdir(), "codegraph-query-unresolved").replace(/\\/g, "/");
    const mainPath = `${projectRoot}/main.ts`;
    const jsonLines: unknown[] = [];

    await handleGraphQueryCommand(
      createGraphQueryContext({
        command: "unresolved",
        projectRootFs: projectRoot,
        projectRootAbs: projectRoot,
        hasFlag: (name) => name === "--json",
        writeJSONLine: (value) => jsonLines.push(value),
        collectGraph: async (): Promise<Graph> => ({
          nodes: new Set([mainPath]),
          edges: [
            {
              from: mainPath,
              to: { type: "external", name: "missing-pkg" },
              raw: "missing-pkg",
            },
          ],
        }),
      }),
    );

    const unresolved = readJsonArray(jsonLines[0]).map(readJsonRecord);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.name).toBe("missing-pkg");
    expect(JSON.stringify(unresolved[0]?.importers)).toContain("main.ts");
  });

  test("defaults the extracted skill command to doctor output", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-skill-module-"));
    const targetDir = path.join(tempDir, "skills", "codegraph");
    await fsp.mkdir(path.dirname(targetDir), { recursive: true });
    const jsonLines: unknown[] = [];

    try {
      await handleSkillCommand({
        positionals: [],
        getOpt: (name) => (name === "--target" ? targetDir : undefined),
        hasFlag: () => false,
        writeJSONLine: (value) => jsonLines.push(value),
        writeStdoutLine: () => {
          throw new Error("unexpected stdout");
        },
        writeStderrLine: () => {
          throw new Error("unexpected stderr");
        },
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
      });

      const report = readJsonRecord(jsonLines[0]);
      expect(report.installTargetDir).toBe(targetDir.replace(/\\/g, "/"));
      expect(report.installedSkill).toMatchObject({
        targetDirExists: false,
        skillFilePresent: false,
      });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("prints the bundled skill path through the extracted skill command", async () => {
    const stdoutLines: string[] = [];

    await handleSkillCommand(
      createSkillContext({
        positionals: ["print-path"],
        writeStdoutLine: (message) => stdoutLines.push(message),
      }),
    );

    expect(stdoutLines).toHaveLength(1);
    expect(stdoutLines[0]).toContain("codegraph-skill/codegraph");
  });

  test("prints skill usage for unknown subcommands", async () => {
    const stderrLines: string[] = [];

    await expect(
      handleSkillCommand(
        createSkillContext({
          positionals: ["remove"],
          writeStderrLine: (message) => stderrLines.push(message),
        }),
      ),
    ).rejects.toThrow("skill exit 2");

    expect(stderrLines).toEqual([
      "Usage: codegraph skill <install|print-path|doctor> [--agent <name> | --target <dir>] [--force]",
    ]);
  });

  test("rejects invalid skill agents and conflicting install targets", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-skill-invalid-"));
    const targetDir = path.join(tempDir, "skills", "codegraph");

    try {
      await expect(
        handleSkillCommand(
          createSkillContext({
            positionals: ["doctor"],
            getOpt: (name) => (name === "--agent" ? "unknown-agent" : undefined),
          }),
        ),
      ).rejects.toThrow('Invalid --agent value "unknown-agent"');

      await expect(
        handleSkillCommand(
          createSkillContext({
            positionals: ["install"],
            getOpt: (name) => {
              if (name === "--agent") return "codex";
              if (name === "--target") return targetDir;
              return undefined;
            },
          }),
        ),
      ).rejects.toThrow("Use either --target or --agent for skill install, not both.");
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});
