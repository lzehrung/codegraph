import type { SyntaxNodeLike } from "../languages/types.js";
import type { SwiftCallableParameter } from "../languages/callable-arity.js";
import { normalizeSwiftIdentifier } from "./identifiers.js";

/**
 * The `user_type` that names the type a Swift `extension` extends, given that node or its single
 * identifier (a native capture resolves to the identifier when the path has one segment).
 * A generic argument or an inheritance clause also holds a `user_type`, but not in the `name` field.
 */
export function swiftExtensionOwnerType(node: SyntaxNodeLike): SyntaxNodeLike | null {
  const type = node.type === "user_type" ? node : node.parent;
  const container = type?.parent;
  if (type?.type !== "user_type" || container?.type !== "class_declaration") return null;
  if (container.childForFieldName("name")?.id !== type.id) return null;
  return container.childForFieldName("declaration_kind")?.text === "extension" ? type : null;
}

/** A segment of an extension header's type path: a use of an existing type, never a declaration. */
export function isSwiftExtensionTypeName(node: SyntaxNodeLike): boolean {
  return node.type === "type_identifier" && swiftExtensionOwnerType(node) !== null;
}

/**
 * The second or later segment of a dotted extension owner (`Inner` in `extension Outer.Inner`).
 * It is a member of the segments before it, so its own spelling proves no binding.
 */
export function isSwiftQualifiedExtensionSuffix(node: SyntaxNodeLike): boolean {
  if (!isSwiftExtensionTypeName(node)) return false;
  const segments = node.parent?.namedChildren ?? [];
  return segments.some((segment) => segment.type === "type_identifier" && segment.startIndex < node.startIndex);
}

/**
 * The name segments of a dotted Swift type through `node` (`Other` and `Base` for `Base` in `Other.Base`), or null when
 * `node` is not a later segment of a plain dotted type. Type arguments are not segments, and a generic owner
 * (`Outer<T>.Inner`) names a member of one specialization, so it proves no path.
 */
export function swiftQualifiedTypeSegments(node: SyntaxNodeLike): SyntaxNodeLike[] | null {
  const type = node.parent;
  if (node.type !== "type_identifier" || type?.type !== "user_type") return null;
  const segments: SyntaxNodeLike[] = [];
  let genericOwner = false;
  for (const child of type.namedChildren) {
    if (child.type === "type_arguments") {
      if (segments.length) genericOwner = true;
      continue;
    }
    if (child.type !== "type_identifier") continue;
    if (genericOwner) return null;
    segments.push(child);
    if (child.startIndex === node.startIndex) break;
  }
  return segments.length > 1 ? segments : null;
}

/**
 * A later segment of a dotted type outside an extension header (`Base` in `Other.Base`). It is a nested type of the
 * segments before it, so its own spelling proves no binding.
 */
export function isSwiftQualifiedTypeSuffix(node: SyntaxNodeLike): boolean {
  if (node.type !== "type_identifier" || node.parent?.type !== "user_type" || isSwiftExtensionTypeName(node)) {
    return false;
  }
  const segments = node.parent.namedChildren;
  return segments.some((segment) => segment.type === "type_identifier" && segment.startIndex < node.startIndex);
}

/** A leading-dot enum case, as an expression or as a switch pattern (`.x`, `.x(let y)`, `let .x(y)`). */
export function isSwiftShorthandCase(node: SyntaxNodeLike): boolean {
  const parent = node.parent;
  if (node.type !== "simple_identifier" || !parent) return false;
  if (parent.type !== "prefix_expression" && parent.type !== "pattern") return false;
  let previous: SyntaxNodeLike | null = null;
  for (let index = 0; ; index += 1) {
    const child = parent.child(index);
    if (!child) return false;
    if (child.type === node.type && child.startIndex === node.startIndex) return previous?.type === ".";
    previous = child;
  }
}

/** `items[key]` parses as a call whose argument list opens with `[`: it reads a value and calls nothing. */
export function isSwiftSubscriptAccess(call: SyntaxNodeLike): boolean {
  if (call.type !== "call_expression") return false;
  const suffix = call.namedChildren.find((child) => child.type === "call_suffix");
  const args = suffix?.namedChildren.find((child) => child.type === "value_arguments");
  return args?.child(0)?.type === "[";
}

