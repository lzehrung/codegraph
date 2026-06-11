#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { BuildOptions } from "./indexer/types.js";
import { type GraphBuildOptions } from "./graphs/types.js";
import { type NativeRuntimeMode } from "./native/treeSitterNative.js";
import { handleChunkCommand } from "./cli/chunk.js";
import {
  createCliProgressHandler,
  exitCli,
  filterFilesByCliDiscoveryGlobs,
  getCwd,
  maybeWriteNativeBackendStatus,
  parseCliArgs,
  readCliStdin,
  runWithCliRuntime,
  setCliStderrFilePath,
  writeCommandReport,
  writeError,
  writeJSONLine,
  writeStderrLine,
  writeStdoutLine,
  type CliRuntime,
  type CommandReport,
} from "./cli/context.js";
import { buildDoctorReport } from "./cli/doctor.js";
import { handleDriftCommand } from "./cli/drift.js";
import { handleDuplicatesCommand } from "./cli/duplicates.js";
import { handleExplainCommand } from "./cli/explain.js";
import { handleGraphDeltaCommand } from "./cli/graphDelta.js";
import { handleGraphQueryCommand } from "./cli/graphQueries.js";
import { handleGrepCommand } from "./cli/grep.js";
import { CLI_HELP_TEXT, helpTextForCommand, isKnownCliCommand } from "./cli/help.js";
import { handleImpactCommand } from "./cli/impact.js";
import { handleIndexCommand } from "./cli/index.js";
import { handleHotspotsCommand, handleInspectCommand } from "./cli/inspect.js";
import { handleOrientCommand } from "./cli/orient.js";
import { handleDumpmodCommand, handleGotoCommand, handleRefsCommand } from "./cli/navigation.js";
import { parseCacheModeOption, parseOptionalNonNegativeIntegerOption } from "./cli/options.js";
import { getCodegraphPackageIdentity, getCodegraphVersion } from "./cli/packageInfo.js";
import { handlePacketCommand } from "./cli/packet.js";
import { handleReviewCommand } from "./cli/review.js";
import { handleSearchCommand } from "./cli/search.js";
import { handleSkillCommand } from "./cli/skill.js";
import { hasDiscoveryOptions, loadCodegraphConfig, mergeDiscoveryOptions } from "./config.js";
import { listChangedFiles } from "./util/git.js";
import { DEFAULT_PROJECT_PATTERNS, listProjectFiles, type ProjectFileDiscoveryOptions } from "./util/projectFiles.js";
import { normalizePath, resolveFilePathFromRoot, toProjectDisplayPath } from "./util/paths.js";

export { isCliDiscoveryRelativePathInside } from "./cli/context.js";

const DUPLICATE_PROJECT_PATTERNS = [...DEFAULT_PROJECT_PATTERNS, "**/*.{json,jsonc,toml,txt,yaml,yml}"];

function normalizeEntrypointPath(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}
function looksLikeGlobPattern(baseRoot: string, value: string): boolean {
  const hasGlobSyntax =
    /[*?]/.test(value) || (value.includes("{") && value.includes("}")) || (value.includes("[") && value.includes("]"));
  if (!hasGlobSyntax) return false;
  return !fs.existsSync(resolveFilePathFromRoot(baseRoot, value));
}

function assertValidIncludeRoots(command: string, baseRoot: string, includeRoots: readonly string[]): void {
  const globLikeRoot = includeRoots.find((includeRoot) => looksLikeGlobPattern(baseRoot, includeRoot));
  if (!globLikeRoot) return;
  throw new Error(
    `Invalid ${command} path "${globLikeRoot}". Positional paths are scan roots, not glob patterns. Repeat --ignore-glob or --include-glob for each glob filter.`,
  );
}

function isDirectCliExecution(importMetaUrl: string, argv: string[] = process.argv): boolean {
  const argv1 = argv[1];
  if (!argv1) return false;

  const modulePath = normalizeEntrypointPath(fileURLToPath(importMetaUrl));
  const invokedPath = normalizeEntrypointPath(argv1);

  if (process.platform === "win32") {
    return modulePath.toLowerCase() === invokedPath.toLowerCase();
  }
  return modulePath === invokedPath;
}
function parseNativeRuntimeMode(value: string | undefined): NativeRuntimeMode {
  if (value === undefined) return "auto";
  if (value === "auto" || value === "on" || value === "off") {
    return value;
  }
  throw new Error(`Invalid --native value "${value}". Expected auto|on|off.`);
}

