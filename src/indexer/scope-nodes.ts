/**
 * Per-language node-name tables for scope construction in `./scope.js`.
 *
 * Rows are keyed by language id, following the trivia-table precedent in `../util/trivia-tables.js`:
 * the walker keeps the algorithm, the table keeps the node names. Every list is the intersection of
 * the pre-table global list in `scope.js` with the node types the pinned grammar of that language
 * actually produces, so moving the data here is behavior-preserving. `tests/scope-node-tables.test.ts`
 * re-derives both halves from the pinned grammar, fails when a row drifts, and asserts that every
 * function-scope node type with a name field has a name-registration entry.
 *
 * Fields are optional: an absent field means the language has no node of that shape.
 *
 * Three fields deviate from that intersection on purpose. `assignmentIdentifierTypes` is declared
 * only where the grammar also has `assignmentDeclarationTypes`, and the ECMAScript row omits
 * `enumBodyMemberTypes`, because the walker reads each of them only in conjunction with the second
 * field, which is absent in those rows. Zig's `memberContainerTypes` is deliberately wider than the
 * intersection: Zig has no implicit member scope, so a container's member functions must not land
 * in the file scope.
 */

export type ScopeNodeRow = {
  /** Ancestor node types that mark an identifier as a parameter rather than a declaration. */
  parameterParents?: ReadonlySet<string>;
  /** Node types whose `name` field is registered in the enclosing scope before the body scope is pushed. */
  functionNameTypes?: ReadonlySet<string>;
  /**
   * Function-scope node types the pinned grammar gives an identifier-typed `name` field, but which
   * deliberately register nothing: the field holds no binding at all (a lambda or an initializer)
   * or holds the containing type's own name (a constructor or destructor), which the container's
   * declaration already binds. `tests/scope-node-tables.test.ts` re-derives each entry from the
   * pinned grammar by parsing a minimal sample.
   */
  unnamedFunctionScopeTypes?: ReadonlySet<string>;
  /** Node types whose `name` field is registered as a class. */
  classNameTypes?: ReadonlySet<string>;
  /** Node types whose `name` field is registered as a type. */
  typeNameTypes?: ReadonlySet<string>;
  /** Node types that push a dedicated scope for the type parameters they declare. */
  typeScopeTypes?: ReadonlySet<string>;
  /** Node types whose member names become module-level extra bindings instead of lexical bindings. */
  enumMemberTypes?: ReadonlySet<string>;
  /** Enum-member node types registered in the current scope instead of as extra bindings. */
  enumMemberLocalTypes?: ReadonlySet<string>;
  /** Node types whose `name` field is registered as a local. */
  enumAssignmentTypes?: ReadonlySet<string>;
  /** Node types registered as locals when their parent is an enum body. */
  enumBodyMemberTypes?: ReadonlySet<string>;
  /** Parent node types that make an `enumBodyMemberTypes` node an enum member. */
  enumBodyParentTypes?: ReadonlySet<string>;
  /** Pattern node types whose `name` field is a bound variable (C# `is` patterns). */
  declarationPatternTypes?: ReadonlySet<string>;
  /** Node types whose `name` field is a type parameter. */
  typeParameterTypes?: ReadonlySet<string>;
  /** Node types the variable-declaration walker inspects. */
  variableDeclarationTypes?: ReadonlySet<string>;
  /** Child node types that carry the declared name inside a variable declaration. */
  variableDeclaratorTypes?: ReadonlySet<string>;
  /** Variable-declaration node types that also register bare identifier children. */
  assignmentDeclarationTypes?: ReadonlySet<string>;
  /** Child node types registered directly inside an `assignmentDeclarationTypes` node. */
  assignmentIdentifierTypes?: ReadonlySet<string>;
  /** Node types whose `pattern` or `name` field is registered as a local. */
  patternBindingTypes?: ReadonlySet<string>;
  /** Node types whose left-hand side is a pattern (`:=` style declarations). */
  shortVariableDeclarationTypes?: ReadonlySet<string>;
  /** Node types that put a declared name and a type node side by side, so the type node is skipped. */
  destructuringTypeFieldTypes?: ReadonlySet<string>;
  /** Node types that destructure a value reached through their `value` field. */
  destructuringPairPatternTypes?: ReadonlySet<string>;
  /** Node types that destructure an object through their named children. */
  destructuringObjectPatternTypes?: ReadonlySet<string>;
  /** Child node types inside a `destructuringObjectPatternTypes` node that bind a name. */
  destructuringShorthandTypes?: ReadonlySet<string>;
  /** Node types that count as member functions when they nest inside a member container. */
  memberFunctionTypes?: ReadonlySet<string>;
  /** Node types that make a nested function a member rather than a file-scope declaration. */
  memberContainerTypes?: ReadonlySet<string>;
  /** Child node types skipped when they hold the name or the parameters of a name-registering node. */
  childSkipNameTypes?: ReadonlySet<string>;
  /** Node types that are the file root, so no block scope is pushed for them. */
  moduleRootTypes?: ReadonlySet<string>;
  /** Function declaration node types hoisted to the enclosing function scope (ECMAScript). */
  hoistedFunctionTypes?: ReadonlySet<string>;
  /** Variable declaration node types hoisted to the enclosing function scope (ECMAScript `var`). */
  hoistedVariableDeclarationTypes?: ReadonlySet<string>;
  /** CommonJS `require` call shape. Only the ECMAScript family can reach it: the walker consults it
   * for the `value` of a `variableDeclaratorTypes` child, and no other registered grammar puts a
   * `call_expression` there. */
  requireCall?: {
    callTypes: ReadonlySet<string>;
    calleeNames: ReadonlySet<string>;
    argumentsPattern: RegExp;
  };
  /** Variable declaration with no `name` field, where the first identifier is the declared name
   * (Zig). An `@import` declaration keeps its namespace binding. */
  namelessVariableDeclaration?: {
    declarationTypes: ReadonlySet<string>;
    importCallPattern: RegExp;
  };
  /** Scoped-enum rule: an enumerator under one of these declarations whose text matches
   * `scopedKeywordPattern` is scoped to its enum and does not bind a file-scope name (C++). */
  scopedEnum?: {
    enumDeclarationTypes: ReadonlySet<string>;
    scopedKeywordPattern: RegExp;
  };
};

