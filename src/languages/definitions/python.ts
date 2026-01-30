import type { Language } from "tree-sitter";
import type { LanguageDefinition } from "../types.js";

const { default: PythonLang } = await import("tree-sitter-python");
const LangPY: Language = PythonLang;

export const PYTHON_DEF: LanguageDefinition = {
  id: "python",
  extensions: [".py"],
  grammar: () => LangPY,
  structure: {
    blocks: [
      {
        type: "class_definition",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "class",
      },
      {
        type: "function_definition",
        nameQuery: "name: (identifier) @chunk.name",
        captureId: "function",
      },

      // Docstrings - only capture top-level module docstrings as standalone chunks
      {
        type: "expression_statement",
        nameQuery: "(string) @chunk.docstring",
        isBlock: false,
        parentType: "module",
      },

      // Top level assignments
      {
        type: "assignment",
        nameQuery: "left: (identifier) @chunk.name",
        captureId: "module_var",
      },

      // Imports
      { type: "import_statement", captureId: "imports" },
      { type: "import_from_statement", captureId: "imports" },
    ],
    splitPoints: [
      "if_statement",
      "for_statement",
      "while_statement",
      "try_statement",
      "with_statement",
      "match_statement",
    ],
    comments: ["comment"],
  },
  graph: {
    imports: `
      (import_statement) @stmt
      (import_from_statement) @stmt
    `,
    exports: `
      (assignment left: (identifier) @left right: (list (string)+ @all_item)) @stmt
      (function_definition name: (identifier) @name)
      (class_definition name: (identifier) @name)
      (assignment left: (identifier) @name)
    `,
    locals: `
      (function_definition name: (identifier) @name)
      (class_definition name: (identifier) @name)
      (assignment left: (identifier) @name)
    `,
    importBindings: `
      (import_statement) @stmt
      (import_from_statement) @stmt
    `,
  },
  nodeTypes: {
    identifier: ["identifier"],
    propertyIdentifier: ["identifier"],
    memberExpression: "attribute",
  },
  classifyDefinition: (n) => {
    const t = n.parent?.type;
    if (t === "function_definition") return "function";
    if (t === "class_definition") return "class";
    return "variable";
  },
  isDeclarationName: (node) => {
    const t = node.parent?.type;
    return (
      !!t &&
      [
        "function_definition",
        "class_definition",
        "assignment",
        "aliased_import",
      ].includes(t)
    );
  },
  createsBlockScope: (n) => n.type === "module" || n.type === "block",
  createsFunctionScope: (n) =>
    n.type === "function_definition" || n.type === "lambda",
  supportsCrossModuleSymbols: true,
};
