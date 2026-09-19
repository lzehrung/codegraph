import { supportForFileWithoutHeaderSample, type LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { FileId, Range } from "../types.js";
import { fileIdentityKey } from "../util/paths.js";
import { sliceText, toRange } from "../util/ast.js";
import { ensureParsedContext, type ParsedFileContext } from "./parse-context.js";
import { sameDef } from "./reference-context.js";
import { readPhpNamespaceFromRange } from "./navigation-php.js";
import { candidateFilesImportingTarget } from "./reference-candidates.js";
import { buildScopeIndexFromSource, type ScopeIndex } from "./scope.js";
import { resolveExport, resolveImported } from "./navigation-resolve.js";
import type {
  ExportEntry,
  ImportBindingRole,
  ModuleIndex,
  ProjectIndex,
  ReferenceCoverage,
  ReferenceCoverageReason,
  ResolutionProvenance,
  SymbolDef,
} from "./types.js";
import type { ImportBinding } from "./import-types.js";
import { ECMASCRIPT_IDENTIFIER_SOURCE } from "../util/identifiers.js";

const EXPORT_FROM_PATTERN = new RegExp(String.raw`\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(["'])([^"']+)\2`, "gu");
const NAMESPACE_EXPORT_PATTERN = new RegExp(
  String.raw`\bexport\s*\*\s*as\s*(${ECMASCRIPT_IDENTIFIER_SOURCE})\s*from\s*(["'])([^"']+)\2`,
  "gu",
);
const EXPORT_FROM_SPECIFIER_PATTERN = new RegExp(String.raw`^(${ECMASCRIPT_IDENTIFIER_SOURCE})`, "u");

type ReexportEntry = Extract<ExportEntry, { type: "reexport" }>;

type ExportFromIdentifier = {
  isExportFrom: boolean;
  sourceSpecifier?: string;
  entry?: ReexportEntry;
};

export function exportFromIdentifier(
  index: ProjectIndex,
  fileId: string,
  range: Range,
  parsed: ParsedFileContext,
): ExportFromIdentifier | null {
  if (!parsed.sup.supportsExportFromReferences) return null;
  const startIndex = range.start.index;
  if (typeof startIndex !== "number") return null;
  const moduleIndex = index.byFile.get(fileIdentityKey(fileId));
  if (!moduleIndex) return null;

  EXPORT_FROM_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPORT_FROM_PATTERN.exec(parsed.source))) {
    const listText = match[1]!;
    const listOffset = match[0].indexOf(listText);
    if (listOffset < 0) continue;
    const listStart = match.index + listOffset;
    let itemOffset = 0;
    for (const item of listText.split(",")) {
      const leadingWhitespace = item.search(/\S/);
      if (leadingWhitespace < 0) {
        itemOffset += item.length + 1;
        continue;
      }
      const itemText = item.trim();
      const itemStart = listStart + itemOffset + leadingWhitespace;
      const itemEnd = itemStart + itemText.length;
      if (startIndex < itemStart || startIndex >= itemEnd) {
        itemOffset += item.length + 1;
        continue;
      }

      const sourceMatch = EXPORT_FROM_SPECIFIER_PATTERN.exec(itemText);
      if (!sourceMatch) return { isExportFrom: true };
      const sourceSpecifier = sourceMatch[1]!;
      const sourceEnd = itemStart + sourceSpecifier.length;
      if (startIndex >= sourceEnd) return { isExportFrom: true };
      const fromSpecifier = match[3]!;
      const matchingEntries = moduleIndex.exports.filter(
        (candidate): candidate is ReexportEntry =>
          candidate.type === "reexport" && candidate.sourceSpecifier === sourceSpecifier,
      );
      const entry =
        matchingEntries.find(
          (candidate) => candidate.moduleSpecifier === fromSpecifier || candidate.fromModule === fromSpecifier,
        ) ?? (matchingEntries.length === 1 ? matchingEntries[0] : undefined);
      return { isExportFrom: true, sourceSpecifier, ...(entry ? { entry } : {}) };
    }
    itemOffset += listText.length + 1;
  }
  NAMESPACE_EXPORT_PATTERN.lastIndex = 0;
  while ((match = NAMESPACE_EXPORT_PATTERN.exec(parsed.source))) {
    const namespace = match[1]!;
    const namespaceStart = match.index + match[0].indexOf(namespace);
    if (startIndex >= namespaceStart && startIndex < namespaceStart + namespace.length) {
      return { isExportFrom: true };
    }
  }
  return null;
}

