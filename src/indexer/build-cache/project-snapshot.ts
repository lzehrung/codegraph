import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Edge, EdgeTo, Graph, Pos, Range } from "../../types.js";
import { buildGraphAdjacency } from "../../graphs/adjacency.js";
import { buildReferenceCandidateIndex } from "../reference-candidates.js";
import type { ProjectFileInfo } from "../../util/projectFiles.js";
import { BloomFilter, BloomFilterCache } from "../../util/bloomFilter.js";
import { summarizeAnalysis } from "../../analysisSummary.js";
import type { AnalysisSummary } from "../../analysisSummary.js";
import { SymbolKind } from "../types.js";
import type {
  BackendReport,
  BuildOptions,
  ExportEntry,
  GraphReport,
  ImportBinding,
  ModuleIndex,
  ProjectIndex,
  SymbolDef,
} from "../types.js";
import { cacheRoot } from "./module-cache.js";
import type { ManifestFileEntry } from "./manifest.js";

const SNAPSHOT_SYMBOL_KINDS = new Set<SymbolKind>(Object.values(SymbolKind));
const PROJECT_SNAPSHOT_VERSION = 2;
const BLOOM_FILTER_MIN_SIZE = 1_000;
const BLOOM_FILTER_MAX_SIZE = 1_000_000;
const BLOOM_FILTER_MIN_HASH_COUNT = 1;
const BLOOM_FILTER_MAX_HASH_COUNT = 10;

type SerializedBloomFilter = {
  size: number;
  hashCount: number;
  bitsBase64: string;
};

type SnapshotAnalysisReport = {
  backend?: BackendReport;
  graph?: GraphReport;
};

export type LoadedProjectIndexSnapshot = {
  index: ProjectIndex;
  analysisReport?: SnapshotAnalysisReport;
};

type ProjectIndexSnapshotPayload = {
  version: number;
  filesSignature: string;
  graph: {
    nodes: string[];
    edges: Graph["edges"];
  };
  modules: ModuleIndex[];
  projectRoot?: string;
  nativeMode?: ProjectIndex["nativeMode"];
  projectFiles?: ProjectFileInfo[];
  bloomFilters?: Record<string, SerializedBloomFilter>;
  analysis?: AnalysisSummary;
  analysisReport?: SnapshotAnalysisReport;
};

