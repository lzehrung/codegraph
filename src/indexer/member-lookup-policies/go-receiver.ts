import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { sliceText } from "../../util/ast.js";
import type { ReceiverSyntaxContext, ReceiverSyntaxDeps, ReceiverSyntaxRules } from "./types.js";

function bindingNames(node: SyntaxNodeLike): SyntaxNodeLike[] {
  if (node.type === "short_var_declaration") {
    const left = node.childForFieldName("left");
    return (left?.namedChildren ?? []).filter((child) => child.type === "identifier");
  }
  if (node.type === "var_spec") return (node.namedChildren ?? []).filter((child) => child.type === "identifier");
  return [];
}

function construction(
  node: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
  syntax: ReceiverSyntaxContext,
  deps: ReceiverSyntaxDeps,
): SyntaxNodeLike | null {
  if (node.type === "short_var_declaration") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left || !right) return null;
    const names = (left.namedChildren ?? []).filter((child) => child.type === "identifier");
    const values = right.namedChildren ?? [];
    const index = names.findIndex((name) => sliceText(name, source) === receiverName);
    if (index < 0) return null;
    const value = values[index] ?? null;
    return value ? deps.constructionTypeName(value, source, sup, syntax) : null;
  }
  if (node.type !== "var_spec") return null;
  const value = node.childForFieldName("value");
  if (value) {
    const first = value.type === "expression_list" ? (value.namedChildren[0] ?? null) : value;
    const fromValue = first ? deps.constructionTypeName(first, source, sup, syntax) : null;
    if (fromValue) return fromValue;
  }
  const typeNode = node.childForFieldName("type");
  return typeNode ? deps.unwrapNamedType(typeNode, sup) : null;
}

const PARALLEL_BINDING = { names: bindingNames, construction };
export const goReceiverSyntax: ReceiverSyntaxRules = {
  parallelBindings: { short_var_declaration: PARALLEL_BINDING, var_spec: PARALLEL_BINDING },
};
