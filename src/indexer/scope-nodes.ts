/**
 * Per-language node-name tables for scope construction in `./scope.js`.
 *
 * Rows are keyed by language id, following the trivia-table precedent in `../util/trivia-tables.js`:
 * the walker keeps the algorithm, and the table keeps the pinned grammar's node names and
 * language-specific visibility rules. `tests/scope-node-tables.test.ts` checks listed node types
 * against the grammar and verifies that name-bearing function scopes register their names.
 * Fields are optional: an absent field means the language has no node of that shape.
 * Zig's `memberContainerTypes` keeps container functions out of the file scope because Zig has
 * no implicit member scope.
 *
 * `wholeScopeKinds` and `wholeScopeDeclarationTypes` say when a binding covers uses that
 * appear before it. The walker resolves occurrences once the enclosing scope is complete; the
 * row decides whether a later declaration in that scope names those earlier uses.
 */

import type { SyntaxNodeLike } from "../languages/types.js";

import type { Range } from "../types.js";
import { SymbolKind } from "./types.js";
import type { Scope } from "./scope-types.js";

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
  /** Explicit unqualified calls use the method namespace, not same-named local variables. */
  explicitMethodCallTypes?: ReadonlySet<string>;
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
  /** Node types whose body is a member scope rather than an ordinary block (C++ classes). */
  memberScopeTypes?: ReadonlySet<string>;
  /** Child node types skipped when they hold the name or parameters of a name-registering node,
   * or repeat a parent identifier's spelling (PHP `variable_name > name`). */
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
  /**
   * Scope kinds whose bindings cover the whole scope, including uses that textually precede
   * the declaration. JS `let`/`const` still name the inner binding from the start of the block
   * (temporal dead zone). Absent kinds expose a binding only at and after its declaration, so a
   * later declaration does not capture an earlier use in that scope (C and C++ files and
   * blocks, Rust `let`, Go locals). Only C++ class member scopes cover earlier uses.
   */
  wholeScopeKinds?: ReadonlySet<Scope["kind"]>;
  /** A later point-declared local shadows an outer name even for an invalid earlier read (C#). */
  laterLocalBlocksOuterKinds?: ReadonlySet<Scope["kind"]>;
  /**
   * Declaration node types that cover their whole scope even when the scope kind is absent from
   * `wholeScopeKinds`. Matched against the name's parent, or that parent's parent when the name
   * sits under a `variable_declarator`. Rust items inside a function are visible before their
   * text; a `let` in the same block is not.
   */
  wholeScopeDeclarationTypes?: ReadonlySet<string>;
  /** Declaration forms visible before their text only when directly inside a member container. */
  wholeScopeMemberDeclarationTypes?: ReadonlySet<string>;
  /** Module names used inside function bodies resolve after module initialization (Python). */
  moduleBindingsAtFunctionRuntime?: boolean;
  /**
   * Put a variable declaration in the nearest scope of one of these kinds. Python: an assignment
   * anywhere in a function makes that name local to the whole function, not to the block that
   * holds the statement.
   */
  variableTargetScopeKinds?: ReadonlySet<Scope["kind"]>;
  /**
   * A scope whose node or parent has one of these types stops `variableTargetScopeKinds` from
   * lifting past it. Python class bodies are `block` nodes, but an assignment there is a class
   * attribute, not a function local.
   */
  variableScopeBoundaryTypes?: ReadonlySet<string>;
  /** Class-body scopes crossed by nested definitions are not captured by those definitions. */
  classScopeBoundaryTypes?: ReadonlySet<string>;
  /** A comprehension runs outside its class, except for its first iterable expression. */
  classScopeComprehension?: {
    types: ReadonlySet<string>;
    firstClauseType: string;
    iterableField: string;
  };
  /**
   * Member-access node types whose property name is not a lexical use.
   * Python `self.run` must not attach to a same-named function; the property is a member.
   */
  nonLexicalMemberPropertyTypes?: ReadonlySet<string>;
};

