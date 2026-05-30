import type { FileId, Range } from "../types.js";
import { type ProjectIndex, SymbolKind, type SymbolDef, type SymbolHandle } from "../indexer/types.js";
import { ensureParsedContext } from "../indexer/parse-context.js";
import {
  buildTrackedSymbolPositions,
  findLocalByStartPosition,
  findTrackedDeclarationNameInAncestors,
  isProjectSymbolExported,
  symbolHandleFromLocal,
} from "../indexer/declarations.js";
import { isGraphOnlyLanguage } from "../documentLinks.js";
import { supportForFile } from "../languages.js";
import type { LanguageSupport } from "../languages.js";
import { isJsTsLanguage } from "../languages/js-family.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { FileChange, ChangedSymbol } from "./types.js";
import { collectChangedLines } from "./hunks.js";
import { toRange } from "../util/ast.js";
import {
  directSignatureParameterNode,
  findAncestorOfTypes,
  findFirstDescendantOfTypes,
} from "./signature-node-utils.js";

export { collectChangedLines } from "./hunks.js";

export async function locateChangedSymbols(
  index: ProjectIndex,
  file: FileId,
  hunks: FileChange["hunks"],
): Promise<ChangedSymbol[]> {
  return (await locateChangedSymbolsWithLines(index, file, hunks)).changedSymbols;
}

export async function locateChangedSymbolsWithLines(
  index: ProjectIndex,
  file: FileId,
  hunks: FileChange["hunks"],
): Promise<{
  changedSymbols: ChangedSymbol[];
  changedLines: Set<number>;
  parseFailed: boolean;
}> {
  const changedLines = collectChangedLines(hunks);
  if (isGraphOnlyFile(file)) {
    return { changedSymbols: [], changedLines, parseFailed: false };
  }

  let parsedEntry;
  try {
    parsedEntry = await ensureParsedContext(file, index.parsed?.get(file));
  } catch {
    return { changedSymbols: [], changedLines, parseFailed: true };
  }
  if (!parsedEntry) return { changedSymbols: [], changedLines, parseFailed: true };

  const { source, tree } = parsedEntry;
  const sup = parsedEntry.sup;

  // Find AST nodes that overlap with changed lines
  const changedNodes = findNodesInLines(tree, changedLines);

  // Precise byte ranges of changed content, used by computeSignatureChanged to
  // avoid false positives on single-line declarations where params and body share
  // the same line number.
  const changedByteRanges = computeChangedByteRanges(source, hunks);

  // Accumulate per-symbol info, deduplicating across multiple overlapping nodes.
  // Key: SymbolHandle -> { symbolDef, typeOnly, lines changed within symbol range }
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
  const trackedPositions = mod ? buildTrackedSymbolPositions(mod.locals) : undefined;

  for (const node of changedNodes) {
    const classification = classifyChangedNode(node, source, sup);
    const symbolHandle = findSymbolHandleForNode(index, file, node, sup, classification, source, trackedPositions);
    if (!symbolHandle) continue;

    const symbolDef = mod?.locals.find((l) => symbolHandleFromLocal(file, l) === symbolHandle);
    if (!symbolDef) continue;

    const existing = seenHandles.get(symbolHandle);
    if (existing) {
      // A symbol is typeOnly only when ALL contributing nodes are typeOnly.
      // Any non-typeOnly contribution clears the flag.
      if (!classification?.typeOnly) existing.typeOnly = false;
    } else {
      // Compute changed lines that fall within this symbol's declared range.
      // Iterate over changedLines (typically small) rather than the symbol's
      // full line span (could be hundreds of lines for large classes).
      const lines = new Set<number>();
      for (const l of changedLines) {
        if (l >= symbolDef.range.start.line && l <= symbolDef.range.end.line) {
          lines.add(l);
        }
      }
      const signatureChanged =
        computeSignatureChanged(tree, symbolDef, changedByteRanges, sup.id, trackedPositions) ||
        signatureOnlyDeclarationLineChanged(tree, symbolDef, changedLines);
      seenHandles.set(symbolHandle, {
        symbolDef,
        typeOnly: !!classification?.typeOnly,
        lines,
        // Computed once here so calculateSeverity doesn't re-parse the AST
        // once per reference (which could be hundreds of calls for hot symbols).
        signatureChanged,
      });
    }
  }

  const changedSymbols: ChangedSymbol[] = [];
  const preciseEntries = removeOuterSymbolsCoveredByNestedChanges(seenHandles, changedByteRanges, changedLines, tree, sup);
  for (const [handle, entry] of preciseEntries) {
    changedSymbols.push({
      id: handle,
      file,
      name: entry.symbolDef.localName,
      kind: entry.symbolDef.kind,
      exported: isProjectSymbolExported(index, file, entry.symbolDef),
      range: entry.symbolDef.range,
      typeOnly: entry.typeOnly,
      changedLines: [...entry.lines].sort((a, b) => a - b),
      signatureChanged: entry.signatureChanged,
    });
  }

  return { changedSymbols, changedLines, parseFailed: false };
}

