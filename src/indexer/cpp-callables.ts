import { declarationMemberArity, isVariadicParameterMarker } from "../graphs/symbol-graph-detailed/ast.js";
import { callArgumentCount } from "../graphs/symbol-graph-detailed/receiver-calls.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import type { Binding } from "./scope-types.js";

export type CppCallableShape = {
  signature: string;
  minArity: number;
  maxArity: number | null;
};

type CppCallableEntity = {
  bindings: Binding[];
  minArity: number;
  maxArity: number | null;
};

function functionDeclarator(node: SyntaxNodeLike | null): SyntaxNodeLike | null {
  let current = node;
  while (current) {
    if (current.type === "function_declarator") return current;
    if (current.type === "program") return null;
    current = current.parent;
  }
  return null;
}

function parameterName(parameter: SyntaxNodeLike): SyntaxNodeLike | null {
  let current = parameter.childForFieldName("declarator");
  while (current) {
    if (current.type === "identifier" || current.type === "field_identifier") return current;
    const nested = current.childForFieldName("name") ?? current.childForFieldName("declarator");
    if (nested) {
      current = nested;
    } else if (
      current.type === "reference_declarator" ||
      current.type === "parenthesized_declarator" ||
      current.type === "variadic_declarator"
    ) {
      current = current.namedChildren.find((child) => child.type !== "comment") ?? null;
    } else {
      return null;
    }
  }
  return null;
}

function nodeSpanKey(node: SyntaxNodeLike): string {
  return `${node.startIndex}:${node.endIndex}`;
}

function sameSpan(left: SyntaxNodeLike, right: SyntaxNodeLike): boolean {
  return left.startIndex === right.startIndex && left.endIndex === right.endIndex;
}

/**
 * Leaf tokens for one node, skipping comments and omitted spans. Used for type
 * specifiers, array extents, trailing function specifiers, and declarator forms
 * the structured walker does not model. Parameter names and default values never
 * contribute because collectOmittedParameterSpans marks their spans first.
 */
function appendLeafTokens(node: SyntaxNodeLike, omittedSpans: Set<string>, tokens: string[]): void {
  if (node.type === "comment" || omittedSpans.has(nodeSpanKey(node))) return;
  // Leaf tokens keep unmodeled punctuation such as qualifiers distinct, while
  // omitted name spans make named and abstract declarators equivalent.
  if (!node.child(0)) {
    tokens.push(node.text);
    return;
  }
  for (let index = 0; ; index += 1) {
    const child = node.child(index);
    if (!child) break;
    appendLeafTokens(child, omittedSpans, tokens);
  }
}

const PARAMETER_DECLARATION_TYPES: Record<string, true> = {
  parameter_declaration: true,
  optional_parameter_declaration: true,
  variadic_parameter_declaration: true,
};

const TOP_LEVEL_CV_QUALIFIER_TEXTS: Record<string, true> = {
  const: true,
  volatile: true,
};

/**
 * Type-specifier kinds that can never denote an array alias, so a qualifier on
 * them is provably top-level when no declarator operator follows. Aliased types
 * may name an array typedef, which would turn a leading const into a pointee
 * qualifier after the array-to-pointer adjustment; those keep their qualifiers
 * because alias expansion is out of scope.
 */
const PROVABLY_NON_ARRAY_TYPE_KINDS: Record<string, true> = {
  primitive_type: true,
  sized_type_specifier: true,
  struct_specifier: true,
  enum_specifier: true,
  union_specifier: true,
  class_specifier: true,
};

const DECLARATOR_OPERATOR_TYPES: Record<string, true> = {
  pointer_declarator: true,
  abstract_pointer_declarator: true,
  reference_declarator: true,
  abstract_reference_declarator: true,
  array_declarator: true,
  abstract_array_declarator: true,
  function_declarator: true,
  abstract_function_declarator: true,
};

/** Grouping only: parentheses and parameter packs do not construct type. */
const TRANSPARENT_DECLARATOR_TYPES: Record<string, true> = {
  parenthesized_declarator: true,
  abstract_parenthesized_declarator: true,
  variadic_declarator: true,
};

const DECLARATOR_CORE_TYPES: Record<string, true> = {
  identifier: true,
  field_identifier: true,
  type_identifier: true,
  destructor_name: true,
  operator_name: true,
  template_function: true,
};

