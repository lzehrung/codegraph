import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";
import {
  cFamilyContainerTypes,
  cFunctionNameQuery,
  findAncestor,
  isFunctionDeclarator,
  isInAncestorDeclarator,
  isInField,
  isInParameterList,
} from "./cFamily.js";

const FUNCTION_NAME_QUERY = cFunctionNameQuery("chunk.name", true);
const GRAPH_FUNCTION_NAME_QUERY = cFunctionNameQuery("name", true);

export const CPP_DEF: LanguageDefinition = {
  id: "cpp",
  extensions: [".cc", ".cpp", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".ipp", ".tpp", ".inl"],
  grammar: () => loadTreeSitterLanguage("tree-sitter-cpp"),
  structure: {
    blocks: [
      {
        type: "function_definition",
        nameQuery: FUNCTION_NAME_QUERY,
        captureId: "function",
      },
      {
        type: "class_specifier",
        nameQuery: "name: (type_identifier) @chunk.name",
        captureId: "class",
      },
      {
        type: "struct_specifier",
        nameQuery: "name: (type_identifier) @chunk.name",
        captureId: "struct",
      },
      {
        type: "enum_specifier",
        nameQuery: "name: (type_identifier) @chunk.name",
        captureId: "enum",
      },
      {
        type: "namespace_definition",
        nameQuery: "name: (namespace_identifier) @chunk.name",
        captureId: "namespace",
      },
      {
        type: "alias_declaration",
        nameQuery: "name: (type_identifier) @chunk.name",
        captureId: "type",
      },
      {
        type: "type_definition",
        nameQuery: "declarator: (type_identifier) @chunk.name",
        captureId: "type",
      },
    ],
    splitPoints: [
      "if_statement",
      "for_statement",
      "while_statement",
      "do_statement",
      "switch_statement",
      "case_statement",
      "try_statement",
      "catch_clause",
    ],
    comments: ["comment"],
  },
  graph: {
    imports: `
      (preproc_include path: (string_literal) @mod) @stmt
      (preproc_include path: (system_lib_string) @mod) @stmt
      (preproc_include path: (identifier) @mod) @stmt
    `,
    exports: `
      (function_definition ${GRAPH_FUNCTION_NAME_QUERY})
      (declaration ${GRAPH_FUNCTION_NAME_QUERY})
      (class_specifier name: (type_identifier) @name)
      (struct_specifier name: (type_identifier) @name)
      (enum_specifier name: (type_identifier) @name)
      (namespace_definition name: (namespace_identifier) @name)
      (alias_declaration name: (type_identifier) @name)
      (type_definition declarator: (type_identifier) @name)
      (using_declaration (qualified_identifier name: (identifier) @name))
      (declaration declarator: (identifier) @name)
      (declaration declarator: (init_declarator declarator: (identifier) @name))
    `,
    locals: `
      (function_definition ${GRAPH_FUNCTION_NAME_QUERY})
      (class_specifier name: (type_identifier) @name)
      (struct_specifier name: (type_identifier) @name)
      (enum_specifier name: (type_identifier) @name)
      (namespace_definition name: (namespace_identifier) @name)
      (alias_declaration name: (type_identifier) @name)
      (type_definition declarator: (type_identifier) @name)
      (declaration declarator: (identifier) @name)
      (declaration declarator: (init_declarator declarator: (identifier) @name))
      (parameter_declaration declarator: (identifier) @name)
      (field_declaration declarator: (field_identifier) @name)
    `,
    importBindings: `
      (preproc_include path: (string_literal) @from) @stmt
      (preproc_include path: (system_lib_string) @from) @stmt
      (preproc_include path: (identifier) @from) @stmt
    `,
  },
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
  createsBlockScope: (node) => node.type === "compound_statement",
  supportsCrossModuleSymbols: true,
};
registerLanguage(CPP_DEF);