const ECMASCRIPT_SCOPE_NODES: ScopeNodeRow = {
  functionNameTypes: new Set(["function_declaration", "generator_function_declaration", "method_definition"]),
  classNameTypes: new Set(["class_declaration", "class"]),
  variableDeclarationTypes: new Set(["variable_declaration", "lexical_declaration"]),
  variableDeclaratorTypes: new Set(["variable_declarator"]),
  destructuringPairPatternTypes: new Set(["pair_pattern"]),
  destructuringObjectPatternTypes: new Set(["object_pattern"]),
  destructuringShorthandTypes: new Set(["shorthand_property_identifier", "shorthand_property_identifier_pattern"]),
  memberFunctionTypes: new Set(["method_definition"]),
  memberContainerTypes: new Set(["class_body", "class_declaration", "class"]),
  childSkipNameTypes: new Set(["identifier"]),
  moduleRootTypes: new Set(["program"]),
  hoistedFunctionTypes: new Set(["function_declaration", "generator_function_declaration"]),
  hoistedVariableDeclarationTypes: new Set(["variable_declaration"]),
  requireCall: {
    callTypes: new Set(["call_expression"]),
    calleeNames: new Set(["require"]),
    argumentsPattern: /^\(\s*["'][^"']+["']\s*\)$/,
  },
};

const TYPESCRIPT_SCOPE_NODES: ScopeNodeRow = {
  ...ECMASCRIPT_SCOPE_NODES,
  classNameTypes: new Set(["class_declaration", "abstract_class_declaration", "class", "module"]),
  typeNameTypes: new Set(["interface_declaration", "type_alias_declaration", "enum_declaration"]),
  enumAssignmentTypes: new Set(["enum_assignment"]),
  enumBodyMemberTypes: new Set(["property_identifier"]),
  enumBodyParentTypes: new Set(["enum_body"]),
  childSkipNameTypes: new Set(["identifier", "type_identifier"]),
  moduleRootTypes: new Set(["program", "module"]),
};

const C_SCOPE_NODES: ScopeNodeRow = {
  parameterParents: new Set(["parameter_declaration"]),
  functionNameTypes: new Set(["function_definition"]),
  typeNameTypes: new Set(["enum_specifier"]),
  enumMemberTypes: new Set(["enumerator"]),
  enumMemberLocalTypes: new Set(["enumerator"]),
  variableDeclarationTypes: new Set(["field_declaration"]),
  destructuringTypeFieldTypes: new Set(["parameter_declaration"]),
  childSkipNameTypes: new Set(["identifier", "type_identifier"]),
};

const DOCUMENT_SCOPE_NODES: ScopeNodeRow = {};

const STYLE_SCOPE_NODES: ScopeNodeRow = {
  childSkipNameTypes: new Set(["identifier"]),
};

