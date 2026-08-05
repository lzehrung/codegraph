import { loadCurrentProjectIndex, type LoadCurrentProjectIndexOptions } from "../indexer/load-current-index.js";
import type { BuildOptions, BuildReport, ProjectIndex } from "../indexer/types.js";
import {
  analyzeImpactFromDiff,
  type ChangedSymbol,
  type CallCompatibilityHint,
  type CompactImpactReport,
  type ImpactItem,
  type ImpactOptions,
  type ImpactReport,
} from "../impact/index.js";
import { formatRequiredArgumentCount, mapSuggestions, mapSurfaceArea } from "../impact/reportShared.js";
import { graphToMermaidSymbolsWithFiles } from "../graphs/symbol-render.js";
import { type GraphBuildOptions } from "../graphs/types.js";
import { type SymbolGraph, type SymbolNodeKind } from "../graphs/symbol-graph.js";
import { parseGitHubRepo } from "../impact/providers/base.js";
import {
  appendDuplicateLeadSummary,
  collectDuplicateLeadSummary,
  parseDuplicateLeadScope,
  type DuplicateLeadSummary,
} from "../duplicatesLeads.js";
import type { NativeRuntimeMode } from "../native/treeSitterNative.js";
import type { Graph } from "../types.js";
import { type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";
import {
  parseImpactScopeOption,
  parseRefContextOption,
  parseCacheModeOption,
  parseOptionalNonNegativeIntegerOption,
  parseOptionalPositiveIntegerOption,
  parsePositiveIntegerOption,
} from "./options.js";
import { changedFilesWithSimilaritySources, duplicateSimilarityHintsFromChanges } from "./duplicateSimilarity.js";
import { DEFAULT_BOUNDED_IMPACT_BUDGETS } from "../impact/budgets.js";

type ImpactOptionsBuilder = Partial<ImpactOptions> & {
  base?: string;
  head?: string;
  cwd?: string;
  pr?: number;
  repo?: string;
  diffText?: string;
  threads?: number;
  cache?: BuildOptions["cache"];
  cacheStrict?: boolean;
  cacheVerify?: boolean;
};

export type ImpactCommandContext = {
  projectRootFs: string;
  discoveryOptions: ProjectFileDiscoveryOptions;
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  parsedOptions: ReadonlyMap<string, readonly string[]>;
  nativeMode: NativeRuntimeMode;
  workerOpts: { useNativeWorkers: true } | Record<string, never>;
  graphOptions: GraphBuildOptions | undefined;
  progressHandler: BuildOptions["onProgress"];
  readStdin: () => Promise<string>;
  writeJSONLine: (value: unknown) => void;
  writeStdoutLine: (message: string) => void;
  writeStderrLine: (message: string) => void;
  exit: (code: number) => never;
};

const SYMBOL_NODE_KINDS: SymbolNodeKind[] = [
  "function",
  "class",
  "variable",
  "interface",
  "type",
  "default",
  "import",
  "namespaceImport",
];

function symbolNodeKindFromString(kind?: string): SymbolNodeKind {
  return kind && SYMBOL_NODE_KINDS.includes(kind as SymbolNodeKind) ? (kind as SymbolNodeKind) : "variable";
}

function ensureImpactReport(report: ImpactReport | CompactImpactReport): ImpactReport {
  if (!("files" in report)) return report;
  const files = report.files;
  const resolveFilePath = (index: number): string => {
    const file = files[index];
    if (!file) {
      throw new Error(`Missing file path for index ${index} in compact impact report`);
    }
    return file;
  };
  const changedFiles = report.changedFiles.map((cf) => ({
    file: resolveFilePath(cf.file),
    hunks: cf.hunks,
    ...(cf.oldFile !== undefined ? { oldFile: resolveFilePath(cf.oldFile) } : {}),
    ...(cf.similarityIndex !== undefined ? { similarityIndex: cf.similarityIndex } : {}),
  }));
  const changedSymbols = report.changedSymbols.map((cs) => {
    const symbol: ChangedSymbol = {
      id: cs.id,
      file: resolveFilePath(cs.file),
      name: cs.name,
      kind: cs.kind,
      exported: cs.exported,
      range: cs.range,
      ...(cs.typeOnly !== undefined ? { typeOnly: cs.typeOnly } : {}),
      ...(cs.callCompatibility?.length ? { callCompatibility: cs.callCompatibility } : {}),
    };
    return symbol;
  });
  const impacted: ImpactItem[] = report.impacted.map((item) => {
    const impact: ImpactItem = {
      file: resolveFilePath(item.file),
      symbols: item.symbols,
      reasons: item.reasons,
      severity: item.severity,
    };
    if (item.depth !== undefined) impact.depth = item.depth;
    if (item.typeOnly !== undefined) impact.typeOnly = item.typeOnly;
    if (item.explain !== undefined) impact.explain = item.explain;
    const maybeRefs = "refs" in item ? (item as { refs?: ImpactItem["refs"] }).refs : undefined;
    if (maybeRefs !== undefined) impact.refs = maybeRefs;
    return impact;
  });
  const suggestions = report.suggestions ? mapSuggestions(report.suggestions, resolveFilePath) : undefined;
  const exportSummary = report.exportSummary?.map((entry) => ({
    file: resolveFilePath(entry.file),
    symbols: entry.symbols,
  }));
  const reexportChains = report.reexportChains
    ? {
        chains: report.reexportChains.chains.map((entry) => ({
          symbol: entry.symbol,
          file: resolveFilePath(entry.file),
          paths: entry.paths.map((pathChain) => pathChain.map((file) => resolveFilePath(file))),
        })),
      }
    : undefined;
  const topImpacts = report.topImpacts?.map((item) => ({
    file: resolveFilePath(item.file),
    symbols: item.symbols,
    reasons: item.reasons,
    severity: item.severity,
    ...(item.depth !== undefined ? { depth: item.depth } : {}),
    ...(item.typeOnly !== undefined ? { typeOnly: item.typeOnly } : {}),
    ...(item.explain ? { explain: item.explain } : {}),
  }));
  const clusters = report.clusters.map((cluster) => ({
    id: cluster.id,
    files: cluster.files.map((file) => resolveFilePath(file)),
    changedFiles: cluster.changedFiles.map((file) => resolveFilePath(file)),
    totalSeverity: cluster.totalSeverity,
  }));
  const fileEdges = report.graph.fileEdges.map((edge) => ({
    from: resolveFilePath(edge.from),
    to: resolveFilePath(edge.to),
    ...(edge.typeOnly !== undefined ? { typeOnly: edge.typeOnly } : {}),
  }));
  const symbolEdges = report.graph.symbolEdges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    label: edge.label,
  }));
  const result: ImpactReport = {
    schemaVersion: report.schemaVersion,
    format: "full",
    ...(report.analysis ? { analysis: report.analysis } : {}),
    changedFiles,
    changedSymbols,
    impacted,
    ...(suggestions ? { suggestions } : {}),
    ...(exportSummary ? { exportSummary } : {}),
    ...(reexportChains ? { reexportChains } : {}),
    ...(topImpacts ? { topImpacts } : {}),
    surfaceArea: mapSurfaceArea(report.surfaceArea, resolveFilePath),
    clusters,
    graph: {
      fileEdges,
      symbolEdges,
    },
  };
  if (report.projectFiles) result.projectFiles = report.projectFiles;
  if (report.warning) result.warning = report.warning;
  return result;
}

