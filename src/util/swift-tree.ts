import type { SyntaxNodeLike } from "../languages/types.js";

/**
 * The `user_type` that names the type a Swift `extension` extends, given that node or its single
 * identifier (a native capture resolves to the identifier when the path has one segment).
 * A generic argument or an inheritance clause also holds a `user_type`, but not in the `name` field.
 */
export function swiftExtensionOwnerType(node: SyntaxNodeLike): SyntaxNodeLike | null {
  const type = node.type === "user_type" ? node : node.parent;
  const container = type?.parent;
  if (type?.type !== "user_type" || container?.type !== "class_declaration") return null;
  if (container.childForFieldName("name")?.id !== type.id) return null;
  return container.childForFieldName("declaration_kind")?.text === "extension" ? type : null;
}

/** A segment of an extension header's type path: a use of an existing type, never a declaration. */
export function isSwiftExtensionTypeName(node: SyntaxNodeLike): boolean {
  return node.type === "type_identifier" && swiftExtensionOwnerType(node) !== null;
}

/**
 * The second or later segment of a dotted extension owner (`Inner` in `extension Outer.Inner`).
 * It is a member of the segments before it, so its own spelling proves no binding.
 */
export function isSwiftQualifiedExtensionSuffix(node: SyntaxNodeLike): boolean {
  if (!isSwiftExtensionTypeName(node)) return false;
  const segments = node.parent?.namedChildren ?? [];
  return segments.some((segment) => segment.type === "type_identifier" && segment.startIndex < node.startIndex);
}
