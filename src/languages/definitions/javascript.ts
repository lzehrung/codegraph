import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import {
  ECMASCRIPT_CONTROL_SPLIT_POINTS,
  ECMASCRIPT_CORE_FUNCTION_BLOCKS,
  ECMASCRIPT_MODULE_VAR_BLOCKS,
} from "./jsFamily.js";

const JS_OBJECT_METHOD_EXPORT_PATTERN = `
      ;; CJS: module.exports = { helper () {} }
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (function_declaration) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports")
`;

const JS_OBJECT_METHOD_EXPORT_NATIVE_PATTERN = `
      ;; CJS: module.exports = { helper () {} }
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (method_definition name: (property_identifier) @cjs_export_name) @cjs_fn)))
        (#eq? @mod "module") (#eq? @prop "exports")
`;

export const JAVASCRIPT_DEF: LanguageDefinition = {
  id: "js",
  extensions: [".js", ".jsx", ".mjs", ".cjs"],
  supportsExportFromReferences: true,
  structure: {
    blocks: [...ECMASCRIPT_CORE_FUNCTION_BLOCKS, ...ECMASCRIPT_MODULE_VAR_BLOCKS],
    splitPoints: [...ECMASCRIPT_CONTROL_SPLIT_POINTS],
    comments: ["comment"],
  },
  graph: {
    imports: `
      (import_statement (string) @mod) @stmt
      (export_statement (string) @mod) @stmt
      (call_expression function: (import) arguments: (arguments (string) @mod)) @stmt
      ((call_expression function: (identifier) @fn arguments: (arguments (string) @mod)) @stmt
        (#eq? @fn "require"))
    `,
    exports: `
      (export_statement) @stmt
      (export_statement declaration: (function_declaration name: (identifier) @name)) @stmt
      (export_statement declaration: (generator_function_declaration name: (identifier) @name)) @stmt
      (export_statement declaration: (class_declaration name: (identifier) @name)) @stmt
      (export_statement declaration: (function_declaration) @anon_default) @stmt
      (export_statement declaration: (generator_function_declaration) @anon_default) @stmt
      (export_statement declaration: (class_declaration) @anon_default) @stmt
      (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name))) @stmt
      (export_statement (export_clause (export_specifier name: (identifier) @src alias: (identifier) @alias)) (string) @from)
      (export_statement (export_clause (export_specifier name: (identifier) @src !alias)) (string) @from)
      (export_statement (export_clause (export_specifier name: (identifier) @src alias: (identifier) @alias)))
      (export_statement (export_clause (export_specifier name: (identifier) @src !alias)))
      (export_statement (string) @from)
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (shorthand_property_identifier) @cjs_shorthand)))
        (#eq? @mod "module") (#eq? @prop "exports")
      ;; CJS spread export: module.exports = { ...base }
      ((expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (spread_element (identifier) @cjs_spread))) @stmt)
        (#eq? @mod "module") (#eq? @prop "exports"))
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (identifier) @cjs_local))))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (member_expression object: (identifier) @mod property: (property_identifier) @prop) property: (property_identifier) @cjs_export_name)
        right: (identifier) @cjs_local))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @exp property: (property_identifier) @cjs_export_name)
        right: (identifier) @cjs_local))
        (#eq? @exp "exports")
      ;; CJS function/arrow direct exports
      (expression_statement (assignment_expression
        left: (member_expression object: (member_expression object: (identifier) @mod property: (property_identifier) @prop) property: (property_identifier) @cjs_export_name)
        right: (function) @cjs_fn))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (member_expression object: (identifier) @mod property: (property_identifier) @prop) property: (property_identifier) @cjs_export_name)
        right: (arrow_function) @cjs_fn))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @exp property: (property_identifier) @cjs_export_name)
        right: (function) @cjs_fn))
        (#eq? @exp "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @exp property: (property_identifier) @cjs_export_name)
        right: (arrow_function) @cjs_fn))
        (#eq? @exp "exports")
      ;; CJS object export with function value
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (function) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (arrow_function) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports")
      ;; CJS: module.exports = { helper () {} }
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (function_declaration) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports")
    `,
    locals: `
      (function_declaration name: (identifier) @name)
      (generator_function_declaration name: (identifier) @name)
      (method_definition name: (property_identifier) @name)
      (class_declaration name: (identifier) @name)
      (variable_declarator name: (identifier) @name)
    `,
    importBindings: `
      (import_statement) @stmt
      (import_statement (string) @from) @stmt
      (import_statement (import_clause (identifier) @def) (string) @from) @stmt
      (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname alias: (identifier) @alias))) (string) @from) @stmt
      (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname))) (string) @from) @stmt
      (import_statement (import_clause (namespace_import (identifier) @ns)) (string) @from) @stmt
      (lexical_declaration (variable_declarator name:(identifier) @def value: (call_expression (identifier) @req arguments: (arguments (string) @from)))) (#eq? @req "require")
      (lexical_declaration (variable_declarator (object_pattern) @pattern value: (call_expression (identifier) @req arguments: (arguments (string) @from)))) (#eq? @req "require")
    `,
  },
  nodeTypes: {
    identifier: ["identifier"],
    propertyIdentifier: ["property_identifier"],
    shorthandPropertyIdentifier: ["shorthand_property_identifier", "shorthand_property_identifier_pattern"],
    memberExpression: "member_expression",
  },
  classifyDefinition: (n) => {
    const t = n.parent?.type;
    if (t === "function_declaration") return "function";
    if (t === "generator_function_declaration") return "function";
    if (t === "method_definition") return "function";
    if (t === "class_declaration") return "class";
    return "variable";
  },
  isDeclarationName: (node) => {
    const p = node.parent?.type;
    return (
      !!p &&
      [
        "function_declaration",
        "generator_function_declaration",
        "class_declaration",
        "variable_declarator",
        "import_specifier",
        "namespace_import",
        "import_clause",
        // Method names in classes: needed so that editing a method name is
        // classified as a definition change, not an unrecognised node.
        "method_definition",
      ].includes(p)
    );
  },
  createsBlockScope: (n) => n.type === "program" || n.type === "block" || n.type === "class_body",
  createsFunctionScope: (n) =>
    n.type === "function_declaration" ||
    n.type === "generator_function_declaration" ||
    n.type === "function" ||
    n.type === "function_expression" ||
    n.type === "arrow_function" ||
    n.type === "method_definition",
  membersAreImplicitlyInScope: false,
  supportsCrossModuleSymbols: true,
  native: {
    normalizeQuery: (_kind, query) =>
      query
        .replace(/\(function\)/g, "(function_expression)")
        .replace(JS_OBJECT_METHOD_EXPORT_PATTERN, JS_OBJECT_METHOD_EXPORT_NATIVE_PATTERN),
    authoritativeKinds: ["exports"],
    notes: ["normalizes function node compatibility for native javascript grammar"],
  },
};
registerLanguage(JAVASCRIPT_DEF);
