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
import { isSwiftExtensionTypeName, isSwiftPatternLabel } from "../util/swift-tree.js";
import { isCsharpMemberDesignator } from "../util/csharp-designators.js";
import { isJavaAnnotationElementName, isJavaSwitchLabelName } from "../util/java-designators.js";
import { rubyLambdaParameterShadows, rubyNamesLocalVariable } from "../util/ruby-tree.js";
import {
  csharpBindingVisibleAt,
  csharpDeclarationOutsideQuery,
  isCsharpPointerExpression,
} from "../util/csharp-bindings.js";
import { javaPatternBindingVisibleAt, javaPatternVariableName } from "../util/java-patterns.js";
import { csharpAttributeParameterCoversUse } from "./name-lookup-policies/csharp-attribute-parameters.js";
import { blocksCsharpJavaSelectorBinding } from "./name-lookup-policies/csharp-java-selectors.js";
import { SymbolKind } from "./types.js";
import type { Binding, Scope, ScopeIndex } from "./scope-types.js";
import { isRecoveredTypeParameterName } from "./type-parameters.js";

export type ScopeNodeRow = {
  /** Ancestor node types that mark an identifier as a parameter rather than a declaration. */
  parameterParents?: ReadonlySet<string>;
  /** Reject a native local capture when the language grammar parsed an expression as a declaration. */
  acceptLocalCapture?: (name: SyntaxNodeLike) => boolean;
  /** A declaration in this scope's outer-evaluated expression belongs in the enclosing scope instead. */
  declarationOutsideScope?: (name: SyntaxNodeLike, scope: SyntaxNodeLike) => boolean;
  /** A declaration that covers a specific earlier use without covering the whole scope. */
  bindingCoversBeforeDeclaration?: (
    binding: { kind?: Binding["kind"]; node?: SyntaxNodeLike },
    use: SyntaxNodeLike,
  ) => boolean;
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
  /**
   * Type declarations whose header parameter list binds names in the declaration's own scope, so the header and the body
   * see them: a C# record's positional parameters, a C# class's or struct's primary-constructor parameters, and a Java
   * record's components. `listTypes` names the parameter-list node, so a delegate's or method's list is not read as one.
   * Each declaration type must also be a `typeScopeTypes` entry.
   */
  headerParameters?: {
    declarationTypes: ReadonlySet<string>;
    listTypes: ReadonlySet<string>;
    /** Header parameters whose generated properties are also receiver-reference candidates. */
    propertyDeclarationTypes?: Readonly<Record<string, true>>;
    /**
     * A parameter named like its own type (C# `Widget Widget`, Color Color; Java `Money Money`) stays unbound: a receiver
     * spelled that way may name the type for its static and nested members, which only the type lookup answers, and a
     * type position never names a parameter.
     */
    leavesTypeNamedUnbound?: true;
  };
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
  /** Pattern names without a `name` field, their scope boundaries, and flow-sensitive visibility. */
  declarationPatternName?: (node: SyntaxNodeLike) => SyntaxNodeLike | null;
  declarationPatternScopeTypes?: ReadonlySet<string>;
  patternBindingVisibleAt?: (declaration: SyntaxNodeLike, use: SyntaxNodeLike) => boolean;
  /** Exhaustive declaration parents that the visibility hook can hide; absent means every binding needs it. */
  conditionalBindingParents?: ReadonlySet<string>;
  /** Node types that introduce type parameters (including defaulted and variadic forms). */
  typeParameterTypes?: ReadonlySet<string>;
  /**
   * The field of a declaration that holds its type-parameter list. Scope construction declares those parameters when the
   * declaration's scope opens, because parameter types, constraints, and defaults are read before the list is walked
   * (TypeScript).
   */
  typeParameterListField?: string;
  /** Declaration types whose generic type parameters can shadow a bare function return type. */
  returnTypeParameterOwnerTypes?: ReadonlySet<string>;
  /**
   * Use-node types that occur only in type syntax (TypeScript `type_identifier`). Such a use skips value bindings, and
   * any other use skips type-parameter bindings, so a value `R` still reaches `import * as R` beside a generic `<R>`.
   */
  typeOnlyUseTypes?: ReadonlySet<string>;
  /**
   * Pattern node types mapped to the field that holds a default-value expression. The default is a read of an
   * enclosing name, never a name the pattern binds (ECMAScript `a = K` in a parameter or destructuring pattern).
   */
  patternDefaultValueFields?: Readonly<Record<string, string>>;
  /** Non-type parameter declarations in a C++ template list (not function parameters). */
  templateValueParameterTypes?: ReadonlySet<string>;
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
  /** Pattern nodes whose type field, and parameter default-value field, contain reads rather than names. */
  destructuringTypeFieldTypes?: ReadonlySet<string>;
  /** Type-field node type that retains its existing pattern binding instead of becoming a read. */
  destructuringTypeFieldBindingTypes?: Readonly<Record<string, string>>;
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
   * Node types that start a scope the local variables of the enclosing scopes do not reach into (Ruby `def`, `class`,
   * `module`, `class << self`). A block is not one: it closes over the locals around it.
   */
  localScopeGateTypes?: ReadonlySet<string>;
  /**
   * Gate node types whose body is a scope for the body's own local variables alone. Every other declaration made in
   * the body (a method, a class, a constant) binds outside it, as in the file scope, so a name keeps its reach.
   */
  localOnlyScopeTypes?: ReadonlySet<string>;
  /** Name node types of local variables, which a gate hides, unlike constants and methods. */
  localVariableNameTypes?: ReadonlySet<string>;
  /**
   * Fields that a function scope's node evaluates outside its own scope: the receiver of a Ruby `def object.name` is
   * read where the `def` stands, so the locals around the `def` are still the receiver's.
   */
  outerEvaluatedFields?: Readonly<Record<string, string>>;
  /**
   * Member-access node types whose property name is not a lexical use.
   * Python `self.run` must not attach to a same-named function; the property is a member.
   */
  nonLexicalMemberPropertyTypes?: ReadonlySet<string>;
  /**
   * Node types whose identifier children are selector positions: Swift member suffixes and argument labels, or
   * Rust path segments. The binding policy below distinguishes lexical variables from items and namespaces.
   */
  memberSelectorParentTypes?: ReadonlySet<string>;
  /**
   * Member-access parent types mapped to their selector field. Other children, including the receiver, remain lexical
   * reads. An explicit method call without a receiver still reads its method binding.
   */
  memberSelectorFields?: Readonly<Record<string, string>>;
  /** Labels that the grammar leaves unfielded or mixes with expression children (Swift patterns). */
  memberSelectorAt?: (node: SyntaxNodeLike) => boolean;
  /** Receiver fields distinguish receiverless calls and type/namespace segments of a qualified value path. */
  memberSelectorReceiverFields?: Readonly<Record<string, string>>;
  /** Whether a selector rejects this lexical binding; member declarations can share a binding kind with locals. */
  memberSelectorRejectsBinding?: (binding: Pick<Binding, "kind" | "node">) => boolean;
  /**
   * Skip this same-scope binding because the use reads another namespace. Lookup then continues to
   * the earlier binding of that name, and a use seen before the matching declaration stays queued.
   */
  namespaceHidesBinding?: (
    row: ScopeNodeRow,
    binding: Pick<Binding, "kind" | "node" | "earlierSameScope">,
    use: SyntaxNodeLike,
    normalizeIdentifier: (name: string) => string,
  ) => boolean;
  /** A syntactic member or argument designator cannot be an occurrence of a lexical binding. */
  nonLexicalUse?: (node: SyntaxNodeLike) => boolean;
  /** Occurrences whose target needs the shared name resolver rather than lexical scope alone. */
  referenceNeedsVerification?: (node: SyntaxNodeLike) => boolean;
};

