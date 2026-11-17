import type { SyntaxNodeLike } from "../languages/types.js";

/** An annotation pair's key names an element of its annotation type, not a lexical variable. */
export function isJavaAnnotationElementName(node: SyntaxNodeLike): boolean {
  const parent = node.parent;
  if (parent?.type !== "element_value_pair") return false;
  const key = parent.namedChildren[0];
  return !!key && key.startIndex === node.startIndex && key.endIndex === node.endIndex;
}

export function javaAnnotationTypeForElement(node: SyntaxNodeLike): SyntaxNodeLike | null {
  if (!isJavaAnnotationElementName(node)) return null;
  const argumentsNode = node.parent?.parent;
  const annotation = argumentsNode?.parent;
  if (argumentsNode?.type !== "annotation_argument_list" || annotation?.type !== "annotation") return null;
  return annotation.childForFieldName("name");
}

/** An unplaced annotation key can name only an annotation element, never a field, parameter, or ordinary method. */
export function javaUnprovenReferenceCandidate(node: SyntaxNodeLike, definitionName: SyntaxNodeLike): boolean {
  if (!isJavaAnnotationElementName(node)) return true;
  return definitionName.parent?.type === "annotation_type_element_declaration";
}
