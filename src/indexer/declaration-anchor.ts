import type { SyntaxNodeLike } from "../languages/types.js";

const declarationNameTypes = new Set(["identifier", "type_identifier", "property_identifier"]);

export function getDeclarationAnchor(node: SyntaxNodeLike | null): SyntaxNodeLike | null {
  if (!node) return null;
  let target = node;
  if (declarationNameTypes.has(target.type) && target.parent) {
    target = target.parent;
  }
  if (target.type === "variable_declarator" && target.parent) {
    target = target.parent;
  }
  if (target.parent?.type === "export_statement") {
    target = target.parent;
  }
  return target;
}
