import type { BuildReport } from "../indexer/types.js";
import {
  exitCli,
  getCwd,
  isCliInteractiveTerminal,
  maybeWriteNativeBackendStatus,
  promptCliLine,
  readCliStdin,
  setCliStderrFilePath,
  writeCommandReport,
  writeJSONLine,
  writeStderrLine,
  writeStdoutLine,
  type CommandReport,
} from "./context.js";
import type { CliBaseContext, CliProjectContext } from "./invocationContext.js";
import { getCodegraphPackageIdentity, getCodegraphVersion } from "../util/packageInfo.js";
import { writeCliOutput } from "./pretty.js";

/**
 * Command dispatch table. Each entry owns its lazy `import()` thunk so MCP and
 * library startup stay off the CLI dependency graph. `base` entries run before
 * the project config/discovery plan loads; `project` entries receive the full
 * invocation context.
 */
export type CliCommandEntry =
  | { stage: "base"; run: (ctx: CliBaseContext) => Promise<void> | void }
  | { stage: "project"; run: (ctx: CliProjectContext) => Promise<void> };

function agentIo(ctx: CliProjectContext) {
  return {
    positionals: ctx.parsed.positionals,
    root: ctx.projectRootFs,
    buildOptions: ctx.buildAgentOptions(),
    getOpt: ctx.getOpt,
    hasFlag: ctx.hasFlag,
  };
}

const agentIoWriters = {
  writeJSONLine,
  writeStdoutLine,
  writeStderrLine,
  exit: exitCli,
} as const;

function graphQueryArgs(ctx: CliProjectContext) {
  const graphOptions = ctx.hasGraphOverrides || ctx.nativeMode !== "auto" ? ctx.buildGraphOptions() : undefined;
  return { ctx, graphOptions };
}

type LifecycleCommand = "init" | "status" | "sync" | "uninit";

async function runLifecycleCommand(ctx: CliProjectContext, command: LifecycleCommand): Promise<void> {
  try {
    const { handleLifecycleCommand } = await import("./lifecycle.js");
    await handleLifecycleCommand({
      command,
      root: ctx.projectRootFs,
      buildOptions: ctx.buildAgentOptions(),
      hasFlag: ctx.hasFlag,
      writeJSONLine,
      writeStdoutLine,
    });
  } catch (error) {
    const { CodegraphLifecycleUserError } = await import("../lifecycle/manifest.js");
    if (error instanceof CodegraphLifecycleUserError) {
      writeStderrLine(error.message);
      exitCli(1);
    }
    throw error;
  }
}

function lifecycleEntry(command: LifecycleCommand): CliCommandEntry {
  return { stage: "project", run: (ctx) => runLifecycleCommand(ctx, command) };
}

function installerEntry(command: "install" | "uninstall"): CliCommandEntry {
  return {
    stage: "base",
    run: async (ctx) => {
      const { handleInstallerCommand } = await import("./install.js");
      await handleInstallerCommand({
        command,
        positionals: ctx.parsed.positionals,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        interactive: isCliInteractiveTerminal,
        promptLine: promptCliLine,
        exit: exitCli,
      });
    },
  };
}

