import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import type { SymbolDef } from "../../indexer/types.js";
import { sliceText, unquote } from "../../util.js";
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

  const walk = (node: SyntaxNodeLike): void => {
    if (
      node.type === "function_declaration" ||
      node.type === "function_definition" ||
      node.type === "method_declaration" ||
      node.type === "constructor_declaration" ||
      node.type === "function_item" ||
      node.type === "method" ||
      node.type === "singleton_method"
    ) {
      const nameNode = node.childForFieldName("name") ?? node.childForFieldName("type");
      const name = nameNode ? sliceText(nameNode, source) : undefined;
      if (name) {
        const def = locals.find((local) => local.localName === name);
        if (def) functionNodes.push({ name, node, def });
      }
    } else if (node.type === "class_declaration" || node.type === "class_definition" || node.type === "class") {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? sliceText(nameNode, source) : undefined;
      if (name) {
        const def = locals.find((local) => local.localName === name);
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
          const def = locals.find((local) => local.localName === name);
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
            const def = locals.find((local) => local.localName === name);
            if (def) functionNodes.push({ name, node: right, def });
          }
        }
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