export function projectSnapshotFilesSignature(entries: ReadonlyMap<string, ManifestFileEntry>): string {
  const hash = createHash("sha256");
  for (const [file, entry] of [...entries.entries()].sort(([left], [right]) => compareSnapshotPath(left, right))) {
    hash.update(file);
    hash.update("\0");
    hash.update(entry.sig);
    hash.update("\0");
    hash.update(entry.gitSig ?? "");
    hash.update("\0");
    hash.update(entry.sqlCorpusSig ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function compareSnapshotPath(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export async function tryLoadProjectIndexSnapshot(
  projectRoot: string,
  opts: BuildOptions | undefined,
  filesSignature: string,
): Promise<LoadedProjectIndexSnapshot | null> {
  if ((opts?.cache ?? "off") !== "disk") return null;
  try {
    const payload = JSON.parse(await fsp.readFile(projectSnapshotPath(projectRoot, opts), "utf8")) as unknown;
    if (
      !isProjectIndexSnapshotPayload(payload) ||
      payload.filesSignature !== filesSignature ||
      payload.nativeMode !== normalizedSnapshotNativeMode(opts?.native)
    ) {
      return null;
    }
    const graph: Graph = {
      nodes: new Set(payload.graph.nodes),
      edges: payload.graph.edges,
    };
    const modules = new Map(payload.modules.map((moduleIndex) => [moduleIndex.file, moduleIndex]));
    const shouldHydrateBloomFilters = opts?.useBloomFilters ?? true;
    const index: ProjectIndex = {
      graph,
      graphAdjacency: buildGraphAdjacency(graph),
      modules,
      byFile: modules,
      ...(payload.projectRoot ? { projectRoot: payload.projectRoot } : {}),
      ...(payload.nativeMode ? { nativeMode: payload.nativeMode } : {}),
      exportCache: new Map(),
      scopeCache: new Map(),
      ...(shouldHydrateBloomFilters && payload.bloomFilters
        ? { bloomFilters: deserializeBloomFilterCache(payload.bloomFilters) }
        : {}),
      ...(payload.projectFiles ? { projectFiles: payload.projectFiles } : {}),
      referenceCandidates: buildReferenceCandidateIndex(modules),
      ...(opts?.cache ? { cacheMode: opts.cache, cacheRootDir: cacheRoot(projectRoot, opts) } : {}),
    };
    return {
      index: {
        ...index,
        ...(payload.analysis ? { analysis: payload.analysis } : {}),
      },
      ...(payload.analysisReport ? { analysisReport: payload.analysisReport } : {}),
    };
  } catch {
    return null;
  }
}

export async function writeProjectIndexSnapshot(
  projectRoot: string,
  opts: BuildOptions | undefined,
  index: ProjectIndex,
  filesSignature: string,
): Promise<void> {
  if ((opts?.cache ?? "off") !== "disk") return;
  const serializedBloomFilters = index.bloomFilters
    ? serializeBloomFilterCache(index.bloomFilters, index.byFile.keys())
    : undefined;
  const snapshotAnalysisReport = analysisReportFromBuildReport(index.buildReport);
  const snapshotAnalysis = index.buildReport ? summarizeAnalysis({ index, report: index.buildReport }) : index.analysis;
  const payload: ProjectIndexSnapshotPayload = {
    version: PROJECT_SNAPSHOT_VERSION,
    filesSignature,
    graph: {
      nodes: [...index.graph.nodes],
      edges: index.graph.edges,
    },
    modules: [...index.byFile.values()],
    ...(index.projectRoot ? { projectRoot: index.projectRoot } : {}),
    ...(normalizedSnapshotNativeMode(index.nativeMode)
      ? { nativeMode: normalizedSnapshotNativeMode(index.nativeMode) }
      : {}),
    ...(index.projectFiles ? { projectFiles: index.projectFiles } : {}),
    ...(serializedBloomFilters ? { bloomFilters: serializedBloomFilters } : {}),
    ...(snapshotAnalysis ? { analysis: snapshotAnalysis } : {}),
    ...(snapshotAnalysisReport ? { analysisReport: snapshotAnalysisReport } : {}),
  };
  try {
    const snapshotPath = projectSnapshotPath(projectRoot, opts);
    await fsp.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fsp.writeFile(snapshotPath, JSON.stringify(payload), "utf8");
  } catch {
    // Snapshot writes are an optimization; cache write failures must not fail indexing.
  }
}

function projectSnapshotPath(projectRoot: string, opts: BuildOptions | undefined): string {
  return path.join(cacheRoot(projectRoot, opts), "project-index-snapshot.json");
}

function normalizedSnapshotNativeMode(
  nativeMode: ProjectIndex["nativeMode"] | undefined,
): ProjectIndex["nativeMode"] | undefined {
  if (nativeMode === undefined || nativeMode === "auto") return undefined;
  return nativeMode;
}

function isSnapshotNativeMode(value: unknown): value is ProjectIndex["nativeMode"] {
  return value === "auto" || value === "on" || value === "off";
}

function isProjectFileInfo(value: unknown): value is ProjectFileInfo {
  if (!value || typeof value !== "object") return false;
  const projectFile = value as Partial<ProjectFileInfo>;
  return (
    typeof projectFile.path === "string" &&
    (projectFile.kind === "file" || projectFile.kind === "dir") &&
    isProjectFileType(projectFile.type) &&
    isProjectFileRole(projectFile.role) &&
    typeof projectFile.projectRoot === "string" &&
    (projectFile.name === undefined || typeof projectFile.name === "string")
  );
}

function isProjectFileType(value: unknown): boolean {
  return (
    value === "node" ||
    value === "typescript" ||
    value === "python" ||
    value === "rust" ||
    value === "go" ||
    value === "maven" ||
    value === "gradle" ||
    value === "dotnet" ||
    value === "ruby" ||
    value === "php" ||
    value === "swift" ||
    value === "native" ||
    value === "ide"
  );
}

function isProjectFileRole(value: unknown): boolean {
  return value === "manifest" || value === "lockfile" || value === "config" || value === "solution" || value === "ide";
}

function isProjectIndexSnapshotPayload(value: unknown): value is ProjectIndexSnapshotPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ProjectIndexSnapshotPayload>;
  return (
    payload.version === PROJECT_SNAPSHOT_VERSION &&
    typeof payload.filesSignature === "string" &&
    !!payload.graph &&
    Array.isArray(payload.graph.nodes) &&
    payload.graph.nodes.every((node) => typeof node === "string") &&
    Array.isArray(payload.graph.edges) &&
    payload.graph.edges.every(isGraphEdge) &&
    Array.isArray(payload.modules) &&
    payload.modules.every(isModuleIndex) &&
    (payload.projectRoot === undefined || typeof payload.projectRoot === "string") &&
    (payload.nativeMode === undefined || isSnapshotNativeMode(payload.nativeMode)) &&
    (payload.bloomFilters === undefined || isSerializedBloomFilterRecord(payload.bloomFilters)) &&
    (payload.analysis === undefined || isAnalysisSummary(payload.analysis)) &&
    (payload.analysisReport === undefined || isSnapshotAnalysisReport(payload.analysisReport)) &&
    (payload.projectFiles === undefined ||
      (Array.isArray(payload.projectFiles) && payload.projectFiles.every(isProjectFileInfo)))
  );
}

function analysisReportFromBuildReport(report: ProjectIndex["buildReport"]): SnapshotAnalysisReport | undefined {
  if (!report?.backend && !report?.graph) {
    return undefined;
  }
  return {
    ...(report.backend ? { backend: report.backend } : {}),
    ...(report.graph ? { graph: report.graph } : {}),
  };
}

function isSnapshotAnalysisReport(value: unknown): value is SnapshotAnalysisReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<SnapshotAnalysisReport>;
  return (
    (report.backend === undefined || isBackendReport(report.backend)) &&
    (report.graph === undefined || isGraphReport(report.graph))
  );
}

function isBackendReport(value: unknown): value is BackendReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<BackendReport>;
  return (
    !!report.native &&
    isNativeBackendReport(report.native) &&
    (report.parser === undefined || isParserBackendDegradationReport(report.parser))
  );
}

function isNativeBackendReport(value: unknown): value is BackendReport["native"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<BackendReport["native"]>;
  return (
    typeof report.available === "boolean" &&
    typeof report.enabled === "boolean" &&
    Array.isArray(report.supportedLanguageIds) &&
    report.supportedLanguageIds.every((languageId) => typeof languageId === "string") &&
    typeof report.filesUsed === "number" &&
    typeof report.filesFellBack === "number" &&
    isUnknownRecord(report.fallbackReasons) &&
    isUnknownRecord(report.byLanguage) &&
    Array.isArray(report.errors)
  );
}

function isParserBackendDegradationReport(value: unknown): value is NonNullable<BackendReport["parser"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<NonNullable<BackendReport["parser"]>>;
  return typeof report.total === "number" && isNumberRecord(report.byLanguage) && Array.isArray(report.files);
}

function isGraphReport(value: unknown): value is GraphReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<GraphReport>;
  return !!report.fallbackImportExtraction && isFallbackImportExtractionReport(report.fallbackImportExtraction);
}

