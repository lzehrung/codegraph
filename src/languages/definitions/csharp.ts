import type { Language } from "tree-sitter";
import CSharp from "tree-sitter-c-sharp";
import type { LanguageDefinition } from "../types.js";

const LangCSharp = CSharp as unknown as Language;

export const CSHARP_DEF: LanguageDefinition = {
  id: "csharp",
  extensions: [".cs"],
  grammar: () => LangCSharp,
  structure: {
    blocks: [
      { type: "class_declaration", nameQuery: "name: (identifier) @chunk.name", captureId: "class" },
      { type: "interface_declaration", nameQuery: "name: (identifier) @chunk.name", captureId: "interface" },
      { type: "method_declaration", nameQuery: "name: (identifier) @chunk.name", captureId: "method" },
      { type: "namespace_declaration", nameQuery: "name: (identifier) @chunk.name", captureId: "namespace" }
    ],
    splitPoints: ["if_statement", "for_statement", "foreach_statement", "while_statement", "switch_statement", "try_statement"],
    comments: ["comment"]
  },
  graph: {
    imports: `
      (using_directive (qualified_name) @mod) @stmt
      (using_directive (identifier) @mod) @stmt
    `,
    exports: `
      (class_declaration name: (identifier) @name)
      (interface_declaration name: (identifier) @name)
      (method_declaration name: (identifier) @name)
      (property_declaration name: (identifier) @name)
    `,
    locals: `
      (class_declaration name: (identifier) @name)
      (interface_declaration name: (identifier) @name)
      (method_declaration name: (identifier) @name)
      (variable_declarator (identifier) @name)
    `,
    importBindings: ""
  },
  nodeTypes: {
    identifier: ["identifier"],
  }
};