/** The callee of a Swift call, not of a subscript access. */
export function isSwiftCallee(node: SyntaxNodeLike): boolean {
  const call = node.parent;
  return call?.type === "call_expression" && call.namedChildren[0]?.id === node.id && !isSwiftSubscriptAccess(call);
}

/** A leading-dot name that is the callee of a call (`.make(1)`): it names a static function or an enum case. */
export function isSwiftShorthandCallee(node: SyntaxNodeLike): boolean {
  const shorthand = node.parent;
  return shorthand?.type === "prefix_expression" && isSwiftShorthandCase(node) && isSwiftCallee(shorthand);
}

/** Whether `node` names a bare value or call (`name`), not a member through an explicit receiver (`x.name`) or `.name`. */
export function isSwiftBareName(node: SyntaxNodeLike): boolean {
  return node.parent?.type !== "navigation_suffix" && !isSwiftShorthandCase(node);
}

const TYPE_BODY_TYPES: Readonly<Record<string, true>> = {
  class_body: true,
  enum_class_body: true,
  protocol_body: true,
  source_file: true,
};

/**
 * A name the scope model does not declare: a `case`, `catch`, `for`, or tuple pattern, an `if`/`guard`/`while`
 * condition, or a closure parameter. A `let`/`var` declaration and a function parameter are declared by it.
 */
function isUndeclaredBinder(identifier: SyntaxNodeLike): boolean {
  const parent = identifier.parent;
  if (!parent) return false;
  if (parent.type === "lambda_parameter") return parent.childForFieldName("name")?.id === identifier.id;
  if (parent.type !== "pattern") return identifier.previousSibling?.type === "value_binding_pattern";
  if (parent.childForFieldName("bound_identifier")?.id === identifier.id) {
    const declaration = parent.parent?.type;
    return declaration !== "property_declaration" && declaration !== "protocol_property_declaration";
  }
  // An element of a tuple pattern (`let (a, b) = pair`, `for (a, b) in pairs`) is the only child of its own pattern.
  const inTuplePattern = parent.parent?.type === "pattern";
  if (!inTuplePattern) return false;
  return parent.namedChildren.length === 1 && parent.child(0)?.id === identifier.id;
}

/**
 * Whether a binder that the scope model does not declare may bind `normalizedName` at `use`: a binder of that
 * spelling at or before the use, anywhere in the declaration directly inside the type body that holds it. A local
 * hides every member of the name, so a lookup that cannot see such a binder must not prefer one member over another.
 */
export function swiftNameMayBeRebound(
  use: SyntaxNodeLike,
  normalizedName: string,
  normalize: (name: string) => string,
): boolean {
  let member: SyntaxNodeLike = use;
  while (member.parent && !TYPE_BODY_TYPES[member.parent.type]) member = member.parent;
  const pending = [member];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (node.startIndex > use.startIndex) continue;
    const rebinds =
      node.type === "simple_identifier" && normalize(node.text) === normalizedName && isUndeclaredBinder(node);
    if (rebinds) return true;
    pending.push(...node.namedChildren);
  }
  return false;
}

const TYPE_WRAPPER_TYPES: Readonly<Record<string, true>> = {
  optional_type: true,
  tuple_type: true,
  tuple_type_item: true,
};

/**
 * A function type, possibly parenthesized or optional (`((Int) -> Void)?`). Attributes (`@Sendable`) sit in a sibling
 * `type_modifiers` node, so a wrapper's other children never hide the function type.
 */
function holdsFunctionType(type: SyntaxNodeLike | undefined): boolean {
  if (!type) return false;
  if (type.type === "function_type") return true;
  if (!TYPE_WRAPPER_TYPES[type.type]) return false;
  if (type.type === "tuple_type" && type.namedChildren.length !== 1) return false;
  return type.namedChildren.some(holdsFunctionType);
}

/**
 * Whether calling the Swift variable declared by `name` can be proven from its declaration: an enum case builds a
 * value, and a property is invoked when its written type is a function type or, unannotated, its initializer is a
 * closure. Any other property holds a value, so a call of that name names another declaration.
 */
export function isSwiftInvocableVariable(name: SyntaxNodeLike): boolean {
  const owner = name.parent;
  if (owner?.type === "enum_entry") return true;
  const declaration = owner?.type === "pattern" ? owner.parent : null;
  if (declaration?.type !== "property_declaration" && declaration?.type !== "protocol_property_declaration") {
    return false;
  }
  const annotation = declaration.namedChildren.find((child) => child.type === "type_annotation");
  if (annotation) return annotation.namedChildren.some(holdsFunctionType);
  return declaration.childForFieldName("value")?.type === "lambda_literal";
}