function removeOuterSymbolsCoveredByNestedChanges<T extends { symbolDef: SymbolDef }>(
  entries: ReadonlyMap<SymbolHandle, T>,
  changedByteRanges: ReadonlyArray<ByteRange>,
  changedLines: ReadonlySet<number>,
  tree: SyntaxTreeLike,
  support: LanguageSupport,
): Array<[SymbolHandle, T]> {
  const declarationRanges = new Map<SymbolHandle, Range>();
  for (const [handle, entry] of entries) {
    declarationRanges.set(handle, declarationRangeForSymbol(tree, entry.symbolDef, support));
  }

  return [...entries].filter(([handle, entry]) => {
    const entryRange = declarationRanges.get(handle) ?? entry.symbolDef.range;
    for (const [otherHandle, otherEntry] of entries) {
      if (otherHandle === handle) continue;
      const otherRange = declarationRanges.get(otherHandle) ?? otherEntry.symbolDef.range;
      if (!rangeStrictlyContains(entryRange, otherRange)) continue;
      const byteRangesAreNested = changedRangesForOuterAreContainedByInner(entryRange, otherRange, changedByteRanges);
      const changedLinesAreNested = changedLinesForOuterAreContainedByInner(entryRange, otherRange, changedLines);
      if (byteRangesAreNested || changedLinesAreNested) {
        return false;
      }
    }
    return true;
  });
}

function declarationRangeForSymbol(tree: SyntaxTreeLike, symbolDef: SymbolDef, support: LanguageSupport): Range {
  const pos = {
    row: symbolDef.range.start.line - 1,
    column: symbolDef.range.start.column - 1,
  };
  let current: SyntaxNodeLike | null = tree.rootNode.descendantForPosition(pos, pos);
  while (current) {
    const declarationName = findDeclarationNameDescendant(current, symbolDef.range, support);
    if (declarationName && isSymbolDeclarationRangeNode(current, symbolDef)) {
      return toRange(current);
    }
    current = current.parent;
  }
  return symbolDef.range;
}

const SYMBOL_DECLARATION_RANGE_TYPES = new Set([
  "function_declaration",
  "function_definition",
  "method_definition",
  "method_signature",
  "abstract_method_signature",
  "method_declaration",
  "method",
  "singleton_method",
  "function_item",
  "class_declaration",
  "class_definition",
  "class",
  "class_specifier",
  "interface_declaration",
  "struct_item",
  "struct_specifier",
  "trait_item",
  "enum_item",
  "enum_specifier",
  "object_declaration",
  "protocol_declaration",
  "namespace_definition",
  "module",
  "mod_item",
]);

