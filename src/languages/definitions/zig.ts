import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { isNameFieldOnParent, nodeTypeIn } from "./shared.js";

const ZIG_TYPE_INITIALIZER_TYPES = new Set([
  "builtin_type",
  "struct_declaration",
  "enum_declaration",
  "union_declaration",
  "opaque_declaration",
  "error_set_declaration",
  "error_union_type",
]);

export const ZIG_DEF: LanguageDefinition = {
  id: "zig",
  extensions: [".zig"],
  usesQueryDrivenLocals: true,
  structure: {
    blocks: [
      { type: "function_declaration", nameQuery: "name: (identifier) @chunk.name", captureId: "function" },
      { type: "test_declaration", nameQuery: "(string) @chunk.name", captureId: "test" },
    ],
    splitPoints: ["if_expression", "for_expression", "while_expression", "switch_expression"],
    comments: ["comment"],
  },
  graph: {
    imports: `
      (builtin_function (builtin_identifier) @fn (arguments (string) @from) (#eq? @fn "@import")) @stmt
      ;; @cImport has no path argument; the builtin identifier is the specifier.
      (builtin_function (builtin_identifier) @from (arguments) (#eq? @from "@cImport")) @stmt
    `,
    exports: `
      ;; Top-level names. The Zig declaration-visibility row keeps only pub declarations.
      (source_file (function_declaration name: (identifier) @name))
      (source_file (variable_declaration . (identifier) @name (_)))
    `,
    locals: `
      (function_declaration name: (identifier) @name)
      (parameter (identifier) @name)
      (variable_declaration . (identifier) @name (_))
    `,
    importBindings: `
      (variable_declaration
        (identifier) @alias
        (builtin_function (builtin_identifier) @fn (arguments (string) @from) (#eq? @fn "@import"))
      ) @stmt
      (variable_declaration
        (identifier) @alias
        (builtin_function (builtin_identifier) @from (arguments) (#eq? @from "@cImport"))
      ) @stmt
      (using_namespace_declaration
        (builtin_function (builtin_identifier) @fn (arguments (string) @from) (#eq? @fn "@import"))
      ) @stmt @wild
    `,
  },
  nodeTypes: {
    identifier: ["identifier"],
    memberExpression: "field_expression",
    propertyIdentifier: ["identifier"],
  },
  supportsCrossModuleSymbols: true,
  classifyDefinition: (node) => {
    const parent = node.parent;
    if (!parent) return "variable";
    if (parent.type === "function_declaration") return "function";
    if (parent.type !== "variable_declaration") return "variable";

    const declaredName = parent.namedChildren.find((child) => child.type === "identifier");
    if (declaredName?.id !== node.id) return "variable";

    let equalsEndIndex = -1;
    for (let index = 0; ; index++) {
      const child = parent.child(index);
      if (!child) break;
      if (child.type === "=") {
        equalsEndIndex = child.endIndex;
        break;
      }
    }
    const initializer = parent.namedChildren.find((child) => child.startIndex >= equalsEndIndex);
    if (initializer && ZIG_TYPE_INITIALIZER_TYPES.has(initializer.type)) return "type";
    return "variable";
  },
  createsFunctionScope: nodeTypeIn(["function_declaration"]),
  createsBlockScope: nodeTypeIn(["block"]),
  isDeclarationName: (node) =>
    isNameFieldOnParent(node, ["function_declaration"]) ||
    // No named field distinguishes the declared identifier from an initializer that is
    // itself a bare identifier (e.g. `const x = y;` puts both `x` and `y` directly under
    // `variable_declaration`); the declared name is always the first identifier child,
    // matching the lookup classifyDefinition above already relies on.
    (node.parent?.type === "variable_declaration" &&
      node.parent.namedChildren.find((child) => child.type === "identifier")?.id === node.id),
};

registerLanguage(ZIG_DEF);
