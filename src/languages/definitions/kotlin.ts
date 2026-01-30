import type { Language } from "tree-sitter";
import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";

const LangKotlin = loadTreeSitterLanguage("tree-sitter-kotlin");

export const KOTLIN_DEF: LanguageDefinition = {
  id: "kotlin",
  extensions: [".kt", ".kts"],
  grammar: () => LangKotlin,
  structure: {
    blocks: [
      {
        type: "class_declaration",
        nameQuery: "(type_identifier) @chunk.name",
        captureId: "class",
      },
      {
        type: "object_declaration",
        nameQuery: "(type_identifier) @chunk.name",
        captureId: "object",
      },
      {
        type: "function_declaration",
        nameQuery: "(simple_identifier) @chunk.name",
        captureId: "function",
      },
      {
        type: "property_declaration",
        nameQuery: "(variable_declaration (simple_identifier) @chunk.name)",
        captureId: "property",
      },
      {
        type: "type_alias",
        nameQuery: "(type_identifier) @chunk.name",
        captureId: "type",
      },
    ],
    splitPoints: [
      "if_expression",
      "when_expression",
      "for_statement",
      "while_statement",
      "do_while_statement",
      "try_expression",
      "catch_block",
      "finally_block",
    ],
    comments: ["line_comment", "multiline_comment"],
  },
  graph: {
    imports: `
      (import_header (identifier) @mod) @stmt
    `,
    exports: `
      (class_declaration (type_identifier) @name)
      (object_declaration (type_identifier) @name)
      (function_declaration (simple_identifier) @name)
      (property_declaration (variable_declaration (simple_identifier) @name))
      (type_alias (type_identifier) @name)
      (enum_entry (simple_identifier) @name)
    `,
    locals: `
      (class_declaration (type_identifier) @name)
      (object_declaration (type_identifier) @name)
      (function_declaration (simple_identifier) @name)
      (property_declaration (variable_declaration (simple_identifier) @name))
      (type_alias (type_identifier) @name)
      (enum_entry (simple_identifier) @name)
      (parameter (simple_identifier) @name)
      (class_parameter (simple_identifier) @name)
      (type_parameter (type_identifier) @name)
    `,
    importBindings: `
      (import_header (identifier) @from (import_alias (type_identifier) @alias)) @stmt
      (import_header (identifier) @from (wildcard_import) @wild) @stmt
      (import_header (identifier) @from) @stmt
    `,
  },
  nodeTypes: {
    identifier: [
      "identifier",
      "interpolated_identifier",
      "simple_identifier",
      "type_identifier",
    ],
    propertyIdentifier: ["simple_identifier", "type_identifier"],
    memberExpression: "navigation_expression",
  },
  classifyDefinition: (node) => {
    const parent = node.parent;
    if (!parent) return "variable";
    if (
      parent.type === "class_declaration" ||
      parent.type === "object_declaration"
    )
      return "class";
    if (parent.type === "function_declaration") return "function";
    if (parent.type === "type_alias") return "type";
    return "variable";
  },
  isDeclarationName: (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (parent.type === "class_declaration" && node.type === "type_identifier")
      return true;
    if (parent.type === "object_declaration" && node.type === "type_identifier")
      return true;
    if (
      parent.type === "function_declaration" &&
      node.type === "simple_identifier"
    )
      return true;
    if (parent.type === "type_alias" && node.type === "type_identifier")
      return true;
    if (
      parent.type === "variable_declaration" &&
      node.type === "simple_identifier"
    )
      return true;
    if (parent.type === "parameter" && node.type === "simple_identifier")
      return true;
    if (parent.type === "class_parameter" && node.type === "simple_identifier")
      return true;
    if (parent.type === "enum_entry" && node.type === "simple_identifier")
      return true;
    if (parent.type === "type_parameter" && node.type === "type_identifier")
      return true;
    return false;
  },
  createsFunctionScope: (node) =>
    node.type === "function_declaration" ||
    node.type === "anonymous_function" ||
    node.type === "lambda_literal",
  createsBlockScope: (node) =>
    node.type === "function_body" ||
    node.type === "class_body" ||
    node.type === "control_structure_body" ||
    node.type === "catch_block" ||
    node.type === "finally_block",
  supportsCrossModuleSymbols: true,
};
