import type { FileId } from "../types.js";
import type { LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import { fileIdentityKey } from "../util/paths.js";
import { SymbolKind, type ExportEntry, type ProjectIndex, type SymbolDef, type SymbolHandle } from "./types.js";
import type { BindingKind } from "./scope-types.js";

const DESCENDANT_DECLARATION_CONTAINER_TYPES = new Set(["function_definition", "declaration"]);

export function declarationKindToBindingKind(kind: string): BindingKind {
  if (kind === "function") return "function";
  if (kind === "method") return "function";
  if (kind === "class" || kind === "interface") return "class";
  if (kind === "type") return "type";
  return "local";
}

export function bindingKindToSymbolKind(kind: BindingKind): SymbolKind {
  if (kind === "function") return SymbolKind.Function;
  if (kind === "class") return SymbolKind.Class;
  if (kind === "type") return SymbolKind.TypeAlias;
  return SymbolKind.Variable;
}

export function symbolHandleFromLocal(file: FileId, local: SymbolDef): SymbolHandle {
  const index = local.range.start.index ?? 0;
  return `${file}::${local.localName}::${index}`;
}

export function buildTrackedSymbolPositions(locals: readonly SymbolDef[]): Set<string> {
  const positions = new Set<string>();
  for (const local of locals) {
    positions.add(`${local.range.start.line}:${local.range.start.column}`);
  }
  return positions;
}

export function findTrackedDeclarationNameInAncestors(
  node: SyntaxNodeLike,
  support: LanguageSupport,
  trackedPositions?: ReadonlySet<string>,
): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = node;
  while (current) {
    for (const child of current.namedChildren || []) {
      if (!support.isDeclarationName?.(child)) continue;
      if (trackedPositions) {
        const line = (child.startPosition?.row ?? 0) + 1;
        const column = (child.startPosition?.column ?? 0) + 1;
        if (!trackedPositions.has(`${line}:${column}`)) continue;
      }
      return child;
    }
    if (DESCENDANT_DECLARATION_CONTAINER_TYPES.has(current.type)) {
      const nested = findTrackedDeclarationNameInDescendants(current, support, trackedPositions);
      if (nested) return nested;
    }
    current = current.parent;
  }
  return null;
}

function findTrackedDeclarationNameInDescendants(
  node: SyntaxNodeLike,
  support: LanguageSupport,
  trackedPositions?: ReadonlySet<string>,
): SyntaxNodeLike | null {
  const queue: SyntaxNodeLike[] = [...(node.namedChildren || [])];
  while (queue.length) {
    const current = queue.shift();
    if (!current) continue;
    if (support.isDeclarationName?.(current)) {
      if (!trackedPositions) return current;
      const line = (current.startPosition?.row ?? 0) + 1;
      const column = (current.startPosition?.column ?? 0) + 1;
      if (trackedPositions.has(`${line}:${column}`)) {
        return current;
      }
    }
    queue.push(...(current.namedChildren || []));
  }
  return null;
}

export function findLocalByStartPosition(
  locals: readonly SymbolDef[],
  line: number | undefined,
  column: number | undefined,
): SymbolDef | undefined {
  if (!line || !column) return undefined;
  return locals.find((local) => local.range.start.line === line && local.range.start.column === column);
}

export function isLocalSymbolExported(exports: readonly ExportEntry[], symbolDef: SymbolDef): boolean {
  const symbolIndex = symbolDef.range.start.index ?? 0;
  return exports.some(
    (entry) =>
      entry.type === "local" &&
      entry.target.localName === symbolDef.localName &&
      (entry.target.range.start.index ?? 0) === symbolIndex,
  );
}

export function isSymbolHandleExported(exports: readonly ExportEntry[], handle: SymbolHandle): boolean {
  return exports.some(
    (entry) => entry.type === "local" && symbolHandleFromLocal(entry.target.file, entry.target) === handle,
  );
}

export function isProjectSymbolExported(index: ProjectIndex, file: FileId, symbolDef: SymbolDef): boolean {
  const mod = index.byFile.get(fileIdentityKey(file));
  return mod ? isLocalSymbolExported(mod.exports, symbolDef) : false;
}
