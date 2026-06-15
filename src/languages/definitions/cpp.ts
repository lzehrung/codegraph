import { registerLanguage } from "../registry.js";
import {
  cFamilyBlock,
  cFamilyContainerTypes,
  cFamilyControlSplitPoints,
  cFamilyFunctionBlock,
  cFamilyTypeIdentifierBlock,
  createCFamilyLanguageDefinition,
  findAncestor,
  isFunctionDeclarator,
  isInAncestorDeclarator,
  isInField,
  isInParameterList,
} from "./cFamily.js";

export const CPP_DEF = createCFamilyLanguageDefinition({
  id: "cpp",
  extensions: [".cc", ".cpp", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".ipp", ".tpp", ".inl"],
  grammarPackage: "tree-sitter-cpp",
  includeFieldIdentifier: true,
  blocks: (functionNameQuery) => [
    cFamilyFunctionBlock(functionNameQuery),
    cFamilyTypeIdentifierBlock("class_specifier", "class"),
    cFamilyTypeIdentifierBlock("struct_specifier", "struct"),
    cFamilyTypeIdentifierBlock("enum_specifier", "enum"),
    cFamilyBlock("namespace_definition", "name: (namespace_identifier) @chunk.name", "namespace"),
    cFamilyTypeIdentifierBlock("alias_declaration", "type"),
    cFamilyBlock("type_definition", "declarator: (type_identifier) @chunk.name", "type"),
  ],
  splitPoints: [...cFamilyControlSplitPoints, "try_statement", "catch_clause"],
  extraExportQueries: [
    `(class_specifier name: (type_identifier) @name)`,
    `(namespace_definition name: (namespace_identifier) @name)`,
    `(alias_declaration name: (type_identifier) @name)`,
    `(using_declaration (qualified_identifier name: (identifier) @name))`,
  ],
  extraLocalQueries: [
    `(class_specifier name: (type_identifier) @name)`,
    `(namespace_definition name: (namespace_identifier) @name)`,
    `(alias_declaration name: (type_identifier) @name)`,
  ],
  nodeTypes: {
    identifier: ["identifier", "field_identifier", "type_identifier", "namespace_identifier"],
    propertyIdentifier: ["field_identifier", "identifier"],
    memberExpression: "field_expression",
  },
  classifyDefinition: (node) => {
    const parent = node.parent;
    if (!parent) return "variable";
    if (
      parent.type === "class_specifier" ||
      parent.type === "struct_specifier" ||
      parent.type === "enum_specifier" ||
      parent.type === "namespace_definition"
    )
      return "class";
    if (
      parent.type === "alias_declaration" ||
      (parent.type === "type_definition" && isInField(node, parent, "declarator"))
    )
      return "type";
    const container = findAncestor(node, cFamilyContainerTypes);
    if (container?.type === "function_definition") return "function";
    if (container?.type === "declaration" && isFunctionDeclarator(node)) return "function";
    return "variable";
  },
  isDeclarationName: (node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (
      (parent.type === "class_specifier" || parent.type === "struct_specifier" || parent.type === "enum_specifier") &&
      isInField(node, parent, "name")
    )
      return true;
    if (parent.type === "namespace_definition" && isInField(node, parent, "name")) return true;
    if (parent.type === "alias_declaration" && isInField(node, parent, "name")) return true;
    if (
      isInAncestorDeclarator(node, new Set(["parameter_declaration"])) ||
      isInAncestorDeclarator(node, new Set(["field_declaration"])) ||
      isInAncestorDeclarator(node, new Set(["init_declarator"])) ||
      isInAncestorDeclarator(node, new Set(["type_definition"]))
    )
      return true;
    if (isInAncestorDeclarator(node, new Set(["function_definition"])) && !isInParameterList(node)) return true;
    if (isInAncestorDeclarator(node, new Set(["declaration"])) && !isInParameterList(node)) return true;
    if (
      parent.type === "qualified_identifier" &&
      parent.parent?.type === "using_declaration" &&
      isInField(node, parent, "name")
    )
      return true;
    if (parent.type === "enumerator" && isInField(node, parent, "name")) return true;
    return false;
  },
  createsFunctionScope: (node) => node.type === "function_definition" || node.type === "lambda_expression",
});

registerLanguage(CPP_DEF);
