import type { LanguageDefinition, SyntaxNodeLike } from "../types.js";
import { registerLanguage } from "../registry.js";
import { hasNonAsciiCodePoint } from "../../util/identifiers.js";

function isTypeAliasLeftName(node: SyntaxNodeLike): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "type") {
    const stmt = parent.parent;
    return stmt?.type === "type_alias_statement" && stmt.childForFieldName("left")?.id === parent.id;
  }
  if (parent.type === "generic_type") {
    const typeNode = parent.parent;
    const stmt = typeNode?.parent;
    return (
      typeNode?.type === "type" &&
      stmt?.type === "type_alias_statement" &&
      stmt.childForFieldName("left")?.id === typeNode.id
    );
  }
  return false;
}

export const PYTHON_DEF: LanguageDefinition = {
  id: "python",
  extensions: [".py", ".pyi", ".pyw"],
  usesQueryDrivenLocals: true,
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
        nameQuery:
          "left: [(identifier) @chunk.name (pattern_list (identifier) @chunk.name) (tuple_pattern (identifier) @chunk.name)]",
        captureId: "module_var",
      },
      {
        type: "type_alias_statement",
        nameQuery: "left: (type [(identifier) @chunk.name (generic_type (identifier) @chunk.name)])",
        captureId: "type",
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
      (future_import_statement) @stmt
    `,
    // NOTE: These __all__ queries only capture module-level assignments.
    // Dynamic __all__ definitions inside functions, conditionals, or loops
    // (e.g., `if PY3: __all__ = [...]`) are not detected by these patterns.
    // This is a known limitation - such patterns are rare in practice.
    exports: `
      ;; __all__ = ["a", "b"] - simple list assignment
      (module (expression_statement (assignment left: (identifier) @left right: (list (string) @all_item)) @stmt))
      ;; __all__ = ("a", "b") - tuple assignment
      (module (expression_statement (assignment left: (identifier) @left right: (tuple (string) @all_item)) @stmt))
      ;; __all__ = ["a"] + ["b"] - concatenation (captures strings in both sides)
      (module (expression_statement (assignment left: (identifier) @left right: (binary_operator (list (string) @all_item))) @stmt))
      (module (expression_statement (assignment left: (identifier) @left right: (binary_operator right: (list (string) @all_item))) @stmt))
      ;; __all__.extend(["a"]) - extend pattern
      (module (expression_statement (call function: (attribute object: (identifier) @left attribute: (identifier) @method) arguments: (argument_list (list (string) @all_item)))) @stmt)
      ;; __all__.append("a") - append pattern
      (module (expression_statement (call function: (attribute object: (identifier) @left attribute: (identifier) @method) arguments: (argument_list (string) @all_item))) @stmt)
      ;; __all__ += ["a"] - augmented assignment
      (module (expression_statement (augmented_assignment left: (identifier) @left right: (list (string) @all_item)) @stmt))
      ;; An empty static list or tuple still defines an explicit export set.
      (module (expression_statement (assignment left: (identifier) @left right: [(list) (tuple)]) @stmt))
      (module (function_definition name: (identifier) @name))
      (module (class_definition name: (identifier) @name))
      (module (decorated_definition (function_definition name: (identifier) @name)))
      (module (decorated_definition (class_definition name: (identifier) @name)))
      (module (expression_statement (assignment left: (identifier) @name)))
      (module (expression_statement (assignment left: [(pattern_list (identifier) @name) (tuple_pattern (identifier) @name)])))
      (module (expression_statement (named_expression name: (identifier) @name)))
      (module (type_alias_statement left: (type [(identifier) @name (generic_type (identifier) @name)])))
      (class_definition body: (block (function_definition name: (identifier) @name)))
      (class_definition body: (block (class_definition name: (identifier) @name)))
      (class_definition body: (block (decorated_definition (function_definition name: (identifier) @name))))
      (class_definition body: (block (decorated_definition (class_definition name: (identifier) @name))))
      (class_definition body: (block (expression_statement (assignment left: (identifier) @name))))
      (class_definition body: (block (expression_statement (assignment left: [(pattern_list (identifier) @name) (tuple_pattern (identifier) @name)]))))
      (class_definition body: (block (expression_statement (named_expression name: (identifier) @name))))
      (class_definition body: (block (type_alias_statement left: (type [(identifier) @name (generic_type (identifier) @name)]))))
    `,
    locals: `
      (function_definition name: (identifier) @name)
      (class_definition name: (identifier) @name)
      (assignment left: (identifier) @name)
      (assignment left: [(pattern_list (identifier) @name) (tuple_pattern (identifier) @name)])
      (named_expression name: (identifier) @name)
      (type_alias_statement left: (type [(identifier) @name (generic_type (identifier) @name)]))
      ;; \`case Point(x=px, y=py):\` is case_pattern -> class_pattern ->
      ;; case_pattern -> keyword_pattern. The binding is the dotted_name child;
      ;; the left-hand attribute is a bare identifier and must not be captured.
      (keyword_pattern (dotted_name (identifier) @name))
      ;; A bare identifier in a case pattern is represented as a single-name
      ;; dotted_name inside a case_pattern. Nested tuple/list/or patterns
      ;; preserve this shape for each capture.
      (case_pattern (dotted_name (identifier) @name))
      ;; \`case value as alias:\` binds the direct identifier child as its alias.
      ;; \`except E as err\` / \`with … as handle\` put the binding in alias.
      (as_pattern !alias (identifier) @name)
      (as_pattern alias: (as_pattern_target (identifier) @name))
      ;; \`case [head, *tail]:\` binds the capture after the splat.
      (splat_pattern (identifier) @name)
    `,
    importBindings: `
      (import_statement) @stmt
      (import_from_statement) @stmt
      (future_import_statement) @stmt
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
    if (isTypeAliasLeftName(n)) return "type";
    return "variable";
  },
  scopeDeclarationNames: (node) => {
    const parentType = node.parent?.type;
    return (
      parentType === "case_pattern" ||
      parentType === "as_pattern" ||
      parentType === "as_pattern_target" ||
      parentType === "splat_pattern" ||
      parentType === "dotted_name" ||
      parentType === "named_expression" ||
      parentType === "pattern_list" ||
      parentType === "tuple_pattern" ||
      parentType === "type" ||
      parentType === "generic_type"
    );
  },
  isDeclarationName: (node) => {
    const parent = node.parent;
    const t = parent?.type;
    if (
      t === "dotted_name" &&
      parent &&
      parent.namedChildren.length === 1 &&
      (parent.parent?.type === "keyword_pattern" || parent.parent?.type === "case_pattern")
    )
      return true;
    if (t === "as_pattern_target") return true;
    if (t === "as_pattern") return parent?.childForFieldName("alias") == null;
    if (t === "splat_pattern") return true;
    if (t === "named_expression") return parent?.childForFieldName("name")?.id === node.id;
    if (t === "pattern_list" || t === "tuple_pattern") return true;
    if (isTypeAliasLeftName(node)) return true;
    return !!t && ["function_definition", "class_definition", "assignment", "aliased_import"].includes(t);
  },
  createsBlockScope: (n) => n.type === "module" || n.type === "block",
  createsFunctionScope: (n) => n.type === "function_definition" || n.type === "lambda",
  membersAreImplicitlyInScope: false,
  supportsCrossModuleSymbols: true,
  normalizeIdentifier: (name) => (hasNonAsciiCodePoint(name) ? name.normalize("NFKC") : name),
};
registerLanguage(PYTHON_DEF);
