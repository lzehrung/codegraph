import picomatch from "picomatch";
import type { Range } from "../types.js";
import { toProjectDisplayPath } from "../util/paths.js";
import { ensureParsedContextForIndex, rethrowStaleQuerySource } from "./parsed-cache.js";
import { isDeclaredSymbol } from "./declarations.js";
import { getCachedScope } from "./navigation-references.js";
import { resolveImported } from "./navigation-resolve.js";
import { defNodeId } from "../graphs/symbol-graph.js";
import { boundList, boundedNonNegativeIntegerOption } from "../presentation/bounds.js";
import type { ImportBinding, ProjectIndex, SymbolDef, SymbolKind } from "./types.js";
import { importNodeId } from "./import-types.js";
import { compareCodeUnits } from "../util/collections.js";

import { DEFAULT_WORKSPACE_SYMBOL_LIMIT, MAX_WORKSPACE_SYMBOL_LIMIT } from "../query/limits.js";
export { DEFAULT_WORKSPACE_SYMBOL_LIMIT, MAX_WORKSPACE_SYMBOL_LIMIT } from "../query/limits.js";

export type WorkspaceSymbolsRequest = {
  query: string;
  kinds?: SymbolKind[];
  exportedOnly?: boolean;
  includeImports?: boolean;
  fileGlob?: string;
  limit?: number;
};

export type WorkspaceSymbolMatch = {
  id: string;
  def: SymbolDef;
  file: string;
  name: string;
  localName: string;
  qualifiedName?: string;
  kind: SymbolKind;
  range: Range;
  exported: boolean;
  imported: boolean;
};

export type WorkspaceSymbolsResult = {
  query: string;
  symbols: WorkspaceSymbolMatch[];
  totalCandidates: number;
  omitted: number;
  limit: number;
  omittedImports: number;
  importScanFailures: number;
};

/** A file's display path and the values derived from it, shared by the file's candidates. */
type SymbolFile = {
  displayPath: string;
  surfaceRank: number;
  /**
   * Lowercase `<displayPath>::`, the start of every lowercase qualified name in the file. Undefined when the path holds
   * a capital sigma, the one character whose lowercase form depends on the characters that follow it.
   */
  lowerQualifiedPrefix: string | undefined;
};

/**
 * A workspace symbol with the values its ranking reads, derived once per index. A local's id comes from its definition
 * when a result or a complete tie needs it.
 */
type SymbolCandidate = {
  def: SymbolDef;
  file: SymbolFile;
  name: string;
  localName: string;
  lowerName: string;
  /** The same string as `lowerName` when the two names are equal. */
  lowerLocalName: string;
  range: Range;
  exported: boolean;
  imported: boolean;
  /** Node id of an import alias; undefined for a local. */
  importId: string | undefined;
};

type CandidateSource = Pick<SymbolCandidate, "def" | "file" | "name" | "localName" | "range" | "exported" | "importId">;

type ImportCandidateBuild = {
  candidates: SymbolCandidate[];
  omitted: number;
  failedFiles: number;
};

type WorkspaceSymbolLookup = {
  locals: SymbolCandidate[];
  imports?: Promise<ImportCandidateBuild>;
};

type PreparedQuery = {
  /** The trimmed query; an empty one matches every candidate that passes the filters. */
  text: string;
  lowerText: string;
  /** Every qualified name holds `::`, and lowercasing keeps it, so only a query holding it can equal one in any case. */
  qualified: boolean;
  tokens: string[];
};

type CandidateFilter = {
  exportedOnly: boolean;
  kinds: ReadonlySet<SymbolKind> | undefined;
  matchesFile: ((file: SymbolFile) => boolean) | undefined;
};

type RankedCandidate = {
  candidate: SymbolCandidate;
  rank: number;
  exactImportAlias: boolean;
};

const QUALIFIED_NAME_SEPARATOR = "::";
const CAPITAL_SIGMA = "\u03a3";

/**
 * Candidates per index. A query compares the values derived here and allocates only for the symbols it matches.
 * Keying by the index object ties the candidates to the snapshot they come from: a rebuilt index (a refresh after an
 * edit) derives its own, and they are released with their index.
 */
const LOOKUP_CACHE = new WeakMap<ProjectIndex, WorkspaceSymbolLookup>();