export function getCachedScope(
  index: ProjectIndex,
  fileId: string,
  moduleIndex: ModuleIndex,
  parsedCtx: {
    source: string;
    sup: LanguageSupport;
    tree: SyntaxTreeLike;
  },
): ScopeIndex {
  const fileKey = fileIdentityKey(fileId);
  const cachedScope = index.scopeCache.get(fileKey);
  if (cachedScope) {
    for (const binding of cachedScope.all) {
      binding.occurrences = binding.occurrences.filter(
        (occurrence) => !exportFromIdentifier(index, fileId, occurrence, parsedCtx)?.isExportFrom,
      );
    }
    return cachedScope;
  }
  const scopeIndex = buildScopeIndexFromSource(fileId, parsedCtx.source, parsedCtx.sup, moduleIndex.imports, {
    tree: parsedCtx.tree,
  });
  for (const binding of scopeIndex.all) {
    binding.occurrences = binding.occurrences.filter(
      (occurrence) => !exportFromIdentifier(index, fileId, occurrence, parsedCtx)?.isExportFrom,
    );
  }
  index.scopeCache.set(fileKey, scopeIndex);
  return scopeIndex;
}
export async function buildPhpQualifiedNames(
  index: ProjectIndex,
  definitionFile: string,
  def: SymbolDef,
): Promise<string[]> {
  try {
    const definitionParsed = await ensureParsedContext(
      definitionFile,
      index.parsed?.get(fileIdentityKey(definitionFile)),
      index.languageExtensions,
    );
    if (definitionParsed.sup.id !== "php") {
      return [];
    }
    const phpNamespace = readPhpNamespaceFromRange(definitionParsed.tree, definitionParsed.source, def.range);
    if (!phpNamespace) return [];
    const qualifiedName = `${phpNamespace}\\${def.localName}`;
    return [qualifiedName, `\\${qualifiedName}`];
  } catch {
    return [];
  }
}

async function collectNamedNodeReferences(
  index: ProjectIndex,
  fileId: string,
  symbolName: string,
): Promise<{ ranges: Range[]; parsed: ParsedFileContext } | null> {
  try {
    const parsedEntry = index.parsed?.get(fileIdentityKey(fileId));
    const parsed = await ensureParsedContext(fileId, parsedEntry, index.languageExtensions);
    const identifierTypes = new Set<string>([
      ...parsed.sup.nodeTypes.identifier,
      ...(parsed.sup.nodeTypes.propertyIdentifier ?? []),
      "constant",
      "type_identifier",
      "field_identifier",
    ]);
    const canonicalSymbolName = parsed.sup.normalizeIdentifier(symbolName);
    const ranges: Range[] = [];
    const moduleIndex = index.byFile.get(fileIdentityKey(fileId));
    const importDeclarationKeys = importBindingDeclarationRangeKeys(moduleIndex);
    const walk = (node: SyntaxNodeLike): void => {
      if (
        identifierTypes.has(node.type) &&
        parsed.sup.normalizeIdentifier(sliceText(node, parsed.source)) === canonicalSymbolName
      ) {
        const range = toRange(node);
        if (!importDeclarationKeys.has(rangeIdentityKey(range))) {
          ranges.push(range);
        }
      }
      for (const child of node.namedChildren) {
        walk(child);
      }
    };
    walk(parsed.tree.rootNode);
    return { ranges, parsed };
  } catch {
    return null;
  }
}

export type VerifiedNamedNodeReference = {
  range: Range;
  provenance?: ResolutionProvenance;
  via?: { reexport: true };
};

