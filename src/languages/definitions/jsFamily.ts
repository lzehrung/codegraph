import type { BlockDefinition } from "../types.js";

export const ECMASCRIPT_CONTROL_SPLIT_POINTS = [
  "if_statement",
  "else_clause",
  "switch_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "try_statement",
  "catch_clause",
  "finally_clause",
] as const;

export const ECMASCRIPT_CORE_FUNCTION_BLOCKS: BlockDefinition[] = [
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
    type: "generator_function_declaration",
    nameQuery: "name: (identifier) @chunk.name",
    captureId: "function",
  },
  {
    type: "method_definition",
    nameQuery: "name: (_) @chunk.name body: (statement_block) @chunk.block.method",
    captureId: "method",
  },
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
];

export const ECMASCRIPT_MODULE_VAR_BLOCKS: BlockDefinition[] = [
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
];
