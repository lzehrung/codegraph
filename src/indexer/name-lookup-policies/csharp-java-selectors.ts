import type { Binding } from "../scope-types.js";

const MEMBER_DECLARATIONS: ReadonlySet<string> = new Set([
  "constant_declaration",
  "enum_constant",
  "enum_member_declaration",
  "event_declaration",
  "event_field_declaration",
  "field_declaration",
  "property_declaration",
]);

/** Fields and properties also have scope kind `local`; only method-local values and parameters are excluded. */
export function blocksCsharpJavaSelectorBinding(binding: Pick<Binding, "kind" | "node">): boolean {
  if (binding.kind === "param") return true;
  if (binding.kind !== "local") return false;
  let declaration = binding.node?.parent;
  while (declaration) {
    if (MEMBER_DECLARATIONS.has(declaration.type)) return false;
    if (declaration.type !== "variable_declarator" && declaration.type !== "variable_declaration") break;
    declaration = declaration.parent;
  }
  return true;
}
