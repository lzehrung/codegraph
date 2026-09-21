import type { LanguageDefinition, SyntaxNodeLike } from "../types.js";
import { registerLanguage } from "../registry.js";
import { classifyByParentType, hasParentType, isNameOrPropertyFieldOnParent, nodeTypeIn } from "./shared.js";
import {
  ECMASCRIPT_BLOCK_SCOPE_TYPES,
  ECMASCRIPT_CONTROL_SPLIT_POINTS,
  ECMASCRIPT_CORE_FUNCTION_BLOCKS,
  ECMASCRIPT_DECLARATION_NAME_PARENTS,
  ECMASCRIPT_FUNCTION_SCOPE_TYPES,
  ECMASCRIPT_MODULE_VAR_BLOCKS,
  isEcmaScriptTypeOnlyStatement,
  isEcmaScriptVariableDeclaratorName,
} from "./js-family.js";

function normalizeTypeScriptNativeQuery(kind: string, query: string): string {
  let normalized = query.replace(
    /\(class_declaration name: \(identifier\) @/g,
    "(class_declaration name: (type_identifier) @",
  );
  if (kind !== "exports") {
    return normalized;
  }
  normalized = normalized.replace(/^\s*\(export_assignment \(identifier\) @ts_export_assign\)\s*$/gm, "");
  return normalized;
}

const TYPESCRIPT_CLASS_BLOCK = {
  type: "class_declaration",
  nameQuery: "name: (type_identifier) @chunk.name",
  captureId: "class",
} as const;

const BASE_STRUCTURE = {
  blocks: [
    TYPESCRIPT_CLASS_BLOCK,
    ...ECMASCRIPT_CORE_FUNCTION_BLOCKS.filter((block) => block.type !== "class_declaration"),
    // TS Specifics
    {
      type: "interface_declaration",
      nameQuery: "name: (type_identifier) @chunk.name",
      captureId: "interface",
    },
    {
      type: "enum_declaration",
      nameQuery: "name: [ (identifier) (type_identifier) ] @chunk.name",
      captureId: "enum",
    },
    {
      type: "type_alias_declaration",
      nameQuery: "name: (type_identifier) @chunk.name",
      captureId: "type_alias",
    },
    {
      type: "internal_module",
      nameQuery: "name: (identifier) @chunk.name body: (statement_block) @chunk.block.namespace",
      captureId: "namespace",
    },
    {
      type: "module",
      nameQuery: "name: [ (identifier) (string) ] @chunk.name body: (statement_block) @chunk.block.namespace",
      captureId: "namespace",
    },

    // Data
    { type: "object", captureId: "data" },

    // Top level vars
    ...ECMASCRIPT_MODULE_VAR_BLOCKS.map((block) =>
      block.type === "import_statement" ? { ...block, parentType: "program" as const } : block,
    ),
  ],
  splitPoints: [...ECMASCRIPT_CONTROL_SPLIT_POINTS, "switch_case", "switch_default"],
  comments: ["comment"],
};

const BASE_GRAPH = {
  imports: `
    (import_statement (string) @from) @stmt
    ;; import x = require("...") is represented via import_require_clause
    (import_statement (import_require_clause (string) @from)) @stmt
    (export_statement (string) @from) @stmt
    (call_expression function: (import) arguments: (arguments (string) @from)) @stmt
    ;; declare module "foo" {} — ambient module augmentations create a type-only
    ;; dependency on the named module and must appear in the file graph so that
    ;; changes to "foo" propagate to augmenting files (and vice-versa).
    ;; The inner node type is "module" (not "module_declaration"); its string
    ;; child uses field-name "name".
    (ambient_declaration (module name: (string) @from)) @stmt
  `,
  exports: `
    (export_statement) @stmt
    (export_statement declaration: (function_declaration name: (identifier) @name)) @stmt
    (export_statement declaration: (function_signature name: (identifier) @name)) @stmt
    (export_statement declaration: (generator_function_declaration name: (identifier) @name)) @stmt
    (export_statement declaration: (class_declaration name: (type_identifier) @name)) @stmt
    (export_statement declaration: (abstract_class_declaration name: (type_identifier) @name)) @stmt
    (export_statement declaration: (enum_declaration name: [ (identifier) (type_identifier) ] @name)) @stmt
    (export_statement declaration: (internal_module name: (identifier) @name)) @stmt
    (export_statement declaration: (module name: (identifier) @name)) @stmt
    (export_statement declaration: (ambient_declaration (function_signature name: (identifier) @name))) @stmt
    (export_statement declaration: (ambient_declaration (internal_module name: (identifier) @name))) @stmt
    (export_statement declaration: (ambient_declaration (module name: (identifier) @name))) @stmt
    (export_statement declaration: (function_declaration) @anon_default) @stmt
    (export_statement declaration: (generator_function_declaration) @anon_default) @stmt
    (export_statement declaration: (class_declaration) @anon_default) @stmt
    (export_statement declaration: (abstract_class_declaration) @anon_default) @stmt
    (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name))) @stmt
    (export_statement (export_clause (export_specifier "type"? @type_kw name: (identifier) @src alias: (identifier) @alias)) (string) @from) @stmt
    (export_statement (export_clause (export_specifier "type"? @type_kw name: (identifier) @src !alias)) (string) @from) @stmt
    (export_statement (export_clause (export_specifier "type"? @type_kw name: (identifier) @src alias: (identifier) @alias))) @stmt
    (export_statement (export_clause (export_specifier "type"? @type_kw name: (identifier) @src !alias))) @stmt
    (export_statement "*" @wild (string) @from) @stmt
    (export_statement (string) @from) @stmt
    (export_assignment (identifier) @ts_export_assign)
  `,
  locals: `
    (function_declaration name: (identifier) @name)
    (generator_function_declaration name: (identifier) @name)
    (method_definition name: (property_identifier) @name)
    (public_field_definition name: (property_identifier) @name)
    (method_signature name: (property_identifier) @name)
    (abstract_method_signature name: (property_identifier) @name)
    (function_signature name: (identifier) @name)
    (class_declaration name: (type_identifier) @name)
    (abstract_class_declaration name: (type_identifier) @name)
    (variable_declarator name: (identifier) @name)
    (interface_declaration name: (type_identifier) @name)
    (type_alias_declaration name: (type_identifier) @name)
    (enum_body (property_identifier) @name)
    (enum_assignment name: (property_identifier) @name)
    (enum_declaration name: [ (identifier) (type_identifier) ] @name)
    (internal_module name: (identifier) @name)
    (module name: (identifier) @name)
  `,
  importBindings: `
    (import_statement) @stmt
    (import_statement (string) @from) @stmt
    (import_statement (import_require_clause (identifier) @def (string) @from)) @stmt
    (import_statement (import_clause (identifier) @def) (string) @from) @stmt
    (import_statement (import_clause (named_imports (import_specifier "type"? @type_kw name: (identifier) @iname alias: (identifier) @alias))) (string) @from) @stmt
    (import_statement (import_clause (named_imports (import_specifier "type"? @type_kw name: (identifier) @iname !alias))) (string) @from) @stmt
    (import_statement (import_clause (namespace_import (identifier) @ns)) (string) @from) @stmt
  `,
};

const BASE_HELPERS = {
  nodeTypes: {
    identifier: ["identifier", "type_identifier"],
    propertyIdentifier: ["property_identifier"],
    shorthandPropertyIdentifier: ["shorthand_property_identifier", "shorthand_property_identifier_pattern"],
    memberExpression: "member_expression",
  },
  // A named function expression's own name is a function-kind binding, matching the
  // declaration forms; the grammar spells the expression forms without the `_declaration`
  // suffix (`function_expression`, `generator_function`).
  classifyDefinition: classifyByParentType({
    function_declaration: "function",
    generator_function_declaration: "function",
    function_expression: "function",
    generator_function: "function",
    method_definition: "function",
    method_signature: "function",
    abstract_method_signature: "function",
    function_signature: "function",
    class_declaration: "class",
    abstract_class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "type",
    internal_module: "type",
    module: "type",
  }),
  isDeclarationName: (node: SyntaxNodeLike) => {
    const parent = node.parent;
    if (isEcmaScriptVariableDeclaratorName(node)) return true;
    if (isNameOrPropertyFieldOnParent(node, ["public_field_definition", "enum_assignment"])) return true;
    if (parent?.type === "enum_body") {
      return node.type === "property_identifier";
    }
    return hasParentType(node, [
      ...ECMASCRIPT_DECLARATION_NAME_PARENTS,
      "abstract_class_declaration",
      "interface_declaration",
      "type_alias_declaration",
      "enum_declaration",
      "function_signature",
      "internal_module",
      "module",
      "import_equals_declaration",
      // Method names in classes and abstract method signatures: needed so
      // that editing a method name is classified as a definition change.
      "method_signature",
      "abstract_method_signature",
      // A named function expression binds its own name inside its body:
      // `const f = function inner() {}` and `$scope.refresh = function refresh() {}`.
      "generator_function",
    ]);
  },
  // Scope construction has structural handling for the ordinary declaration forms. Ambient
  // overload signatures, `namespace X {}`, and a named function expression's own name are not
  // in it, so opt their name nodes in here; `isDeclarationName` already accepts every parent.
  // The function-expression name is registered after the function scope is pushed, so it lands
  // in that scope: visible to the body (and recursive calls) but never to the module.
  scopeDeclarationNames: (node: SyntaxNodeLike) => {
    const parent = node.parent?.type;
    return (
      parent === "function_signature" ||
      parent === "internal_module" ||
      parent === "module" ||
      parent === "function_expression" ||
      parent === "generator_function"
    );
  },
  createsBlockScope: nodeTypeIn([...ECMASCRIPT_BLOCK_SCOPE_TYPES, "enum_body"]),
  // A generator function expression has its own body scope: without this, its own name
  // (registered above) and its parameters would land in the enclosing scope.
  createsFunctionScope: nodeTypeIn([...ECMASCRIPT_FUNCTION_SCOPE_TYPES, "generator_function"]),
  supportsCrossModuleSymbols: true,
};

export const TYPESCRIPT_DEF: LanguageDefinition = {
  id: "ts",
  extensions: [".ts", ".mts", ".cts"],
  structure: BASE_STRUCTURE,
  graph: BASE_GRAPH,
  supportsExportFromReferences: true,
  ...BASE_HELPERS,
  isTypeOnly: isEcmaScriptTypeOnlyStatement,
  native: {
    normalizeQuery: normalizeTypeScriptNativeQuery,
    authoritativeKinds: ["exports"],
    notes: ["drops unsupported TypeScript export-assignment nodes while keeping native export results authoritative"],
  },
};
registerLanguage(TYPESCRIPT_DEF);

export const TSX_DEF: LanguageDefinition = {
  id: "tsx",
  extensions: [".tsx"],
  structure: {
    ...BASE_STRUCTURE,
    blocks: [
      ...BASE_STRUCTURE.blocks,
      { type: "jsx_element", captureId: "jsx" },
      { type: "jsx_self_closing_element", captureId: "jsx" },
    ],
  },
  graph: BASE_GRAPH,
  supportsExportFromReferences: true,
  ...BASE_HELPERS,
  isTypeOnly: isEcmaScriptTypeOnlyStatement,
  native: {
    normalizeQuery: normalizeTypeScriptNativeQuery,
    authoritativeKinds: ["exports"],
    notes: ["drops unsupported TypeScript export-assignment nodes while keeping native export results authoritative"],
  },
};
registerLanguage(TSX_DEF);