export const SCOPE_NODE_ROWS: Record<string, ScopeNodeRow> = {
  js: ECMASCRIPT_SCOPE_NODES,
  ts: TYPESCRIPT_SCOPE_NODES,
  tsx: TYPESCRIPT_SCOPE_NODES,
  python: {
    parameterParents: new Set(["parameter", "lambda_parameters"]),
    functionNameTypes: new Set(["function_definition"]),
    classNameTypes: new Set(["class_definition", "module"]),
    variableDeclarationTypes: new Set(["assignment"]),
    assignmentDeclarationTypes: new Set(["assignment"]),
    assignmentIdentifierTypes: new Set(["identifier"]),
    memberContainerTypes: new Set(["class_definition"]),
    childSkipNameTypes: new Set(["identifier", "parameters"]),
    moduleRootTypes: new Set(["module"]),
  },
  php: {
    functionNameTypes: new Set(["function_definition", "method_declaration"]),
    classNameTypes: new Set(["class_declaration"]),
    typeNameTypes: new Set(["interface_declaration", "enum_declaration"]),
    enumMemberTypes: new Set(["enum_case"]),
    variableDeclarationTypes: new Set(["const_declaration"]),
    memberFunctionTypes: new Set(["method_declaration"]),
    memberContainerTypes: new Set(["class_declaration"]),
    moduleRootTypes: new Set(["program"]),
  },
  go: {
    parameterParents: new Set(["parameter_declaration"]),
    functionNameTypes: new Set(["function_declaration", "method_declaration", "func_literal"]),
    typeNameTypes: new Set(["type_spec"]),
    typeScopeTypes: new Set(["type_spec"]),
    typeParameterTypes: new Set(["type_parameter_declaration"]),
    variableDeclarationTypes: new Set([
      "field_declaration",
      "var_declaration",
      "const_declaration",
      "short_var_declaration",
    ]),
    variableDeclaratorTypes: new Set(["var_spec", "const_spec"]),
    shortVariableDeclarationTypes: new Set(["short_var_declaration"]),
    destructuringTypeFieldTypes: new Set(["parameter_declaration", "variadic_parameter_declaration"]),
    memberFunctionTypes: new Set(["method_declaration"]),
    childSkipNameTypes: new Set(["identifier", "type_identifier"]),
  },
  java: {
    functionNameTypes: new Set(["method_declaration"]),
    unnamedFunctionScopeTypes: new Set(["constructor_declaration"]),
    classNameTypes: new Set(["class_declaration"]),
    typeNameTypes: new Set(["interface_declaration", "enum_declaration"]),
    enumMemberTypes: new Set(["enum_constant"]),
    enumBodyParentTypes: new Set(["enum_body"]),
    variableDeclarationTypes: new Set(["field_declaration", "local_variable_declaration"]),
    variableDeclaratorTypes: new Set(["variable_declarator"]),
    memberFunctionTypes: new Set(["method_declaration"]),
    memberContainerTypes: new Set(["class_body", "class_declaration"]),
    childSkipNameTypes: new Set(["identifier", "type_identifier"]),
    moduleRootTypes: new Set(["program"]),
  },
  csharp: {
    parameterParents: new Set(["parameter"]),
    functionNameTypes: new Set(["method_declaration", "local_function_statement"]),
    unnamedFunctionScopeTypes: new Set(["constructor_declaration", "destructor_declaration"]),
    classNameTypes: new Set(["class_declaration"]),
    typeNameTypes: new Set(["interface_declaration", "enum_declaration"]),
    enumMemberTypes: new Set(["enum_member_declaration"]),
    declarationPatternTypes: new Set(["declaration_pattern"]),
    variableDeclarationTypes: new Set(["variable_declaration", "field_declaration"]),
    variableDeclaratorTypes: new Set(["variable_declarator"]),
    memberFunctionTypes: new Set(["method_declaration"]),
    memberContainerTypes: new Set(["class_declaration"]),
    childSkipNameTypes: new Set(["identifier"]),
  },
  rust: {
    parameterParents: new Set(["parameter"]),
    functionNameTypes: new Set(["function_item"]),
    classNameTypes: new Set(["struct_item", "mod_item"]),
    typeNameTypes: new Set(["trait_item", "enum_item"]),
    enumMemberTypes: new Set(["enum_variant"]),
    variableDeclarationTypes: new Set(["field_declaration", "let_declaration", "const_item", "static_item"]),
    patternBindingTypes: new Set(["let_declaration", "const_item", "static_item"]),
    memberContainerTypes: new Set(["impl_item"]),
    childSkipNameTypes: new Set(["identifier", "type_identifier", "parameters"]),
  },
  c: C_SCOPE_NODES,
  cpp: {
    ...C_SCOPE_NODES,
    typeParameterTypes: new Set(["type_parameter_declaration"]),
    destructuringTypeFieldTypes: new Set(["parameter_declaration", "variadic_parameter_declaration"]),
    scopedEnum: {
      enumDeclarationTypes: new Set(["enum_specifier"]),
      scopedKeywordPattern: /^\s*enum\s+(?:class|struct)\b/,
    },
  },
  kotlin: {
    parameterParents: new Set(["parameter", "class_parameter", "lambda_parameters"]),
    functionNameTypes: new Set(["function_declaration"]),
    classNameTypes: new Set(["class_declaration"]),
    enumMemberTypes: new Set(["enum_entry"]),
    unnamedFunctionScopeTypes: new Set(["lambda_literal"]),
    variableDeclarationTypes: new Set(["variable_declaration", "assignment"]),
    assignmentDeclarationTypes: new Set(["assignment"]),
    assignmentIdentifierTypes: new Set(["identifier"]),
    memberContainerTypes: new Set(["class_body", "class_declaration"]),
    childSkipNameTypes: new Set(["identifier"]),
  },
  swift: {
    parameterParents: new Set(["parameter"]),
    functionNameTypes: new Set(["function_declaration"]),
    classNameTypes: new Set(["class_declaration"]),
    enumMemberTypes: new Set(["enum_entry"]),
    unnamedFunctionScopeTypes: new Set(["init_declaration", "subscript_declaration"]),
    variableDeclarationTypes: new Set(["assignment"]),
    assignmentDeclarationTypes: new Set(["assignment"]),
    assignmentIdentifierTypes: new Set(["identifier"]),
    memberContainerTypes: new Set(["class_body", "class_declaration"]),
    childSkipNameTypes: new Set(["identifier", "type_identifier"]),
  },
  ruby: {
    parameterParents: new Set(["lambda_parameters"]),
    functionNameTypes: new Set(["method", "singleton_method"]),
    classNameTypes: new Set(["class", "module"]),
    variableDeclarationTypes: new Set(["assignment"]),
    assignmentDeclarationTypes: new Set(["assignment"]),
    assignmentIdentifierTypes: new Set(["identifier"]),
    memberFunctionTypes: new Set(["method", "singleton_method"]),
    memberContainerTypes: new Set(["class"]),
    childSkipNameTypes: new Set(["identifier"]),
    moduleRootTypes: new Set(["program", "module"]),
  },
  zig: {
    parameterParents: new Set(["parameter"]),
    functionNameTypes: new Set(["function_declaration"]),
    typeNameTypes: new Set(["enum_declaration"]),
    variableDeclarationTypes: new Set(["variable_declaration"]),
    namelessVariableDeclaration: {
      declarationTypes: new Set(["variable_declaration"]),
      importCallPattern: /@(?:import|cImport)\s*\(/,
    },
    // Zig has no implicit member scope: inside a container, a sibling member is reachable only
    // through `Self.`, `@This()`, or an instance, so a member function's name must not land in the
    // file scope.
    memberContainerTypes: new Set(["struct_declaration", "enum_declaration", "union_declaration"]),

    childSkipNameTypes: new Set(["identifier", "parameters"]),
  },
  sql: {
    parameterParents: new Set(["parameter"]),
    functionNameTypes: new Set(["function_declaration"]),
    variableDeclarationTypes: new Set(["assignment"]),
    assignmentDeclarationTypes: new Set(["assignment"]),
    assignmentIdentifierTypes: new Set(["identifier"]),
    childSkipNameTypes: new Set(["identifier"]),
    moduleRootTypes: new Set(["program"]),
  },
  scss: {
    parameterParents: new Set(["parameter"]),
    childSkipNameTypes: new Set(["identifier", "parameters"]),
  },
  css: STYLE_SCOPE_NODES,
  less: STYLE_SCOPE_NODES,
  html: DOCUMENT_SCOPE_NODES,
  vue: DOCUMENT_SCOPE_NODES,
  svelte: DOCUMENT_SCOPE_NODES,
  astro: DOCUMENT_SCOPE_NODES,
  hbs: DOCUMENT_SCOPE_NODES,
  markdown: DOCUMENT_SCOPE_NODES,
  mdx: DOCUMENT_SCOPE_NODES,
  rst: DOCUMENT_SCOPE_NODES,
  adoc: DOCUMENT_SCOPE_NODES,
};

/** Languages outside the registry have no scope node table; the structural lists are empty and
 * only the `createsFunctionScope` / `createsBlockScope` / `scopeDeclarationNames` hooks apply. */
const EMPTY_SCOPE_NODES: ScopeNodeRow = {};

export function scopeNodesFor(languageId: string): ScopeNodeRow {
  return SCOPE_NODE_ROWS[languageId] ?? EMPTY_SCOPE_NODES;
}