/** Inner declarator of a declarator-chain node, or null at the declared name. */
function declaratorInner(node: SyntaxNodeLike): SyntaxNodeLike | null {
  if (
    node.type === "parenthesized_declarator" ||
    node.type === "abstract_parenthesized_declarator" ||
    node.type === "variadic_declarator"
  ) {
    return node.namedChildren.find((child) => child.type !== "comment") ?? null;
  }
  return node.childForFieldName("declarator");
}

type DeclaratorScan = {
  /** Deepest type constructor, the top of the adjusted parameter type. */
  topOperator: SyntaxNodeLike | null;
  /** False when an unmodeled declarator form hides the type structure. */
  modeled: boolean;
};

/**
 * Walks a declarator chain from its root toward the declared name. Operators
 * wrap the accumulated type, so the deepest operator is the top of the
 * parameter type; its qualifiers are the only declarator qualifiers that can be
 * top-level. Any unmodeled declarator form hides the structure and vetoes both
 * the top operator and qualifier dropping.
 */
function scanDeclaratorChain(declarator: SyntaxNodeLike): DeclaratorScan {
  let topOperator: SyntaxNodeLike | null = null;
  let current: SyntaxNodeLike | null = declarator;
  while (current) {
    if (DECLARATOR_OPERATOR_TYPES[current.type]) {
      topOperator = current;
    } else if (!TRANSPARENT_DECLARATOR_TYPES[current.type] && !DECLARATOR_CORE_TYPES[current.type]) {
      return { topOperator: null, modeled: false };
    }
    const inner = declaratorInner(current);
    if (!inner) break;
    current = inner;
  }
  return { topOperator, modeled: true };
}

/** Parameter names and default values at any nesting depth never become tokens. */
function collectOmittedParameterSpans(node: SyntaxNodeLike, omittedSpans: Set<string>): void {
  if (PARAMETER_DECLARATION_TYPES[node.type]) {
    const name = parameterName(node);
    if (name) omittedSpans.add(nodeSpanKey(name));
    const defaultValue = node.childForFieldName("default_value");
    if (defaultValue) {
      omittedSpans.add(nodeSpanKey(defaultValue));
      for (let index = 0; ; index += 1) {
        const child = node.child(index);
        if (!child) break;
        if (child.type === "=") omittedSpans.add(nodeSpanKey(child));
      }
    }
  }
  for (let index = 0; ; index += 1) {
    const child = node.child(index);
    if (!child) break;
    collectOmittedParameterSpans(child, omittedSpans);
  }
}

function appendDeclaratorQualifierTokens(
  node: SyntaxNodeLike,
  dropTopLevelCv: boolean,
  omittedSpans: Set<string>,
  tokens: string[],
): void {
  for (let index = 0; ; index += 1) {
    const child = node.child(index);
    if (!child) break;
    if (child.type !== "type_qualifier") continue;
    if (dropTopLevelCv && TOP_LEVEL_CV_QUALIFIER_TEXTS[child.text]) continue;
    appendLeafTokens(child, omittedSpans, tokens);
  }
}

function referencePunctuator(node: SyntaxNodeLike): string {
  for (let index = 0; ; index += 1) {
    const child = node.child(index);
    if (!child) break;
    if (child.type === "&" || child.type === "&&") return child.text;
  }
  return "&";
}

/** Bracket contents of a retained array dimension: qualifiers and the extent. */
function appendArrayExtentTokens(node: SyntaxNodeLike, omittedSpans: Set<string>, tokens: string[]): void {
  const declarator = node.childForFieldName("declarator");
  for (let index = 0; ; index += 1) {
    const child = node.child(index);
    if (!child) break;
    if (child.type === "[" || child.type === "]") continue;
    if (declarator && sameSpan(child, declarator)) continue;
    appendLeafTokens(child, omittedSpans, tokens);
  }
}

