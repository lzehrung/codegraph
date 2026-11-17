import type { SyntaxNodeLike } from "../../languages/types.js";
import type { Binding } from "../scope-types.js";

/** Callable parameters are in scope in attributes on the callable and its parameters. */
export function csharpAttributeParameterCoversUse(
  binding: { kind?: Binding["kind"]; node?: SyntaxNodeLike },
  use: SyntaxNodeLike,
): boolean {
  const parameter = binding.node?.parent;
  if (binding.kind !== "param" || parameter?.type !== "parameter") return false;
  const parameters = parameter.parent;
  if (parameters?.type !== "parameter_list") return false;
  const owner = parameters.parent;
  if (
    owner?.type !== "method_declaration" &&
    owner?.type !== "constructor_declaration" &&
    owner?.type !== "local_function_statement"
  ) {
    return false;
  }

  for (let current = use.parent; current && current.id !== owner.id; current = current.parent) {
    if (current.type !== "attribute_argument") continue;
    const attribute = current.parent?.parent;
    const list = attribute?.type === "attribute" ? attribute.parent : null;
    if (list?.type !== "attribute_list") return false;
    let attributed = list.parent;
    if (attributed?.type === "parameter") attributed = attributed.parent?.parent ?? null;
    return attributed?.id === owner.id;
  }
  return false;
}
