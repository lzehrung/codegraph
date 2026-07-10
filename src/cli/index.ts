import { performance } from "node:perf_hooks";
import { buildProjectIndex, buildProjectIndexFromFiles } from "../indexer/build-index.js";
import { type BuildOptions, type BuildReport } from "../indexer/types.js";
import { type GraphBuildOptions } from "../graphs/types.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import type { ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import { parseCacheModeOption, parseNonNegativeIntegerOption } from "./options.js";

type CommandTimingReport = {
  totalMs?: number;
  resolveFilesMs?: number;
  commandMs?: number;
};

type IndexCommandReport = {
  command: string;
  timings: CommandTimingReport;
  index?: BuildReport;
};

export type IndexCommandContext = {
  projectRootFs: string;
  includeRootsAbs: string[];
  gitBase: string | undefined;
  changedSince: string | undefined;
  discoveryOptions: ProjectFileDiscoveryOptions;
  nativeMode: NativeRuntimeMode;
  workerOpts: { useNativeWorkers: true } | Record<string, never>;
  languageExtensions: BuildOptions["languageExtensions"];
  progressHandler: ((update: { current: number; total: number }) => void) | undefined;
  graphOptions: GraphBuildOptions | undefined;
  reportEnabled: boolean;
  reportFile: string | undefined;
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  resolveFiles: () => Promise<string[]>;
  writeJSONLine: (value: unknown) => void;
  writeStderrLine: (message: string) => void;
  writeCommandReport: (report: IndexCommandReport, reportFile: string | undefined) => Promise<void>;
  maybeWriteNativeBackendStatus: (report: BuildReport | undefined, showProgress: boolean) => void;
  showProgress: boolean;
};

export async function handleIndexCommand(context: IndexCommandContext): Promise<void> {
  const verbose = context.hasFlag("--verbose");
  const commandReport: IndexCommandReport | undefined = context.reportEnabled
    ? { command: "index", timings: {} }
    : undefined;
  const commandStart = performance.now();
  const resolveStart = performance.now();
  const files = await context.resolveFiles();
  if (commandReport) {
    commandReport.timings.resolveFilesMs = Math.round(performance.now() - resolveStart);
  }
  const threads = parseNonNegativeIntegerOption(context.getOpt("--threads"), "--threads", 0);
  const cache = parseCacheModeOption(context.getOpt("--cache"));
  const cacheStrict = context.hasFlag("--cache-strict");
  const full = context.hasFlag("--json") || context.hasFlag("--full");
  const cacheVerify = context.hasFlag("--cache-verify");
  const shouldWriteManifest = !context.includeRootsAbs.length && !context.gitBase && !context.changedSince;
  const indexReport: BuildReport | undefined = context.reportEnabled || verbose ? { timings: {} } : undefined;
  if (commandReport && indexReport) {
    commandReport.index = indexReport;
  }
  const baseIndexOptions: BuildOptions = {
    onProgress: context.progressHandler,
    threads,
    discovery: context.discoveryOptions,
    ...(context.nativeMode !== "auto" ? { native: context.nativeMode } : {}),
    ...(context.languageExtensions ? { languageExtensions: context.languageExtensions } : {}),
    ...context.workerOpts,
    ...(cache !== undefined ? { cache } : {}),
    cacheStrict,
    cacheVerify,
    ...(context.graphOptions ? { graph: context.graphOptions } : {}),
    ...(indexReport ? { report: indexReport } : {}),
  };
  const index = shouldWriteManifest
    ? await buildProjectIndex(context.projectRootFs, baseIndexOptions)
    : await buildProjectIndexFromFiles(context.projectRootFs, files, baseIndexOptions);
  context.maybeWriteNativeBackendStatus(indexReport, context.showProgress);
  if (full) {
    const modules = [...index.byFile.values()].map((m) => ({
      file: m.file,
      locals: m.locals.map((l) => ({
        name: l.localName,
        kind: l.kind,
        start: l.range.start,
      })),
      exports: m.exports,
      imports: m.imports,
    }));
    context.writeJSONLine({
      files: modules.length,
      edges: index.graph.edges.length,
      modules,
    });
  } else {
    context.writeJSONLine({
      files: [...index.byFile.keys()].length,
      edges: index.graph.edges.length,
    });
  }
  if (verbose && indexReport) {
    const cache = indexReport.cache;
    const fileStats = indexReport.files;
    if (cache) {
      context.writeStderrLine(`Cache (${cache.mode}): ${cache.hits} hits, ${cache.misses} misses`);
    }
    if (fileStats) {
      context.writeStderrLine(
        `Files: ${fileStats.parsed ?? 0} parsed, ${fileStats.cached ?? 0} cached, ${fileStats.total} total`,
      );
    }
  }
  if (commandReport) {
    commandReport.timings.commandMs = Math.round(performance.now() - commandStart);
    commandReport.timings.totalMs = commandReport.timings.commandMs;
    await context.writeCommandReport(commandReport, context.reportFile);
  }
}
