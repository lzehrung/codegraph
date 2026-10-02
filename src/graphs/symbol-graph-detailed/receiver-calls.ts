import { readFileSync } from "node:fs";
import { findCommentEnd } from "../../impact/call-compatibility/text-scanner.js";
import { isGoExportedMemberName } from "../../indexer/declaration-visibility.js";
import { selectMember, type MemberModel } from "../../indexer/member-selection.js";
import { SymbolKind, type ModuleIndex, type SymbolDef } from "../../indexer/types.js";
import type { LanguageSupport } from "../../languages.js";
import { isJsTsLanguage } from "../../languages/js-family.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../../languages/types.js";
import { sliceText } from "../../util/ast.js";
import { foldPhpIdentifierCase, XID_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
import { fileIdentityKey } from "../../util/paths.js";
import { keywordReceiverKind, ownReceiverMemberScope } from "../../util/member-access-tables.js";
import {
  getMemberAccessParts,
  getNavigationExpressionProperty,
  isMemberAccessNode,
  isMemberReferencePropertyIdentifier,
  isReceiverNameNode,
  receiverKeywordText,
} from "../../util/member-access.js";
import type { SymbolGraph } from "../symbol-graph.js";
import { declarationMemberArity, findFirstNodeByType, isIdentifierType, PARAMETER_LIST_NODE_TYPES } from "./ast.js";

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
  /** Files proven to share the caller's Go package; only those see unexported methods. */
  goPackagePeerFiles?: ReadonlySet<string>;
  /** Match the member name with PHP's ASCII case-insensitive method rule. */
  caseInsensitiveMemberName?: boolean;
  /**
   * Argument count rejects incompatible known targets and separates overloads on one type.
   * `null` means the call shape is unknown, so arity-based resolution is omitted.
   */
  argumentCount: number | null;
  site: NonNullable<SymbolGraph["edges"][number]["site"]>;
  /** Required static/instance scope; omitted candidates are classified from site. */
  memberScope?: ReceiverMemberScope;
  /** Free function to use only if a Swift receiver has no matching member. */
  fallbackTargetId?: string | undefined;
};

/** Languages whose grammar distinguishes static members from instance members. */
const STATIC_MEMBER_LANGUAGES: Record<string, true> = {
  cpp: true,
  csharp: true,
  java: true,
  js: true,
  php: true,
  ruby: true,
  swift: true,
  ts: true,
  tsx: true,
};

const MEMBER_OVERLOAD_LANGUAGE_IDS: Record<string, true> = {
  cpp: true,
  csharp: true,
  java: true,
  kotlin: true,
  swift: true,
  ts: true,
  tsx: true,
};

/** Bare calls inside members can target a proven member even without an explicit receiver. */
const IMPLICIT_SELF_MEMBER_CALL_LANGUAGES: Record<string, true> = {
  csharp: true,
  swift: true,
};

/** Whether a bare, receiver-less call inside a member function may target `this`/an inherited member. */
export function supportsImplicitSelfMemberCalls(languageId: string): boolean {
  return !!IMPLICIT_SELF_MEMBER_CALL_LANGUAGES[languageId];
}

/** Whether member lookup uses call arity to select or reject same-name declarations. */
export function supportsReceiverMemberOverloads(languageId: string): boolean {
  return !!MEMBER_OVERLOAD_LANGUAGE_IDS[languageId];
}

/** Every language with a static-member distinction, guarded by the registry-consistency test. */
export const staticMemberLanguageIds: readonly string[] = Object.keys(STATIC_MEMBER_LANGUAGES);

export function hasStaticMemberDistinction(languageId: string): boolean {
  return STATIC_MEMBER_LANGUAGES[languageId] !== undefined;
}

/**
 * Languages whose grammar gives members a static-equivalent scope without a `static` keyword:
 * a Kotlin member of a `companion object` or a named `object` declaration is reachable as
 * `Outer.member()`. Member lookup classifies those members "static" and every other member
 * "instance", matching the keyword-`static` languages.
 */
const STATIC_EQUIVALENT_MEMBER_CONTAINERS: Record<string, Readonly<Record<string, true>>> = {
  kotlin: { companion_object: true, object_declaration: true },
};

/**
 * Whether `node` is lexically declared inside its language's static-equivalent member
 * container. The nearest enclosing member container decides: a nested type's members belong
 * to that type, not to an outer `object`.
 */
export function declarationIsStaticEquivalent(languageId: string, node: SyntaxNodeLike): boolean {
  const containers = STATIC_EQUIVALENT_MEMBER_CONTAINERS[languageId];
  if (!containers) return false;
  let current: SyntaxNodeLike | null = node.parent;
  while (current) {
    if (containers[current.type] === true) return true;
    if (MEMBER_CONTAINER_TYPES[current.type] === true) return false;
    current = current.parent;
  }
  return false;
}

