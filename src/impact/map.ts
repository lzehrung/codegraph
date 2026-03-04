import type Parser from "tree-sitter";
import type { FileId } from "../types.js";
import type { ProjectIndex, SymbolDef, SymbolHandle } from "../indexer.js";
import { ensureParsedContext } from "../indexer.js";
import type { LanguageSupport } from "../languages.js";
import type { FileChange, ChangedSymbol } from "./types.js";

function symbolHandleFromLocal(file: FileId, local: SymbolDef): string {
  const index = local.range.start.index ?? 0;
  return `${file}::${local.localName}::${index}`;
}

export async function locateChangedSymbols(
  index: ProjectIndex,
  file: FileId,
  hunks: FileChange["hunks"],
): Promise<ChangedSymbol[]> {
  return (await locateChangedSymbolsWithLines(index, file, hunks))
    .changedSymbols;
}

export async function locateChangedSymbolsWithLines(
  index: ProjectIndex,
  file: FileId,
  hunks: FileChange["hunks"],
): Promise<{ changedSymbols: ChangedSymbol[]; changedLines: Set<number> }> {
  let parsedEntry;
  try {
    parsedEntry = await ensureParsedContext(file, index.parsed?.get(file));
  } catch {
    return { changedSymbols: [], changedLines: new Set() };
  }
  if (!parsedEntry) return { changedSymbols: [], changedLines: new Set() };

  const { source, tree } = parsedEntry;
  const sup = parsedEntry.sup;

  // Collect changed line numbers in the new file view.
  // Track deletions by mapping them to the current new-line position.
  const changedLines = collectChangedLines(hunks);

  // Find AST nodes that overlap with changed lines
  const changedNodes = findNodesInLines(tree, changedLines);

  // Accumulate per-symbol info, deduplicating across multiple overlapping nodes.
  // Key: SymbolHandle  →  { symbolDef, typeOnly, lines changed within symbol range }
  type SymbolEntry = {
    symbolDef: SymbolDef;
    typeOnly: boolean;
    lines: Set<number>;
    signatureChanged: boolean;
  };
  const seenHandles = new Map<SymbolHandle, SymbolEntry>();
  const mod = index.byFile.get(file);

  // Pre-build an O(1) position lookup so findDeclarationNameInAncestors does
  // not do an O(locals) scan for every candidate declaration name node.
  const trackedPositions = mod ? buildTrackedPositions(mod.locals) : undefined;

  for (const node of changedNodes) {
    const classification = classifyChangedNode(node, source, sup);
    const symbolHandle = findSymbolHandleForNode(
      index,
      file,
      node,
      sup,
      classification,
      source,
      trackedPositions,
    );
    if (!symbolHandle) continue;

    const symbolDef = mod?.locals.find(
      (l) => symbolHandleFromLocal(file, l) === symbolHandle,
    );
    if (!symbolDef) continue;

    const existing = seenHandles.get(symbolHandle);
    if (existing) {
      // A symbol is typeOnly only when ALL contributing nodes are typeOnly.
      // Any non-typeOnly contribution clears the flag.
      if (!classification?.typeOnly) existing.typeOnly = false;
    } else {
      // Compute changed lines that fall within this symbol's declared range
      const lines = new Set<number>();
      for (
        let l = symbolDef.range.start.line;
        l <= symbolDef.range.end.line;
        l++
      ) {
        if (changedLines.has(l)) lines.add(l);
      }
      seenHandles.set(symbolHandle, {
        symbolDef,
        typeOnly: !!classification?.typeOnly,
        lines,
        // Computed once here so calculateSeverity doesn't re-parse the AST
        // once per reference (which could be hundreds of calls for hot symbols).
        signatureChanged: computeSignatureChanged(tree, symbolDef, lines),
      });
    }
  }

  const changedSymbols: ChangedSymbol[] = [];
  for (const [handle, entry] of seenHandles) {
    changedSymbols.push({
      id: handle,
      file,
      name: entry.symbolDef.localName,
      kind: entry.symbolDef.kind,
      exported: isExported(index, file, entry.symbolDef),
      range: entry.symbolDef.range,
      typeOnly: entry.typeOnly,
      changedLines: entry.lines,
      signatureChanged: entry.signatureChanged,
    });
  }

  return { changedSymbols, changedLines };
}