export async function collectVerifiedNamedNodeReferences(
  index: ProjectIndex,
  fileId: string,
  symbolName: string,
  expectedDef: SymbolDef,
  resolveDefinition: (
    params: {
      file: string;
      line: number;
      column: number;
    },
    parsed: ParsedFileContext,
  ) => Promise<{ status: string; definition?: SymbolDef; provenance?: ResolutionProvenance }>,
  maxVerified?: number,
  includeReference?: (reference: VerifiedNamedNodeReference) => boolean,
): Promise<VerifiedNamedNodeReference[]> {
  const collected = await collectNamedNodeReferences(index, fileId, symbolName);
  if (!collected) return [];
  const { ranges, parsed } = collected;
  const verified: VerifiedNamedNodeReference[] = [];
  const pushVerified = (reference: VerifiedNamedNodeReference): void => {
    if (!includeReference || includeReference(reference)) verified.push(reference);
  };
  for (const range of ranges) {
    if (maxVerified !== undefined && maxVerified > 0 && verified.length >= maxVerified) {
      break;
    }
    const exportFrom = exportFromIdentifier(index, fileId, range, parsed);
    if (exportFrom?.entry) {
      const reexported = resolveExport(index, exportFrom.entry.fromModule, exportFrom.entry.sourceSpecifier);
      if (reexported?.kind === "resolved") {
        if (sameDef(reexported.def, expectedDef, index.languageExtensions)) {
          pushVerified({ range, via: { reexport: true } });
        }
        continue;
      }
    }
    const resolved = await resolveDefinition(
      {
        file: fileId,
        line: range.start.line,
        column: range.start.column,
      },
      parsed,
    );
    if (resolved.status !== "ok" || !resolved.definition) continue;
    if (sameDef(resolved.definition, expectedDef, index.languageExtensions)) {
      pushVerified({
        range,
        ...(exportFrom?.isExportFrom ? { via: { reexport: true } } : {}),
        ...(resolved.provenance ? { provenance: resolved.provenance } : {}),
      });
    }
  }
  return verified;
}

export function getCandidateReferenceNames(
  moduleIndex: ModuleIndex,
  definitionFile: string,
  exportedNameSet: Set<string>,
): string[] {
  const names = new Set<string>();
  let hasDirectImport = false;

  for (const imp of moduleIndex.imports) {
    const resolved = typeof imp.resolved === "string" ? imp.resolved : undefined;
    if (!resolved || fileIdentityKey(resolved) !== fileIdentityKey(definitionFile)) continue;
    hasDirectImport = true;

    if (imp.kind === "named") {
      if (exportedNameSet.has(imp.imported)) names.add(imp.local);
    } else if (imp.kind === "default") {
      if (exportedNameSet.has("default")) names.add(imp.local);
    } else if (imp.kind === "namespace" || imp.kind === "star") {
      for (const name of exportedNameSet) {
        names.add(name);
      }
    }
  }

  if (!hasDirectImport) return [];
  return Array.from(names);
}

export function hasExpandedNamedImport(moduleIndex: ModuleIndex, targetFile: string, symbolName: string): boolean {
  const targetKey = fileIdentityKey(targetFile);
  return moduleIndex.imports.some(
    (candidate) =>
      candidate.kind === "named" &&
      candidate.local === symbolName &&
      candidate.imported === symbolName &&
      typeof candidate.resolved === "string" &&
      fileIdentityKey(candidate.resolved) === targetKey,
  );
}

const referenceCandidateCache = new WeakMap<ProjectIndex, Map<string, string[]>>();

function referenceCandidateCacheKey(index: ProjectIndex, def: SymbolDef, exportedNames: readonly string[]): string {
  const normalizeIdentifier =
    supportForFileWithoutHeaderSample(def.file, index.languageExtensions)?.normalizeIdentifier ?? ((name) => name);
  const sortedNames = exportedNames.map(normalizeIdentifier).sort();
  return `${fileIdentityKey(def.file)}::${def.range.start.index ?? 0}::canonical::${sortedNames.join("\0")}`;
}

function importCanReferenceDefinition(
  index: ProjectIndex,
  imp: ImportBinding,
  def: SymbolDef,
  exportedNames: readonly string[],
): boolean {
  const targetFile = typeof imp.resolved === "string" ? imp.resolved : undefined;
  if (!targetFile) return false;

  const resolvesToDefinition = (exportedName: string): boolean => {
    const hit = resolveExport(index, targetFile, exportedName);
    if (hit?.kind === "resolved") {
      return sameDef(hit.def, def, index.languageExtensions);
    }
    return imp.kind === "namespace" && fileIdentityKey(targetFile) === fileIdentityKey(def.file);
  };

  if (imp.kind === "named") {
    return resolvesToDefinition(imp.imported);
  }
  if (imp.kind === "default") {
    return resolvesToDefinition("default");
  }
  if (imp.kind === "star") {
    return exportedNames.some((exportedName) => {
      const result = resolveImported(index, imp, exportedName);
      return !!result && !("namespace" in result) && sameDef(result, def, index.languageExtensions);
    });
  }
  return exportedNames.some((exportedName) => resolvesToDefinition(exportedName));
}

