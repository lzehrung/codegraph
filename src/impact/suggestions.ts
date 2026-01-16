import path from "node:path";
import type Parser from "tree-sitter";
import type { FileId, Range } from "../types.js";
import type {
  ExportEntry,
  ImportBinding,
  ModuleIndex,
  ProjectIndex,
} from "../indexer.js";
import { goToDefinition } from "../indexer.js";
import type { LanguageSupport } from "../languages.js";
import type {
  FileChange,
  ImpactOptions,
  ImpactSuggestion,
  ImpactSuggestionConfidence,
} from "./types.js";

type ReferenceCandidate = {
  name: string;
  range: Range;
};

type ExportLookup = {
  exportNamesByFile: Map<FileId, Set<string>>;
  filesByExportName: Map<string, Set<FileId>>;
};

// Symbol names that are so generic they should be treated with lower confidence.
const COMMON_SYMBOLS = new Set<string>([
  "default",
  "index",
  "utils",
  "util",
  "config",
  "configs",
  "constants",
  "consts",
  "helper",
  "helpers",
  "common",
  "shared",
  "data",
  "handler",
  "handlers",
]);

export async function collectImpactSuggestions(
  index: ProjectIndex,
  projectRoot: string,
  diffFiles: FileChange[],
  options: Partial<ImpactOptions>,
): Promise<ImpactSuggestion[]> {
  const maxSuggestions = options.maxSuggestions;
  const output: ImpactSuggestion[] = [];
  const seen = new Set<string>();
  const exportLookup = buildExportLookup(index);

  for (const fileChange of diffFiles) {
    if (maxSuggestions !== undefined && output.length >= maxSuggestions) break;

    const absoluteFile = resolveFilePath(projectRoot, fileChange.path);
    const reportFile = toProjectRelative(projectRoot, absoluteFile);
    const mod = index.byFile.get(absoluteFile);
    const importedLocals = collectImportedLocals(mod);
    const importedFiles = collectImportedFiles(mod);
    const missingExportSuggestions = collectMissingExportSuggestions(
      mod,
      exportLookup,
      reportFile,
      projectRoot,
      importedFiles,
    );

    for (const suggestion of missingExportSuggestions) {
      if (maxSuggestions !== undefined && output.length >= maxSuggestions) break;
      pushUniqueSuggestion(output, seen, suggestion);
    }

    const parsedEntry = index.parsed?.get(absoluteFile);
    if (!parsedEntry) continue;

    const changedLines = collectChangedLines(fileChange.hunks);
    const candidates = collectReferenceCandidates(
      parsedEntry.tree,
      parsedEntry.source,
      parsedEntry.sup,
      changedLines,
    );

    for (const candidate of candidates) {
      if (maxSuggestions !== undefined && output.length >= maxSuggestions) break;
      if (importedLocals.has(candidate.name)) continue;
      if (mod && mod.locals.some((local) => local.localName === candidate.name))
        continue;

      const result = await goToDefinition(index, {
        file: absoluteFile,
        line: candidate.range.start.line,
        column: candidate.range.start.column,
      });

      if (result.status === "ok") continue;

      const exportCandidates =
        exportLookup.filesByExportName.get(candidate.name) ?? new Set<FileId>();
      const filteredCandidates = [...exportCandidates].filter(
        (file) => file !== absoluteFile,
      );

      if (filteredCandidates.length > 0) {
        const relatedFile = selectBestCandidateFile(
          index,
          absoluteFile,
          filteredCandidates,
        );
        const confidence = determineSuggestionConfidence({
          symbol: candidate.name,
          exportCandidateCount: filteredCandidates.length,
          importedCandidate: importedFiles.has(relatedFile),
        });
        pushUniqueSuggestion(output, seen, {
          file: reportFile,
          range: candidate.range,
          kind: "missingImport",
          symbol: candidate.name,
          relatedFile: toProjectRelative(projectRoot, relatedFile),
          details: `No import found for ${candidate.name}.`,
          confidence,
        });
        continue;
      }

      const confidence = determineSuggestionConfidence({
        symbol: candidate.name,
        exportCandidateCount: 0,
        importedCandidate: false,
      });
      pushUniqueSuggestion(output, seen, {
        file: reportFile,
        range: candidate.range,
        kind: "missingDeclaration",
        symbol: candidate.name,
        details: `No declaration found for ${candidate.name}.`,
        confidence,
      });
    }
  }

  return output;
}

