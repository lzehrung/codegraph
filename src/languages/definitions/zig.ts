import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";

export const ZIG_DEF: LanguageDefinition = {
  id: "zig",
  extensions: [".zig"],
  grammar: () => loadTreeSitterLanguage("@tree-sitter-grammars/tree-sitter-zig"),
  structure: {
    blocks: [
      { type: "function_declaration", nameQuery: "name: (identifier) @chunk.name", captureId: "function" },
      { type: "test_declaration", nameQuery: "(string) @chunk.name", captureId: "test" },
    ],
    splitPoints: ["if_expression", "for_expression", "while_expression", "switch_expression"],
    comments: ["line_comment", "doc_comment"],
  },
  graph: {
    imports: '(builtin_function (builtin_identifier) @fn (arguments (string) @mod) (#eq? @fn "@import")) @stmt',
    exports: `
      (function_declaration name: (identifier) @name)
      (variable_declaration (identifier) @name)
    `,
    locals: `
      (function_declaration name: (identifier) @name)
      (parameter (identifier) @name)
      (variable_declaration (identifier) @name)
    `,
    importBindings: `
      (variable_declaration
        (identifier) @alias
        (builtin_function (builtin_identifier) @fn (arguments (string) @from) (#eq? @fn "@import"))
      ) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["identifier"],
    memberExpression: "field_access",
  },
  supportsCrossModuleSymbols: true,
  createsFunctionScope: (node) => node.type === "function_declaration",
  createsBlockScope: (node) => node.type === "block",
  isDeclarationName: (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (parent.type === "function_declaration" && parent.childForFieldName("name")?.id === node.id) return true;
    return parent.type === "variable_declaration";
  },
};

registerLanguage(ZIG_DEF);
