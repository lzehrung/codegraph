import type { SyntaxNodeLike } from "../../languages/types.js";
import { isJavaSwitchLabelName } from "../../util/java-designators.js";
import { findClosestScopeBinding } from "../navigation-local.js";
import { UNPROVEN_JAVA_SWITCH_CASE_REASON } from "../ambiguous-resolution.js";
import type { NameLookupState, NameResolution } from "../name-resolution-types.js";
import { SymbolKind } from "../types.js";

/** Parameters and non-final locals are never Java constant expressions. */
function cannotBeCaseConstant(state: NameLookupState): boolean {
  const { use, closestBinding } = state;
  const normalize = use.parsed.sup.normalizeIdentifier;
  const wanted = normalize(state.lookupName);
  for (let current = use.node.parent; current; current = current.parent) {
    if (current.type === "method_declaration" || current.type === "constructor_declaration") break;
    if (current.type !== "catch_clause" && current.type !== "enhanced_for_statement") continue;
    const body = current.childForFieldName("body");
    if (!body || use.node.startIndex < body.startIndex || use.node.endIndex > body.endIndex) continue;
    const parameter =
      current.type === "catch_clause"
        ? current.namedChildren.find((child) => child.type === "catch_formal_parameter")
        : current;
    const name = parameter?.childForFieldName("name");
    if (name && normalize(name.text) === wanted) return true;
  }
  if (!closestBinding || closestBinding.import) return false;
  if (closestBinding.kind === "param") return true;
  if (closestBinding.kind !== "local") return false;
  let declaration = closestBinding.node?.parent;
  if (declaration?.type === "variable_declarator") declaration = declaration.parent;
  if (declaration?.type === "field_declaration" || declaration?.type === "constant_declaration") return false;
  if (declaration?.type === "enum_constant") return false;
  if (declaration?.type !== "local_variable_declaration") return true;
  const modifiers = declaration.namedChildren.find((child) => child.type === "modifiers");
  for (let index = 0; modifiers; index += 1) {
    const token = modifiers.child(index);
    if (!token) break;
    if (token.type === "final") return false;
  }
  return true;
}

/** A proven enum subject owns its labels; otherwise retain the ordinary constant lookup. */
export function javaSwitchCase(
  state: NameLookupState,
  rest: () => NameResolution | null,
): NameResolution | null | undefined {
  const { use } = state;
  if (!isJavaSwitchLabelName(use.node)) return undefined;
  const fallback = (): NameResolution | null =>
    cannotBeCaseConstant(state) ? { status: "not_found", reason: UNPROVEN_JAVA_SWITCH_CASE_REASON } : rest();
  let switchNode: SyntaxNodeLike | null = use.node.parent;
  while (switchNode && switchNode.type !== "switch_expression") switchNode = switchNode.parent;
  if (!switchNode) return fallback();
  let subject = switchNode.childForFieldName("condition");
  while (subject?.type === "parenthesized_expression") subject = subject.namedChildren[0] ?? null;
  if (subject?.type !== "identifier") return fallback();
  const binding = findClosestScopeBinding(use.scopeIndex, subject.text, subject, use.parsed.sup);
  let declaration = binding?.node?.parent;
  if (declaration?.type === "variable_declarator") declaration = declaration.parent;
  const type = declaration?.childForFieldName("type");
  if (!type || type.type === "integral_type") return fallback();
  return {
    status: "deferred",
    request: {
      kind: "contextual-member",
      owner: type,
      expectedKind: SymbolKind.Variable,
      jvmTypeOnly: true,
      ownerDeclarationType: "enum_declaration",
      memberDeclarationType: "enum_constant",
    },
    fallback: fallback(),
  };
}