const WHOLE_FILE_SCOPE: ReadonlySet<Scope["kind"]> = new Set(["module"]);
const CPP_MEMBER_SCOPE: ReadonlySet<Scope["kind"]> = new Set(["member"]);
const WHOLE_LEXICAL_SCOPE: ReadonlySet<Scope["kind"]> = new Set(["module", "function", "block", "type"]);

/**
 * Whether `binding` in a scope of `scopeKind` names a use at `useStartIndex`.
 * Whole-scope bindings name every use in the scope. Every other binding names only uses at
 * or after its declaration. Declaration-type coverage is recorded on the binding when it is
 * registered, so this compares indexes instead of walking the declaration's ancestors.
 */
export function bindingCoversUse(
  row: ScopeNodeRow,
  scopeKind: Scope["kind"],
  binding: { def?: Range; coversEnclosingScope?: boolean },
  useStartIndex: number,
): boolean {
  if (binding.coversEnclosingScope || row.wholeScopeKinds?.has(scopeKind)) return true;
  const defIndex = binding.def?.start.index;
  if (defIndex === undefined) return true;
  return defIndex <= useStartIndex;
}

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
  wholeScopeKinds: WHOLE_LEXICAL_SCOPE,
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
  // `x: T` keeps its type annotation in the `type` field; skip it for bindings (H1).
  destructuringTypeFieldTypes: new Set(["required_parameter", "optional_parameter"]),
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
    wholeScopeKinds: new Set(["function"]),
    moduleBindingsAtFunctionRuntime: true,
    variableTargetScopeKinds: new Set(["function"]),
    variableScopeBoundaryTypes: new Set(["class_definition"]),
    classScopeBoundaryTypes: new Set(["function_definition", "lambda", "class_definition"]),
    classScopeComprehension: {
      types: new Set(["list_comprehension", "set_comprehension", "dictionary_comprehension", "generator_expression"]),
      firstClauseType: "for_in_clause",
      iterableField: "right",
    },
    nonLexicalMemberPropertyTypes: new Set(["attribute"]),
  },
  php: {
    functionNameTypes: new Set(["function_definition", "method_declaration"]),
    classNameTypes: new Set(["class_declaration", "trait_declaration"]),
    typeNameTypes: new Set(["interface_declaration", "enum_declaration"]),
    enumMemberTypes: new Set(["enum_case"]),
    variableDeclarationTypes: new Set(["assignment_expression", "const_declaration"]),
    assignmentDeclarationTypes: new Set(["assignment_expression"]),
    assignmentIdentifierTypes: new Set(["variable_name"]),
    memberFunctionTypes: new Set(["method_declaration"]),
    memberContainerTypes: new Set([
      "class_declaration",
      "interface_declaration",
      "trait_declaration",
      "enum_declaration",
    ]),
    childSkipNameTypes: new Set(["name"]),
    moduleRootTypes: new Set(["program"]),
    wholeScopeDeclarationTypes: new Set([
      "function_definition",
      "class_declaration",
      "interface_declaration",
      "trait_declaration",
      "enum_declaration",
    ]),
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
    wholeScopeKinds: WHOLE_FILE_SCOPE,
  },
  java: {
    functionNameTypes: new Set(["method_declaration"]),
    unnamedFunctionScopeTypes: new Set(["constructor_declaration"]),
    classNameTypes: new Set(["class_declaration"]),
    typeNameTypes: new Set(["interface_declaration", "enum_declaration"]),
    enumMemberTypes: new Set(["enum_constant"]),
    enumBodyParentTypes: new Set(["enum_body"]),
    variableDeclarationTypes: new Set(["field_declaration", "local_variable_declaration"]),
    destructuringTypeFieldTypes: new Set(["formal_parameter"]),
    variableDeclaratorTypes: new Set(["variable_declarator"]),
    memberFunctionTypes: new Set(["method_declaration"]),
    memberContainerTypes: new Set(["class_body", "class_declaration"]),
    childSkipNameTypes: new Set(["identifier", "type_identifier"]),
    moduleRootTypes: new Set(["program"]),
    wholeScopeKinds: WHOLE_FILE_SCOPE,
    wholeScopeDeclarationTypes: new Set([
      "method_declaration",
      "constructor_declaration",
      "class_declaration",
      "field_declaration",
    ]),
  },
  csharp: {
    parameterParents: new Set(["parameter"]),
    functionNameTypes: new Set(["method_declaration", "local_function_statement"]),
    unnamedFunctionScopeTypes: new Set(["constructor_declaration", "destructor_declaration"]),
    classNameTypes: new Set(["class_declaration", "struct_declaration", "record_declaration"]),
    typeNameTypes: new Set(["interface_declaration", "enum_declaration", "delegate_declaration"]),
    enumMemberTypes: new Set(["enum_member_declaration"]),
    declarationPatternTypes: new Set(["declaration_pattern"]),
    variableDeclarationTypes: new Set(["variable_declaration", "field_declaration"]),
    destructuringTypeFieldTypes: new Set(["parameter"]),
    variableDeclaratorTypes: new Set(["variable_declarator"]),
    memberFunctionTypes: new Set(["method_declaration"]),
    memberContainerTypes: new Set(["class_declaration"]),
    childSkipNameTypes: new Set(["identifier"]),
    wholeScopeDeclarationTypes: new Set([
      "method_declaration",
      "local_function_statement",
      "constructor_declaration",
      "class_declaration",
      "struct_declaration",
      "record_declaration",
      "interface_declaration",
      "enum_declaration",
      "delegate_declaration",
      "field_declaration",
      "property_declaration",
    ]),
    laterLocalBlocksOuterKinds: new Set(["function", "block"]),
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
    // A parameter's `type` field is a sibling of its `pattern`, not a nested pattern: without
    // this, the generic recursive walk in `addPatternDecls` (scope.js) descends into the type
    // position and registers the referenced type name (bare or `super::`/`crate::`-qualified)
    // as a same-scope "param" binding at the reference site itself, which then shadows the
    // real declaration and makes goto/references resolve the use to itself.
    destructuringTypeFieldTypes: new Set(["parameter"]),
    childSkipNameTypes: new Set(["identifier", "type_identifier", "parameters"]),
    wholeScopeKinds: WHOLE_FILE_SCOPE,
    wholeScopeDeclarationTypes: new Set([
      "function_item",
      "struct_item",
      "enum_item",
      "trait_item",
      "const_item",
      "static_item",
      "mod_item",
      "union_item",
      "type_item",
      "macro_definition",
    ]),
  },
  c: C_SCOPE_NODES,
  cpp: {
    ...C_SCOPE_NODES,
    memberScopeTypes: new Set(["field_declaration_list"]),
    wholeScopeKinds: CPP_MEMBER_SCOPE,
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
    variableDeclarationTypes: new Set(["variable_declaration"]),
    memberContainerTypes: new Set(["class_body", "class_declaration"]),
    childSkipNameTypes: new Set(["identifier"]),
    wholeScopeKinds: WHOLE_FILE_SCOPE,
    wholeScopeDeclarationTypes: new Set(["function_declaration", "class_declaration"]),
    wholeScopeMemberDeclarationTypes: new Set(["property_declaration"]),
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
    wholeScopeKinds: WHOLE_FILE_SCOPE,
    wholeScopeDeclarationTypes: new Set(["function_declaration", "class_declaration"]),
  },
  ruby: {
    parameterParents: new Set(["lambda_parameters"]),
    functionNameTypes: new Set(["method", "singleton_method"]),
    classNameTypes: new Set(["class", "module"]),
    variableDeclarationTypes: new Set(["assignment"]),
    assignmentDeclarationTypes: new Set(["assignment"]),
    assignmentIdentifierTypes: new Set(["identifier"]),
    explicitMethodCallTypes: new Set(["call"]),
    memberFunctionTypes: new Set(["method", "singleton_method"]),
    memberContainerTypes: new Set(["class"]),
    childSkipNameTypes: new Set(["identifier"]),
    moduleRootTypes: new Set(["program", "module"]),
    wholeScopeDeclarationTypes: new Set(["class", "module", "method", "singleton_method"]),
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
    wholeScopeKinds: WHOLE_FILE_SCOPE,
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

/** Preserve sigils on variable nodes so they cannot collide with import, type, or function names. */
export function scopeIdentifierKey(
  row: ScopeNodeRow,
  name: string,
  node: SyntaxNodeLike,
  normalizeIdentifier: (value: string) => string,
): string {
  let variable: SyntaxNodeLike | null = null;
  if (row.assignmentIdentifierTypes?.has(node.type)) variable = node;
  else if (node.parent && row.assignmentIdentifierTypes?.has(node.parent.type)) variable = node.parent;
  if (variable?.text.startsWith("$")) return variable.text;
  return normalizeIdentifier(name);
}

/** A call with a method name but no receiver does not name a local variable (Ruby). */
export function isExplicitMethodCall(row: ScopeNodeRow, node: SyntaxNodeLike): boolean {
  const call = node.parent;
  if (!call || !row.explicitMethodCallTypes?.has(call.type) || call.childForFieldName("receiver")) return false;
  const method = call.childForFieldName("method");
  return !!method && node.startIndex >= method.startIndex && node.endIndex <= method.endIndex;
}

/** Class bodies are not closures for nested runtime scopes (Python). */
export function scopeAllowsUse(row: ScopeNodeRow, scope: Scope, use: SyntaxNodeLike): boolean {
  const boundaries = row.classScopeBoundaryTypes;
  if (!boundaries || !scope.node.parent || !row.variableScopeBoundaryTypes?.has(scope.node.parent.type)) return true;
  const comprehension = row.classScopeComprehension;
  for (let current = use.parent; current; current = current.parent) {
    if (current.startIndex === scope.node.startIndex && current.endIndex === scope.node.endIndex) break;
    if (comprehension?.types.has(current.type)) {
      const firstClause = current.namedChildren.find((child) => child.type === comprehension.firstClauseType);
      const iterable = firstClause?.childForFieldName(comprehension.iterableField);
      if (!iterable || use.startIndex < iterable.startIndex || use.endIndex > iterable.endIndex) return false;
    }
    if (boundaries.has(current.type)) {
      const body = current.childForFieldName("body");
      if (body && use.startIndex >= body.startIndex && use.endIndex <= body.endIndex) return false;
    }
  }
  return true;
}

/** A later local in this lexical scope makes an earlier outer-name read invalid. */
export function laterLocalBlocksOuterUse(
  row: ScopeNodeRow,
  scope: Scope,
  canonicalName: string,
  useStartIndex: number,
): boolean {
  if (!row.laterLocalBlocksOuterKinds?.has(scope.kind)) return false;
  for (let binding = scope.map.get(canonicalName); binding; binding = binding.earlierSameScope) {
    const declarationIndex = binding.def?.start.index;
    if (
      binding.kind === "local" &&
      !binding.coversEnclosingScope &&
      declarationIndex !== undefined &&
      declarationIndex > useStartIndex
    )
      return true;
  }
  return false;
}

/** Check a same-file definition found outside lexical lookup against file-scope declaration order. */
export function fileScopeDefinitionCoversUse(
  languageId: string,
  def: Range,
  useStartIndex: number,
  kind?: SymbolKind,
  fromFunctionAtRuntime = false,
): boolean {
  if (def.start.index === undefined) return false;
  const row = scopeNodesFor(languageId);
  if (row.wholeScopeKinds?.has("module")) return true;
  if (fromFunctionAtRuntime && row.moduleBindingsAtFunctionRuntime) return true;
  const covering = row.wholeScopeDeclarationTypes;
  let declarationTypes: ReadonlySet<string> | undefined;
  if (kind === SymbolKind.Function) declarationTypes = row.functionNameTypes;
  else if (kind === SymbolKind.Class) declarationTypes = row.classNameTypes;
  else if (kind === SymbolKind.Interface || kind === SymbolKind.TypeAlias) declarationTypes = row.typeNameTypes;
  if (covering && declarationTypes) {
    for (const declarationType of declarationTypes) {
      if (covering.has(declarationType)) return true;
    }
  }
  return def.start.index <= useStartIndex;
}
