import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { classifyByParentType, hasParentType, nodeTypeIn } from "./shared.js";

/** Parent types whose direct `identifier` child is a declared name. */
const KOTLIN_DECLARATION_NAME_PARENT_TYPES = [
  "class_declaration",
  "object_declaration",
  "function_declaration",
  "type_alias",
  "variable_declaration",
  "parameter",
  "class_parameter",
  "enum_entry",
  "type_parameter",
];

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
      (import (qualified_identifier) @from) @stmt
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
  classifyDefinition: classifyByParentType({
    class_declaration: "class",
    object_declaration: "class",
    function_declaration: "function",
    type_alias: "type",
  }),
  // The Kotlin grammar exposes no `name` field on these declarations, so the declared
  // name is identified by parent type with a plain `identifier` child.
  isDeclarationName: (node) => node.type === "identifier" && hasParentType(node, KOTLIN_DECLARATION_NAME_PARENT_TYPES),
  scopeDeclarationNames: "all",
  createsFunctionScope: nodeTypeIn(["function_declaration", "anonymous_function", "lambda_literal"]),
  createsBlockScope: nodeTypeIn(["function_body", "class_body", "block", "catch_block", "finally_block"]),
  supportsCrossModuleSymbols: true,
  membersAreImplicitlyInScope: true,
  exportScopeBlockers: ["function_body", "lambda_literal", "anonymous_function"],
};
registerLanguage(KOTLIN_DEF);
