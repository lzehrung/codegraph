import type { LanguageSupport } from "../languages.js";
import type { JsLanguage, SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import { sliceText, toRange } from "../util/ast.js";
import { ensureParsedContext } from "./parse-context.js";
import { sameDef } from "./reference-context.js";
import { readPhpNamespaceFromRange } from "./navigation-php.js";
import { buildScopeIndexFromSource, type ScopeIndex } from "./scope.js";
import type { ModuleIndex, ProjectIndex, SymbolDef } from "./types.js";

export function getCachedScope(
  index: ProjectIndex,
  fileId: string,
  moduleIndex: ModuleIndex,
  parsedCtx: {
    source: string;
    sup: LanguageSupport;
    lang?: JsLanguage;
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
