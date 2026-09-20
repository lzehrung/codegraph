import type { BlockDefinition, SyntaxNodeLike } from "../types.js";
import { isNameFieldOnParent, isNameOrPropertyFieldOnParent } from "./shared.js";

/**
 * `import type` / `export type` statements. The JS grammar has no type-only syntax (the
 * keyword parses as an ERROR node), so this matches the statement text instead.
 */
export function isEcmaScriptTypeOnlyStatement(stmtText: string): boolean {
  return /\b(import|export)\s+type\b/.test(stmtText);
}

/** Declaration parents whose direct name child declares a name in both the JS and TS grammars. */
export const ECMASCRIPT_DECLARATION_NAME_PARENTS = [
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "import_specifier",
  "namespace_import",
  "import_clause",
  // Method names in classes: needed so that editing a method name is
  // classified as a definition change, not an unrecognised node.
  "method_definition",
  // A named function expression binds its own name; `$scope.x = function x() {}` and
  // `const f = function inner() {}` are the common shapes.
  "function_expression",
] as const;

export const ECMASCRIPT_BLOCK_SCOPE_TYPES = ["program", "block", "class_body", "class_static_block"] as const;

export const ECMASCRIPT_FUNCTION_SCOPE_TYPES = [
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
] as const;

/** A `variable_declarator`'s declared name (field identity; `const x = y` must not match `y`). */
export function isEcmaScriptVariableDeclaratorName(node: SyntaxNodeLike): boolean {
  return isNameFieldOnParent(node, ["variable_declarator"]);
}

/** A class field's declared name; the grammar spells the field `name` or `property`. */
export function isEcmaScriptFieldDefinitionName(node: SyntaxNodeLike, parentType: string): boolean {
  return isNameOrPropertyFieldOnParent(node, [parentType]);
}

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
