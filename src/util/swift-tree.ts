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

/**
 * The name segments of a dotted Swift type through `node` (`Other` and `Base` for `Base` in `Other.Base`), or null when
 * `node` is not a later segment of a plain dotted type. Type arguments are not segments, and a generic owner
 * (`Outer<T>.Inner`) names a member of one specialization, so it proves no path.
 */
export function swiftQualifiedTypeSegments(node: SyntaxNodeLike): SyntaxNodeLike[] | null {
  const type = node.parent;
  if (node.type !== "type_identifier" || type?.type !== "user_type") return null;
  const segments: SyntaxNodeLike[] = [];
  let genericOwner = false;
  for (const child of type.namedChildren) {
    if (child.type === "type_arguments") {
      if (segments.length) genericOwner = true;
      continue;
    }
    if (child.type !== "type_identifier") continue;
    if (genericOwner) return null;
    segments.push(child);
    if (child.startIndex === node.startIndex) break;
  }
  return segments.length > 1 ? segments : null;
}

/**
 * A later segment of a dotted type outside an extension header (`Base` in `Other.Base`). It is a nested type of the
 * segments before it, so its own spelling proves no binding.
 */
export function isSwiftQualifiedTypeSuffix(node: SyntaxNodeLike): boolean {
  if (node.type !== "type_identifier" || node.parent?.type !== "user_type" || isSwiftExtensionTypeName(node)) {
    return false;
  }
  const segments = node.parent.namedChildren;
  return segments.some((segment) => segment.type === "type_identifier" && segment.startIndex < node.startIndex);
}
