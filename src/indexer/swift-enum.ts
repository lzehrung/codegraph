import type { SyntaxNodeLike } from "../languages/types.js";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import { nearestMemberContainer } from "../graphs/symbol-graph-detailed/receiver-calls.js";
import { sliceText } from "../util/ast.js";
import { normalizeSwiftIdentifier } from "../util/identifiers.js";
import { getMemberAccessParts, isMemberAccessNode } from "../util/member-access.js";
import { fileIdentityKey } from "../util/paths.js";
import { swiftCallLabels, swiftParameterForArgument } from "../util/swift-tree.js";
import { findClosestScopeBinding } from "./navigation-local.js";
import type { BareNameUse } from "./name-resolution-types.js";
import type { ParsedFileContext } from "./parse-context.js";
import { ensureParsedContextForIndex, rethrowStaleQuerySource } from "./parsed-cache.js";
import { getSharedOwnerIdentity } from "./shared-owner-identity.js";
import type { ModuleIndex, ProjectIndex, SymbolDef } from "./types.js";

/** The type a leading-dot name (an enum case or a static member) is resolved against. */
export type ContextualType = {
  node: SyntaxNodeLike;
  parsed: ParsedFileContext;
  module: ModuleIndex;
  /** `node` sits inside the type (`self`, `Self`), so the members of its body and its extensions are the candidates. */
  enclosing: boolean;
  /** The context is `Type?`: `Optional` declares `none` and `some` itself, so those names are not the type's cases. */
  optional: boolean;
  /** The name is an element of an array literal typed as this nominal type, which then has to be an `OptionSet`. */
  optionSet: boolean;
};

/** A dotted type that spells the full path of the type around `declaration` names that type, whatever its root is. */
function namesEnclosingOwner(
  segments: readonly SyntaxNodeLike[],
  declaration: SyntaxNodeLike,
  parsed: ParsedFileContext,
  module: ModuleIndex,
): boolean {
  const container = nearestMemberContainer(declaration);
  const identity = container ? getSharedOwnerIdentity(container, parsed.source, "swift", module.file) : null;
  return identity?.fullPath === segments.map((segment) => normalizeSwiftIdentifier(segment.text)).join(".");
}

/**
 * Only an explicitly written nominal type proves a context; trailing type arguments are ignored (`Box<Int>` names
 * `Box`) and `Self` names the enclosing type. For an array-literal element, `[Mode]` types the element and a nominal
 * type is an `OptionSet` literal typed as a whole.
 */
function writtenType(
  type: SyntaxNodeLike | undefined,
  declaration: SyntaxNodeLike,
  parsed: ParsedFileContext,
  module: ModuleIndex,
  elements = false,
): ContextualType | null {
  const optional = type?.type === "optional_type";
  let nominal = optional ? type?.namedChildren[0] : type;
  const arrayType = elements && nominal?.type === "array_type";
  if (arrayType) nominal = nominal?.namedChildren.find((child) => child.type === "user_type");
  if (nominal?.type !== "user_type") return null;
  // `Validator<T>` names `Validator`; type arguments before another segment make the owner generic and prove no path.
  const parts = nominal.namedChildren;
  const segments = parts.at(-1)?.type === "type_arguments" ? parts.slice(0, -1) : parts;
  if (!segments.length || segments.some((child) => child.type !== "type_identifier")) return null;
  const node = segments.at(-1);
  if (!node) return null;
  const optionSet = elements && !arrayType;
  const namesSelf = segments.length === 1 && node.text === "Self";
  if (namesSelf || (segments.length > 1 && namesEnclosingOwner(segments, declaration, parsed, module))) {
    return { node: declaration, parsed, module, enclosing: true, optional, optionSet };
  }
  return { node, parsed, module, enclosing: false, optional, optionSet };
}

/** The written type of a parameter or property declaration. */
function declaredType(
  declaration: SyntaxNodeLike,
  parsed: ParsedFileContext,
  module: ModuleIndex,
  elements = false,
): ContextualType | null {
  const annotation = declaration.namedChildren.find((child) => child.type === "type_annotation");
  const written = declaration.namedChildren.find(
    (child) =>
      child.type === "user_type" || child.type === "optional_type" || (elements && child.type === "array_type"),
  );
  const type = annotation?.namedChildren[0] ?? written;
  return writtenType(type, declaration, parsed, module, elements);
}

/** The written return type of a function: the first type after its `->`. */
function returnedType(
  declaration: SyntaxNodeLike,
  parsed: ParsedFileContext,
  module: ModuleIndex,
  elements = false,
): ContextualType | null {
  let afterArrow = false;
  for (let index = 0; ; index += 1) {
    const child = declaration.child(index);
    if (!child) return null;
    if (child.type === "->") afterArrow = true;
    else if (afterArrow && child.type !== "comment") return writtenType(child, declaration, parsed, module, elements);
  }
}

