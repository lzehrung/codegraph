import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";

export const JAVA_DEF: LanguageDefinition = {
  id: "java",
  extensions: [".java"],
  grammar: () => loadTreeSitterLanguage("tree-sitter-java"),
  structure: {
    blocks: [
      {
        type: "class_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "class",
      },
      {
        type: "record_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "class",
      },
      {
        type: "interface_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "interface",
      },
      {
        type: "enum_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "enum",
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
    splitPoints: ["if_statement", "for_statement", "while_statement", "try_statement", "switch_expression"],
    comments: ["line_comment", "block_comment"],
  },
  graph: {
    imports: `
      (import_declaration . (_) @mod) @stmt
    `,
    exports: `
      (class_declaration name: (identifier) @name)
      (record_declaration name: (identifier) @name)
      (interface_declaration name: (identifier) @name)
      (enum_declaration name: (identifier) @name)
      (enum_constant name: (identifier) @name)
      (method_declaration name: (identifier) @name)
      (field_declaration (variable_declarator name: (identifier) @name))
    `,
    locals: `
      (class_declaration name: (identifier) @name)
      (record_declaration name: (identifier) @name)
      (interface_declaration name: (identifier) @name)
      (enum_declaration name: (identifier) @name)
      (enum_constant name: (identifier) @name)
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
  classifyDefinition: (node) => {
    const parent = node.parent;
    if (!parent) return "variable";
    if (parent.type === "method_declaration" || parent.type === "constructor_declaration") return "method";
    if (parent.type === "class_declaration" || parent.type === "record_declaration") return "class";
    if (parent.type === "interface_declaration") return "interface";
    if (parent.type === "enum_declaration") return "type";
    return "variable";
  },
  createsFunctionScope: (node) => node.type === "method_declaration" || node.type === "constructor_declaration",
  createsBlockScope: (node) => node.type === "block",
  isDeclarationName: (node) => {
    const p = node.parent;
    if (!p) return false;
    if (p.type === "class_declaration" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "record_declaration" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "interface_declaration" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "enum_declaration" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "enum_constant" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "method_declaration" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "variable_declarator" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "formal_parameter" && p.childForFieldName("name")?.id === node.id) return true;
    return false;
  },
};
registerLanguage(JAVA_DEF);