export const CLI_COMMAND_TABLE: Readonly<Record<string, CliCommandEntry>> = {
  version: {
    stage: "base",
    run: (ctx) => {
      if (ctx.hasFlag("--json")) {
        writeJSONLine(getCodegraphPackageIdentity());
      } else {
        writeStdoutLine(getCodegraphVersion());
      }
    },
  },
  doctor: {
    stage: "base",
    run: async (ctx) => {
      const { buildDoctorReport, formatDoctorSummary } = await import("./doctor.js");
      writeCliOutput(
        { hasFlag: ctx.hasFlag, writeJSONLine, writeStdoutLine },
        buildDoctorReport(ctx.parsed.positionals.at(-1)),
        formatDoctorSummary,
      );
    },
  },
  skill: {
    stage: "base",
    run: async (ctx) => {
      const { handleSkillCommand } = await import("./skill.js");
      await handleSkillCommand({
        positionals: ctx.parsed.positionals,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        exit: exitCli,
      });
    },
  },
  install: installerEntry("install"),
  uninstall: installerEntry("uninstall"),
  sql: {
    stage: "base",
    run: async (ctx) => {
      const { handleSqlCommand } = await import("./sql.js");
      await handleSqlCommand({
        positionals: ctx.parsed.positionals,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        cwd: getCwd,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        exit: exitCli,
      });
    },
  },
  chunk: {
    stage: "base",
    run: async (ctx) => {
      const { handleChunkCommand } = await import("./chunk.js");
      await handleChunkCommand({
        positionals: ctx.parsed.positionals,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        cwd: getCwd,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        exit: exitCli,
      });
    },
  },
  init: lifecycleEntry("init"),
  status: lifecycleEntry("status"),
  sync: lifecycleEntry("sync"),
  uninit: lifecycleEntry("uninit"),
  explore: {
    stage: "project",
    run: async (ctx) => {
      const { handleExploreCommand } = await import("./explore.js");
      await handleExploreCommand({ ...agentIo(ctx), ...agentIoWriters });
    },
  },
  file: {
    stage: "project",
    run: async (ctx) => {
      const { handleFileCommand } = await import("./file.js");
      await handleFileCommand({ ...agentIo(ctx), ...agentIoWriters });
    },
  },
  search: {
    stage: "project",
    run: async (ctx) => {
      const commandReport: CommandReport | undefined = ctx.reportEnabled
        ? { command: "search", timings: {} }
        : undefined;
      const indexReport: BuildReport | undefined = ctx.reportEnabled ? { timings: {} } : undefined;
      if (commandReport && indexReport) commandReport.index = indexReport;
      const buildOptions = ctx.buildAgentOptions();
      if (indexReport) buildOptions.report = indexReport;
      const { handleSearchCommand } = await import("./search.js");
      await handleSearchCommand({
        positionals: ctx.parsed.positionals,
        root: ctx.projectRootFs,
        buildOptions,
        reportFile: ctx.reportFile,
        commandReport,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        writeCommandReport,
        exit: exitCli,
      });
    },
  },
  symbols: {
    stage: "project",
    run: async (ctx) => {
      const { handleSymbolsCommand } = await import("./symbols.js");
      await handleSymbolsCommand({ ...agentIo(ctx), ...agentIoWriters });
    },
  },
  "refactor-plan": {
    stage: "project",
    run: async (ctx) => {
      const { handleRefactorPlanCommand } = await import("./refactorPlan.js");
      await handleRefactorPlanCommand({ ...agentIo(ctx), ...agentIoWriters });
    },
  },
  "rename-preview": {
    stage: "project",
    run: async (ctx) => {
      const { handleRenamePreviewCommand } = await import("./renamePreview.js");
      await handleRenamePreviewCommand({ ...agentIo(ctx), ...agentIoWriters });
    },
  },
  callers: {
    stage: "project",
    run: async (ctx) => {
      const { handleCallHierarchyCommand } = await import("./callHierarchy.js");
      await handleCallHierarchyCommand("callers", { ...agentIo(ctx), ...agentIoWriters });
    },
  },
  callees: {
    stage: "project",
    run: async (ctx) => {
      const { handleCallHierarchyCommand } = await import("./callHierarchy.js");
      await handleCallHierarchyCommand("callees", { ...agentIo(ctx), ...agentIoWriters });
    },
  },
  supertypes: {
    stage: "project",
    run: async (ctx) => {
      const { handleTypeHierarchyCommand } = await import("./typeHierarchy.js");
      await handleTypeHierarchyCommand("supertypes", { ...agentIo(ctx), ...agentIoWriters });
    },
  },
  subtypes: {
    stage: "project",
    run: async (ctx) => {
      const { handleTypeHierarchyCommand } = await import("./typeHierarchy.js");
      await handleTypeHierarchyCommand("subtypes", { ...agentIo(ctx), ...agentIoWriters });
    },
  },
  implementations: {
    stage: "project",
    run: async (ctx) => {
      const { handleTypeHierarchyCommand } = await import("./typeHierarchy.js");
      await handleTypeHierarchyCommand("implementations", { ...agentIo(ctx), ...agentIoWriters });
    },
  },
  explain: {
    stage: "project",
    run: async (ctx) => {
      const { handleExplainCommand } = await import("./explain.js");
      await handleExplainCommand({ ...agentIo(ctx), ...agentIoWriters });
    },
  },
  orient: {
    stage: "project",
    run: async (ctx) => {
      const commandReport: CommandReport | undefined = ctx.reportEnabled
        ? { command: "orient", timings: {} }
        : undefined;
      const indexReport: BuildReport | undefined = ctx.reportEnabled ? { timings: {} } : undefined;
      if (commandReport && indexReport) commandReport.index = indexReport;
      const { handleOrientCommand } = await import("./orient.js");
      await handleOrientCommand({
        ...agentIo(ctx),
        positionals: ctx.includeRoots,
        reportFile: ctx.reportFile,
        commandReport,
        writeCommandReport,
        ...agentIoWriters,
      });
    },
  },
  packet: {
    stage: "project",
    run: async (ctx) => {
      const { handlePacketCommand } = await import("./packet.js");
      await handlePacketCommand({ ...agentIo(ctx), ...agentIoWriters });
    },
  },
  artifact: {
    stage: "project",
    run: async (ctx) => {
      const { handleArtifactCommand } = await import("./artifact.js");
      await handleArtifactCommand({ ...agentIo(ctx), ...agentIoWriters });
    },
  },
  mcp: {
    stage: "project",
    run: async (ctx) => {
      const { handleMcpServeCommand } = await import("./mcp.js");
      await handleMcpServeCommand({
        positionals: ctx.parsed.positionals,
        root: ctx.projectRootAbs,
        buildOptions: ctx.buildAgentOptions(),
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        writeStderrLine,
        exit: exitCli,
      });
    },
  },
  server: {
    stage: "base",
    run: async (ctx) => {
      const { handleServerCommand } = await import("./server.js");
      await handleServerCommand({
        positionals: ctx.parsed.positionals,
        root: ctx.projectRootAbs,
        parsedOptions: ctx.parsed.options,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        exit: exitCli,
      });
    },
  },
  "graph-delta": {
    stage: "project",
    run: async (ctx) => {
      if (ctx.hasCliDiscoveryGlobs && (ctx.gitBase || ctx.gitHead || ctx.changedSince)) {
        throw new Error(
          "graph-delta does not support CLI discovery globs together with --git-base/--git-head or --changed-since.",
        );
      }
      const files = await ctx.resolveFiles();
      const { handleGraphDeltaCommand } = await import("./graphDelta.js");
      await handleGraphDeltaCommand({
        projectRootFs: ctx.projectRootFs,
        files,
        languageExtensions: ctx.config.languages?.extensions,
        cacheLocation: ctx.config.cache?.location,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        cwd: getCwd,
        nativeMode: ctx.nativeMode,
        workerOpts: ctx.workerOpts,
        graphOptions: ctx.hasGraphOverrides ? ctx.buildGraphOptions() : undefined,
        gitBase: ctx.gitBase,
        gitHead: ctx.gitHead,
        changedSince: ctx.changedSince,
        progressHandler: ctx.progressHandler,
        writeJSONLine,
        writeStdoutLine,
      });
    },
  },
  graph: {
    stage: "project",
    run: async (ctx) => {
      if (
        ctx.hasCliDiscoveryGlobs &&
        (ctx.gitBase || ctx.gitHead || ctx.changedSince) &&
        (ctx.getOpt("--sqlite") || ctx.getOpt("--db"))
      ) {
        throw new Error(
          "graph does not support CLI discovery globs together with --git-base/--git-head or --changed-since when --sqlite/--db is used.",
        );
      }
      const { handleGraphCommand } = await import("./graph.js");
      await handleGraphCommand({
        projectRootFs: ctx.projectRootFs,
        discoveryOptions: ctx.discoveryOptions,
        cacheLocation: ctx.config.cache?.location,
        nativeMode: ctx.nativeMode,
        workerOpts: ctx.workerOpts,
        progressHandler: ctx.progressHandler,
        graphFlags: ctx.graphFlags,
        gitBase: ctx.gitBase,
        gitHead: ctx.gitHead,
        changedSince: ctx.changedSince,
        reportEnabled: ctx.reportEnabled,
        reportFile: ctx.reportFile,
        showProgress: ctx.showBuildDiagnostics,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        cwd: getCwd,
        resolveFiles: ctx.resolveFiles,
        resolveChangedFilesWithDeletes: ctx.resolveChangedFilesWithDeletes,
        writeStdoutLine,
        setStderrFilePath: setCliStderrFilePath,
        writeCommandReport,
        maybeWriteNativeBackendStatus,
      });
    },
  },
  index: {
    stage: "project",
    run: async (ctx) => {
      const { handleIndexCommand } = await import("./index.js");
      await handleIndexCommand({
        projectRootFs: ctx.projectRootFs,
        includeRootsAbs: ctx.includeRootsAbs,
        gitBase: ctx.gitBase,
        changedSince: ctx.changedSince,
        discoveryOptions: ctx.discoveryOptions,
        nativeMode: ctx.nativeMode,
        workerOpts: ctx.workerOpts,
        languageExtensions: ctx.config.languages?.extensions,
        cacheLocation: ctx.config.cache?.location,
        progressHandler: ctx.progressHandler,
        graphOptions: ctx.hasGraphOverrides || ctx.nativeMode !== "auto" ? ctx.buildGraphOptions() : undefined,
        reportEnabled: ctx.reportEnabled,
        reportFile: ctx.reportFile,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        resolveFiles: ctx.resolveFiles,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        writeCommandReport,
        maybeWriteNativeBackendStatus,
        showProgress: ctx.showBuildDiagnostics,
      });
    },
  },
  drift: {
    stage: "project",
    run: async (ctx) => {
      const driftGraphOptions =
        ctx.hasGraphOverrides || ctx.nativeMode !== "auto" ? ctx.buildGraphOptions() : undefined;
      const driftCacheDir = ctx.getOpt("--cache-dir");
      const { handleDriftCommand } = await import("./drift.js");
      await handleDriftCommand({
        projectRootFs: ctx.projectRootFs,
        positionals: ctx.includeRoots,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        nativeMode: ctx.nativeMode,
        ...(driftGraphOptions ? { graphOptions: driftGraphOptions } : {}),
        indexOptions: {
          onProgress: ctx.progressHandler,
          discovery: ctx.discoveryOptions,
          ...(ctx.nativeMode !== "auto" ? { native: ctx.nativeMode } : {}),
          ...(ctx.config.languages?.extensions ? { languageExtensions: ctx.config.languages.extensions } : {}),
          ...ctx.workerOpts,
          ...(driftCacheDir ? { cacheDir: driftCacheDir } : {}),
          ...(ctx.config.cache?.location ? { cacheLocation: ctx.config.cache.location } : {}),
        },
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        exit: exitCli,
      });
    },
  },
  duplicates: {
    stage: "project",
    run: async (ctx) => {
      const files = await ctx.resolveFiles();
      const { handleDuplicatesCommand } = await import("./duplicates.js");
      const { createCurrentProjectIndexLoader } = await import("../indexer/load-current-index.js");
      await handleDuplicatesCommand({
        projectRootFs: ctx.projectRootFs,
        files,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        loadCurrentIndex: createCurrentProjectIndexLoader(ctx.projectRootFs, ctx.buildAgentOptions(), {
          kind: "resolved-files",
          files,
        }),
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        exit: exitCli,
      });
    },
  },
  dumpmod: {
    stage: "project",
    run: async (ctx) => {
      const { handleDumpmodCommand } = await import("./navigation.js");
      await handleDumpmodCommand(navigationArgs(ctx));
    },
  },
  goto: {
    stage: "project",
    run: async (ctx) => {
      const { handleGotoCommand } = await import("./navigation.js");
      await handleGotoCommand(navigationArgs(ctx));
    },
  },
  refs: {
    stage: "project",
    run: async (ctx) => {
      const { handleRefsCommand } = await import("./navigation.js");
      await handleRefsCommand(navigationArgs(ctx));
    },
  },
  grep: {
    stage: "project",
    run: async (ctx) => {
      const { handleGrepCommand } = await import("./grep.js");
      await handleGrepCommand({
        positionals: ctx.parsed.positionals,
        projectRootFs: ctx.projectRootFs,
        discoveryOptions: ctx.discoveryOptions,
        parsedOptions: ctx.parsed.options,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        exit: exitCli,
      });
    },
  },
  impact: {
    stage: "project",
    run: async (ctx) => {
      const { handleImpactCommand } = await import("./impact.js");
      await handleImpactCommand({
        projectRootFs: ctx.projectRootFs,
        discoveryOptions: ctx.discoveryOptions,
        cacheLocation: ctx.config.cache?.location,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        parsedOptions: ctx.parsed.options,
        nativeMode: ctx.nativeMode,
        workerOpts: ctx.workerOpts,
        graphOptions: ctx.hasGraphOverrides
          ? {
              fast: ctx.graphFlags.fast,
              resolveNodeModules: ctx.graphFlags.resolveNodeModules,
              dynamicImportHeuristics: ctx.graphFlags.dynamicImportHeuristics,
              ...(ctx.graphFlags.resolutionHints.length ? { resolutionHints: ctx.graphFlags.resolutionHints } : {}),
            }
          : undefined,
        progressHandler: ctx.progressHandler,
        readStdin: readCliStdin,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        exit: exitCli,
      });
    },
  },
  affected: {
    stage: "project",
    run: async (ctx) => {
      const { handleAffectedCommand } = await import("./affected.js");
      await handleAffectedCommand({
        projectRootFs: ctx.projectRootFs,
        buildOptions: ctx.buildAgentOptions(),
        positionals: ctx.parsed.positionals,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        parsedOptions: ctx.parsed.options,
        readStdin: readCliStdin,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        exit: exitCli,
      });
    },
  },
  review: {
    stage: "project",
    run: async (ctx) => {
      // Review entry point: CLI workflow for review reports.
      const commandReport: CommandReport | undefined = ctx.reportEnabled
        ? { command: "review", timings: {} }
        : undefined;
      const { handleReviewCommand } = await import("./review.js");
      await handleReviewCommand({
        projectRootFs: ctx.projectRootFs,
        discoveryOptions: ctx.discoveryOptions,
        cacheLocation: ctx.config.cache?.location,
        reportFile: ctx.reportFile,
        commandReport,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        nativeMode: ctx.nativeMode,
        useNativeWorkers: ctx.useNativeWorkers,
        graphOptions: ctx.hasGraphOverrides ? ctx.buildGraphOptions() : undefined,
        progressHandler: ctx.progressHandler,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        writeCommandReport,
        exit: exitCli,
      });
    },
  },
  deps: {
    stage: "project",
    run: async (ctx) => {
      const { graphOptions } = graphQueryArgs(ctx);
      const { handleGraphQueryCommand } = await import("./graphQueries.js");
      await handleGraphQueryCommand({
        command: "deps",
        positionals: ctx.parsed.positionals,
        projectRootFs: ctx.projectRootFs,
        projectRootAbs: ctx.projectRootAbs,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        exit: exitCli,
        listProjectFilesForScan: async () => await ctx.listProjectFilesForScan(ctx.projectRootFs),
        ...(graphOptions ? { graphOptions } : {}),
        loadCurrentIndex: ctx.createGraphQueryIndexLoader(graphOptions),
      });
    },
  },
  rdeps: {
    stage: "project",
    run: async (ctx) => {
      const { graphOptions } = graphQueryArgs(ctx);
      const { handleGraphQueryCommand } = await import("./graphQueries.js");
      await handleGraphQueryCommand({
        command: "rdeps",
        positionals: ctx.parsed.positionals,
        projectRootFs: ctx.projectRootFs,
        projectRootAbs: ctx.projectRootAbs,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        exit: exitCli,
        listProjectFilesForScan: async () => await ctx.listProjectFilesForScan(ctx.projectRootFs),
        ...(graphOptions ? { graphOptions } : {}),
        loadCurrentIndex: ctx.createGraphQueryIndexLoader(graphOptions),
      });
    },
  },
  links: {
    stage: "project",
    run: async (ctx) => {
      const { handleLinksCommand } = await import("./links.js");
      await handleLinksCommand({
        projectRootFs: ctx.projectRootFs,
        discoveryOptions: ctx.discoveryOptions,
        hasFlag: ctx.hasFlag,
        writeJSONLine,
        writeStdoutLine,
        exit: exitCli,
      });
    },
  },
  path: {
    stage: "project",
    run: (ctx) => runPathFamilyCommand(ctx, "path"),
  },
  cycles: {
    stage: "project",
    run: (ctx) => runPathFamilyCommand(ctx, "cycles"),
  },
  unresolved: {
    stage: "project",
    run: (ctx) => runPathFamilyCommand(ctx, "unresolved"),
  },
  inspect: {
    stage: "project",
    run: async (ctx) => {
      const commandReport: CommandReport | undefined = ctx.reportEnabled
        ? { command: "inspect", timings: {} }
        : undefined;
      if (commandReport) commandReport.index = { timings: {} };
      const { handleInspectCommand } = await import("./inspect.js");
      await handleInspectCommand({
        projectRootFs: ctx.projectRootFs,
        includeRootsAbs: ctx.includeRootsAbs,
        discoveryOptions: ctx.discoveryOptions,
        languageExtensions: ctx.config.languages?.extensions,
        cacheLocation: ctx.config.cache?.location,
        graphOptions: ctx.hasGraphOverrides || ctx.nativeMode !== "auto" ? ctx.buildGraphOptions() : undefined,
        nativeMode: ctx.nativeMode,
        workerOpts: ctx.workerOpts,
        progressHandler: ctx.progressHandler,
        reportFile: ctx.reportFile,
        commandReport,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        resolveFilesFromRoots: ctx.resolveFilesFromRoots,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        writeCommandReport,
      });
    },
  },
  hotspots: {
    stage: "project",
    run: async (ctx) => {
      const { handleHotspotsCommand } = await import("./inspect.js");
      await handleHotspotsCommand({
        projectRootFs: ctx.projectRootFs,
        includeRootsAbs: ctx.includeRootsAbs,
        discoveryOptions: ctx.discoveryOptions,
        languageExtensions: ctx.config.languages?.extensions,
        cacheLocation: ctx.config.cache?.location,
        graphOptions: ctx.hasGraphOverrides || ctx.nativeMode !== "auto" ? ctx.buildGraphOptions() : undefined,
        nativeMode: ctx.nativeMode,
        workerOpts: ctx.workerOpts,
        progressHandler: ctx.progressHandler,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        resolveFilesFromRoots: ctx.resolveFilesFromRoots,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
      });
    },
  },
  apisurface: {
    stage: "project",
    run: async (ctx) => {
      const { handleGraphQueryCommand } = await import("./graphQueries.js");
      await handleGraphQueryCommand({
        command: "apisurface",
        positionals: ctx.parsed.positionals,
        projectRootFs: ctx.projectRootFs,
        projectRootAbs: ctx.projectRootAbs,
        getOpt: ctx.getOpt,
        hasFlag: ctx.hasFlag,
        writeJSONLine,
        writeStdoutLine,
        writeStderrLine,
        exit: exitCli,
        listProjectFilesForScan: async () => await ctx.listProjectFilesForScan(ctx.projectRootFs),
        loadCurrentIndex: ctx.createGraphQueryIndexLoader(undefined),
      });
    },
  },
};