function moduleExportProbeNames(
  index: ProjectIndex,
  moduleIndex: ModuleIndex,
  exportedNames: readonly string[],
  visited: ReadonlySet<string> = new Set(),
): string[] {
  const names = new Set(exportedNames);
  const nextVisited = new Set([...visited, fileIdentityKey(moduleIndex.file)]);
  for (const entry of moduleIndex.exports) {
    if (entry.type === "reexport" || entry.type === "namespaceReexport") {
      names.add(entry.exportedAs);
      continue;
    }
    if (entry.type === "exportStar") {
      const targetModule = index.byFile.get(fileIdentityKey(entry.fromModule));
      if (!targetModule || nextVisited.has(fileIdentityKey(targetModule.file))) continue;
      for (const exportedName of moduleExportProbeNames(index, targetModule, exportedNames, nextVisited)) {
        names.add(exportedName);
      }
    }
  }
  return [...names];
}

function filesExportingDefinition(index: ProjectIndex, def: SymbolDef, exportedNames: readonly string[]): string[] {
  const files = new Map<string, string>([[fileIdentityKey(def.file), def.file]]);
  for (const moduleIndex of index.byFile.values()) {
    const fileId = moduleIndex.file;
    if (fileIdentityKey(fileId) === fileIdentityKey(def.file) || !moduleIndex.exports.length) continue;
    for (const exportedName of moduleExportProbeNames(index, moduleIndex, exportedNames)) {
      const resolved = resolveExport(index, fileId, exportedName);
      if (resolved?.kind === "resolved" && sameDef(resolved.def, def, index.languageExtensions)) {
        files.set(fileIdentityKey(fileId), fileId);
        break;
      }
    }
    if (
      moduleIndex.exports.some(
        (entry) =>
          entry.type === "reexport" &&
          exportedNames.includes(entry.sourceSpecifier) &&
          resolveExport(index, entry.fromModule, entry.sourceSpecifier)?.kind !== "resolved",
      )
    ) {
      files.set(fileIdentityKey(fileId), fileId);
    }
  }
  return [...files.values()];
}

function getIndexedReferenceCandidateFiles(
  index: ProjectIndex,
  def: SymbolDef,
  exportedNames: readonly string[],
): readonly string[] | undefined {
  if (def.file.toLowerCase().endsWith(".php")) return undefined;
  if (!index.referenceCandidates) return undefined;
  const files = new Map<string, string>();
  for (const exportingFile of filesExportingDefinition(index, def, exportedNames)) {
    for (const importingFile of candidateFilesImportingTarget(index.referenceCandidates, exportingFile) ?? []) {
      files.set(fileIdentityKey(importingFile), importingFile);
    }
  }
  for (const moduleIndex of index.byFile.values()) {
    const fileId = moduleIndex.file;
    if (fileIdentityKey(fileId) === fileIdentityKey(def.file) || files.has(fileIdentityKey(fileId))) continue;
    if (
      moduleIndex.imports.some(
        (imp) =>
          (imp.kind === "star" || imp.kind === "namespace") &&
          importCanReferenceDefinition(index, imp, def, exportedNames),
      )
    ) {
      files.set(fileIdentityKey(fileId), fileId);
    }
  }
  return [...files.values()].sort((left, right) => left.localeCompare(right));
}

export function getCachedReferenceCandidateFiles(
  index: ProjectIndex,
  def: SymbolDef,
  exportedNames: readonly string[],
  hasGlobalNameReferences: boolean,
): string[] {
  if (hasGlobalNameReferences) {
    return Array.from(index.byFile.values(), (module) => module.file).sort((left, right) => left.localeCompare(right));
  }

  let cache = referenceCandidateCache.get(index);
  if (!cache) {
    cache = new Map();
    referenceCandidateCache.set(index, cache);
  }

  const key = referenceCandidateCacheKey(index, def, exportedNames);
  const cached = cache.get(key);
  if (cached) return cached;

  const candidates = new Map<string, string>();
  const candidateFileEntries =
    getIndexedReferenceCandidateFiles(index, def, exportedNames) ??
    Array.from(index.byFile.values(), (module) => module.file);
  const exportingFileIds = filesExportingDefinition(index, def, exportedNames);
  const exportingFiles = new Set(exportingFileIds.map((file) => fileIdentityKey(file)));
  for (const fileId of exportingFileIds) {
    if (fileIdentityKey(fileId) !== fileIdentityKey(def.file)) {
      candidates.set(fileIdentityKey(fileId), fileId);
    }
  }
  for (const fileId of candidateFileEntries) {
    if (fileIdentityKey(fileId) === fileIdentityKey(def.file)) continue;
    const moduleIndex = index.byFile.get(fileIdentityKey(fileId));
    if (!moduleIndex) continue;
    if (
      moduleIndex.imports.some((imp) => {
        if (typeof imp.resolved !== "string") return false;
        return (
          exportingFiles.has(fileIdentityKey(imp.resolved)) ||
          importCanReferenceDefinition(index, imp, def, exportedNames)
        );
      })
    ) {
      candidates.set(fileIdentityKey(fileId), fileId);
    }
  }

  const sorted = [...candidates.values()].sort((left, right) => left.localeCompare(right));
  cache.set(key, sorted);
  return sorted;
}

