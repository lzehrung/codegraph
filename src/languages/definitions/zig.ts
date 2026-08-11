import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";

const ZIG_TYPE_INITIALIZER_TYPES = new Set([
  "builtin_type",
  "struct_declaration",
  "enum_declaration",
  "union_declaration",
  "opaque_declaration",
  "error_set_declaration",
]);

export const ZIG_DEF: LanguageDefinition = {
  id: "zig",
  extensions: [".zig"],
  grammar: () => loadTreeSitterLanguage("@tree-sitter-grammars/tree-sitter-zig"),
  usesQueryDrivenLocals: true,
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
    memberExpression: "field_expression",
  },
  supportsCrossModuleSymbols: true,
  classifyDefinition: (node) => {
    const parent = node.parent;
    if (!parent) return "variable";
    if (parent.type === "function_declaration") return "function";
    if (parent.type !== "variable_declaration") return "variable";

    const declaredName = parent.namedChildren.find((child) => child.type === "identifier");
    if (declaredName?.id !== node.id) return "variable";

    const initializer = parent.namedChildren.find((child) => child.id !== node.id);
    if (initializer && ZIG_TYPE_INITIALIZER_TYPES.has(initializer.type)) return "type";
    return "variable";
  },
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