function isSymbolDeclarationRangeNode(node: SyntaxNodeLike, symbolDef: SymbolDef): boolean {
  if (node.type === "variable_declaration") {
    return symbolDef.kind === SymbolKind.Class || symbolDef.kind === SymbolKind.TypeAlias;
  }
  return SYMBOL_DECLARATION_RANGE_TYPES.has(node.type);
}

function findDeclarationNameDescendant(
  node: SyntaxNodeLike,
  symbolRange: Range,
  support: LanguageSupport,
): SyntaxNodeLike | null {
  const queue: SyntaxNodeLike[] = [...(node.namedChildren ?? [])];
  while (queue.length) {
    const current = queue.shift();
    if (!current) continue;
    if (support.isDeclarationName(current) && sameRangeStartPosition(toRange(current), symbolRange)) {
      return current;
    }
    queue.push(...(current.namedChildren ?? []));
  }
  return null;
}

function sameRangeStartPosition(left: Range, right: Range): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.column === right.start.column &&
    left.start.index === right.start.index
  );
}

export async function mapChangedLinesToSymbols(
  index: ProjectIndex,
  file: FileId,
  hunks: FileChange["hunks"],
  changedLinesOverride?: Set<number>,
): Promise<Map<SymbolHandle, Set<number>>> {
  if (isGraphOnlyFile(file)) {
    return new Map();
  }

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
  const trackedPositions = mod ? buildTrackedSymbolPositions(mod.locals) : undefined;

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
    if (!matchingLines.length) continue;
    const classification = classifyChangedNode(node, source, sup);
    const symbolHandle = findSymbolHandleForNode(index, file, node, sup, classification, source, trackedPositions);
    if (!symbolHandle) continue;
    const existing = linesByHandle.get(symbolHandle) ?? new Set<number>();
    for (const line of matchingLines) existing.add(line);
    linesByHandle.set(symbolHandle, existing);
  }

  return linesByHandle;
}

function isGraphOnlyFile(file: FileId): boolean {
  const support = supportForFile(file);
  return support ? isGraphOnlyLanguage(support.id) : false;
}

/**
 * Binary-search check: returns true if any element in the sorted array falls
 * within [lo, hi] inclusive.  O(log n) vs the O(span) linear scan it replaces.
 */
function hasOverlapSorted(sorted: number[], lo: number, hi: number): boolean {
  let left = 0;
  let right = sorted.length - 1;
  while (left <= right) {
    const mid = (left + right) >>> 1;
    const v = sorted[mid]!;
    if (v < lo) {
      left = mid + 1;
    } else if (v > hi) {
      right = mid - 1;
    } else {
      return true; // lo <= v <= hi
    }
  }
  return false;
}

