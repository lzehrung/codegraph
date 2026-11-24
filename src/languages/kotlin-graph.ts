import type { SyntaxNodeLike } from "./types.js";

/** Receiver spellings before an extension's name: a type, a nullable type, or a parenthesized type. */
const EXTENSION_RECEIVER_TYPES: Readonly<Record<string, true>> = {
  user_type: true,
  nullable_type: true,
  parenthesized_type: true,
};

/** The receiver type before an extension or anonymous function's name/parameters. */
export function kotlinExtensionReceiverType(node: SyntaxNodeLike): SyntaxNodeLike | null {
  let name: SyntaxNodeLike | null | undefined;
  if (node.type === "function_declaration") name = node.childForFieldName("name");
  else if (node.type === "property_declaration") {
    name = node.namedChildren.find((child) => child.type === "variable_declaration");
  } else if (node.type === "anonymous_function") {
    name = node.namedChildren.find((child) => child.type === "function_value_parameters");
  } else return null;
  if (!name) return null;
  return (
    node.namedChildren.find((child) => child.startIndex < name.startIndex && EXTENSION_RECEIVER_TYPES[child.type]) ??
    null
  );
}