function appendParameterListTokens(node: SyntaxNodeLike, omittedSpans: Set<string>, tokens: string[]): void {
  const parameters = node.childForFieldName("parameters");
  if (!parameters) return;
  // `(void)` is the C/C++ zero-parameter spelling. A variadic parameter list is not empty, so it
  // keeps its pack/ellipsis tokens instead of collapsing to `()`.
  if (declarationMemberArity(node, "cpp") === 0 && !parameterListIsVariadic(parameters)) {
    tokens.push("(", ")");
    return;
  }
  for (let index = 0; ; index += 1) {
    const child = parameters.child(index);
    if (!child) break;
    if (child.type === "comment") continue;
    if (child.type === ",") {
      tokens.push(",");
      continue;
    }
    if (PARAMETER_DECLARATION_TYPES[child.type]) {
      appendParameterTokens(child, tokens);
      continue;
    }
    appendLeafTokens(child, omittedSpans, tokens);
  }
}

/** Exception specifications such as noexcept that trail one function type. */
function appendTrailingFunctionTokens(node: SyntaxNodeLike, omittedSpans: Set<string>, tokens: string[]): void {
  const declarator = node.childForFieldName("declarator");
  const parameters = node.childForFieldName("parameters");
  for (let index = 0; ; index += 1) {
    const child = node.child(index);
    if (!child) break;
    if (child.type === "(" || child.type === ")") continue;
    if (declarator && sameSpan(child, declarator)) continue;
    if (parameters && sameSpan(child, parameters)) continue;
    appendLeafTokens(child, omittedSpans, tokens);
  }
}

/**
 * Emits one declarator chain root-first: each operator wraps the accumulated
 * type, so root-first order is the canonical constructor order and equivalent
 * spellings such as `T p[][3]` and `T (*p)[3]` produce the same sequence.
 */
function appendAdjustedDeclaratorTokens(
  node: SyntaxNodeLike,
  scan: DeclaratorScan,
  omittedSpans: Set<string>,
  tokens: string[],
): void {
  if (TRANSPARENT_DECLARATOR_TYPES[node.type]) {
    if (node.type === "variadic_declarator") tokens.push("...");
    const inner = declaratorInner(node);
    if (inner) appendAdjustedDeclaratorTokens(inner, scan, omittedSpans, tokens);
    return;
  }
  if (!DECLARATOR_OPERATOR_TYPES[node.type]) {
    // Unmodeled or core declarator form: leaf tokens keep distinct types distinct.
    appendLeafTokens(node, omittedSpans, tokens);
    return;
  }
  switch (node.type) {
    case "pointer_declarator":
    case "abstract_pointer_declarator": {
      tokens.push("*");
      // Qualifiers on the top pointer are top-level cv and dropped; deeper
      // pointers keep theirs because they qualify a pointee.
      appendDeclaratorQualifierTokens(node, scan.topOperator === node, omittedSpans, tokens);
      break;
    }
    case "reference_declarator":
    case "abstract_reference_declarator": {
      // & and && share the node type; the punctuator text keeps them distinct.
      tokens.push(referencePunctuator(node));
      break;
    }
    case "array_declarator":
    case "abstract_array_declarator": {
      if (scan.topOperator === node) {
        // Parameter array-to-pointer adjustment: the outermost extent is not
        // part of the adjusted pointer type; inner extents stay.
        tokens.push("*");
      } else {
        tokens.push("[");
        appendArrayExtentTokens(node, omittedSpans, tokens);
        tokens.push("]");
      }
      break;
    }
    case "function_declarator":
    case "abstract_function_declarator": {
      tokens.push("(");
      appendParameterListTokens(node, omittedSpans, tokens);
      tokens.push(")");
      appendTrailingFunctionTokens(node, omittedSpans, tokens);
      if (scan.topOperator === node) {
        // Parameter function-to-pointer adjustment.
        tokens.push("*");
      }
      break;
    }
  }
  const inner = declaratorInner(node);
  if (inner) appendAdjustedDeclaratorTokens(inner, scan, omittedSpans, tokens);
}

