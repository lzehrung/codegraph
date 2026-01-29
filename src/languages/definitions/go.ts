import type { Language } from "tree-sitter";
import Go from "tree-sitter-go";
import type { LanguageDefinition } from "../types.js";

const LangGo = Go as unknown as Language;

export const GO_DEF: LanguageDefinition = {
  id: "go",
  extensions: [".go"],
  grammar: () => LangGo,
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
      (short_var_declaration left: (expression_list (identifier) @name))
    `,
    importBindings: `
      (import_spec name: (package_identifier) @alias path: (interpreted_string_literal) @from) @stmt
      (import_spec path: (interpreted_string_literal) @from) @stmt
    `,
  },
  nodeTypes: {
    identifier: [
      "identifier",
      "field_identifier",
      "type_identifier",
      "package_identifier",
    ],
    memberExpression: "selector_expression",
  },
  supportsCrossModuleSymbols: true,
  createsFunctionScope: (node) =>
    node.type === "function_declaration" ||
    node.type === "method_declaration" ||
    node.type === "func_literal",
  createsBlockScope: (node) => node.type === "block",
  isDeclarationName: (node) => {
    const p = node.parent;
    if (!p) return false;
    if (
      p.type === "function_declaration" &&
      p.childForFieldName("name")?.id === node.id
    )
      return true;
    if (
      p.type === "method_declaration" &&
      p.childForFieldName("name")?.id === node.id
    )
      return true;
    if (p.type === "type_spec" && p.childForFieldName("name")?.id === node.id)
      return true;
    if (p.type === "var_spec" && p.childForFieldName("name")?.id === node.id)
      return true;
    if (p.type === "const_spec" && p.childForFieldName("name")?.id === node.id)
      return true;
    if (p.type === "short_var_declaration") return true;
    if (p.type === "parameter_declaration") return true;
    return false;
  },
};
