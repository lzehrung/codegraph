import type { SyntaxNode } from "tree-sitter";
import type { LanguageDefinition } from "../types.js";
import { loadTypeScriptGrammars } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";

const BASE_STRUCTURE = {
  blocks: [
    {
      type: "class_declaration",
      nameQuery: "name: (type_identifier) @chunk.name",
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

    // TS Specifics
    {
      type: "interface_declaration",
      nameQuery: "name: (type_identifier) @chunk.name",
      captureId: "interface",
    },
    {
      type: "enum_declaration",
      nameQuery: "name: [ (identifier) (type_identifier) ] @chunk.name",
      captureId: "enum",
    },
    {
      type: "type_alias_declaration",
      nameQuery: "name: (type_identifier) @chunk.name",
      captureId: "type_alias",
    },
    {
      type: "internal_module",
      nameQuery:
        "name: (identifier) @chunk.name body: (statement_block) @chunk.block.namespace",
      captureId: "namespace",
    },
    {
      type: "module",
      nameQuery:
        "name: (identifier) @chunk.name body: (statement_block) @chunk.block.namespace",
      captureId: "namespace",
    },

    // Data
    { type: "object", captureId: "data" },

    // Top level vars
    { type: "import_statement", captureId: "imports", parentType: "program" },
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
    "switch_case",
    "switch_default",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "try_statement",
    "catch_clause",
    "finally_clause",
  ],
  comments: ["comment"],
};

const BASE_GRAPH = {
  imports: `
    (import_statement (string) @mod) @stmt
    ;; import x = require("...") is represented via import_require_clause
    (import_statement (import_require_clause (string) @mod)) @stmt
    (export_statement (string) @mod) @stmt
    (call_expression function: (import) arguments: (arguments (string) @mod)) @stmt
  `,
  exports: `
    (export_statement) @stmt
    (export_statement (function_declaration name: (identifier) @name)) @stmt
    (export_statement (class_declaration name: (identifier) @name)) @stmt
    (export_statement (lexical_declaration (variable_declarator name: (identifier) @name))) @stmt
    (export_statement (export_clause (export_specifier name: (identifier) @src alias: (identifier) @alias)) (string) @from) @stmt
    (export_statement (export_clause (export_specifier name: (identifier) @src)) (string) @from) @stmt
    (export_statement (export_clause (export_specifier name: (identifier) @src alias: (identifier) @alias))) @stmt
    (export_statement (export_clause (export_specifier name: (identifier) @src))) @stmt
    (export_statement (string) @from) @stmt
    (export_statement (function_declaration name: (identifier) @default)) @stmt (#match? @stmt "default")
    (export_statement (class_declaration name: (identifier) @default)) @stmt (#match? @stmt "default")
    (export_assignment (identifier) @ts_export_assign)
  `,
  locals: `
    (function_declaration name: (identifier) @name)
    (class_declaration name: (identifier) @name)
    (variable_declarator name: (identifier) @name)
    (interface_declaration name: (type_identifier) @name)
    (type_alias_declaration name: (type_identifier) @name)
  `,
  importBindings: `
    (import_statement) @stmt
    (import_statement (string) @from) @stmt
    (import_statement (import_require_clause (identifier) @def (string) @from)) @stmt
    (import_statement (import_clause (identifier) @def) (string) @from) @stmt
    (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname alias: (identifier) @alias))) (string) @from) @stmt
    (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname))) (string) @from) @stmt
    (import_statement (import_clause (namespace_import (identifier) @ns)) (string) @from) @stmt
  `,
};

const BASE_HELPERS = {
  nodeTypes: {
    identifier: ["identifier", "type_identifier"],
    propertyIdentifier: ["property_identifier"],
    shorthandPropertyIdentifier: ["shorthand_property_identifier"],
    memberExpression: "member_expression",
  },
  classifyDefinition: (n: SyntaxNode) => {
    const t = n.parent?.type;
    if (t === "function_declaration") return "function";
    if (t === "class_declaration") return "class";
    if (t === "interface_declaration") return "interface";
    if (t === "type_alias_declaration") return "type";
    return "variable";
  },
  isDeclarationName: (node: SyntaxNode) => {
    const p = node.parent?.type;
    return (
      !!p &&
      [
        "function_declaration",
        "class_declaration",
        "variable_declarator",
        "interface_declaration",
        "type_alias_declaration",
        "import_specifier",
        "namespace_import",
        "import_clause",
        "import_equals_declaration",
      ].includes(p)
    );
  },
  createsBlockScope: (n: SyntaxNode) =>
    n.type === "program" || n.type === "block",
  createsFunctionScope: (n: SyntaxNode) =>
    n.type === "function_declaration" ||
    n.type === "function" ||
    n.type === "function_expression" ||
    n.type === "arrow_function" ||
    n.type === "method_definition",
  supportsCrossModuleSymbols: true,
};

export const TYPESCRIPT_DEF: LanguageDefinition = {
  id: "ts",
  extensions: [".ts", ".mts", ".cts"],
  grammar: () => loadTypeScriptGrammars().typescript,
  structure: BASE_STRUCTURE,
  graph: BASE_GRAPH,
  ...BASE_HELPERS,
  isTypeOnly: (stmtText: string) => /\b(import|export)\s+type\b/.test(stmtText),
};
registerLanguage(TYPESCRIPT_DEF);

export const TSX_DEF: LanguageDefinition = {
  id: "tsx",
  extensions: [".tsx"],
  grammar: () => loadTypeScriptGrammars().tsx,
  structure: {
    ...BASE_STRUCTURE,
    blocks: [
      ...BASE_STRUCTURE.blocks,
      { type: "jsx_element", captureId: "jsx" },
      { type: "jsx_self_closing_element", captureId: "jsx" },
    ],
  },
  graph: BASE_GRAPH,
  ...BASE_HELPERS,
  isTypeOnly: (stmtText: string) => /\b(import|export)\s+type\b/.test(stmtText),
};
registerLanguage(TSX_DEF);