/**
 * Normalized fingerprint tokens for one parameter declaration.
 *
 * Language-defined adjustments only; no alias resolution and no general type
 * equivalence:
 * - array-to-pointer: the outermost array dimension of a parameter becomes a
 *   pointer, so `T p[]`, `T p[N]`, and `T* p` share one identity. Likewise,
 *   `T p[][3]` equals `T (*p)[3]`, but differs from `T* p` or `T p[][4]`;
 * - function-to-pointer: `T f(P)` and `T (*f)(P)` share one identity;
 * - top-level const/volatile is dropped for provably scalar base types with no
 *   declarator operator (`const int p` equals `int p`) and for the top pointer
 *   (`int* const p` equals `int* p`). Qualifiers that would land on a pointee,
 *   referent, element, or return type stay, and aliased base types keep their
 *   qualifiers because an array typedef cannot be ruled out syntactically.
 * References, pointee qualification, member-pointer forms, unmodeled
 * declarators, and trailing member cv/ref suffixes (handled by the shape's
 * suffix tokens) are preserved as distinct.
 */
function appendParameterTokens(parameter: SyntaxNodeLike, tokens: string[]): void {
  const omittedSpans = new Set<string>();
  collectOmittedParameterSpans(parameter, omittedSpans);
  const declarator = parameter.childForFieldName("declarator");
  const scan = declarator ? scanDeclaratorChain(declarator) : { topOperator: null, modeled: true };

  const typeNode = parameter.childForFieldName("type");
  const dropTypeQualifiers =
    !scan.topOperator && scan.modeled && !!typeNode && PROVABLY_NON_ARRAY_TYPE_KINDS[typeNode.type];
  for (let index = 0; ; index += 1) {
    const child = parameter.child(index);
    if (!child) break;
    if (child.type === "comment") continue;
    if (declarator && sameSpan(child, declarator)) continue;
    if (child.type === "type_qualifier" && TOP_LEVEL_CV_QUALIFIER_TEXTS[child.text] && dropTypeQualifiers) {
      continue;
    }
    appendLeafTokens(child, omittedSpans, tokens);
  }
  if (declarator) appendAdjustedDeclaratorTokens(declarator, scan, omittedSpans, tokens);
}

function parameterFingerprint(parameter: SyntaxNodeLike): string {
  const tokens: string[] = [];
  appendParameterTokens(parameter, tokens);
  return JSON.stringify(tokens);
}

function parameterListIsVariadic(parameters: SyntaxNodeLike): boolean {
  for (let index = 0; ; index += 1) {
    const child = parameters.child(index);
    if (!child) return false;
    if (child.type === "..." || child.type.includes("variadic_parameter")) return true;
  }
}

export function cppCallableShapeForNode(node: SyntaxNodeLike): CppCallableShape | null {
  const declarator = functionDeclarator(node);
  const parameters = declarator?.childForFieldName("parameters");
  if (!declarator || !parameters) return null;
  const arity = declarationMemberArity(declarator, "cpp");
  if (arity === undefined) return null;
  let parameterNodes = parameters.namedChildren.filter((child) => child.type !== "comment");
  // A `(void)` parameter list is the C/C++ zero-parameter spelling and shares identity with `()`.
  // C++ variadic markers are not zero parameters: a pack `Args... rest` (arity 0 when it is the
  // only parameter) keeps its fingerprint so it stays distinct from a zero-parameter overload.
  if (!arity) parameterNodes = parameterNodes.filter((child) => isVariadicParameterMarker(child));
  const optionalCount = parameterNodes.filter(
    (parameter) =>
      parameter.type === "optional_parameter_declaration" || !!parameter.childForFieldName("default_value"),
  ).length;
  const suffixTokens: string[] = [];
  for (let index = 0; ; index += 1) {
    const child = declarator.child(index);
    if (!child) break;
    if (child.startIndex >= parameters.endIndex) appendLeafTokens(child, new Set<string>(), suffixTokens);
  }
  const variadic = parameterListIsVariadic(parameters);
  return {
    signature: `${parameterNodes.map(parameterFingerprint).join("|")}::${variadic ? "variadic" : "fixed"}::${JSON.stringify(suffixTokens)}`,
    minArity: Math.max(0, arity - optionalCount),
    maxArity: variadic ? null : arity,
  };
}

export function cppBindingCallableShape(binding: Binding): CppCallableShape | null {
  return binding.node ? cppCallableShapeForNode(binding.node) : null;
}

function syntaxRoot(node: SyntaxNodeLike): SyntaxNodeLike {
  let current = node;
  while (current.parent) current = current.parent;
  return current;
}