function isFallbackImportExtractionReport(value: unknown): value is GraphReport["fallbackImportExtraction"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<GraphReport["fallbackImportExtraction"]>;
  return (
    typeof report.total === "number" &&
    isNumberRecord(report.byLanguage) &&
    isUnknownRecord(report.files) &&
    (report.byReason === undefined || isNumberRecord(report.byReason))
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isUnknownRecord(value) && Object.values(value).every((entry) => typeof entry === "number");
}

function isAnalysisSummary(value: unknown): value is AnalysisSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as Partial<AnalysisSummary>;
  return (
    (summary.mode === "semantic" || summary.mode === "mixed" || summary.mode === "reduced") &&
    (summary.backend === "native" ||
      summary.backend === "mixed" ||
      summary.backend === "graph-only" ||
      summary.backend === "unknown") &&
    typeof summary.parserDegradedFiles === "number" &&
    typeof summary.fallbackImportExtractionFiles === "number" &&
    typeof summary.nativeFilesUsed === "number" &&
    typeof summary.nativeFilesFellBack === "number" &&
    typeof summary.label === "string"
  );
}

function serializeBloomFilterCache(
  cache: BloomFilterCache,
  files: Iterable<string>,
): Record<string, SerializedBloomFilter> | undefined {
  const serialized: Record<string, SerializedBloomFilter> = {};
  for (const file of files) {
    const filter = cache.get(file);
    if (!filter) continue;
    const metadata = filter.getMetadata();
    serialized[file] = {
      size: metadata.size,
      hashCount: metadata.hashCount,
      bitsBase64: filter.toBuffer().toString("base64"),
    };
  }
  return Object.keys(serialized).length ? serialized : undefined;
}

