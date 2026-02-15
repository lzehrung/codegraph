import type { LanguageDefinition } from "../types.js";
import { loadTreeSitterLanguage } from "./loadLanguage.js";
import { registerLanguage } from "../registry.js";

export const PYTHON_DEF: LanguageDefinition = {
  id: "python",
  extensions: [".py"],
  grammar: () => loadTreeSitterLanguage("tree-sitter-python"),
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
    // NOTE: These __all__ queries only capture module-level assignments.
    // Dynamic __all__ definitions inside functions, conditionals, or loops
    // (e.g., `if PY3: __all__ = [...]`) are not detected by these patterns.
    // This is a known limitation - such patterns are rare in practice.
    exports: `
      ;; __all__ = ["a", "b"] - simple list assignment
      (assignment left: (identifier) @left right: (list (string)+ @all_item)) @stmt
      ;; __all__ = ("a", "b") - tuple assignment
      (assignment left: (identifier) @left right: (tuple (string)+ @all_item)) @stmt
      ;; __all__ = ["a"] + ["b"] - concatenation (captures strings in both sides)
      (assignment left: (identifier) @left right: (binary_operator (list (string)+ @all_item))) @stmt
      (assignment left: (identifier) @left right: (binary_operator right: (list (string)+ @all_item))) @stmt
      ;; __all__.extend(["a"]) - extend pattern
      (expression_statement (call function: (attribute object: (identifier) @left attribute: (identifier) @method) arguments: (argument_list (list (string)+ @all_item)))) @stmt
      ;; __all__.append("a") - append pattern
      (expression_statement (call function: (attribute object: (identifier) @left attribute: (identifier) @method) arguments: (argument_list (string) @all_item))) @stmt
      ;; __all__ += ["a"] - augmented assignment
      (augmented_assignment left: (identifier) @left right: (list (string)+ @all_item)) @stmt
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
registerLanguage(PYTHON_DEF);
