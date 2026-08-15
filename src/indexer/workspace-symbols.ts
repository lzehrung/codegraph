import picomatch from "picomatch";
import type { Range } from "../types.js";
import { fileIdentityKey, toProjectDisplayPath } from "../util/paths.js";
import { ensureParsedContext } from "./parse-context.js";
import { getCachedScope } from "./navigation-references.js";
import { resolveImported } from "./navigation-resolve.js";
import { defNodeId } from "../graphs/symbol-graph.js";
import { boundList } from "../presentation/bounds.js";
import type { ImportBinding, ProjectIndex, SymbolDef, SymbolKind } from "./types.js";

export const DEFAULT_WORKSPACE_SYMBOL_LIMIT = 50;
export const MAX_WORKSPACE_SYMBOL_LIMIT = 500;

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

type LocalCandidate = {
  def: SymbolDef;
  exportedNames: string[];
};

type ImportCandidateBuild = {
  symbols: WorkspaceSymbolMatch[];
  omitted: number;
  failedFiles: number;
};

type WorkspaceSymbolLookup = {
  locals: LocalCandidate[];
  imports?: Promise<ImportCandidateBuild>;
};

type RankedCandidate = {
  candidate: WorkspaceSymbolMatch;
  rank: number;
  exactImportAlias: boolean;
};

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
  const candidates = lookup.locals.map((candidate) => toLocalMatch(candidate, index.projectRoot));
  let omittedImports = 0;
  let importScanFailures = 0;
  if (request.includeImports) {
    lookup.imports ??= buildImportCandidates(index);
    const importBuild = await lookup.imports;
    candidates.push(...importBuild.symbols);
    omittedImports = importBuild.omitted;
    importScanFailures = importBuild.failedFiles;
  }

  const kindFilter = request.kinds?.length ? new Set(request.kinds) : undefined;
  const fileMatches = request.fileGlob ? picomatch(request.fileGlob, { dot: true }) : undefined;
  const ranked: RankedCandidate[] = [];
  for (const candidate of candidates) {
    if (request.exportedOnly && !candidate.exported) continue;
    if (kindFilter && !kindFilter.has(candidate.kind as SymbolKind)) continue;
    if (fileMatches && !fileMatches(candidate.file)) continue;
    const match = rankCandidate(candidate, query);
    if (match) ranked.push(match);
  }

  ranked.sort(compareRankedCandidates);
  const boundedRanked = boundList(ranked, limit);
  const symbols = boundedRanked.items.map(({ candidate }) => candidate);
  return {
    query,
    symbols,
    totalCandidates: ranked.length,
    omitted: boundedRanked.omitted,
    limit,
    omittedImports,
    importScanFailures,
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

  const locals: LocalCandidate[] = [];
  for (const moduleIndex of index.byFile.values()) {
    for (const def of moduleIndex.locals) {
      locals.push({
        def,
        exportedNames: [...(exportedNamesById.get(defNodeId(def)) ?? [])].sort(),
      });
    }
  }
  const created = { locals };
  LOOKUP_CACHE.set(index, created);
  return created;
}

function toLocalMatch(candidate: LocalCandidate, projectRoot: string | undefined): WorkspaceSymbolMatch {
  const { def, exportedNames } = candidate;
  const name = exportedNames[0] ?? def.localName;
  const file = toProjectDisplayPath(projectRoot, def.file);
  return {
    id: defNodeId(def),
    def,
    file,
    name,
    localName: def.localName,
    qualifiedName: `${file}::${name}`,
    kind: def.kind,
    range: def.range,
    exported: Boolean(exportedNames.length),
    imported: false,
  };
}

