import type { ImpactDefinitionShapes, SyntaxNodeLike } from "../types.js";

function isHtmlIdAttributeValue(node: SyntaxNodeLike, source: string): boolean {
  const quoted = node.parent;
  if (!quoted) return false;
  const attribute = quoted.parent;
  if (!attribute || attribute.type !== "attribute") return false;
  const nameNode = attribute.childForFieldName?.("name") ?? attribute.child(0);
  if (!nameNode || nameNode.type !== "attribute_name") return false;
  const nameText = source.slice(nameNode.startIndex, nameNode.endIndex).trim().toLowerCase();
  return nameText === "id";
}

export const HTML_IMPACT_DEFINITIONS: ImpactDefinitionShapes = {
  names: [{ nodeType: "attribute_value" }],
  acceptsName: isHtmlIdAttributeValue,
};