const COVERAGE_REASON_ORDER: ReferenceCoverageReason[] = ["parser_degraded", "unresolved_import", "truncated"];

type ImportBindingRanges = {
  importedRange: Range | undefined;
  localRange: Range | undefined;
};

export function rangeIdentityKey(range: Range): string {
  return `${range.start.line}:${range.start.column}:${range.start.index ?? ""}:${range.end.line}:${range.end.column}:${range.end.index ?? ""}`;
}

export function referenceSiteKey(file: string, range: Range): string {
  return `${fileIdentityKey(file)}:${rangeIdentityKey(range)}`;
}

export function rangesEqual(left: Range | undefined, right: Range | undefined): boolean {
  if (!left || !right) return false;
  return rangeIdentityKey(left) === rangeIdentityKey(right);
}

function bindingTokenRanges(imp: ImportBinding): ImportBindingRanges {
  if (imp.kind === "named") {
    return { importedRange: imp.importedRange, localRange: imp.localRange };
  }
  if (imp.kind === "default" || imp.kind === "namespace") {
    return { importedRange: undefined, localRange: imp.localRange };
  }
  return { importedRange: undefined, localRange: undefined };
}

export function importBindingReferenceSites(
  imp: ImportBinding,
): Array<{ range: Range; importBinding: ImportBindingRole }> {
  const sites: Array<{ range: Range; importBinding: ImportBindingRole }> = [];
  if (imp.kind === "named") {
    const { importedRange, localRange } = bindingTokenRanges(imp);
    if (importedRange) {
      sites.push({ range: importedRange, importBinding: "imported" });
    } else if (localRange && imp.local === imp.imported) {
      sites.push({ range: localRange, importBinding: "imported" });
    }
    if (localRange && !rangesEqual(localRange, importedRange)) {
      sites.push({ range: localRange, importBinding: "local" });
    }
  } else if (imp.kind === "default") {
    const { localRange } = bindingTokenRanges(imp);
    if (localRange) {
      sites.push({ range: localRange, importBinding: "local" });
    }
  }
  return sites;
}

export function importBindingIdentityVerificationSites(
  imp: ImportBinding,
): Array<{ range: Range; importBinding: ImportBindingRole }> {
  const sites = importBindingReferenceSites(imp);
  if (imp.kind !== "named" || imp.local === imp.imported) {
    return sites;
  }
  const localSites = sites.filter((site) => site.importBinding === "local");
  return localSites.length > 0 ? localSites : sites;
}

export function importBindingDeclarationRangeKeys(moduleIndex: ModuleIndex | undefined): Set<string> {
  const keys = new Set<string>();
  if (!moduleIndex) return keys;
  for (const imp of moduleIndex.imports) {
    const { importedRange, localRange } = bindingTokenRanges(imp);
    if (importedRange) keys.add(rangeIdentityKey(importedRange));
    if (localRange) keys.add(rangeIdentityKey(localRange));
  }
  return keys;
}