function buildExportLookup(index: ProjectIndex): ExportLookup {
  const exportNamesByFile = new Map<FileId, Set<string>>();
  const filesByExportName = new Map<string, Set<FileId>>();

  for (const [file, mod] of index.byFile) {
    const names = collectExportNames(mod);
    exportNamesByFile.set(file, names);
    for (const name of names) {
      const existing = filesByExportName.get(name) ?? new Set<FileId>();
      existing.add(file);
      filesByExportName.set(name, existing);
    }
  }

  return { exportNamesByFile, filesByExportName };
}

function collectExportNames(mod: ModuleIndex): Set<string> {
  const names = new Set<string>();
  for (const entry of mod.exports) {
    const exportedName = getExportedName(entry);
    if (exportedName) names.add(exportedName);
  }
  return names;
}

function getExportedName(entry: ExportEntry): string | null {
  if (
    entry.type === "local" ||
    entry.type === "reexport" ||
    entry.type === "namespaceReexport"
  )
    return entry.exportedAs;
  return null;
}

function collectImportedLocals(mod?: ModuleIndex): Set<string> {
  const locals = new Set<string>();
  if (!mod) return locals;
  for (const binding of mod.imports) {
    const local = getImportLocal(binding);
    if (local) locals.add(local);
  }
  return locals;
}

function getImportLocal(binding: ImportBinding): string | null {
  if (binding.kind === "namespace") return binding.localNS;
  if (binding.kind === "default" || binding.kind === "named")
    return binding.local;
  return null;
}

function collectImportedFiles(mod?: ModuleIndex): Set<FileId> {
  const files = new Set<FileId>();
  if (!mod) return files;
  for (const binding of mod.imports) {
    if (binding.resolved && typeof binding.resolved === "string") {
      files.add(binding.resolved);
    }
  }
  return files;
}

function determineSuggestionConfidence({
  symbol,
  exportCandidateCount,
  importedCandidate,
}: {
  symbol?: string;
  exportCandidateCount: number;
  importedCandidate: boolean;
}): ImpactSuggestionConfidence {
  if (symbol && isCommonSymbolName(symbol)) return "low";
  if (exportCandidateCount >= 3) return "low";
  if (exportCandidateCount === 1 && importedCandidate) return "high";
  return "medium";
}

function isCommonSymbolName(symbol: string): boolean {
  return COMMON_SYMBOLS.has(symbol);
}

function collectMissingExportSuggestions(
  mod: ModuleIndex | undefined,
  lookup: ExportLookup,
  reportFile: FileId,
  projectRoot: string,
  importedFiles: Set<FileId>,
): ImpactSuggestion[] {
  if (!mod) return [];
  const suggestions: ImpactSuggestion[] = [];

  for (const binding of mod.imports) {
    if (!binding.resolved) continue;
    if (typeof binding.resolved !== "string") continue;

    const exportedNames = lookup.exportNamesByFile.get(binding.resolved);
    if (!exportedNames) continue;

    if (binding.kind === "named") {
      if (!exportedNames.has(binding.imported)) {
        const exportCandidates =
          lookup.filesByExportName.get(binding.imported) ?? new Set<FileId>();
        const candidateList = [...exportCandidates];
        const singleCandidate =
          candidateList.length === 1 ? candidateList[0] : undefined;
        const confidence = determineSuggestionConfidence({
          symbol: binding.imported,
          exportCandidateCount: candidateList.length,
          importedCandidate:
            singleCandidate !== undefined && importedFiles.has(singleCandidate),
        });
        suggestions.push({
          file: reportFile,
          kind: "missingExport",
          symbol: binding.imported,
          relatedFile: toProjectRelative(projectRoot, binding.resolved),
          details: `Export ${binding.imported} not found in ${binding.resolved}.`,
          confidence,
        });
      }
      continue;
    }

    if (binding.kind === "default") {
      if (!exportedNames.has("default")) {
        const exportCandidates =
          lookup.filesByExportName.get("default") ?? new Set<FileId>();
        const candidateList = [...exportCandidates];
        const singleCandidate =
          candidateList.length === 1 ? candidateList[0] : undefined;
        const confidence = determineSuggestionConfidence({
          symbol: "default",
          exportCandidateCount: candidateList.length,
          importedCandidate:
            singleCandidate !== undefined && importedFiles.has(singleCandidate),
        });
        suggestions.push({
          file: reportFile,
          kind: "missingExport",
          symbol: "default",
          relatedFile: toProjectRelative(projectRoot, binding.resolved),
          details: `Default export not found in ${binding.resolved}.`,
          confidence,
        });
      }
    }
  }

  return suggestions;
}