const C_MEMBER_BINDING_NAME_TYPES: Readonly<Record<string, true>> = { field_identifier: true };
const RUST_ITEM_DECLARATION_TYPES: ReadonlySet<string> = new Set([
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
]);
const RUST_TYPE_NAMESPACE_DECLARATIONS: ReadonlySet<string> = new Set(["mod_item", "enum_item", "trait_item"]);

/** These identifier parents do not denote bare value uses. */
const RUST_NON_VALUE_IDENTIFIER_PARENTS: ReadonlySet<string> = new Set([
  "scoped_identifier",
  "scoped_type_identifier",
  "scoped_use_list",
  "use_declaration",
  "use_as_clause",
  "use_list",
  "use_wildcard",
  "visibility_modifier",
  "macro_invocation",
  "token_tree",
  "token_repetition",
  "token_tree_pattern",
  "token_repetition_pattern",
]);

/** Paths under imports and macro token trees are not value uses. */
const RUST_NON_VALUE_PATH_ANCESTORS: ReadonlySet<string> = new Set([
  "use_declaration",
  "visibility_modifier",
  "scoped_type_identifier",
  "macro_invocation",
  "token_tree",
  "token_repetition",
  "token_tree_pattern",
  "token_repetition_pattern",
]);

const RUST_VALUE_ROOTS: ReadonlySet<string> = new Set(["crate", "self", "super"]);

function rustScopedValueName(use: SyntaxNodeLike): boolean {
  const parent = use.parent;
  if (!parent || parent.type !== "scoped_identifier") return false;
  const qualifier = parent.childForFieldName("path");
  if (!qualifier || !RUST_VALUE_ROOTS.has(qualifier.type)) return false;
  const name = parent.childForFieldName("name");
  if (!name || name.startIndex !== use.startIndex || name.endIndex !== use.endIndex) return false;
  for (let current = parent.parent; current; current = current.parent) {
    if (RUST_NON_VALUE_PATH_ANCESTORS.has(current.type)) return false;
  }
  return true;
}

/** A bare Rust return type can name a type parameter of its function or an enclosing generic owner. */
export function rustGenericReturnTypeParameter(
  row: ScopeNodeRow,
  use: SyntaxNodeLike,
  normalizeIdentifier: (name: string) => string,
): boolean {
  const functionNode = use.parent;
  if (use.type !== "type_identifier" || functionNode?.type !== "function_item") return false;
  if (!fieldIncludesNode(functionNode, "return_type", use)) return false;
  const owners = row.returnTypeParameterOwnerTypes;
  if (!owners) return false;
  let name: string | undefined;
  for (let owner: SyntaxNodeLike | null = functionNode; owner; owner = owner.parent) {
    if (!owners.has(owner.type)) continue;
    const parameters = owner.childForFieldName("type_parameters");
    if (!parameters) continue;
    name ??= normalizeIdentifier(use.text);
    for (const parameter of parameters.namedChildren) {
      if (parameter.type !== "type_parameter") continue;
      const declared = parameter.childForFieldName("name");
      if (declared && normalizeIdentifier(declared.text) === name) return true;
    }
  }
  return false;
}

