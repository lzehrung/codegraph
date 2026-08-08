import fs from "node:fs";
import path from "node:path";
import type { GraphBuildOptions } from "../graphs/types.js";
import type { CodegraphConfig } from "../config.js";
import {
  createCurrentProjectIndexLoader,
  type CurrentProjectIndexLoader,
} from "../indexer/load-current-index.js";
import type { BuildOptions } from "../indexer/types.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import { normalizePath, normalizeResolutionHints, resolveFilePathFromRoot, toProjectDisplayPath } from "../util/paths.js";
import type { ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import { createCliProgressHandler, exitCli, getCwd, writeStderrLine } from "./context.js";
import { parseCacheModeOption, parseOptionalNonNegativeIntegerOption, type ParsedCliArgs } from "./options.js";
import type { CliProgressPolicy } from "./progress.js";
import {
  assertValidIncludeRoots,
  parseNativeRuntimeMode,
  resolveCliDiscoveryGlobPolicy,
  resolveCliIncludeRoots,
  resolveCliRootPolicy,
} from "./rootPolicy.js";

type DiscoveryGlobHelpers = typeof import("./discoveryGlobs.js");
type ConfigHelpers = typeof import("../config.js");
type ProjectFilesHelpers = typeof import("../util/projectFiles.js");
type GitHelpers = typeof import("../util/git.js");
type IncludeRootsHelpers = typeof import("../util/includeRoots.js");

let discoveryGlobHelpersPromise: Promise<DiscoveryGlobHelpers> | undefined;
let configHelpersPromise: Promise<ConfigHelpers> | undefined;
let projectFilesHelpersPromise: Promise<ProjectFilesHelpers> | undefined;
let gitHelpersPromise: Promise<GitHelpers> | undefined;
let includeRootsHelpersPromise: Promise<IncludeRootsHelpers> | undefined;

function loadDiscoveryGlobHelpers(): Promise<DiscoveryGlobHelpers> {
  discoveryGlobHelpersPromise ??= import("./discoveryGlobs.js");
  return discoveryGlobHelpersPromise;
}

function loadConfigHelpers(): Promise<ConfigHelpers> {
  configHelpersPromise ??= import("../config.js");
  return configHelpersPromise;
}

function loadProjectFilesHelpers(): Promise<ProjectFilesHelpers> {
  projectFilesHelpersPromise ??= import("../util/projectFiles.js");
  return projectFilesHelpersPromise;
}

function loadGitHelpers(): Promise<GitHelpers> {
  gitHelpersPromise ??= import("../util/git.js");
  return gitHelpersPromise;
}

function loadIncludeRootsHelpers(): Promise<IncludeRootsHelpers> {
  includeRootsHelpersPromise ??= import("../util/includeRoots.js");
  return includeRootsHelpersPromise;
}

async function getDuplicateProjectPatterns(): Promise<string[]> {
  const { DEFAULT_PROJECT_PATTERNS } = await loadProjectFilesHelpers();
  return [...DEFAULT_PROJECT_PATTERNS, "**/*.{json,jsonc,toml,txt,yaml,yml}"];
}

export type CliGraphFlags = {
  fast: boolean;
  resolveNodeModules: boolean;
  dynamicImportHeuristics: boolean;
  resolutionHints: string[];
};

/**
 * Everything derivable from the parsed argv before the project config and
 * discovery plan are loaded. Early command table entries (version, doctor,
 * skill, install, sql, chunk) run against this context only.
 */
export type CliBaseContext = {
  command: string;
  parsed: ParsedCliArgs;
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  reportFile: string | undefined;
  reportEnabled: boolean;
  nativeMode: NativeRuntimeMode;
  useNativeWorkers: boolean;
  workerOpts: { useNativeWorkers: true } | Record<string, never>;
  progressHandler: BuildOptions["onProgress"];
  showBuildDiagnostics: boolean;
  graphFlags: CliGraphFlags;
  hasGraphOverrides: boolean;
  buildGraphOptions: () => GraphBuildOptions;
  gitBase: string | undefined;
  gitHead: string | undefined;
  changedSince: string | undefined;
  projectRootFs: string;
  projectRootAbs: string;
  cliGlobDiscoveryOptions: ProjectFileDiscoveryOptions;
  activeCliRootGlobDiscoveryOptions: ProjectFileDiscoveryOptions;
  cliGitignoreDiscoveryOptions: ProjectFileDiscoveryOptions;
  hasCliDiscoveryGlobs: boolean;
};

/** Full invocation context: base options plus config, discovery, include roots, and file resolution. */
export type CliProjectContext = CliBaseContext & {
  config: CodegraphConfig;
  discoveryOptions: ProjectFileDiscoveryOptions;
  diagnosticDiscoveryOptions: ProjectFileDiscoveryOptions;
  includeRootDiscoveryOptions: ProjectFileDiscoveryOptions;
  includeRoots: string[];
  includeRootsAbs: string[];
  buildAgentOptions: () => BuildOptions;
  createGraphQueryIndexLoader: (
    graphOptions: GraphBuildOptions | undefined,
  ) => ReturnType<typeof createCurrentProjectIndexLoader>;
  resolveFiles: () => Promise<string[]>;
  resolveFilesFromRoots: () => Promise<string[]>;
  listProjectFilesForScan: (scanRoot: string) => Promise<string[]>;
  resolveChangedFilesWithDeletes: () => Promise<{ existingFiles: string[]; deletedFiles: string[] } | null>;
};

export type CliOptionAccessors = {
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
};

export function createCliOptionAccessors(parsed: ParsedCliArgs): CliOptionAccessors {
  const hasFlag = (name: string) => parsed.flags.has(name);
  const getOpt = (name: string) => {
    const v = parsed.options.get(name);
    return v?.length ? v[v.length - 1] : undefined;
  };
  return { getOpt, hasFlag };
}

/**
 * Build the base context: shared option policy plus root/discovery-glob policy.
 * Root-policy violations write to stderr and exit 2, matching the historical
 * dispatcher.
 */
export function createCliBaseContext(command: string, parsed: ParsedCliArgs): CliBaseContext {
  const { getOpt, hasFlag } = createCliOptionAccessors(parsed);

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
  const graphFlags: CliGraphFlags = {
    fast: hasFlag("--fast-graph"),
    resolveNodeModules: hasFlag("--resolve-node-modules"),
    dynamicImportHeuristics: hasFlag("--dynamic-import-heuristics"),
    resolutionHints: parsed.options.get("--resolution-hint") ?? [],
  };
  const computeHasGraphOverrides = (): boolean =>
    graphFlags.fast ||
    graphFlags.resolveNodeModules ||
    graphFlags.dynamicImportHeuristics ||
    !!graphFlags.resolutionHints.length;
  const hasGraphOverrides = computeHasGraphOverrides();
  const buildGraphOptions = (): GraphBuildOptions => ({
    fast: graphFlags.fast,
    resolveNodeModules: graphFlags.resolveNodeModules,
    dynamicImportHeuristics: graphFlags.dynamicImportHeuristics,
    ...(nativeMode !== "auto" ? { native: nativeMode } : {}),
    ...(graphFlags.resolutionHints.length ? { resolutionHints: graphFlags.resolutionHints } : {}),
  });

  const changedSince = getOpt("--changed-since");
  const gitBase = getOpt("--git-base");
  const gitHead = getOpt("--git-head");
  const rootOpt = getOpt("--root");

  const rootPolicy = resolveCliRootPolicy({ command, positionals: parsed.positionals, rootOpt, cwd: getCwd });
  if (rootPolicy.status === "error") {
    for (const message of rootPolicy.messages) {
      writeStderrLine(message);
    }
    exitCli(2);
  }
  const projectRootFs = rootPolicy.projectRootFs;
  const projectRootAbs = normalizePath(projectRootFs);
  const globPolicy = resolveCliDiscoveryGlobPolicy(command, parsed);

  return {
    command,
    parsed,
    getOpt,
    hasFlag,
    reportFile,
    reportEnabled,
    nativeMode,
    useNativeWorkers,
    workerOpts,
    progressHandler,
    showBuildDiagnostics,
    graphFlags,
    hasGraphOverrides,
    buildGraphOptions,
    gitBase,
    gitHead,
    changedSince,
    projectRootFs,
    projectRootAbs,
    ...globPolicy,
  };
}

/** Load config, merge discovery options, resolve include roots, and wire file resolution. */
export async function loadCliProjectContext(base: CliBaseContext): Promise<CliProjectContext> {
  const { command, parsed, getOpt, hasFlag, projectRootFs } = base;
  const {
    cliGlobDiscoveryOptions,
    activeCliRootGlobDiscoveryOptions,
    cliGitignoreDiscoveryOptions,
    gitBase,
    gitHead,
    changedSince,
    graphFlags,
  } = base;

  const { hasDiscoveryOptions, loadCodegraphConfig, mergeDiscoveryOptions } = await loadConfigHelpers();
  const explicitDiscoveryOptions = mergeDiscoveryOptions(cliGlobDiscoveryOptions, cliGitignoreDiscoveryOptions);
  const config = await loadCodegraphConfig(projectRootFs);
  graphFlags.resolutionHints = normalizeResolutionHints([
    ...(config.graph?.resolutionHints ?? []),
    ...graphFlags.resolutionHints,
  ]);
  const hasGraphOverrides =
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

  const includeRoots = resolveCliIncludeRoots({
    command,
    positionals: parsed.positionals,
    rootOpt: getOpt("--root"),
    cwd: getCwd,
  });
  assertValidIncludeRoots(command, projectRootFs, includeRoots);
  const includeRootsAbs = includeRoots.map((r) => normalizePath(resolveFilePathFromRoot(projectRootFs, r)));

  const { isPathUnderIncludeRoots } = await loadIncludeRootsHelpers();
  const isUnderIncludeRoots = (filePath: string): boolean => {
    return isPathUnderIncludeRoots(normalizePath(filePath), includeRootsAbs);
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

  const flushCliGlobDiagnostics = (): void => {
    for (const diagnostic of Array.from(new Set(cliGlobDiagnostics))) {
      writeStderrLine(diagnostic);
    }
    cliGlobDiagnostics.length = 0;
  };

  const applyCliDiscoveryFilters = (files: readonly string[]): string[] => {
    const rootFilteredFiles = filterFilesByCliDiscoveryGlobs(files, projectRootFs, activeCliRootGlobDiscoveryOptions);
    if (!includeRootsAbs.length) {
      return filterFilesByCliDiscoveryGlobs(rootFilteredFiles, projectRootFs, cliGlobDiscoveryOptions);
    }

    const matchedFiles = new Set<string>();
    for (const scanRoot of includeRootsAbs) {
      const scanRootFiles = rootFilteredFiles.filter((filePath) => {
        const normalizedFile = normalizePath(filePath);
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
    const basePatterns = command === "duplicates" ? await getDuplicateProjectPatterns() : undefined;
    const [{ languageExtensionPatterns }, { DEFAULT_PROJECT_PATTERNS }] = await Promise.all([
      import("../languages.js"),
      loadProjectFilesHelpers(),
    ]);
    const customPatterns = languageExtensionPatterns(config.languages?.extensions);
    const patterns = customPatterns.length
      ? [...(basePatterns ?? DEFAULT_PROJECT_PATTERNS), ...customPatterns]
      : basePatterns;
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

  const emitCliGlobDiagnosticsForChangedFiles = async (files: readonly string[]): Promise<void> => {
    if (!cliGlobDiscoveryOptions.includeGlobs?.length && !cliGlobDiscoveryOptions.ignoreGlobs?.length) return;
    const patterns = command === "duplicates" ? await getDuplicateProjectPatterns() : undefined;
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
          const normalizedFile = normalizePath(filePath);
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

  const buildAgentOptions = (): BuildOptions => {
    const cache = parseCacheModeOption(getOpt("--cache"));
    const threads = parseOptionalNonNegativeIntegerOption(getOpt("--threads"), "--threads");
    return {
      ...(base.progressHandler ? { onProgress: base.progressHandler } : {}),
      discovery: discoveryOptions,
      ...(config.languages?.extensions ? { languageExtensions: config.languages.extensions } : {}),
      ...(cache !== undefined ? { cache } : {}),
      ...(hasFlag("--cache-strict") ? { cacheStrict: true } : {}),
      ...(hasFlag("--cache-verify") ? { cacheVerify: true } : {}),
      ...(hasGraphOverrides || base.nativeMode !== "auto" ? { graph: base.buildGraphOptions() } : {}),
      ...(base.nativeMode !== "auto" ? { native: base.nativeMode } : {}),
      ...(threads !== undefined ? { threads } : {}),
      ...base.workerOpts,
    };
  };

  // One place decides how current-state queries load the index: the shared loader
  // supplies the disk-cache default and the project scope encoding.
  const createGraphQueryIndexLoader = (graphOptions: GraphBuildOptions | undefined): CurrentProjectIndexLoader => {
    const options = buildAgentOptions();
    if (graphOptions) options.graph = graphOptions;
    return createCurrentProjectIndexLoader(projectRootFs, options);
  };

  return {
    ...base,
    hasGraphOverrides,
    config,
    discoveryOptions,
    diagnosticDiscoveryOptions,
    includeRootDiscoveryOptions,
    includeRoots,
    includeRootsAbs,
    buildAgentOptions,
    createGraphQueryIndexLoader,
    resolveFiles,
    resolveFilesFromRoots,
    listProjectFilesForScan,
    resolveChangedFilesWithDeletes,
  };
}
