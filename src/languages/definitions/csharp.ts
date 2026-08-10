import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";

export const CSHARP_DEF: LanguageDefinition = {
  id: "csharp",
  extensions: [".cs"],
  grammar: () => loadTreeSitterLanguage("tree-sitter-c-sharp"),
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
        type: "namespace_declaration",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "namespace",
      },
    ],
    splitPoints: [
      "if_statement",
      "for_statement",
      "foreach_statement",
      "while_statement",
      "switch_statement",
      "try_statement",
    ],
    comments: ["comment"],
  },
  graph: {
    imports: `
      (using_directive . (_) @mod) @stmt
    `,
    exports: `
      (class_declaration name: (identifier) @name)
      (record_declaration name: (identifier) @name)
      (interface_declaration name: (identifier) @name)
      (enum_declaration name: (identifier) @name)
      (enum_member_declaration name: (identifier) @name)
      (method_declaration name: (identifier) @name)
      (property_declaration name: (identifier) @name)
    `,
    locals: `
      (class_declaration name: (identifier) @name)
      (record_declaration name: (identifier) @name)
      (interface_declaration name: (identifier) @name)
      (enum_declaration name: (identifier) @name)
      (enum_member_declaration name: (identifier) @name)
      (method_declaration name: (identifier) @name)
      (variable_declarator (identifier) @name)
      (declaration_pattern name: (identifier) @name)
    `,
    importBindings: `
      (using_directive name: (identifier) @alias . (_) @from) @stmt
      (using_directive . (_) @from) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["identifier"],
    memberExpression: "member_access_expression",
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
    if (p.type === "enum_member_declaration" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "method_declaration" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "variable_declarator" && p.child(0)?.id === node.id) return true;
    if (p.type === "parameter" && p.childForFieldName("name")?.id === node.id) return true;
    if (p.type === "declaration_pattern" && p.childForFieldName("name")?.id === node.id) return true;
    return false;
  },
};
registerLanguage(CSHARP_DEF);
