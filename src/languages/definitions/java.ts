import type { Language } from "tree-sitter";
import Java from "tree-sitter-java";
import type { LanguageDefinition } from "../types.js";

const LangJava = Java as unknown as Language;

export const JAVA_DEF: LanguageDefinition = {
  id: "java",
  extensions: [".java"],
  grammar: () => LangJava,
  structure: {
    blocks: [
      { type: "class_declaration", nameQuery: "name: (identifier) @chunk.name", captureId: "class" },
      { type: "interface_declaration", nameQuery: "name: (identifier) @chunk.name", captureId: "interface" },
      { type: "method_declaration", nameQuery: "name: (identifier) @chunk.name", captureId: "method" },
      { type: "constructor_declaration", nameQuery: "name: (identifier) @chunk.name", captureId: "method" }
    ],
    splitPoints: ["if_statement", "for_statement", "while_statement", "try_statement", "switch_expression"],
    comments: ["line_comment", "block_comment"]
  },
  graph: {
    imports: `
      (import_declaration (scoped_identifier) @mod) @stmt
    `,
    exports: `
      (class_declaration name: (identifier) @name)
      (interface_declaration name: (identifier) @name)
      (method_declaration name: (identifier) @name)
      (field_declaration (variable_declarator name: (identifier) @name))
    `,
    locals: `
      (class_declaration name: (identifier) @name)
      (interface_declaration name: (identifier) @name)
      (method_declaration name: (identifier) @name)
      (variable_declarator name: (identifier) @name)
    `,
    importBindings: ""
  },
  nodeTypes: {
    identifier: ["identifier"],
  }
};

