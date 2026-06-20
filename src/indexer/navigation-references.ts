import type { LanguageSupport } from "../languages.js";
import type { ParserLanguage, SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import { sliceText, toRange } from "../util/ast.js";
import { ensureParsedContext } from "./parse-context.js";
import { sameDef } from "./reference-context.js";
import { readPhpNamespaceFromRange } from "./navigation-php.js";
import { candidateFilesImportingTarget } from "./reference-candidates.js";
import { buildScopeIndexFromSource, type ScopeIndex } from "./scope.js";
import { resolveExport, resolveImported } from "./navigation-resolve.js";
import type { ModuleIndex, ProjectIndex, SymbolDef } from "./types.js";
import type { ImportBinding } from "./import-types.js";

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
  if (index.scopeCache.has(fileId)) return index.scopeCache.get(fileId)!;
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
  index.scopeCache.set(fileId, scopeIndex);
  return scopeIndex;
}

export async function buildPhpQualifiedNames(
  index: ProjectIndex,
  definitionFile: string,
  def: SymbolDef,
): Promise<string[]> {
  try {
    const definitionParsed = await ensureParsedContext(definitionFile, index.parsed?.get(definitionFile));
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

async function collectNamedNodeReferences(index: ProjectIndex, fileId: string, symbolName: string): Promise<Range[]> {
  try {
    const parsedEntry = index.parsed?.get(fileId);
    const parsed = await ensureParsedContext(fileId, parsedEntry);
    const identifierTypes = new Set<string>([
      ...parsed.sup.nodeTypes.identifier,
      ...(parsed.sup.nodeTypes.propertyIdentifier ?? []),
      "constant",
      "type_identifier",
      "field_identifier",
    ]);
    const matches: Range[] = [];
    const walk = (node: SyntaxNodeLike): void => {
      if (identifierTypes.has(node.type) && sliceText(node, parsed.source) === symbolName) {
        matches.push(toRange(node));
      }
      for (const child of node.namedChildren) {
        walk(child);
      }
    };
    walk(parsed.tree.rootNode);
    return matches;
  } catch {
    return [];
  }
}

export async function collectVerifiedNamedNodeReferences(
  index: ProjectIndex,
  fileId: string,
  symbolName: string,
  expectedDef: SymbolDef,
  resolveDefinition: (params: {
    file: string;
    line: number;
    column: number;
  }) => Promise<{ status: string; definition?: SymbolDef }>,
  maxVerified?: number,
): Promise<Range[]> {
  const matches = await collectNamedNodeReferences(index, fileId, symbolName);
  const verified: Range[] = [];
  for (const range of matches) {
    if (maxVerified !== undefined && maxVerified > 0 && verified.length >= maxVerified) {
      break;
    }
    const resolved = await resolveDefinition({
      file: fileId,
      line: range.start.line,
      column: range.start.column,
    });
    if (resolved.status !== "ok" || !resolved.definition) continue;
    if (sameDef(resolved.definition, expectedDef)) {
      verified.push(range);
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
    if (!resolved || resolved !== definitionFile) continue;
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
  return moduleIndex.imports.some(
    (candidate) =>
      candidate.kind === "named" &&
      candidate.local === symbolName &&
      candidate.imported === symbolName &&
      candidate.resolved === targetFile,
  );
}

const referenceCandidateCache = new WeakMap<ProjectIndex, Map<string, string[]>>();

function referenceCandidateCacheKey(def: SymbolDef, exportedNames: readonly string[]): string {
  const sortedNames = [...exportedNames].sort();
  return `${def.file}::${def.range.start.index ?? 0}::${sortedNames.join("\0")}`;
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
    return hit?.kind === "resolved" ? sameDef(hit.def, def) : targetFile === def.file;
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
  const nextVisited = new Set([...visited, moduleIndex.file]);
  for (const entry of moduleIndex.exports) {
    if (entry.type === "reexport" || entry.type === "namespaceReexport") {
      names.add(entry.exportedAs);
      continue;
    }
    if (entry.type === "exportStar") {
      const targetModule = index.byFile.get(entry.fromModule);
      if (!targetModule || nextVisited.has(targetModule.file)) continue;
      for (const exportedName of moduleExportProbeNames(index, targetModule, exportedNames, nextVisited)) {
        names.add(exportedName);
      }
    }
  }
  return [...names];
}

function filesExportingDefinition(index: ProjectIndex, def: SymbolDef, exportedNames: readonly string[]): Set<string> {
  const files = new Set<string>([def.file]);
  for (const [fileId, moduleIndex] of index.byFile) {
    if (fileId === def.file || !moduleIndex.exports.length) continue;
    for (const exportedName of moduleExportProbeNames(index, moduleIndex, exportedNames)) {
      const resolved = resolveExport(index, fileId, exportedName);
      if (resolved?.kind === "resolved" && sameDef(resolved.def, def)) {
        files.add(fileId);
        break;
      }
    }
  }
  return files;
}

function getIndexedReferenceCandidateFiles(
  index: ProjectIndex,
  def: SymbolDef,
  exportedNames: readonly string[],
): readonly string[] | undefined {
  if (def.file.toLowerCase().endsWith(".php")) return undefined;
  if (!index.referenceCandidates) return undefined;
  const files = new Set<string>();
  for (const exportingFile of filesExportingDefinition(index, def, exportedNames)) {
    for (const importingFile of candidateFilesImportingTarget(index.referenceCandidates, exportingFile) ?? []) {
      files.add(importingFile);
    }
  }
  for (const [fileId, moduleIndex] of index.byFile) {
    if (fileId === def.file || files.has(fileId)) continue;
    if (
      moduleIndex.imports.some(
        (imp) =>
          (imp.kind === "star" || imp.kind === "namespace") &&
          importCanReferenceDefinition(index, imp, def, exportedNames),
      )
    ) {
      files.add(fileId);
    }
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

export function getCachedReferenceCandidateFiles(
  index: ProjectIndex,
  def: SymbolDef,
  exportedNames: readonly string[],
  hasGlobalNameReferences: boolean,
): string[] {
  if (hasGlobalNameReferences) {
    return Array.from(index.byFile.keys())
      .filter((candidateFile) => candidateFile !== def.file)
      .sort((left, right) => left.localeCompare(right));
  }

  let cache = referenceCandidateCache.get(index);
  if (!cache) {
    cache = new Map();
    referenceCandidateCache.set(index, cache);
  }

  const key = referenceCandidateCacheKey(def, exportedNames);
  const cached = cache.get(key);
  if (cached) return cached;

  const candidates = new Set<string>();
  const candidateFileEntries = getIndexedReferenceCandidateFiles(index, def, exportedNames) ?? index.byFile.keys();
  for (const fileId of candidateFileEntries) {
    if (fileId === def.file) continue;
    const moduleIndex = index.byFile.get(fileId);
    if (!moduleIndex) continue;
    if (moduleIndex.imports.some((imp) => importCanReferenceDefinition(index, imp, def, exportedNames))) {
      candidates.add(fileId);
    }
  }

  const sorted = Array.from(candidates).sort((left, right) => left.localeCompare(right));
  cache.set(key, sorted);
  return sorted;
}
