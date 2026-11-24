/** A source-written constant path and the lexical scope from which its root is read. */
export type RubyConstantReference = {
  names: readonly string[];
  anchor: "lexical" | "top-level" | "self";
  namespaces: readonly string[];
  unprovenNamespace?: boolean;
};
