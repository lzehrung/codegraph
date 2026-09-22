import { readFileSync } from "node:fs";
import { findCommentEnd } from "../../impact/call-compatibility/text-scanner.js";
import { SymbolKind, type SymbolDef } from "../../indexer/types.js";
import type { LanguageSupport } from "../../languages.js";
import { isJsTsLanguage } from "../../languages/js-family.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { sliceText } from "../../util/ast.js";
import { XID_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
import { keywordReceiverKind, ownReceiverMemberScope } from "../../util/member-access-tables.js";
import {
  getMemberAccessParts,
  getNavigationExpressionProperty,
  isMemberAccessNode,
  isMemberReferencePropertyIdentifier,
  isReceiverNameNode,
} from "../../util/member-access.js";
import type { SymbolGraph } from "../symbol-graph.js";
import { PARAMETER_LIST_NODE_TYPES } from "./ast.js";

/**
 * A receiver method call whose target could not be proven from the calling module
 * alone. Resolution is deferred until every module has contributed its `member_of`
 * and type-hierarchy edges, because the declaring type may live in another file.
 */
export type ReceiverCallCandidate = {
  /** Symbol node id of the function containing the call. */
  callerId: string;
  /** Declaring type node id, or null to use the type that declares `callerId`. */
  ownerId: string | null;
  /** Resolve only through supertypes, for explicit `parent`/`super`/`base` receivers. */
  viaSupertypes: boolean;
  memberName: string;
  /**
   * Argument count, used only to separate same-named overloads on one type.
   * `null` means the call shape is unknown, so arity-based resolution is omitted.
   */
  argumentCount: number | null;
  site: NonNullable<SymbolGraph["edges"][number]["site"]>;
  /** Required static/instance scope; omitted candidates are classified from `site`. */
  memberScope?: ReceiverMemberScope;
};

/** Languages whose grammar distinguishes static members from instance members. */
const STATIC_MEMBER_LANGUAGES: Record<string, true> = {
  cpp: true,
  csharp: true,
  java: true,
  js: true,
  php: true,
  swift: true,
  ts: true,
  tsx: true,
};

/** Every language with a static-member distinction, guarded by the registry-consistency test. */
export const staticMemberLanguageIds: readonly string[] = Object.keys(STATIC_MEMBER_LANGUAGES);

export function hasStaticMemberDistinction(languageId: string): boolean {
  return STATIC_MEMBER_LANGUAGES[languageId] !== undefined;
}

/**
 * Call nodes that carry the receiver and the member name on the call node itself
 * instead of exposing a member-access callee.
 */
const RECEIVER_CALL_NODE_TYPES: Record<string, true> = {
  member_call_expression: true,
  method_invocation: true,
  nullsafe_member_call_expression: true,
  scoped_call_expression: true,
};

/** Declaration nodes that lexically own the methods declared inside them. */
const MEMBER_CONTAINER_TYPES: Record<string, true> = {
  abstract_class_declaration: true,
  class: true,
  class_declaration: true,
  class_definition: true,
  class_specifier: true,
  enum_declaration: true,
  impl_item: true,
  interface_declaration: true,
  module: true,
  object_declaration: true,
  protocol_declaration: true,
  record_declaration: true,
  singleton_class: true,
  struct_declaration: true,
  struct_item: true,
  struct_specifier: true,
  trait_declaration: true,
  trait_item: true,
  // C/C++ unions declare members exactly like structs (tree-sitter-cpp captures
  // union names and classifies them as classes).
  union_specifier: true,
};

/** Nodes holding a call's argument list across the supported grammars. */
export const CALL_ARGUMENT_NODE_TYPES: Record<string, true> = {
  argument_list: true,
  arguments: true,
  // Swift wraps its argument list in a call suffix.
  call_suffix: true,
  value_arguments: true,
};

const HIERARCHY_LABELS: Record<string, true> = {
  extends: true,
  implements: true,
  mixin: true,
  trait: true,
};
const UNPROVEN_HERITAGE_EXPRESSION_TYPES = new Set([
  "binary_expression",
  "call_expression",
  "new_expression",
  "subscript_expression",
  "ternary_expression",
]);

export function isUnprovenHeritageExpression(node: SyntaxNodeLike): boolean {
  return UNPROVEN_HERITAGE_EXPRESSION_TYPES.has(node.type);
}

/**
 * Nodes that bind a value name across the supported grammars: locals, parameters,
 * and assignment targets. A receiver naming one of these is a value, not a type.
 */
const VALUE_BINDING_TYPES: Record<string, true> = {
  assignment: true,
  assignment_expression: true,
  assignment_statement: true,
  class_parameter: true,
  formal_parameter: true,
  init_declarator: true,
  let_declaration: true,
  optional_parameter: true,
  parameter: true,
  parameter_declaration: true,
  property_declaration: true,
  required_parameter: true,
  short_var_declaration: true,
  simple_parameter: true,
  typed_parameter: true,
  var_spec: true,
  variable_declaration: true,
  variable_declarator: true,
};

/**
 * Access nodes whose syntax is type-scoped (`::`), not dotted member access.
 * A dotted identifier is never itself proof of a type.
 */
const TYPE_SCOPED_ACCESS_TYPES: Record<string, true> = {
  qualified_identifier: true,
  qualified_name: true,
  scope_resolution: true,
  scoped_call_expression: true,
  scoped_identifier: true,
  scoped_type_identifier: true,
};

/** Nodes that scope value bindings, including each grammar's file root. */
const BINDING_SCOPE_TYPES: Record<string, true> = {
  arrow_function: true,
  block: true,
  compilation_unit: true,
  function: true,
  function_body: true,
  function_declaration: true,
  function_definition: true,
  function_expression: true,
  function_item: true,
  method: true,
  method_declaration: true,
  method_definition: true,
  module: true,
  program: true,
  source_file: true,
  statement_block: true,
  compound_statement: true,
  do_block: true,
  impl_item: true,
  translation_unit: true,
};

const BINDING_CONTAINER_TYPES = new Set([
  "program",
  "compilation_unit",
  "source_file",
  "translation_unit",
  "statement_block",
  "block",
  "compound_statement",
  "function_body",
  "body_statement",
  "function_declaration",
  "function_item",
  "function_definition",
  "function",
  "function_expression",
  "arrow_function",
  "method_definition",
  "method_declaration",
  "method",
  "impl_item",
]);

const BINDING_DECLARATION_TYPES = new Set([
  "variable_declarator",
  "variable_declaration",
  "let_declaration",
  "assignment",
  "assignment_expression",
  "assignment_statement",
  "formal_parameter",
  "required_parameter",
  "optional_parameter",
  "simple_parameter",
  "parameter",
  "parameter_declaration",
  "typed_parameter",
  "short_var_declaration",
  "var_spec",
  "property_declaration",
  "local_variable_declaration",
  "local_declaration_statement",
]);

const RUBY_CONSTANT_SOURCE = String.raw`(?=\p{Lu})${XID_IDENTIFIER_SOURCE}`;

/** Proven construction forms that name a receiver's type, keyed by language. */
const LANGUAGE_CONSTRUCTION_FORMS: Record<
  string,
  {
    newExpression?: true;
    compositeLiteral?: true;
    capitalizedCall?: true;
    rubyNew?: true;
    rustUnitStruct?: true;
  }
> = {
  cpp: { newExpression: true },
  csharp: { newExpression: true },
  go: { compositeLiteral: true },
  java: { newExpression: true },
  js: { newExpression: true },
  kotlin: { capitalizedCall: true },
  php: { newExpression: true },
  python: { capitalizedCall: true },
  ruby: { rubyNew: true },
  rust: { capitalizedCall: true, rustUnitStruct: true },
  swift: { capitalizedCall: true },
  ts: { newExpression: true },
  tsx: { newExpression: true },
  zig: { compositeLiteral: true },
};

/** Guards against a cyclic or pathological declared hierarchy. */
const MAX_SUPERTYPE_DEPTH = 16;

export type ReceiverCallAccess = {
  /** Member-access node carrying the receiver, used for import-chain resolution. */
  accessNode: SyntaxNodeLike;
  receiver: SyntaxNodeLike;
  property: SyntaxNodeLike;
};

/**
 * Resolves the receiver and member-name nodes of a call, or null when the call has no
 * receiver or its shape is not a member access. `callee` is the call's resolved callee
 * node when the grammar exposes one.
 */
export function receiverCallAccess(
  sup: LanguageSupport,
  callNode: SyntaxNodeLike,
  callee: SyntaxNodeLike | null,
): ReceiverCallAccess | null {
  let accessNode: SyntaxNodeLike | null = null;
  if (RECEIVER_CALL_NODE_TYPES[callNode.type]) {
    accessNode = callNode;
  } else if (callee && isMemberAccessNode(sup, callee)) {
    accessNode = callee;
  } else if (isMemberAccessNode(sup, callNode)) {
    accessNode = callNode;
  }
  if (!accessNode) return null;

  const parts = getMemberAccessParts(sup, accessNode);
  const receiver = parts.object;
  let property = parts.property;
  if (!property && accessNode.type === "navigation_expression") {
    // Kotlin and Swift member access sometimes exposes the member as a direct child
    // rather than through a navigation suffix node.
    property = getNavigationExpressionProperty(sup, accessNode) ?? accessNode.namedChildren[1] ?? null;
  }
  if (!receiver || !property) return null;
  // A receiverless call whose positional fallback collapsed onto the callee itself.
  if (receiver.startIndex === property.startIndex) return null;
  if (!isMemberReferencePropertyIdentifier(sup, property.type)) return null;
  return { accessNode, receiver, property };
}

export type ReceiverMemberScope = "any" | "instance" | "static";

export type ReceiverBinding =
  | { kind: "own-type"; memberScope: ReceiverMemberScope }
  | { kind: "supertype"; memberScope: ReceiverMemberScope }
  | { kind: "named-type"; typeName: string; memberScope: ReceiverMemberScope };

/** What one receiver expression proves, memoized per enclosing function and text. */
export type ReceiverProof = {
  /** Node naming the constructed type, when a prior constructor proves one. */
  constructed: SyntaxNodeLike | null;
  /** Whether an enclosing scope binds the receiver name as a value. */
  locallyBound: boolean;
};

type BindingProof = { status: "none" } | { status: "unproven" } | { status: "type"; node: SyntaxNodeLike };

/**
 * Identifier a binding node declares: a `name` field, a nested C/C++ declarator,
 * an assignment left-hand side, or the last identifier child (C++ parameters hide
 * the name after the type).
 */
function bindingIdentifier(node: SyntaxNodeLike, sup: LanguageSupport): SyntaxNodeLike | null {
  const named = node.childForFieldName("name");
  if (named && (isReceiverNameNode(sup, named.type) || named.type === "field_identifier")) {
    return named;
  }
  if (
    node.type === "assignment" ||
    node.type === "assignment_expression" ||
    node.type === "assignment_statement" ||
    node.type === "short_var_declaration"
  ) {
    const left = node.childForFieldName("left") ?? node.child(0);
    if (left && isReceiverNameNode(sup, left.type)) return left;
    if (left?.type === "expression_list" || left?.type === "pattern") {
      return left.namedChildren.find((child) => isReceiverNameNode(sup, child.type)) ?? null;
    }
    return null;
  }
  let current = node.childForFieldName("declarator");
  while (current) {
    if (isReceiverNameNode(sup, current.type) || current.type === "field_identifier") {
      return current;
    }
    const nested = current.childForFieldName("declarator");
    if (nested) {
      current = nested;
      continue;
    }
    return (
      current.namedChildren.find((child) => child.type === "identifier" || child.type === "field_identifier") ?? null
    );
  }
  const identifiers = node.namedChildren.filter(
    (child) => isReceiverNameNode(sup, child.type) || child.type === "field_identifier",
  );
  if (identifiers.length === 0) return null;
  // `let name = Type;` / `var name = Type{}` put the binding first and the type second.
  // C++ parameters keep the name last, after the type.
  if (node.type === "let_declaration" || node.type === "variable_declaration" || node.type === "variable_declarator") {
    return identifiers[0]!;
  }
  return identifiers[identifiers.length - 1]!;
}

/**
 * Whether a scope encloses `receiver` and binds `receiverName` as a value before it.
 * Nested scopes that do not contain the receiver are skipped, so an unrelated
 * function's local never shadows a type name.
 */
function bindsLocalValue(
  receiver: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): boolean {
  const declaresName = (node: SyntaxNodeLike): boolean => {
    if (node.startIndex >= receiver.startIndex) return false;
    if (node !== receiver && BINDING_SCOPE_TYPES[node.type] && !containsIndex(node, receiver.startIndex)) return false;
    if (PARAMETER_LIST_NODE_TYPES[node.type]) {
      for (const child of node.namedChildren) {
        if (child.startIndex >= receiver.startIndex) continue;
        // Ruby `def run(Lib)` is invalid; tree-sitter wraps the capitalized
        // name in ERROR. Treat recovered parameter names as value bindings.
        const names = child.type === "ERROR" ? child.namedChildren : [child];
        for (const name of names) {
          if (
            (isReceiverNameNode(sup, name.type) || name.type === "identifier" || name.type === "constant") &&
            sliceText(name, source) === receiverName
          ) {
            return true;
          }
        }
      }
    }
    if (VALUE_BINDING_TYPES[node.type]) {
      const name = bindingIdentifier(node, sup);
      if (name && sliceText(name, source) === receiverName) return true;
    }
    return node.namedChildren.some(declaresName);
  };

  for (let current: SyntaxNodeLike | null = receiver.parent; current; current = current.parent) {
    if (BINDING_SCOPE_TYPES[current.type] && current.namedChildren.some(declaresName)) return true;
  }
  return false;
}

function containsIndex(node: SyntaxNodeLike, index: number): boolean {
  return node.startIndex <= index && node.endIndex >= index;
}

function constructorNameNode(node: SyntaxNodeLike, sup: LanguageSupport): SyntaxNodeLike | null {
  const constructor = node.childForFieldName("constructor") ?? node.child(0);
  if (constructor && isReceiverNameNode(sup, constructor.type)) {
    return constructor;
  }
  for (const child of node.namedChildren) {
    if (isReceiverNameNode(sup, child.type) || child.type === "type_identifier" || child.type === "constant") {
      return child;
    }
  }
  return null;
}

function rubyNewReceiverNameNode(node: SyntaxNodeLike, source: string, sup: LanguageSupport): SyntaxNodeLike | null {
  if (!new RegExp(String.raw`^(?:${RUBY_CONSTANT_SOURCE})\.new$`, "u").test(sliceText(node, source))) return null;
  return node.namedChildren.find((child) => isReceiverNameNode(sup, child.type) || child.type === "constant") ?? null;
}

export function unwrapNamedType(node: SyntaxNodeLike, sup: LanguageSupport): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (
      current.type === "type_annotation" ||
      current.type === "named_type" ||
      current.type === "user_type" ||
      current.type === "type" ||
      current.type === "parenthesized_type" ||
      current.type === "pointer_type" ||
      current.type === "reference_type" ||
      current.type === "optional_type" ||
      current.type === "nullable_type"
    ) {
      current = current.childForFieldName("type") ?? current.namedChildren[0] ?? null;
      continue;
    }
    if (current.type === "generic_type" || current.type === "generic_name") {
      current = current.childForFieldName("type") ?? current.namedChildren[0] ?? null;
      continue;
    }
    break;
  }
  if (!current) return null;
  if (isReceiverNameNode(sup, current.type) || current.type === "type_identifier" || current.type === "name") {
    return current;
  }
  return null;
}