/**
 * Whether member lookup for `languageId` distinguishes static-equivalent members from
 * instance members. A bare type-name receiver restricts lookup to the static-equivalent
 * scope exactly when this holds; otherwise every member must stay reachable.
 */
export function supportsStaticMemberScope(languageId: string): boolean {
  return (
    STATIC_MEMBER_LANGUAGES[languageId] !== undefined || STATIC_EQUIVALENT_MEMBER_CONTAINERS[languageId] !== undefined
  );
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
  type_alias_declaration: true,
  // C/C++ unions declare members exactly like structs (tree-sitter-cpp captures
  // union names and classifies them as classes).
  union_specifier: true,
};

const CPP_MEMBER_CONTAINER_TYPES: Record<string, true> = {
  class_specifier: true,
  struct_specifier: true,
  union_specifier: true,
};

/**
 * Container nodes whose declared members belong to the *enclosing* member container for
 * direct-member lookup, rather than forming a separate nested type. Kotlin's unnamed
 * `companion object { ... }` block is the language's static-member mechanism: `create()`
 * declared inside one is a member of the enclosing class, reachable as `Outer.create()`,
 * not a member of a distinct "Companion" type the indexer would need to name separately.
 */
export const TRANSPARENT_MEMBER_CONTAINER_TYPES: Record<string, true> = {
  companion_object: true,
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
  // C/C++ local variable statement (`Box b;`, `Box* p = raw;`); the declared type sits
  // beside the declarator, unlike other grammars' dedicated `variable_declaration` node.
  declaration: true,
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
  // C/C++ local variable statement, e.g. `Box b;`, `Box* p = raw;`, `Box w{5};`.
  "declaration",
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
  rust: { capitalizedCall: true, rustUnitStruct: true, compositeLiteral: true },
  swift: { capitalizedCall: true },
  ts: { newExpression: true },
  tsx: { newExpression: true },
  zig: { compositeLiteral: true },
};

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

/** The graph matcher keeps its existing explicit-argument range shape. */
export type MemberArityRange = { min: number; max: number | null };

export type ReceiverBinding =
  | { kind: "own-type"; memberScope: ReceiverMemberScope }
  | { kind: "supertype"; memberScope: ReceiverMemberScope }
  | { kind: "module-import"; receiver: SyntaxNodeLike }
  | { kind: "unknown"; receiver: SyntaxNodeLike }
  | {
      kind: "named-type";
      proof: "constructor" | "declared-type" | "static-type";
      typeName: string;
      /** Syntax proving the type, including imported qualified types. */
      typeNode: SyntaxNodeLike;
      memberScope: ReceiverMemberScope;
      constructed?: boolean;
    };

/** What one receiver expression proves, memoized per enclosing function and text. */
export type ReceiverProof = {
  /** A constructor or declared type from a binding visible at this receiver. */
  typeEvidence: ReceiverTypeEvidence | null;
  /** Whether an enclosing scope binds the receiver name as a value. */
  locallyBound: boolean;
};

type ReceiverTypeEvidence = { typeNode: SyntaxNodeLike; origin: "constructor" | "declared-type" };
type BindingProof =
  | { status: "none" }
  | { status: "unproven" }
  | { status: "type"; node: SyntaxNodeLike }
  /** A TypeScript type annotation: every later assignment must conform to it. */
  | { status: "declared"; node: SyntaxNodeLike };

/**
 * Identifier a binding node declares: a `name` or `pattern` field, a nested C/C++
 * declarator, an assignment left-hand side, or the last identifier child (C++
 * parameters hide the name after the type). Rust spells parameter and `let` names in
 * the `pattern` field, where the last-identifier fallback would pick the declared type.
 */
