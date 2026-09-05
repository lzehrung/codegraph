import { performance } from "node:perf_hooks";
import { buildProjectIndexFromFiles, buildProjectIndexIncremental } from "../indexer/build-index.js";
import { type BuildOptions, type BuildReport, type CacheLocation } from "../indexer/types.js";
import { summarizeAnalysis, type AnalysisSummary } from "../analysisSummary.js";
import { type GraphBuildOptions } from "../graphs/types.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import type { LanguageExtensionMap } from "../languages.js";
import type { ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import { parseCacheModeOption, parseNonNegativeIntegerOption } from "./options.js";
import { writeCliOutput } from "./pretty.js";

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

type IndexPrettyOutput = {
  files: number;
  edges: number;
  analysis: AnalysisSummary;
  modules?: Array<{
    file: string;
    locals: readonly unknown[];
    exports: readonly unknown[];
    imports: readonly unknown[];
  }>;
};

function formatIndexOutput(output: IndexPrettyOutput): string {
  const lines = [`Indexed ${output.files} file(s) with ${output.edges} edge(s).`];
  if (output.analysis.mode !== "semantic") {
    lines.push(`Analysis: ${output.analysis.label}.`);
  }
  if (!output.modules) {
    return lines.join("\n");
  }
  lines.push("Modules:");
  for (const mod of output.modules) {
    lines.push(
      `- ${mod.file}: ${mod.locals.length} locals, ${mod.exports.length} exports, ${mod.imports.length} imports`,
    );
  }
  return lines.join("\n");
}

export type IndexCommandContext = {
  projectRootFs: string;
  includeRootsAbs: string[];
  gitBase: string | undefined;
  changedSince: string | undefined;
  discoveryOptions: ProjectFileDiscoveryOptions;
  nativeMode: NativeRuntimeMode;
  languageExtensions: LanguageExtensionMap | undefined;
  workerOpts: { useNativeWorkers: true } | Record<string, never>;
  progressHandler: BuildOptions["onProgress"];
  cacheLocation: CacheLocation | undefined;
  graphOptions: GraphBuildOptions | undefined;
  reportEnabled: boolean;
  reportFile: string | undefined;
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  resolveFiles: () => Promise<string[]>;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
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
  const shouldWriteManifest = !context.includeRootsAbs.length && !context.gitBase && !context.changedSince;
  // Keep resolve when CLI discovery globs were supplied so --include-glob/--ignore-glob
  // "matched no files" warnings still emit on whole-project index runs.
  const hasCliDiscoveryGlob =
    context.getOpt("--include-glob") !== undefined || context.getOpt("--ignore-glob") !== undefined;
  const needsResolvedFiles = !shouldWriteManifest || hasCliDiscoveryGlob;
  let files: string[] = [];
  if (needsResolvedFiles) {
    const resolveStart = performance.now();
    files = await context.resolveFiles();
    if (commandReport) {
      commandReport.timings.resolveFilesMs = Math.round(performance.now() - resolveStart);
    }
  }
  const threads = parseNonNegativeIntegerOption(context.getOpt("--threads"), "--threads", 0);
  const cache = parseCacheModeOption(context.getOpt("--cache"));
  const cacheDir = context.getOpt("--cache-dir");
  const cacheStrict = context.hasFlag("--cache-strict");
  const full = context.hasFlag("--json") || context.hasFlag("--full");
  const cacheVerify = context.hasFlag("--cache-verify");

  // Always populated (not gated behind --report/--verbose) so a plain `index`
  // run can detect and surface reduced-accuracy analysis (native tree-sitter
  // unavailable or per-file fallback) via both the stderr warning and the
  // pretty/--json `analysis` field below, per finding #43.
  const indexReport: BuildReport = { timings: {} };
  if (commandReport) {
    commandReport.index = indexReport;
  }
  // Defaults to the on-disk incremental cache, matching search/orient/inspect/review;
  // pass --cache off to opt out for a single invocation.
  const baseIndexOptions: BuildOptions = {
    onProgress: context.progressHandler,
    threads,
    discovery: context.discoveryOptions,
    ...(context.nativeMode !== "auto" ? { native: context.nativeMode } : {}),
    ...(context.languageExtensions ? { languageExtensions: context.languageExtensions } : {}),
    ...context.workerOpts,
    ...(cacheDir ? { cacheDir } : {}),
    ...(context.cacheLocation ? { cacheLocation: context.cacheLocation } : {}),
    cache: cache ?? "disk",
    cacheStrict,
    cacheVerify,
    ...(context.graphOptions ? { graph: context.graphOptions } : {}),
    report: indexReport,
  };
  // Whole-project runs reuse the on-disk manifest and Git-backed incremental discovery
  // instead of a full recursive scan; scoped include roots or an explicit git range keep
  // using the already-resolved file list, since manifest-based reconciliation is scoped
  // to the whole project root and cannot safely stand in for a root subset.
  const index = shouldWriteManifest
    ? await buildProjectIndexIncremental(context.projectRootFs, baseIndexOptions)
    : await buildProjectIndexFromFiles(context.projectRootFs, files, baseIndexOptions);
  context.maybeWriteNativeBackendStatus(indexReport, context.showProgress);
  const analysis = summarizeAnalysis({ index, nativeMode: context.nativeMode, report: indexReport });
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
    writeCliOutput(
      context,
      {
        files: modules.length,
        edges: index.graph.edges.length,
        analysis,
        modules,
      },
      formatIndexOutput,
    );
  } else {
    writeCliOutput(
      context,
      {
        files: [...index.byFile.keys()].length,
        edges: index.graph.edges.length,
        analysis,
      },
      formatIndexOutput,
    );
  }
  if (verbose) {
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
