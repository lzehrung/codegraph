import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { MAX_FILE_VIEW_BYTES, MAX_FILE_VIEW_LINES } from "../src/agent/fileView.js";
import { handleChunkCommand, type ChunkCommandContext } from "../src/cli/chunk.js";
import type { CliAgentCommandContext } from "../src/cli/context.js";
import { maybeWriteNativeBackendStatus, runWithCliRuntime } from "../src/cli/context.js";
import { buildDoctorReport, findStaleNpmRetirementPaths } from "../src/cli/doctor.js";
import { handleGraphCommand, type GraphCommandContext } from "../src/cli/graph.js";
import { handleGraphDeltaCommand } from "../src/cli/graphDelta.js";
import { handleGraphQueryCommand, type GraphQueryCommandContext } from "../src/cli/graphQueries.js";
import {
  CLI_HELP_TEXT,
  FILE_HELP_TEXT,
  MCP_SERVE_HELP_TEXT,
  PACKET_HELP_TEXT,
  SQL_HELP_TEXT,
} from "../src/cli/help.js";
import { handleImpactCommand, type ImpactCommandContext } from "../src/cli/impact.js";
import { handleIndexCommand, type IndexCommandContext } from "../src/cli/index.js";
import { handleHotspotsCommand, handleInspectCommand, type InspectCommandContext } from "../src/cli/inspect.js";
import {
  handleDumpmodCommand,
  handleGotoCommand,
  handleRefsCommand,
  type NavigationCommandContext,
} from "../src/cli/navigation.js";
import { getCodegraphPackageIdentity, getCodegraphVersion } from "../src/util/packageInfo.js";
import { handlePacketCommand } from "../src/cli/packet.js";
import { handleGrepCommand } from "../src/cli/grep.js";
import { TEXT_GREP_MAX_HITS, textGrepBounded } from "../src/graphs/grep.js";
import { handleSearchCommand } from "../src/cli/search.js";
import { handleSkillCommand, type SkillCommandContext } from "../src/cli/skill.js";
import { handleSqlCommand } from "../src/cli/sql.js";
import { runCli } from "../src/cli.js";
import { captureCli } from "./helpers/cli.js";
import * as indexerBuild from "../src/indexer/build-index.js";
import { diffBuildOptions, summarizeBuildOptions } from "../src/indexer/build-cache.js";
import type { ProjectIndex } from "../src/indexer.js";
import type { BuildOptions, BuildReport, NativeBackendReport } from "../src/indexer/types.js";
import { getNativeRuntimeFingerprint } from "../src/native/treeSitterNative.js";
import type { Graph } from "../src/types.js";
import { runGit } from "./helpers/git.js";
import { createTwoCommitCycleProject, mkTmpDir } from "./helpers/filesystem.js";
import { fileIdentityKey } from "../src/util/paths.js";
import * as mcpServer from "../src/mcp/server.js";
import * as projectFilesModule from "../src/util/projectFiles.js";

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
    hasFlag: (name) => name === "--json",
    cwd: () => process.cwd(),
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
    hasFlag: (name) => name === "--json",
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
    hasFlag: (name) => name === "--json",
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
    hasFlag: (name) => name === "--json",
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
    hasFlag: (name) => name === "--json",
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

