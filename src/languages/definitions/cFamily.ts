import type { SyntaxNodeLike } from "../types.js";

export const cFamilyContainerTypes = new Set([
  "function_definition",
  "declaration",
  "parameter_declaration",
  "field_declaration",
  "type_definition",
  "init_declarator",
]);

const cFamilyParameterListTypes = new Set(["parameter_declaration", "parameter_list"]);

export function cFunctionNameQuery(captureName: string, includeFieldIdentifier: boolean): string {
  const identifierTypes = includeFieldIdentifier ? ["identifier", "field_identifier"] : ["identifier"];
  const patterns: string[] = [];
  for (const identifierType of identifierTypes) {
    patterns.push(`(function_declarator declarator: (${identifierType}) @${captureName})`);
    patterns.push(
      `(function_declarator declarator: (pointer_declarator declarator: (${identifierType}) @${captureName}))`,
    );
    patterns.push(
      `(pointer_declarator declarator: (function_declarator declarator: (${identifierType}) @${captureName}))`,
    );
    patterns.push(
      `(function_declarator declarator: (parenthesized_declarator (pointer_declarator declarator: (${identifierType}) @${captureName})))`,
    );
  }
  return `
  declarator: [
    ${patterns.join("\n    ")}
  ]
`;
}

export function isWithin(node: SyntaxNodeLike, ancestor: SyntaxNodeLike | null): boolean {
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (ancestor && current.id === ancestor.id) return true;
    current = current.parent;
  }
  return false;
}

export function isInField(node: SyntaxNodeLike, parent: SyntaxNodeLike, field: string): boolean {
  return isWithin(node, parent.childForFieldName(field));
}

export function findAncestor(node: SyntaxNodeLike, types: Set<string>): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = node.parent;
  while (current) {
    if (types.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

export function isInParameterList(node: SyntaxNodeLike): boolean {
  return !!findAncestor(node, cFamilyParameterListTypes);
}

function resolveDeclaratorRoot(ancestor: SyntaxNodeLike): SyntaxNodeLike | null {
  let declaratorNode = ancestor.childForFieldName("declarator");
  if (!declaratorNode) return null;
  if (declaratorNode.type === "init_declarator") {
    const inner = declaratorNode.childForFieldName("declarator");
    if (inner) declaratorNode = inner;
  }
  if (declaratorNode.type === "function_declarator") {
    const inner = declaratorNode.childForFieldName("declarator");
    if (inner) declaratorNode = inner;
  }
  return declaratorNode;
}

export function isInAncestorDeclarator(node: SyntaxNodeLike, ancestorTypes: Set<string>): boolean {
  const ancestor = findAncestor(node, ancestorTypes);
  if (!ancestor) return false;
  const declaratorNode = resolveDeclaratorRoot(ancestor);
  if (!declaratorNode) return false;
  return isWithin(node, declaratorNode);
}

export function isFunctionDeclarator(node: SyntaxNodeLike): boolean {
  let current: SyntaxNodeLike | null = node.parent;
  while (current) {
    if (current.type === "function_declarator") return true;
    if (cFamilyContainerTypes.has(current.type)) return false;
    current = current.parent;
  }
  return false;
}