export async function workspaceSymbols(
  index: ProjectIndex,
  request: WorkspaceSymbolsRequest,
): Promise<WorkspaceSymbolsResult> {
  const query = request.query.trim();
  if (!query && !request.fileGlob && !request.kinds?.length) {
    throw new Error("Workspace symbol lookup requires a query, file glob, or symbol kind filter.");
  }

  const limit = normalizeLimit(request.limit);
  const lookup = getWorkspaceSymbolLookup(index);
  let importBuild: ImportCandidateBuild | undefined;
  if (request.includeImports) {
    lookup.imports ??= buildImportCandidates(index);
    importBuild = await lookup.imports;
  }

  const filter: CandidateFilter = {
    exportedOnly: Boolean(request.exportedOnly),
    kinds: request.kinds?.length ? new Set(request.kinds) : undefined,
    matchesFile: request.fileGlob ? createFileGlobMatcher(request.fileGlob) : undefined,
  };
  const prepared: PreparedQuery = {
    text: query,
    lowerText: query.toLowerCase(),
    qualified: query.includes(QUALIFIED_NAME_SEPARATOR),
    tokens: identifierTokens(query),
  };
  const ranked: RankedCandidate[] = [];
  rankCandidates(lookup.locals, filter, prepared, ranked);
  if (importBuild) rankCandidates(importBuild.candidates, filter, prepared, ranked);

  ranked.sort(compareRankedCandidates);
  const boundedRanked = boundList(ranked, limit);
  const symbols = boundedRanked.items.map(({ candidate }): WorkspaceSymbolMatch => {
    const file = candidate.file.displayPath;
    return {
      id: candidateId(candidate),
      def: candidate.def,
      file,
      name: candidate.name,
      localName: candidate.localName,
      qualifiedName: `${file}${QUALIFIED_NAME_SEPARATOR}${candidate.name}`,
      kind: candidate.def.kind,
      range: candidate.range,
      exported: candidate.exported,
      imported: candidate.imported,
    };
  });
  return {
    query,
    symbols,
    totalCandidates: ranked.length,
    omitted: boundedRanked.omitted,
    limit,
    omittedImports: importBuild?.omitted ?? 0,
    importScanFailures: importBuild?.failedFiles ?? 0,
  };
}

function getWorkspaceSymbolLookup(index: ProjectIndex): WorkspaceSymbolLookup {
  const cached = LOOKUP_CACHE.get(index);
  if (cached) return cached;

  const exportedNamesById = new Map<string, Set<string>>();
  for (const moduleIndex of index.byFile.values()) {
    for (const entry of moduleIndex.exports) {
      if (entry.type !== "local") continue;
      const id = defNodeId(entry.target);
      const names = exportedNamesById.get(id) ?? new Set<string>();
      names.add(entry.exportedAs);
      exportedNamesById.set(id, names);
    }
  }

  const symbolFile = createSymbolFileTable(index.projectRoot);
  const locals: SymbolCandidate[] = [];
  for (const moduleIndex of index.byFile.values()) {
    for (const def of moduleIndex.locals) {
      if (!isDeclaredSymbol(def)) continue;
      const exportedNames = [...(exportedNamesById.get(defNodeId(def)) ?? [])].sort();
      locals.push(
        createCandidate({
          def,
          file: symbolFile(def.file),
          name: exportedNames[0] ?? def.localName,
          localName: def.localName,
          range: def.range,
          exported: Boolean(exportedNames.length),
          importId: undefined,
        }),
      );
    }
  }
  const created = { locals };
  LOOKUP_CACHE.set(index, created);
  return created;
}

/** Returns the shared file record of each indexed file path, deriving its display path once. */
function createSymbolFileTable(projectRoot: string | undefined): (file: string) => SymbolFile {
  const files = new Map<string, SymbolFile>();
  return (file) => {
    const existing = files.get(file);
    if (existing) return existing;
    const displayPath = toProjectDisplayPath(projectRoot, file);
    const created: SymbolFile = {
      displayPath,
      surfaceRank: fileSurfaceRank(displayPath),
      lowerQualifiedPrefix: displayPath.includes(CAPITAL_SIGMA)
        ? undefined
        : `${displayPath}${QUALIFIED_NAME_SEPARATOR}`.toLowerCase(),
    };
    files.set(file, created);
    return created;
  };
}

