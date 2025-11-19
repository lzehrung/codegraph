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
      { type: "function_item", nameQuery: "name: (identifier) @chunk.name", captureId: "function" },
      { type: "struct_item", nameQuery: "name: (type_identifier) @chunk.name", captureId: "struct" },
      { type: "impl_item", nameQuery: "type: (type_identifier) @chunk.name", captureId: "impl" },
      { type: "mod_item", nameQuery: "name: (identifier) @chunk.name", captureId: "module" }
    ],
    splitPoints: ["if_expression", "for_expression", "while_expression", "loop_expression", "match_expression"],
    comments: ["line_comment", "block_comment"]
  },
  graph: {
    imports: `
      (use_declaration argument: (scoped_identifier) @mod) @stmt
      (use_declaration argument: (identifier) @mod) @stmt
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
    importBindings: ""
  },
  nodeTypes: {
    identifier: ["identifier", "type_identifier"],
  }
};