/** External parameter labels and defaults as spelled by a Swift callable declaration; null after a parse recovery. */
export function swiftCallableParameters(declaration: SyntaxNodeLike): SwiftCallableParameter[] | null {
  const parameters: SwiftCallableParameter[] = [];
  let current: SwiftCallableParameter | undefined;
  let inParameters = false;
  for (let index = 0; ; index += 1) {
    const child = declaration.child(index);
    if (!child) break;
    if (child.type === "(") {
      inParameters = true;
      continue;
    }
    if (!inParameters) continue;
    if (child.type === ")") return parameters;
    if (child.type === "ERROR" || child.type === "MISSING") return null;
    if (child.type === "parameter") {
      if (child.namedChildren.some((part) => part.type === "ERROR" || part.type === "MISSING")) return null;
      const name = child.namedChildren.find((part) => part.type === "simple_identifier");
      if (!name) return null;
      let variadic = false;
      for (let part = 0; ; part += 1) {
        const token = child.child(part);
        if (!token) break;
        if (token.type === "...") variadic = true;
      }
      current = { label: normalizeSwiftIdentifier(name.text), optional: false, variadic };
      parameters.push(current);
    } else if (child.type === "=" && current) {
      current.optional = true;
    }
  }
  return null;
}

/** Whether `name` is the member the call invokes: the callee itself, its last `.member`, or a leading-dot name. */
function namesCalledMember(name: SyntaxNodeLike, callee: SyntaxNodeLike): boolean {
  if (callee.id === name.id) return true;
  if (callee.type === "navigation_expression") {
    return callee.childForFieldName("suffix")?.childForFieldName("suffix")?.id === name.id;
  }
  return callee.type === "prefix_expression" && callee.namedChildren.at(-1)?.id === name.id;
}

/** Sentinel label for a Swift trailing closure, whose external parameter label is elided at the call site. */
export const SWIFT_TRAILING_CLOSURE_LABEL = "<trailing-closure>";

function appendTrailingClosureLabels(suffix: SyntaxNodeLike | undefined, labels: string[]): void {
  if (!suffix) return;
  let pendingLabel: string | null = null;
  for (const child of suffix.namedChildren) {
    if (child.type === "simple_identifier") {
      pendingLabel = normalizeSwiftIdentifier(child.text);
    } else if (child.type === "lambda_literal") {
      labels.push(pendingLabel ?? SWIFT_TRAILING_CLOSURE_LABEL);
      pendingLabel = null;
    } else if (child.type !== "comment") {
      pendingLabel = null;
    }
  }
}

/** Labels on a call to `name`; subscripts and malformed calls remain unproven. */
export function swiftCallLabels(name: SyntaxNodeLike): string[] | null {
  for (let node = name.parent; node; node = node.parent) {
    if (node.type === "value_argument" || node.type === "lambda_literal") return null;
    if (node.type !== "call_expression") continue;
    if (isSwiftSubscriptAccess(node)) return null;
    const callee = node.namedChildren[0];
    if (!callee || name.startIndex < callee.startIndex || name.endIndex > callee.endIndex) return null;
    // A receiver or an earlier member of the callee (`arguments` in `arguments.append(1)`) is not what is invoked.
    if (!namesCalledMember(name, callee)) return null;
    const suffix = node.namedChildren.find((child) => child.type === "call_suffix");
    if (!suffix) return null;
    // `let x = f(a: 1) { }` or `await f(a: 1) { }` nests this call in a call whose suffix holds the trailing closure.
    let inner = node;
    while (inner.parent?.type === "await_expression" || inner.parent?.type === "try_expression") inner = inner.parent;
    const wrapper =
      inner.parent?.type === "call_expression" && inner.parent.namedChildren[0]?.id === inner.id ? inner.parent : null;
    const wrapperSuffix = wrapper?.namedChildren.find((child) => child.type === "call_suffix");
    const args = suffix.namedChildren.find((child) => child.type === "value_arguments");
    const hasTrailing =
      suffix.namedChildren.some((child) => child.type === "lambda_literal") ||
      !!wrapperSuffix?.namedChildren.some((child) => child.type === "lambda_literal");
    if (!args && !hasTrailing) return null;
    const labels: string[] = [];
    if (args) {
      for (const arg of args.namedChildren) {
        if (arg.type === "comment") continue;
        if (arg.type !== "value_argument") return null;
        const label = arg.childForFieldName("name");
        labels.push(label ? normalizeSwiftIdentifier(label.text) : "_");
      }
    }
    appendTrailingClosureLabels(suffix, labels);
    appendTrailingClosureLabels(wrapperSuffix, labels);
    return labels;
  }
  return null;
}