/** The annotation on a local or parameter is a fact of that binding; `self` is the enclosing type. */
function declaredValueType(use: BareNameUse, value: SyntaxNodeLike, elements = false): ContextualType | null {
  if (value.type === "self_expression") {
    return { node: value, parsed: use.parsed, module: use.mod, enclosing: true, optional: false, optionSet: elements };
  }
  if (value.type !== "simple_identifier") return null;
  const binding = findClosestScopeBinding(use.scopeIndex, sliceText(value, use.parsed.source), value, use.parsed.sup);
  if (!binding?.node || (binding.kind !== "local" && binding.kind !== "param")) return null;
  let declaration: SyntaxNodeLike | null = binding.node.parent;
  if (declaration?.type === "pattern") declaration = declaration.parent;
  if (!declaration || (declaration.type !== "parameter" && declaration.type !== "property_declaration")) return null;
  return declaredType(declaration, use.parsed, use.mod, elements);
}

const operatorDeclarations = new WeakMap<ProjectIndex, Map<string, Promise<boolean>>>();

/** A user-defined equality can give the opposite operand a different type. */
function comparisonOperatorMayBeOverloaded(use: BareNameUse, operator: string): Promise<boolean> {
  let cache = operatorDeclarations.get(use.index);
  if (!cache) {
    cache = new Map();
    operatorDeclarations.set(use.index, cache);
  }
  const key = operator;
  let result = cache.get(key);
  if (!result) {
    result = (async () => {
      for (const module of use.index.byFile.values()) {
        if (supportForFileWithoutHeaderSample(module.file, use.index.languageExtensions)?.id !== "swift") continue;
        let parsed: ParsedFileContext;
        try {
          parsed = await ensureParsedContextForIndex(use.index, module.file);
        } catch (error) {
          rethrowStaleQuerySource(error);
          return true;
        }
        if (module.parseErrorRanges?.length) return true;
        const hasOperator = (node: SyntaxNodeLike): boolean => {
          if (node.type === "function_declaration" && node.childForFieldName("name")?.text === operator) return true;
          return node.namedChildren.some(hasOperator);
        };
        if (hasOperator(parsed.tree.rootNode)) return true;
      }
      return false;
    })();
    cache.set(key, result);
  }
  return result;
}

/** Read the declared parameter corresponding to an argument of a uniquely resolved callable. */
async function argumentType(
  use: BareNameUse,
  argument: SyntaxNodeLike,
  resolveCallee: ((node: SyntaxNodeLike) => Promise<SymbolDef | null>) | undefined,
  elements = false,
): Promise<ContextualType | null> {
  const argumentsNode = argument.parent;
  const suffix = argumentsNode?.parent;
  const call = suffix?.parent;
  if (argumentsNode?.type !== "value_arguments" || suffix?.type !== "call_suffix" || call?.type !== "call_expression") {
    return null;
  }
  const callee = call.namedChildren[0];
  if (!callee || !resolveCallee) return null;
  const name = isMemberAccessNode(use.parsed.sup, callee)
    ? getMemberAccessParts(use.parsed.sup, callee).property
    : callee;
  if (!name) return null;
  const labels = swiftCallLabels(name);
  if (!labels) return null;
  const args = argumentsNode.namedChildren.filter((child) => child.type === "value_argument");
  const targetArgument = args.findIndex((child) => child.id === argument.id);
  if (targetArgument < 0 || labels.length < args.length) return null;
  const definition = await resolveCallee(name);
  const parameters = definition?.callable?.swiftParameters;
  if (!definition || !parameters) return null;
  const position = swiftParameterForArgument(parameters, labels, targetArgument);
  if (position === null) return null;
  const module = use.index.byFile.get(fileIdentityKey(definition.file));
  if (!module) return null;
  const parsed = await ensureParsedContextForIndex(use.index, definition.file);
  const start = definition.range.start.index;
  if (start === undefined) return null;
  const nameNode = parsed.tree.rootNode.descendantForIndex(start, definition.range.end.index ?? start);
  const declaration = nameNode.parent;
  if (!declaration || declaration.type !== "function_declaration") return null;
  const parameter = declaration.namedChildren.filter((child) => child.type === "parameter")[position];
  return parameter ? declaredType(parameter, parsed, module, elements) : null;
}

/** `.case(args)` is a call whose callee is the shorthand; a conditional's branches take the context of the whole. */
function shorthandValue(shorthand: SyntaxNodeLike): SyntaxNodeLike {
  let value = shorthand;
  const call = value.parent;
  if (call?.type === "call_expression" && call.namedChildren[0]?.id === value.id) value = call;
  for (;;) {
    const conditional = value.parent;
    if (conditional?.type !== "ternary_expression") return value;
    // The condition is a Bool, not a value of the case's type.
    if (conditional.namedChildren[0]?.id === value.id) return value;
    value = conditional;
  }
}

/** The type of the other operand of `==` or `!=`, unless a project operator can give it a different type. */
async function equalityOperandType(
  use: BareNameUse,
  equality: SyntaxNodeLike,
  value: SyntaxNodeLike,
): Promise<ContextualType | null> {
  let operator = "";
  for (let index = 0; ; index += 1) {
    const child = equality.child(index);
    if (!child) break;
    if (child.type === "==" || child.type === "!=") operator = child.type;
  }
  if (!operator || (await comparisonOperatorMayBeOverloaded(use, operator))) return null;
  const others = equality.namedChildren.filter((child) => child.id !== value.id);
  return others.length === 1 ? declaredValueType(use, others[0]!) : null;
}

