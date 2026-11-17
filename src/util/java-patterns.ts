import type { SyntaxNodeLike } from "../languages/types.js";

const PATTERN_MEMBER_TYPES: Readonly<Record<string, true>> = {
  method_declaration: true,
  constructor_declaration: true,
  compact_constructor_declaration: true,
  field_declaration: true,
  constant_declaration: true,
  annotation_type_element_declaration: true,
  static_initializer: true,
  enum_constant: true,
};
const TYPE_BODY_TYPES: Readonly<Record<string, true>> = {
  class_body: true,
  enum_body: true,
  enum_body_declarations: true,
  interface_body: true,
  annotation_type_body: true,
};

/** A pattern belongs to its enclosing executable member, regardless of the type body's grammar shape. */
export function javaPatternMember(node: SyntaxNodeLike): SyntaxNodeLike {
  let member = node;
  while (member.parent) {
    if (PATTERN_MEMBER_TYPES[member.type]) return member;
    if (member.type === "block" && TYPE_BODY_TYPES[member.parent.type]) return member;
    member = member.parent;
  }
  return member;
}

function sameNode(left: SyntaxNodeLike | null | undefined, right: SyntaxNodeLike): boolean {
  return !!left && left.startIndex === right.startIndex && left.endIndex === right.endIndex;
}

function contains(outer: SyntaxNodeLike | null | undefined, inner: SyntaxNodeLike): boolean {
  return !!outer && outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;
}

/** The name of a type or record pattern; type names and nested pattern components are not declarations. */
export function javaPatternVariableName(pattern: SyntaxNodeLike): SyntaxNodeLike | null {
  if (pattern.type === "instanceof_expression") return pattern.childForFieldName("name");
  if (pattern.type !== "type_pattern" && pattern.type !== "record_pattern_component") return null;
  const name = pattern.namedChildren.at(-1);
  return name?.type === "identifier" ? name : null;
}

export function isJavaPatternVariableName(node: SyntaxNodeLike): boolean {
  const parent = node.parent;
  return !!parent && sameNode(javaPatternVariableName(parent), node);
}

/** A true expression proves an instanceof only through parentheses and &&, not || or negation. */
function provesPattern(expression: SyntaxNodeLike | null, pattern: SyntaxNodeLike): boolean {
  if (!expression || !contains(expression, pattern)) return false;
  if (sameNode(expression, pattern)) return true;
  if (expression.type === "parenthesized_expression")
    return provesPattern(expression.namedChildren[0] ?? null, pattern);
  if (expression.type !== "binary_expression" || expression.childForFieldName("operator")?.type !== "&&") return false;
  return (
    provesPattern(expression.childForFieldName("left"), pattern) ||
    provesPattern(expression.childForFieldName("right"), pattern)
  );
}

/** Whether a pattern binding is proven to reach a use in an if condition/body or switch rule. */
export function javaPatternBindingVisibleAt(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  if (!isJavaPatternVariableName(declaration)) return true;
  if (sameNode(declaration, use)) return true;
  let pattern = declaration.parent;
  while (pattern && pattern.type !== "instanceof_expression" && pattern.type !== "switch_label") {
    pattern = pattern.parent;
  }
  if (!pattern) return false;
  if (pattern.type === "switch_label") {
    const rule = pattern.parent;
    return rule?.type === "switch_rule" && contains(rule, use) && declaration.endIndex <= use.startIndex;
  }
  let condition = pattern.parent;
  while (condition && condition.type !== "if_statement") {
    if (condition.type === "block" || condition.type === "method_declaration") return false;
    condition = condition.parent;
  }
  if (!condition) return false;
  const ifCondition = condition.childForFieldName("condition");
  if (!contains(ifCondition, pattern)) return false;
  if (contains(condition.childForFieldName("consequence"), use)) return provesPattern(ifCondition, pattern);
  if (!contains(ifCondition, use)) return false;
  for (let current = use.parent; current && !sameNode(current, condition); current = current.parent) {
    if (current.type !== "binary_expression" || current.childForFieldName("operator")?.type !== "&&") continue;
    if (!contains(current.childForFieldName("right"), use)) continue;
    if (provesPattern(current.childForFieldName("left"), pattern)) return true;
  }
  return false;
}

/** Whether an unmodeled flow rule might still put this earlier pattern in scope at the use. */
export function javaPatternMayReachUse(declaration: SyntaxNodeLike, use: SyntaxNodeLike): boolean {
  if (declaration.startIndex > use.startIndex) return false;
  let pattern = declaration.parent;
  while (pattern && pattern.type !== "instanceof_expression" && pattern.type !== "switch_label") {
    pattern = pattern.parent;
  }
  if (!pattern) return true;
  if (pattern.type === "switch_label") return contains(pattern.parent, use);
  for (let scope = pattern.parent; scope; scope = scope.parent) {
    if (PATTERN_MEMBER_TYPES[scope.type]) {
      if (!contains(scope, use)) return false;
      break;
    }
    const lexicalBoundary =
      scope.type === "block" || scope.type === "lambda_expression" || scope.type === "ternary_expression";
    if (lexicalBoundary && !contains(scope, use)) return false;
    if (scope.type !== "ternary_expression") continue;
    const condition = scope.childForFieldName("condition");
    const consequence = scope.childForFieldName("consequence");
    const alternative = scope.childForFieldName("alternative");
    if (contains(condition, pattern)) {
      if (provesPattern(condition, pattern) && contains(alternative, use)) return false;
    } else {
      const operand = contains(consequence, pattern) ? consequence : alternative;
      if (!contains(operand, use)) return false;
    }
  }
  let conditional = pattern.parent;
  while (conditional && conditional.type !== "if_statement") {
    if (conditional.type === "block" || conditional.type === "method_declaration") return true;
    conditional = conditional.parent;
  }
  if (!conditional) return true;
  const positive = provesPattern(conditional.childForFieldName("condition"), pattern);
  const alternative = conditional.childForFieldName("alternative");
  if (contains(conditional, use)) {
    if (positive && contains(alternative, use)) return false;
    return true;
  }
  if (positive && !alternative) return false;
  if (positive && alternative?.type === "block") {
    const straightLine = alternative.namedChildren.every(
      (child) =>
        child.type === "expression_statement" ||
        child.type === "local_variable_declaration" ||
        child.type === "empty_statement",
    );
    if (straightLine) return false;
  }
  return true;
}
