import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";
import {
  cFamilyContainerTypes,
  cFamilyControlSplitPoints,
  cFamilyCoreExportQueries,
  cFamilyCoreLocalQueries,
  cFamilyIncludeBindingsQuery,
  cFamilyIncludeImportsQuery,
  cFunctionNameQuery,
  findAncestor,
  isFunctionDeclarator,
  isInAncestorDeclarator,
  isInField,
  isInParameterList,
  joinQueryPatterns,
} from "./cFamily.js";

const FUNCTION_NAME_QUERY = cFunctionNameQuery("chunk.name", false);
const GRAPH_FUNCTION_NAME_QUERY = cFunctionNameQuery("name", false);

export const C_DEF: LanguageDefinition = {
  id: "c",
  extensions: [".c", ".h", ".i"],
  grammar: () => loadTreeSitterLanguage("tree-sitter-c"),
  structure: {
    blocks: [
      {
        type: "function_definition",
        nameQuery: FUNCTION_NAME_QUERY,
        captureId: "function",
      },
      {
        type: "struct_specifier",
        nameQuery: "name: (type_identifier) @chunk.name",
        captureId: "struct",
      },
      {
        type: "union_specifier",
        nameQuery: "name: (type_identifier) @chunk.name",
        captureId: "union",
      },
      {
        type: "enum_specifier",
        nameQuery: "name: (type_identifier) @chunk.name",
        captureId: "enum",
      },
      {
        type: "type_definition",
        nameQuery: "declarator: (type_identifier) @chunk.name",
        captureId: "type",
      },
      {
        type: "preproc_def",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "macro",
      },
      {
        type: "preproc_function_def",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "macro",
      },
    ],
    splitPoints: cFamilyControlSplitPoints,
    comments: ["comment"],
  },
  graph: {
    imports: cFamilyIncludeImportsQuery,
    exports: joinQueryPatterns([
      ...cFamilyCoreExportQueries(GRAPH_FUNCTION_NAME_QUERY),
      `(union_specifier name: (type_identifier) @name)`,
      `(preproc_def name: (identifier) @name)`,
      `(preproc_function_def name: (identifier) @name)`,
    ]),
    locals: joinQueryPatterns([
      ...cFamilyCoreLocalQueries(GRAPH_FUNCTION_NAME_QUERY),
      `(union_specifier name: (type_identifier) @name)`,
      `(preproc_def name: (identifier) @name)`,
      `(preproc_function_def name: (identifier) @name)`,
    ]),
    importBindings: cFamilyIncludeBindingsQuery,
  },
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
  createsBlockScope: (node) => node.type === "compound_statement",
  supportsCrossModuleSymbols: true,
};
registerLanguage(C_DEF);
