import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import type { SymbolDef } from "../../indexer/types.js";
import { sliceText, unquote } from "../../util/ast.js";
import {
  getMemberAccessParts,
  memberExpressionTypeFor,
  memberPropertyIdentifierTypes,
} from "../../util/memberAccess.js";

export type DetailedFunctionNode = {
  name: string;
  node: SyntaxNodeLike;
  def: SymbolDef;
};

export type DetailedClassNode = {
  name: string;
  node: SyntaxNodeLike;
  def: SymbolDef;
};

export type DetailedDeclarationPassResult = {
  functionNodes: DetailedFunctionNode[];
  classNodes: DetailedClassNode[];
  constStringOf: Map<string, string>;
};

export const isIdentifierType = (sup: LanguageSupport, type: string): boolean =>
  Array.isArray(sup.nodeTypes?.identifier) && sup.nodeTypes.identifier.includes(type);

/** C and C++ put the function name in a nested declarator, not a `name` field. */
function functionNameNode(node: SyntaxNodeLike): SyntaxNodeLike | null {
  const named = node.childForFieldName("name");
  if (named) return named;
  let current = node.childForFieldName("declarator");
  while (current) {
    if (current.type === "identifier" || current.type === "field_identifier") return current;
    const nested = current.childForFieldName("declarator");
    if (nested) {
      current = nested;
      continue;
    }
    return (
      current.namedChildren.find((child) => child.type === "identifier" || child.type === "field_identifier") ?? null
    );
  }
  return node.childForFieldName("type");
}

export function collectDetailedDeclarations(
  rootNode: SyntaxNodeLike,
  sup: LanguageSupport,
  source: string,
  locals: SymbolDef[],
): DetailedDeclarationPassResult {
  const functionNodes: DetailedFunctionNode[] = [];
  const classNodes: DetailedClassNode[] = [];
  const constStringOf = new Map<string, string>();
  const memberExpressionType = memberExpressionTypeFor(sup);
  const propertyIdentifierTypes = memberPropertyIdentifierTypes(sup);
  const functionNodeTypes = new Set([
    "function_declaration",
    "function_definition",
    "method_declaration",
    "method_definition",
    "method_signature",
    "abstract_method_signature",
    "constructor_declaration",
    "function_item",
    "function_signature_item",
    "method",
    "protocol_function_declaration",
    "singleton_method",
  ]);
  const typeNodeTypes = new Set([
    "class_declaration",
    "record_declaration",
    "abstract_class_declaration",
    "class_definition",
    "class",
    "interface_declaration",
    "module",
    "protocol_declaration",
    "trait_item",
    "trait_declaration",
    "struct_item",
    "struct_declaration",
    "class_specifier",
    "struct_specifier",
    // Enums can implement interfaces/protocols in several supported languages
    // (Java, C#, PHP, Kotlin) - treat them as class-kind nodes so
    // emitClassInheritanceEdges sees them and wires implements/extends edges.
    "enum_declaration",
  ]);

  const findDefinition = (name: string, nameNode: SyntaxNodeLike): SymbolDef | undefined => {
    const candidates = locals.filter((local) => local.localName === name);
    const exact = candidates.find((local) => local.range.start.index === nameNode.startIndex);
    if (exact) return exact;
    const containing = candidates
      .filter(
        (local) =>
          (local.range.start.index ?? Number.POSITIVE_INFINITY) <= nameNode.startIndex &&
          (local.range.end.index ?? Number.NEGATIVE_INFINITY) >= nameNode.endIndex,
      )
      .sort(
        (left, right) =>
          (left.range.end.index ?? 0) -
          (left.range.start.index ?? 0) -
          ((right.range.end.index ?? 0) - (right.range.start.index ?? 0)),
      );
    return containing[0] ?? candidates[0];
  };

  const walk = (node: SyntaxNodeLike): void => {
    if (functionNodeTypes.has(node.type)) {
      const nameNode = functionNameNode(node);
      const name = nameNode ? sliceText(nameNode, source) : undefined;
      if (name) {
        const def = findDefinition(name, nameNode!);
        if (def) functionNodes.push({ name, node, def });
      }
    } else if (typeNodeTypes.has(node.type)) {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? sliceText(nameNode, source) : undefined;
      if (name) {
        const def = findDefinition(name, nameNode!);
        if (def) classNodes.push({ name, node, def });
      }
    } else if (node.type === "variable_declarator") {
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (nameNode && valueNode) {
        if (valueNode.type === "string") {
          const name = sliceText(nameNode, source);
          const value = unquote(sliceText(valueNode, source));
          constStringOf.set(name, value);
        }
        const valueType = String(valueNode.type || "");
        if (/arrow_function|function/.test(valueType)) {
          const name = sliceText(nameNode, source);
          const def = findDefinition(name, nameNode);
          if (def) functionNodes.push({ name, node: valueNode, def });
        }
      }
    } else if (node.type === "assignment_expression") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left && right) {
        const valueType = String(right.type || "");
        if (/arrow_function|function/.test(valueType)) {
          let name: string | null = null;
          if (left.type === memberExpressionType) {
            const { property: prop } = getMemberAccessParts(sup, left);
            if (prop && propertyIdentifierTypes.includes(prop.type)) name = sliceText(prop, source);
          } else if (left.type === "identifier") {
            name = sliceText(left, source);
          }
          if (name) {
            const def = findDefinition(name, left);
            if (def) functionNodes.push({ name, node: right, def });
          }
        }
      }
    } else if (sup.id === "ruby" && node.type === "assignment") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      const receiver = right?.childForFieldName("receiver");
      const method = right?.childForFieldName("method");
      if (
        left?.type === "constant" &&
        right?.type === "call" &&
        receiver?.text === "Struct" &&
        method?.text === "new"
      ) {
        const name = sliceText(left, source);
        const def = findDefinition(name, left);
        if (def) classNodes.push({ name, node, def });
      }
    }

    for (const child of node.namedChildren) walk(child);
  };

  walk(rootNode);
  return { functionNodes, classNodes, constStringOf };
}

export function collectIdentifiers(node: SyntaxNodeLike, sup: LanguageSupport, source: string, out: string[]): void {
  if (isIdentifierType(sup, node.type) || node.type === "type_identifier") {
    out.push(sliceText(node, source));
  }
  for (const child of node.namedChildren ?? []) collectIdentifiers(child, sup, source, out);
}

export function findFirstNodeByType(node: SyntaxNodeLike, type: string): SyntaxNodeLike | null {
  for (const child of node.namedChildren ?? []) {
    if (child.type === type) return child;
    const found = findFirstNodeByType(child, type);
    if (found) return found;
  }
  return null;
}

export function collectNodesByType(node: SyntaxNodeLike, type: string, out: SyntaxNodeLike[]): void {
  for (const child of node.namedChildren ?? []) {
    if (child.type === type) out.push(child);
    collectNodesByType(child, type, out);
  }
}

export function scanForAliasUse(
  node: SyntaxNodeLike,
  sup: LanguageSupport,
  source: string,
  cb: (name: string, atNode: SyntaxNodeLike) => void,
): void {
  if (isIdentifierType(sup, node.type)) {
    const name = sliceText(node, source);
    cb(name, node);
  }
  for (const child of node.namedChildren) scanForAliasUse(child, sup, source, cb);
}
