import type { SyntaxNodeLike } from "../../languages/types.js";

/** Kotlin user-type segments through the selected token; a generic owner proves no path. */
export function kotlinQualifiedTypeSegments(node: SyntaxNodeLike): SyntaxNodeLike[] | null {
  let type: SyntaxNodeLike | null = null;
  if (node.type === "user_type") type = node;
  else if (node.parent?.type === "user_type") type = node.parent;
  if (!type) return null;
  const segments: SyntaxNodeLike[] = [];
  let genericOwner = false;
  for (let index = 0; ; index += 1) {
    const child = type.child(index);
    if (!child) break;
    if (child.type === "identifier") {
      if (genericOwner) return null;
      segments.push(child);
      if (node !== type && child.startIndex === node.startIndex) break;
    } else if (child.type === "type_arguments" && segments.length) {
      genericOwner = true;
    }
  }
  return segments.length > 1 ? segments : null;
}
