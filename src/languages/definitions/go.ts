import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { classifyByParentType, isNameFieldOnParent, matchesParentTypePairs, nodeTypeIn } from "./shared.js";

export const GO_DEF: LanguageDefinition = {
  id: "go",
  extensions: [".go"],
  usesQueryDrivenLocals: true,
  structure: {
    blocks: [
      {
        type: "function_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "function",
      },
      {
        type: "method_declaration",
        nameQuery: "name: (field_identifier) @chunk.name",
        captureId: "method",
      },
      {
        type: "type_declaration",
        nameQuery: "(type_spec name: (type_identifier) @chunk.name)",
        captureId: "type",
      },
    ],
    splitPoints: [
      "if_statement",
      "for_statement",
      "expression_switch_statement",
      "type_switch_statement",
      "select_statement",
    ],
    comments: ["comment"],
  },
  graph: {
    imports: `
      (import_spec path: (interpreted_string_literal) @from) @stmt
    `,
    exports: `
      (function_declaration name: (identifier) @name)
      (method_declaration name: (field_identifier) @name)
      (source_file (type_declaration (type_spec name: (type_identifier) @name)))
      (source_file (const_declaration (const_spec (identifier) @name)))
      (source_file (var_declaration (var_spec (identifier) @name)))
    `,
    locals: `
      (function_declaration name: (identifier) @name)
      (method_declaration name: (field_identifier) @name)
      (type_spec name: (type_identifier) @name)
      (parameter_declaration name: (identifier) @name)
      (variadic_parameter_declaration name: (identifier) @name)
      (type_parameter_declaration name: (identifier) @name)
      (short_var_declaration left: (expression_list (identifier) @name))
      (var_spec (identifier) @name)
      (const_spec (identifier) @name)
      (type_spec type: (struct_type (field_declaration_list (field_declaration name: (field_identifier) @name))))
      (range_clause left: (expression_list (identifier) @name) (#not-eq? @name "_"))
    `,
    importBindings: `
      (import_spec name: (dot) @wild path: (interpreted_string_literal) @from) @stmt
      (import_spec name: (package_identifier) @alias path: (interpreted_string_literal) @from) @stmt
      (import_spec name: (blank_identifier) @alias path: (interpreted_string_literal) @from) @stmt
      (import_spec path: (interpreted_string_literal) @from) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["identifier", "field_identifier", "type_identifier", "package_identifier"],
    memberExpression: "selector_expression",
  },
  supportsCrossModuleSymbols: true,
  classifyDefinition: classifyByParentType({
    function_declaration: "function",
    method_declaration: "function",
    type_spec: { kind: "type", nameField: "name" },
    type_parameter_declaration: "type",
  }),
  createsFunctionScope: nodeTypeIn(["function_declaration", "method_declaration", "func_literal"]),
  createsBlockScope: nodeTypeIn(["block", "for_statement"]),
  isDeclarationName: (node) =>
    isNameFieldOnParent(node, ["function_declaration", "method_declaration", "type_spec"]) ||
    matchesParentTypePairs(node, [
      ["var_spec", "identifier"],
      ["const_spec", "identifier"],
      ["type_parameter_declaration", "identifier"],
      // Only parameter *names* — never type-position identifiers (e.g. builtin `int` or type param `T`).
      ["parameter_declaration", "identifier"],
      ["variadic_parameter_declaration", "identifier"],
      ["field_declaration", "field_identifier"],
    ]) ||
    (node.parent?.type === "expression_list" &&
      node.parent.parent?.type === "short_var_declaration" &&
      node.type === "identifier") ||
    (node.parent?.type === "expression_list" &&
      node.parent.parent?.type === "range_clause" &&
      node.type === "identifier" &&
      node.text !== "_"),
  scopeDeclarationNames: (node) =>
    (node.type === "field_identifier" && node.parent?.type === "field_declaration") ||
    (node.type === "identifier" &&
      node.parent?.type === "expression_list" &&
      node.parent.parent?.type === "range_clause"),
};
registerLanguage(GO_DEF);