function capitalizedCallTypeName(expr: SyntaxNodeLike, source: string, sup: LanguageSupport): SyntaxNodeLike | null {
  if (expr.type !== "call" && expr.type !== "call_expression") return null;
  const callee = expr.childForFieldName("function") ?? expr.namedChildren[0] ?? null;
  if (!callee || !isReceiverNameNode(sup, callee.type)) return null;
  const name = sliceText(callee, source);
  if (!name) return null;
  const first = name[0]!;
  if (first !== first.toUpperCase()) return null;
  return callee;
}

function compositeLiteralTypeName(expr: SyntaxNodeLike, source: string, sup: LanguageSupport): SyntaxNodeLike | null {
  let current = expr;
  if (current.type === "unary_expression") {
    const operand = current.childForFieldName("operand");
    if (!operand) return null;
    const operator = current.childForFieldName("operator");
    let isAddr = sliceText(current, source).startsWith("&");
    if (operator) isAddr = sliceText(operator, source) === "&";
    if (!isAddr) return null;
    current = operand;
  }
  if (current.type !== "composite_literal" && current.type !== "struct_initializer") return null;
  const typeNode =
    current.childForFieldName("type") ??
    current.namedChildren.find((child) => child.type === "type_identifier" || child.type === "identifier") ??
    null;
  return typeNode ? (unwrapNamedType(typeNode, sup) ?? typeNode) : null;
}