async function buildImportCandidates(index: ProjectIndex): Promise<ImportCandidateBuild> {
  const symbols: WorkspaceSymbolMatch[] = [];
  let omitted = 0;
  let failedFiles = 0;
  for (const moduleIndex of index.byFile.values()) {
    if (!moduleIndex.imports.length) continue;
    const file = moduleIndex.file;
    try {
      const parsed = await ensureParsedContext(file, index.parsed?.get(fileIdentityKey(file)));
      const scope = getCachedScope(index, file, moduleIndex, parsed);
      for (const binding of scope.all) {
        if (!binding.import) continue;
        const range = binding.def ?? binding.occurrences[0];
        const target = resolveImportDefinition(index, binding.import);
        if (!range || !target) {
          omitted += 1;
          continue;
        }
        const displayFile = toProjectDisplayPath(index.projectRoot, file);
        symbols.push({
          id: `${displayFile}::${binding.name}::import`,
          def: target,
          file: displayFile,
          name: binding.name,
          localName: binding.name,
          qualifiedName: `${displayFile}::${binding.name}`,
          kind: target.kind,
          range,
          exported: false,
          imported: true,
        });
      }
    } catch {
      failedFiles += 1;
      omitted += moduleIndex.imports.length;
    }
  }
  return { symbols, omitted, failedFiles };
}

function resolveImportDefinition(index: ProjectIndex, binding: ImportBinding): SymbolDef | null {
  if (binding.kind === "namespace" || binding.kind === "star") return null;
  const exportedName = binding.kind === "named" ? binding.imported : "default";
  const resolved = resolveImported(index, binding, exportedName);
  if (!resolved || "namespace" in resolved) return null;
  return resolved;
}

function rankCandidate(candidate: WorkspaceSymbolMatch, query: string): RankedCandidate | null {
  if (!query) return { candidate, rank: 6, exactImportAlias: false };
  const qualifiedName = candidate.qualifiedName ?? "";
  const names = [candidate.name, candidate.localName];
  if (qualifiedName === query) return { candidate, rank: 0, exactImportAlias: candidate.imported };
  if (names.includes(query)) return { candidate, rank: 1, exactImportAlias: candidate.imported };

  const normalizedQuery = query.toLowerCase();
  const normalizedNames = names.map((name) => name.toLowerCase());
  if (qualifiedName.toLowerCase() === normalizedQuery || normalizedNames.includes(normalizedQuery)) {
    return { candidate, rank: 2, exactImportAlias: candidate.imported };
  }
  if (normalizedNames.some((name) => name.startsWith(normalizedQuery))) {
    return { candidate, rank: 3, exactImportAlias: false };
  }

  const queryTokens = identifierTokens(query);
  const candidateTokens = new Set(identifierTokens(names.join(" ")));
  if (queryTokens.length && queryTokens.every((token) => candidateTokens.has(token))) {
    return { candidate, rank: 4, exactImportAlias: false };
  }
  if (normalizedNames.some((name) => name.includes(normalizedQuery))) {
    return { candidate, rank: 5, exactImportAlias: false };
  }
  return null;
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
  if (left.candidate.exported !== right.candidate.exported) return left.candidate.exported ? -1 : 1;
  const surfaceOrder = fileSurfaceRank(left.candidate.file) - fileSurfaceRank(right.candidate.file);
  if (surfaceOrder) return surfaceOrder;
  const fileOrder = compareCodeUnits(left.candidate.file, right.candidate.file);
  if (fileOrder) return fileOrder;
  const lineOrder = left.candidate.range.start.line - right.candidate.range.start.line;
  if (lineOrder) return lineOrder;
  const columnOrder = left.candidate.range.start.column - right.candidate.range.start.column;
  if (columnOrder) return columnOrder;
  return compareCodeUnits(left.candidate.id, right.candidate.id);
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function fileSurfaceRank(file: string): number {
  const normalized = `/${file.toLowerCase()}/`;
  if (/\/(?:test|tests|__tests__|spec|specs)\//.test(normalized)) return 1;
  if (/\/(?:doc|docs)\//.test(normalized)) return 2;
  return 0;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_WORKSPACE_SYMBOL_LIMIT;
  if (!Number.isInteger(limit) || limit < 0) throw new Error("Workspace symbol limit must be a non-negative integer.");
  return Math.min(limit, MAX_WORKSPACE_SYMBOL_LIMIT);
}
