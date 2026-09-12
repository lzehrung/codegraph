import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
export const KOTLIN_DEF: LanguageDefinition = {
  id: "kotlin",
  extensions: [".kt", ".kts", ".ktm"],
  usesQueryDrivenLocals: true,
  structure: {
    blocks: [
      {
        type: "class_declaration",
        nameQuery: "(identifier) @chunk.name",
        captureId: "class",
      },
      {
        type: "object_declaration",
        nameQuery: "(identifier) @chunk.name",
        captureId: "object",
      },
      {
        type: "function_declaration",
        nameQuery: "(identifier) @chunk.name",
        captureId: "function",
      },
      {
        type: "property_declaration",
        nameQuery: "(variable_declaration (identifier) @chunk.name)",
        captureId: "property",
      },
      {
        type: "type_alias",
        nameQuery: "(identifier) @chunk.name",
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
    comments: ["line_comment", "block_comment"],
  },
  graph: {
    imports: `
      (import (qualified_identifier) @mod) @stmt
    `,
    exports: `
      (source_file
        [
          (class_declaration name: (identifier) @name)
          (object_declaration name: (identifier) @name)
          (function_declaration name: (identifier) @name)
          (property_declaration (variable_declaration (identifier) @name))
          (type_alias type: (identifier) @name)
        ])
      (class_body
        [
          (class_declaration name: (identifier) @name)
          (object_declaration name: (identifier) @name)
          (function_declaration name: (identifier) @name)
          (property_declaration (variable_declaration (identifier) @name))
          (type_alias type: (identifier) @name)
        ])
      (enum_class_body (enum_entry (identifier) @name))
    `,
    locals: `
      (class_declaration name: (identifier) @name)
      (object_declaration name: (identifier) @name)
      (function_declaration name: (identifier) @name)
      (property_declaration (variable_declaration (identifier) @name))
      (type_alias type: (identifier) @name)
      (enum_entry (identifier) @name)
      (parameter (identifier) @name)
      (class_parameter (identifier) @name)
      (type_parameter (identifier) @name)
    `,
    importBindings: `
      (import (qualified_identifier) @from (identifier) @alias) @stmt
      (import (qualified_identifier) @from ("*") @wild) @stmt
      (import (qualified_identifier) @from) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["identifier"],
    propertyIdentifier: ["identifier"],
    memberExpression: "navigation_expression",
  },
  classifyDefinition: (node) => {
    const parent = node.parent;
    if (!parent) return "variable";
    if (parent.type === "class_declaration" || parent.type === "object_declaration") return "class";
    if (parent.type === "function_declaration") return "function";
    if (parent.type === "type_alias") return "type";
    return "variable";
  },
  isDeclarationName: (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (parent.type === "class_declaration" && node.type === "identifier") return true;
    if (parent.type === "object_declaration" && node.type === "identifier") return true;
    if (parent.type === "function_declaration" && node.type === "identifier") return true;
    if (parent.type === "type_alias" && node.type === "identifier") return true;
    if (parent.type === "variable_declaration" && node.type === "identifier") return true;
    if (parent.type === "parameter" && node.type === "identifier") return true;
    if (parent.type === "class_parameter" && node.type === "identifier") return true;
    if (parent.type === "enum_entry" && node.type === "identifier") return true;
    if (parent.type === "type_parameter" && node.type === "identifier") return true;
    return false;
  },
  scopeDeclarationNames: "all",
  createsFunctionScope: (node) =>
    node.type === "function_declaration" || node.type === "anonymous_function" || node.type === "lambda_literal",
  createsBlockScope: (node) =>
    node.type === "function_body" ||
    node.type === "class_body" ||
    node.type === "block" ||
    node.type === "catch_block" ||
    node.type === "finally_block",
  supportsCrossModuleSymbols: true,
};
registerLanguage(KOTLIN_DEF);
