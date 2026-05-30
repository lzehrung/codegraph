import type { SyntaxNodeLike } from "../languages/types.js";

export function directSignatureParameterNode(node: SyntaxNodeLike): SyntaxNodeLike | null {
  return (
    node.childForFieldName("parameters") ??
    node.childForFieldName("params") ??
    node.childForFieldName("parameter") ??
    null
  );
}

export function findAncestorOfTypes(
  node: SyntaxNodeLike | null,
  types: ReadonlySet<string>,
): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (types.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

export function findFirstDescendantOfTypes(
  node: SyntaxNodeLike,
  types: ReadonlySet<string>,
): SyntaxNodeLike | null {
  for (const child of node.namedChildren ?? []) {
    if (types.has(child.type)) {
      return child;
    }
    const found = findFirstDescendantOfTypes(child, types);
    if (found) {
      return found;
    }
  }
  return null;
}