/**
 * Resolves the node naming the type a construction expression denotes, or null
 * when the expression is not a proven constructor form.
 */
export function constructionTypeName(
  expr: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  const forms = LANGUAGE_CONSTRUCTION_FORMS[sup.id];
  if (!forms) return null;
  if (forms.newExpression && (expr.type === "new_expression" || expr.type === "object_creation_expression")) {
    return constructorNameNode(expr, sup);
  }
  if (forms.rubyNew && expr.type === "call") {
    const rubyConstructor = rubyNewReceiverNameNode(expr, source, sup);
    if (rubyConstructor) return rubyConstructor;
  }
  if (forms.compositeLiteral) {
    const composite = compositeLiteralTypeName(expr, source, sup);
    if (composite) return composite;
  }
  if (forms.capitalizedCall) {
    const fromCall = capitalizedCallTypeName(expr, source, sup);
    if (fromCall) return fromCall;
  }
  // Rust unit structs are constructed by the type name itself: `let service = Service;`.
  if (forms.rustUnitStruct && isReceiverNameNode(sup, expr.type)) {
    const name = sliceText(expr, source);
    const first = name[0];
    if (first && first === first.toUpperCase() && first !== first.toLowerCase()) return expr;
  }
  return null;
}

function bindingValueExpression(node: SyntaxNodeLike): SyntaxNodeLike | null {
  const named =
    node.childForFieldName("value") ?? node.childForFieldName("right") ?? node.childForFieldName("default_value");
  if (named) {
    if (named.type === "expression_list") return named.namedChildren[0] ?? null;
    return named;
  }
  const expressionTypes = new Set([
    "new_expression",
    "object_creation_expression",
    "call",
    "call_expression",
    "composite_literal",
    "struct_initializer",
    "unary_expression",
  ]);
  return node.namedChildren.find((child) => expressionTypes.has(child.type)) ?? null;
}