function navigationArgs(ctx: CliProjectContext) {
  return {
    projectRootFs: ctx.projectRootFs,
    discoveryOptions: ctx.discoveryOptions,
    positionals: ctx.parsed.positionals,
    getOpt: ctx.getOpt,
    hasFlag: ctx.hasFlag,
    nativeMode: ctx.nativeMode,
    workerOpts: ctx.workerOpts,
    progressHandler: ctx.progressHandler,
    cacheLocation: ctx.config.cache?.location,
    writeJSONLine,
    writeStdoutLine,
    writeStderrLine,
    exit: exitCli,
  };
}

async function runPathFamilyCommand(ctx: CliProjectContext, command: "path" | "cycles" | "unresolved"): Promise<void> {
  const { graphOptions } = graphQueryArgs(ctx);
  const { handleGraphQueryCommand } = await import("./graphQueries.js");
  const collectGraph =
    command === "cycles" && ctx.includeRootsAbs.length ? (await import("../graph-builder.js")).collectGraph : undefined;
  await handleGraphQueryCommand({
    command,
    positionals: ctx.parsed.positionals,
    projectRootFs: ctx.projectRootFs,
    projectRootAbs: ctx.projectRootAbs,
    getOpt: ctx.getOpt,
    hasFlag: ctx.hasFlag,
    writeJSONLine,
    writeStdoutLine,
    writeStderrLine,
    exit: exitCli,
    listProjectFilesForScan: async () => {
      if (command === "cycles") return await ctx.resolveFilesFromRoots();
      return await ctx.listProjectFilesForScan(ctx.projectRootFs);
    },
    ...(collectGraph ? { collectGraph } : {}),
    ...(graphOptions ? { graphOptions } : {}),
    loadCurrentIndex: ctx.createGraphQueryIndexLoader(graphOptions),
  });
}
