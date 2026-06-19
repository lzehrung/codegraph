import { registerLanguage } from "../registry.js";
import {
  cFamilyBlock,
  cFamilyContainerTypes,
  cFamilyFunctionBlock,
  cFamilyTypeIdentifierBlock,
  createCFamilyLanguageDefinition,
  findAncestor,
  isFunctionDeclarator,
  isInAncestorDeclarator,
  isInField,
  isInParameterList,
} from "./cFamily.js";

export const C_DEF = createCFamilyLanguageDefinition({
  id: "c",
  extensions: [".c", ".h", ".i"],
  grammarPackage: "tree-sitter-c",
  includeFieldIdentifier: false,
  blocks: (functionNameQuery) => [
    cFamilyFunctionBlock(functionNameQuery),
    cFamilyTypeIdentifierBlock("struct_specifier", "struct"),
    cFamilyTypeIdentifierBlock("union_specifier", "union"),
    cFamilyTypeIdentifierBlock("enum_specifier", "enum"),
    cFamilyBlock("type_definition", "declarator: (type_identifier) @chunk.name", "type"),
    cFamilyBlock("preproc_def", "name: (identifier) @chunk.name", "macro"),
    cFamilyBlock("preproc_function_def", "name: (identifier) @chunk.name", "macro"),
  ],
  extraExportQueries: [
    `(union_specifier name: (type_identifier) @name)`,
    `(enumerator name: (identifier) @name)`,
    `(preproc_def name: (identifier) @name)`,
    `(preproc_function_def name: (identifier) @name)`,
  ],
  extraLocalQueries: [
    `(union_specifier name: (type_identifier) @name)`,
    `(enumerator name: (identifier) @name)`,
    `(preproc_def name: (identifier) @name)`,
    `(preproc_function_def name: (identifier) @name)`,
  ],
  nodeTypes: {
    identifier: ["identifier", "field_identifier", "type_identifier"],
    propertyIdentifier: ["field_identifier"],
    memberExpression: "field_expression",
  },
  classifyDefinition: (node) => {
    const parent = node.parent;
    if (!parent) return "variable";
    if (parent.type === "struct_specifier" || parent.type === "union_specifier" || parent.type === "enum_specifier")
      return "class";
    if (parent.type === "type_definition" && isInField(node, parent, "declarator")) return "type";
    const container = findAncestor(node, cFamilyContainerTypes);
    if (container?.type === "function_definition") return "function";
    if (container?.type === "declaration" && isFunctionDeclarator(node)) return "function";
    return "variable";
  },
  isDeclarationName: (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (
      (parent.type === "struct_specifier" || parent.type === "union_specifier" || parent.type === "enum_specifier") &&
      isInField(node, parent, "name")
    )
      return true;
    if (
      isInAncestorDeclarator(node, new Set(["parameter_declaration"])) ||
      isInAncestorDeclarator(node, new Set(["field_declaration"])) ||
      isInAncestorDeclarator(node, new Set(["init_declarator"])) ||
      isInAncestorDeclarator(node, new Set(["type_definition"]))
    )
      return true;
    if (isInAncestorDeclarator(node, new Set(["function_definition"])) && !isInParameterList(node)) return true;
    if (isInAncestorDeclarator(node, new Set(["declaration"])) && !isInParameterList(node)) return true;
    if (parent.type === "enumerator" && isInField(node, parent, "name")) return true;
    if (parent.type === "preproc_def" && isInField(node, parent, "name")) return true;
    if (parent.type === "preproc_function_def" && isInField(node, parent, "name")) return true;
    return false;
  },
  createsFunctionScope: (node) => node.type === "function_definition",
});

registerLanguage(C_DEF);
