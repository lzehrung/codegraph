import type { LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import { sliceText, unquote } from "./ast.js";
import { MEMBER_ACCESS_ROWS, type MemberAccessChild } from "./member-access-tables.js";

export type MemberAccessParts = {
  object: SyntaxNodeLike | null;
  property: SyntaxNodeLike | null;
};

export type MemberAccessChain = {
  base: SyntaxNodeLike;
  names: string[];
};

/**
 * Member-access node types accepted for every language. The list is deliberately wider than any
 * one grammar: node types are language-scoped in practice, so an over-broad shared list cannot
 * cross-match between two parses.
 */
const GENERIC_MEMBER_ACCESS_TYPES: Record<string, true> = {
  member_access_expression: true,
  qualified_name: true,
  field_access: true,
  method_invocation: true,
  scoped_identifier: true,
  scoped_type_identifier: true,
  qualified_identifier: true,
  call: true,
  scope_resolution: true,
  field_expression: true,
  attribute: true,
  navigation_expression: true,
};

export function memberExpressionTypeFor(sup: LanguageSupport): string {
  if (sup.nodeTypes.memberExpression) return sup.nodeTypes.memberExpression;
  return MEMBER_ACCESS_ROWS[sup.id]?.memberExpressionType ?? "member_expression";
}

export function memberPropertyIdentifierTypes(sup: LanguageSupport): string[] {
  return [...(sup.nodeTypes.propertyIdentifier ?? ["property_identifier"])];
}

export function memberReferencePropertyIdentifierTypes(sup: LanguageSupport): string[] {
  return [...memberPropertyIdentifierTypes(sup), "field_identifier", "type_identifier", "identifier", "constant"];
}

export function memberAccessTraversalTypes(sup: LanguageSupport): Set<string> {
  const types = new Set<string>([
    memberExpressionTypeFor(sup),
    "optional_member_expression",
    "subscript_expression",
    "optional_chain",
  ]);
  for (const nodeType of MEMBER_ACCESS_ROWS[sup.id]?.extraTraversalTypes ?? []) types.add(nodeType);
  return types;
}

export function isMemberAccessNode(sup: LanguageSupport, node: SyntaxNodeLike): boolean {
  return (
    node.type === memberExpressionTypeFor(sup) ||
    GENERIC_MEMBER_ACCESS_TYPES[node.type] ||
    (MEMBER_ACCESS_ROWS[sup.id]?.extraMemberAccessTypes?.includes(node.type) ?? false)
  );
}

export function isMemberObjectIdentifier(nodeType: string): boolean {
  return (
    nodeType === "identifier" ||
    nodeType === "type_identifier" ||
    nodeType === "package_identifier" ||
    nodeType === "constant" ||
    nodeType === "namespace_identifier" ||
    nodeType === "simple_identifier" ||
    nodeType === "instance_variable" ||
    nodeType === "class_variable"
  );
}

/** Identifier-like nodes that can name a receiver, including Ruby `@ivar`/`@@cvar`. */
export function isReceiverNameNode(sup: LanguageSupport, nodeType: string): boolean {
  return sup.nodeTypes.identifier.includes(nodeType) || isMemberObjectIdentifier(nodeType);
}

export function isMemberReferencePropertyIdentifier(sup: LanguageSupport, nodeType: string): boolean {
  return memberReferencePropertyIdentifierTypes(sup).includes(nodeType);
}

export function getNavigationExpressionProperty(sup: LanguageSupport, expr: SyntaxNodeLike): SyntaxNodeLike | null {
  const suffix = expr.namedChildren.find((child) => child.type === "navigation_suffix") ?? expr.child(1);
  if (!suffix) return null;
  const fromSuffix =
    suffix.childForFieldName("suffix") ??
    suffix.childForFieldName("name") ??
    suffix.namedChildren[0] ??
    suffix.child(0);
  if (fromSuffix) return fromSuffix;
  if (MEMBER_ACCESS_ROWS[sup.id]?.navigationFallbackLastChild) {
    return expr.namedChildren[expr.namedChildren.length - 1] ?? expr.child(2);
  }
  return null;
}

/**
 * Extracts one member-access child by tree-sitter field name, falling back to a positional child
 * when the field is absent, or reading it directly by (named) child index.
 *
 * Most languages model member access as `<object>.<property>`, so per-language
 * rows in `./member-access-tables.ts` only supply their field names instead of
 * repeating this shape.
 */
function shapeChild(memberNode: SyntaxNodeLike, child: MemberAccessChild): SyntaxNodeLike | null {
  if ("field" in child) return memberNode.childForFieldName(child.field) ?? memberNode.child(child.fallbackIndex);
  if ("index" in child) return memberNode.child(child.index);
  return memberNode.namedChildren[child.namedIndex] ?? memberNode.child(child.namedIndex);
}

export function getMemberAccessParts(sup: LanguageSupport, memberNode: SyntaxNodeLike): MemberAccessParts {
  // A shape without `nodeTypes` is the language's catch-all and must be its row's last entry.
  const shape = MEMBER_ACCESS_ROWS[sup.id]?.memberAccessShapes?.find(
    (candidate) => candidate.nodeTypes === undefined || candidate.nodeTypes.includes(memberNode.type),
  );
  if (shape) {
    const property =
      "navigation" in shape.property
        ? getNavigationExpressionProperty(sup, memberNode)
        : shapeChild(memberNode, shape.property);
    return { object: shapeChild(memberNode, shape.object), property };
  }
  return {
    object: memberNode.childForFieldName("object") ?? memberNode.child(0),
    property:
      memberNode.childForFieldName("property") ?? memberNode.childForFieldName("attribute") ?? memberNode.child(2),
  };
}

export function collectMemberAccessChain(args: {
  sup: LanguageSupport;
  source: string;
  chainNode: SyntaxNodeLike;
  constStringOf?: Map<string, string>;
}): MemberAccessChain | null {
  const names: string[] = [];
  let current: SyntaxNodeLike | null = args.chainNode;
  let base: SyntaxNodeLike | null = null;
  const traversalTypes = memberAccessTraversalTypes(args.sup);
  const propertyTypes = memberPropertyIdentifierTypes(args.sup);

  const pushPropertyName = (propNode: SyntaxNodeLike | null): void => {
    if (!propNode) return;
    if (propertyTypes.includes(propNode.type)) {
      names.push(sliceText(propNode, args.source));
      return;
    }
    if (propNode.type === "string") {
      names.push(unquote(sliceText(propNode, args.source)));
      return;
    }
    if (propNode.type !== "identifier") return;
    const keyName = sliceText(propNode, args.source);
    const value = args.constStringOf?.get(keyName);
    if (typeof value === "string") names.push(value);
  };

  while (current && traversalTypes.has(current.type)) {
    if (current.type === "subscript_expression") {
      base = current.child(0) ?? base;
      pushPropertyName(current.child(2));
      current = base;
      continue;
    }
    if (current.type === "optional_chain") {
      current = current.child(0);
      continue;
    }
    const parts = getMemberAccessParts(args.sup, current);
    base = parts.object ?? base;
    pushPropertyName(parts.property);
    current = base;
  }

  if (!current || !names.length) return null;
  return { base: current, names };
}