function declaredTypeNameNode(node: SyntaxNodeLike, sup: LanguageSupport): SyntaxNodeLike | null {
  const typeField = node.childForFieldName("type");
  if (typeField) return unwrapNamedType(typeField, sup);
  const typedChild = node.namedChildren.find(
    (child) =>
      child.type === "named_type" ||
      child.type === "user_type" ||
      child.type === "type_annotation" ||
      child.type === "type",
  );
  if (typedChild) return unwrapNamedType(typedChild, sup);
  const ids = node.namedChildren.filter(
    (child) => isReceiverNameNode(sup, child.type) || child.type === "type_identifier" || child.type === "name",
  );
  if (ids.length >= 2) return unwrapNamedType(ids[0]!, sup);
  return null;
}

function goBindingNameNodes(node: SyntaxNodeLike): SyntaxNodeLike[] {
  if (node.type === "short_var_declaration") {
    const left = node.childForFieldName("left");
    return (left?.namedChildren ?? []).filter((child) => child.type === "identifier");
  }
  if (node.type === "var_spec") {
    return (node.namedChildren ?? []).filter((child) => child.type === "identifier");
  }
  return [];
}

function bindingDeclaresReceiverName(
  node: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): boolean {
  if (sup.id === "go") {
    const goNames = goBindingNameNodes(node);
    if (goNames.some((name) => sliceText(name, source) === receiverName)) return true;
  }
  const name = bindingIdentifier(node, sup);
  if (name && sliceText(name, source) === receiverName) return true;
  if (node.type === "property_declaration") {
    return node.namedChildren.some((child) => {
      if (child.type === "variable_declaration" || child.type === "pattern") {
        return child.namedChildren.some(
          (inner) => isReceiverNameNode(sup, inner.type) && sliceText(inner, source) === receiverName,
        );
      }
      return isReceiverNameNode(sup, child.type) && sliceText(child, source) === receiverName;
    });
  }
  return false;
}

function constructionTypeFromBinding(
  node: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  if (sup.id === "go" && (node.type === "short_var_declaration" || node.type === "var_spec")) {
    return constructorFromGoBinding(node, receiverName, source, sup) ?? declaredTypeNameNode(node, sup);
  }
  const value = bindingValueExpression(node);
  if (value) {
    const fromValue = constructionTypeName(value, source, sup);
    if (fromValue) return fromValue;
  }
  return declaredTypeNameNode(node, sup);
}

function constructorFromGoBinding(
  node: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  if (node.type === "short_var_declaration") {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left || !right) return null;
    const names = (left.namedChildren ?? []).filter((child) => child.type === "identifier");
    const values = right.namedChildren ?? [];
    const index = names.findIndex((name) => sliceText(name, source) === receiverName);
    if (index < 0) return null;
    const value = values[index] ?? null;
    return value ? constructionTypeName(value, source, sup) : null;
  }
  if (node.type !== "var_spec") return null;
  const value = node.childForFieldName("value");
  if (value) {
    const first = value.type === "expression_list" ? (value.namedChildren[0] ?? null) : value;
    const fromValue = first ? constructionTypeName(first, source, sup) : null;
    if (fromValue) return fromValue;
  }
  const typeNode = node.childForFieldName("type");
  return typeNode ? unwrapNamedType(typeNode, sup) : null;
}

function bindingProof(node: SyntaxNodeLike, receiverName: string, source: string, sup: LanguageSupport): BindingProof {
  if (!BINDING_DECLARATION_TYPES.has(node.type)) return { status: "none" };
  if (!bindingDeclaresReceiverName(node, receiverName, source, sup)) return { status: "none" };
  const typeNode = constructionTypeFromBinding(node, receiverName, source, sup);
  if (typeNode) return { status: "type", node: typeNode };
  return { status: "unproven" };
}

function isSkippableBindingContainer(node: SyntaxNodeLike, receiver: SyntaxNodeLike): boolean {
  return BINDING_CONTAINER_TYPES.has(node.type) && !containsIndex(node, receiver.startIndex);
}

