import type { LanguageSupport } from "../languages.js";
import { isJsTsLanguage } from "../languages/js-family.js";
import type { ParserLanguage, SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import { fileIdentityKey } from "../util/paths.js";
import { sliceText, toRange } from "../util/ast.js";
import { ensureParsedContext, type ParsedFileContext } from "./parse-context.js";
import { sameDef } from "./reference-context.js";
import { readPhpNamespaceFromRange } from "./navigation-php.js";
import { candidateFilesImportingTarget } from "./reference-candidates.js";
import { buildScopeIndexFromSource, type ScopeIndex } from "./scope.js";
import { resolveExport, resolveImported } from "./navigation-resolve.js";
import type { ExportEntry, ModuleIndex, ProjectIndex, ResolutionProvenance, SymbolDef } from "./types.js";
import type { ImportBinding } from "./import-types.js";

type ReexportEntry = Extract<ExportEntry, { type: "reexport" }>;

type ExportFromIdentifier = {
  isExportFrom: boolean;
  sourceSpecifier?: string;
  entry?: ReexportEntry;
};

function exportFromIdentifier(
  index: ProjectIndex,
  fileId: string,
  range: Range,
  parsed: ParsedFileContext,
): ExportFromIdentifier | null {
  if (!isJsTsLanguage(parsed.sup.id)) return null;
  const startIndex = range.start.index;
  if (typeof startIndex !== "number") return null;
  const moduleIndex = index.byFile.get(fileIdentityKey(fileId));
  if (!moduleIndex) return null;

  const exportFromPattern = /\bexport\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2/g;
  let match: RegExpExecArray | null;
  while ((match = exportFromPattern.exec(parsed.source))) {
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

      const sourceMatch = /^([A-Za-z_$][\w$]*)/.exec(itemText);
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
  return null;
}

export function getCachedScope(
  index: ProjectIndex,
  fileId: string,
  moduleIndex: ModuleIndex,
  parsedCtx: {
    source: string;
    sup: LanguageSupport;
    lang?: ParserLanguage;
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
  const scopeIndex = buildScopeIndexFromSource(
    fileId,
    parsedCtx.source,
    parsedCtx.sup,
    parsedCtx.lang,
    moduleIndex.imports,
    {
      tree: parsedCtx.tree,
    },
  );
  for (const binding of scopeIndex.all) {
    binding.occurrences = binding.occurrences.filter(
      (occurrence) => !exportFromIdentifier(index, fileId, occurrence, parsedCtx)?.isExportFrom,
    );
  }
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
    const parsed = await ensureParsedContext(fileId, parsedEntry);
    const identifierTypes = new Set<string>([
      ...parsed.sup.nodeTypes.identifier,
      ...(parsed.sup.nodeTypes.propertyIdentifier ?? []),
      "constant",
      "type_identifier",
      "field_identifier",
    ]);
    const ranges: Range[] = [];
    const walk = (node: SyntaxNodeLike): void => {
      if (identifierTypes.has(node.type) && sliceText(node, parsed.source) === symbolName) {
        ranges.push(toRange(node));
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

export type VerifiedNamedNodeReference = { range: Range; provenance?: ResolutionProvenance };

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
): Promise<VerifiedNamedNodeReference[]> {
  const collected = await collectNamedNodeReferences(index, fileId, symbolName);
  if (!collected) return [];
  const { ranges, parsed } = collected;
  const verified: VerifiedNamedNodeReference[] = [];
  for (const range of ranges) {
    if (maxVerified !== undefined && maxVerified > 0 && verified.length >= maxVerified) {
      break;
    }
    if (exportFromIdentifier(index, fileId, range, parsed)?.isExportFrom) continue;
    const resolved = await resolveDefinition(
      {
        file: fileId,
        line: range.start.line,
        column: range.start.column,
      },
      parsed,
    );
    if (resolved.status !== "ok" || !resolved.definition) continue;
    if (sameDef(resolved.definition, expectedDef)) {
      verified.push({ range, ...(resolved.provenance ? { provenance: resolved.provenance } : {}) });
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

function referenceCandidateCacheKey(def: SymbolDef, exportedNames: readonly string[]): string {
  const sortedNames = [...exportedNames].sort();
  return `${fileIdentityKey(def.file)}::${def.range.start.index ?? 0}::${sortedNames.join("\0")}`;
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
    return hit?.kind === "resolved" ? sameDef(hit.def, def) : fileIdentityKey(targetFile) === fileIdentityKey(def.file);
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
      return !!result && !("namespace" in result) && sameDef(result, def);
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
      if (resolved?.kind === "resolved" && sameDef(resolved.def, def)) {
        files.set(fileIdentityKey(fileId), fileId);
        break;
      }
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

  const key = referenceCandidateCacheKey(def, exportedNames);
  const cached = cache.get(key);
  if (cached) return cached;

  const candidates = new Map<string, string>();
  const candidateFileEntries =
    getIndexedReferenceCandidateFiles(index, def, exportedNames) ??
    Array.from(index.byFile.values(), (module) => module.file);
  for (const fileId of candidateFileEntries) {
    if (fileIdentityKey(fileId) === fileIdentityKey(def.file)) continue;
    const moduleIndex = index.byFile.get(fileIdentityKey(fileId));
    if (!moduleIndex) continue;
    if (moduleIndex.imports.some((imp) => importCanReferenceDefinition(index, imp, def, exportedNames))) {
      candidates.set(fileIdentityKey(fileId), fileId);
    }
  }

  const sorted = [...candidates.values()].sort((left, right) => left.localeCompare(right));
  cache.set(key, sorted);
  return sorted;
}