/** `self = .case`, or `local = .case` for a local with a written type. */
function assignmentTargetType(
  use: BareNameUse,
  assignment: SyntaxNodeLike,
  value: SyntaxNodeLike,
  elements: boolean,
): ContextualType | null {
  if (assignment.childForFieldName("operator")?.type !== "=") return null;
  if (assignment.namedChildren.at(-1)?.id !== value.id) return null;
  const target = assignment.childForFieldName("target")?.namedChildren[0];
  return target ? declaredValueType(use, target, elements) : null;
}

/** `return .case` in a function with a written return type, or in a computed property with a written type. */
function returnedValueType(use: BareNameUse, statement: SyntaxNodeLike, elements: boolean): ContextualType | null {
  if (statement.child(0)?.type !== "return") return null;
  for (let owner = statement.parent; owner; owner = owner.parent) {
    if (owner.type === "function_declaration") return returnedType(owner, use.parsed, use.mod, elements);
    if (owner.type === "property_declaration") return declaredType(owner, use.parsed, use.mod, elements);
    // A closure, initializer, or accessor has no written type of its own to prove.
    if (owner.type === "lambda_literal" || owner.type === "init_declaration") return null;
  }
  return null;
}

/** A body of one expression returns it: a single-expression function, or a computed property with a written type. */
function implicitReturnType(use: BareNameUse, statements: SyntaxNodeLike, elements: boolean): ContextualType | null {
  if (statements.namedChildren.filter((child) => child.type !== "comment").length !== 1) return null;
  const body = statements.parent;
  const owner = body?.parent;
  if (body?.type === "function_body" && owner?.type === "function_declaration") {
    return returnedType(owner, use.parsed, use.mod, elements);
  }
  if (body?.type === "computed_property" && owner?.type === "property_declaration") {
    return declaredType(owner, use.parsed, use.mod, elements);
  }
  return null;
}

/** The subject expression of a `switch`, or its element at the tuple position the pattern occupies. */
function switchSubjectFor(shorthand: SyntaxNodeLike): SyntaxNodeLike | null {
  const outer = shorthand.parent;
  if (outer?.type === "switch_pattern") return switchSubject(outer);
  // `case (.a, .b)` pairs each element pattern with the subject tuple's element.
  const tuplePattern = outer?.type === "pattern" ? outer : null;
  const switchPattern = tuplePattern?.parent;
  if (!tuplePattern || switchPattern?.type !== "switch_pattern") return null;
  if (tuplePattern.namedChildren.some((child) => child.type === "simple_identifier")) return null;
  const subject = switchSubject(switchPattern);
  if (subject?.type !== "tuple_expression") return null;
  const elements = tuplePattern.namedChildren.filter((child) => child.type === "pattern");
  const position = elements.findIndex((child) => child.id === shorthand.id);
  if (position < 0 || subject.namedChildren.length !== elements.length) return null;
  return subject.namedChildren[position] ?? null;
}

function switchSubject(pattern: SyntaxNodeLike): SyntaxNodeLike | null {
  const entry = pattern.parent;
  const statement = entry?.parent;
  if (entry?.type !== "switch_entry" || statement?.type !== "switch_statement") return null;
  return statement.namedChildren[0] ?? null;
}

/**
 * Context supplied by an annotation, call parameter, comparison, assignment, return, switch subject, or the typed array
 * literal an element sits in.
 */
export async function swiftShorthandContextType(
  use: BareNameUse,
  resolveCallee?: (node: SyntaxNodeLike) => Promise<SymbolDef | null>,
): Promise<ContextualType | null> {
  const shorthand = use.node.parent;
  if (!shorthand) return null;
  if (shorthand.type === "pattern") {
    const subject = switchSubjectFor(shorthand);
    return subject ? declaredValueType(use, subject) : null;
  }
  let value = shorthandValue(shorthand);
  // `[.a, .b]` types each element by the context of the literal itself.
  const literal = value.parent?.type === "array_literal" ? value.parent : null;
  if (literal) value = shorthandValue(literal);
  const elements = !!literal;
  const parent = value.parent;
  if (!parent) return null;
  if (parent.type === "property_declaration") {
    if (parent.childForFieldName("value")?.id !== value.id) return null;
    return declaredType(parent, use.parsed, use.mod, elements);
  }
  if (parent.type === "value_argument") {
    if (parent.childForFieldName("value")?.id !== value.id) return null;
    return await argumentType(use, parent, resolveCallee, elements);
  }
  if (parent.type === "equality_expression") return elements ? null : await equalityOperandType(use, parent, value);
  if (parent.type === "assignment") return assignmentTargetType(use, parent, value, elements);
  if (parent.type === "control_transfer_statement") return returnedValueType(use, parent, elements);
  if (parent.type === "statements") return implicitReturnType(use, parent, elements);
  return null;
}