function findNodesInLines(tree: SyntaxTreeLike, changedLines: Set<number>): SyntaxNodeLike[] {
  if (!changedLines.size) return [];

  // Build a sorted array once for O(log n) overlap checks during the walk.
  const sortedLines = [...changedLines].sort((a, b) => a - b);
  const minLine = sortedLines[0]!;
  const maxLine = sortedLines[sortedLines.length - 1]!;

  const nodes: SyntaxNodeLike[] = [];

  function walk(node: SyntaxNodeLike) {
    const startLine = node.startPosition?.row + 1;
    const endLine = node.endPosition?.row + 1;

    // Prune: if this node's range is entirely outside all changed lines, skip subtree.
    if (endLine < minLine || startLine > maxLine) return;

    // Binary-search check: O(log #changedLines) instead of O(node line span).
    if (hasOverlapSorted(sortedLines, startLine, endLine)) {
      nodes.push(node);
    }

    // Walk children (safe: already pruned obvious non-overlaps above).
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

function classifyChangedNode(node: SyntaxNodeLike, source: string, sup: LanguageSupport): NodeClassification {
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
  if (node.type === "import_statement" || node.type === "import_equals_declaration") {
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
  if (sup.nodeTypes.identifier.includes(node.type) && !sup.isDeclarationName?.(node)) {
    return { type: "callsite" };
  }

  return null;
}

function isTypeOnlyDeclaration(node: SyntaxNodeLike, source: string): boolean {
  // Check if this is part of a type-only declaration
  let current: SyntaxNodeLike | null = node;
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

const SIGNATURE_DECL_TYPES = new Set([
  "function_item",
  "method",
  "singleton_method",
  "function_declaration",
  "function_definition",
  "method_definition",
  "method_declaration",
  "constructor_declaration",
  "init_declaration",
  "protocol_function_declaration",
  "variable_declarator",
  "declaration",
]);

const CALLABLE_VARIABLE_VALUE_TYPES = new Set(["arrow_function", "function_expression"]);
const JS_TS_CLASS_SIGNATURE_FALLBACK_TYPES = new Set(["class_declaration"]);
const JS_TS_METHOD_SIGNATURE_FALLBACK_TYPES = new Set([
  "method_definition",
  "method_signature",
  "abstract_method_signature",
]);
const SIGNATURE_PARAMETER_LIST_TYPES = new Set([
  "parameters",
  "parameter_list",
  "formal_parameters",
  "function_value_parameters",
  "method_parameters",
]);

type ByteRange = { start: number; end: number };

function signatureParameterSpan(declNode: SyntaxNodeLike): ByteRange | null {
  if (declNode.type === "method_signature" || declNode.type === "abstract_method_signature") {
    return { start: declNode.startIndex, end: declNode.endIndex };
  }

  let params = directSignatureParameterNode(declNode);
  params = enclosingSignatureParameterList(params);
  if (!params && declNode.type === "variable_declarator") {
    const valueNode = declNode.childForFieldName("value");
    if (!valueNode || !CALLABLE_VARIABLE_VALUE_TYPES.has(valueNode.type)) {
      return null;
    }
    params = directSignatureParameterNode(valueNode);
    params = enclosingSignatureParameterList(params);
  }
  if (!params) {
    params = findFirstDescendantOfTypes(declNode, SIGNATURE_PARAMETER_LIST_TYPES);
  }
  if (!params && declNode.type === "function_declaration") {
    const parameterNodes = declNode.namedChildren.filter((child) => child.type === "parameter");
    const first = parameterNodes[0];
    const last = parameterNodes[parameterNodes.length - 1];
    if (first && last) {
      return { start: first.startIndex, end: last.endIndex };
    }
  }
  if (!params) {
    return null;
  }
  return { start: params.startIndex, end: params.endIndex };
}

function enclosingSignatureParameterList(node: SyntaxNodeLike | null): SyntaxNodeLike | null {
  if (!node) {
    return null;
  }
  if (SIGNATURE_PARAMETER_LIST_TYPES.has(node.type)) {
    return node;
  }
  const parent = node.parent;
  if (parent && SIGNATURE_PARAMETER_LIST_TYPES.has(parent.type)) {
    return parent;
  }
  return node;
}

function byteRangesOverlap(left: ByteRange, right: ByteRange): boolean {
  return left.start < right.end && left.end > right.start;
}

function rangeStrictlyContains(outer: Range, inner: Range): boolean {
  const startsBeforeOrEqual =
    outer.start.line < inner.start.line ||
    (outer.start.line === inner.start.line && outer.start.column <= inner.start.column);
  const endsAfterOrEqual =
    outer.end.line > inner.end.line || (outer.end.line === inner.end.line && outer.end.column >= inner.end.column);
  return startsBeforeOrEqual && endsAfterOrEqual && !sameRangeStartPosition(outer, inner);
}

function rangeByteBounds(range: Range): ByteRange | null {
  const start = range.start.index;
  const end = range.end.index;
  if (start === undefined || end === undefined) {
    return null;
  }
  return { start, end };
}

function byteRangeContains(outer: ByteRange, inner: ByteRange): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

function changedRangesForOuterAreContainedByInner(
  outer: Range,
  inner: Range,
  changedByteRanges: ReadonlyArray<ByteRange>,
): boolean {
  const outerBounds = rangeByteBounds(outer);
  const innerBounds = rangeByteBounds(inner);
  if (!outerBounds || !innerBounds) {
    return false;
  }

  const relevantChangedRanges = changedByteRanges.filter((changedRange) => byteRangesOverlap(changedRange, outerBounds));
  if (!relevantChangedRanges.length) {
    return false;
  }
  return relevantChangedRanges.every((changedRange) => byteRangeContains(innerBounds, changedRange));
}

function changedLinesForOuterAreContainedByInner(
  outer: Range,
  inner: Range,
  changedLines: ReadonlySet<number>,
): boolean {
  const relevantChangedLines = [...changedLines].filter(
    (line) => line >= outer.start.line && line <= outer.end.line,
  );
  if (!relevantChangedLines.length) {
    return false;
  }
  return relevantChangedLines.every((line) => line >= inner.start.line && line <= inner.end.line);
}

function spanOverlapsAnyChangedRange(span: ByteRange, changedByteRanges: ReadonlyArray<ByteRange>): boolean {
  for (const changedRange of changedByteRanges) {
    if (byteRangesOverlap(changedRange, span)) {
      return true;
    }
  }
  return false;
}

function hasChangedDescendantMethodSignature(
  node: SyntaxNodeLike,
  changedByteRanges: ReadonlyArray<ByteRange>,
  trackedPositions?: ReadonlySet<string>,
): boolean {
  for (const child of node.namedChildren ?? []) {
    if (JS_TS_METHOD_SIGNATURE_FALLBACK_TYPES.has(child.type)) {
      const span = signatureParameterSpan(child);
      const methodNameIsTracked = isMethodNameTracked(child, trackedPositions);
      if (!methodNameIsTracked && span && spanOverlapsAnyChangedRange(span, changedByteRanges)) {
        return true;
      }
      continue;
    }
    if (hasChangedDescendantMethodSignature(child, changedByteRanges, trackedPositions)) {
      return true;
    }
  }
  return false;
}

function isMethodNameTracked(node: SyntaxNodeLike, trackedPositions?: ReadonlySet<string>): boolean {
  if (!trackedPositions) {
    return false;
  }

  const nameNode = node.childForFieldName("name");
  if (!nameNode) {
    return false;
  }

  const line = (nameNode.startPosition?.row ?? 0) + 1;
  const column = (nameNode.startPosition?.column ?? 0) + 1;
  return trackedPositions.has(`${line}:${column}`);
}

/**
 * Compute precise byte ranges (in the new source) that actually changed, by
 * pairing deleted and added diff lines and finding the minimal changed span
 * within each pair via common-prefix/suffix trimming.
 *
 * This is more accurate than treating whole changed lines as modified: for a
 * single-line function where only the body changes, the edit range starts after
 * the closing `)` of the parameter list and therefore does not overlap params.
 */
function computeChangedByteRanges(source: string, hunks: FileChange["hunks"]): ByteRange[] {
  // Build 0-indexed line-start byte offsets for the new source.
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }

  const ranges: ByteRange[] = [];

  for (const hunk of hunks) {
    let newLine = hunk.newStart;
    let i = 0;
    while (i < hunk.lines.length) {
      const ln = hunk.lines[i]!;
      if (ln.startsWith(" ")) {
        newLine++;
        i++;
        continue;
      }
      // Collect a run of deleted lines, then a run of added lines.
      const deleted: string[] = [];
      while (i < hunk.lines.length && hunk.lines[i]!.startsWith("-")) {
        deleted.push(hunk.lines[i]!.slice(1));
        i++;
      }
      const added: string[] = [];
      const addedStart = newLine;
      while (i < hunk.lines.length && hunk.lines[i]!.startsWith("+")) {
        added.push(hunk.lines[i]!.slice(1));
        newLine++;
        i++;
      }
      for (let ai = 0; ai < added.length; ai++) {
        const absLine = addedStart + ai; // 1-based
        const lineStart = lineStarts[absLine - 1];
        if (lineStart === undefined) continue;
        const newText = added[ai]!;
        if (ai < deleted.length) {
          // Paired replacement: narrow to the minimal changed span.
          const oldText = deleted[ai]!;
          let pfx = 0;
          const maxPfx = Math.min(oldText.length, newText.length);
          while (pfx < maxPfx && oldText[pfx] === newText[pfx]) pfx++;
          let sfx = 0;
          while (
            sfx < oldText.length - pfx &&
            sfx < newText.length - pfx &&
            oldText[oldText.length - 1 - sfx] === newText[newText.length - 1 - sfx]
          )
            sfx++;
          const start = lineStart + pfx;
          const end = lineStart + newText.length - sfx;
          // Guard: ensure start < end (or at least a 1-byte sentinel).
          ranges.push({ start, end: end > start ? end : start + 1 });
        } else {
          // Pure addition: whole line is new content.
          ranges.push({ start: lineStart, end: lineStart + newText.length });
        }
      }
      // If more lines were deleted than added, including pure-deletion blocks,
      // emit a 1-byte sentinel at the deletion cursor in the new source.
      // Without this, removing a parameter line from a multiline
      // signature would leave computeSignatureChanged with no byte range to overlap
      // against the params node and incorrectly return false.
      // When the deletion falls at EOF, newLine-1 can exceed lineStarts.length;
      // clamp to source.length rather than the last line-start so the sentinel
      // does not create spurious overlap with content near the last line.
      if (deleted.length > added.length) {
        const deletionCursorLine = Math.max(newLine - 1, 0);
        const cursor = deletionCursorLine >= lineStarts.length ? source.length : lineStarts[deletionCursorLine]!;
        // Ensure the sentinel range is non-empty: computeSignatureChanged uses
        // strict overlap (r.start < paramsEnd && r.end > paramsStart), so a
        // zero-length range (start === end) would never overlap anything.
        // At EOF, back up one byte when possible; skip if source is empty.
        if (cursor >= source.length) {
          if (source.length) {
            ranges.push({ start: source.length - 1, end: source.length });
          }
          // else: empty source, no sentinel needed
        } else {
          ranges.push({ start: cursor, end: cursor + 1 });
        }
      }
    }
  }

  return ranges;
}

/**
 * Returns true when the parameter list of the declaration containing
 * `symbolDef` byte-range-overlaps with any of the precise changed byte ranges.
 * Computed once per symbol (not once per reference).
 *
 * Using hunk-derived byte ranges (not line-level changed nodes) avoids false
 * positives on single-line declarations: a body-only edit on
 * `function f(a) { return a + 1; }` produces a changed byte range that starts
 * after the `)` and therefore does not overlap the params node.
 */
function computeSignatureChanged(
  tree: SyntaxTreeLike,
  symbolDef: SymbolDef,
  changedByteRanges: ReadonlyArray<ByteRange>,
  languageId: string,
  trackedPositions?: ReadonlySet<string>,
): boolean {
  if (!changedByteRanges.length) return false;
  const pos = {
    row: symbolDef.range.start.line - 1,
    column: symbolDef.range.start.column - 1,
  };
  const nameNode = tree.rootNode.descendantForPosition(pos, pos);
  let declNode: SyntaxNodeLike | null = nameNode;
  while (declNode && !SIGNATURE_DECL_TYPES.has(declNode.type)) {
    declNode = declNode.parent;
  }

  if (!declNode && isJsTsLanguage(languageId)) {
    const classNode = findAncestorOfTypes(nameNode, JS_TS_CLASS_SIGNATURE_FALLBACK_TYPES);
    if (classNode) {
      return hasChangedDescendantMethodSignature(classNode, changedByteRanges, trackedPositions);
    }
    return false;
  }
  if (!declNode) return false;

  const paramsSpan = signatureParameterSpan(declNode);
  if (!paramsSpan) return false;
  // Note: namedChildCount === 0 is intentionally NOT checked here.
  // A signature edit that removes ALL parameters (e.g. f(a) -> f()) should
  // still be detected: the params node exists and its byte range overlaps the
  // changed content even though it ends up empty.
  return spanOverlapsAnyChangedRange(paramsSpan, changedByteRanges);
}

function signatureOnlyDeclarationLineChanged(
  tree: SyntaxTreeLike,
  symbolDef: SymbolDef,
  changedLines: ReadonlySet<number>,
): boolean {
  if (!changedLines.has(symbolDef.range.start.line)) {
    return false;
  }

  const pos = {
    row: symbolDef.range.start.line - 1,
    column: symbolDef.range.start.column - 1,
  };
  const nameNode = tree.rootNode.descendantForPosition(pos, pos);
  let current: SyntaxNodeLike | null = nameNode;
  while (current) {
    if (current.type === "method_signature" || current.type === "abstract_method_signature") {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function findSymbolHandleForNode(
  index: ProjectIndex,
  file: FileId,
  node: SyntaxNodeLike,
  sup: LanguageSupport,
  classification: NodeClassification,
  source: string,
  trackedPositions?: ReadonlySet<string>,
): SymbolHandle | null {
  const mod = index.byFile.get(file);
  if (!mod) return null;

  // Exact declaration name node
  if (classification?.type === "definition" && isDefinitionNameNode(node, sup, source)) {
    const definitionLine = node.startPosition?.row + 1;
    const definitionColumn = node.startPosition?.column + 1;
    const local = findLocalByStartPosition(mod.locals, definitionLine, definitionColumn);
    if (local) {
      return symbolHandleFromLocal(file, local);
    }
    // No matching local (e.g. method names after adding method_definition to
    // isDeclarationName): fall through to the ancestor-climb path below so
    // the edit can be attributed to the nearest tracked ancestor (e.g. the
    // containing class) instead of being dropped entirely.
  }

  // For body/callsite/import/export edits, climb to nearest declaration name.
  // Pass trackedPositions (pre-built from mod.locals) so the search skips
  // untracked names (e.g., method names when methods are not in locals) and
  // continues climbing to a tracked ancestor.
  const nameNode = findTrackedDeclarationNameInAncestors(node, sup, trackedPositions);
  if (nameNode) {
    const ancestorLine = nameNode.startPosition?.row + 1;
    const ancestorColumn = nameNode.startPosition?.column + 1;
    const local = findLocalByStartPosition(mod.locals, ancestorLine, ancestorColumn);
    return local ? symbolHandleFromLocal(file, local) : null;
  }

  return null;
}

function isStyleDefinitionNode(node: SyntaxNodeLike, sup: LanguageSupport): boolean {
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

function isHtmlIdAttributeValue(node: SyntaxNodeLike, source: string): boolean {
  if (node.type !== "attribute_value") return false;
  const quoted = node.parent;
  if (!quoted) return false;
  const attribute = quoted.parent;
  if (!attribute || attribute.type !== "attribute") return false;
  const nameNode = attribute.childForFieldName?.("name") ?? attribute.child(0);
  if (!nameNode || nameNode.type !== "attribute_name") return false;
  const nameText = source.slice(nameNode.startIndex, nameNode.endIndex).trim().toLowerCase();
  return nameText === "id";
}

function isDefinitionNameNode(node: SyntaxNodeLike, sup: LanguageSupport, source: string): boolean {
  if (sup.isDeclarationName?.(node)) return true;
  if (sup.id === "html") return isHtmlIdAttributeValue(node, source);
  if (sup.id === "css" || sup.id === "less" || sup.id === "scss") {
    return isStyleDefinitionNode(node, sup);
  }
  return false;
}