function isCppDeclarationSite(binding: Binding, node: SyntaxNodeLike): boolean {
  const candidate = binding.node;
  if (!candidate) return false;
  if (candidate.startIndex !== node.startIndex || candidate.endIndex !== node.endIndex) return false;
  const root = syntaxRoot(candidate);
  // Offset coincidence across files is not a declaration site.
  return root === syntaxRoot(node);
}

function cppCallArgumentCount(node: SyntaxNodeLike, source: string): number | null {
  let current = node.parent;
  while (current) {
    if (current.type === "call_expression") {
      const callee = current.childForFieldName("function");
      if (callee && callee.startIndex <= node.startIndex && callee.endIndex >= node.endIndex) {
        return callArgumentCount(current, source);
      }
    }
    if (current.type === "function_definition" || current.type === "program") return null;
    current = current.parent;
  }
  return null;
}

function cppCallableEntities(
  bindings: readonly Binding[],
  canonicalNames?: ReadonlyMap<Binding, string>,
): Map<string, CppCallableEntity> | null {
  const entities = new Map<string, CppCallableEntity>();
  for (const binding of bindings) {
    const shape = cppBindingCallableShape(binding);
    if (!shape) return null;
    const canonicalName = canonicalNames?.get(binding);
    if (canonicalNames && canonicalName === undefined) return null;
    const key = canonicalName === undefined ? shape.signature : `${canonicalName}\0${shape.signature}`;
    const existing = entities.get(key);
    if (!existing) {
      entities.set(key, {
        bindings: [binding],
        minArity: shape.minArity,
        maxArity: shape.maxArity,
      });
      continue;
    }
    existing.bindings.push(binding);
    existing.minArity = Math.min(existing.minArity, shape.minArity);
    if (existing.maxArity === null || shape.maxArity === null) {
      existing.maxArity = null;
    } else {
      existing.maxArity = Math.max(existing.maxArity, shape.maxArity);
    }
  }
  return entities;
}

function preferredCppCallableBinding(bindings: readonly Binding[]): Binding {
  return bindings.find((binding) => cppCallableIsDefinition(binding.node)) ?? bindings[0]!;
}

/** Same-shape declarations and definitions for one C++ callable binding. */
export function cppEquivalentCallableBindings(binding: Binding): readonly Binding[] {
  const collisions = binding.sameScopeFunctionBindings ?? [binding];
  const entities = cppCallableEntities(collisions);
  if (!entities) return [binding];
  for (const entity of entities.values()) {
    if (entity.bindings.includes(binding)) return entity.bindings;
  }
  return [binding];
}

/**
 * Call-count selection without the declaration-site shortcut. Use when the query
 * node may come from a different file than the candidate bindings.
 */
export function cppSelectCallableByCallArity(
  bindings: readonly Binding[],
  node: SyntaxNodeLike,
  source: string,
  canonicalNames?: ReadonlyMap<Binding, string>,
): Binding | null {
  const entities = cppCallableEntities(bindings, canonicalNames);
  if (!entities?.size) return null;

  const argumentCount = cppCallArgumentCount(node, source);
  const matches =
    argumentCount === null
      ? [...entities.values()]
      : [...entities.values()].filter(
          (entity) =>
            argumentCount >= entity.minArity && (entity.maxArity === null || argumentCount <= entity.maxArity),
        );
  // Multiple arity-viable entities stay unresolved: default arguments and
  // variadics can overlap, and this matcher does not implement C++ ranking.
  // One canonical entity still has to accept a known call count: below its
  // minimum or above a finite maximum is not a unique match.
  if (matches.length === 1) return preferredCppCallableBinding(matches[0]!.bindings);
  return null;
}

export function cppSelectCallableBinding(
  bindings: readonly Binding[],
  node: SyntaxNodeLike,
  source: string,
): Binding | null {
  const declaration = bindings.find((candidate) => isCppDeclarationSite(candidate, node));
  if (declaration) return preferredCppCallableBinding(cppEquivalentCallableBindings(declaration));
  return cppSelectCallableByCallArity(bindings, node, source);
}

export function cppCallableIsDefinition(node: SyntaxNodeLike | null | undefined): boolean {
  let current = node ?? null;
  while (current) {
    if (current.type === "function_definition") return true;
    if (current.type === "declaration" || current.type === "program") return false;
    current = current.parent;
  }
  return false;
}