function createCandidate(source: CandidateSource): SymbolCandidate {
  const lowerName = source.name.toLowerCase();
  return {
    def: source.def,
    file: source.file,
    name: source.name,
    localName: source.localName,
    lowerName,
    lowerLocalName: source.localName === source.name ? lowerName : source.localName.toLowerCase(),
    range: source.range,
    exported: source.exported,
    imported: source.importId !== undefined,
    importId: source.importId,
  };
}

function candidateId(candidate: SymbolCandidate): string {
  return candidate.importId ?? defNodeId(candidate.def);
}

async function buildImportCandidates(index: ProjectIndex): Promise<ImportCandidateBuild> {
  const candidates: SymbolCandidate[] = [];
  const symbolFile = createSymbolFileTable(index.projectRoot);
  let omitted = 0;
  let failedFiles = 0;
  for (const moduleIndex of index.byFile.values()) {
    if (!moduleIndex.imports.length) continue;
    const file = moduleIndex.file;
    try {
      const parsed = await ensureParsedContextForIndex(index, file);
      const scope = getCachedScope(index, file, moduleIndex, parsed);
      for (const binding of scope.all) {
        if (!binding.import) continue;
        const range = binding.def ?? binding.occurrences[0];
        const target = resolveImportDefinition(index, binding.import);
        if (!range || !target || binding.import.kind === "star") {
          omitted += 1;
          continue;
        }
        const importFile = symbolFile(file);
        candidates.push(
          createCandidate({
            def: target,
            file: importFile,
            name: binding.name,
            localName: binding.name,
            range,
            exported: false,
            importId: importNodeId(importFile.displayPath, binding.import),
          }),
        );
      }
    } catch (error) {
      rethrowStaleQuerySource(error);
      failedFiles += 1;
      omitted += moduleIndex.imports.length;
    }
  }
  return { candidates, omitted, failedFiles };
}

function resolveImportDefinition(index: ProjectIndex, binding: ImportBinding): SymbolDef | null {
  if (binding.kind === "namespace" || binding.kind === "star") return null;
  const exportedName = binding.kind === "named" ? binding.imported : "default";
  const resolved = resolveImported(index, binding, exportedName);
  if (!resolved || "namespace" in resolved) return null;
  return resolved;
}

/** Candidates arrive grouped by file, so the glob runs once per run of candidates from one file. */
function createFileGlobMatcher(fileGlob: string): (file: SymbolFile) => boolean {
  const matches = picomatch(fileGlob, { dot: true });
  let lastFile: SymbolFile | undefined;
  let lastMatched = false;
  return (file) => {
    if (file !== lastFile) {
      lastFile = file;
      lastMatched = matches(file.displayPath);
    }
    return lastMatched;
  };
}

function rankCandidates(
  candidates: readonly SymbolCandidate[],
  filter: CandidateFilter,
  query: PreparedQuery,
  ranked: RankedCandidate[],
): void {
  for (const candidate of candidates) {
    if (filter.exportedOnly && !candidate.exported) continue;
    if (filter.kinds && !filter.kinds.has(candidate.def.kind)) continue;
    if (filter.matchesFile && !filter.matchesFile(candidate.file)) continue;
    const match = rankCandidate(candidate, query);
    if (match) ranked.push(match);
  }
}

function rankCandidate(candidate: SymbolCandidate, query: PreparedQuery): RankedCandidate | null {
  if (!query.text) return { candidate, rank: 6, exactImportAlias: false };
  if (query.qualified && qualifiedNameEquals(candidate, query.text)) {
    return { candidate, rank: 0, exactImportAlias: candidate.imported };
  }
  if (candidate.name === query.text || candidate.localName === query.text) {
    return { candidate, rank: 1, exactImportAlias: candidate.imported };
  }
  if (equalsIgnoringCase(candidate, query)) {
    return { candidate, rank: 2, exactImportAlias: candidate.imported };
  }
  const { lowerName, lowerLocalName } = candidate;
  const lowerQuery = query.lowerText;
  if (lowerName.startsWith(lowerQuery) || lowerLocalName.startsWith(lowerQuery)) {
    return { candidate, rank: 3, exactImportAlias: false };
  }
  if (hasQueryTokens(candidate, query.tokens)) {
    return { candidate, rank: 4, exactImportAlias: false };
  }
  if (lowerName.includes(lowerQuery) || lowerLocalName.includes(lowerQuery)) {
    return { candidate, rank: 5, exactImportAlias: false };
  }
  return null;
}

