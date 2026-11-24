import type { SyntaxNodeLike } from "../../languages/types.js";

function swiftDeclarationKind(container: SyntaxNodeLike): string {
  const kind = container.childForFieldName("declaration_kind");
  if (kind) {
    const text = kind.text.trim();
    if (text) return text;
  }
  for (let index = 0; ; index += 1) {
    const child = container.child(index);
    if (!child) return "";
    const text = child.text.trim();
    if (text === "extension" || text === "class" || text === "struct" || text === "enum" || text === "actor") {
      return text;
    }
  }
}

/** The enclosing extension, unless an intervening nominal type owns the member instead. */
export function enclosingSwiftExtension(node: SyntaxNodeLike): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (current.type === "class_declaration") {
      return swiftDeclarationKind(current) === "extension" ? current : null;
    }
    current = current.parent;
  }
  return null;
}