/** Value names skip declarations that only occupy Rust's type namespace. */
function rustNamespaceHidesBinding(
  row: ScopeNodeRow,
  binding: Pick<Binding, "kind" | "node" | "earlierSameScope">,
  use: SyntaxNodeLike,
  normalizeIdentifier: (name: string) => string,
): boolean {
  if (!use.parent) return false;
  if (use.type === "type_identifier") {
    const parent = use.parent;
    const recordName = parent.type === "struct_expression" && fieldIncludesNode(parent, "name", use);
    const bareReturn = parent.type === "function_item" && fieldIncludesNode(parent, "return_type", use);
    if (bareReturn && rustGenericReturnTypeParameter(row, use, normalizeIdentifier)) return true;
    if (recordName || bareReturn) return isValueNamespaceBinding(binding);
    return false;
  }
  if (use.type !== "identifier") return false;
  const ownDeclaration = binding.node?.startIndex === use.startIndex && binding.node.endIndex === use.endIndex;
  if (ownDeclaration) return false;
  if (RUST_ITEM_DECLARATION_TYPES.has(use.parent.type)) {
    const name = use.parent.childForFieldName("name");
    if (name && name.startIndex === use.startIndex && name.endIndex === use.endIndex) return true;
  }
  // A qualifier may skip a value item only when an earlier type or namespace is present. If
  // none is known, retaining the value blocks fallback to an unrelated same-named function.
  if (isValuePathQualifier(row, use)) {
    if (!isValueNamespaceBinding(binding)) return false;
    const declaration = binding.node?.parent;
    const localValue = !declaration || !RUST_ITEM_DECLARATION_TYPES.has(declaration.type);
    if (localValue && rustScopedValueName(use)) return true;
    const earlier = binding.earlierSameScope;
    return earlier?.kind === "class" || earlier?.kind === "type" || earlier?.kind === "namespace";
  }
  const parent = use.parent;
  const qualifiedTuplePattern =
    parent.type === "scoped_identifier" &&
    parent.parent?.type === "tuple_struct_pattern" &&
    parent.parent.childForFieldName("type")?.id === parent.id;
  if (RUST_NON_VALUE_IDENTIFIER_PARENTS.has(parent.type) && !rustScopedValueName(use) && !qualifiedTuplePattern)
    return false;
  if (binding.kind === "namespace") return true;
  const declaration = binding.node?.parent;
  if (!declaration) return false;
  if (RUST_TYPE_NAMESPACE_DECLARATIONS.has(declaration.type)) return true;
  return declaration.type === "struct_item" && declaration.childForFieldName("body")?.type === "field_declaration_list";
}

const WHOLE_FILE_SCOPE: ReadonlySet<Scope["kind"]> = new Set(["module"]);
const CPP_MEMBER_SCOPE: ReadonlySet<Scope["kind"]> = new Set(["member"]);
const WHOLE_LEXICAL_SCOPE: ReadonlySet<Scope["kind"]> = new Set(["module", "function", "block", "type"]);

/** A Python function's own default runs before that function replaces its previous binding. */
export function pythonFunctionPendingInDefault(defStart: number | undefined, use: SyntaxNodeLike): boolean {
  if (defStart === undefined) return false;
  let inDefaultValue = false;
  for (let current = use.parent; current; current = current.parent) {
    if (current.type === "default_parameter" || current.type === "typed_default_parameter") {
      const value = current.childForFieldName("value");
      if (value && use.startIndex >= value.startIndex && use.endIndex <= value.endIndex) inDefaultValue = true;
    }
    if (current.type !== "function_definition" && current.type !== "lambda") continue;
    const body = current.childForFieldName("body");
    if (body && use.startIndex >= body.startIndex && use.endIndex <= body.endIndex) return false;
    if (inDefaultValue && current.childForFieldName("name")?.startIndex === defStart) return true;
  }
  return false;
}

/**
 * C# type syntax does not bind a same-named value. The grammar parses a bare `is A` operand as a constant pattern;
 * alias lookup can prove that spelling is a type, while ordinary constant patterns must remain value reads.
 */
export function csharpTypeOnlyName(node: SyntaxNodeLike, typeAliasPattern = false): boolean {
  for (let current = node, parent = node.parent; parent; current = parent, parent = current.parent) {
    const parentType = parent.type;
    if (parentType === "pointer_type" && isCsharpPointerExpression(parent.parent ?? parent)) return false;
    if (parent.childForFieldName("type")?.id === current.id) return true;
    if (parent.childForFieldName("returns")?.id === current.id) return true;
    const typeOperand = parentType === "as_expression" || parentType === "is_expression";
    if (typeOperand && parent.childForFieldName("right")?.id === current.id) return true;
    if (typeAliasPattern && parentType === "constant_pattern") {
      return parent.parent?.type === "is_pattern_expression";
    }
    if (parentType === "type_argument_list" || parentType === "attribute") return true;
    const nameWrapper =
      parentType === "qualified_name" ||
      parentType === "alias_qualified_name" ||
      parentType === "generic_name" ||
      parentType === "nullable_type" ||
      parentType === "array_type";
    if (!nameWrapper) return false;
  }
  return false;
}

/**
 * Kotlin user_type names occupy the type namespace, including qualified and nested type arguments. A Swift
 * extension header names the type it extends, so a same-named function or variable cannot bind it. A row's
 * `typeOnlyUseTypes` lists the node types that appear only in type syntax.
 */
export function typeOnlyName(languageId: string, node: SyntaxNodeLike): boolean {
  if (languageId === "csharp") return csharpTypeOnlyName(node);
  if (languageId === "swift") return isSwiftExtensionTypeName(node);
  if (languageId === "kotlin") return node.parent?.type === "user_type";
  return !!scopeNodesFor(languageId).typeOnlyUseTypes?.has(node.type);
}

/** A type-position name never binds a variable, parameter, or function of the same spelling. */
export function isValueNamespaceBinding(binding: { kind: Binding["kind"] }): boolean {
  return binding.kind === "local" || binding.kind === "param" || binding.kind === "function";
}

/**
 * Whether a gate between a use and `binding` hides it: a local variable bound outside a Ruby `def`, `class`, or
 * `module` is not that local inside it, while a method, a class, and a constant keep their reach.
 */
