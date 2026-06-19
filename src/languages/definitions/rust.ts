import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";

export const RUST_DEF: LanguageDefinition = {
  id: "rust",
  extensions: [".rs"],
  grammar: () => loadTreeSitterLanguage("tree-sitter-rust"),
  structure: {
    blocks: [
      {
        type: "function_item",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "function",
      },
      {
        type: "struct_item",
        nameQuery: "name: (type_identifier) @chunk.name",
        captureId: "struct",
      },
      {
        type: "enum_item",
        nameQuery: "name: (type_identifier) @chunk.name",
        captureId: "enum",
      },
      {
        type: "impl_item",
        nameQuery: "type: (type_identifier) @chunk.name",
        captureId: "impl",
      },
      {
        type: "mod_item",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "module",
      },
    ],
    splitPoints: ["if_expression", "for_expression", "while_expression", "loop_expression", "match_expression"],
    comments: ["line_comment", "block_comment"],
  },
  graph: {
    imports: `
      (mod_item name: (identifier) @mod) @stmt
      (extern_crate_declaration name: (identifier) @mod) @stmt
      (use_declaration argument: (_) @mod) @stmt
    `,
    exports: `
      (function_item name: (identifier) @name) @stmt
      (struct_item name: (type_identifier) @name) @stmt
      (trait_item name: (type_identifier) @name) @stmt
      (enum_item name: (type_identifier) @name) @stmt
      (enum_variant name: (identifier) @name) @stmt
      (const_item name: (identifier) @name) @stmt
      (static_item name: (identifier) @name) @stmt
      (use_declaration argument: (scoped_identifier path: (identifier) @from name: (identifier) @src)) @stmt
      (use_declaration argument: (identifier) @src) @stmt
    `,
    locals: `
      (function_item name: (identifier) @name)
      (struct_item name: (type_identifier) @name)
      (trait_item name: (type_identifier) @name)
      (enum_item name: (type_identifier) @name)
      (enum_variant name: (identifier) @name)
      (const_item name: (identifier) @name)
      (static_item name: (identifier) @name)
      (let_declaration pattern: (identifier) @name)
      (parameter pattern: (identifier) @name)
    `,
    importBindings: `
      (mod_item name: (identifier) @from) @stmt
      (extern_crate_declaration name: (identifier) @from) @stmt
      (extern_crate_declaration name: (identifier) @from alias: (identifier) @alias) @stmt
      (use_declaration argument: (use_as_clause path: (identifier) @from alias: (identifier) @alias)) @stmt
      (use_declaration argument: (use_as_clause path: (scoped_identifier path: (identifier) @from name: (identifier) @iname) alias: (identifier) @alias)) @stmt
      (use_declaration argument: (scoped_identifier path: (identifier) @from name: (identifier) @iname)) @stmt
      (use_declaration argument: (identifier) @from) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["identifier", "type_identifier"],
    memberExpression: "field_expression",
  },
  supportsCrossModuleSymbols: true,
  classifyDefinition: (node) => {
    const parent = node.parent;
    if (!parent) return "variable";
    if (parent.type === "function_item") return "function";
    if (parent.type === "struct_item" || parent.type === "trait_item" || parent.type === "enum_item") return "class";
    return "variable";
  },
  createsFunctionScope: (node) => node.type === "function_item",
  createsBlockScope: (node) => node.type === "block",
  isDeclarationName: (node) => {
    const p = node.parent;
    if (!p) return false;
    if (p.type === "function_item" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "struct_item" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "trait_item" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "enum_item" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "enum_variant" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "const_item" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "static_item" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "let_declaration" && p.childForFieldName("pattern")?.id === node.id) return true;
    if (p.type === "parameter" && p.childForFieldName("pattern")?.id === node.id) return true;
    return false;
  },
};
registerLanguage(RUST_DEF);