/** Match labels in order, allowing defaulted and variadic parameters without ranking types. */
export function swiftParametersAcceptLabels(
  parameters: readonly SwiftCallableParameter[],
  labels: readonly string[],
): boolean {
  const memo = new Map<number, boolean>();
  const matches = (parameterIndex: number, argumentIndex: number): boolean => {
    const key = parameterIndex * (labels.length + 1) + argumentIndex;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const parameter = parameters[parameterIndex];
    if (!parameter) return argumentIndex === labels.length;
    let accepted = (parameter.optional || parameter.variadic) && matches(parameterIndex + 1, argumentIndex);
    const argLabel = labels[argumentIndex];
    if (!accepted && (argLabel === parameter.label || argLabel === SWIFT_TRAILING_CLOSURE_LABEL)) {
      if (parameter.variadic) {
        let end = argumentIndex + 1;
        accepted = matches(parameterIndex + 1, end);
        while (!accepted && labels[end] === "_") {
          end += 1;
          accepted = matches(parameterIndex + 1, end);
        }
      } else {
        accepted = matches(parameterIndex + 1, argumentIndex + 1);
      }
    }
    memo.set(key, accepted);
    return accepted;
  };
  return matches(0, 0);
}

/**
 * Whether only the argument count, not a label, separates the call from the parameters: it omits trailing parameters
 * or passes more unlabeled arguments than there are parameters. A label the callee lacks, or one out of order, fits
 * neither, so it proves the callee is another declaration.
 */
export function swiftLabelsFit(parameters: readonly SwiftCallableParameter[], labels: readonly string[]): boolean {
  if (swiftParametersAcceptLabels(parameters, labels)) return true;
  for (let kept = 0; kept < parameters.length; kept += 1) {
    if (swiftParametersAcceptLabels(parameters.slice(0, kept), labels)) return true;
  }
  const surplus = labels.length > parameters.length && !parameters.some((parameter) => parameter.variadic);
  for (let end = labels.length - 1; surplus && end >= 0 && labels[end] === "_"; end -= 1) {
    if (swiftParametersAcceptLabels(parameters, labels.slice(0, end))) return true;
  }
  return false;
}

/** The unique parameter accepting one argument, or null when default/variadic matching is ambiguous. */
export function swiftParameterForArgument(
  parameters: readonly SwiftCallableParameter[],
  labels: readonly string[],
  targetArgument: number,
): number | null {
  const candidates = new Set<number>();
  const visited = new Set<string>();
  const walk = (parameterIndex: number, argumentIndex: number, targetParameter: number): void => {
    if (candidates.size > 1) return;
    const key = `${parameterIndex}:${argumentIndex}:${targetParameter}`;
    if (visited.has(key)) return;
    visited.add(key);
    const parameter = parameters[parameterIndex];
    if (!parameter) {
      if (argumentIndex === labels.length && targetParameter >= 0) candidates.add(targetParameter);
      return;
    }
    if (parameter.optional || parameter.variadic) walk(parameterIndex + 1, argumentIndex, targetParameter);
    const argLabel = labels[argumentIndex];
    if (argLabel !== parameter.label && argLabel !== SWIFT_TRAILING_CLOSURE_LABEL) return;
    let end = argumentIndex + 1;
    let matched = argumentIndex === targetArgument ? parameterIndex : targetParameter;
    walk(parameterIndex + 1, end, matched);
    if (!parameter.variadic) return;
    while (labels[end] === "_") {
      if (end === targetArgument) matched = parameterIndex;
      end += 1;
      walk(parameterIndex + 1, end, matched);
    }
  };
  walk(0, 0, -1);
  return candidates.size === 1 ? (candidates.values().next().value ?? null) : null;
}