function deserializeBloomFilterCache(serialized: Record<string, SerializedBloomFilter>): BloomFilterCache {
  const cache = new BloomFilterCache();
  for (const [file, filter] of Object.entries(serialized)) {
    cache.set(file, BloomFilter.fromBuffer(Buffer.from(filter.bitsBase64, "base64"), filter.size, filter.hashCount));
  }
  return cache;
}

function isSerializedBloomFilterRecord(value: unknown): value is Record<string, SerializedBloomFilter> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(isSerializedBloomFilter);
}

function isSerializedBloomFilter(value: unknown): value is SerializedBloomFilter {
  if (!value || typeof value !== "object") return false;
  const filter = value as Partial<SerializedBloomFilter>;
  if (
    typeof filter.size !== "number" ||
    !Number.isInteger(filter.size) ||
    filter.size < BLOOM_FILTER_MIN_SIZE ||
    filter.size > BLOOM_FILTER_MAX_SIZE ||
    typeof filter.hashCount !== "number" ||
    !Number.isInteger(filter.hashCount) ||
    filter.hashCount < BLOOM_FILTER_MIN_HASH_COUNT ||
    filter.hashCount > BLOOM_FILTER_MAX_HASH_COUNT ||
    typeof filter.bitsBase64 !== "string"
  ) {
    return false;
  }
  const maxBytes = Math.ceil(filter.size / 8);
  const maxBase64Length = Math.ceil(maxBytes / 3) * 4;
  return filter.bitsBase64.length === maxBase64Length;
}

function isModuleIndex(value: unknown): value is ModuleIndex {
  if (!value || typeof value !== "object") return false;
  const moduleIndex = value as Partial<ModuleIndex>;
  return (
    typeof moduleIndex.file === "string" &&
    Array.isArray(moduleIndex.locals) &&
    moduleIndex.locals.every(isSymbolDef) &&
    Array.isArray(moduleIndex.imports) &&
    moduleIndex.imports.every(isImportBinding) &&
    Array.isArray(moduleIndex.exports) &&
    moduleIndex.exports.every(isExportEntry)
  );
}

function isSymbolDef(value: unknown): value is SymbolDef {
  if (!value || typeof value !== "object") return false;
  const symbol = value as Partial<SymbolDef>;
  return (
    typeof symbol.file === "string" &&
    typeof symbol.localName === "string" &&
    isSymbolKind(symbol.kind) &&
    isRange(symbol.range) &&
    (symbol.docstring === undefined || typeof symbol.docstring === "string") &&
    (symbol.lineSpan === undefined || typeof symbol.lineSpan === "number") &&
    (symbol.complexity === undefined || typeof symbol.complexity === "number")
  );
}

