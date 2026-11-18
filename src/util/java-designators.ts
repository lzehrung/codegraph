import type { SyntaxNodeLike } from "../languages/types.js";

/** An annotation pair's key names an element of its annotation type, not a lexical variable. */
export function isJavaAnnotationElementName(node: SyntaxNodeLike): boolean {
  const parent = node.parent;
  if (parent?.type !== "element_value_pair") return false;
  const key = parent.namedChildren[0];
  return !!key && key.startIndex === node.startIndex && key.endIndex === node.endIndex;
}

/** A bare case label may name an enum constant instead of an enclosing lexical binding. */
export function isJavaSwitchLabelName(node: SyntaxNodeLike): boolean {
  return node.type === "identifier" && node.parent?.type === "switch_label";
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
  if (isJavaSwitchLabelName(node)) {
    const parent = definitionName.parent;
    if (parent?.type === "formal_parameter" || parent?.type === "inferred_parameters") return false;
    if (parent?.type === "lambda_expression") return false;
  }
  if (!isJavaAnnotationElementName(node)) return true;
  return definitionName.parent?.type === "annotation_type_element_declaration";
}