const IMPACT_REASON_LABELS: Record<ImpactItem["reasons"][number], string> = {
  directRef: "reason: direct reference",
  namespaceMember: "reason: namespace member",
  importAlias: "reason: import alias",
  transitive: "reason: transitive dependency",
  exportChain: "reason: export chain",
  fileLevelChange: "reason: file-level change",
};

function formatImpactReasonLabel(item: Pick<ImpactItem, "reasons" | "explain">): string {
  const primaryReason = item.explain?.reason ?? item.reasons[0];
  if (!primaryReason) return "reason: impact";
  return IMPACT_REASON_LABELS[primaryReason];
}

function collectLikelyCallCompatibilityMismatches(report: ImpactReport): Array<{
  symbol: ChangedSymbol;
  hint: CallCompatibilityHint;
}> {
  const findings: Array<{ symbol: ChangedSymbol; hint: CallCompatibilityHint }> = [];
  for (const symbol of report.changedSymbols) {
    const hints = symbol.callCompatibility ?? [];
    for (const hint of hints) {
      if (hint.status === "likely_mismatch") {
        findings.push({ symbol, hint });
      }
    }
  }
  return findings;
}

function duplicateScopeFilesForImpact(
  impactReport: ImpactReport,
  duplicateScope: Exclude<ReturnType<typeof parseDuplicateLeadScope>, "off">,
): string[] | undefined {
  if (duplicateScope === "all") return undefined;
  const changedFiles = duplicateChangedFilesWithSimilaritySources(impactReport.changedFiles);
  if (duplicateScope === "changed") return changedFiles;
  return [...changedFiles, ...impactReport.impacted.map((item) => item.file)];
}