export function localHiddenByGate(
  row: ScopeNodeRow,
  binding: { kind?: Binding["kind"]; node?: SyntaxNodeLike },
): boolean {
  const isLocal = binding.kind === "local" || binding.kind === "param";
  return isLocal && !!binding.node && !!row.localVariableNameTypes?.has(binding.node.type);
}

/** Whether leaving `scope` for its parent crosses a gate the locals of the outer scopes do not reach through. */
export function scopeIsLocalGate(scope: Scope): boolean {
  return !!scope.gate;
}

/**
 * A class or module body that declared no local: nothing in it can name a use, and climbing out of it only crosses its
 * gate. No use is ever barred from such a body, so a lookup skips it without the checks a scope with bindings needs.
 */
export function scopeIsEmptyBody(scope: Scope): boolean {
  return scope.gate === "body" && !scope.map.size;
}

/** Whether the language hides a method declared at `binding.node` from a bare name at `useNode`. */
function methodHiddenFrom(
  binding: { kind?: Binding["kind"]; node?: SyntaxNodeLike; generatedOwner?: SyntaxNodeLike },
  useNode: SyntaxNodeLike | undefined,
  support: { methodVisibleAt?: (declaration: SyntaxNodeLike, use: SyntaxNodeLike) => boolean },
): boolean {
  const declaration = binding.node;
  if (binding.generatedOwner || binding.kind !== "function" || !declaration || !useNode) return false;
  return !!support.methodVisibleAt && !support.methodVisibleAt(declaration, useNode);
}

/**
 * Whether the closest binding lies in another namespace than the use, or behind a gate: a method call never reads a
 * local variable, a type-position name never reads a value, a gate crossed on the way to the binding hides its local
 * variables, and in a language that keeps types and values apart (`typeOnlyUseTypes`) a type parameter exists only in
 * type syntax, so any other use passes it by and reaches the outer value of that spelling.
 */
export function bindingHiddenFromUse(
  row: ScopeNodeRow,
  binding: Pick<Binding, "kind" | "node" | "earlierSameScope" | "conditionalVisibility">,
  use: SyntaxNodeLike | undefined,
  methodCall: boolean,
  typeOnly: boolean,
  crossedGate: boolean,
  normalizeIdentifier: (name: string) => string,
): boolean {
  if (methodCall && binding.kind === "local") return true;
  if (typeOnly && isValueNamespaceBinding(binding)) return true;
  if (crossedGate && localHiddenByGate(row, binding)) return true;
  if (use && binding.node && row.patternBindingVisibleAt) {
    const needsCheck = !row.conditionalBindingParents || binding.conditionalVisibility;
    if (needsCheck && !row.patternBindingVisibleAt(binding.node, use)) return true;
  }
  if (use && row.namespaceHidesBinding?.(row, binding, use, normalizeIdentifier)) return true;
  if (binding.kind !== "type" || !use || !row.typeOnlyUseTypes) return false;
  // Type syntax reads a type parameter; every other use passes it by.
  if (row.typeOnlyUseTypes.has(use.type)) return false;
  if (!isTypeParameterBinding(row, binding)) return false;
  // A binding's own name token names it, whichever node type the grammar gives that token.
  return use.startIndex !== binding.node?.startIndex || use.endIndex !== binding.node.endIndex;
}

/**
 * Whether `binding` in a scope of `scopeKind` names a use at `useStartIndex`.
 * Whole-scope bindings name every use in the scope. Every other binding names only uses at
 * or after its declaration. Python also rejects a function's own eager default before its
 * name is bound; other declaration-type coverage is recorded when the binding is registered.
 * A generated member names only the uses its language says its owner reaches, and a method only the uses its
 * language says the type that declares it reaches.
 */
