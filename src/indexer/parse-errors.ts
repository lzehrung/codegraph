import type { ProjectedSyntaxTree } from "../native/projected-tree.js";
import type { ParseErrorRange } from "./types.js";

/** The outermost Tree-sitter ERROR and MISSING ranges of a tree, as UTF-16 source offsets. */
export function collectParseErrorRanges(tree: ProjectedSyntaxTree): ParseErrorRange[] {
  const columns = tree.columns;
  const isParseErrorNode = (nodeId: number): boolean => {
    const kind = columns.kinds[columns.kindIds[nodeId]!]!;
    return kind === "ERROR" || columns.isMissing[nodeId] !== 0;
  };
  const ranges: ParseErrorRange[] = [];
  for (let nodeId = 0; nodeId < columns.nodeCount; nodeId += 1) {
    if (!isParseErrorNode(nodeId)) continue;
    let parentId = columns.parentIds[nodeId]!;
    let hasErrorAncestor = false;
    while (parentId >= 0) {
      if (isParseErrorNode(parentId)) {
        hasErrorAncestor = true;
        break;
      }
      parentId = columns.parentIds[parentId]!;
    }
    if (hasErrorAncestor) continue;
    // MISSING nodes are zero-width; prefer a containing statement/declaration, then the nearest non-empty ancestor.
    let rangeNodeId = nodeId;
    if (columns.isMissing[nodeId] !== 0) {
      let ancestorId = columns.parentIds[nodeId]!;
      let nearestNonZeroAncestorId = -1;
      while (ancestorId >= 0) {
        if (columns.startIndex[ancestorId] !== columns.endIndex[ancestorId]) {
          if (nearestNonZeroAncestorId < 0) nearestNonZeroAncestorId = ancestorId;
          const kind = columns.kinds[columns.kindIds[ancestorId]!]!;
          if (kind === "statement" || kind.endsWith("_statement") || kind.endsWith("_declaration")) {
            rangeNodeId = ancestorId;
            break;
          }
        }
        ancestorId = columns.parentIds[ancestorId]!;
      }
      if (rangeNodeId === nodeId && nearestNonZeroAncestorId >= 0) rangeNodeId = nearestNonZeroAncestorId;
    }
    const startIndex = tree.stringIndexForByte(columns.startIndex[rangeNodeId]!);
    const endIndex = tree.stringIndexForByte(columns.endIndex[rangeNodeId]!);
    ranges.push({ startIndex, endIndex });
  }
  return ranges;
}
