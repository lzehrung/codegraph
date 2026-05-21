import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import { sliceText } from "../util/ast.js";

function readPhpNamespaceName(namespaceNode: SyntaxNodeLike, source: string): string | null {
  const namespaceName =
    namespaceNode.childForFieldName?.("name") ??
    namespaceNode.namedChildren.find((child) => child.type === "namespace_name");
  return namespaceName ? sliceText(namespaceName, source).trim() : null;
}

function findClosestPhpNamespaceDefinition(root: SyntaxNodeLike, targetIndex: number): SyntaxNodeLike | null {
  let bestMatch: SyntaxNodeLike | null = null;

  const visit = (node: SyntaxNodeLike): void => {
    if (node.startIndex > targetIndex) {
      return;
    }
    if (node.type === "namespace_definition" && (!bestMatch || node.startIndex >= bestMatch.startIndex)) {
      bestMatch = node;
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  };

  visit(root);
  return bestMatch;
}

function readPhpNamespaceFromNode(tree: SyntaxTreeLike, node: SyntaxNodeLike | null, source: string): string | null {
  if (!node) return null;
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (current.type === "namespace_definition") {
      return readPhpNamespaceName(current, source);
    }
    current = current.parent;
  }
  const namespaceNode = findClosestPhpNamespaceDefinition(tree.rootNode, node.startIndex);
  return namespaceNode ? readPhpNamespaceName(namespaceNode, source) : null;
}

export function readPhpNamespaceFromRange(tree: SyntaxTreeLike, source: string, range: Range): string | null {
  const row = Math.max(0, range.start.line - 1);
  const column = Math.max(0, range.start.column - 1);
  const position = { row, column };
  const node = tree.rootNode.descendantForPosition(position, position);
  return readPhpNamespaceFromNode(tree, node, source);
}

export function getPhpQualifiedReference(node: SyntaxNodeLike | null, source: string): string | null {
  if (!node) return null;
  if (node.type === "qualified_name" || node.type === "relative_name") {
    return sliceText(node, source);
  }
  const parent = node.parent;
  if (parent && (parent.type === "qualified_name" || parent.type === "relative_name")) {
    return sliceText(parent, source);
  }
  return null;
}

export function normalizePhpQualifiedReference(
  rawName: string,
  source: string,
  tree: SyntaxTreeLike,
  node: SyntaxNodeLike | null,
): string | null {
  const trimmed = rawName.trim().replace(/^\\+/, "");
  if (!trimmed) return null;
  if (!trimmed.startsWith("namespace\\")) {
    return trimmed;
  }
  const currentNamespace = readPhpNamespaceFromNode(tree, node, source);
  const relativeSuffix = trimmed.slice("namespace\\".length);
  if (!relativeSuffix) {
    return currentNamespace;
  }
  if (!currentNamespace) {
    return relativeSuffix;
  }
  return `${currentNamespace}\\${relativeSuffix}`;
}

export function inferPhpQualifiedReferenceImportType(node: SyntaxNodeLike): "class" | "function" | undefined {
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (current.type === "object_creation_expression") {
      return "class";
    }
    if (current.type === "function_call_expression" || current.type === "call_expression") {
      return "function";
    }
    if (
      current.type === "scoped_call_expression" ||
      current.type === "scoped_property_access_expression" ||
      current.type === "class_constant_access_expression"
    ) {
      return "class";
    }
    current = current.parent;
  }
  return undefined;
}