function structurallyExportsDefinition(
  index: ProjectIndex,
  moduleFile: string,
  exportedName: string,
  def: SymbolDef,
  definitionExportedNames: readonly string[],
  visited: Set<string> = new Set(),
): boolean {
  const normalizeIdentifier =
    supportForFileWithoutHeaderSample(moduleFile, index.languageExtensions)?.normalizeIdentifier ?? ((name) => name);
  const canonicalName = normalizeIdentifier(exportedName);
  const fileKey = fileIdentityKey(moduleFile);
  const visitKey = `${fileKey}::${canonicalName}`;
  if (visited.has(visitKey)) return false;
  visited.add(visitKey);
  if (
    fileKey === fileIdentityKey(def.file) &&
    definitionExportedNames.some((name) => normalizeIdentifier(name) === canonicalName)
  ) {
    return true;
  }
  const moduleIndex = index.byFile.get(fileKey);
  if (!moduleIndex) return false;
  for (const entry of moduleIndex.exports) {
    if (entry.type === "local") {
      if (
        normalizeIdentifier(entry.exportedAs) === canonicalName &&
        sameDef(entry.target, def, index.languageExtensions)
      ) {
        return true;
      }
      continue;
    }
    if (entry.type === "reexport" && normalizeIdentifier(entry.exportedAs) === canonicalName) {
      if (
        structurallyExportsDefinition(
          index,
          entry.fromModule,
          entry.sourceSpecifier || exportedName,
          def,
          definitionExportedNames,
          visited,
        )
      ) {
        return true;
      }
    } else if (
      entry.type === "exportStar" &&
      structurallyExportsDefinition(index, entry.fromModule, exportedName, def, definitionExportedNames, visited)
    ) {
      return true;
    }
  }
  return false;
}

function isUnresolvedIndexedImport(
  index: ProjectIndex,
  imp: ImportBinding,
  def: SymbolDef,
  exportedNames: readonly string[],
): boolean {
  if (typeof imp.resolved !== "string") return false;
  let importedName: string;
  if (imp.kind === "named") importedName = imp.imported;
  else if (imp.kind === "default") importedName = "default";
  else return false;
  if (!structurallyExportsDefinition(index, imp.resolved, importedName, def, exportedNames)) return false;
  return !importCanReferenceDefinition(index, imp, def, exportedNames);
}

function parserDegradedCandidateFiles(
  index: ProjectIndex,
  scannedFiles: readonly string[],
): { files: FileId[]; hasUnlistedCandidate: boolean } {
  const report = index.buildReport?.backend?.parser;
  if (!report) return { files: [], hasUnlistedCandidate: false };
  const scanned = new Set(scannedFiles.map((file) => fileIdentityKey(file)));
  const listed = new Set(report.files.map((entry) => fileIdentityKey(entry.file)));
  const affected: FileId[] = [];
  const seen = new Set<string>();
  for (const entry of report.files) {
    const key = fileIdentityKey(entry.file);
    if (!scanned.has(key) || seen.has(key)) continue;
    seen.add(key);
    affected.push(entry.file);
  }
  let hasUnlistedCandidate = false;
  if (report.total > report.files.length) {
    for (const fileKey of scanned) {
      if (listed.has(fileKey)) continue;
      hasUnlistedCandidate = true;
      break;
    }
  }
  return { files: affected, hasUnlistedCandidate };
}

export function buildIndexedCandidateCoverage(args: {
  index: ProjectIndex;
  def: SymbolDef;
  exportedNames: readonly string[];
  candidateFiles: readonly string[];
  scannedFiles: readonly string[];
  truncated: boolean;
}): ReferenceCoverage {
  const { index, def, exportedNames, candidateFiles, scannedFiles, truncated } = args;
  const reasons: ReferenceCoverageReason[] = [];
  const affectedFiles: FileId[] = [];
  const affectedSeen = new Set<string>();
  const addAffected = (file: FileId): void => {
    const key = fileIdentityKey(file);
    if (affectedSeen.has(key)) return;
    affectedSeen.add(key);
    affectedFiles.push(file);
  };

  const degraded = parserDegradedCandidateFiles(index, scannedFiles);
  if (degraded.files.length || degraded.hasUnlistedCandidate) {
    reasons.push("parser_degraded");
    for (const file of degraded.files) addAffected(file);
  }

  const unresolvedFiles: FileId[] = [];
  for (const fileId of candidateFiles) {
    const moduleIndex = index.byFile.get(fileIdentityKey(fileId));
    if (!moduleIndex) continue;
    if (moduleIndex.imports.some((imp) => isUnresolvedIndexedImport(index, imp, def, exportedNames))) {
      unresolvedFiles.push(fileId);
    }
  }
  if (unresolvedFiles.length) {
    reasons.push("unresolved_import");
    for (const file of unresolvedFiles) addAffected(file);
  }

  if (truncated) reasons.push("truncated");

  if (!reasons.length) {
    return { scope: "indexed_candidates", state: "complete" };
  }
  return {
    scope: "indexed_candidates",
    state: "partial",
    reasons: COVERAGE_REASON_ORDER.filter((reason) => reasons.includes(reason)),
    ...(affectedFiles.length ? { affectedFiles } : {}),
  };
}