function createIndexContext(overrides: Partial<IndexCommandContext>): IndexCommandContext {
  const projectRoot = path.join(os.tmpdir(), "codegraph-index-context").replace(/\\/g, "/");
  return {
    projectRootFs: projectRoot,
    includeRootsAbs: [projectRoot],
    gitBase: undefined,
    changedSince: undefined,
    discoveryOptions: {},
    nativeMode: "auto",
    languageExtensions: undefined,
    workerOpts: {},
    progressHandler: undefined,
    graphOptions: undefined,
    reportEnabled: false,
    reportFile: undefined,
    showProgress: false,
    getOpt: (name) => (name === "--cache" ? "off" : undefined),
    hasFlag: () => false,
    resolveFiles: async () => [],
    writeJSONLine: () => {
      throw new Error("unexpected json output");
    },
    writeStdoutLine: () => {
      throw new Error("unexpected stdout");
    },
    writeStderrLine: () => {
      throw new Error("unexpected stderr");
    },
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
    loadCurrentIndex: async () => {
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
    hasFlag: (name) => name === "--json",
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

  test("documents --pretty for both SQL command forms", () => {
    expect(SQL_HELP_TEXT).toContain('codegraph sql --db <sqlite-path> --query "SELECT ..." [--json | --pretty]');
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
    const orientIndex = unfamiliarRepoGuidance.indexOf("codegraph orient --root . --budget small");

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
    expect(MCP_SERVE_HELP_TEXT).toContain(
      "goto            Go to definition by handle, qualified symbol path, or file position",
    );
    expect(MCP_SERVE_HELP_TEXT).toContain(
      "deps            List file dependencies by file, qualified symbol path, or handle",
    );
  });

  test("packet help documents accepted target shapes", () => {
    expect(PACKET_HELP_TEXT).toContain("file paths, symbol names, SQL object names");
    expect(PACKET_HELP_TEXT).toContain("file:/symbol:/chunk:/sql:/graph: handles");
    expect(PACKET_HELP_TEXT).not.toContain("CLI orient returns file handles");
  });

  test("install and uninstall help document --json/--pretty and install documents --force", async () => {
    for (const command of ["install", "uninstall"]) {
      const result = await captureCli([command, "--help"]);

      expect(result.exitCode, command).toBeUndefined();
      expect(result.stderr, command).toBe("");
      expect(result.stdout, command).toContain(`Usage: codegraph ${command}`);
      expect(result.stdout, command).toContain("--json");
      expect(result.stdout, command).toContain("--pretty");
    }
    const installHelp = await captureCli(["install", "--help"]);
    expect(installHelp.stdout).toContain("--force");
    expect(installHelp.stdout).toMatch(/re-run with --force/i);
  });

  test("top-level help documents human defaults and JSON opt-in", async () => {
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
    expect(outputSection).toContain("--pretty");
    expect(outputSection).toContain("Human-readable output (default)");
    expect(outputSection).toContain("--json");
    expect(outputSection).toContain("Structured JSON output for automation");
    expect(outputSection).not.toContain("JSON (default)");
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
          positionals: ["show", "target"],
          writeStderrLine: (message) => stderr.push(message),
        }),
      ),
    ).rejects.toThrow("agent command exit 2");

    expect(stderr.join("\n")).toContain("Usage: codegraph packet [get] <target>");
  });

  test("goto command validates a missing target before indexing", async () => {
    const stderr: string[] = [];

    await expect(
      handleGotoCommand(
        createNavigationContext({
          positionals: [],
          writeStderrLine: (message) => stderr.push(message),
        }),
      ),
    ).rejects.toThrow("navigation exit 2");

    expect(stderr).toEqual(["Usage: goto <file>[:line[:column]] [line] [column]"]);
  });
  test("goto pretty output renders a concise definition summary", async () => {
    const root = await mkTmpDir("codegraph-goto-pretty-");
    const utilsPath = path.join(root, "utils.ts");
    const mainPath = path.join(root, "main.ts");
    await fsp.writeFile(utilsPath, "export function helper() {\n  return 1;\n}\n", "utf8");
    await fsp.writeFile(mainPath, 'import { helper } from "./utils";\nhelper();\n', "utf8");
    const stdout: string[] = [];

    try {
      await handleGotoCommand(
        createNavigationContext({
          projectRootFs: root,
          positionals: [mainPath, "2", "1"],
          getOpt: (name) => (name === "--cache" ? "off" : undefined),
          hasFlag: () => false,
          writeStdoutLine: (message) => stdout.push(message),
        }),
      );

      expect(stdout).toHaveLength(1);
      expect(stdout[0]).toContain("utils.ts:1:");
      expect(stdout[0]).toContain("function helper");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("navigation commands forward --cache-verify to incremental index builds", async () => {
    const emptyIndex: ProjectIndex = {
      graph: { nodes: new Set<string>(), edges: [] },
      modules: new Map(),
      byFile: new Map(),
      exportCache: new Map(),
      scopeCache: new Map(),
    };
    const root = await mkTmpDir("codegraph-navigation-cache-verify-");
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockResolvedValue(emptyIndex);
    try {
      await expect(
        handleGotoCommand(
          createNavigationContext({
            projectRootFs: root,
            positionals: [path.join(root, "main.ts"), "1", "1"],
            hasFlag: (name) => name === "--json" || name === "--cache-verify",
            writeJSONLine: () => undefined,
          }),
        ),
      ).rejects.toThrow("navigation exit 1");

      expect(buildSpy.mock.calls[0]?.[1]?.cacheVerify).toBe(true);
    } finally {
      buildSpy.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("goto command reuses the on-disk manifest on a second invocation without a full recursive scan", async () => {
    const root = await mkTmpDir("codegraph-goto-manifest-reuse-");
    const filePath = path.join(root, "main.ts");
    await fsp.writeFile(filePath, "export const value = 1;\n", "utf8");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "tests@example.com"]);
    runGit(root, ["config", "user.name", "Tests"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "base"]);

    const results: unknown[] = [];
    const context = createNavigationContext({
      projectRootFs: root,
      positionals: [filePath, "1", "14"],
      writeJSONLine: (value) => results.push(value),
    });

    await handleGotoCommand(context);
    const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");
    try {
      await handleGotoCommand(context);

      expect(results).toHaveLength(2);
      expect(scanSpy).not.toHaveBeenCalled();
    } finally {
      scanSpy.mockRestore();
    }
  });

  test("refs command reuses the on-disk manifest on a second invocation without a full recursive scan", async () => {
    const root = await mkTmpDir("codegraph-refs-manifest-reuse-");
    const filePath = path.join(root, "main.ts");
    await fsp.writeFile(filePath, "export const value = 1;\n", "utf8");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "tests@example.com"]);
    runGit(root, ["config", "user.name", "Tests"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "base"]);

    const results: unknown[] = [];
    const context = createNavigationContext({
      projectRootFs: root,
      getOpt: (name) => {
        if (name === "--file") return filePath;
        if (name === "--line") return "1";
        if (name === "--col") return "14";
        return undefined;
      },
      writeJSONLine: (value) => results.push(value),
    });

    await handleRefsCommand(context);
    const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");
    try {
      await handleRefsCommand(context);

      expect(results).toHaveLength(2);
      expect(scanSpy).not.toHaveBeenCalled();
    } finally {
      scanSpy.mockRestore();
    }
  });
  test("dumpmod preserves imports in JSON output", async () => {
    const root = await mkTmpDir("codegraph-dumpmod-json-");
    const mainPath = path.join(root, "main.ts");
    const depPath = path.join(root, "dep.ts");
    await fsp.writeFile(depPath, "export const dep = 1;\n", "utf8");
    await fsp.writeFile(mainPath, 'import { dep } from "./dep";\nexport const value = dep;\n', "utf8");
    const jsonLines: unknown[] = [];

    try {
      await handleDumpmodCommand(
        createNavigationContext({
          projectRootFs: root,
          positionals: [mainPath],
          getOpt: (name) => (name === "--cache" ? "off" : undefined),
          hasFlag: (name) => name === "--json",
          writeJSONLine: (value) => jsonLines.push(value),
        }),
      );

      const output = readJsonRecord(jsonLines[0]);
      const imports = readJsonArray(output.imports);
      expect(imports.length).toBeGreaterThan(0);
      expect(JSON.stringify(imports[0])).toContain("./dep");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  test("grep pretty output streams one hit at a time", async () => {
    const root = await mkTmpDir("codegraph-grep-stream-");
    const mainPath = path.join(root, "main.ts");
    await fsp.writeFile(mainPath, "export function helperFunction() {\n  return 1;\n}\nhelperFunction();\n", "utf8");
    const stdoutLines: string[] = [];

    try {
      await handleGrepCommand({
        positionals: ["helperFunction"],
        projectRootFs: root,
        discoveryOptions: {},
        parsedOptions: new Map(),
        getOpt: () => undefined,
        hasFlag: () => false,
        writeJSONLine: () => {
          throw new Error("unexpected json output");
        },
        writeStdoutLine: (message) => stdoutLines.push(message),
        writeStderrLine: (message) => {
          throw new Error(`unexpected stderr: ${message}`);
        },
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
      });

      expect(stdoutLines.length).toBeGreaterThan(1);
      expect(stdoutLines[0]).toContain(".ts:");
      expect(stdoutLines[0]).toContain("helperFunction");
      expect(stdoutLines[0]).toContain("\n  ");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("grep --json wraps text hits in a truncation envelope with an exact truncated flag", async () => {
    const root = await mkTmpDir("codegraph-grep-envelope-");
    const mainPath = path.join(root, "main.ts");
    await fsp.writeFile(
      mainPath,
      "export function needleFn() {\n  return 1;\n}\nneedleFn();\nconst alias = needleFn;\n",
      "utf8",
    );
    const jsonLines: unknown[] = [];
    const runGrep = async (maxHits: string | undefined): Promise<Record<string, unknown>> => {
      jsonLines.length = 0;
      await handleGrepCommand({
        positionals: ["needleFn"],
        projectRootFs: root,
        discoveryOptions: {},
        parsedOptions: new Map(),
        getOpt: (name) => (name === "--max-hits" ? maxHits : undefined),
        hasFlag: (name) => name === "--json",
        writeJSONLine: (value) => jsonLines.push(value),
        writeStdoutLine: () => {
          throw new Error("unexpected stdout");
        },
        writeStderrLine: (message) => {
          throw new Error(`unexpected stderr: ${message}`);
        },
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
      });
      return readJsonRecord(jsonLines[0]);
    };

    try {
      const capped = await runGrep("1");
      expect(readJsonArray(capped.items)).toHaveLength(1);
      expect(capped.limit).toBe(1);
      expect(capped.truncated).toBe(true);
      expect(capped.totalSeen).toBe(2);
      expect(capped.omitted).toBe(1);

      // Exactly-at-limit must read as complete: the scan probes one hit past
      // the cap, so a true count equal to the limit is not confused with "more exist".
      const atLimit = await runGrep("3");
      expect(readJsonArray(atLimit.items)).toHaveLength(3);
      expect(atLimit.truncated).toBe(false);
      expect(atLimit.totalSeen).toBe(3);
      expect(atLimit.omitted).toBe(0);

      const complete = await runGrep(undefined);
      const items = readJsonArray(complete.items);
      expect(items).toHaveLength(3);
      expect(complete.limit).toBe(5000);
      expect(complete.truncated).toBe(false);
      expect(complete.totalSeen).toBe(3);
      expect(complete.omitted).toBe(0);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
  test("textGrepBounded returns an empty, truncated page for maxHits: 0", async () => {
    const root = await mkTmpDir("codegraph-grep-zero-limit-");
    await fsp.writeFile(path.join(root, "main.ts"), "needle\n", "utf8");
    try {
      const envelope = await textGrepBounded(root, "needle", ["**/*.ts"], { maxHits: 0 });
      expect(envelope).toEqual({
        items: [],
        limit: 0,
        totalSeen: 1,
        truncated: true,
        omitted: 1,
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("grep rejects max-hits values above the 200000 cap with exit 2 (usage error)", async () => {
    const root = await mkTmpDir("codegraph-grep-clamped-limit-");
    await fsp.writeFile(path.join(root, "main.ts"), "needle\n", "utf8");
    const stderrLines: string[] = [];
    try {
      await expect(
        handleGrepCommand({
          positionals: ["needle"],
          projectRootFs: root,
          discoveryOptions: {},
          parsedOptions: new Map(),
          getOpt: (name) => (name === "--max-hits" ? String(TEXT_GREP_MAX_HITS + 1) : undefined),
          hasFlag: (name) => name === "--json",
          writeJSONLine: () => {
            throw new Error("unexpected json output");
          },
          writeStdoutLine: () => {
            throw new Error("unexpected stdout");
          },
          writeStderrLine: (message) => stderrLines.push(message),
          exit: (code) => {
            throw new Error(`grep exit ${code}`);
          },
        }),
      ).rejects.toThrow("grep exit 2");

      expect(stderrLines).toEqual(['Invalid --max-hits value "200001". Expected an integer from 1 to 200000.']);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("textGrepBounded treats exactly 200000 hits as complete", async () => {
    const root = await mkTmpDir("codegraph-grep-exact-ceiling-");
    await fsp.writeFile(path.join(root, "main.ts"), "x\n".repeat(TEXT_GREP_MAX_HITS), "utf8");
    try {
      const envelope = await textGrepBounded(root, "^x$", ["**/*.ts"], { maxHits: TEXT_GREP_MAX_HITS });
      expect(envelope.limit).toBe(TEXT_GREP_MAX_HITS);
      expect(envelope.totalSeen).toBe(TEXT_GREP_MAX_HITS);
      expect(envelope.truncated).toBe(false);
      expect(envelope.omitted).toBe(0);
      expect(envelope.items).toHaveLength(TEXT_GREP_MAX_HITS);
      expect(envelope.items[0]).toEqual({
        file: "main.ts",
        line: 1,
        column: 1,
        match: "x",
        snippet: "x",
      });
      expect(envelope.items[TEXT_GREP_MAX_HITS - 1]).toEqual({
        file: "main.ts",
        line: TEXT_GREP_MAX_HITS,
        column: 1,
        match: "x",
        snippet: "x",
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("textGrepBounded reports truncated:true at the 200_000 hit ceiling when more hits exist", async () => {
    const root = await mkTmpDir("codegraph-grep-ceiling-");
    const filePath = path.join(root, "main.ts");
    await fsp.writeFile(filePath, `${"x\n".repeat(TEXT_GREP_MAX_HITS + 1)}`, "utf8");
    try {
      const envelope = await textGrepBounded(root, "^x$", ["**/*.ts"], { maxHits: TEXT_GREP_MAX_HITS });
      expect(envelope.limit).toBe(TEXT_GREP_MAX_HITS);
      expect(envelope.truncated).toBe(true);
      expect(envelope.totalSeen).toBe(TEXT_GREP_MAX_HITS + 1);
      expect(envelope.items).toHaveLength(TEXT_GREP_MAX_HITS);
      expect(envelope.omitted).toBe(1);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("grep --json --query wraps AST hits in a complete envelope", async () => {
    const root = await mkTmpDir("codegraph-grep-ast-envelope-");
    const mainPath = path.join(root, "main.ts");
    await fsp.writeFile(mainPath, "export function helperFunction() {\n  return 1;\n}\nhelperFunction();\n", "utf8");
    const jsonLines: unknown[] = [];

    try {
      await handleGrepCommand({
        positionals: [],
        projectRootFs: root,
        discoveryOptions: {},
        parsedOptions: new Map(),
        getOpt: (name) => (name === "--query" ? "(identifier) @id" : undefined),
        hasFlag: (name) => name === "--json",
        writeJSONLine: (value) => jsonLines.push(value),
        writeStdoutLine: () => {
          throw new Error("unexpected stdout");
        },
        writeStderrLine: (message) => {
          throw new Error(`unexpected stderr: ${message}`);
        },
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
      });

      const envelope = readJsonRecord(jsonLines[0]);
      const items = readJsonArray(envelope.items);
      expect(items.length).toBeGreaterThan(0);
      // astGrep has no result cap: limit is null and the envelope is always complete.
      expect(envelope.limit).toBeNull();
      expect(envelope.truncated).toBe(false);
      expect(envelope.omitted).toBe(0);
      expect(envelope.totalSeen).toBe(items.length);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("graph --json carries analysis metadata and wires the backend warning independent of progress", async () => {
    const root = await mkTmpDir("codegraph-graph-analysis-");
    const entryFile = path.join(root, "entry.ts");
    await fsp.writeFile(entryFile, "export const value = 1;\n", "utf8");
    const stdout: string[] = [];
    const backendCalls: Array<{ report: BuildReport | undefined; showProgress: boolean }> = [];

    await handleGraphCommand(
      createGraphContext({
        projectRootFs: root,
        cwd: () => root,
        nativeMode: "off",
        resolveFiles: async () => [entryFile.replace(/\\/g, "/")],
        hasFlag: (name) => name === "--stdout" || name === "--json",
        writeStdoutLine: (message) => stdout.push(message),
        maybeWriteNativeBackendStatus: (report, showProgress) => {
          backendCalls.push({ report, showProgress });
        },
      }),
    );

    const graph = readJsonRecord(JSON.parse(stdout[0] ?? "{}"));
    const analysis = readJsonRecord(graph.analysis);
    expect(analysis.mode).toBe("reduced");
    expect(analysis.backend).toBe("graph-only");
    expect(typeof analysis.label).toBe("string");
    expect(backendCalls).toHaveLength(1);
    expect(backendCalls[0]?.showProgress).toBe(false);
    expect(backendCalls[0]?.report).toBeDefined();
  });

  test("graph human output keeps the mermaid contract and still wires the backend warning without progress", async () => {
    const root = await mkTmpDir("codegraph-graph-analysis-human-");
    const entryFile = path.join(root, "entry.ts");
    await fsp.writeFile(entryFile, "export const value = 1;\n", "utf8");
    const stdout: string[] = [];
    const backendCalls: Array<{ report: BuildReport | undefined; showProgress: boolean }> = [];

    await handleGraphCommand(
      createGraphContext({
        projectRootFs: root,
        cwd: () => root,
        nativeMode: "off",
        resolveFiles: async () => [entryFile.replace(/\\/g, "/")],
        hasFlag: () => false,
        writeStdoutLine: (message) => stdout.push(message),
        maybeWriteNativeBackendStatus: (report, showProgress) => {
          backendCalls.push({ report, showProgress });
        },
      }),
    );

    // Human graph output stays mermaid; the degradation signal for this mode is the
    // stderr warning emitted through the backend-status hook, which must fire even
    // though --progress was not requested.
    expect(stdout[0]).toContain("flowchart");
    expect(backendCalls).toHaveLength(1);
    expect(backendCalls[0]?.showProgress).toBe(false);
    expect(backendCalls[0]?.report?.backend?.native.filesFellBack).toBeGreaterThan(0);
  });

  test("index pretty and JSON output advertise reduced analysis when native parsing is off", async () => {
    const root = await mkTmpDir("codegraph-index-analysis-");
    const entryFile = path.join(root, "entry.ts");
    await fsp.writeFile(entryFile, "export const value = 1;\n", "utf8");
    const resolvedFiles = [entryFile.replace(/\\/g, "/")];
    const backendCalls: Array<{ report: BuildReport | undefined; showProgress: boolean }> = [];
    const recordBackendCall = (report: BuildReport | undefined, showProgress: boolean): void => {
      backendCalls.push({ report, showProgress });
    };

    try {
      const prettyLines: string[] = [];
      await handleIndexCommand(
        createIndexContext({
          projectRootFs: root,
          includeRootsAbs: [root],
          nativeMode: "off",
          resolveFiles: async () => resolvedFiles,
          writeStdoutLine: (message) => prettyLines.push(message),
          maybeWriteNativeBackendStatus: recordBackendCall,
        }),
      );
      expect(prettyLines[0]).toContain("Indexed 1 file(s)");
      expect(prettyLines[0]).toContain("Analysis: reduced graph-only.");

      const jsonLines: unknown[] = [];
      await handleIndexCommand(
        createIndexContext({
          projectRootFs: root,
          includeRootsAbs: [root],
          nativeMode: "off",
          resolveFiles: async () => resolvedFiles,
          hasFlag: (name) => name === "--json",
          writeJSONLine: (value) => jsonLines.push(value),
          maybeWriteNativeBackendStatus: recordBackendCall,
        }),
      );
      const output = readJsonRecord(jsonLines[0]);
      const analysis = readJsonRecord(output.analysis);
      expect(analysis.mode).toBe("reduced");
      expect(analysis.backend).toBe("graph-only");

      // Both runs consulted the backend-status hook with showProgress off, so the
      // degradation warning decision never depends on progress rendering.
      expect(backendCalls).toHaveLength(2);
      expect(backendCalls.every((call) => !call.showProgress && call.report !== undefined)).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("index pretty output only prints an Analysis line when the JSON analysis mode is reduced or mixed", async () => {
    const root = await mkTmpDir("codegraph-index-analysis-normal-");
    const entryFile = path.join(root, "entry.ts");
    await fsp.writeFile(entryFile, "export const value = 1;\n", "utf8");
    const resolvedFiles = [entryFile.replace(/\\/g, "/")];

    try {
      const jsonLines: unknown[] = [];
      await handleIndexCommand(
        createIndexContext({
          projectRootFs: root,
          includeRootsAbs: [root],
          resolveFiles: async () => resolvedFiles,
          hasFlag: (name) => name === "--json",
          writeJSONLine: (value) => jsonLines.push(value),
        }),
      );
      const analysis = readJsonRecord(readJsonRecord(jsonLines[0]).analysis);
      expect(["semantic", "mixed", "reduced"]).toContain(analysis.mode);

      const prettyLines: string[] = [];
      await handleIndexCommand(
        createIndexContext({
          projectRootFs: root,
          includeRootsAbs: [root],
          resolveFiles: async () => resolvedFiles,
          writeStdoutLine: (message) => prettyLines.push(message),
        }),
      );
      expect(prettyLines[0]).toContain("Indexed 1 file(s)");
      if (analysis.mode === "semantic") {
        // Normal native runs keep the prior one-line output contract.
        expect(prettyLines[0]).not.toContain("Analysis:");
      } else {
        expect(prettyLines[0]).toContain(`Analysis: ${String(analysis.label)}.`);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  describe("maybeWriteNativeBackendStatus", () => {
    const reportWithNative = (overrides: Partial<NativeBackendReport>): BuildReport => ({
      timings: {},
      backend: {
        native: {
          available: true,
          enabled: true,
          supportedLanguageIds: ["typescript"],
          filesUsed: 3,
          filesFellBack: 0,
          fallbackReasons: { unavailable: 0, unsupportedLanguage: 0, queryFailure: 0 },
          byLanguage: {},
          errors: [],
          ...overrides,
        },
      },
    });

    const captureStderr = async (report: BuildReport, showProgress: boolean): Promise<string> => {
      const chunks: string[] = [];
      await runWithCliRuntime({ stderr: (chunk) => chunks.push(chunk) }, async () => {
        maybeWriteNativeBackendStatus(report, showProgress);
      });
      return chunks.join("");
    };

    test("warns when the native addon is unavailable, even without --progress", async () => {
      const stderr = await captureStderr(
        reportWithNative({ available: false, enabled: false, filesUsed: 0, loadError: "MODULE_NOT_FOUND" }),
        false,
      );
      expect(stderr).toContain("Backend: reduced graph/regex mode");
      expect(stderr).toContain("native addon unavailable");
      expect(stderr).toContain("MODULE_NOT_FOUND");
    });

    test("warns when files fell back from native parsing, even without --progress", async () => {
      const stderr = await captureStderr(reportWithNative({ filesUsed: 5, filesFellBack: 2 }), false);
      expect(stderr).toContain("native tree-sitter used for 5 file(s)");
      expect(stderr).toContain("fallback for 2 file(s)");
    });

    test("stays silent for a healthy native backend without --progress", async () => {
      const stderr = await captureStderr(reportWithNative({}), false);
      expect(stderr).toBe("");
    });

    test("prints the backend status line for a healthy native backend with --progress", async () => {
      const stderr = await captureStderr(reportWithNative({}), true);
      expect(stderr).toContain("Backend: native tree-sitter used for 3 file(s)");
    });
  });

  test("impact command reuses the on-disk manifest on a second invocation without a full recursive scan", async () => {
    const root = await mkTmpDir("codegraph-impact-manifest-reuse-");
    const sourcePath = path.join(root, "feature.ts");
    await fsp.writeFile(sourcePath, "export function feature() {\n  return 2;\n}\n", "utf8");
    runGit(root, ["init"]);
    runGit(root, ["config", "user.email", "tests@example.com"]);
    runGit(root, ["config", "user.name", "Tests"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-m", "base"]);
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

    const context = createImpactContext({
      projectRootFs: root,
      readStdin: async () => diffText,
      writeJSONLine: () => undefined,
    });

    await handleImpactCommand(context);
    const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");
    try {
      await handleImpactCommand(context);

      expect(scanSpy).not.toHaveBeenCalled();
    } finally {
      scanSpy.mockRestore();
    }
  });

  test("graph command can write JSON to stdout without default files", async () => {
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
    expect(readJsonArray(graph.files)).toContain(entryFile.replace(/\\/g, "/"));
    expect(stderrFiles).toEqual([undefined]);
  });

  test("graph --sqlite forwards cache directory options to full index builds", async () => {
    const root = await mkTmpDir("codegraph-graph-sqlite-cache-");
    const entryFile = path.join(root, "entry.ts");
    const sqliteFile = path.join(root, "graph.sqlite");
    const cacheDir = path.join(root, "cache");
    await fsp.writeFile(entryFile, "export const value = 1;\n", "utf8");
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexFromFiles");

    try {
      await handleGraphCommand(
        createGraphContext({
          projectRootFs: root,
          cwd: () => root,
          nativeMode: "off",
          resolveFiles: async () => [entryFile.replace(/\\/g, "/")],
          getOpt: (name) => {
            if (name === "--cache") return "memory";
            if (name === "--cache-dir") return cacheDir;
            if (name === "--sqlite") return sqliteFile;
            return undefined;
          },
          hasFlag: (name) => name === "--cache-verify",
        }),
      );

      expect(buildSpy).toHaveBeenCalledOnce();
      expect(buildSpy).toHaveBeenCalledWith(
        root,
        [entryFile.replace(/\\/g, "/")],
        expect.objectContaining({ cache: "memory", cacheDir, cacheVerify: true }),
      );
      expect(fs.existsSync(sqliteFile)).toBe(true);
    } finally {
      buildSpy.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("graph --sqlite uses disk cache for verification without an explicit cache mode", async () => {
    const root = await mkTmpDir("codegraph-graph-sqlite-cache-verify-");
    const entryFile = path.join(root, "entry.ts");
    const sqliteFile = path.join(root, "graph.sqlite");
    await fsp.writeFile(entryFile, "export const value = 1;\n", "utf8");
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexFromFiles");

    try {
      await handleGraphCommand(
        createGraphContext({
          projectRootFs: root,
          cwd: () => root,
          nativeMode: "off",
          resolveFiles: async () => [entryFile.replace(/\\/g, "/")],
          getOpt: (name) => (name === "--sqlite" ? sqliteFile : undefined),
          hasFlag: (name) => name === "--cache-verify",
        }),
      );

      expect(buildSpy).toHaveBeenCalledOnce();
      expect(buildSpy).toHaveBeenCalledWith(
        root,
        [entryFile.replace(/\\/g, "/")],
        expect.objectContaining({ cache: "disk", cacheVerify: true }),
      );
    } finally {
      buildSpy.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("graph --symbols forwards the requested cache mode to its full index build", async () => {
    const root = await mkTmpDir("codegraph-graph-symbols-cache-");
    const entryFile = path.join(root, "entry.ts");
    await fsp.writeFile(entryFile, "export const value = 1;\n", "utf8");
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexFromFiles");

    try {
      await handleGraphCommand(
        createGraphContext({
          projectRootFs: root,
          cwd: () => root,
          nativeMode: "off",
          resolveFiles: async () => [entryFile.replace(/\\/g, "/")],
          getOpt: (name) => (name === "--cache" ? "memory" : undefined),
          hasFlag: (name) => name === "--symbols" || name === "--json",
          writeStdoutLine: () => undefined,
        }),
      );

      expect(buildSpy).toHaveBeenCalledOnce();
      expect(buildSpy).toHaveBeenCalledWith(
        root,
        [entryFile.replace(/\\/g, "/")],
        expect.objectContaining({ cache: "memory" }),
      );
    } finally {
      buildSpy.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("graph --symbols uses disk cache for verification without an explicit cache mode", async () => {
    const root = await mkTmpDir("codegraph-graph-symbols-cache-verify-");
    const entryFile = path.join(root, "entry.ts");
    await fsp.writeFile(entryFile, "export const value = 1;\n", "utf8");
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexFromFiles");

    try {
      await handleGraphCommand(
        createGraphContext({
          projectRootFs: root,
          cwd: () => root,
          nativeMode: "off",
          resolveFiles: async () => [entryFile.replace(/\\/g, "/")],
          hasFlag: (name) => name === "--symbols" || name === "--json" || name === "--cache-verify",
          writeStdoutLine: () => undefined,
        }),
      );

      expect(buildSpy).toHaveBeenCalledOnce();
      expect(buildSpy).toHaveBeenCalledWith(
        root,
        [entryFile.replace(/\\/g, "/")],
        expect.objectContaining({ cache: "disk", cacheVerify: true }),
      );
    } finally {
      buildSpy.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
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
        usage: "Usage: codegraph packet [get] <target>",
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

      { args: ["index", "--help"], heading: "codegraph index", usage: "Usage: codegraph index" },
      { args: ["review", "--help"], heading: "codegraph review", usage: "Usage: codegraph review" },
      {
        args: ["deps", "--help"],
        heading: "codegraph deps",
        usage: "Usage: codegraph deps <file|file::symbol|symbol:...>",
      },
      { args: ["artifact", "--help"], heading: "codegraph artifact", usage: "Usage: codegraph artifact [build]" },
      { args: ["drift", "--help"], heading: "codegraph drift", usage: "Usage: codegraph drift [roots...]" },
      { args: ["mcp", "--help"], heading: "codegraph mcp", usage: "Usage: codegraph mcp [serve]" },
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
    const result = await captureCli(["file", "--json", "--help"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${FILE_HELP_TEXT.trimEnd()}\n`);
    for (const option of ["--offset", "--limit", "--max-bytes", "--include-graph-context", "--allow-sensitive"]) {
      expect(result.stdout, option).toContain(option);
    }
  });

  test("documents drift-specific flags and head semantics in drift help", async () => {
    const result = await captureCli(["drift", "--json", "--help"]);

    expect(result.stdout).toContain("--limit");
    expect(result.stdout).toContain("--hotspot-jump-threshold");
    expect(result.stdout).toContain("--head <ref>");
    expect(result.stdout).toContain("--graph-edges <mode>");
    expect(result.stdout).toContain("--public-api <mode>");
    expect(result.stdout).not.toContain("--compact-json");
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
    const result = await captureCli(["doctor", "--json"]);

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    const report = readJsonRecord(JSON.parse(result.stdout));
    expect(report.package).toMatchObject({ name: "@lzehrung/codegraph" });
    expect(report.native).toBeTypeOf("object");
  });

  test("defaults command output to pretty and gives --json precedence", async () => {
    const pretty = await captureCli(["doctor"]);
    const json = await captureCli(["doctor", "--pretty", "--json"]);

    expect(pretty).toMatchObject({ stderr: "", exitCode: undefined });
    expect(pretty.stdout).toContain("Package:\n  Name: @lzehrung/codegraph");
    expect(pretty.stdout).toMatch(/^Package:/m);
    expect(pretty.stdout).toMatch(/^Cache:/m);
    expect(pretty.stdout).toMatch(/^ {2}Path: /m);
    expect(pretty.stdout).toMatch(/^ {2}Anchor: /m);
    expect(pretty.stdout).toMatch(/^ {2}Layer: /m);
    expect(pretty.stdout).toMatch(/^Native:/m);
    expect(pretty.stdout).toMatch(/^ {2}Origin:/m);
    expect(pretty.stdout).toMatch(/^ {2}Update:/m);
    expect(pretty.stdout).not.toMatch(/^Origin:/m);
    expect(pretty.stdout).not.toMatch(/^Update:/m);
    expect(pretty.stdout).not.toContain('"package"');
    const report = readJsonRecord(JSON.parse(json.stdout));
    expect(report.package).toMatchObject({ name: "@lzehrung/codegraph" });
    expect(report.native).toBeTypeOf("object");
  });

  test("captures CLI usage exits in process", async () => {
    const result = await captureCli(["missing-command"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('Unknown command "missing-command".');
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
    const result = await captureCli(["file", "--json", "src/first.ts", "src/second.ts"]);

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
        expected: 'Invalid graph-delta project root "stray-position"',
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
        runCli(["graph", "--json", "--output", "codegraph.json"], {
          cwd: () => firstRoot,
          stdout: () => {
            throw new Error("unexpected first stdout");
          },
        }),
        runCli(["graph", "--json", "--output", "codegraph.json"], {
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

  test("doctor reports the effective cache.location from codegraph.config.json", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-doctor-cache-config-"));
    const cacheLocation = path.join(tempDir, "custom-cache");
    await fsp.mkdir(cacheLocation, { recursive: true });
    await fsp.writeFile(
      path.join(tempDir, "codegraph.config.json"),
      JSON.stringify({ cache: { location: cacheLocation } }),
      "utf8",
    );
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const report = buildDoctorReport();
      expect(report.cache.layer).toBe("explicit");
      expect(report.cache.anchor).toBe(cacheLocation.replace(/\\/g, "/"));
    } finally {
      process.chdir(previousCwd);
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("doctor ignores a relative cache.location that would fail real schema validation", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-doctor-invalid-cache-config-"));
    await fsp.writeFile(
      path.join(tempDir, "codegraph.config.json"),
      JSON.stringify({ cache: { location: "relative-cache-dir" } }),
      "utf8",
    );
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const report = buildDoctorReport();
      expect(report.cache.layer).not.toBe("explicit");
      expect(report.cache.anchor).not.toContain("relative-cache-dir");
    } finally {
      process.chdir(previousCwd);
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("doctor falls back to the platform user config when project config has no cache.location", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-doctor-user-cache-config-"));
    const userConfigRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-doctor-user-config-root-"));
    const cacheLocation = path.join(tempDir, "user-custom-cache");
    await fsp.mkdir(path.join(userConfigRoot, "codegraph"), { recursive: true });
    await fsp.writeFile(
      path.join(userConfigRoot, "codegraph", "config.json"),
      JSON.stringify({ cache: { location: cacheLocation } }),
      "utf8",
    );
    const previousCwd = process.cwd();
    process.chdir(tempDir);
    vi.stubEnv("APPDATA", userConfigRoot);
    vi.stubEnv("XDG_CONFIG_HOME", userConfigRoot);
    try {
      const report = buildDoctorReport();
      expect(report.cache.layer).toBe("explicit");
      expect(report.cache.anchor).toBe(cacheLocation.replace(/\\/g, "/"));
    } finally {
      process.chdir(previousCwd);
      vi.unstubAllEnvs();
      await fsp.rm(tempDir, { recursive: true, force: true });
      await fsp.rm(userConfigRoot, { recursive: true, force: true });
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
        positionals: [],
        getOpt: (name) => {
          if (name === "--db") return dbPath;
          if (name === "--query") return "SELECT name FROM symbols WHERE kind = 'function';";
          return undefined;
        },
        hasFlag: (name) => name === "--json",
        cwd: () => process.cwd(),
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
        positionals: [],
        getOpt: () => undefined,
        hasFlag: () => false,
        cwd: () => process.cwd(),
        writeJSONLine: () => {
          throw new Error("unexpected json output");
        },
        writeStdoutLine: () => {
          throw new Error("unexpected stdout");
        },
        writeStderrLine: (message) => stderrLines.push(message),
        exit: (code) => {
          throw new Error(`sql exit ${code}`);
        },
      }),
    ).rejects.toThrow("sql exit 2");

    expect(stderrLines).toEqual([
      'Usage: sql <sqlite-path> "SELECT ..." OR sql --db <sqlite-path> --query "SELECT ..."',
    ]);
  });

  test("resolves relative SQL database paths against the injected runtime cwd", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-sql-relative-"));
    const dbPath = path.join(tempDir, "graph.sqlite");
    await fsp.writeFile(path.join(tempDir, "main.ts"), "export const answer = 42;\n", "utf8");
    await captureCli(["graph", "--root", tempDir, "--sqlite", dbPath]);
    const jsonLines: unknown[] = [];

    try {
      await handleSqlCommand({
        positionals: [],
        getOpt: (name) => {
          if (name === "--sqlite") return "graph.sqlite";
          if (name === "--query") return "SELECT path FROM files ORDER BY path;";
          return undefined;
        },
        hasFlag: (name) => name === "--json",
        cwd: () => tempDir,
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

      const result = readJsonRecord(jsonLines[0]);
      expect(result.columns).toEqual(["path"]);
      expect(JSON.stringify(result.rows)).toContain("main.ts");
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("forwards custom language mappings through the graph-delta command handler", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-delta-module-"));
    const outputPath = path.join(tempDir, "delta.json");
    const sourcePath = path.join(tempDir, "main.tpl");
    const helperPath = path.join(tempDir, "helper.ts");
    await fsp.writeFile(sourcePath, "import { helper } from './helper';\nhelper();\n", "utf8");
    await fsp.writeFile(helperPath, "export function helper() { return 1; }\n", "utf8");
    const languageExtensions = { ".tpl": "ts" };
    const expectedEdge = { from: "main.tpl", to: { type: "file", path: "helper.ts" }, raw: "./helper" };

    try {
      await handleGraphDeltaCommand({
        projectRootFs: tempDir,
        files: [sourcePath, helperPath],
        getOpt: (name) => {
          if (name === "--output") return outputPath;
          return undefined;
        },
        hasFlag: (name) => name === "--json",
        cwd: () => process.cwd(),
        nativeMode: "auto",
        workerOpts: {},
        graphOptions: undefined,
        languageExtensions,
        gitBase: undefined,
        gitHead: undefined,
        changedSince: undefined,
        writeJSONLine: () => {
          throw new Error("unexpected json stdout");
        },
        writeStdoutLine: () => {
          throw new Error("unexpected stdout");
        },
      });

      const report = readJsonRecord(JSON.parse(await fsp.readFile(outputPath, "utf8")));
      expect(report.changedFiles).toEqual(["helper.ts", "main.tpl"]);
      expect(report.added).toEqual([expectedEdge]);
      expect(report.removed).toEqual([]);
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
  test("inspect pretty output renders sectioned summaries", async () => {
    const root = await mkTmpDir("codegraph-inspect-pretty-");
    const filePath = path.join(root, "main.ts");
    await fsp.writeFile(filePath, "export const value = 1;\n", "utf8");
    const stdout: string[] = [];

    try {
      await handleInspectCommand(
        createInspectContext({
          projectRootFs: root,
          includeRootsAbs: [root],
          resolveFilesFromRoots: async () => [filePath],
          hasFlag: () => false,
          writeStdoutLine: (message) => stdout.push(message),
        }),
      );

      expect(stdout).toHaveLength(1);
      expect(stdout[0]).toContain("Files: 1 total");
      expect(stdout[0]).toContain("Hotspots:");
      expect(stdout[0]).toContain("Recommended commands:");
      expect(stdout[0]).toContain("Duplicates: disabled");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("passes resolved hotspot files as the current project scope", async () => {
    const root = await mkTmpDir("codegraph-hotspots-scope-options-");
    const cacheDir = path.join(root, ".codegraph-cache", "index-v1");
    const files = [path.join(root, "src", "main.ts")];
    const emptyIndex: ProjectIndex = {
      graph: { nodes: new Set<string>(), edges: [] },
      modules: new Map(),
      byFile: new Map(),
      exportCache: new Map(),
      scopeCache: new Map(),
    };
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockResolvedValue(emptyIndex);

    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(
        path.join(cacheDir, "manifest.json"),
        JSON.stringify({ updatedAt: Date.now(), lastCommit: "test-commit" }),
        "utf8",
      );
      await handleHotspotsCommand(
        createInspectContext({
          projectRootFs: root,
          includeRootsAbs: [path.join(root, "src")],
          resolveFilesFromRoots: async () => files,
          getOpt: () => undefined,
          hasFlag: (name) => name === "--json",
        }),
      );

      expect(buildSpy).toHaveBeenCalledWith(
        root,
        expect.objectContaining({
          files,
          filesAreProjectScope: true,
          cache: "disk",
        }),
      );
    } finally {
      buildSpy.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("invalidates persisted build options when the effective native runtime changes", () => {
    const autoOptions = summarizeBuildOptions({ native: "auto" });
    const offOptions = summarizeBuildOptions({ native: "off" });
    expect(diffBuildOptions(offOptions, { native: "auto" })).toContain("native");

    const enabledFingerprint = getNativeRuntimeFingerprint("auto", {});
    const disabledFingerprint = getNativeRuntimeFingerprint("auto", { CODEGRAPH_DISABLE_NATIVE: "1" });
    expect(enabledFingerprint).not.toBe(disabledFingerprint);
    expect(JSON.parse(disabledFingerprint)).toMatchObject({
      requestedMode: "auto",
      envDisabled: true,
      available: false,
      supportedLanguageIds: [],
    });

    const currentFingerprint = autoOptions.nativeRuntimeFingerprint;
    const staleFingerprint = currentFingerprint === enabledFingerprint ? disabledFingerprint : enabledFingerprint;
    expect(
      diffBuildOptions(
        {
          ...autoOptions,
          nativeRuntimeFingerprint: staleFingerprint,
        },
        { native: "auto" },
      ),
    ).toContain("native");

    const legacyOptions = { ...autoOptions };
    delete legacyOptions.nativeRuntimeFingerprint;
    expect(diffBuildOptions(legacyOptions, { native: "auto" })).toContain("native");
    expect(diffBuildOptions(undefined, { native: "auto" })).toContain("native");
  });
  test("ignores the removed preset field when comparing persisted build options", () => {
    const current = summarizeBuildOptions({ cache: "disk", cacheStrict: true });
    expect(current).not.toHaveProperty("preset");

    const legacyManifest = { ...current, preset: "code-review" };
    expect(diffBuildOptions(legacyManifest, { cache: "disk", cacheStrict: true })).not.toContain("preset");
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
        languageExtensions: undefined,
        gitBase: undefined,
        gitHead: undefined,
        changedSince: undefined,
        writeJSONLine: () => {
          throw new Error("unexpected json stdout");
        },
      }),
    ).rejects.toThrow('Invalid --cache value "banana". Expected one of: off, memory, disk.');
  });

  test("graph-delta --json parses and emits JSON while unsupported flags still error", async () => {
    const root = await createTwoCommitCycleProject("codegraph-graph-delta-json-", runCliModuleGit);
    try {
      const json = await captureCli([
        "graph-delta",
        "--root",
        root,
        "--git-base",
        "HEAD~1",
        "--git-head",
        "HEAD",
        "--json",
      ]);
      expect(json.exitCode).toBeUndefined();
      const payload = readJsonRecord(JSON.parse(json.stdout));
      expect(Array.isArray(payload.changedFiles)).toBe(true);
      expect(Array.isArray(payload.added)).toBe(true);
      expect(Array.isArray(payload.removed)).toBe(true);

      const bad = await captureCli(["graph-delta", "--root", root, "--not-a-real-flag"]);
      expect(bad.exitCode).toBe(2);
      expect(bad.stderr).toContain("Unknown option for graph-delta: --not-a-real-flag");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
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
    const originalBuildProjectIndexIncremental = indexerBuild.buildProjectIndexIncremental;
    const buildSpy = vi
      .spyOn(indexerBuild, "buildProjectIndexIncremental")
      .mockImplementation(async (projectRoot, opts) => {
        if (opts) capturedIndexOptions.push(opts);
        return await originalBuildProjectIndexIncremental(projectRoot, opts);
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
      await handleImpactCommand(
        createImpactContext({
          ...baseContext,
          hasFlag: (name) => name === "--json" || name === "--cache-verify",
        }),
      );

      expect(capturedIndexOptions[0]?.keepParsed).toBeUndefined();
      expect(capturedIndexOptions[1]?.keepParsed).toBe(true);
      expect(capturedIndexOptions[2]?.cacheVerify).toBe(true);
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
        hasFlag: (name) => name === "--json",
        cwd: () => process.cwd(),
        writeJSONLine: (value) => jsonLines.push(value),
        writeStdoutLine: () => {
          throw new Error("unexpected stdout");
        },
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
      const pretty = await captureCli(["chunk", "sample.ts", "--min-tokens", "1", "--max-tokens", "50"], {
        cwd: tempDir,
      });
      const result = await captureCli(["chunk", "--json", "sample.ts", "--min-tokens", "1", "--max-tokens", "50"], {
        cwd: tempDir,
      });

      expect(pretty).toMatchObject({ stderr: "", exitCode: undefined });
      expect(pretty.stdout).toContain("chunk(s).");
      expect(pretty.stdout).toContain(`${filePath}:1`);
      expect(pretty.stdout).toContain("function beta");
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
          hasFlag: (name) => name === "--json" || name === "--text",
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
        "--json",
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
      ]);
      expect(prettyResult).toEqual({
        stdout: [
          "File: util.ts",
          "Lines 2-2 of 3",
          "2\texport const second = 2;",
          "Next page: codegraph file util.ts --offset 3 --limit 1",
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
    const result = await captureCli(["file", "--json", "util.ts", option, String(excessiveValue)]);

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

  test("writes search timing and index reports without changing command output", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-search-report-"));
    const reportPath = path.join(tempDir, "search-report.json");
    await fsp.writeFile(path.join(tempDir, "entry.ts"), "export const searchableValue = 1;\n", "utf8");

    try {
      const result = await captureCli([
        "search",
        "searchableValue",
        "--root",
        tempDir,
        "--mode",
        "text",
        "--json",
        "--report-file",
        reportPath,
      ]);
      const response = readJsonRecord(JSON.parse(result.stdout));
      const report = readJsonRecord(JSON.parse(await fsp.readFile(reportPath, "utf8")));
      const timings = readJsonRecord(report.timings);

      expect(result).toMatchObject({ stderr: "", exitCode: undefined });
      expect(response.results).toBeTypeOf("object");
      expect(report.command).toBe("search");
      expect(timings.commandMs).toBeTypeOf("number");
      expect(timings.totalMs).toBeTypeOf("number");
      expect(readJsonRecord(readJsonRecord(report.index).files).total).toBe(1);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("writes inspect timing and index reports without changing command output", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-inspect-report-"));
    const reportPath = path.join(tempDir, "inspect-report.json");
    await fsp.writeFile(path.join(tempDir, "entry.ts"), "export const inspectedValue = 1;\n", "utf8");

    try {
      const result = await captureCli(["inspect", "--root", tempDir, "--json", "--report-file", reportPath]);
      const response = readJsonRecord(JSON.parse(result.stdout));
      const report = readJsonRecord(JSON.parse(await fsp.readFile(reportPath, "utf8")));
      const timings = readJsonRecord(report.timings);

      expect(result.exitCode).toBeUndefined();
      expect(response.files).toBeTypeOf("object");
      expect(report.command).toBe("inspect");
      expect(timings.commandMs).toBeTypeOf("number");
      expect(timings.totalMs).toBeTypeOf("number");
      expect(readJsonRecord(readJsonRecord(report.index).files).total).toBe(1);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("keeps inspect duplicate analysis opt-in and emits bounded summaries", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-cli-inspect-duplicates-"));
    const clone = [
      "export function calculate(values: number[]): number {",
      "  const positive = values.filter((value) => value > 0);",
      "  const doubled = positive.map((value) => value * 2);",
      "  const bounded = doubled.filter((value) => value < 1000);",
      "  const total = bounded.reduce((sum, value) => sum + value, 0);",
      "  const average = bounded.length ? total / bounded.length : 0;",
      "  const rounded = Math.round(average * 100) / 100;",
      "  return Number.isFinite(rounded) ? rounded : 0;",
      "}",
      "",
    ].join("\n");
    await Promise.all([
      fsp.writeFile(path.join(tempDir, "first.ts"), clone, "utf8"),
      fsp.writeFile(path.join(tempDir, "second.ts"), clone, "utf8"),
    ]);

    try {
      const defaultResult = await captureCli(["inspect", "--root", tempDir, "--cache", "off", "--json"]);
      const enabledResult = await captureCli([
        "inspect",
        "--root",
        tempDir,
        "--cache",
        "off",
        "--duplicates",
        "--limit",
        "1",
        "--json",
      ]);
      const defaultReport = readJsonRecord(JSON.parse(defaultResult.stdout));
      const defaultDuplicates = readJsonRecord(defaultReport.duplicates);
      const enabledReport = readJsonRecord(JSON.parse(enabledResult.stdout));
      const enabledDuplicates = readJsonRecord(enabledReport.duplicates);

      expect(defaultResult.exitCode).toBeUndefined();
      expect(defaultDuplicates).toEqual({ enabled: false });
      expect(enabledResult.exitCode).toBeUndefined();
      expect(enabledDuplicates.enabled).toBe(true);
      expect(enabledDuplicates.minConfidence).toBe("high");
      expect(readJsonArray(enabledDuplicates.top)).toHaveLength(1);
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
      const warmDeps = await captureCli(["deps", "main.ts", "--root", tempDir, "--json", "--progress"]);
      const rdeps = await captureCli(["rdeps", "util.ts", "--root", tempDir]);
      const graphPath = await captureCli(["path", "main.ts", "util.ts", "--root", tempDir]);
      const cycles = await captureCli(["cycles", "--root", tempDir, "--progress"]);
      const unresolved = await captureCli(["unresolved", "--root", tempDir, "--verbose"]);
      const apiSurface = await captureCli(["apisurface", "--root", tempDir, "--progress"]);

      expect(JSON.stringify(JSON.parse(deps.stdout))).toContain("util.ts");
      expect(warmDeps.stderr).toContain("Checking project index");
      expect(warmDeps.stderr).toContain("Checked project index");
      expect(warmDeps.stderr).not.toContain("Building project index");
      expect(warmDeps.stderr).not.toContain("files processed");
      expect(rdeps.stdout).toContain("Reverse dependencies for util.ts:");
      expect(graphPath.stdout).toContain("main.ts");
      expect(graphPath.stdout).toContain("util.ts");
      expect(cycles.stdout).toContain("No dependency cycles found.");
      expect(cycles.stderr).toContain("Checked project index");
      expect(cycles.stderr).not.toContain("Building project index");
      expect(unresolved.stdout).toContain("missing-pkg");
      expect(unresolved.stdout).toContain('as "missing-pkg"');
      expect(apiSurface.stdout).toContain("API Surface");
      expect(apiSurface.stdout).toContain("run");
      expect(apiSurface.stderr).toContain("Checked project index");
      expect(apiSurface.stderr).not.toContain("Building project index");
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
        "--json",
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
        "--json",
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
      loadCurrentIndex: async () => {
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
        forward: new Map([[fileIdentityKey(mainPath), [utilPath]]]),
        reverse: new Map([[fileIdentityKey(utilPath), [mainPath]]]),
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
        loadCurrentIndex: async () => {
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

    expect(stderrLines).toEqual(["Usage: deps <file|file::symbol|symbol:...> [--depth N] [--json]"]);
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

    await expect(
      handleGraphQueryCommand(
        createGraphQueryContext({
          command: "rdeps",
          positionals: ["../outside.ts"],
          projectRootFs: projectRoot,
          projectRootAbs: projectRoot,
          writeStdoutLine: (message) => stdoutLines.push(message),
        }),
      ),
    ).rejects.toThrow("graph query exit 1");

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
  test("skill doctor pretty output renders an installation summary", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-skill-pretty-"));
    const targetDir = path.join(tempDir, "skills", "codegraph");
    const stdout: string[] = [];

    try {
      await handleSkillCommand(
        createSkillContext({
          positionals: ["doctor"],
          getOpt: (name) => (name === "--target" ? targetDir : undefined),
          writeStdoutLine: (message) => stdout.push(message),
        }),
      );

      expect(stdout).toHaveLength(1);
      expect(stdout[0]).toContain(`Install target: ${targetDir.replace(/\\/g, "/")}`);
      expect(stdout[0]).toContain("Installed SKILL.md:");
      expect(stdout[0]).toContain("CLI on PATH:");
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
      "Usage: codegraph skill <install|print-path|doctor> [--agent <name> | --target <dir>] [--force] [--json | --pretty]",
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

  test("mcp --stdio --idle-timeout-ms reaches serveCodegraphMcp as a number, and rejects non-numeric values", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-mcp-idle-timeout-"));
    const serveSpy = vi.spyOn(mcpServer, "serveCodegraphMcp").mockResolvedValue();

    try {
      const result = await captureCli(["mcp", "--root", root, "--stdio", "--idle-timeout-ms", "1000"]);
      expect(result.exitCode).toBeUndefined();
      expect(serveSpy).toHaveBeenCalledWith(expect.objectContaining({ idleTimeoutMs: 1000 }));

      const invalid = await captureCli(["mcp", "--root", root, "--stdio", "--idle-timeout-ms", "not-a-number"]);
      expect(invalid.exitCode).toBe(2);
      expect(invalid.stderr).toContain('Invalid --idle-timeout-ms value "not-a-number"');
    } finally {
      serveSpy.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