export function bindingCoversUse(
  row: ScopeNodeRow,
  scopeKind: Scope["kind"],
  binding: {
    def?: Range;
    coversEnclosingScope?: boolean;
    kind?: Binding["kind"];
    node?: SyntaxNodeLike;
    generatedOwner?: SyntaxNodeLike;
  },
  useStartIndex: number,
  useNode: SyntaxNodeLike | undefined,
  support: {
    generatedMemberVisibleAt?: (owner: SyntaxNodeLike, use: SyntaxNodeLike) => boolean;
    methodVisibleAt?: (declaration: SyntaxNodeLike, use: SyntaxNodeLike) => boolean;
  },
): boolean {
  const pythonFunction = row.moduleBindingsAtFunctionRuntime && binding.kind === "function";
  if (pythonFunction && useNode && pythonFunctionPendingInDefault(binding.def?.start.index, useNode)) return false;
  const owner = binding.generatedOwner;
  if (owner && !(useNode && support.generatedMemberVisibleAt?.(owner, useNode))) return false;
  if (methodHiddenFrom(binding, useNode, support)) return false;
  if (binding.coversEnclosingScope || row.wholeScopeKinds?.has(scopeKind)) return true;
  const defIndex = binding.def?.start.index;
  if (defIndex === undefined) return true;
  if (defIndex <= useStartIndex) return true;
  return !!useNode && !!row.bindingCoversBeforeDeclaration?.(binding, useNode);
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
  patternDefaultValueFields: { assignment_pattern: "right", object_assignment_pattern: "right" },
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
  patternDefaultValueFields: {
    ...ECMASCRIPT_SCOPE_NODES.patternDefaultValueFields,
    required_parameter: "value",
    optional_parameter: "value",
  },
  // A function, method, or arrow function holds its own type parameters in its function scope. These declarations have
  // no function scope, so each one opens a scope that holds the parameters for its signature, heritage, and body.
  typeScopeTypes: new Set([
    "class_declaration",
    "abstract_class_declaration",
    "class",
    "interface_declaration",
    "type_alias_declaration",
    "function_signature",
    "method_signature",
    "abstract_method_signature",
    "call_signature",
    "construct_signature",
    "function_type",
    "constructor_type",
  ]),
  typeParameterTypes: new Set(["type_parameter"]),
  typeParameterListField: "type_parameters",
  typeOnlyUseTypes: new Set(["type_identifier"]),
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
    destructuringTypeFieldTypes: new Set(["default_parameter", "typed_default_parameter"]),
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
    unnamedFunctionScopeTypes: new Set(["constructor_declaration", "lambda_expression"]),
    classNameTypes: new Set(["class_declaration"]),
    typeNameTypes: new Set(["interface_declaration", "enum_declaration"]),
    // A record's components are bound in the record's own scope, which the header and the body share.
    typeScopeTypes: new Set(["record_declaration"]),
    headerParameters: {
      declarationTypes: new Set(["record_declaration"]),
      listTypes: new Set(["formal_parameters"]),
      leavesTypeNamedUnbound: true,
    },
    enumMemberTypes: new Set(["enum_constant"]),
    enumBodyParentTypes: new Set(["enum_body"]),
    declarationPatternTypes: new Set(["instanceof_expression", "type_pattern", "record_pattern_component"]),
    declarationPatternName: javaPatternVariableName,
    declarationPatternScopeTypes: new Set(["if_statement", "switch_rule"]),
    patternBindingVisibleAt: javaPatternBindingVisibleAt,
    variableDeclarationTypes: new Set(["field_declaration", "local_variable_declaration"]),
    destructuringTypeFieldTypes: new Set(["formal_parameter"]),
    variableDeclaratorTypes: new Set(["variable_declarator"]),
    memberFunctionTypes: new Set(["method_declaration"]),
    memberContainerTypes: new Set(["class_body", "class_declaration"]),
    childSkipNameTypes: new Set(["identifier", "type_identifier"]),
    moduleRootTypes: new Set(["program"]),
    memberSelectorFields: { field_access: "field", method_invocation: "name" },
    memberSelectorReceiverFields: { method_invocation: "object" },
    memberSelectorRejectsBinding: blocksCsharpJavaSelectorBinding,
    nonLexicalUse: isJavaAnnotationElementName,
    referenceNeedsVerification: isJavaSwitchLabelName,
    wholeScopeKinds: WHOLE_FILE_SCOPE,
    wholeScopeDeclarationTypes: new Set([
      "method_declaration",
      "constructor_declaration",
      "class_declaration",
      "field_declaration",
    ]),
  },
  csharp: {
    acceptLocalCapture: (name) => !isCsharpPointerExpression(name),
    declarationOutsideScope: csharpDeclarationOutsideQuery,
    parameterParents: new Set(["parameter"]),
    bindingCoversBeforeDeclaration: csharpAttributeParameterCoversUse,
    functionNameTypes: new Set(["method_declaration", "local_function_statement"]),
    unnamedFunctionScopeTypes: new Set([
      "constructor_declaration",
      "destructor_declaration",
      "operator_declaration",
      "conversion_operator_declaration",
      "lambda_expression",
    ]),
    classNameTypes: new Set(["class_declaration", "struct_declaration", "record_declaration"]),
    typeNameTypes: new Set(["interface_declaration", "enum_declaration", "delegate_declaration"]),
    typeScopeTypes: new Set([
      "class_declaration",
      "struct_declaration",
      "record_declaration",
      "interface_declaration",
      "delegate_declaration",
    ]),
    // Record positional parameters and C# 12 primary-constructor parameters are bound in the declaration's own scope.
    headerParameters: {
      declarationTypes: new Set(["record_declaration", "class_declaration", "struct_declaration"]),
      listTypes: new Set(["parameter_list"]),
      leavesTypeNamedUnbound: true,
      propertyDeclarationTypes: { record_declaration: true },
    },
    typeParameterTypes: new Set(["type_parameter"]),
    enumMemberTypes: new Set(["enum_member_declaration"]),
    declarationPatternTypes: new Set(["declaration_pattern"]),
    conditionalBindingParents: new Set([
      "declaration_expression",
      "declaration_pattern",
      "foreach_statement",
      "tuple_pattern",
      "from_clause",
      "join_clause",
      "join_into_clause",
      "let_clause",
      "query_expression",
    ]),
    patternBindingVisibleAt: csharpBindingVisibleAt,
    variableDeclarationTypes: new Set(["variable_declaration", "field_declaration"]),
    destructuringTypeFieldTypes: new Set(["parameter"]),
    variableDeclaratorTypes: new Set(["variable_declarator"]),
    memberFunctionTypes: new Set(["method_declaration"]),
    memberContainerTypes: new Set(["class_declaration"]),
    childSkipNameTypes: new Set(["identifier"]),
    memberSelectorParentTypes: new Set(["member_binding_expression"]),
    memberSelectorFields: { member_access_expression: "name" },
    memberSelectorRejectsBinding: blocksCsharpJavaSelectorBinding,
    nonLexicalUse: isCsharpMemberDesignator,
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
    returnTypeParameterOwnerTypes: new Set(["function_item", "impl_item", "trait_item"]),
    enumMemberTypes: new Set(["enum_variant"]),
    variableDeclarationTypes: new Set(["field_declaration", "let_declaration", "const_item", "static_item"]),
    patternBindingTypes: new Set(["let_declaration", "const_item", "static_item"]),
    memberContainerTypes: new Set(["impl_item"]),
    // A parameter's `type` field is a sibling of its `pattern`, not a nested pattern. A tuple or
    // struct pattern's `type` likewise names the matched type (`let Tuple(value) = Tuple(1)`).
    // Without this, the pattern walk registers that type name as a local at the pattern, and the
    // constructor resolves to the pattern instead of the struct.
    destructuringTypeFieldTypes: new Set(["parameter", "tuple_struct_pattern", "struct_pattern"]),
    // Preserve the prior binding for qualified struct patterns until their variant owner is proven.
    destructuringTypeFieldBindingTypes: { struct_pattern: "scoped_type_identifier" },
    childSkipNameTypes: new Set(["identifier", "parameters"]),
    memberSelectorFields: { scoped_identifier: "name" },
    memberSelectorParentTypes: new Set(["scoped_identifier"]),
    memberSelectorReceiverFields: { scoped_identifier: "path" },
    memberSelectorRejectsBinding: (binding) => {
      const declaration = binding.node?.parent;
      return !declaration || !RUST_ITEM_DECLARATION_TYPES.has(declaration.type);
    },
    namespaceHidesBinding: rustNamespaceHidesBinding,
    wholeScopeKinds: WHOLE_FILE_SCOPE,
    wholeScopeDeclarationTypes: RUST_ITEM_DECLARATION_TYPES,
  },
  c: {
    ...C_SCOPE_NODES,
    memberSelectorFields: { field_expression: "field" },
    memberSelectorParentTypes: new Set(["field_designator"]),
    memberSelectorRejectsBinding: (binding) => !binding.node || !C_MEMBER_BINDING_NAME_TYPES[binding.node.type],
  },
  cpp: {
    ...C_SCOPE_NODES,
    memberScopeTypes: new Set(["field_declaration_list"]),
    // The template's own name remains in its enclosing scope; only its parameters stay here.
    typeScopeTypes: new Set(["template_declaration"]),
    wholeScopeKinds: CPP_MEMBER_SCOPE,
    typeParameterTypes: new Set([
      "type_parameter_declaration",
      "optional_type_parameter_declaration",
      "variadic_type_parameter_declaration",
    ]),
    templateValueParameterTypes: new Set([
      "parameter_declaration",
      "optional_parameter_declaration",
      "variadic_parameter_declaration",
    ]),
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
    typeScopeTypes: new Set(["class_declaration", "type_alias"]),
    typeParameterTypes: new Set(["type_parameter"]),
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
    memberSelectorParentTypes: new Set(["navigation_suffix", "value_argument_label"]),
    memberSelectorFields: { tuple_expression: "name", tuple_type_item: "name" },
    memberSelectorAt: isSwiftPatternLabel,
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
    localScopeGateTypes: new Set(["method", "singleton_method", "class", "module", "singleton_class"]),
    localOnlyScopeTypes: new Set(["class", "module", "singleton_class"]),
    localVariableNameTypes: new Set(["identifier"]),
    referenceNeedsVerification: rubyLambdaParameterShadows,
    namespaceHidesBinding: (_row, binding, use) => {
      if (binding.kind !== "function") return false;
      let earlier = binding.earlierSameScope;
      while (earlier && earlier.kind !== "local" && earlier.kind !== "param") earlier = earlier.earlierSameScope;
      return !!earlier && rubyNamesLocalVariable(use);
    },
    outerEvaluatedFields: { singleton_method: "object" },
    memberSelectorFields: { call: "method" },
    memberSelectorReceiverFields: { call: "receiver" },
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
  // Terraform declarations are order-independent across the module; references resolve in
  // src/terraform/, so the scope walker registers no Terraform node shapes.
  terraform: {
    wholeScopeKinds: WHOLE_FILE_SCOPE,
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

/** Whether `node` is the name a generic type-parameter declaration introduces. */
export function isTypeParameterName(languageId: string, node: SyntaxNodeLike): boolean {
  return isTypeParameterNameIn(scopeNodesFor(languageId), node);
}

function isTypeParameterNameIn(row: ScopeNodeRow, node: SyntaxNodeLike): boolean {
  const typeParameterTypes = row.typeParameterTypes;
  const parentType = node.parent?.type;
  if (!parentType || !typeParameterTypes) return false;
  return typeParameterTypes.has(parentType) || isRecoveredTypeParameterName(node, typeParameterTypes);
}

/**
 * Whether `binding` is a generic type parameter of a language whose row names its type-only syntax: such a binding
 * exists only in type syntax, so a use anywhere else passes it by.
 */
export function isTypeParameterBinding(row: ScopeNodeRow, binding: Pick<Binding, "kind" | "node">): boolean {
  if (binding.kind !== "type" || !row.typeOnlyUseTypes || !binding.node) return false;
  return isTypeParameterNameIn(row, binding.node);
}

/**
 * The declaration whose header parameter list declares `name`, a parameter's name node (a record component, or a
 * primary-constructor parameter), per the language's `headerParameters` row. Any other parameter has no such owner.
 */
export function headerParameterOwner(languageId: string, name: SyntaxNodeLike): SyntaxNodeLike | null {
  const header = scopeNodesFor(languageId).headerParameters;
  if (!header) return null;
  // The name sits in a parameter, or in a declarator inside a varargs parameter, below the list.
  let current = name.parent;
  for (let hop = 0; current && hop < 3 && !header.listTypes.has(current.type); hop += 1) current = current.parent;
  const owner = current && header.listTypes.has(current.type) ? current.parent : null;
  return owner && header.declarationTypes.has(owner.type) ? owner : null;
}

/** Whether a header parameter's declared type is spelled like its own name (`Widget Widget`, `Lib.Widget? Widget`). */
export function headerParameterNamedLikeType(
  parameter: SyntaxNodeLike,
  name: SyntaxNodeLike,
  normalizeIdentifier: (value: string) => string,
): boolean {
  const type = parameter.childForFieldName("type");
  if (!type) return false;
  const text = type.text.replace(/\?$/u, "");
  // A generic or array type is not the simple name the parameter spells.
  if (/[<[(]/u.test(text)) return false;
  const simple = text.split(/\.|::/u).at(-1)!.trim();
  return normalizeIdentifier(simple) === normalizeIdentifier(name.text);
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

/** Identify selector positions before applying their binding and namespace policy. */
export function isNonLexicalValueUse(row: ScopeNodeRow, useNode: SyntaxNodeLike): boolean {
  if (row.memberSelectorAt?.(useNode)) return true;
  if (!row.memberSelectorParentTypes && !row.memberSelectorFields) return false;
  const parent = useNode.parent;
  if (!parent) return false;
  if (row.memberSelectorParentTypes?.has(parent.type)) return true;
  const field = row.memberSelectorFields?.[parent.type];
  if (!field) return false;
  const receiverField = row.memberSelectorReceiverFields?.[parent.type];
  if (receiverField && !parent.childForFieldName(receiverField)) return false;
  return fieldIncludesNode(parent, field, useNode);
}

/** True when `node` is any child stored under `field`, including a repeated field name. */
function fieldIncludesNode(parent: SyntaxNodeLike, field: string, node: SyntaxNodeLike): boolean {
  if (parent.childForFieldNameAt) {
    const child = parent.childForFieldNameAt(field, node.startIndex);
    return !!child && child.endIndex === node.endIndex;
  }
  const selector = parent.childForFieldName(field);
  return !!selector && selector.startIndex === node.startIndex && selector.endIndex === node.endIndex;
}

/** Namespace qualifier fields apply to every nonterminal segment of a qualified path. */
function isValuePathQualifier(row: ScopeNodeRow, useNode: SyntaxNodeLike): boolean {
  const qualifierFields = row.memberSelectorReceiverFields;
  if (!qualifierFields) return false;
  let segment = useNode;
  for (let path = segment.parent; path; path = path.parent) {
    if (!row.memberSelectorParentTypes?.has(path.type) || !qualifierFields[path.type]) return false;
    const nameField = row.memberSelectorFields?.[path.type];
    if (nameField && fieldIncludesNode(path, nameField, segment)) {
      segment = path;
      continue;
    }
    return true;
  }
  return false;
}

/** One selector decision for both scope occurrences and lexical name resolution. */
export function rejectsLexicalBindingAtSelector(
  row: ScopeNodeRow,
  binding: Pick<Binding, "kind" | "node"> | null,
  useNode: SyntaxNodeLike,
): boolean {
  if (!isNonLexicalValueUse(row, useNode)) return false;
  if (!binding) return !row.memberSelectorRejectsBinding;
  if (!isValueNamespaceBinding(binding)) return false;
  if (isValuePathQualifier(row, useNode)) return true;
  return row.memberSelectorRejectsBinding?.(binding) ?? true;
}

/** Python defaults use enclosing scopes; class bodies are not closures for nested runtime scopes. */
export function scopeAllowsUse(row: ScopeNodeRow, scope: Scope, use: SyntaxNodeLike): boolean {
  const scopeType = scope.node.type;
  const outerField = scope.kind === "function" ? row.outerEvaluatedFields?.[scopeType] : undefined;
  const outerExpression = outerField ? scope.node.childForFieldName(outerField) : null;
  if (outerExpression && use.startIndex >= outerExpression.startIndex && use.endIndex <= outerExpression.endIndex) {
    return false;
  }
  // A C# lambda's parameter defaults and types are evaluated outside its parameter bindings.
  if (scopeType === "lambda_expression") {
    const parameters = scope.node.childForFieldName("parameters");
    const inParameters = parameters && use.startIndex >= parameters.startIndex && use.endIndex <= parameters.endIndex;
    if (inParameters) {
      const parameter = use.parent?.type === "parameter" || use.parent?.type === "formal_parameter";
      const parameterName = parameter && use.parent?.childForFieldName("name")?.id === use.id;
      const inferred = use.parent?.type === "inferred_parameters" || parameters?.id === use.id;
      const spreadDeclarator =
        use.parent?.type === "variable_declarator" && use.parent.parent?.type === "spread_parameter";
      const spreadName = spreadDeclarator && use.parent?.childForFieldName("name")?.id === use.id;
      const declaresParameter = use.type === "implicit_parameter" || parameterName || inferred || spreadName;
      if (!declaresParameter) return false;
    }
  }
  if (row.moduleBindingsAtFunctionRuntime && scope.kind === "function") {
    const body = scope.node.childForFieldName("body");
    const isFunctionBodyUse = !!body && use.startIndex >= body.startIndex && use.endIndex <= body.endIndex;
    if (!isFunctionBodyUse) {
      for (let current = use.parent; current; current = current.parent) {
        const isScopeNode = current.startIndex === scope.node.startIndex && current.endIndex === scope.node.endIndex;
        if (isScopeNode) break;
        if (!row.destructuringTypeFieldTypes?.has(current.type)) continue;
        const value = current.childForFieldName("value");
        const isDefaultValueUse = !!value && use.startIndex >= value.startIndex && use.endIndex <= value.endIndex;
        if (isDefaultValueUse) return false;
      }
    }
  }
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

/** A later or not-yet-bound local makes an earlier outer-name read invalid. */
export function laterLocalBlocksOuterUse(
  row: ScopeNodeRow,
  scope: Scope,
  canonicalName: string,
  useStartIndex: number,
  normalizeIdentifier: (name: string) => string,
  useNode?: SyntaxNodeLike,
): boolean {
  const pythonFunctionScope =
    row.moduleBindingsAtFunctionRuntime &&
    (scope.kind === "function" || (scope.kind === "block" && scope.node.parent?.type === "function_definition"));
  if (pythonFunctionScope && useNode) {
    const binding = scope.map.get(canonicalName);
    if (
      binding?.kind === "function" &&
      !binding.earlierSameScope &&
      pythonFunctionPendingInDefault(binding.def?.start.index, useNode)
    ) {
      return true;
    }
  }
  if (!row.laterLocalBlocksOuterKinds?.has(scope.kind)) return false;
  for (let binding = scope.map.get(canonicalName); binding; binding = binding.earlierSameScope) {
    const declarationIndex = binding.def?.start.index;
    if (
      binding.kind === "local" &&
      !binding.coversEnclosingScope &&
      declarationIndex !== undefined &&
      declarationIndex > useStartIndex
    ) {
      if (useNode && bindingHiddenFromUse(row, binding, useNode, false, false, false, normalizeIdentifier)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Whether a file-wide same-name fallback may bind the declaration starting at `defStartIndex`
 * for a use the lexical lookup refused: the declaring scope must sit on the use's lexical
 * chain, and a class body only binds uses inside itself (Python class scopes are not
 * closures for nested runtime scopes). Declarations outside the scope model stay accepted.
 */
/**
 * A scope index's scopes in source order together with the nesting between them, so the innermost scope around a
 * position takes a binary search and a short climb instead of a scan of every scope.
 */
type ScopeNesting = {
  /** Start and end offsets of each scope, ordered by ascending start, then descending end, then creation order. */
  starts: Int32Array;
  ends: Int32Array;
  scopes: readonly Scope[];
  /** Position of the nearest enclosing scope in this order, or -1 when no scope encloses it. */
  enclosing: Int32Array;
};

/**
 * What is known about a scope index: nothing yet, that it was scanned once, its nesting, or (null) that its scopes do
 * not nest, which keeps the scan of every scope.
 */
const scopeNestings = new WeakMap<ScopeIndex, "scanned" | ScopeNesting | null>();

/** The nesting of `allScopes`, or null when two scopes overlap without one holding the other. */
function buildScopeNesting(allScopes: readonly Scope[]): ScopeNesting | null {
  const count = allScopes.length;
  const startOf = new Int32Array(count);
  const endOf = new Int32Array(count);
  for (let index = 0; index < count; index += 1) {
    const node = allScopes[index]!.node;
    startOf[index] = node.startIndex;
    endOf[index] = node.endIndex;
  }
  const precedes = (left: number, right: number): number =>
    startOf[left]! - startOf[right]! || endOf[right]! - endOf[left]! || left - right;
  // Scopes are created as the walk reaches them, which is source order unless a parameter's default is walked early.
  const order: number[] = [];
  let sorted = true;
  for (let index = 0; index < count; index += 1) {
    order.push(index);
    if (index && precedes(index, index - 1) < 0) sorted = false;
  }
  if (!sorted) order.sort(precedes);
  const starts = new Int32Array(count);
  const ends = new Int32Array(count);
  const enclosing = new Int32Array(count);
  const scopes: Scope[] = [];
  const open: number[] = [];
  for (let position = 0; position < count; position += 1) {
    const index = order[position]!;
    const start = startOf[index]!;
    const end = endOf[index]!;
    while (open.length) {
      const top = open[open.length - 1]!;
      if (start >= starts[top]! && end <= ends[top]!) break;
      // A scope that begins inside the open one and ends after it overlaps it without nesting.
      if (start < ends[top]!) return null;
      open.pop();
    }
    starts[position] = start;
    ends[position] = end;
    scopes.push(allScopes[index]!);
    enclosing[position] = open.length ? open[open.length - 1]! : -1;
    open.push(position);
  }
  return { starts, ends, scopes, enclosing };
}

/** The last scope in the order that holds `start`..`end`: the deepest of the scopes around it. */
function innermostScopeAround(nesting: ScopeNesting, start: number, end: number): Scope | undefined {
  const { starts, ends, scopes, enclosing } = nesting;
  let low = 0;
  let high = starts.length - 1;
  let last = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (starts[middle]! <= start) {
      last = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  // Every scope around the range encloses the last one that starts at or before it, so the climb finds the deepest.
  for (let position = last; position >= 0; position = enclosing[position]!) {
    if (ends[position]! >= end) return scopes[position];
  }
  return undefined;
}

/** Every scope is tried in creation order and a later one that lies inside the best so far replaces it. */
function scanClosestContainingScope(allScopes: readonly Scope[], start: number, end: number): Scope | undefined {
  let best: Scope | undefined;
  for (const scope of allScopes) {
    if (
      start >= scope.node.startIndex &&
      end <= scope.node.endIndex &&
      (!best || (scope.node.startIndex >= best.node.startIndex && scope.node.endIndex <= best.node.endIndex))
    )
      best = scope;
  }
  return best;
}

/**
 * Innermost scope whose node contains `currentNode`; of scopes with the same range, the one created last. A scope index
 * asked once costs a scan, as it always did; the nesting is built when it is asked again, so a graph build that asks
 * hundreds of times per file pays for it once and a lookup that touches many files once each pays nothing extra.
 */
export function closestContainingScope(scopeIndex: ScopeIndex, currentNode: SyntaxNodeLike): Scope | undefined {
  const start = currentNode.startIndex;
  const end = currentNode.endIndex;
  // An empty range can sit on the shared edge of two scopes that touch, which only the scan orders.
  if (start < end) {
    const known = scopeNestings.get(scopeIndex);
    if (known === undefined) {
      scopeNestings.set(scopeIndex, "scanned");
    } else if (known === "scanned") {
      const built = buildScopeNesting(scopeIndex.allScopes);
      scopeNestings.set(scopeIndex, built);
      if (built) return innermostScopeAround(built, start, end);
    } else if (known) {
      return innermostScopeAround(known, start, end);
    }
  }
  return scanClosestContainingScope(scopeIndex.allScopes, start, end);
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