function duplicateChangedFilesWithSimilaritySources(changedFiles: ImpactReport["changedFiles"]): string[] {
  return changedFilesWithSimilaritySources(changedFiles);
}

function duplicateSimilarityHintsFromImpact(report: ImpactReport) {
  return duplicateSimilarityHintsFromChanges(report.changedFiles);
}

async function collectImpactDuplicateSummary(input: {
  index: ProjectIndex;
  projectRoot: string;
  impactReport: ImpactReport;
  duplicateScope: Exclude<ReturnType<typeof parseDuplicateLeadScope>, "off">;
}): Promise<DuplicateLeadSummary | undefined> {
  const scopedFiles = duplicateScopeFilesForImpact(input.impactReport, input.duplicateScope);
  return await collectDuplicateLeadSummary({
    index: input.index,
    projectRoot: input.projectRoot,
    scope: input.duplicateScope,
    ...(scopedFiles !== undefined ? { scopedFiles } : {}),
    similarityHints: duplicateSimilarityHintsFromImpact(input.impactReport),
    allScopeFileCount: input.impactReport.projectFiles?.length ?? input.index.byFile.size,
  });
}

function formatImpactMermaid(report: ImpactReport, root: string): string {
  const fileGraph: Graph = { nodes: new Set<string>(), edges: [] };
  const ensureFileNode = (file: string) => fileGraph.nodes.add(file);
  for (const cf of report.changedFiles) ensureFileNode(cf.file);
  for (const item of report.impacted) ensureFileNode(item.file);
  for (const symbol of report.changedSymbols) ensureFileNode(symbol.file);
  for (const edge of report.graph.fileEdges) {
    ensureFileNode(edge.from);
    ensureFileNode(edge.to);
    fileGraph.edges.push({
      from: edge.from,
      to: { type: "file", path: edge.to },
      raw: "",
      ...(edge.typeOnly ? { typeOnly: edge.typeOnly } : {}),
    });
  }

  const symbolGraph: SymbolGraph = { nodes: new Map(), edges: [] };
  for (const sym of report.changedSymbols) {
    symbolGraph.nodes.set(sym.id, {
      id: sym.id,
      file: sym.file,
      name: sym.name,
      kind: symbolNodeKindFromString(sym.kind),
    });
  }
  for (const edge of report.graph.symbolEdges) {
    const fromSym = report.changedSymbols[edge.from];
    const toSym = report.changedSymbols[edge.to];
    if (!fromSym || !toSym) continue;
    symbolGraph.edges.push({
      from: fromSym.id,
      to: toSym.id,
      ...(edge.label ? { label: edge.label } : {}),
    });
  }

  return graphToMermaidSymbolsWithFiles(symbolGraph, fileGraph, root);
}

