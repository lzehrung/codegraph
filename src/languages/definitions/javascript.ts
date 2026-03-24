import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";

const JS_OBJECT_METHOD_EXPORT_PATTERN = `
      ;; CJS: module.exports = { helper () {} }
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (function_declaration) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports")
`;

export const JAVASCRIPT_DEF: LanguageDefinition = {
  id: "js",
  extensions: [".js", ".jsx", ".mjs", ".cjs"],
  grammar: () => loadTreeSitterLanguage("tree-sitter-javascript"),
  structure: {
    blocks: [
      {
        type: "class_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "class",
      },
      {
        type: "function_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "function",
      },
      {
        type: "method_definition",
        nameQuery:
          "name: (_) @chunk.name body: (statement_block) @chunk.block.method",
        captureId: "method",
      },

      // Variable assignments (functions/arrows)
      {
        type: "lexical_declaration",
        nameQuery: `(variable_declarator name: (identifier) @chunk.name value: [ (function_expression body: (statement_block) @chunk.block.function) (arrow_function body: (statement_block) @chunk.block.function) ])`,
        captureId: "function",
      },
      {
        type: "variable_declaration",
        nameQuery: `(variable_declarator name: (identifier) @chunk.name value: [ (function_expression body: (statement_block) @chunk.block.function) (arrow_function body: (statement_block) @chunk.block.function) ])`,
        captureId: "function",
      },
      {
        type: "assignment_expression",
        nameQuery: `left: (_) @chunk.name right: [ (function_expression body: (statement_block) @chunk.block.function) (arrow_function body: (statement_block) @chunk.block.function) ]`,
        captureId: "function",
      },

      // Remaining functions
      {
        type: "arrow_function",
        nameQuery: "body: (statement_block) @chunk.block.function",
        captureId: "function",
      },
      {
        type: "function_expression",
        nameQuery: "body: (statement_block) @chunk.block.function",
        captureId: "function",
      },

      // Data & JSX
      // { type: "object", captureId: "data" },
      // { type: "jsx_element", captureId: "jsx" },
      // { type: "jsx_self_closing_element", captureId: "jsx" },

      // Top level vars
      { type: "import_statement", captureId: "imports" },
      {
        type: "lexical_declaration",
        nameQuery: `(variable_declarator name: (identifier) @chunk.name)`,
        captureId: "module_var",
        parentType: "program",
      },
      {
        type: "variable_declaration",
        nameQuery: `(variable_declarator name: (identifier) @chunk.name)`,
        captureId: "module_var",
        parentType: "program",
      },
    ],
    splitPoints: [
      "if_statement",
      "else_clause",
      "switch_statement",
      // "switch_case",
      // "switch_default",
      "for_statement",
      "for_in_statement",
      "while_statement",
      "do_statement",
      "try_statement",
      "catch_clause",
      "finally_clause",
    ],
    comments: ["comment"],
  },
  graph: {
    imports: `
      (import_statement (string) @mod) @stmt
      (export_statement (string) @mod) @stmt
      (call_expression function: (import) arguments: (arguments (string) @mod)) @stmt
      (call_expression function: (identifier) @fn arguments: (arguments (string) @mod)) (#eq? @fn "require")
    `,
    exports: `
      (export_statement) @stmt
      (export_statement (function_declaration name: (identifier) @name))
      (export_statement (class_declaration name: (identifier) @name))
      (export_statement (lexical_declaration (variable_declarator (identifier) @name)))
      (export_statement (export_clause (export_specifier name: (identifier) @src alias: (identifier) @alias)) (string) @from)
      (export_statement (export_clause (export_specifier name: (identifier) @src)) (string) @from)
      (export_statement (export_clause (export_specifier name: (identifier) @src alias: (identifier) @alias)))
      (export_statement (export_clause (export_specifier name: (identifier) @src)))
      (export_statement (string) @from)
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (shorthand_property_identifier) @cjs_shorthand)))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (identifier) @cjs_local))))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (member_expression object: (identifier) @mod property: (property_identifier) @prop) property: (property_identifier) @cjs_export_name)
        right: (identifier) @cjs_local))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @exp property: (property_identifier) @cjs_export_name)
        right: (identifier) @cjs_local))
        (#eq? @exp "exports")
      ;; CJS function/arrow direct exports
      (expression_statement (assignment_expression
        left: (member_expression object: (member_expression object: (identifier) @mod property: (property_identifier) @prop) property: (property_identifier) @cjs_export_name)
        right: (function) @cjs_fn))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (member_expression object: (identifier) @mod property: (property_identifier) @prop) property: (property_identifier) @cjs_export_name)
        right: (arrow_function) @cjs_fn))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @exp property: (property_identifier) @cjs_export_name)
        right: (function) @cjs_fn))
        (#eq? @exp "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @exp property: (property_identifier) @cjs_export_name)
        right: (arrow_function) @cjs_fn))
        (#eq? @exp "exports")
      ;; CJS object export with function value
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (function) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (arrow_function) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports")
      ;; CJS: module.exports = { helper () {} }
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (function_declaration) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports")
    `,
    locals: `
      (function_declaration name: (identifier) @name)
      (class_declaration name: (identifier) @name)
      (variable_declarator name: (identifier) @name)
    `,
    importBindings: `
      (import_statement) @stmt
      (import_statement (string) @from) @stmt
      (import_statement (import_clause (identifier) @def) (string) @from) @stmt
      (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname alias: (identifier) @alias))) (string) @from) @stmt
      (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname))) (string) @from) @stmt
      (import_statement (import_clause (namespace_import (identifier) @ns)) (string) @from) @stmt
      (lexical_declaration (variable_declarator name:(identifier) @def value: (call_expression (identifier) @req arguments: (arguments (string) @from)))) (#eq? @req "require")
      (lexical_declaration (variable_declarator (object_pattern) @pattern value: (call_expression (identifier) @req arguments: (arguments (string) @from)))) (#eq? @req "require")
    `,
  },
  nodeTypes: {
    identifier: ["identifier"],
    propertyIdentifier: ["property_identifier"],
    shorthandPropertyIdentifier: ["shorthand_property_identifier"],
    memberExpression: "member_expression",
  },
  classifyDefinition: (n) => {
    const t = n.parent?.type;
    if (t === "function_declaration") return "function";
    if (t === "class_declaration") return "class";
    return "variable";
  },
  isDeclarationName: (node) => {
    const p = node.parent?.type;
    return (
      !!p &&
      [
        "function_declaration",
        "class_declaration",
        "variable_declarator",
        "import_specifier",
        "namespace_import",
        "import_clause",
        // Method names in classes: needed so that editing a method name is
        // classified as a definition change, not an unrecognised node.
        "method_definition",
      ].includes(p)
    );
  },
  createsBlockScope: (n) => n.type === "program" || n.type === "block",
  createsFunctionScope: (n) =>
    n.type === "function_declaration" ||
    n.type === "function" ||
    n.type === "function_expression" ||
    n.type === "arrow_function" ||
    n.type === "method_definition",
  supportsCrossModuleSymbols: true,
  native: {
    normalizeQuery: (_kind, query) =>
      query
        .replace(/\(function\)/g, "(function_expression)")
        .replace(JS_OBJECT_METHOD_EXPORT_PATTERN, "\n"),
    notes: [
      "normalizes function node compatibility for native javascript grammar",
    ],
  },
};
registerLanguage(JAVASCRIPT_DEF);
