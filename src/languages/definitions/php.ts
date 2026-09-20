import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { classifyByParentType, isNameFieldOnParent } from "./shared.js";

// Include/require arguments are string | encapsed_string | binary_expression |
// variable_name | other expressions; no closed node-type list, so keep `(_)`.
const PHP_IMPORT_QUERY = `
      (require_expression (_) @from) @stmt
      (include_expression (_) @from) @stmt
      (require_once_expression (_) @from) @stmt
      (include_once_expression (_) @from) @stmt
      (namespace_use_declaration (namespace_use_clause (qualified_name) @from alias: (name) @alias)) @stmt
      (namespace_use_declaration (namespace_use_clause (qualified_name) @from !alias)) @stmt
      (namespace_use_declaration (namespace_use_clause (name) @from alias: (name) @alias)) @stmt
      (namespace_use_declaration (namespace_use_clause (name) @from !alias)) @stmt
      (namespace_use_declaration (namespace_name) @from (namespace_use_group)) @stmt
    `;

export const PHP_DEF: LanguageDefinition = {
  id: "php",
  extensions: [".php", ".phtml", ".php4", ".php8"],
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
        nameQuery: "(const_element . (name) @chunk.name)",
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
    // Path-bearing nodes: include/require argument, `use Foo\Bar` qualified_name.
    // Grouped `use Foo\{A}` has no single node for `Foo\A` (prefix + clause); the
    // prefix is `@from`. Concatenated includes (`__DIR__ . "/x"`) capture the
    // expression. PHP has no star-import token, so there is no `@wild`.
    imports: PHP_IMPORT_QUERY,
    exports: `
      (namespace_definition name: (namespace_name) @name)
      (class_declaration name: (name) @name)
      (interface_declaration name: (name) @name)
      (trait_declaration name: (name) @name)
      (enum_declaration name: (name) @name)
      (enum_case name: (name) @name)
      (function_definition name: (name) @name)
      (const_declaration (const_element . (name) @name))
    `,
    locals: `
      (class_declaration name: (name) @name)
      (interface_declaration name: (name) @name)
      (trait_declaration name: (name) @name)
      (enum_declaration name: (name) @name)
      (enum_case name: (name) @name)
      (function_definition name: (name) @name)
      (method_declaration name: (name) @name)
      (const_declaration (const_element . (name) @name))
      (property_element name: (variable_name) @name)
    `,
    importBindings: PHP_IMPORT_QUERY,
  },
  nodeTypes: {
    identifier: ["name", "variable_name", "namespace_name", "qualified_name", "relative_name"],
    propertyIdentifier: ["name"],
    memberExpression: "member_access_expression",
  },
  classifyDefinition: classifyByParentType({
    class_declaration: "class",
    interface_declaration: "interface",
    trait_declaration: "trait",
    enum_declaration: "type",
    enum_case: "constant",
    function_definition: "function",
    method_declaration: "method",
    namespace_definition: "namespace",
    const_element: "constant",
    const_declaration: "constant",
  }),
  normalizeIdentifier: (name) => name.replace(/^\$/, ""),
  isDeclarationName: (node) =>
    isNameFieldOnParent(node, [
      "namespace_definition",
      "class_declaration",
      "interface_declaration",
      "trait_declaration",
      "enum_declaration",
      "enum_case",
      "function_definition",
      "method_declaration",
      // `property_element` exposes the declared name via the `name` field and any
      // initializer via `default_value`; field identity keeps a default value that
      // happens to be a bare variable reference from being misread as a declaration.
      "property_element",
    ]) ||
    // `const_element` has no named fields (grammar: `seq($.name, '=', $.expression)`),
    // so the declared name is identified positionally as the first namedChild; a
    // value that is itself a bare `name` reference (e.g. `const X = SOME_CONST;`)
    // is the second namedChild and must not qualify.
    (node.parent?.type === "const_element" && node.parent.namedChildren[0]?.id === node.id && node.type === "name"),
  scopeDeclarationNames: (node) => node.type === "variable_name" && node.parent?.type === "property_element",
  createsFunctionScope: (node) => node.type === "function_definition" || node.type === "method_declaration",
  // PHP `if`/`while`/function bodies are all `compound_statement`; without a block scope a
  // nested declaration leaks into the enclosing scope.
  createsBlockScope: (node) => node.type === "compound_statement",
  // The exports query anchors unanchored, so a `function_definition` nested inside another
  // function's `compound_statement` would otherwise publish as a module export.
  exportScopeBlockers: ["compound_statement"],
  supportsCrossModuleSymbols: true,
};

registerLanguage(PHP_DEF);