function selectBestCandidateFile(
  index: ProjectIndex,
  sourceFile: FileId,
  candidates: FileId[],
): FileId {
  if (candidates.length === 0) {
    throw new Error("selectBestCandidateFile called with no candidates");
  }
  const directImports = new Set<FileId>();
  for (const edge of index.graph.edges) {
    if (edge.from !== sourceFile) continue;
    if (edge.to.type === "file") directImports.add(edge.to.path);
  }
  for (const candidate of candidates) {
    if (directImports.has(candidate)) return candidate;
  }
  const sorted = candidates.slice().sort();
  const fallback = sorted[0];
  if (!fallback) {
    throw new Error("selectBestCandidateFile could not resolve a fallback");
  }
  return fallback;
}

function collectReferenceCandidates(
  tree: Parser.Tree,
  source: string,
  sup: LanguageSupport,
  changedLines: Set<number>,
): ReferenceCandidate[] {
  const candidates: ReferenceCandidate[] = [];
  const propertyIdentifiers = new Set<string>(
    sup.nodeTypes.propertyIdentifier ?? [],
  );
  const shorthandPropertyIdentifiers = new Set<string>(
    sup.nodeTypes.shorthandPropertyIdentifier ?? [],
  );

  const walk = (node: Parser.SyntaxNode) => {
    if (!node) return;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    if (!rangeIntersectsLines(startLine, endLine, changedLines)) return;

    if (sup.nodeTypes.identifier.includes(node.type)) {
      if (!sup.isDeclarationName(node) && !isInImportOrExport(node)) {
        const isPropertyIdentifier = propertyIdentifiers.has(node.type);
        const isShorthandPropertyIdentifier =
          shorthandPropertyIdentifiers.has(node.type);
        if (!isPropertyIdentifier && !isShorthandPropertyIdentifier) {
          candidates.push({
            name: source.slice(node.startIndex, node.endIndex),
            range: toRange(node),
          });
        }
      }
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  };

  walk(tree.rootNode);
  return candidates;
}

function rangeIntersectsLines(
  startLine: number,
  endLine: number,
  changedLines: Set<number>,
): boolean {
  for (let line = startLine; line <= endLine; line++) {
    if (changedLines.has(line)) return true;
  }
  return false;
}

function isInImportOrExport(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    const type = current.type;
    if (type.startsWith("import") || type.startsWith("export")) return true;
    current = current.parent;
  }
  return false;
}

function collectChangedLines(hunks: FileChange["hunks"]): Set<number> {
  const changedLines = new Set<number>();
  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith(" ")) {
        oldLine++;
        newLine++;
      } else if (line.startsWith("+")) {
        changedLines.add(newLine);
        newLine++;
      } else if (line.startsWith("-")) {
        const mappedLine = newLine;
        changedLines.add(mappedLine);
        oldLine++;
      }
    }
  }
  return changedLines;
}

function resolveFilePath(projectRoot: string, file: FileId): FileId {
  if (path.isAbsolute(file)) return normalizeFilePath(file);
  return normalizeFilePath(path.resolve(projectRoot, file));
}

function normalizeFilePath(file: FileId): FileId {
  return file.replace(/\\/g, "/");
}

function toProjectRelative(projectRoot: string, file: FileId): FileId {
  const normalized = normalizeFilePath(file);
  if (!path.isAbsolute(normalized)) return normalized;
  const rel = path.relative(projectRoot, normalized).replace(/\\/g, "/");
  return rel.length > 0 ? rel : normalized;
}

function pushUniqueSuggestion(
  output: ImpactSuggestion[],
  seen: Set<string>,
  suggestion: ImpactSuggestion,
): void {
  const range = suggestion.range?.start;
  const rangeKey = range ? `${range.line}:${range.column}` : "no-range";
  const keyParts = [
    suggestion.file,
    suggestion.kind,
    suggestion.symbol ?? "",
    suggestion.relatedFile ?? "",
    rangeKey,
  ];
  const key = keyParts.join("|");
  if (seen.has(key)) return;
  seen.add(key);
  output.push(suggestion);
}

function toRange(node: Parser.SyntaxNode): Range {
  return {
    start: {
      line: node.startPosition.row + 1,
      column: node.startPosition.column + 1,
      index: node.startIndex,
    },
    end: {
      line: node.endPosition.row + 1,
      column: node.endPosition.column + 1,
      index: node.endIndex,
    },
  };
}