function buildDiffProviderOptions(context: ImpactCommandContext): ImpactOptionsBuilder {
  const provider = context.getOpt("--provider") ?? "git";
  if (provider !== "git" && provider !== "github" && provider !== "raw") {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return { provider };
}

async function hydrateDiffProviderOptions(context: ImpactCommandContext, options: ImpactOptionsBuilder): Promise<void> {
  if (options.provider === "git") {
    options.base = context.getOpt("--base") ?? "HEAD";
    options.head = context.getOpt("--head") ?? "WORKTREE";
    options.cwd = context.projectRootFs;
    return;
  }

  if (options.provider === "github") {
    const pr = context.getOpt("--pr");
    const repo = context.getOpt("--repo");
    if (!pr || !repo) {
      throw new Error(
        "Impact provider 'github' requires --repo owner/name and --pr <number>. Example: codegraph impact --provider github --repo acme/app --pr 42",
      );
    }
    options.pr = parsePositiveIntegerOption(pr, "--pr", 1);
    parseGitHubRepo(repo);
    options.repo = repo;
    return;
  }

  options.diffText = await context.readStdin();
}

function applyAnalysisOptions(context: ImpactCommandContext, options: ImpactOptionsBuilder): void {
  const threadsRaw = context.getOpt("--threads");
  const threads = parseOptionalNonNegativeIntegerOption(threadsRaw, "--threads");
  if (threads !== undefined) options.threads = threads;

  const cache = parseCacheModeOption(context.getOpt("--cache"));
  if (cache !== undefined) options.cache = cache;

  if (context.hasFlag("--cache-strict")) options.cacheStrict = true;
  if (context.hasFlag("--cache-verify")) options.cacheVerify = true;
  if (context.hasFlag("--compact")) options.compact = true;

  const maxRefs = context.getOpt("--max-refs");
  const parsedMaxRefs = parseOptionalNonNegativeIntegerOption(maxRefs, "--max-refs");
  if (parsedMaxRefs !== undefined) options.maxRefs = parsedMaxRefs;

  const maxChangedSymbols = context.getOpt("--max-changed-symbols");
  const parsedMaxChangedSymbols = parseOptionalNonNegativeIntegerOption(maxChangedSymbols, "--max-changed-symbols");
  if (parsedMaxChangedSymbols !== undefined) options.maxChangedSymbols = parsedMaxChangedSymbols;

  const maxReferenceLookups = context.getOpt("--max-reference-lookups");
  const parsedMaxReferenceLookups = parseOptionalNonNegativeIntegerOption(
    maxReferenceLookups,
    "--max-reference-lookups",
  );
  if (parsedMaxReferenceLookups !== undefined) options.maxReferenceLookups = parsedMaxReferenceLookups;

  const maxTotalReferences = context.getOpt("--max-total-references");
  const parsedMaxTotalReferences = parseOptionalNonNegativeIntegerOption(maxTotalReferences, "--max-total-references");
  if (parsedMaxTotalReferences !== undefined) options.maxTotalReferences = parsedMaxTotalReferences;

  const timeBudgetMs = context.getOpt("--time-budget-ms");
  const parsedTimeBudgetMs = parseOptionalNonNegativeIntegerOption(timeBudgetMs, "--time-budget-ms");
  if (parsedTimeBudgetMs !== undefined) options.timeBudgetMs = parsedTimeBudgetMs;

  // Bounded defaults for the common orchestrator accelerant path (human-readable/--compact)
  // without changing unlimited library behavior when callers omit budgets.
  const wantsBoundedDefaults = !context.hasFlag("--json") || context.hasFlag("--compact");
  if (wantsBoundedDefaults) {
    if (options.maxChangedSymbols === undefined)
      options.maxChangedSymbols = DEFAULT_BOUNDED_IMPACT_BUDGETS.maxChangedSymbols;
    if (options.maxReferenceLookups === undefined)
      options.maxReferenceLookups = DEFAULT_BOUNDED_IMPACT_BUDGETS.maxReferenceLookups;
    if (options.maxTotalReferences === undefined)
      options.maxTotalReferences = DEFAULT_BOUNDED_IMPACT_BUDGETS.maxTotalReferences;
    if (options.timeBudgetMs === undefined) options.timeBudgetMs = DEFAULT_BOUNDED_IMPACT_BUDGETS.timeBudgetMs;
  }

  const depth = context.getOpt("--depth");
  const parsedDepth = parseOptionalNonNegativeIntegerOption(depth, "--depth");
  if (parsedDepth !== undefined) options.depth = parsedDepth;

  const scope = parseImpactScopeOption(context.getOpt("--scope"), "--scope");
  if (scope !== undefined) options.scope = scope;

  const refContext = parseRefContextOption(context.getOpt("--ref-context"), "--ref-context");
  if (refContext !== undefined) options.refContext = refContext;

  const refContextLines = context.getOpt("--ref-context-lines");
  const parsedRefContextLines = parseOptionalNonNegativeIntegerOption(refContextLines, "--ref-context-lines");
  if (parsedRefContextLines !== undefined) options.refContextLines = parsedRefContextLines;

  const refBlockMaxLines = context.getOpt("--ref-block-max-lines");
  const parsedRefBlockMaxLines = parseOptionalPositiveIntegerOption(refBlockMaxLines, "--ref-block-max-lines");
  if (parsedRefBlockMaxLines !== undefined) options.refBlockMaxLines = parsedRefBlockMaxLines;

  if (context.discoveryOptions.ignoreGlobs?.length) {
    options.ignoreGlobs = context.discoveryOptions.ignoreGlobs;
  }

  if (context.hasFlag("--verify-refs")) options.verifyReferences = true;

  const lcovPaths = context.parsedOptions.get("--lcov");
  if (lcovPaths?.length) {
    options.lcovPaths = [...lcovPaths];
    options.testCoverageSuggestions = true;
  }

  const coveragePaths = context.parsedOptions.get("--coverage-report");
  if (coveragePaths?.length) {
    options.coveragePaths = [...coveragePaths];
    options.testCoverageSuggestions = true;
  }

  const testCommandTemplate = context.getOpt("--test-command-template");
  if (testCommandTemplate) {
    options.testCommandTemplate = testCommandTemplate;
    options.testCoverageSuggestions = true;
  }

  options.includeTests = context.hasFlag("--include-tests");
  options.membersOnly = context.hasFlag("--members-only");
}

// Current repository state: the diff range describes what to analyze, never the freshness
// scope of the index. `--cache off` opts out of persisted reuse for one invocation.
function buildIndexOptions(
  context: ImpactCommandContext,
  options: ImpactOptionsBuilder,
  analysisOptions: { keepParsedForDuplicates?: boolean } = {},
): LoadCurrentProjectIndexOptions {
  const explicitCache =
    options.cache === "off" || options.cache === "memory" || options.cache === "disk" ? options.cache : undefined;
  const keepParsedForDuplicates = analysisOptions.keepParsedForDuplicates ?? false;
  const keepParsed = options.refContext !== undefined || keepParsedForDuplicates;
  const indexOpts: LoadCurrentProjectIndexOptions = {
    threads: options.threads ?? 0,
    discovery: context.discoveryOptions,
    onProgress: context.progressHandler,
    ...(explicitCache ? { cache: explicitCache } : {}),
    ...(keepParsed ? { keepParsed } : {}),
    ...(context.nativeMode !== "auto" ? { native: context.nativeMode } : {}),
    ...context.workerOpts,
    ...(options.cacheStrict ? { cacheStrict: true } : {}),
    ...(options.cacheVerify ? { cacheVerify: true } : {}),
  };
  if (context.graphOptions) {
    indexOpts.graph = context.graphOptions;
  }
  return indexOpts;
}

function formatPrettyImpactReport(impactReport: ImpactReport, duplicateSummary?: DuplicateLeadSummary): string {
  const lines: string[] = [];
  lines.push("Impact Analysis Report");
  lines.push("======================");
  if (impactReport.warning) {
    lines.push(`WARNING: ${impactReport.warning}`);
    lines.push("");
  }
  if (impactReport.analysis) {
    lines.push(`Analysis: ${impactReport.analysis.label}`);
  }
  lines.push(`Changed files: ${impactReport.changedFiles.length}`);
  lines.push(`Changed symbols: ${impactReport.changedSymbols.length}`);
  lines.push(`Impacted items: ${impactReport.impacted.length}`);
  if (impactReport.diagnostics) {
    const diagnostics = impactReport.diagnostics;
    lines.push(
      `Bounds: changed symbols ${diagnostics.changedSymbolsAnalyzed}/${diagnostics.changedSymbolsTotal} analyzed (${diagnostics.changedSymbolsOmitted} omitted); ` +
        `reference lookups ${diagnostics.referenceLookupsStarted} started (${diagnostics.referenceLookupsOmitted} omitted); ` +
        `references ${diagnostics.referencesRetained} retained (${diagnostics.referencesOmitted} omitted); ` +
        `deadline exceeded: ${diagnostics.deadlineExceeded ? "yes" : "no"}`,
    );
  }
  lines.push("");
  for (const item of impactReport.impacted.slice(0, 10)) {
    const reasonLabel = formatImpactReasonLabel(item);
    lines.push(
      `${item.file}: ${item.symbols.join(", ")} (${reasonLabel}, severity: ${(item.severity * 100).toFixed(1)}%)`,
    );
    if ("refs" in item && item.refs?.length) {
      const contextsToShow = item.refs.slice(0, 2);
      for (const ref of contextsToShow) {
        lines.push(`  Reference at ${ref.range.start.line}:${ref.range.start.column}:`);
        const refContext = ref.context ?? "";
        const contextLines = refContext.split("\n").slice(0, 5);
        for (const line of contextLines) {
          lines.push(`    ${line}`);
        }
        if (refContext.split("\n").length > 5) {
          lines.push("    ...");
        }
      }
      if (item.refs.length > 2) {
        lines.push(`  ... and ${item.refs.length - 2} more references`);
      }
    }
  }
  if (impactReport.impacted.length > 10) {
    lines.push(`... and ${impactReport.impacted.length - 10} more`);
  }
  const compatibilityFindings = collectLikelyCallCompatibilityMismatches(impactReport);
  if (compatibilityFindings.length) {
    lines.push("");
    lines.push("Call compatibility:");
    for (const finding of compatibilityFindings) {
      const { symbol, hint } = finding;
      const plural = hint.actual.argCount === 1 ? "argument" : "arguments";
      const requirement = formatRequiredArgumentCount(hint);
      lines.push(
        `- ${symbol.name}: ${hint.callsiteFile}:${hint.callsiteRange.start.line} passes ${hint.actual.argCount} ${plural}; new signature ${requirement}.`,
      );
    }
  }
  appendDuplicateLeadSummary(lines, duplicateSummary);
  return lines.join("\n");
}

export async function handleImpactCommand(context: ImpactCommandContext): Promise<void> {
  const options = buildDiffProviderOptions(context);
  await hydrateDiffProviderOptions(context, options);
  applyAnalysisOptions(context, options);

  const mermaid = context.hasFlag("--mermaid");
  const json = context.hasFlag("--json");
  const compact = context.hasFlag("--compact");
  const pretty = !json && !mermaid && (context.hasFlag("--pretty") || !compact);
  try {
    const duplicateScope =
      pretty && !mermaid ? parseDuplicateLeadScope(context.getOpt("--duplicates"), "changed") : "off";
    const buildReport: BuildReport = { timings: {} };
    const indexOptions = buildIndexOptions(context, options, { keepParsedForDuplicates: duplicateScope !== "off" });
    indexOptions.report = buildReport;
    const index = await loadCurrentProjectIndex({
      root: context.projectRootFs,
      scope: { kind: "project" },
      options: indexOptions,
    });
    const report = await analyzeImpactFromDiff(context.projectRootFs, index, options as ImpactOptions, { buildReport });
    const impactReport = ensureImpactReport(report);

    if (mermaid) {
      context.writeStdoutLine(formatImpactMermaid(impactReport, context.projectRootFs));
    } else if (pretty) {
      const duplicateSummary =
        duplicateScope === "off"
          ? undefined
          : await collectImpactDuplicateSummary({
              index,
              projectRoot: context.projectRootFs,
              impactReport,
              duplicateScope,
            });
      context.writeStdoutLine(formatPrettyImpactReport(impactReport, duplicateSummary));
    } else {
      context.writeJSONLine(report);
    }
  } catch (error) {
    context.writeStderrLine(`Impact analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    context.exit(1);
  }
}
