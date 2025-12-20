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
      {
        type: "class_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "class",
      },
      {
        type: "interface_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "interface",
      },
      {
        type: "method_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "method",
      },
      {
        type: "constructor_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "method",
      },
    ],
    splitPoints: [
      "if_statement",
      "for_statement",
      "while_statement",
      "try_statement",
      "switch_expression",
    ],
    comments: ["line_comment", "block_comment"],
  },
  graph: {
    imports: `
      (import_declaration . (_) @mod) @stmt
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
    importBindings: `
      (import_declaration . (_) @from) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["identifier", "type_identifier"],
    memberExpression: "field_access",
  },
  supportsCrossModuleSymbols: true,
  createsFunctionScope: (node) =>
    node.type === "method_declaration" ||
    node.type === "constructor_declaration",
  createsBlockScope: (node) => node.type === "block",
  isDeclarationName: (node) => {
    const p = node.parent;
    if (!p) return false;
    if (
      p.type === "class_declaration" &&
      p.childForFieldName("name")?.id === node.id
    )
      return true;
    if (
      p.type === "interface_declaration" &&
      p.childForFieldName("name")?.id === node.id
    )
      return true;
    if (
      p.type === "method_declaration" &&
      p.childForFieldName("name")?.id === node.id
    )
      return true;
    if (
      p.type === "variable_declarator" &&
      p.childForFieldName("name")?.id === node.id
    )
      return true;
    if (
      p.type === "formal_parameter" &&
      p.childForFieldName("name")?.id === node.id
    )
      return true;
    return false;
  },
};
