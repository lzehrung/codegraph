import type { SyntaxNodeLike } from "../languages/types.js";

const ARRAY_CREATION_TYPES: ReadonlySet<string> = new Set([
  "array_creation_expression",
  "implicit_array_creation_expression",
  "stackalloc_expression",
  "implicit_stackalloc_expression",
]);

const DESIGNATOR_PARENT_TYPES: ReadonlySet<string> = new Set([
  "with_initializer",
  "subpattern",
  "anonymous_object_creation_expression",
  "attribute_argument",
]);

function sameNode(left: SyntaxNodeLike | null | undefined, right: SyntaxNodeLike): boolean {
  if (!left) return false;
  if (left.id !== undefined && right.id !== undefined) return left.id === right.id;
  return left.type === right.type && left.startIndex === right.startIndex && left.endIndex === right.endIndex;
}

function followingTokenType(node: SyntaxNodeLike): string | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  for (let position = 0; ; position += 1) {
    const child = parent.child(position);
    if (!child) return undefined;
    if (sameNode(child, node)) return parent.child(position + 1)?.type;
  }
}

/** A member, argument, or tuple label rather than a lexical name. */
export function isCsharpMemberDesignator(node: SyntaxNodeLike): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "argument") return sameNode(parent.childForFieldName("name"), node);
  if (DESIGNATOR_PARENT_TYPES.has(parent.type)) {
    const following = followingTokenType(node);
    return following === "=" || following === ":";
  }
  if (parent.type !== "assignment_expression" || !sameNode(parent.childForFieldName("left"), node)) return false;
  const container = parent.parent;
  if (container?.type === "attribute_argument") return true;
  if (container?.type !== "initializer_expression" || ARRAY_CREATION_TYPES.has(container.parent?.type ?? ""))
    return false;
  // Error recovery can parse a statement block as an initializer; semicolons prove it is not one.
  if (
    container.parent?.type === "ERROR" &&
    container.namedChildren.some((child) => child.type === "ERROR" && child.text === ";")
  ) {
    return false;
  }
  return true;
}

/** Tuple labels and explicit anonymous-property names never name an existing indexed declaration. */
export function csharpUnprovenReferenceCandidate(node: SyntaxNodeLike, definitionName: SyntaxNodeLike): boolean {
  const parent = node.parent;
  const parameterList = definitionName.parent?.parent;
  const recordParameter =
    parameterList?.type === "parameter_list" && parameterList.parent?.type === "record_declaration";
  const parameter =
    !recordParameter && (definitionName.parent?.type === "parameter" || definitionName.type === "implicit_parameter");
  if (parameter && parent?.type === "member_access_expression" && sameNode(parent.childForFieldName("name"), node)) {
    return false;
  }
  if (parameter && parent?.type === "member_binding_expression") return false;
  if (parent?.type === "anonymous_object_creation_expression") return !isCsharpMemberDesignator(node);
  if (parent?.type !== "argument") return true;
  if (parent.parent?.type !== "tuple_expression") return true;
  return !isCsharpMemberDesignator(node);
}

/** Explicit type syntax for an object initializer or a type-qualified property pattern. */
export function csharpDesignatorType(node: SyntaxNodeLike): SyntaxNodeLike | null {
  const parent = node.parent;
  if (!parent) return null;
  if (parent.type === "assignment_expression") {
    const initializer = parent.parent;
    const creation = initializer?.type === "initializer_expression" ? initializer.parent : null;
    if (creation?.type === "object_creation_expression") return creation.childForFieldName("type");
  }
  if (parent.type === "subpattern") {
    const clause = parent.parent;
    const pattern = clause?.type === "property_pattern_clause" ? clause.parent : null;
    if (pattern?.type === "recursive_pattern") return pattern.childForFieldName("type");
  }
  if (parent.type === "with_initializer") {
    const expression = parent.parent;
    const receiver = expression?.type === "with_expression" ? expression.child(0) : null;
    if (receiver?.type === "object_creation_expression") return receiver.childForFieldName("type");
    if (receiver?.type === "this") {
      for (let owner = expression?.parent; owner; owner = owner.parent) {
        if (
          owner.type === "class_declaration" ||
          owner.type === "struct_declaration" ||
          owner.type === "record_declaration"
        ) {
          return owner.childForFieldName("name");
        }
      }
    }
  }
  return null;
}

/** A simple receiver whose declared type can supply an omitted pattern or with-expression type. */
export function csharpDesignatorReceiver(node: SyntaxNodeLike): SyntaxNodeLike | null {
  const parent = node.parent;
  if (parent?.type === "with_initializer") {
    const expression = parent.parent;
    const receiver = expression?.type === "with_expression" ? expression.child(0) : null;
    return receiver?.type === "identifier" ? receiver : null;
  }
  if (parent?.type === "subpattern") {
    const pattern = parent.parent?.parent;
    const expression = pattern?.type === "recursive_pattern" ? pattern.parent : null;
    if (expression?.type !== "is_pattern_expression") return null;
    const receiver = expression.childForFieldName("expression");
    return receiver?.type === "identifier" ? receiver : null;
  }
  return null;
}

/** The invocation or construction containing a named argument, if it has a callable owner. */
export function csharpNamedArgumentCall(node: SyntaxNodeLike): SyntaxNodeLike | null {
  const argument = node.parent;
  if (argument?.type !== "argument" || !sameNode(argument.childForFieldName("name"), node)) return null;
  const list = argument.parent;
  if (list?.type !== "argument_list") return null;
  const call = list.parent;
  return call?.type === "invocation_expression" || call?.type === "object_creation_expression" ? call : null;
}