function isImportBinding(value: unknown): value is ImportBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<ImportBinding>;
  if (
    typeof binding.from !== "string" ||
    !isResolvedImportTarget(binding.resolved) ||
    !isOptionalBoolean(binding.typeOnly) ||
    !isImportMechanism(binding.mechanism) ||
    !isResolvedType(binding.resolvedType) ||
    !isOptionalNumber(binding.confidence)
  ) {
    return false;
  }
  if (binding.kind === "default") return typeof binding.local === "string";
  if (binding.kind === "named") {
    return (
      typeof binding.local === "string" &&
      typeof binding.imported === "string" &&
      (binding.phpImportType === undefined ||
        binding.phpImportType === "class" ||
        binding.phpImportType === "function" ||
        binding.phpImportType === "const")
    );
  }
  if (binding.kind === "namespace") return typeof binding.localNS === "string";
  return binding.kind === "star";
}

function isExportEntry(value: unknown): value is ExportEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ExportEntry>;
  if (entry.type === "local") return typeof entry.exportedAs === "string" && isSymbolDef(entry.target);
  if (entry.type === "reexport") {
    return (
      typeof entry.exportedAs === "string" &&
      typeof entry.fromModule === "string" &&
      typeof entry.sourceSpecifier === "string" &&
      (entry.moduleSpecifier === undefined || typeof entry.moduleSpecifier === "string") &&
      isOptionalBoolean(entry.typeOnly)
    );
  }
  if (entry.type === "namespaceReexport") {
    return (
      typeof entry.exportedAs === "string" &&
      typeof entry.fromModule === "string" &&
      (entry.moduleSpecifier === undefined || typeof entry.moduleSpecifier === "string") &&
      isOptionalBoolean(entry.typeOnly)
    );
  }
  if (entry.type === "exportStar") {
    return (
      typeof entry.fromModule === "string" &&
      typeof entry.sourceSpecifier === "string" &&
      (entry.moduleSpecifier === undefined || typeof entry.moduleSpecifier === "string") &&
      isOptionalBoolean(entry.typeOnly)
    );
  }
  return false;
}

function isResolvedImportTarget(value: ImportBinding["resolved"] | undefined): boolean {
  if (value === undefined || typeof value === "string") return true;
  return Boolean(value && typeof value === "object" && typeof value.external === "string");
}

function isImportMechanism(value: unknown): boolean {
  return value === undefined || value === "es" || value === "cjs" || value === "python" || value === "php";
}

function isResolvedType(value: unknown): boolean {
  return value === undefined || value === "heuristic" || value === "precise";
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function isSymbolKind(value: unknown): value is SymbolKind {
  return SNAPSHOT_SYMBOL_KINDS.has(value as SymbolKind);
}

function isRange(value: unknown): value is Range {
  if (!value || typeof value !== "object") return false;
  const range = value as Partial<Range>;
  return isPos(range.start) && isPos(range.end);
}

function isPos(value: unknown): value is Pos {
  if (!value || typeof value !== "object") return false;
  const pos = value as Partial<Pos>;
  return (
    typeof pos.line === "number" &&
    typeof pos.column === "number" &&
    (pos.index === undefined || typeof pos.index === "number")
  );
}

function isGraphEdge(value: unknown): value is Edge {
  if (!value || typeof value !== "object") return false;
  const edge = value as Partial<Edge>;
  const resolved = edge.resolved;
  return (
    typeof edge.from === "string" &&
    isEdgeTo(edge.to) &&
    typeof edge.raw === "string" &&
    (edge.typeOnly === undefined || typeof edge.typeOnly === "boolean") &&
    (resolved === undefined || resolved === "heuristic" || resolved === "precise") &&
    (edge.confidence === undefined || typeof edge.confidence === "number")
  );
}

function isEdgeTo(value: unknown): value is EdgeTo {
  if (!value || typeof value !== "object") return false;
  const edgeTo = value as Partial<EdgeTo>;
  if (edgeTo.type === "file") return typeof edgeTo.path === "string";
  if (edgeTo.type === "external") return typeof edgeTo.name === "string";
  return false;
}
