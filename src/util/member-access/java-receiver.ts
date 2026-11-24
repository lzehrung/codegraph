import type { SyntaxNodeLike } from "../../languages/types.js";

function collectSegments(part: SyntaxNodeLike, endIndex: number, segments: SyntaxNodeLike[]): boolean {
  if (part.startIndex >= endIndex) return true;
  if (part.type === "identifier" || part.type === "type_identifier") {
    segments.push(part);
    return true;
  }
  if (part.type !== "scoped_type_identifier") return false;
  for (const child of part.namedChildren) {
    if (child.type === "line_comment" || child.type === "block_comment") continue;
    if (!collectSegments(child, endIndex, segments)) return false;
  }
  return true;
}

/** Java scoped type segments through the selected token, without type arguments. */
export function javaQualifiedTypeSegments(node: SyntaxNodeLike): SyntaxNodeLike[] | null {
  let type: SyntaxNodeLike | null = null;
  if (node.type === "scoped_type_identifier") type = node;
  else if (node.parent?.type === "scoped_type_identifier") type = node.parent;
  if (!type) return null;
  const endIndex = node === type ? type.endIndex : node.endIndex;
  const segments: SyntaxNodeLike[] = [];
  return collectSegments(type, endIndex, segments) && segments.length > 1 ? segments : null;
}
