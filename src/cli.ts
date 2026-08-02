#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { BuildOptions } from "./indexer/types.js";
import type { GraphBuildOptions } from "./graphs/types.js";
import type { NativeRuntimeMode } from "./native/treeSitterNative.js";
import {
  createCliProgressHandler,
  exitCli,
  getCwd,
  isCliInteractiveTerminal,
  maybeWriteNativeBackendStatus,
  parseCliArgs,
  readCliStdin,
  promptCliLine,
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
import { CLI_HELP_TEXT, CLI_TASK_HELP_TEXT, helpTextForCommand, isKnownCliCommand } from "./cli/help.js";
import { routeForCliIntent, suggestCliCommands } from "./cli/commandCatalog.js";
import { parseCacheModeOption, parseOptionalNonNegativeIntegerOption, validateCliArgs } from "./cli/options.js";
import { getCodegraphPackageIdentity, getCodegraphVersion } from "./cli/packageInfo.js";
import { writeCliOutput } from "./cli/pretty.js";
import type { CliProgressPolicy } from "./cli/progress.js";
import type { ProjectFileDiscoveryOptions } from "./util/projectFiles.js";
import {
  normalizePath,
  normalizeResolutionHints,
  resolveFilePathFromRoot,
  toProjectDisplayPath,
} from "./util/paths.js";

export { isRelativePathInside as isCliDiscoveryRelativePathInside } from "./util/discoveryPath.js";
export const CLI_DISPATCHABLE_COMMANDS = [
  "apisurface",
  "artifact",
  "callees",
  "callers",
  "chunk",
  "cycles",
  "deps",
  "doctor",
  "drift",
  "dumpmod",
  "duplicates",
  "explain",
  "explore",
  "file",
  "goto",
  "graph",
  "graph-delta",
  "grep",
  "hotspots",
  "impact",
  "implementations",
  "index",
  "init",
  "inspect",
  "install",
  "mcp",
  "orient",
  "packet",
  "path",
  "rdeps",
  "refactor-plan",
  "refs",
  "rename-preview",
  "review",
  "search",
  "skill",
  "sql",
  "status",
  "subtypes",
  "supertypes",
  "symbols",
  "sync",
  "uninit",
  "uninstall",
  "unresolved",
  "viewer",
  "version",
] as const;

async function getDuplicateProjectPatterns(): Promise<string[]> {
  const { DEFAULT_PROJECT_PATTERNS } = await loadProjectFilesHelpers();
  return [...DEFAULT_PROJECT_PATTERNS, "**/*.{json,jsonc,toml,txt,yaml,yml}"];
}

type DiscoveryGlobHelpers = typeof import("./cli/discoveryGlobs.js");
type ConfigHelpers = typeof import("./config.js");
type ProjectFilesHelpers = typeof import("./util/projectFiles.js");
type GitHelpers = typeof import("./util/git.js");
type IncludeRootsHelpers = typeof import("./util/includeRoots.js");

let discoveryGlobHelpersPromise: Promise<DiscoveryGlobHelpers> | undefined;
let configHelpersPromise: Promise<ConfigHelpers> | undefined;
let projectFilesHelpersPromise: Promise<ProjectFilesHelpers> | undefined;
let gitHelpersPromise: Promise<GitHelpers> | undefined;
let includeRootsHelpersPromise: Promise<IncludeRootsHelpers> | undefined;

function loadDiscoveryGlobHelpers(): Promise<DiscoveryGlobHelpers> {
  discoveryGlobHelpersPromise ??= import("./cli/discoveryGlobs.js");
  return discoveryGlobHelpersPromise;
}

function loadConfigHelpers(): Promise<ConfigHelpers> {
  configHelpersPromise ??= import("./config.js");
  return configHelpersPromise;
}

function loadProjectFilesHelpers(): Promise<ProjectFilesHelpers> {
  projectFilesHelpersPromise ??= import("./util/projectFiles.js");
  return projectFilesHelpersPromise;
}

function loadGitHelpers(): Promise<GitHelpers> {
  gitHelpersPromise ??= import("./util/git.js");
  return gitHelpersPromise;
}

function loadIncludeRootsHelpers(): Promise<IncludeRootsHelpers> {
  includeRootsHelpersPromise ??= import("./util/includeRoots.js");
  return includeRootsHelpersPromise;
}

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

function isExistingDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

function isLifecycleCommand(command: string): command is "init" | "status" | "sync" | "uninit" {
  return command === "init" || command === "status" || command === "sync" || command === "uninit";
}

function acceptsOptionalProjectRoot(command: string): boolean {
  return command === "apisurface" || command === "graph-delta" || command === "review" || command === "unresolved";
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
  if (!rawArgs.length) {
    writeStdoutLine(CLI_TASK_HELP_TEXT);
    return;
  }

  if (rawArgs[0] === "help") {
    const command = rawArgs[1];
    writeStdoutLine(
      (command ? helpTextForCommand(command, rawArgs.slice(2)) : CLI_HELP_TEXT)?.trimEnd() ?? CLI_HELP_TEXT,
    );
    return;
  }

  const cmd = rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs[0] : "graph";
  const argTokens = rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs.slice(1) : rawArgs;

  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(cmd, argTokens);
  } catch (error) {
    writeStderrLine(error instanceof Error ? error.message : String(error));
    exitCli(2);
  }
  const hasFlag = (name: string) => parsed.flags.has(name);
  const getOpt = (name: string) => {
    const v = parsed.options.get(name);
    return v?.length ? v[v.length - 1] : undefined;
  };

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
    writeStderrLine(`Unknown command "${cmd}".`);
    const suggestions = suggestCliCommands(cmd);
    if (suggestions.length) writeStderrLine(`Did you mean: ${suggestions.join(", ")}?`);
    const route = routeForCliIntent(cmd);
    if (route) writeStderrLine(`Try: ${route}`);
    exitCli(1);
    return;
  }
  try {
    validateCliArgs(cmd, parsed);
  } catch (error) {
    writeStderrLine(error instanceof Error ? error.message : String(error));
    exitCli(2);
  }
  if (cmd === "viewer") {
    // Keep the human-only browser server out of normal agent command startup.
    const { handleViewerCommand } = await import("./cli/viewer.js");
    await handleViewerCommand({
      getOpt,
      hasFlag,
      cwd: getCwd,
      writeStderrLine,
      writeStdoutLine,
      exit: exitCli,
    });
    return;
  }

  const reportFile = getOpt("--report-file");
  const reportEnabled = hasFlag("--report") || reportFile !== undefined;
  const nativeMode = parseNativeRuntimeMode(getOpt("--native"));
  const useNativeWorkers = hasFlag("--workers");
  const workerOpts = useNativeWorkers ? ({ useNativeWorkers: true } as const) : ({} as const);
  let progressPolicy: CliProgressPolicy = "auto";
  if (hasFlag("--no-progress")) {
    progressPolicy = "never";
  } else if (hasFlag("--progress")) {
    progressPolicy = "always";
  }
  const showBuildDiagnostics = hasFlag("--progress");
  const progressHandler = createCliProgressHandler(progressPolicy);
  const graphFlags = {
    fast: hasFlag("--fast-graph"),
    resolveNodeModules: hasFlag("--resolve-node-modules"),
    dynamicImportHeuristics: hasFlag("--dynamic-import-heuristics"),
    resolutionHints: parsed.options.get("--resolution-hint") ?? [],
  };
  let hasGraphOverrides =
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

  if (cmd === "impact" && parsed.positionals.length) {
    const impactRootArg = parsed.positionals[0]!;
    const resolvedImpactRoot = resolveAbs(impactRootArg);
    const isLegacyImpactRoot = !rootOpt && isExistingDirectory(resolvedImpactRoot);
    if (!isLegacyImpactRoot) {
      writeStderrLine(`Unexpected positional argument for impact: ${impactRootArg}`);
      writeStderrLine("Usage: codegraph impact [project-root] [--provider git|github|raw] [options]");
      exitCli(2);
    }
  }

  const firstPositionalRoot = parsed.positionals.length === 1 ? resolveAbs(parsed.positionals[0]!) : undefined;
  if (isLifecycleCommand(cmd) && rootOpt && parsed.positionals.length) {
    writeStderrLine(
      `Invalid ${cmd} path "${parsed.positionals[0]!}". Positional paths cannot be combined with --root for lifecycle commands.`,
    );
    exitCli(2);
    return;
  }
  if (
    isLifecycleCommand(cmd) &&
    !rootOpt &&
    firstPositionalRoot !== undefined &&
    !isExistingDirectory(firstPositionalRoot)
  ) {
    writeStderrLine(
      `Invalid ${cmd} path "${parsed.positionals[0]!}". Expected an existing directory or use --root <path>.`,
    );
    exitCli(2);
    return;
  }
  if (acceptsOptionalProjectRoot(cmd) && rootOpt && parsed.positionals.length) {
    writeStderrLine(`Positional project root cannot be combined with --root for ${cmd}.`);
    exitCli(2);
    return;
  }
  if (
    acceptsOptionalProjectRoot(cmd) &&
    !rootOpt &&
    firstPositionalRoot !== undefined &&
    !isExistingDirectory(firstPositionalRoot)
  ) {
    writeStderrLine(`Invalid ${cmd} project root "${parsed.positionals[0]!}". Expected an existing directory.`);
    exitCli(2);
    return;
  }
  const defaultProjectRoot =
    (cmd === "graph" ||
      cmd === "graph-delta" ||
      cmd === "index" ||
      cmd === "hotspots" ||
      cmd === "inspect" ||
      cmd === "duplicates" ||
      cmd === "impact" ||
      cmd === "review" ||
      cmd === "apisurface" ||
      cmd === "unresolved" ||
      isLifecycleCommand(cmd)) &&
    !rootOpt &&
    firstPositionalRoot !== undefined &&
    isExistingDirectory(firstPositionalRoot)
      ? firstPositionalRoot
      : getCwd();

  const projectRootFs = rootOpt ? resolveAbs(rootOpt) : defaultProjectRoot;
  const projectRootAbs = projectRootFs.replace(/\\/g, "/");
  const includeGlobs = parsed.options.get("--include-glob") ?? [];
  const scanIgnoreGlobs = parsed.options.get("--ignore-glob") ?? [];
  const rootIncludeGlobs = parsed.options.get("--include-root-glob") ?? [];
  const rootIgnoreGlobs = parsed.options.get("--ignore-root-glob") ?? [];
  const cliGlobDiscoveryOptions: ProjectFileDiscoveryOptions = {
    ...(includeGlobs.length ? { includeGlobs } : {}),
    ...(scanIgnoreGlobs.length ? { ignoreGlobs: scanIgnoreGlobs } : {}),
  };
  const supportsRootDiscoveryGlobs = cmd === "duplicates";
  if (!supportsRootDiscoveryGlobs && (rootIncludeGlobs.length || rootIgnoreGlobs.length)) {
    throw new Error("The --include-root-glob and --ignore-root-glob flags are currently supported only by duplicates.");
  }
  const activeCliRootGlobDiscoveryOptions: ProjectFileDiscoveryOptions = supportsRootDiscoveryGlobs
    ? {
        ...(rootIncludeGlobs.length ? { includeGlobs: rootIncludeGlobs } : {}),
        ...(rootIgnoreGlobs.length ? { ignoreGlobs: rootIgnoreGlobs } : {}),
      }
    : {};
  const cliGitignoreDiscoveryOptions: ProjectFileDiscoveryOptions = {
    ...(hasFlag("--no-gitignore") ? { useGitignore: false } : {}),
  };
  const hasCliDiscoveryGlobs = Boolean(
    includeGlobs.length ||
    scanIgnoreGlobs.length ||
    activeCliRootGlobDiscoveryOptions.includeGlobs?.length ||
    activeCliRootGlobDiscoveryOptions.ignoreGlobs?.length,
  );

  if (cmd === "version") {
    if (hasFlag("--json")) {
      writeJSONLine(getCodegraphPackageIdentity());
    } else {
      writeStdoutLine(getCodegraphVersion());
    }
    return;
  }

  if (cmd === "doctor") {
    const { buildDoctorReport } = await import("./cli/doctor.js");
    writeCliOutput({ hasFlag, writeJSONLine, writeStdoutLine }, buildDoctorReport(parsed.positionals.at(-1)));
    return;
  }

  if (cmd === "skill") {
    const { handleSkillCommand } = await import("./cli/skill.js");
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

  if (cmd === "install" || cmd === "uninstall") {
    const { handleInstallerCommand } = await import("./cli/install.js");
    await handleInstallerCommand({
      command: cmd,
      positionals: parsed.positionals,
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      interactive: isCliInteractiveTerminal,
      promptLine: promptCliLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "sql") {
    const { handleSqlCommand } = await import("./cli/sql.js");
    await handleSqlCommand({
      positionals: parsed.positionals,
      getOpt,
      hasFlag,
      cwd: getCwd,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "chunk") {
    const { handleChunkCommand } = await import("./cli/chunk.js");
    await handleChunkCommand({
      positionals: parsed.positionals,
      getOpt,
      hasFlag,
      cwd: getCwd,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  const { hasDiscoveryOptions, loadCodegraphConfig, mergeDiscoveryOptions } = await loadConfigHelpers();
  const explicitDiscoveryOptions = mergeDiscoveryOptions(cliGlobDiscoveryOptions, cliGitignoreDiscoveryOptions);
  const config = await loadCodegraphConfig(projectRootFs);
  graphFlags.resolutionHints = normalizeResolutionHints([
    ...(config.graph?.resolutionHints ?? []),
    ...graphFlags.resolutionHints,
  ]);
  hasGraphOverrides =
    graphFlags.fast ||
    graphFlags.resolveNodeModules ||
    graphFlags.dynamicImportHeuristics ||
    !!graphFlags.resolutionHints.length;
  const baseDiscoveryOptions = mergeDiscoveryOptions(config.discovery, cliGitignoreDiscoveryOptions);
  const mergedDiscoveryOptions = mergeDiscoveryOptions(config.discovery, explicitDiscoveryOptions);
  const rootFilteredDiscoveryOptions = mergeDiscoveryOptions(baseDiscoveryOptions, activeCliRootGlobDiscoveryOptions);
  const discoveryOptions: ProjectFileDiscoveryOptions = hasDiscoveryOptions(mergedDiscoveryOptions)
    ? { ...mergedDiscoveryOptions, globRoot: projectRootFs }
    : {};
  const diagnosticDiscoveryOptions: ProjectFileDiscoveryOptions = hasDiscoveryOptions(baseDiscoveryOptions)
    ? { ...baseDiscoveryOptions, globRoot: projectRootFs }
    : {};
  const includeRootDiscoveryOptions: ProjectFileDiscoveryOptions = hasDiscoveryOptions(rootFilteredDiscoveryOptions)
    ? { ...rootFilteredDiscoveryOptions, globRoot: projectRootFs }
    : {};
  const cliGlobDiagnostics: string[] = [];

  const supportsIncludeRoots =
    cmd === "graph" ||
    cmd === "index" ||
    cmd === "hotspots" ||
    cmd === "inspect" ||
    cmd === "duplicates" ||
    cmd === "drift" ||
    cmd === "orient" ||
    cmd === "cycles";
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

  const { isPathUnderIncludeRoots } = await loadIncludeRootsHelpers();
  const isUnderIncludeRoots = (filePath: string): boolean => {
    return isPathUnderIncludeRoots(filePath.replace(/\\/g, "/"), includeRootsAbs);
  };
  const displayScanRoot = (scanRoot: string): string => {
    const relative = normalizePath(path.relative(projectRootFs, scanRoot));
    if (!relative) return ".";
    return relative;
  };

  const { diagnoseCliDiscoveryGlobs, filterFilesByCliDiscoveryGlobs } = await loadDiscoveryGlobHelpers();
  const recordCliGlobDiagnostics = (files: readonly string[], scanRoot: string): void => {
    for (const diagnostic of diagnoseCliDiscoveryGlobs(files, scanRoot, projectRootFs, cliGlobDiscoveryOptions)) {
      const optionName = diagnostic.kind === "include" ? "--include-glob" : "--ignore-glob";
      let message = `Warning: ${optionName} "${diagnostic.glob}" matched no files under scan root "${displayScanRoot(
        diagnostic.scanRoot,
      )}". CLI globs are relative to each active scan root.`;
      if (diagnostic.suggestion) {
        message += ` Did you mean "${diagnostic.suggestion}"?`;
      }
      cliGlobDiagnostics.push(message);
    }
  };

  const applyCliDiscoveryFilters = (files: readonly string[]): string[] => {
    const rootFilteredFiles = filterFilesByCliDiscoveryGlobs(files, projectRootFs, activeCliRootGlobDiscoveryOptions);
    if (!includeRootsAbs.length) {
      return filterFilesByCliDiscoveryGlobs(rootFilteredFiles, projectRootFs, cliGlobDiscoveryOptions);
    }

    const matchedFiles = new Set<string>();
    for (const scanRoot of includeRootsAbs) {
      const scanRootFiles = rootFilteredFiles.filter((filePath) => {
        const normalizedFile = filePath.replace(/\\/g, "/");
        return normalizedFile === scanRoot || normalizedFile.startsWith(`${scanRoot}/`);
      });
      for (const filePath of filterFilesByCliDiscoveryGlobs(scanRootFiles, scanRoot, cliGlobDiscoveryOptions)) {
        matchedFiles.add(filePath);
      }
    }
    return rootFilteredFiles.filter((filePath) => matchedFiles.has(filePath));
  };

  const resolveFilesFromRoots = async (): Promise<string[]> => {
    const { listProjectFiles } = await loadProjectFilesHelpers();
    const patterns = cmd === "duplicates" ? await getDuplicateProjectPatterns() : undefined;
    if (!includeRootsAbs.length) {
      const diagnosticFiles = await listProjectFiles(projectRootFs, patterns, {
        ...diagnosticDiscoveryOptions,
        gitignoreRoot: projectRootFs,
      });
      recordCliGlobDiagnostics(diagnosticFiles, projectRootFs);
      flushCliGlobDiagnostics();
      if (!hasDiscoveryOptions(activeCliRootGlobDiscoveryOptions)) {
        return await listProjectFiles(projectRootFs, patterns, {
          ...discoveryOptions,
          gitignoreRoot: projectRootFs,
        });
      }
      return applyCliDiscoveryFilters(diagnosticFiles);
    }
    const normalizedRoots = includeRootsAbs;
    const all: string[][] = await Promise.all(
      normalizedRoots.map(async (r) => {
        const files = await listProjectFiles(r, patterns, {
          ...diagnosticDiscoveryOptions,
          gitignoreRoot: projectRootFs,
        });
        recordCliGlobDiagnostics(files, r);
        return files;
      }),
    );
    flushCliGlobDiagnostics();
    return applyCliDiscoveryFilters(Array.from(new Set(all.flat())));
  };

  const listProjectFilesForScan = async (scanRoot: string): Promise<string[]> => {
    const { listProjectFiles } = await loadProjectFilesHelpers();
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
    const { listChangedFiles } = await loadGitHelpers();
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

  const flushCliGlobDiagnostics = (): void => {
    for (const diagnostic of Array.from(new Set(cliGlobDiagnostics))) {
      writeStderrLine(diagnostic);
    }
    cliGlobDiagnostics.length = 0;
  };

  const emitCliGlobDiagnosticsForChangedFiles = async (files: readonly string[]): Promise<void> => {
    if (!cliGlobDiscoveryOptions.includeGlobs?.length && !cliGlobDiscoveryOptions.ignoreGlobs?.length) return;
    const patterns = cmd === "duplicates" ? await getDuplicateProjectPatterns() : undefined;
    const deletedFiles = files.filter((filePath) => !fs.existsSync(filePath));
    const scanRoots = includeRootsAbs.length ? includeRootsAbs : [projectRootFs];
    await Promise.all(
      scanRoots.map(async (scanRoot) => {
        const { listProjectFiles } = await loadProjectFilesHelpers();
        const currentFiles = fs.existsSync(scanRoot)
          ? await listProjectFiles(scanRoot, patterns, {
              ...diagnosticDiscoveryOptions,
              gitignoreRoot: projectRootFs,
            })
          : [];
        const deletedScanRootFiles = deletedFiles.filter((filePath) => {
          const normalizedFile = filePath.replace(/\\/g, "/");
          return normalizedFile === scanRoot || normalizedFile.startsWith(`${scanRoot}/`);
        });
        recordCliGlobDiagnostics(Array.from(new Set([...currentFiles, ...deletedScanRootFiles])), scanRoot);
      }),
    );
    flushCliGlobDiagnostics();
  };

  const resolveChangedFilesWithDeletes = async (): Promise<{
    existingFiles: string[];
    deletedFiles: string[];
  } | null> => {
    const gitFiles = await resolveChangedFiles();
    if (!gitFiles) return null;
    await emitCliGlobDiagnosticsForChangedFiles(gitFiles);
    const existence = gitFiles.map((file: string) => ({
      file,
      exists: fs.existsSync(file),
    }));
    const existingFiles = applyCliDiscoveryFilters(
      existence.filter((entry) => entry.exists).map((entry) => entry.file),
    );
    const deletedFiles = applyCliDiscoveryFilters(
      existence.filter((entry) => !entry.exists).map((entry) => entry.file),
    );
    return { existingFiles, deletedFiles };
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

  if (isLifecycleCommand(cmd)) {
    try {
      const { handleLifecycleCommand } = await import("./cli/lifecycle.js");
      await handleLifecycleCommand({
        command: cmd,
        root: projectRootFs,
        buildOptions: buildAgentOptions(),
        hasFlag,
        writeJSONLine,
        writeStdoutLine,
      });
    } catch (error) {
      const { CodegraphLifecycleUserError } = await import("./lifecycle/manifest.js");
      if (error instanceof CodegraphLifecycleUserError) {
        writeStderrLine(error.message);
        exitCli(1);
      }
      throw error;
    }
    return;
  }
  if (cmd === "explore") {
    const { handleExploreCommand } = await import("./cli/explore.js");
    await handleExploreCommand({
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
  if (cmd === "file") {
    const { handleFileCommand } = await import("./cli/file.js");
    await handleFileCommand({
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

  if (cmd === "search") {
    const { handleSearchCommand } = await import("./cli/search.js");
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

  if (cmd === "symbols") {
    const { handleSymbolsCommand } = await import("./cli/symbols.js");
    await handleSymbolsCommand({
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

  if (cmd === "refactor-plan") {
    const { handleRefactorPlanCommand } = await import("./cli/refactorPlan.js");
    await handleRefactorPlanCommand({
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

  if (cmd === "rename-preview") {
    const { handleRenamePreviewCommand } = await import("./cli/renamePreview.js");
    await handleRenamePreviewCommand({
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

  if (cmd === "callers" || cmd === "callees") {
    const { handleCallHierarchyCommand } = await import("./cli/callHierarchy.js");
    await handleCallHierarchyCommand(cmd, {
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

  if (cmd === "supertypes" || cmd === "subtypes" || cmd === "implementations") {
    const { handleTypeHierarchyCommand } = await import("./cli/typeHierarchy.js");
    await handleTypeHierarchyCommand(cmd, {
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
    const { handleExplainCommand } = await import("./cli/explain.js");
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
    const { handleOrientCommand } = await import("./cli/orient.js");
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
    const { handlePacketCommand } = await import("./cli/packet.js");
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
    if (hasCliDiscoveryGlobs && (gitBase || gitHead || changedSince)) {
      throw new Error(
        "graph-delta does not support CLI discovery globs together with --git-base/--git-head or --changed-since.",
      );
    }
    const files = await resolveFiles();
    const { handleGraphDeltaCommand } = await import("./cli/graphDelta.js");
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
      progressHandler,
      writeJSONLine,
      writeStdoutLine,
    });
    return;
  }

  if (cmd === "graph") {
    if (hasCliDiscoveryGlobs && (gitBase || gitHead || changedSince) && (getOpt("--sqlite") || getOpt("--db"))) {
      throw new Error(
        "graph does not support CLI discovery globs together with --git-base/--git-head or --changed-since when --sqlite/--db is used.",
      );
    }
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
      showProgress: showBuildDiagnostics,
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
    const { handleIndexCommand } = await import("./cli/index.js");
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
      writeStdoutLine,
      writeStderrLine,
      writeCommandReport,
      maybeWriteNativeBackendStatus,
      showProgress: showBuildDiagnostics,
    });
    return;
  }

  if (cmd === "drift") {
    const driftGraphOptions = hasGraphOverrides || nativeMode !== "auto" ? buildGraphOptions() : undefined;
    const { handleDriftCommand } = await import("./cli/drift.js");
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
    const duplicateIndexOptions = buildAgentOptions();
    duplicateIndexOptions.cache ??= "disk";
    const { handleDuplicatesCommand } = await import("./cli/duplicates.js");
    await handleDuplicatesCommand({
      projectRootFs,
      files,
      getOpt,
      hasFlag,
      indexOptions: duplicateIndexOptions,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "dumpmod") {
    const { handleDumpmodCommand } = await import("./cli/navigation.js");
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
    const { handleGotoCommand } = await import("./cli/navigation.js");
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
    const { handleRefsCommand } = await import("./cli/navigation.js");
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
    const { handleGrepCommand } = await import("./cli/grep.js");
    await handleGrepCommand({
      positionals: parsed.positionals,
      projectRootFs,
      discoveryOptions,
      parsedOptions: parsed.options,
      getOpt,
      hasFlag,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      exit: exitCli,
    });
    return;
  }

  if (cmd === "impact") {
    const { handleImpactCommand } = await import("./cli/impact.js");
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
    const { handleReviewCommand } = await import("./cli/review.js");
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
      progressHandler,
      writeJSONLine,
      writeStdoutLine,
      writeStderrLine,
      writeCommandReport,
      exit: exitCli,
    });
    return;
  }

  const buildGraphQueryIndexOptions = (graphOptions: GraphBuildOptions | undefined): BuildOptions => {
    const options = buildAgentOptions();
    options.cache ??= "disk";
    if (graphOptions) options.graph = graphOptions;
    return options;
  };

  if (cmd === "deps" || cmd === "rdeps") {
    const graphOptions = hasGraphOverrides || nativeMode !== "auto" ? buildGraphOptions() : undefined;
    const { handleGraphQueryCommand } = await import("./cli/graphQueries.js");
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
    const { handleGraphQueryCommand } = await import("./cli/graphQueries.js");
    const collectGraph =
      cmd === "cycles" && includeRootsAbs.length ? (await import("./graph-builder.js")).collectGraph : undefined;
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
      listProjectFilesForScan: async () => {
        if (cmd === "cycles") return await resolveFilesFromRoots();
        return await listProjectFilesForScan(projectRootFs);
      },
      ...(collectGraph ? { collectGraph } : {}),
      ...(graphOptions ? { graphOptions } : {}),
      indexOptions: buildGraphQueryIndexOptions(graphOptions),
    });
    return;
  }

  if (cmd === "inspect") {
    const { handleInspectCommand } = await import("./cli/inspect.js");
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
    const { handleHotspotsCommand } = await import("./cli/inspect.js");
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
    const { handleGraphQueryCommand } = await import("./cli/graphQueries.js");
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
      indexOptions: buildGraphQueryIndexOptions(undefined),
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

export async function main(rawArgs: string[] = process.argv.slice(2)): Promise<void> {
  // Keep the failure path inside the ALS CLI context so --stderr-file (and other
  // context-local state) remains visible to writeError/writeStderrLine.
  await runWithCliRuntime({}, async () => {
    try {
      await runCliWithActiveRuntime(rawArgs);
    } catch (error) {
      writeError(error);
      exitCli(1);
    }
  });
}

if (isDirectCliExecution(import.meta.url)) {
  void main();
}
