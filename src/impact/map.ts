import type { FileId, Range } from "../types.js";
import type { ProjectIndex, SymbolHandle } from "../indexer.js";
import type { FileChange, ChangedSymbol } from "./types.js";
import { supportForFile, languageForFile } from "../languages.js";

export function locateChangedSymbols(
  index: ProjectIndex,
  file: FileId,
  hunks: FileChange["hunks"]
): ChangedSymbol[] {
  const parsedEntry = index.parsed?.get(file);
  if (!parsedEntry) return [];

  const { source, tree } = parsedEntry;
  const sup = supportForFile(file);
  const changedSymbols: ChangedSymbol[] = [];

  // Collect all changed line ranges from hunks
  // Robust new-file line tracking; works with unified=0 (no context)
  const changedLines = new Set<number>();
  for (const hunk of hunks) {
    let newLine = hunk.startLine;
    for (const line of hunk.lines) {
      if (line.startsWith(" ")) {
        newLine++;
      } else if (line.startsWith("+")) {
        changedLines.add(newLine);
        newLine++;
      }
      // '-' lines aren't included in hunk.lines with unified=0; no newLine++
    }
  }

  // Find AST nodes that overlap with changed lines
  const changedNodes = findNodesInLines(tree, changedLines);

  // Classify and collect changed symbols
  for (const node of changedNodes) {
    const classification = classifyChangedNode(node, source, sup);
    const symbolHandle = findSymbolHandleForNode(index, file, node, sup, classification);
    if (symbolHandle) {
      const symbolDef = index.byFile.get(file)?.locals.find(
        l => `${file}::${l.localName}::${l.range.start.index}` === symbolHandle
      );
      if (symbolDef) {
        changedSymbols.push({
          id: symbolHandle,
          file,
          name: symbolDef.localName,
          kind: symbolDef.kind,
          exported: isExported(index, file, symbolDef),
          range: symbolDef.range,
          typeOnly: !!classification?.typeOnly
        });
      }
    }
  }

  return changedSymbols;
}

function findNodesInLines(tree: any, changedLines: Set<number>): any[] {
  const nodes: any[] = [];

  function walk(node: any) {
    const startLine = node.startPosition?.row + 1;
    const endLine = node.endPosition?.row + 1;

    // Check if this node overlaps with any changed lines
    for (let line = startLine; line <= endLine; line++) {
      if (changedLines.has(line)) {
        nodes.push(node);
        break;
      }
    }

    // Walk children
    for (const child of node.namedChildren || []) {
      walk(child);
    }
  }

  walk(tree.rootNode);
  return nodes;
}

type NodeClassification = {
  type: "definition" | "import" | "export" | "callsite";
  typeOnly?: boolean;
} | null;

function classifyChangedNode(node: any, source: string, sup: any): NodeClassification {
  // Check for definition nodes
  if (sup.isDeclarationName?.(node)) {
    return { type: "definition", typeOnly: isTypeOnlyDeclaration(node, source) };
  }

  // Check for import statements
  if (node.type === "import_statement" || node.type === "import_equals_declaration") {
    return { type: "import", typeOnly: /^\s*import\s+type\b/.test(source.slice(node.startIndex, node.endIndex)) };
  }

  // Check for export statements
  if (node.type?.startsWith("export_")) {
    return { type: "export", typeOnly: /^\s*export\s+type\b/.test(source.slice(node.startIndex, node.endIndex)) };
  }

  // Check for callsites (identifiers that are not declarations)
  if (sup.nodeTypes.identifier.includes(node.type) && !sup.isDeclarationName?.(node)) {
    return { type: "callsite" };
  }

  return null;
}

function isTypeOnlyDeclaration(node: any, source: string): boolean {
  // Check if this is part of a type-only declaration
  let current = node;
  while (current) {
    const text = source.slice(current.startIndex, current.endIndex);
    if (/\btype\b|\binterface\b|\btype\b.*=/.test(text)) {
      return true;
    }
    if (/\bconst\b|\blet\b|\bvar\b|\bfunction\b|\bclass\b/.test(text)) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function findDeclarationNameInAncestors(node: any, sup: any): any | null {
  let cur = node;
  while (cur) {
    for (const ch of cur.namedChildren || []) {
      if (sup.isDeclarationName?.(ch)) return ch;
    }
    cur = cur.parent;
  }
  return null;
}

function findSymbolHandleForNode(
  index: ProjectIndex,
  file: FileId,
  node: any,
  sup: any,
  classification: NodeClassification
): SymbolHandle | null {
  const mod = index.byFile.get(file);
  if (!mod) return null;

  // Exact declaration name node
  if (classification?.type === "definition" && sup.isDeclarationName?.(node)) {
    const local = mod.locals.find(l =>
      l.range.start.line === (node.startPosition?.row + 1) &&
      l.range.start.column === (node.startPosition?.column + 1)
    );
    return local ? `${file}::${local.localName}::${local.range.start.index}` : null;
  }

  // For body/callsite/import/export edits, climb to nearest declaration name
  const nameNode = findDeclarationNameInAncestors(node, sup);
  if (nameNode) {
    const local = mod.locals.find(l =>
      l.range.start.line === (nameNode.startPosition?.row + 1) &&
      l.range.start.column === (nameNode.startPosition?.column + 1)
    );
    return local ? `${file}::${local.localName}::${local.range.start.index}` : null;
  }

  return null;
}

function isExported(index: ProjectIndex, file: FileId, symbolDef: any): boolean {
  const mod = index.byFile.get(file);
  if (!mod) return false;

  return mod.exports.some(e =>
    e.type === "local" &&
    e.target.localName === symbolDef.localName &&
    e.target.range.start.index === symbolDef.range.start.index
  );
}