function findPriorConstructorInContainer(
  node: SyntaxNodeLike,
  receiver: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  let constructor: SyntaxNodeLike | null = null;
  let sawUnproven = false;
  const visit = (current: SyntaxNodeLike): boolean => {
    if (current.startIndex >= receiver.startIndex) return true;
    if (current !== node && isSkippableBindingContainer(current, receiver)) return true;
    const proof = bindingProof(current, receiverName, source, sup);
    if (proof.status === "unproven") {
      if (constructor) {
        constructor = null;
        return false;
      }
      sawUnproven = true;
      return true;
    }
    if (proof.status === "type") {
      if (sawUnproven) {
        constructor = null;
        return false;
      }
      if (constructor && sliceText(constructor, source) !== sliceText(proof.node, source)) {
        constructor = null;
        return false;
      }
      constructor = proof.node;
      return true;
    }
    for (const child of current.namedChildren) {
      if (!visit(child)) return false;
    }
    return true;
  };
  visit(node);
  return constructor;
}

function bindingContainerDeclaresNameBefore(
  node: SyntaxNodeLike,
  receiver: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): boolean {
  const visit = (current: SyntaxNodeLike): boolean => {
    if (current.startIndex >= receiver.startIndex) return false;
    if (current !== node && isSkippableBindingContainer(current, receiver)) return false;
    if (
      BINDING_DECLARATION_TYPES.has(current.type) &&
      bindingDeclaresReceiverName(current, receiverName, source, sup)
    ) {
      return true;
    }
    for (const child of current.namedChildren) {
      if (visit(child)) return true;
    }
    return false;
  };
  return visit(node);
}

function rootOf(node: SyntaxNodeLike): SyntaxNodeLike {
  let current = node;
  while (current.parent) current = current.parent;
  return current;
}

function findVisiblePriorConstructor(
  receiver: SyntaxNodeLike,
  receiverName: string,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = receiver;
  while (current) {
    if (BINDING_CONTAINER_TYPES.has(current.type)) {
      const constructor = findPriorConstructorInContainer(current, receiver, receiverName, source, sup);
      if (constructor || bindingContainerDeclaresNameBefore(current, receiver, receiverName, source, sup)) {
        return constructor;
      }
    }
    current = current.parent;
  }
  return findPriorConstructorInContainer(rootOf(receiver), receiver, receiverName, source, sup);
}

/**
 * Resolves the node naming the type a receiver expression was constructed from, or
 * null when no constructor is proven for it. Shared with detailed symbol-graph call
 * extraction so `goto` and resolved `calls` edges accept the same receiver forms.
 */
export function receiverConstructorExpression(
  obj: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  const direct = constructionTypeName(obj, source, sup);
  if (direct) return direct;
  if (!isReceiverNameNode(sup, obj.type)) return null;
  const receiverName = sliceText(obj, source);
  return findVisiblePriorConstructor(obj, receiverName, source, sup);
}

export function cppOutOfLineClassName(node: SyntaxNodeLike, source: string, sup: LanguageSupport): string | null {
  if (sup.id !== "cpp") return null;
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (current.type === "function_definition") {
      let declarator = current.childForFieldName("declarator");
      while (declarator) {
        if (declarator.type === "qualified_identifier") {
          const scope = declarator.childForFieldName("scope");
          if (!scope) return null;
          const rightmostScopeName = scope.childForFieldName("name") ?? scope;
          return sliceText(rightmostScopeName, source);
        }
        const nested = declarator.childForFieldName("declarator");
        if (!nested || nested.id === declarator.id) break;
        declarator = nested;
      }
      return null;
    }
    current = current.parent;
  }
  return null;
}
export function nodeDeclaresStatic(node: SyntaxNodeLike, source: string): boolean {
  if (node.type === "static" || node.type === "static_modifier") return true;
  if (node.type === "storage_class_specifier" || node.type === "modifier" || node.type === "property_modifier") {
    return sliceText(node, source).trim() === "static";
  }
  if (node.type === "class") {
    const parentType = node.parent?.type;
    return (
      parentType === "function_declaration" ||
      parentType === "property_declaration" ||
      parentType === "subscript_declaration"
    );
  }
  if (node.type === "modifiers") {
    for (let childIndex = 0; ; childIndex += 1) {
      const child = node.child(childIndex);
      if (!child) break;
      if (nodeDeclaresStatic(child, source)) return true;
    }
  }
  return false;
}
export function declarationNodeIsStatic(node: SyntaxNodeLike, source: string): boolean {
  if (nodeDeclaresStatic(node, source)) return true;
  for (let childIndex = 0; ; childIndex += 1) {
    const child = node.child(childIndex);
    if (!child) return false;
    if (nodeDeclaresStatic(child, source)) return true;
  }
}

function nodeInStaticMemberContext(node: SyntaxNodeLike, source: string): boolean {
  const container = nearestMemberContainer(node);
  if (!container) return false;
  let current: SyntaxNodeLike | null = node;
  while (current && current !== container) {
    if (declarationNodeIsStatic(current, source)) return true;
    current = current.parent;
  }
  return false;
}

const JS_TS_DYNAMIC_THIS_FUNCTION_TYPES: Record<string, true> = {
  function: true,
  function_declaration: true,
  function_expression: true,
  generator_function: true,
  generator_function_declaration: true,
  method_definition: true,
};

/**
 * Ordinary JS/TS functions and object-literal methods own `this`/`super`; arrows preserve the
 * enclosing class member's receiver. Crossing one of those dynamic boundaries makes the class
 * receiver unproven.
 */
export function keywordReceiverCrossesDynamicBoundary(sup: LanguageSupport, node: SyntaxNodeLike): boolean {
  if (!isJsTsLanguage(sup.id)) return false;
  const container = nearestMemberContainer(node);
  if (!container) return false;
  let current: SyntaxNodeLike | null = node.parent;
  while (current && current !== container) {
    if (JS_TS_DYNAMIC_THIS_FUNCTION_TYPES[current.type]) {
      const directlyOwnedClassMethod =
        current.type === "method_definition" &&
        current.parent?.type === "class_body" &&
        current.parent.parent?.startIndex === container.startIndex;
      return !directlyOwnedClassMethod;
    }
    current = current.parent;
  }
  return false;
}

