import type { LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import { sliceText, unquote } from "../util.js";

export type MemberAccessParts = {
  object: SyntaxNodeLike | null;
  property: SyntaxNodeLike | null;
};

export type MemberAccessChain = {
  base: SyntaxNodeLike;
  names: string[];
};

export function memberExpressionTypeFor(sup: LanguageSupport): string {
  if (sup.nodeTypes.memberExpression) return sup.nodeTypes.memberExpression;
  if (sup.id === "python") return "attribute";
  if (sup.id === "ruby") return "call";
  return "member_expression";
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
  if (sup.id === "go") types.add("qualified_type");
  if (sup.id === "python") types.add("attribute");
  if (sup.id === "kotlin" || sup.id === "swift") types.add("navigation_expression");
  return types;
}

export function isMemberAccessNode(sup: LanguageSupport, node: SyntaxNodeLike): boolean {
  const memberExpressionType = memberExpressionTypeFor(sup);
  return (
    node.type === memberExpressionType ||
    (sup.id === "go" && node.type === "qualified_type") ||
    node.type === "member_access_expression" ||
    node.type === "qualified_name" ||
    node.type === "field_access" ||
    node.type === "method_invocation" ||
    node.type === "scoped_identifier" ||
    node.type === "scoped_type_identifier" ||
    node.type === "call" ||
    node.type === "scope_resolution" ||
    node.type === "field_expression" ||
    node.type === "attribute" ||
    node.type === "navigation_expression"
  );
}

export function isMemberObjectIdentifier(nodeType: string): boolean {
  return (
    nodeType === "identifier" ||
    nodeType === "type_identifier" ||
    nodeType === "package_identifier" ||
    nodeType === "constant" ||
    nodeType === "namespace_identifier"
  );
}

export function isMemberReferencePropertyIdentifier(sup: LanguageSupport, nodeType: string): boolean {
  return memberReferencePropertyIdentifierTypes(sup).includes(nodeType);
}

export function getNavigationExpressionProperty(expr: SyntaxNodeLike): SyntaxNodeLike | null {
  const suffix = expr.namedChildren.find((child) => child.type === "navigation_suffix") ?? expr.child(1);
  if (!suffix) return null;
  return (
    suffix.childForFieldName("suffix") ?? suffix.childForFieldName("name") ?? suffix.namedChildren[0] ?? suffix.child(0)
  );
}

export function getMemberAccessParts(sup: LanguageSupport, memberNode: SyntaxNodeLike): MemberAccessParts {
  if (sup.id === "python") {
    return {
      object: memberNode.childForFieldName("object") ?? memberNode.child(0),
      property: memberNode.childForFieldName("attribute") ?? memberNode.child(2),
    };
  }
  if (sup.id === "csharp") {
    return {
      object: memberNode.child(0),
      property: memberNode.child(2),
    };
  }
  if (sup.id === "java") {
    if (memberNode.type === "method_invocation") {
      return {
        object: memberNode.childForFieldName("object") ?? memberNode.child(0),
        property: memberNode.childForFieldName("name") ?? memberNode.child(2),
      };
    }
    if (memberNode.type === "scoped_identifier" || memberNode.type === "scoped_type_identifier") {
      return {
        object: memberNode.childForFieldName("scope") ?? memberNode.child(0),
        property: memberNode.childForFieldName("name") ?? memberNode.child(2),
      };
    }
  }
  if (sup.id === "ruby") {
    if (memberNode.type === "scope_resolution") {
      return {
        object: memberNode.childForFieldName("scope") ?? memberNode.child(0),
        property: memberNode.childForFieldName("name") ?? memberNode.child(2),
      };
    }
    return {
      object: memberNode.childForFieldName("receiver") ?? memberNode.child(0),
      property: memberNode.childForFieldName("method") ?? memberNode.child(2),
    };
  }
  if (sup.id === "rust" && memberNode.type === "scoped_identifier") {
    return {
      object: memberNode.childForFieldName("path") ?? memberNode.child(0),
      property: memberNode.childForFieldName("name") ?? memberNode.child(2),
    };
  }
  if (sup.id === "go" && memberNode.type === "qualified_type") {
    return {
      object: memberNode.namedChildren[0] ?? memberNode.child(0),
      property: memberNode.namedChildren[1] ?? memberNode.child(1),
    };
  }
  if ((sup.id === "kotlin" || sup.id === "swift") && memberNode.type === "navigation_expression") {
    return {
      object: memberNode.namedChildren[0] ?? memberNode.child(0),
      property: getNavigationExpressionProperty(memberNode),
    };
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
