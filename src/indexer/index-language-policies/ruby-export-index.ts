import type { SyntaxNodeLike } from "../../languages/types.js";
import { sliceText } from "../../util/ast.js";
import type { DeclarationHooks } from "../language-hook-types.js";

const RUBY_CONTAINER_TYPES = new Set(["class", "module"]);

/** Whether `container`'s own body (not a nested class or module) declares `name`. */
function rubyContainerDeclares(container: SyntaxNodeLike, name: string, source: string): boolean {
  const visit = (node: SyntaxNodeLike): boolean => {
    for (const child of node.namedChildren) {
      if (RUBY_CONTAINER_TYPES.has(child.type)) {
        const childName = child.childForFieldName("name");
        if (childName && sliceText(childName, source) === name) return true;
        continue;
      }
      if (visit(child)) return true;
    }
    return false;
  };
  return visit(container);
}

/**
 * Nested Ruby constants are not top-level names. `module Outer; class Base`
 * exports as `Outer::Base`, so a `require` cannot bind bare `Base`. A `scope_resolution`
 * name (`class Inner::Tool`) looks up its first segment lexically, as Ruby does: the
 * innermost enclosing class or module that declares `Inner` in this file supplies the
 * prefix (`Outer::Inner::Tool`); otherwise the path is top-level. A leading `::` is absolute.
 */
function rubyQualifiedExportName(nameNode: SyntaxNodeLike, source: string, name: string): string {
  if (name.startsWith("::")) return name.slice(2);
  const containers: { node: SyntaxNodeLike; text: string }[] = [];
  for (let current = nameNode.parent; current; current = current.parent) {
    if (!RUBY_CONTAINER_TYPES.has(current.type)) continue;
    const containerName = current.childForFieldName("name");
    if (!containerName) continue;
    const ownsExport = containerName.startIndex <= nameNode.startIndex && containerName.endIndex >= nameNode.endIndex;
    if (ownsExport) continue;
    const text = sliceText(containerName, source);
    if (text) containers.push({ node: current, text });
  }
  // `containers` is innermost first. A plain constant is owned by the innermost container; a
  // scope-resolution name by the innermost container that declares its first segment.
  let ownerIndex = 0;
  if (nameNode.type === "scope_resolution") {
    const firstSegment = name.split("::")[0] ?? name;
    ownerIndex = containers.findIndex((container) => rubyContainerDeclares(container.node, firstSegment, source));
    if (ownerIndex < 0) return name;
  } else if (nameNode.type !== "constant") {
    return name;
  }
  const prefix = containers
    .slice(ownerIndex)
    .reverse()
    .map((container) => container.text);
  return prefix.length ? `${prefix.join("::")}::${name}` : name;
}

export const rubyDeclarations: DeclarationHooks = { qualifiedExportName: rubyQualifiedExportName };