export function keywordReceiverMemberScope(
  sup: LanguageSupport,
  receiverName: string,
  node: SyntaxNodeLike,
  source: string,
): ReceiverMemberScope {
  if (!hasStaticMemberDistinction(sup.id)) return "any";
  const kind = keywordReceiverKind(sup.id, receiverName);
  if (kind === "supertype") {
    return nodeInStaticMemberContext(node, source) ? "static" : "instance";
  }
  const keywordScope = ownReceiverMemberScope(sup.id, receiverName) ?? "any";
  return keywordScope === "instance" && nodeInStaticMemberContext(node, source) ? "static" : keywordScope;
}

/**
 * Classifies a receiver as the declaring type, a supertype, or a named/constructed type.
 * Returns null when the receiver cannot be proven.
 * Named-local constructor lookup is memoized per enclosing function and receiver text.
 */
export function classifyReceiver(
  sup: LanguageSupport,
  receiver: SyntaxNodeLike,
  source: string,
  proofCache: Map<string, ReceiverProof>,
  cacheScope: number,
  accessNode: SyntaxNodeLike,
): ReceiverBinding | null {
  const text = sliceText(receiver, source).trim();
  if (!text) return null;
  const keywordKind = keywordReceiverKind(sup.id, text);
  if (keywordKind) {
    if (keywordReceiverCrossesDynamicBoundary(sup, accessNode)) return null;
    const memberScope = keywordReceiverMemberScope(sup, text, accessNode, source);
    return keywordKind === "own" ? { kind: "own-type", memberScope } : { kind: "supertype", memberScope };
  }

  const receiverIsName = isReceiverNameNode(sup, receiver.type);

  const cacheKey = `${cacheScope}\u0000${text}`;
  let proof = proofCache.get(cacheKey);
  if (!proof) {
    const constructed = receiverConstructorExpression(receiver, source, sup);
    proof = {
      constructed,
      locallyBound: !constructed && receiverIsName && bindsLocalValue(receiver, text, source, sup),
    };
    proofCache.set(cacheKey, proof);
  }
  if (proof.constructed) {
    return {
      kind: "named-type",
      typeName: sliceText(proof.constructed, source),
      memberScope: hasStaticMemberDistinction(sup.id) ? "instance" : "any",
    };
  }
  if (!receiverIsName) return null;
  // A name bound by a local or parameter is a value, not a type. Without this guard
  // `Example::shared()` would still be attributed to a colliding parameter named Example.
  if (proof.locallyBound) return null;
  // Dotted `Cfg.load()` is not proof: the identifier may be a value. Type-scoped `::`
  // is the remaining named-type proof. Ruby capitalized names are `constant` tokens
  // even when they name a parameter, so `constant` is not itself type proof.
  const property = getMemberAccessParts(sup, accessNode).property;
  const between = property ? source.slice(receiver.endIndex, property.startIndex) : "";
  const typeScoped = TYPE_SCOPED_ACCESS_TYPES[accessNode.type] === true || between.includes("::");
  if (receiver.type !== "type_identifier" && !typeScoped) return null;
  return {
    kind: "named-type",
    typeName: text,
    memberScope: hasStaticMemberDistinction(sup.id) && typeScoped ? "static" : "any",
  };
}

/** Whether a resolved definition can declare callable members. */
export function declaresMembers(def: SymbolDef): boolean {
  return def.kind === SymbolKind.Class || def.kind === SymbolKind.Interface || def.kind === SymbolKind.TypeAlias;
}

/** Nearest enclosing declaration that lexically owns `node` as a member. */
export function nearestMemberContainer(node: SyntaxNodeLike): SyntaxNodeLike | null {
  let current = node.parent;
  while (current) {
    if (MEMBER_CONTAINER_TYPES[current.type]) return current;
    current = current.parent;
  }
  return null;
}

/** Positional argument count of a call, including Kotlin/Swift trailing lambdas. */
export function callArgumentCount(callNode: SyntaxNodeLike, source: string): number | null {
  // Kotlin wraps `pick(1) { }` in an outer call node whose only other child is the
  // callee call; the trailing lambda belongs to the inner call's argument list.
  let scope = callNode;
  for (let wrapper = trailingLambdaWrapper(scope); wrapper; wrapper = trailingLambdaWrapper(scope)) {
    scope = wrapper;
  }

  let argumentNode: SyntaxNodeLike | null =
    callNode.childForFieldName("arguments") ??
    callNode.childForFieldName("argument_list") ??
    (callNode.namedChildren ?? []).find((child) => CALL_ARGUMENT_NODE_TYPES[child.type]) ??
    null;
  if (argumentNode?.type === "call_suffix") {
    argumentNode = (argumentNode.namedChildren ?? []).find((child) => child.type === "value_arguments") ?? null;
  }
  if (!argumentNode) {
    // Swift allows a call suffix with only a trailing lambda (`pick { }`), and Kotlin
    // `pick { }` keeps the lambda directly on the call node: no argument list exists.
    const suffix = (callNode.namedChildren ?? []).find((child) => child.type === "call_suffix");
    return ((suffix ?? scope).namedChildren ?? []).filter(
      (child) => TRAILING_LAMBDA_NODE_TYPES[child.type] && child.startIndex >= callNode.startIndex,
    ).length;
  }

  let count = (argumentNode.namedChildren ?? []).filter((argument) => argument.type !== "comment").length;
  const trailingEnd = argumentNode.parent?.type === "call_suffix" ? argumentNode.parent.endIndex : scope.endIndex;
  if (trailingEnd > argumentNode.endIndex && containsTrailingLambdaNode(scope, argumentNode.endIndex, trailingEnd)) {
    const trailing = countTrailingClosureArguments(source.slice(argumentNode.endIndex, trailingEnd));
    // A null scan means the trailing-closure count is unknown, so the whole call
    // arity is unknown rather than the parenthesized count alone.
    if (trailing === null) return null;
    count += trailing;
  }
  return count;
}

