import type { ProjectIndex } from "../indexer.js";
import { mapLimit } from "../util.js";
import { analyzeImpact } from "./analyzer.js";
import { locateChangedSymbolsWithLines } from "./map.js";
import { createImpactIgnoreMatcher, normalizeImpactDiffFiles } from "./path.js";
import { getDiff } from "./providers/base.js";
import type { ChangedSymbol, FileChange, ImpactDiagnostics, ImpactItem, ImpactOptions } from "./types.js";

export type CollectedImpactAnalysis = {
  normalizedChanges: FileChange[];
  changedSymbols: ChangedSymbol[];
  impactedItems: ImpactItem[];
  diagnostics: ImpactDiagnostics;
  warning?: string | undefined;
};

export type ChangedSymbolCollection = {
  changedSymbols: ChangedSymbol[];
  filesWithSymbols: ReadonlySet<string>;
};

export type ChangedFileSymbolMapping = {
  idx: number;
  path: string;
  kind: FileChange["kind"];
  symbols: ChangedSymbol[];
  parseFailed: boolean;
};

export function createImpactDiagnostics(changedFilesTotal: number, changedFilesIgnored: number): ImpactDiagnostics {
  return {
    changedFilesTotal,
    changedFilesIgnored,
    changedFilesWithoutSymbols: 0,
    symbolMappingParseFailures: 0,
    refsScanned: 0,
    refsFilteredTests: 0,
    refsFilteredIgnored: 0,
    refsDroppedByMaxRefs: 0,
    fallbackSeededFiles: 0,
    fallbackSeededDependents: 0,
  };
}

export async function collectChangedSymbols(
  index: ProjectIndex,
  normalizedChanges: FileChange[],
  options: Pick<ImpactOptions, "scope">,
  diagnostics: ImpactDiagnostics,
): Promise<ChangedSymbolCollection> {
  const changedByFile = await mapLimit(
    normalizedChanges.map((fileChange, idx) => ({ fileChange, idx })),
    8,
    async ({ fileChange, idx }) => await mapChangedFileSymbols(index, fileChange, idx),
  );

  changedByFile.sort((a, b) => a.idx - b.idx);
  let changedSymbols: ChangedSymbol[] = [];
  const filesWithSymbols = new Set<string>();
  for (const entry of changedByFile) {
    changedSymbols.push(...applyChangedFileSymbolMapping(entry, options, diagnostics, filesWithSymbols));
  }

  return { changedSymbols, filesWithSymbols };
}

export async function mapChangedFileSymbols(
  index: ProjectIndex,
  fileChange: FileChange,
  idx: number,
): Promise<ChangedFileSymbolMapping> {
  const mapped = await locateChangedSymbolsWithLines(index, fileChange.path, fileChange.hunks);
  return {
    idx,
    path: fileChange.path,
    kind: fileChange.kind,
    symbols: mapped.changedSymbols,
    parseFailed: mapped.parseFailed,
  };
}

export function applyChangedFileSymbolMapping(
  entry: ChangedFileSymbolMapping,
  options: Pick<ImpactOptions, "scope">,
  diagnostics: ImpactDiagnostics,
  filesWithSymbols: Set<string>,
): ChangedSymbol[] {
  if (entry.symbols.length) filesWithSymbols.add(entry.path);
  if (!entry.symbols.length) {
    diagnostics.changedFilesWithoutSymbols += 1;
    if (entry.parseFailed && entry.kind !== "deleted") {
      diagnostics.symbolMappingParseFailures += 1;
    }
  }
  return options.scope === "imported" ? entry.symbols.filter((symbol) => symbol.exported) : entry.symbols;
}

export function listFileLevelFallbackPaths(normalizedChanges: FileChange[], filesWithSymbols: ReadonlySet<string>) {
  return normalizedChanges
    .filter((change) => change.kind !== "deleted" && !filesWithSymbols.has(change.path))
    .map((change) => change.path);
}

export async function collectImpactAnalysis(
  projectRoot: string,
  index: ProjectIndex,
  options: ImpactOptions,
): Promise<CollectedImpactAnalysis> {
  const diff = await getDiff(options);
  const { ignoreGlobs = [] } = options;
  const isIgnored = createImpactIgnoreMatcher(projectRoot, ignoreGlobs);
  const normalizedDiff = normalizeImpactDiffFiles(projectRoot, diff.files, isIgnored);
  const diagnostics = createImpactDiagnostics(diff.files.length, normalizedDiff.ignoredCount);

  const normalizedChanges = normalizedDiff.files;
  const { changedSymbols, filesWithSymbols } = await collectChangedSymbols(
    index,
    normalizedChanges,
    options,
    diagnostics,
  );

  const fileLevelFallback = options.fileLevelFallback ?? true;
  const fileLevelFallbackPaths = listFileLevelFallbackPaths(normalizedChanges, filesWithSymbols);

  const impactedItems = await analyzeImpact(index, changedSymbols, normalizedChanges, {
    ...options,
    projectRoot,
    fileLevelFallback,
    fileLevelFallbackPaths,
    diagnostics,
  });

  return {
    normalizedChanges,
    changedSymbols,
    impactedItems,
    diagnostics,
    warning: diff.warning,
  };
}