export async function mapChangedLinesToSymbols(
  index: ProjectIndex,
  file: FileId,
  hunks: FileChange["hunks"],
  changedLinesOverride?: Set<number>,
): Promise<Map<SymbolHandle, Set<number>>> {
  let parsedEntry;
  try {
    parsedEntry = await ensureParsedContext(file, index.parsed?.get(file));
  } catch {
    return new Map();
  }
  if (!parsedEntry) return new Map();

  const { source, tree } = parsedEntry;
  const sup = parsedEntry.sup;
  const changedLines = changedLinesOverride ?? collectChangedLines(hunks);

  const mod = index.byFile.get(file);
  const trackedPositions = mod ? buildTrackedPositions(mod.locals) : undefined;

  const nodes = findNodesInLines(tree, changedLines);
  const linesByHandle = new Map<SymbolHandle, Set<number>>();
  for (const node of nodes) {
    const startLine = node.startPosition?.row + 1;
    const endLine = node.endPosition?.row + 1;
    if (!startLine || !endLine) continue;
    const matchingLines: number[] = [];
    for (let line = startLine; line <= endLine; line++) {
      if (changedLines.has(line)) matchingLines.push(line);
    }
    if (matchingLines.length === 0) continue;
    const classification = classifyChangedNode(node, source, sup);
    const symbolHandle = findSymbolHandleForNode(
      index,
      file,
      node,
      sup,
      classification,
      source,
      trackedPositions,
    );
    if (!symbolHandle) continue;
    const existing = linesByHandle.get(symbolHandle) ?? new Set<number>();
    for (const line of matchingLines) existing.add(line);
    linesByHandle.set(symbolHandle, existing);
  }

  return linesByHandle;
}

function findNodesInLines(
  tree: Parser.Tree,
  changedLines: Set<number>,
): Parser.SyntaxNode[] {
  if (changedLines.size === 0) return [];

  // Build a sorted array for efficient range-overlap checks
  const sortedLines = [...changedLines].sort((a, b) => a - b);
  const minLine = sortedLines[0]!;
  const maxLine = sortedLines[sortedLines.length - 1]!;

  const nodes: Parser.SyntaxNode[] = [];

  function walk(node: Parser.SyntaxNode) {
    const startLine = node.startPosition?.row + 1;
    const endLine = node.endPosition?.row + 1;

    // Prune: if this node's range is entirely outside all changed lines, skip subtree
    if (endLine < minLine || startLine > maxLine) return;

    // Check if this node overlaps with any changed lines
    for (let line = startLine; line <= endLine; line++) {
      if (changedLines.has(line)) {
        nodes.push(node);
        break;
      }
    }

    // Walk children (safe: already pruned obvious non-overlaps above)
    for (const child of node.namedChildren || []) {
      walk(child);
    }
  }

  walk(tree.rootNode);
  return nodes;
}

export function collectChangedLines(hunks: FileChange["hunks"]): Set<number> {
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
        const mappedLine = newLine > 0 ? newLine : oldLine;
        changedLines.add(mappedLine);
        oldLine++;
      }
    }
  }
  return changedLines;
}

type NodeClassification = {
  type: "definition" | "import" | "export" | "callsite";
  typeOnly?: boolean;
} | null;

function classifyChangedNode(
  node: Parser.SyntaxNode,
  source: string,
  sup: LanguageSupport,
): NodeClassification {
  if (sup.id === "html" && isHtmlIdAttributeValue(node, source)) {
    return { type: "definition" };
  }
  if (sup.id === "css" || sup.id === "less" || sup.id === "scss") {
    if (isStyleDefinitionNode(node, sup)) {
      return { type: "definition" };
    }
  }

  // Check for definition nodes
  if (sup.isDeclarationName?.(node)) {
    return {
      type: "definition",
      typeOnly: isTypeOnlyDeclaration(node, source),
    };
  }

  // Check for import statements
  if (
    node.type === "import_statement" ||
    node.type === "import_equals_declaration"
  ) {
    return {
      type: "import",
      typeOnly: sup.isTypeOnly(source.slice(node.startIndex, node.endIndex)),
    };
  }

  // Check for export statements
  if (node.type?.startsWith("export_")) {
    return {
      type: "export",
      typeOnly: sup.isTypeOnly(source.slice(node.startIndex, node.endIndex)),
    };
  }

  // Check for callsites (identifiers that are not declarations)
  if (
    sup.nodeTypes.identifier.includes(node.type) &&
    !sup.isDeclarationName?.(node)
  ) {
    return { type: "callsite" };
  }

  return null;
}

function isTypeOnlyDeclaration(
  node: Parser.SyntaxNode,
  source: string,
): boolean {
  // Check if this is part of a type-only declaration
  let current: Parser.SyntaxNode | null = node;
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

/** Build an O(1)-lookup set of tracked symbol positions ("line:col") from locals. */
function buildTrackedPositions(locals: readonly SymbolDef[]): Set<string> {
  const set = new Set<string>();
  for (const l of locals) {
    set.add(`${l.range.start.line}:${l.range.start.column}`);
  }
  return set;
}

function findDeclarationNameInAncestors(
  node: Parser.SyntaxNode,
  sup: LanguageSupport,
  trackedPositions?: ReadonlySet<string>,
): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node;
  while (cur) {
    for (const ch of cur.namedChildren || []) {
      if (sup.isDeclarationName?.(ch)) {
        // If we have a tracked-position set, only stop at names that are
        // actually in the index.  This prevents the search from halting at
        // declaration names for symbols not tracked as separate locals (e.g.
        // class method names) and allows climbing to a tracked ancestor instead.
        if (trackedPositions) {
          const line = (ch.startPosition?.row ?? 0) + 1;
          const col = (ch.startPosition?.column ?? 0) + 1;
          if (!trackedPositions.has(`${line}:${col}`)) continue;
        }
        return ch;
      }
    }
    cur = cur.parent;
  }
  return null;
}