/** Trailing lambda nodes across the supported grammars. */
const TRAILING_LAMBDA_NODE_TYPES: Record<string, true> = {
  annotated_lambda: true, // Kotlin wraps the lambda on the outer call node.
  lambda_literal: true, // Swift keeps trailing lambdas inside `call_suffix`.
};

/** Call nodes that can wrap a callee call plus a Kotlin trailing lambda. */
const TRAILING_LAMBDA_WRAPPER_TYPES: Record<string, true> = {
  call: true,
  call_expression: true,
};

/**
 * The outer call node attaching a trailing lambda to `node`, or null. The wrapper
 * never carries its own argument list, which distinguishes it from a chained call.
 */
function trailingLambdaWrapper(node: SyntaxNodeLike): SyntaxNodeLike | null {
  const parent = node.parent;
  if (!parent || !TRAILING_LAMBDA_WRAPPER_TYPES[parent.type]) return null;
  const children = parent.namedChildren ?? [];
  if (children.some((child) => CALL_ARGUMENT_NODE_TYPES[child.type])) return null;
  return children.some((child) => TRAILING_LAMBDA_NODE_TYPES[child.type]) ? parent : null;
}

/** Whether a trailing lambda node overlaps `[start, end)` anywhere under `node`. */
function containsTrailingLambdaNode(node: SyntaxNodeLike, start: number, end: number): boolean {
  for (const child of node.namedChildren ?? []) {
    if (child.endIndex <= start || child.startIndex >= end) continue;
    if (TRAILING_LAMBDA_NODE_TYPES[child.type]) return true;
    if (containsTrailingLambdaNode(child, start, end)) return true;
  }
  return false;
}

/** End index after a Swift trailing-closure label and its colon, or null when absent. */
function trailingClosureLabelEnd(text: string, startIndex: number): number | null {
  if (text[startIndex] === "`") {
    const escapedEnd = text.indexOf("`", startIndex + 1);
    if (escapedEnd < 0 || text[escapedEnd + 1] !== ":") return null;
    return escapedEnd + 2;
  }
  const identifier = /^[_\p{ID_Start}][_\p{ID_Continue}]*/u.exec(text.slice(startIndex));
  if (!identifier) return null;
  const colonIndex = startIndex + identifier[0].length;
  return text[colonIndex] === ":" ? colonIndex + 1 : null;
}

/**
 * Counts the top-level `{ ... }` blocks in trailing call text, one per trailing
 * closure, or null when the text is not a well-formed trailing-closure run.
 * Shared with call-compatibility extraction so both paths count identically.
 */
export function countTrailingClosureArguments(text: string): number | null {
  let startIndex = 0;
  let count = 0;

  while (startIndex < text.length) {
    while (/\s/.test(text[startIndex] ?? "")) {
      startIndex += 1;
    }
    if (startIndex === text.length) {
      return count;
    }
    if (text[startIndex] !== "{") {
      const labelEnd = trailingClosureLabelEnd(text, startIndex);
      if (labelEnd === null) return null;
      startIndex = labelEnd;
      while (/\s/.test(text[startIndex] ?? "")) {
        startIndex += 1;
      }
      if (text[startIndex] !== "{") return null;
    }

    let braceDepth = 0;
    let quote: string | null = null;
    let escaped = false;
    let closed = false;
    for (let index = startIndex; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === quote) {
          quote = null;
        }
        continue;
      }

      const commentEnd = findCommentEnd(text, index);
      if (commentEnd !== null) {
        if (commentEnd < 0) {
          return null;
        }
        index = commentEnd - 1;
        continue;
      }

      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") {
        braceDepth += 1;
        continue;
      }
      if (char === "}") {
        braceDepth -= 1;
        if (braceDepth < 0) {
          return null;
        }
        if (!braceDepth) {
          startIndex = index + 1;
          count += 1;
          closed = true;
          break;
        }
      }
    }
    if (!closed) {
      return null;
    }
  }

  return count;
}

function loadSource(file: string, cache: Map<string, string>): string {
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  try {
    const source = readFileSync(file, "utf8");
    cache.set(file, source);
    return source;
  } catch {
    cache.set(file, "");
    return "";
  }
}

function inferCallMemberScope(
  site: ReceiverCallCandidate["site"],
  sourceCache: Map<string, string>,
): ReceiverMemberScope {
  const source = loadSource(site.file, sourceCache);
  if (!source) return "any";
  const start = site.range.start.index ?? 0;
  const before = source.slice(Math.max(0, start - 120), start);
  if (/\b(?:self|static|parent|super|base)\s*::\s*$/i.test(before)) return "any";
  if (/::\s*$/.test(before)) return "static";
  if (/\?->\s*$/.test(before) || /->\s*$/.test(before)) return "instance";
  if (/\)\s*\.\s*$/.test(before)) return "instance";
  // Older serialized candidates lack memberScope. Infer the common dotted-receiver cases.
  if (/(?:^|[^A-Za-z0-9_$])[a-z_][A-Za-z0-9_]*\s*\.\s*$/.test(before)) return "instance";
  if (/(?:^|[^A-Za-z0-9_$])[A-Z][A-Za-z0-9_]*\s*\.\s*$/.test(before)) return "static";
  return "any";
}
function callSiteKey(callerId: string, site: ReceiverCallCandidate["site"]): string {
  const { start, end } = site.range;
  return `${callerId}\u0000${site.file}\u0000${start.line}:${start.column}:${start.index ?? ""}-${end.line}:${end.column}:${end.index ?? ""}`;
}

/**
 * Records proven `calls` edges for deferred receiver invocations.
 * Ambiguous names at a level stop the walk.
 * `super`/`base`/`parent` follow class `extends` ancestors only.
 */
