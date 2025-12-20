import type { Language } from "tree-sitter";
import Rust from "tree-sitter-rust";
import type { LanguageDefinition } from "../types.js";

const LangRust = Rust as unknown as Language;

export const RUST_DEF: LanguageDefinition = {
  id: "rust",
  extensions: [".rs"],
  grammar: () => LangRust,
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
    splitPoints: [
      "if_expression",
      "for_expression",
      "while_expression",
      "loop_expression",
      "match_expression",
    ],
    comments: ["line_comment", "block_comment"],
  },
  graph: {
    imports: `
      (mod_item name: (identifier) @mod)
      (use_declaration argument: (_) @mod) @stmt
    `,
    exports: `
      (function_item name: (identifier) @name)
      (struct_item name: (type_identifier) @name)
      (enum_item name: (type_identifier) @name)
      (const_item name: (identifier) @name)
      (static_item name: (identifier) @name)
    `,
    locals: `
      (function_item name: (identifier) @name)
      (struct_item name: (type_identifier) @name)
      (let_declaration pattern: (identifier) @name)
    `,
    importBindings: `
      (mod_item name: (identifier) @from) @stmt
      (use_declaration argument: (_) @from) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["identifier", "type_identifier"],
    memberExpression: "field_expression",
  },
  supportsCrossModuleSymbols: true,
  createsFunctionScope: (node) => node.type === "function_item",
  createsBlockScope: (node) => node.type === "block",
  isDeclarationName: (node) => {
    const p = node.parent;
    if (!p) return false;
    if (
      p.type === "function_item" &&
      p.childForFieldName("name")?.id === node.id
    )
      return true;
    if (p.type === "struct_item" && p.childForFieldName("name")?.id === node.id)
      return true;
    if (p.type === "enum_item" && p.childForFieldName("name")?.id === node.id)
      return true;
    if (p.type === "const_item" && p.childForFieldName("name")?.id === node.id)
      return true;
    if (p.type === "static_item" && p.childForFieldName("name")?.id === node.id)
      return true;
    if (
      p.type === "let_declaration" &&
      p.childForFieldName("pattern")?.id === node.id
    )
      return true;
    if (
      p.type === "parameter" &&
      p.childForFieldName("pattern")?.id === node.id
    )
      return true;
    return false;
  },
};
