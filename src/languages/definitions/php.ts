import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";

export const PHP_DEF: LanguageDefinition = {
  id: "php",
  extensions: [".php"],
  usesQueryDrivenLocals: true,
  structure: {
    blocks: [
      {
        type: "namespace_definition",
        nameQuery: "name: (namespace_name) @chunk.name",
        captureId: "namespace",
      },
      {
        type: "class_declaration",
        nameQuery: "name: (name) @chunk.name",
        captureId: "class",
      },
      {
        type: "interface_declaration",
        nameQuery: "name: (name) @chunk.name",
        captureId: "interface",
      },
      {
        type: "trait_declaration",
        nameQuery: "name: (name) @chunk.name",
        captureId: "trait",
      },
      {
        type: "enum_declaration",
        nameQuery: "name: (name) @chunk.name",
        captureId: "enum",
      },
      {
        type: "function_definition",
        nameQuery: "name: (name) @chunk.name",
        captureId: "function",
      },
      {
        type: "method_declaration",
        nameQuery: "name: (name) @chunk.name",
        captureId: "method",
      },
      {
        type: "const_declaration",
        nameQuery: "(const_element (name) @chunk.name)",
        captureId: "const",
      },
    ],
    splitPoints: [
      "if_statement",
      "switch_statement",
      "for_statement",
      "foreach_statement",
      "while_statement",
      "do_statement",
      "try_statement",
      "match_expression",
    ],
    comments: ["comment"],
  },
  graph: {
    imports: `
      (require_expression) @stmt
      (include_expression) @stmt
      (require_once_expression) @stmt
      (include_once_expression) @stmt
      (namespace_use_declaration) @stmt
    `,
    exports: `
      (namespace_definition name: (namespace_name) @name)
      (class_declaration name: (name) @name)
      (interface_declaration name: (name) @name)
      (trait_declaration name: (name) @name)
      (enum_declaration name: (name) @name)
      (enum_case name: (name) @name)
      (function_definition name: (name) @name)
      (const_declaration (const_element (name) @name))
    `,
    locals: `
      (class_declaration name: (name) @name)
      (interface_declaration name: (name) @name)
      (trait_declaration name: (name) @name)
      (enum_declaration name: (name) @name)
      (enum_case name: (name) @name)
      (function_definition name: (name) @name)
      (method_declaration name: (name) @name)
      (const_declaration (const_element (name) @name))
      (property_element (variable_name) @name)
    `,
    importBindings: `
      (require_expression) @stmt
      (include_expression) @stmt
      (require_once_expression) @stmt
      (include_once_expression) @stmt
      (namespace_use_declaration) @stmt
  `,
  },
  nodeTypes: {
    identifier: ["name", "variable_name", "namespace_name", "qualified_name", "relative_name"],
    propertyIdentifier: ["name"],
    memberExpression: "member_access_expression",
  },
  classifyDefinition: (node) => {
    const parentType = node.parent?.type;
    if (parentType === "class_declaration") return "class";
    if (parentType === "interface_declaration") return "interface";
    if (parentType === "trait_declaration") return "trait";
    if (parentType === "enum_declaration") return "type";
    if (parentType === "enum_case") return "constant";
    if (parentType === "function_definition") return "function";
    if (parentType === "method_declaration") return "method";
    if (parentType === "namespace_definition") return "namespace";
    if (parentType === "const_element" || parentType === "const_declaration") {
      return "constant";
    }
    return "variable";
  },
  normalizeIdentifier: (name) => name.replace(/^\$/, ""),
  isDeclarationName: (node) => {
    const parent = node.parent;
    if (!parent) return false;

    const nameFieldOwnerTypes = new Set([
      "namespace_definition",
      "class_declaration",
      "interface_declaration",
      "trait_declaration",
      "enum_declaration",
      "enum_case",
      "function_definition",
      "method_declaration",
    ]);

    if (nameFieldOwnerTypes.has(parent.type)) {
      return parent.childForFieldName("name")?.id === node.id;
    }

    if (parent.type === "property_element" && node.type === "variable_name") return true;
    return (
      parent.type === "const_element" &&
      parent.namedChildren.some((child) => child.id === node.id && child.type === "name")
    );
  },
  scopeDeclarationNames: (node) => node.type === "variable_name" && node.parent?.type === "property_element",
  createsFunctionScope: (node) => node.type === "function_definition" || node.type === "method_declaration",
  membersAreImplicitlyInScope: false,
  supportsCrossModuleSymbols: true,
};

registerLanguage(PHP_DEF);