export function emitReceiverCallEdges(
  graph: SymbolGraph,
  candidates: readonly ReceiverCallCandidate[],
  recordEdge: (fromId: string, toId: string, label?: string, site?: SymbolGraph["edges"][number]["site"]) => boolean,
  memberScopes: ReadonlyMap<string, ReceiverMemberScope> = new Map(),
): void {
  if (!candidates.length) return;

  const membersByOwner = new Map<string, string[]>();
  const ownerByMember = new Map<string, string>();
  const supertypesByOwner = new Map<string, string[]>();
  const classAncestorsByOwner = new Map<string, string[]>();
  const pushUnique = (map: Map<string, string[]>, from: string, to: string): void => {
    const list = map.get(from);
    if (!list) map.set(from, [to]);
    else if (!list.includes(to)) list.push(to);
  };
  for (const edge of graph.edges) {
    const label = edge.label;
    if (label === "member_of") {
      pushUnique(membersByOwner, edge.to, edge.from);
      ownerByMember.set(edge.from, edge.to);
      continue;
    }
    if (!label || !HIERARCHY_LABELS[label]) continue;
    pushUnique(supertypesByOwner, edge.from, edge.to);
    if (label === "extends") pushUnique(classAncestorsByOwner, edge.from, edge.to);
  }

  const nextOwners = (ownerId: string, viaSupertypes: boolean): string[] => {
    if (!viaSupertypes) return supertypesByOwner.get(ownerId) ?? [];
    return (classAncestorsByOwner.get(ownerId) ?? []).filter((id) => graph.nodes.get(id)?.kind === "class");
  };

  const callTargetsBySite = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.label !== "calls" || !edge.site) continue;
    const key = callSiteKey(edge.from, edge.site);
    const targets = callTargetsBySite.get(key);
    if (targets) targets.add(edge.to);
    else callTargetsBySite.set(key, new Set([edge.to]));
  }
  const rejectedCallSites = new Set<string>();

  const sourceCache = new Map<string, string>();
  for (const candidate of candidates) {
    const siteKey = callSiteKey(candidate.callerId, candidate.site);
    const existingTargets = callTargetsBySite.get(siteKey) ?? new Set<string>();
    if (existingTargets.size > 1) {
      rejectedCallSites.add(siteKey);
      continue;
    }
    const owner = candidate.ownerId ?? ownerByMember.get(candidate.callerId);
    if (!owner) continue;
    const memberScope = candidate.memberScope ?? inferCallMemberScope(candidate.site, sourceCache);
    let level = candidate.viaSupertypes ? nextOwners(owner, true) : [owner];
    const visited = new Set<string>(level);
    let receiverDisposition: "none" | "resolved" | "ambiguous" = "none";
    for (let depth = 0; depth < MAX_SUPERTYPE_DEPTH && level.length; depth += 1) {
      const lookup = provenMemberTarget(graph, membersByOwner, level, candidate, memberScope, memberScopes);
      if (lookup.status === "unique") {
        receiverDisposition = "resolved";
        const combinedTargets = new Set(existingTargets);
        combinedTargets.add(lookup.memberId);
        if (combinedTargets.size === 1) {
          if (existingTargets.size === 0 && recordEdge(candidate.callerId, lookup.memberId, "calls", candidate.site)) {
            existingTargets.add(lookup.memberId);
            callTargetsBySite.set(siteKey, existingTargets);
          }
        } else {
          rejectedCallSites.add(siteKey);
        }
        break;
      }
      if (lookup.status === "ambiguous") {
        receiverDisposition = "ambiguous";
        if (existingTargets.size) rejectedCallSites.add(siteKey);
        break;
      }
      const next: string[] = [];
      for (const ownerId of level) {
        for (const supertype of nextOwners(ownerId, candidate.viaSupertypes)) {
          if (visited.has(supertype)) continue;
          visited.add(supertype);
          next.push(supertype);
        }
      }
      level = next;
    }
    if (receiverDisposition === "none" && existingTargets.size) {
      rejectedCallSites.add(siteKey);
    }
  }
  if (rejectedCallSites.size) {
    graph.edges = graph.edges.filter(
      (edge) => edge.label !== "calls" || !edge.site || !rejectedCallSites.has(callSiteKey(edge.from, edge.site)),
    );
  }
}

type MemberTargetLookup = { status: "none" } | { status: "unique"; memberId: string } | { status: "ambiguous" };

/**
 * The single callable member named by `candidate` across `owners`.
 * `none` means this depth has no name match and the walk may continue.
 * `ambiguous` means this depth matched the name but could not prove one member,
 * including arity ambiguity, and the walk must stop.
 */
function provenMemberTarget(
  graph: SymbolGraph,
  membersByOwner: ReadonlyMap<string, readonly string[]>,
  owners: readonly string[],
  candidate: ReceiverCallCandidate,
  memberScope: ReceiverMemberScope,
  memberScopes: ReadonlyMap<string, ReceiverMemberScope>,
): MemberTargetLookup {
  const matches = new Set<string>();
  for (const ownerId of owners) {
    for (const memberId of membersByOwner.get(ownerId) ?? []) {
      const node = graph.nodes.get(memberId);
      if (!node || node.kind !== "function" || node.name !== candidate.memberName) continue;
      if (memberScope !== "any" && memberScopes.get(memberId) !== memberScope) continue;
      matches.add(memberId);
    }
  }
  if (!matches.size) return { status: "none" };
  if (matches.size === 1) {
    const [memberId] = matches;
    return { status: "unique", memberId: memberId! };
  }
  const byArity =
    candidate.argumentCount === null
      ? []
      : [...matches].filter((memberId) => graph.nodes.get(memberId)?.memberArity === candidate.argumentCount);
  if (byArity.length === 1) return { status: "unique", memberId: byArity[0]! };
  return { status: "ambiguous" };
}