const SIGNATURE_DECL_TYPES = new Set([
  "function_declaration",
  "function_definition",
  "method_definition",
  "method_declaration",
  "class_declaration",
  "class_definition",
]);

/**
 * Returns true when the parameter list of the declaration that contains
 * `symbolDef` overlaps with any of the provided changed lines.
 * Computed once per symbol (not once per reference).
 */
function computeSignatureChanged(
  tree: Parser.Tree,
  symbolDef: SymbolDef,
  lines: ReadonlySet<number>,
): boolean {
  if (lines.size === 0) return false;
  const pos = {
    row: symbolDef.range.start.line - 1,
    column: symbolDef.range.start.column - 1,
  };
  const nameNode = tree.rootNode.descendantForPosition(pos, pos);
  let declNode: Parser.SyntaxNode | null = nameNode;
  while (declNode && !SIGNATURE_DECL_TYPES.has(declNode.type)) {
    declNode = declNode.parent;
  }
  if (!declNode) return false;
  const params =
    declNode.childForFieldName("parameters") ||
    declNode.childForFieldName("params");
  if (!params || params.namedChildCount === 0) return false;
  const paramsStart = params.startPosition.row + 1;
  const paramsEnd = params.endPosition.row + 1;
  for (let line = paramsStart; line <= paramsEnd; line++) {
    if (lines.has(line)) return true;
  }
  return false;
}

function findSymbolHandleForNode(
  index: ProjectIndex,
  file: FileId,
  node: Parser.SyntaxNode,
  sup: LanguageSupport,
  classification: NodeClassification,
  source: string,
  trackedPositions?: ReadonlySet<string>,
): SymbolHandle | null {
  const mod = index.byFile.get(file);
  if (!mod) return null;

  // Exact declaration name node
  if (
    classification?.type === "definition" &&
    isDefinitionNameNode(node, sup, source)
  ) {
    const local = mod.locals.find(
      (l) =>
        l.range.start.line === node.startPosition?.row + 1 &&
        l.range.start.column === node.startPosition?.column + 1,
    );
    return local ? symbolHandleFromLocal(file, local) : null;
  }

  // For body/callsite/import/export edits, climb to nearest declaration name.
  // Pass trackedPositions (pre-built from mod.locals) so the search skips
  // untracked names (e.g., method names when methods are not in locals) and
  // continues climbing to a tracked ancestor.
  const nameNode = findDeclarationNameInAncestors(node, sup, trackedPositions);
  if (nameNode) {
    const local = mod.locals.find(
      (l) =>
        l.range.start.line === nameNode.startPosition?.row + 1 &&
        l.range.start.column === nameNode.startPosition?.column + 1,
    );
    return local ? symbolHandleFromLocal(file, local) : null;
  }

  return null;
}

function isExported(
  index: ProjectIndex,
  file: FileId,
  symbolDef: SymbolDef,
): boolean {
  const mod = index.byFile.get(file);
  if (!mod) return false;

  const symbolIndex = symbolDef.range.start.index ?? 0;
  return mod.exports.some(
    (e) =>
      e.type === "local" &&
      e.target.localName === symbolDef.localName &&
      (e.target.range.start.index ?? 0) === symbolIndex,
  );
}

function isStyleDefinitionNode(
  node: Parser.SyntaxNode,
  sup: LanguageSupport,
): boolean {
  const parentType = node.parent?.type ?? "";
  if (sup.id === "css" || sup.id === "less") {
    if (node.type === "class_name" && parentType === "class_selector") {
      return true;
    }
    if (node.type === "id_name" && parentType === "id_selector") {
      return true;
    }
    return false;
  }

  if (sup.id === "scss") {
    if (node.type === "class_name" && parentType === "class_selector") {
      return true;
    }
    if (node.type === "id_name" && parentType === "id_selector") {
      return true;
    }
    if (node.type === "variable" && parentType === "variable_declaration") {
      return true;
    }
    if (node.type === "name" && parentType === "mixin_statement") {
      return true;
    }
    if (node.type === "name" && parentType === "function_statement") {
      return true;
    }
  }

  return false;
}

function isHtmlIdAttributeValue(
  node: Parser.SyntaxNode,
  source: string,
): boolean {
  if (node.type !== "attribute_value") return false;
  const quoted = node.parent;
  if (!quoted) return false;
  const attribute = quoted.parent;
  if (!attribute || attribute.type !== "attribute") return false;
  const nameNode = attribute.childForFieldName?.("name") ?? attribute.child(0);
  if (!nameNode || nameNode.type !== "attribute_name") return false;
  const nameText = source
    .slice(nameNode.startIndex, nameNode.endIndex)
    .trim()
    .toLowerCase();
  return nameText === "id";
}

function isDefinitionNameNode(
  node: Parser.SyntaxNode,
  sup: LanguageSupport,
  source: string,
): boolean {
  if (sup.isDeclarationName?.(node)) return true;
  if (sup.id === "html") return isHtmlIdAttributeValue(node, source);
  if (sup.id === "css" || sup.id === "less" || sup.id === "scss") {
    return isStyleDefinitionNode(node, sup);
  }
  return false;
}
