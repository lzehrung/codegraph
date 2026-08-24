import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";

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
      (import_spec path: (interpreted_string_literal) @mod) @stmt
    `,
    exports: `
      (function_declaration name: (identifier) @name)
      (method_declaration name: (field_identifier) @name)
      (type_spec name: (type_identifier) @name)
      (const_spec name: (identifier) @name)
      (var_spec name: (identifier) @name)
    `,
    locals: `
      (function_declaration name: (identifier) @name)
      (method_declaration name: (field_identifier) @name)
      (type_spec name: (type_identifier) @name)
      (parameter_declaration name: (identifier) @name)
      (variadic_parameter_declaration name: (identifier) @name)
      (short_var_declaration left: (expression_list (identifier) @name))
      (var_spec name: (identifier) @name)
      (const_spec name: (identifier) @name)
      (type_spec type: (struct_type (field_declaration_list (field_declaration name: (field_identifier) @name))))
      (range_clause left: (expression_list (identifier) @name) (#not-eq? @name "_"))
    `,
    importBindings: `
      (import_spec name: (package_identifier) @alias path: (interpreted_string_literal) @from) @stmt
      (import_spec path: (interpreted_string_literal) @from) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["identifier", "field_identifier", "type_identifier", "package_identifier"],
    memberExpression: "selector_expression",
  },
  supportsCrossModuleSymbols: true,
  classifyDefinition: (node) => {
    const parent = node.parent;
    if (!parent) return "variable";
    if (parent.type === "function_declaration" || parent.type === "method_declaration") return "function";
    if (parent.type === "type_spec" && parent.childForFieldName("name")?.id === node.id) return "type";
    return "variable";
  },
  createsFunctionScope: (node) =>
    node.type === "function_declaration" || node.type === "method_declaration" || node.type === "func_literal",
  createsBlockScope: (node) => node.type === "block" || node.type === "for_statement",
  membersAreImplicitlyInScope: false,
  isDeclarationName: (node) => {
    const p = node.parent;
    if (!p) return false;
    if (p.type === "function_declaration" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "method_declaration" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "type_spec" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "var_spec" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "const_spec" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "expression_list" && p.parent?.type === "short_var_declaration") return node.type === "identifier";
    if (p.type === "expression_list" && p.parent?.type === "range_clause")
      return node.type === "identifier" && node.text !== "_";
    // Only parameter *names* — never type-position identifiers (e.g. builtin `int` or type param `T`).
    if (p.type === "parameter_declaration" || p.type === "variadic_parameter_declaration") {
      return node.type === "identifier";
    }
    if (p.type === "field_declaration" && node.type === "field_identifier") return true;
    return false;
  },
  scopeDeclarationNames: (node) =>
    (node.type === "field_identifier" && node.parent?.type === "field_declaration") ||
    (node.type === "identifier" &&
      node.parent?.type === "expression_list" &&
      node.parent.parent?.type === "range_clause"),
};
registerLanguage(GO_DEF);