async function runCliWithActiveRuntime(rawArgs: string[]) {
  const cmd = rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs[0] : "graph";
  const argTokens = rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs.slice(1) : rawArgs;

  const parsed = parseCliArgs(cmd, argTokens);
  const hasFlag = (name: string) => parsed.flags.has(name);
  const getOpt = (name: string) => {
    const v = parsed.options.get(name);
    return v?.length ? v[v.length - 1] : undefined;
  };

  // Handle help flag
  if (hasFlag("--help") || hasFlag("-h")) {
    const commandHelp = helpTextForCommand(cmd, parsed.positionals);
    writeStdoutLine((commandHelp ?? CLI_HELP_TEXT).trimEnd());
    return;
  }

  if (hasFlag("--version") || hasFlag("-v")) {
    if (hasFlag("--json")) {
      writeJSONLine(getCodegraphPackageIdentity());
    } else {
      writeStdoutLine(getCodegraphVersion());
    }
    return;
  }

  if (!isKnownCliCommand(cmd)) {
    writeStderrLine(`Unknown command: ${cmd}`);
    exitCli(1);
    return;
  }

  const reportFile = getOpt("--report-file");
  const reportEnabled = hasFlag("--report") || reportFile !== undefined;
  const nativeMode = parseNativeRuntimeMode(getOpt("--native"));
  const useNativeWorkers = hasFlag("--workers");
  const workerOpts = useNativeWorkers ? ({ useNativeWorkers: true } as const) : ({} as const);
  const showProgress = hasFlag("--progress");
  const progressHandler = createCliProgressHandler(showProgress);
  const graphFlags = {
    fast: hasFlag("--fast-graph"),
    resolveNodeModules: hasFlag("--resolve-node-modules"),
    dynamicImportHeuristics: hasFlag("--dynamic-import-heuristics"),
    resolutionHints: parsed.options.get("--resolution-hint") ?? [],
  };
  const hasGraphOverrides =
    graphFlags.fast ||
    graphFlags.resolveNodeModules ||
    graphFlags.dynamicImportHeuristics ||
    !!graphFlags.resolutionHints.length;
  const buildGraphOptions = () => ({
    fast: graphFlags.fast,
    resolveNodeModules: graphFlags.resolveNodeModules,
    dynamicImportHeuristics: graphFlags.dynamicImportHeuristics,
    ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
    ...(graphFlags.resolutionHints.length ? { resolutionHints: graphFlags.resolutionHints } : {}),
  });
  const buildAgentOptions = (): BuildOptions => {
    const cache = parseCacheModeOption(getOpt("--cache"));
    const threads = parseOptionalNonNegativeIntegerOption(getOpt("--threads"), "--threads");
    return {
      ...(progressHandler ? { onProgress: progressHandler } : {}),
      discovery: discoveryOptions,
      ...(cache !== undefined ? { cache } : {}),
      ...(hasFlag("--cache-strict") ? { cacheStrict: true } : {}),
      ...(hasFlag("--cache-verify") ? { cacheVerify: true } : {}),
      ...(hasGraphOverrides || nativeMode !== "auto" ? { graph: buildGraphOptions() } : {}),
      ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
      ...(threads !== undefined ? { threads } : {}),
      ...workerOpts,
    };
  };

  const changedSince = getOpt("--changed-since");
  const gitBase = getOpt("--git-base");
  const gitHead = getOpt("--git-head");

  const rootOpt = getOpt("--root");
  const resolveAbs = (p: string) => resolveFilePathFromRoot(getCwd(), p);

  const defaultProjectRoot =
    (cmd === "graph" ||
      cmd === "graph-delta" ||
      cmd === "index" ||
      cmd === "grep" ||
      cmd === "hotspots" ||
      cmd === "inspect" ||
      cmd === "duplicates" ||
      cmd === "impact") &&
    !rootOpt &&
    parsed.positionals.length === 1 &&
    fs.existsSync(resolveAbs(parsed.positionals[0]!)) &&
    fs.statSync(resolveAbs(parsed.positionals[0]!)).isDirectory()
      ? resolveAbs(parsed.positionals[0]!)
      : getCwd();

  const projectRootFs = rootOpt ? resolveAbs(rootOpt) : defaultProjectRoot;
  const projectRootAbs = projectRootFs.replace(/\\/g, "/");
  const includeGlobs = parsed.options.get("--include-glob") ?? [];
  const scanIgnoreGlobs = parsed.options.get("--ignore-glob") ?? [];
  const cliGlobDiscoveryOptions: ProjectFileDiscoveryOptions = {
    ...(includeGlobs.length ? { includeGlobs } : {}),
    ...(scanIgnoreGlobs.length ? { ignoreGlobs: scanIgnoreGlobs } : {}),
  };
  const cliGitignoreDiscoveryOptions: ProjectFileDiscoveryOptions = {
    ...(hasFlag("--no-gitignore") ? { useGitignore: false } : {}),
  };
  const explicitDiscoveryOptions: ProjectFileDiscoveryOptions = {
    ...cliGlobDiscoveryOptions,
    ...cliGitignoreDiscoveryOptions,
  };

  if (cmd === "version") {
    if (hasFlag("--json")) {
      writeJSONLine(getCodegraphPackageIdentity());
    } else {
      writeStdoutLine(getCodegraphVersion());
    }
    return;
  }

  if (cmd === "doctor") {
    writeJSONLine(buildDoctorReport(parsed.positionals.at(-1)));
    return;
  }

  if (cmd === "skill") {
    await handleSkillCommand({
      positionals: parsed.positionals,
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "sql") {
    const { handleSqlCommand } = await import("./cli/sql.js");
    await handleSqlCommand({
      getOpt,
      cwd: getCwd,
      writeJSONLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "chunk") {
    await handleChunkCommand({
      positionals: parsed.positionals,
      getOpt,
      hasFlag,
      cwd: getCwd,
      writeJSONLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  const config = await loadCodegraphConfig(projectRootFs);
  const configDiscoveryOptions = mergeDiscoveryOptions(config.discovery, cliGitignoreDiscoveryOptions);
  const mergedDiscoveryOptions = mergeDiscoveryOptions(config.discovery, explicitDiscoveryOptions);
  const discoveryOptions: ProjectFileDiscoveryOptions = hasDiscoveryOptions(mergedDiscoveryOptions)
    ? { ...mergedDiscoveryOptions, globRoot: projectRootFs }
    : {};
  const includeRootDiscoveryOptions: ProjectFileDiscoveryOptions = hasDiscoveryOptions(configDiscoveryOptions)
    ? { ...configDiscoveryOptions, globRoot: projectRootFs }
    : {};

  const supportsIncludeRoots =
    cmd === "graph" ||
    cmd === "index" ||
    cmd === "hotspots" ||
    cmd === "inspect" ||
    cmd === "duplicates" ||
    cmd === "drift" ||
    cmd === "orient";
  let includeRoots: string[] = [];
  if (supportsIncludeRoots) {
    if (rootOpt) {
      // If the user explicitly sets --root, treat all remaining positionals as include roots.
      includeRoots = parsed.positionals;
    } else if (cmd === "orient" || cmd === "drift") {
      // Orient and drift use positionals only as include roots; they do not use the legacy root positional.
      includeRoots = parsed.positionals;
    } else if (parsed.positionals.length > 1) {
      // Otherwise, a single positional arg is treated as the project root (back-compat).
      includeRoots = parsed.positionals;
    } else if (parsed.positionals.length === 1 && looksLikeGlobPattern(getCwd(), parsed.positionals[0]!)) {
      throw new Error(
        `Invalid ${cmd} path "${parsed.positionals[0]!}". Positional paths are scan roots, not glob patterns. Repeat --ignore-glob or --include-glob for each glob filter.`,
      );
    }
  }
  assertValidIncludeRoots(cmd, projectRootFs, includeRoots);
  const includeRootsAbs = includeRoots.map((r) => normalizePath(resolveFilePathFromRoot(projectRootFs, r)));

  const isUnderIncludeRoots = (filePath: string): boolean => {
    if (!includeRootsAbs.length) return true;
    const f = filePath.replace(/\\/g, "/");
    return includeRootsAbs.some((root) => f === root || f.startsWith(`${root}/`));
  };

  const resolveFilesFromRoots = async (): Promise<string[]> => {
    const patterns = cmd === "duplicates" ? DUPLICATE_PROJECT_PATTERNS : undefined;
    if (!includeRootsAbs.length) return await listProjectFiles(projectRootFs, patterns, discoveryOptions);
    const normalizedRoots = includeRootsAbs;
    const all: string[][] = await Promise.all(
      normalizedRoots.map(async (r) => {
        const files = await listProjectFiles(r, patterns, {
          ...includeRootDiscoveryOptions,
          gitignoreRoot: projectRootFs,
        });
        return filterFilesByCliDiscoveryGlobs(files, r, cliGlobDiscoveryOptions);
      }),
    );
    return Array.from(new Set(all.flat()));
  };

  const listProjectFilesForScan = async (scanRoot: string): Promise<string[]> => {
    if (scanRoot === projectRootFs) {
      return await listProjectFiles(scanRoot, undefined, discoveryOptions);
    }
    const files = await listProjectFiles(scanRoot, undefined, {
      ...includeRootDiscoveryOptions,
      gitignoreRoot: projectRootFs,
    });
    return filterFilesByCliDiscoveryGlobs(files, scanRoot, cliGlobDiscoveryOptions);
  };

  const resolveChangedFiles = async (): Promise<string[] | null> => {
    if (gitBase) {
      const diffOpts: { base: string; head?: string } = { base: gitBase };
      if (gitHead) diffOpts.head = gitHead;
      return (await listChangedFiles(projectRootFs, diffOpts)).filter(isUnderIncludeRoots);
    }
    if (changedSince) {
      return (
        await listChangedFiles(projectRootFs, {
          changedSince,
        })
      ).filter(isUnderIncludeRoots);
    }
    return null;
  };

  const resolveChangedFilesWithDeletes = async (): Promise<{
    existingFiles: string[];
    deletedFiles: string[];
  } | null> => {
    const gitFiles = await resolveChangedFiles();
    if (!gitFiles) return null;
    const existence = gitFiles.map((file: string) => ({
      file,
      exists: fs.existsSync(file),
    }));
    return {
      existingFiles: existence.filter((entry) => entry.exists).map((entry) => entry.file),
      deletedFiles: existence.filter((entry) => !entry.exists).map((entry) => entry.file),
    };
  };

  const resolveFiles = async (): Promise<string[]> => {
    const changedSet = await resolveChangedFilesWithDeletes();
    if (changedSet) {
      const { existingFiles, deletedFiles } = changedSet;
      if (deletedFiles.length) {
        writeStderrLine(
          `Skipping ${deletedFiles.length} deleted file(s) from git diff: ${deletedFiles
            .map((file) => toProjectDisplayPath(projectRootFs, file) || file)
            .join(", ")}`,
        );
      }
      if (!existingFiles.length) {
        writeStderrLine("No changed files detected via git diff.");
      }
      return existingFiles;
    }
    return await resolveFilesFromRoots();
  };

  if (cmd === "search") {
    await handleSearchCommand({
      positionals: parsed.positionals,
      root: projectRootFs,
      buildOptions: buildAgentOptions(),
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "explain") {
    await handleExplainCommand({
      positionals: parsed.positionals,
      root: projectRootFs,
      buildOptions: buildAgentOptions(),
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "orient") {
    await handleOrientCommand({
      positionals: includeRoots,
      root: projectRootFs,
      buildOptions: buildAgentOptions(),
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "packet") {
    await handlePacketCommand({
      positionals: parsed.positionals,
      root: projectRootFs,
      buildOptions: buildAgentOptions(),
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "artifact") {
    const { handleArtifactCommand } = await import("./cli/artifact.js");
    await handleArtifactCommand({
      positionals: parsed.positionals,
      root: projectRootFs,
      buildOptions: buildAgentOptions(),
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "mcp") {
    const { handleMcpServeCommand } = await import("./cli/mcp.js");
    await handleMcpServeCommand({
      positionals: parsed.positionals,
      root: projectRootFs,
      buildOptions: buildAgentOptions(),
      getOpt,
      hasFlag,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "graph-delta") {
    const files = await resolveFiles();
    await handleGraphDeltaCommand({
      projectRootFs,
      files,
      getOpt,
      hasFlag,
      cwd: getCwd,
      nativeMode,
      workerOpts,
      graphOptions: hasGraphOverrides ? buildGraphOptions() : undefined,
      gitBase,
      gitHead,
      changedSince,
      writeJSONLine,
    });
    return;
  }

  if (cmd === "graph") {
    const { handleGraphCommand } = await import("./cli/graph.js");
    await handleGraphCommand({
      projectRootFs,
      discoveryOptions,
      nativeMode,
      workerOpts,
      progressHandler,
      graphFlags,
      gitBase,
      gitHead,
      changedSince,
      reportEnabled,
      reportFile,
      showProgress,
      getOpt,
      hasFlag,
      cwd: getCwd,
      resolveFiles,
      resolveChangedFilesWithDeletes,
      writeStdoutLine,
      setStderrFilePath: setCliStderrFilePath,
      writeCommandReport,
      maybeWriteNativeBackendStatus,
    });
    return;
  }

  if (cmd === "index") {
    await handleIndexCommand({
      projectRootFs,
      includeRootsAbs,
      gitBase,
      changedSince,
      discoveryOptions,
      nativeMode,
      workerOpts,
      progressHandler,
      graphOptions: hasGraphOverrides ? buildGraphOptions() : undefined,
      reportEnabled,
      reportFile,
      getOpt,
      hasFlag,
      resolveFiles,
      writeJSONLine,
      writeStderrLine,
      writeCommandReport,
      maybeWriteNativeBackendStatus,
      showProgress,
    });
    return;
  }

  if (cmd === "drift") {
    const driftGraphOptions = hasGraphOverrides || nativeMode !== "auto" ? buildGraphOptions() : undefined;
    await handleDriftCommand({
      projectRootFs,
      positionals: includeRoots,
      getOpt,
      hasFlag,
      nativeMode,
      ...(driftGraphOptions ? { graphOptions: driftGraphOptions } : {}),
      indexOptions: {
        onProgress: progressHandler,
        discovery: discoveryOptions,
        ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
        ...workerOpts,
      },
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "duplicates") {
    const files = await resolveFiles();
    await handleDuplicatesCommand({
      projectRootFs,
      files,
      getOpt,
      hasFlag,
      indexOptions: {
        onProgress: progressHandler,
        discovery: discoveryOptions,
        ...(hasGraphOverrides ? { graph: buildGraphOptions() } : {}),
        ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
        ...workerOpts,
      },
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "dumpmod") {
    await handleDumpmodCommand({
      projectRootFs,
      discoveryOptions,
      positionals: parsed.positionals,
      getOpt,
      hasFlag,
      nativeMode,
      workerOpts,
      progressHandler,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "goto") {
    await handleGotoCommand({
      projectRootFs,
      discoveryOptions,
      positionals: parsed.positionals,
      getOpt,
      hasFlag,
      nativeMode,
      workerOpts,
      progressHandler,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "refs") {
    await handleRefsCommand({
      projectRootFs,
      discoveryOptions,
      positionals: parsed.positionals,
      getOpt,
      hasFlag,
      nativeMode,
      workerOpts,
      progressHandler,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "grep") {
    await handleGrepCommand({
      projectRootFs,
      discoveryOptions,
      parsedOptions: parsed.options,
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "impact") {
    await handleImpactCommand({
      projectRootFs,
      discoveryOptions,
      getOpt,
      hasFlag,
      parsedOptions: parsed.options,
      nativeMode,
      workerOpts,
      graphOptions: hasGraphOverrides
        ? {
            fast: graphFlags.fast,
            resolveNodeModules: graphFlags.resolveNodeModules,
            dynamicImportHeuristics: graphFlags.dynamicImportHeuristics,
            ...(graphFlags.resolutionHints.length ? { resolutionHints: graphFlags.resolutionHints } : {}),
          }
        : undefined,
      progressHandler,
      readStdin: readCliStdin,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  // Review entry point: CLI workflow for review reports.
  if (cmd === "review") {
    const commandReport: CommandReport | undefined = reportEnabled ? { command: "review", timings: {} } : undefined;
    await handleReviewCommand({
      projectRootFs,
      discoveryOptions,
      reportFile,
      commandReport,
      getOpt,
      hasFlag,
      nativeMode,
      useNativeWorkers,
      graphOptions: hasGraphOverrides ? buildGraphOptions() : undefined,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      writeCommandReport,
      exit: exitCli,
    });
    return;
  }

  const buildGraphQueryIndexOptions = (graphOptions: GraphBuildOptions | undefined): BuildOptions => ({
    onProgress: progressHandler,
    discovery: discoveryOptions,
    ...(graphOptions ? { graph: graphOptions } : {}),
    ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
    ...workerOpts,
  });

  if (cmd === "deps" || cmd === "rdeps") {
    const graphOptions = hasGraphOverrides || nativeMode !== "auto" ? buildGraphOptions() : undefined;
    await handleGraphQueryCommand({
      command: cmd,
      positionals: parsed.positionals,
      projectRootFs,
      projectRootAbs,
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
      listProjectFilesForScan: async () => await listProjectFilesForScan(projectRootFs),
      ...(graphOptions ? { graphOptions } : {}),
      indexOptions: buildGraphQueryIndexOptions(graphOptions),
    });
    return;
  }

  if (cmd === "path" || cmd === "cycles" || cmd === "unresolved") {
    const graphOptions = hasGraphOverrides || nativeMode !== "auto" ? buildGraphOptions() : undefined;
    await handleGraphQueryCommand({
      command: cmd,
      positionals: parsed.positionals,
      projectRootFs,
      projectRootAbs,
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
      listProjectFilesForScan: async () => await listProjectFilesForScan(projectRootFs),
      ...(graphOptions ? { graphOptions } : {}),
      indexOptions: buildGraphQueryIndexOptions(graphOptions),
    });
    return;
  }

  if (cmd === "inspect") {
    await handleInspectCommand({
      projectRootFs,
      includeRootsAbs,
      discoveryOptions,
      graphOptions: hasGraphOverrides || nativeMode !== "auto" ? buildGraphOptions() : undefined,
      nativeMode,
      workerOpts,
      progressHandler,
      getOpt,
      hasFlag,
      resolveFilesFromRoots,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
    });
    return;
  }

  if (cmd === "hotspots") {
    await handleHotspotsCommand({
      projectRootFs,
      includeRootsAbs,
      discoveryOptions,
      graphOptions: hasGraphOverrides || nativeMode !== "auto" ? buildGraphOptions() : undefined,
      nativeMode,
      workerOpts,
      progressHandler,
      getOpt,
      hasFlag,
      resolveFilesFromRoots,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
    });
    return;
  }

  if (cmd === "apisurface") {
    await handleGraphQueryCommand({
      command: cmd,
      positionals: parsed.positionals,
      projectRootFs,
      projectRootAbs,
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
      listProjectFilesForScan: async () => await listProjectFilesForScan(projectRootFs),
      indexOptions: {
        onProgress: progressHandler,
        discovery: discoveryOptions,
        ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
        ...workerOpts,
      },
    });
    return;
  }

  writeStderrLine(`Unknown command: ${cmd}`);
  exitCli(1);
}

export async function runCli(
  rawArgs: string[] = process.argv.slice(2),
  runtime: Partial<CliRuntime> = {},
): Promise<void> {
  await runWithCliRuntime(runtime, async () => await runCliWithActiveRuntime(rawArgs));
}

if (isDirectCliExecution(import.meta.url)) {
  void runWithCliRuntime({}, async () => {
    try {
      await runCliWithActiveRuntime(process.argv.slice(2));
    } catch (error) {
      writeError(error);
      exitCli(1);
    }
  });
}
