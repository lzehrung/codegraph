import type { LanguageDefinition } from "../types.js";
import { registerLanguage } from "../registry.js";
import { classifyByParentType, hasParentType, nodeTypeIn } from "./shared.js";
import {
  ECMASCRIPT_BLOCK_SCOPE_TYPES,
  ECMASCRIPT_CONTROL_SPLIT_POINTS,
  ECMASCRIPT_CORE_FUNCTION_BLOCKS,
  ECMASCRIPT_DECLARATION_NAME_PARENTS,
  ECMASCRIPT_FUNCTION_SCOPE_TYPES,
  ECMASCRIPT_MODULE_VAR_BLOCKS,
  isEcmaScriptFieldDefinitionName,
  isEcmaScriptTypeOnlyStatement,
  isEcmaScriptVariableDeclaratorName,
} from "./js-family.js";

const JS_OBJECT_METHOD_EXPORT_PATTERN = `
      ;; CJS: module.exports = { helper () {} }
      ((expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (function_declaration) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports"))
`;

const JS_OBJECT_METHOD_EXPORT_NATIVE_PATTERN = `
      ;; CJS: module.exports = { helper () {} }
      ((expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (method_definition name: (property_identifier) @cjs_export_name) @cjs_fn)))
        (#eq? @mod "module") (#eq? @prop "exports"))
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
      (import_statement (string) @from) @stmt
      (export_statement (string) @from) @stmt
      (call_expression function: (import) arguments: (arguments (string) @from)) @stmt
      ((call_expression function: (identifier) @fn arguments: (arguments (string) @from)) @stmt
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
      (export_statement "*" @wild (string) @from)
      (export_statement (string) @from)
      ;; CJS whole-module export: module.exports = function () {} / = () => {}
      ;; @mod is the identifier module in module.exports, not a specifier; keep it out of GraphImportCapture.
      ((expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @cjs_export_name)
        right: [ (function) (arrow_function) ] @cjs_fn))
        (#eq? @mod "module") (#eq? @cjs_export_name "exports"))
      ((expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (shorthand_property_identifier) @cjs_shorthand)))
        (#eq? @mod "module") (#eq? @prop "exports"))
      ;; CJS spread export: module.exports = { ...base }
      ((expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (spread_element (identifier) @cjs_spread))) @stmt)
        (#eq? @mod "module") (#eq? @prop "exports"))
      ((expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (identifier) @cjs_local))))
        (#eq? @mod "module") (#eq? @prop "exports"))
      ((expression_statement (assignment_expression
        left: (member_expression object: (member_expression object: (identifier) @mod property: (property_identifier) @prop) property: (property_identifier) @cjs_export_name)
        right: (identifier) @cjs_local))
        (#eq? @mod "module") (#eq? @prop "exports"))
      ((expression_statement (assignment_expression
        left: (member_expression object: (identifier) @exp property: (property_identifier) @cjs_export_name)
        right: (identifier) @cjs_local))
        (#eq? @exp "exports"))
      ;; CJS function/arrow direct exports
      ((expression_statement (assignment_expression
        left: (member_expression object: (member_expression object: (identifier) @mod property: (property_identifier) @prop) property: (property_identifier) @cjs_export_name)
        right: (function) @cjs_fn))
        (#eq? @mod "module") (#eq? @prop "exports"))
      ((expression_statement (assignment_expression
        left: (member_expression object: (member_expression object: (identifier) @mod property: (property_identifier) @prop) property: (property_identifier) @cjs_export_name)
        right: (arrow_function) @cjs_fn))
        (#eq? @mod "module") (#eq? @prop "exports"))
      ((expression_statement (assignment_expression
        left: (member_expression object: (identifier) @exp property: (property_identifier) @cjs_export_name)
        right: (function) @cjs_fn))
        (#eq? @exp "exports"))
      ((expression_statement (assignment_expression
        left: (member_expression object: (identifier) @exp property: (property_identifier) @cjs_export_name)
        right: (arrow_function) @cjs_fn))
        (#eq? @exp "exports"))
      ;; CJS object export with function value
      ((expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (function) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports"))
      ((expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (arrow_function) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports"))
      ;; CJS: module.exports = { helper () {} }
      ((expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (function_declaration) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports"))
    `,
    locals: `
      (function_declaration name: (identifier) @name)
      (generator_function_declaration name: (identifier) @name)
      (method_definition name: (property_identifier) @name)
      (field_definition property: (property_identifier) @name)
      (class_declaration name: (identifier) @name)
      (variable_declarator name: (identifier) @name)
    `,
    importBindings: `
      (import_statement) @stmt
      (import_statement (string) @from) @stmt
      (import_statement (import_clause (identifier) @def) (string) @from) @stmt
      (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname alias: (identifier) @alias))) (string) @from) @stmt
      (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname !alias))) (string) @from) @stmt
      (import_statement (import_clause (namespace_import (identifier) @ns)) (string) @from) @stmt
      ((lexical_declaration (variable_declarator name:(identifier) @def value: (call_expression (identifier) @req arguments: (arguments (string) @from))))
        (#eq? @req "require"))
      ((lexical_declaration (variable_declarator (object_pattern) @pattern value: (call_expression (identifier) @req arguments: (arguments (string) @from))))
        (#eq? @req "require"))
    `,
  },
  nodeTypes: {
    identifier: ["identifier"],
    propertyIdentifier: ["property_identifier"],
    shorthandPropertyIdentifier: ["shorthand_property_identifier", "shorthand_property_identifier_pattern"],
    memberExpression: "member_expression",
  },
  classifyDefinition: classifyByParentType({
    function_declaration: "function",
    generator_function_declaration: "function",
    method_definition: "function",
    function: "function",
    function_expression: "function",
    class_declaration: "class",
  }),
  isDeclarationName: (node) =>
    isEcmaScriptVariableDeclaratorName(node) ||
    isEcmaScriptFieldDefinitionName(node, "field_definition") ||
    // `function` is the JS grammar's function-expression node; the TS grammar spells it
    // `function_expression` instead.
    hasParentType(node, [...ECMASCRIPT_DECLARATION_NAME_PARENTS, "function"]),
  // Scope construction has no structural handling for a function expression's own name.
  scopeDeclarationNames: (node) => {
    const parent = node.parent?.type;
    return parent === "function" || parent === "function_expression";
  },
  createsBlockScope: nodeTypeIn([...ECMASCRIPT_BLOCK_SCOPE_TYPES]),
  createsFunctionScope: nodeTypeIn([...ECMASCRIPT_FUNCTION_SCOPE_TYPES, "function"]),
  supportsCrossModuleSymbols: true,
  // JSDoc-typed `.js` files use `import type` / `export type`; the JS grammar has no type-only
  // syntax, so classification matches the statement text like TypeScript's.
  isTypeOnly: isEcmaScriptTypeOnlyStatement,
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