/** Whether `<file>::<name>` equals `value`, compared without building the qualified name. */
function qualifiedNameEquals(candidate: SymbolCandidate, value: string): boolean {
  const { displayPath } = candidate.file;
  const { name } = candidate;
  if (value.length !== displayPath.length + QUALIFIED_NAME_SEPARATOR.length + name.length) return false;
  return (
    value.startsWith(displayPath) &&
    value.startsWith(QUALIFIED_NAME_SEPARATOR, displayPath.length) &&
    value.endsWith(name)
  );
}

function equalsIgnoringCase(candidate: SymbolCandidate, query: PreparedQuery): boolean {
  if (candidate.lowerName === query.lowerText || candidate.lowerLocalName === query.lowerText) return true;
  return query.qualified && lowerQualifiedNameEquals(candidate, query.lowerText);
}

/**
 * Whether the lowercase `<file>::<name>` equals `lowerValue`. It starts with the file's lowercase prefix, so only the
 * candidates of a file whose prefix starts the value build the full name.
 */
function lowerQualifiedNameEquals(candidate: SymbolCandidate, lowerValue: string): boolean {
  const prefix = candidate.file.lowerQualifiedPrefix;
  if (prefix !== undefined && !lowerValue.startsWith(prefix)) return false;
  return `${candidate.file.displayPath}${QUALIFIED_NAME_SEPARATOR}${candidate.name}`.toLowerCase() === lowerValue;
}

/**
 * Whether the identifier tokens of the candidate's names include every query token. A token is a lowercase ASCII run
 * of one name, so it also occurs in that lowercase name: the substring test rejects most candidates before tokenizing.
 */
function hasQueryTokens(candidate: SymbolCandidate, queryTokens: readonly string[]): boolean {
  if (!queryTokens.length) return false;
  for (const token of queryTokens) {
    if (!candidate.lowerName.includes(token) && !candidate.lowerLocalName.includes(token)) return false;
  }
  const candidateTokens = new Set(identifierTokens(`${candidate.name} ${candidate.localName}`));
  return queryTokens.every((token) => candidateTokens.has(token));
}

function identifierTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

function compareRankedCandidates(left: RankedCandidate, right: RankedCandidate): number {
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.exactImportAlias !== right.exactImportAlias) return left.exactImportAlias ? -1 : 1;
  const leftCandidate = left.candidate;
  const rightCandidate = right.candidate;
  if (leftCandidate.exported !== rightCandidate.exported) return leftCandidate.exported ? -1 : 1;
  const surfaceOrder = leftCandidate.file.surfaceRank - rightCandidate.file.surfaceRank;
  if (surfaceOrder) return surfaceOrder;
  const fileOrder = compareCodeUnits(leftCandidate.file.displayPath, rightCandidate.file.displayPath);
  if (fileOrder) return fileOrder;
  const lineOrder = leftCandidate.range.start.line - rightCandidate.range.start.line;
  if (lineOrder) return lineOrder;
  const columnOrder = leftCandidate.range.start.column - rightCandidate.range.start.column;
  if (columnOrder) return columnOrder;
  return compareCodeUnits(candidateId(leftCandidate), candidateId(rightCandidate));
}

function fileSurfaceRank(file: string): number {
  const normalized = `/${file.toLowerCase()}/`;
  if (/\/(?:test|tests|__tests__|spec|specs)\//.test(normalized)) return 1;
  if (/\/(?:doc|docs)\//.test(normalized)) return 2;
  return 0;
}

function normalizeLimit(limit: number | undefined): number {
  return boundedNonNegativeIntegerOption(
    limit,
    DEFAULT_WORKSPACE_SYMBOL_LIMIT,
    MAX_WORKSPACE_SYMBOL_LIMIT,
    "Workspace symbol limit",
  );
}