function bindingIdentifier(node: SyntaxNodeLike, sup: LanguageSupport): SyntaxNodeLike | null {
  const named = node.childForFieldName("name") ?? node.childForFieldName("pattern");
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
  // A dedicated `type` field (C#'s `object_creation_expression`, C/C++'s `new_expression`) can
  // wrap a qualified (`Outer.Inner`) or generic (`Box<int>`) shape the fallback scan below never
  // matches; a language without that field (TS/PHP's `constructor` field, or none) falls through.
  const typeField = node.childForFieldName("type");
  if (typeField) {
    if (isMemberAccessNode(sup, typeField)) return typeField;
    const unwrapped = unwrapNamedType(typeField, sup);
    if (unwrapped) return unwrapped;
  }
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

const PHP_OBJECT_CREATION_KEYWORDS: Record<string, "self" | "static" | "parent"> = {
  self: "self",
  static: "static",
  parent: "parent",
};

/** `new self()`, `new static()`, or `new parent()`, or null when `node` is not that keyword. */
export type PhpObjectCreationKeyword = {
  keyword: "self" | "static" | "parent";
  nameNode: SyntaxNodeLike;
  /** Enclosing class, or null when the keyword is outside a class declaration. */
  classNode: SyntaxNodeLike | null;
};

export function phpObjectCreationKeyword(
  node: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
): PhpObjectCreationKeyword | null {
  if (sup.id !== "php") return null;
  let creation: SyntaxNodeLike | null = node;
  while (creation && creation.type !== "object_creation_expression") {
    if (
      creation.type === "method_declaration" ||
      creation.type === "function_definition" ||
      creation.type === "class_declaration"
    ) {
      return null;
    }
    creation = creation.parent;
  }
  if (!creation) return null;
  const nameNode = constructorNameNode(creation, sup);
  if (!nameNode) return null;
  const onName = node === creation || (node.startIndex >= nameNode.startIndex && node.endIndex <= nameNode.endIndex);
  if (!onName) return null;
  const keyword = PHP_OBJECT_CREATION_KEYWORDS[foldPhpIdentifierCase(sliceText(nameNode, source))];
  if (!keyword) return null;
  const container = nearestMemberContainer(creation);
  const classNode = container?.type === "class_declaration" ? container : null;
  return { keyword, nameNode, classNode };
}

/** Members-declaring symbol whose name node is this container's name, when that match is unique. */
export function memberContainerDef(mod: ModuleIndex, container: SyntaxNodeLike): SymbolDef | null {
  const nameNode = container.childForFieldName("name");
  if (!nameNode) return null;
  const matches = mod.locals.filter(
    (local) => declaresMembers(local) && local.range.start.index === nameNode.startIndex,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function rubyNewReceiverNameNode(node: SyntaxNodeLike, source: string, sup: LanguageSupport): SyntaxNodeLike | null {
  if (!new RegExp(String.raw`^(?:${RUBY_CONSTANT_SOURCE})\.new$`, "u").test(sliceText(node, source))) return null;
  return node.namedChildren.find((child) => isReceiverNameNode(sup, child.type) || child.type === "constant") ?? null;
}

const NULLISH_TYPE_TEXT = new Set(["undefined", "null", "void"]);

/**
 * The `typeof import("spec")` type query a TypeScript annotation names, ignoring `| undefined` and
 * `| null`: such a binding holds the module namespace of `spec`.
 */
export function typescriptImportTypeQuery(annotation: SyntaxNodeLike): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = annotation;
  while (current?.type === "type_annotation") current = current.namedChildren[0] ?? null;
  if (current?.type === "union_type") {
    const members: SyntaxNodeLike[] = current.namedChildren.filter(
      (member) => !NULLISH_TYPE_TEXT.has(member.text.trim()),
    );
    current = members.length === 1 ? members[0]! : null;
  }
  if (current?.type !== "type_query") return null;
  const call = current.namedChildren[0];
  return call?.type === "call_expression" && call.childForFieldName("function")?.type === "import" ? current : null;
}

/** The module specifier of a `typeof import("spec")` type query. */
export function importTypeQuerySpecifier(typeQuery: SyntaxNodeLike): string | null {
  const argument = typeQuery.namedChildren[0]?.childForFieldName("arguments")?.namedChildren[0];
  if (argument?.type !== "string") return null;
  return argument.namedChildren.find((child) => child.type === "string_fragment")?.text ?? null;
}

export function unwrapNamedType(node: SyntaxNodeLike, sup: LanguageSupport): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (current.type === "union_type") {
      // `Store | undefined` and `Store | null` still prove `Store` for a member call.
      const members: SyntaxNodeLike[] = current.namedChildren.filter(
        (member) => !NULLISH_TYPE_TEXT.has(member.text.trim()),
      );
      current = members.length === 1 ? members[0]! : null;
      continue;
    }
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
    if (current.type === "qualified_name") {
      // C#'s `Outer.Inner` names the nested type by its last segment. PHP also parses a
      // namespaced name as `qualified_name`, but as one flat token with no `name` field, so an
      // absent field leaves `current` as that whole node instead of nulling the result out.
      const segment = current.childForFieldName("name");
      if (!segment) break;
      current = segment;
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

/**
 * Kotlin extension-function receiver type, e.g. `Widget` in `fun Widget.describe(): String`.
 * The receiver type is an unfielded `user_type` positioned before the function's own `name`;
 * an ordinary function or class member declares no such node.
 */
export function kotlinExtensionReceiverTypeNode(node: SyntaxNodeLike, sup: LanguageSupport): SyntaxNodeLike | null {
  if (node.type !== "function_declaration") return null;
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  const receiverType = node.namedChildren.find(
    (child) => child.startIndex < nameNode.startIndex && (child.type === "user_type" || child.type === "nullable_type"),
  );
  return receiverType ? unwrapNamedType(receiverType, sup) : null;
}

/**
 * Self-type name node of a Rust `impl` block: `Circle` in `impl Circle`, `impl Shape for
 * Circle`, `impl<T> Box<T>`, or `impl Shape for &Circle`. The `type` field always names the
 * self type (the `trait` field names the implemented trait), and `unwrapNamedType` strips
 * generic and reference wrappers down to the base type identifier. Shared by member
 * ownership in the detailed graph and receiver-member navigation so both attribute an
 * impl method to the same owner.
 */
export function rustImplSelfTypeNode(implItem: SyntaxNodeLike, sup: LanguageSupport): SyntaxNodeLike | null {
  if (implItem.type !== "impl_item") return null;
  const typeNode = implItem.childForFieldName("type");
  return typeNode ? unwrapNamedType(typeNode, sup) : null;
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
  // tree-sitter-go composite_literal, tree-sitter-zig struct_initializer, tree-sitter-rust
  // struct_expression: `Type { field: value }` / `Type{ .field = value }`.
  if (
    current.type !== "composite_literal" &&
    current.type !== "struct_initializer" &&
    current.type !== "struct_expression"
  ) {
    return null;
  }
  const typeNode =
    current.childForFieldName("type") ??
    current.namedChildren.find(
      (child) =>
        child.type === "type_identifier" ||
        child.type === "identifier" ||
        child.type === sup.nodeTypes.memberExpression,
    ) ??
    null;
  // A qualified literal type (Zig `ns.Struct{...}`) has no dedicated `type` field and is not a
  // simple named type either; `unwrapNamedType` rejects it, so the member-access node itself is
  // kept so the caller can resolve it the same way as any other qualified expression.
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
  if (typeField) return unwrapNamedType(typeField, sup) ?? typeField;
  const typedChild = node.namedChildren.find(
    (child) =>
      child.type === "named_type" ||
      child.type === "user_type" ||
      child.type === "type_annotation" ||
      child.type === "type",
  );
  if (typedChild) return unwrapNamedType(typedChild, sup) ?? typedChild;
  if (node.type === "let_declaration") return null;
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
  const annotation = isJsTsLanguage(sup.id) ? node.childForFieldName("type") : null;
  const annotated = annotation ? (unwrapNamedType(annotation, sup) ?? typescriptImportTypeQuery(annotation)) : null;
  if (annotated) return { status: "declared", node: annotated };
  const declared = declaredTypeNameNode(node, sup);
  if (declared) return { status: "declared", node: declared };
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
): ReceiverTypeEvidence | null {
  let typeEvidence: ReceiverTypeEvidence | null = null;
  let sawUnproven = false;
  let declared = false;
  const visit = (current: SyntaxNodeLike): boolean => {
    if (current.startIndex >= receiver.startIndex) return true;
    if (current !== node && isSkippableBindingContainer(current, receiver)) return true;
    const proof = bindingProof(current, receiverName, source, sup);
    if (proof.status === "declared") {
      typeEvidence = { typeNode: proof.node, origin: "declared-type" };
      declared = isJsTsLanguage(sup.id);
      return true;
    }
    // A later assignment to an annotated binding cannot change its declared type.
    if (declared && proof.status !== "none") return true;
    if (proof.status === "unproven") {
      if (typeEvidence) {
        typeEvidence = null;
        return false;
      }
      sawUnproven = true;
      return true;
    }
    if (proof.status === "type") {
      if (sawUnproven) {
        typeEvidence = null;
        return false;
      }
      if (typeEvidence && sliceText(typeEvidence.typeNode, source) !== sliceText(proof.node, source)) {
        typeEvidence = null;
        return false;
      }
      typeEvidence = { typeNode: proof.node, origin: "constructor" };
      return true;
    }
    for (const child of current.namedChildren) {
      if (!visit(child)) return false;
    }
    return true;
  };
  visit(node);
  return typeEvidence;
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
    // A JavaScript/TypeScript assignment updates an existing binding; it declares nothing.
    const declaresNewBinding = !(isJsTsLanguage(sup.id) && current.type === "assignment_expression");
    if (
      declaresNewBinding &&
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
): ReceiverTypeEvidence | null {
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

/** Constructor or declared type visible at a receiver, without resolving its owner. */
function receiverTypeEvidence(obj: SyntaxNodeLike, source: string, sup: LanguageSupport): ReceiverTypeEvidence | null {
  const direct = constructionTypeName(obj, source, sup);
  if (!isReceiverNameNode(sup, obj.type)) return direct ? { typeNode: direct, origin: "constructor" } : null;
  const receiverName = sliceText(obj, source);
  if (direct && !bindsLocalValue(obj, receiverName, source, sup)) {
    return { typeNode: direct, origin: "constructor" };
  }
  return findVisiblePriorConstructor(obj, receiverName, source, sup);
}

/** Syntax naming the type of a constructed or declared receiver. */
export function receiverConstructorExpression(
  obj: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike | null {
  return receiverTypeEvidence(obj, source, sup)?.typeNode ?? null;
}

/** Identifier segments in a C++ qualified name, excluding template arguments. */
export function cppQualifiedNameSegments(node: SyntaxNodeLike, source: string): string[] {
  return cppQualifiedTextSegments(sliceText(node, source));
}

/** `::`-separated segments of a C++ qualified name, ignoring `::` inside template arguments and dropping them. */
export function cppQualifiedTextSegments(text: string): string[] {
  const segments: string[] = [];
  let segmentStart = 0;
  let templateDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "<") {
      templateDepth += 1;
      continue;
    }
    if (char === ">") {
      templateDepth = Math.max(0, templateDepth - 1);
      continue;
    }
    if (char !== ":" || text[index + 1] !== ":" || templateDepth !== 0) continue;
    const segment = text.slice(segmentStart, index).trim();
    if (segment) segments.push(segment.replace(/<.*$/u, "").trim());
    segmentStart = index + 2;
    index += 1;
  }
  const finalSegment = text.slice(segmentStart).trim();
  if (finalSegment) segments.push(finalSegment.replace(/<.*$/u, "").trim());
  return segments.filter(Boolean);
}

/** Exact namespace/type path that qualifies a C++ out-of-line function definition. */
export function cppOutOfLineOwnerPath(node: SyntaxNodeLike, source: string, sup: LanguageSupport): string[] | null {
  if (sup.id !== "cpp") return null;
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (current.type === "function_definition") {
      let declarator = current.childForFieldName("declarator");
      while (declarator) {
        if (declarator.type === "qualified_identifier") {
          const path = cppQualifiedNameSegments(declarator, source);
          path.pop();
          if (!sliceText(declarator, source).trimStart().startsWith("::")) {
            const namespaces: string[][] = [];
            let parent = current.parent;
            while (parent) {
              if (parent.type === "namespace_definition") {
                const name = parent.childForFieldName("name");
                if (name) namespaces.push(cppQualifiedNameSegments(name, source));
              }
              parent = parent.parent;
            }
            for (const namespace of namespaces.reverse()) path.unshift(...namespace);
          }
          return path.length ? path : null;
        }
        const nested = declarator.childForFieldName("declarator") ?? declarator.namedChildren.at(-1);
        if (!nested || nested.id === declarator.id) break;
        declarator = nested;
      }
      return null;
    }
    current = current.parent;
  }
  return null;
}

/** Unqualified member name from a C++ out-of-line function definition. */
export function cppOutOfLineMemberName(node: SyntaxNodeLike, source: string, sup: LanguageSupport): string | null {
  if (sup.id !== "cpp") return null;
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (current.type === "function_definition") {
      const nameNode = cppFunctionDeclaratorName(current, sup);
      return nameNode ? sliceText(nameNode, source) : null;
    }
    current = current.parent;
  }
  return null;
}
function sameSyntaxNode(left: SyntaxNodeLike | null, right: SyntaxNodeLike): boolean {
  if (!left) return false;
  if (left.id !== undefined && right.id !== undefined) return left.id === right.id;
  return left.type === right.type && left.startIndex === right.startIndex && left.endIndex === right.endIndex;
}

function cppFunctionDeclaratorName(node: SyntaxNodeLike, sup: LanguageSupport): SyntaxNodeLike | null {
  const functionDeclarator =
    node.type === "function_declarator" ? node : findFirstNodeByType(node, "function_declarator");
  let current = functionDeclarator?.childForFieldName("declarator") ?? null;
  while (current) {
    if (isIdentifierType(sup, current.type) || current.type === "operator_name" || current.type === "destructor_name") {
      return current;
    }
    let name = current.childForFieldName("name");
    while (name?.childForFieldName("name")) name = name.childForFieldName("name");
    if (
      name &&
      (isIdentifierType(sup, name.type) || name.type === "operator_name" || name.type === "destructor_name")
    ) {
      return name;
    }
    const nested = current.childForFieldName("declarator");
    if (!nested || nested.id === current.id) return null;
    current = nested;
  }
  return null;
}

function cppMemberArityFromAncestor(node: SyntaxNodeLike): number | undefined {
  let current: SyntaxNodeLike | null = node;
  while (current) {
    const arity = declarationMemberArity(current, "cpp");
    if (arity !== undefined) return arity;
    current = current.parent;
  }
  return undefined;
}

function collectCppMemberDeclarations(
  node: SyntaxNodeLike,
  ownerNode: SyntaxNodeLike,
  localName: string,
  ownerSource: string,
  sup: LanguageSupport,
  expectedArity: number | undefined,
  out: Array<{ node: SyntaxNodeLike; nameNode: SyntaxNodeLike }>,
): void {
  if (
    (node.type === "field_declaration" || node.type === "declaration") &&
    sameSyntaxNode(nearestMemberContainer(node), ownerNode)
  ) {
    const nameNode = cppFunctionDeclaratorName(node, sup);
    if (
      nameNode &&
      sup.normalizeIdentifier(sliceText(nameNode, ownerSource)) === sup.normalizeIdentifier(localName) &&
      declarationMemberArity(node, sup.id) === expectedArity
    ) {
      out.push({ node, nameNode });
    }
    return;
  }
  for (const child of node.namedChildren) {
    collectCppMemberDeclarations(child, ownerNode, localName, ownerSource, sup, expectedArity, out);
  }
}

export type CppOutOfLineMemberDeclaration = {
  node: SyntaxNodeLike;
  nameNode: SyntaxNodeLike;
};

/**
 * Finds the unique in-class declaration corresponding to a C++ out-of-line member
 * definition. Name and arity must both match so overloads do not collapse.
 */
export function cppOutOfLineMemberDeclarationNode(
  definitionNameNode: SyntaxNodeLike,
  localName: string,
  ownerNameNode: SyntaxNodeLike,
  ownerSource: string,
  sup: LanguageSupport,
): CppOutOfLineMemberDeclaration | null {
  if (sup.id !== "cpp") return null;
  const ownerNode = nearestMemberContainer(ownerNameNode);
  if (!ownerNode) return null;
  const expectedArity = cppMemberArityFromAncestor(definitionNameNode);
  const declarations: CppOutOfLineMemberDeclaration[] = [];
  collectCppMemberDeclarations(ownerNode, ownerNode, localName, ownerSource, sup, expectedArity, declarations);
  return declarations.length === 1 ? declarations[0]! : null;
}

export function nodeDeclaresStatic(node: SyntaxNodeLike, source: string): boolean {
  if (node.type === "singleton_method") {
    const receiver = node.childForFieldName("object") ?? node.childForFieldName("receiver") ?? node.namedChildren[0];
    return !!receiver && sliceText(receiver, source).trim() === "self";
  }
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

export function nodeInStaticMemberContext(node: SyntaxNodeLike, source: string): boolean {
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
  if (nodeInStaticMemberContext(node, source)) return "static";
  const kind = keywordReceiverKind(sup.id, receiverName);
  if (kind === "supertype") return "instance";
  return ownReceiverMemberScope(sup.id, receiverName) ?? "any";
}

/**
 * The leftmost identifier of a C# chain of plain identifiers joined by `.` (`P` in `P.Inner.Mix`),
 * or `null` when `node` has a call, index, keyword, or type arguments. When that identifier binds
 * nothing, the chain is a namespace-qualified type name.
 */
export function csharpDottedNameRoot(node: SyntaxNodeLike): SyntaxNodeLike | null {
  if (node.type === "identifier") return node;
  if (node.type !== "member_access_expression") return null;
  const object = node.childForFieldName("expression");
  if (!object || node.childForFieldName("name")?.type !== "identifier") return null;
  return csharpDottedNameRoot(object);
}

/** Classify a receiver from syntax and consumer-proven import bindings. */
export function classifyReceiver(
  sup: LanguageSupport,
  receiver: SyntaxNodeLike,
  source: string,
  proofCache: Map<string, ReceiverProof> | null,
  cacheScope: number,
  accessNode: SyntaxNodeLike,
  hasLexicalBinding: (callee: SyntaxNodeLike) => boolean,
  classifyImport?: (name: string, node: SyntaxNodeLike) => "module-import" | "static-type" | null,
): ReceiverBinding {
  const text = receiverKeywordText(sup, receiver, source, hasLexicalBinding);
  if (!text) return { kind: "unknown", receiver };
  const keywordKind = keywordReceiverKind(sup.id, text);
  if (keywordKind) {
    if (keywordReceiverCrossesDynamicBoundary(sup, accessNode)) return { kind: "unknown", receiver };
    const memberScope = keywordReceiverMemberScope(sup, text, accessNode, source);
    return keywordKind === "own" ? { kind: "own-type", memberScope } : { kind: "supertype", memberScope };
  }
  const receiverIsName = isReceiverNameNode(sup, receiver.type);
  const importProof = receiverIsName ? classifyImport?.(text, receiver) : null;
  if (importProof === "module-import") return { kind: "module-import", receiver };
  const cacheKey = proofCache ? cacheScope + "\u0000" + text : "";
  let proof = proofCache?.get(cacheKey);
  if (!proof) {
    const typeEvidence = receiverTypeEvidence(receiver, source, sup);
    proof = {
      typeEvidence,
      locallyBound: !typeEvidence && receiverIsName && bindsLocalValue(receiver, text, source, sup),
    };
    proofCache?.set(cacheKey, proof);
  }
  if (proof.typeEvidence) {
    const { typeNode, origin } = proof.typeEvidence;
    return {
      kind: "named-type",
      proof: origin,
      typeName: sliceText(typeNode, source),
      typeNode,
      memberScope: hasStaticMemberDistinction(sup.id) ? "instance" : "any",
      constructed: origin === "constructor",
    };
  }
  if (importProof === "static-type") {
    return { kind: "named-type", proof: "static-type", typeName: text, typeNode: receiver, memberScope: "static" };
  }
  if (!receiverIsName || proof.locallyBound) return { kind: "unknown", receiver };
  // Dotted `Cfg.load()` is not proof in languages where the identifier may be a
  // value. Type-scoped `::` is one named-type proof; C# `Box.Left()` is another
  // because a capitalized unbound name is the static type receiver. Ruby
  // capitalized names are `constant` tokens even when they name a parameter, so
  // `constant` is not itself type proof.
  const property = getMemberAccessParts(sup, accessNode).property;
  const between = property ? source.slice(receiver.endIndex, property.startIndex) : "";
  const typeScoped = TYPE_SCOPED_ACCESS_TYPES[accessNode.type] === true || between.includes("::");
  if (receiver.type !== "type_identifier" && !typeScoped) {
    // A capitalized bare name is type proof where construction already types
    // `Box()` as a Box, and for static type-name receivers (`Box.Left()`).
    // The named type must still resolve to a members-declaring definition
    // before any call edge is recorded, so a name alone never invents a target.
    if (!capitalizedTypeReceiverName(sup, receiver, text)) return { kind: "unknown", receiver };
    return {
      kind: "named-type",
      proof: "static-type",
      typeName: text,
      typeNode: receiver,
      memberScope: UNBOUND_INSTANCE_CALL_LANGUAGE_IDS[sup.id] ? "any" : "static",
    };
  }
  return {
    kind: "named-type",
    proof: "static-type",
    typeName: text,
    typeNode: receiver,
    memberScope: hasStaticMemberDistinction(sup.id) && typeScoped ? "static" : "any",
  };
}

/**
 * Languages whose runtime allows an instance member to be invoked through a type
 * name (`Box.instanceMethod(args)` is a real unbound call), so a type-named
 * receiver restricts nothing about static versus instance members.
 */
const UNBOUND_INSTANCE_CALL_LANGUAGE_IDS: Record<string, true> = {
  python: true,
};

/**
 * Languages whose dotted type-name receivers (`Box.Left()`) name the type itself.
 * Distinct from `capitalizedCall`, which also treats `Box()` as construction.
 */
const STATIC_TYPE_NAME_RECEIVER_LANGUAGE_IDS: Record<string, true> = {
  csharp: true,
  java: true,
  js: true,
  kotlin: true,
  ts: true,
  ruby: true,
  tsx: true,
};

/** Whether a receiver name is capitalized like a type in a capitalized-name language. */
function capitalizedTypeReceiverName(sup: LanguageSupport, receiver: SyntaxNodeLike, text: string): boolean {
  if (
    LANGUAGE_CONSTRUCTION_FORMS[sup.id]?.capitalizedCall !== true &&
    !STATIC_TYPE_NAME_RECEIVER_LANGUAGE_IDS[sup.id]
  ) {
    return false;
  }
  if (!isReceiverNameNode(sup, receiver.type)) return false;
  const first = text[0];
  return !!first && first === first.toUpperCase() && first !== first.toLowerCase();
}

/** Whether a resolved definition can declare callable members. */
export function declaresMembers(def: SymbolDef): boolean {
  return def.kind === SymbolKind.Class || def.kind === SymbolKind.Interface || def.kind === SymbolKind.TypeAlias;
}

/** Whether a C++ definition denotes a class, struct, or union that can own methods. */
export function isCppMemberContainerDefinition(tree: SyntaxTreeLike, def: SymbolDef): boolean {
  const position = {
    row: Math.max(0, def.range.start.line - 1),
    column: Math.max(0, def.range.start.column - 1),
  };
  const nameNode = tree.rootNode.descendantForPosition(position, position);
  const container = nearestMemberContainer(nameNode);
  if (!container || CPP_MEMBER_CONTAINER_TYPES[container.type] === undefined) return false;
  const containerName = container.childForFieldName("name");
  return containerName?.startPosition.row === position.row && containerName.startPosition.column === position.column;
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
  nodeAliases: ReadonlyMap<string, string> = new Map(),
  memberArities: ReadonlyMap<string, MemberArityRange> = new Map(),
  ownerAnchors: ReadonlyMap<string, string> = new Map(),
  accessibleMembers: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  fileHiddenMemberIds: ReadonlySet<string> = new Set(),
  acceptsCallTarget?: (targetId: string, candidate: ReceiverCallCandidate) => boolean,
  callableIdentities: ReadonlyMap<string, import("../../languages/callable-arity.js").CallableIdentity> = new Map(),
): SymbolGraph["edges"][number][] {
  if (!candidates.length) return [];

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
  // Receiver-local access does not change the nominal type's membership edges.
  for (const [ownerId, memberIds] of accessibleMembers) {
    for (const memberId of memberIds) pushUnique(membersByOwner, ownerId, memberId);
  }

  let activeCandidate: ReceiverCallCandidate;
  const facts = new Map<string, import("../../languages/callable-arity.js").CallableIdentity>();
  for (const [ownerId, ids] of membersByOwner) {
    for (const id of ids) {
      const canonicalId = canonicalMemberId(id, nodeAliases);
      const indexed = callableIdentities.get(id) ?? callableIdentities.get(canonicalId);
      const bounds = memberArities.get(id) ?? memberArities.get(canonicalId);
      facts.set(id, {
        key: indexed?.key ?? canonicalId,
        owner: indexed?.owner ?? ownerId,
        kind: indexed?.kind ?? "function",
        arity: bounds ? { minArgs: bounds.min, maxArgs: bounds.max } : null,
        ...(indexed?.role ? { role: indexed.role } : {}),
      });
    }
  }
  const model: MemberModel<string, string> = {
    ownerKey: (id) => id,
    members: (id) => membersByOwner.get(id) ?? [],
    supertypes: (id, classOnly) => {
      if (!classOnly) return supertypesByOwner.get(id) ?? [];
      return (classAncestorsByOwner.get(id) ?? []).filter((base) => graph.nodes.get(base)?.kind === "class");
    },
    name: (id) => graph.nodes.get(id)?.name ?? graph.nodes.get(canonicalMemberId(id, nodeAliases))?.name ?? "",
    key: (id) => facts.get(id)?.key ?? canonicalMemberId(id, nodeAliases),
    callable: (id) => facts.get(id),
    scope: (id) => memberScopes.get(id) ?? memberScopes.get(canonicalMemberId(id, nodeAliases)) ?? "any",
    visible: (id, useFile) => {
      const canonicalId = canonicalMemberId(id, nodeAliases);
      const node = graph.nodes.get(id) ?? graph.nodes.get(canonicalId);
      if (!node || (node.kind !== "function" && !node.callable)) return false;
      if (
        (fileHiddenMemberIds.has(id) || fileHiddenMemberIds.has(canonicalId)) &&
        fileIdentityKey(node.file) !== fileIdentityKey(useFile)
      )
        return false;
      return (
        !activeCandidate.goPackagePeerFiles ||
        isGoExportedMemberName("go", node.name) ||
        activeCandidate.goPackagePeerFiles.has(node.file)
      );
    },
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
    const rawOwner = candidate.ownerId ?? ownerByMember.get(candidate.callerId);
    if (!rawOwner) continue;
    // Shared-owner anchors redirect Swift extension and C# partial owners to the
    // coalesced type identity so lookup starts on the whole member set.
    const owner = ownerAnchors.get(rawOwner) ?? rawOwner;
    const memberScope = candidate.memberScope ?? inferCallMemberScope(candidate.site, sourceCache);
    activeCandidate = candidate;
    const lookup = selectMember([owner], model, {
      name: candidate.memberName,
      argumentCount: candidate.argumentCount,
      scope: memberScope,
      useFile: candidate.site.file,
      phpCaseInsensitive: !!candidate.caseInsensitiveMemberName,
      startAtAncestor: candidate.viaSupertypes,
    });
    let receiverDisposition: "none" | "resolved" | "ambiguous" =
      lookup.status === "unique" ? "resolved" : lookup.status;
    if (lookup.status === "unique") {
      const memberId = canonicalMemberId(lookup.member, nodeAliases);
      if (acceptsCallTarget && !acceptsCallTarget(memberId, candidate)) {
        receiverDisposition = "ambiguous";
        if (existingTargets.size) rejectedCallSites.add(siteKey);
      } else {
        receiverDisposition = "resolved";
        const combinedTargets = new Set(existingTargets);
        combinedTargets.add(memberId);
        if (combinedTargets.size === 1) {
          if (!existingTargets.size && recordEdge(candidate.callerId, memberId, "calls", candidate.site)) {
            existingTargets.add(memberId);
            callTargetsBySite.set(siteKey, existingTargets);
          }
        } else rejectedCallSites.add(siteKey);
      }
    } else if (lookup.status === "ambiguous" && existingTargets.size) {
      rejectedCallSites.add(siteKey);
    }
    if (receiverDisposition === "none") {
      if (candidate.fallbackTargetId && !existingTargets.size) {
        recordEdge(candidate.callerId, candidate.fallbackTargetId, "calls", candidate.site);
      } else if (existingTargets.size) {
        rejectedCallSites.add(siteKey);
      }
    }
  }
  const removed: SymbolGraph["edges"][number][] = [];
  if (rejectedCallSites.size) {
    let writeIndex = 0;
    for (const edge of graph.edges) {
      if (edge.label === "calls" && edge.site && rejectedCallSites.has(callSiteKey(edge.from, edge.site))) {
        removed.push(edge);
        continue;
      }
      graph.edges[writeIndex] = edge;
      writeIndex += 1;
    }
    graph.edges.length = writeIndex;
  }
  return removed;
}

function canonicalMemberId(id: string, aliases: ReadonlyMap<string, string>): string {
  let current = id;
  const seen = new Set<string>();
  while (aliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = aliases.get(current)!;
  }
  return current;
}
