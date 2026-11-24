import type { SyntaxNodeLike } from "../../languages/types.js";

/** A template argument names an existing type instead of declaring a new name. */
export function isCppTemplateArgumentName(node: SyntaxNodeLike): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "template_argument_list") return true;
  }
  return false;
}
