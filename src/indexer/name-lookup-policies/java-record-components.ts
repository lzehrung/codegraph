/**
 * Java record components are bound in the record's own scope (`headerParameters` in `scope-nodes.ts`), where the body,
 * the compact constructor, and inner classes read them. Names the scope walker does not bind as variables would read a
 * component by mistake, so the lookup stops there instead of guessing:
 *  - a pattern variable declared earlier in the same member (`o instanceof T name`, `T(var name)`, `case T name`);
 *  - a lambda parameter, an enhanced-`for` variable, a `catch` parameter, or a try-with-resources variable in scope;
 *  - an annotation element name (`@A(name = 1)`).
 */
import type { SyntaxNodeLike, SyntaxTreeLike } from "../../languages/types.js";
import { UNPROVEN_JAVA_RECORD_COMPONENT_REASON } from "../ambiguous-resolution.js";
import type { NameLookupState, NameResolution } from "../name-resolution-types.js";
import { headerParameterOwner } from "../scope-nodes.js";

/** Nodes that declare a pattern variable: it is their `name` field, or their last identifier. */
const PATTERN_DECLARATION_TYPES: ReadonlySet<string> = new Set([
  "instanceof_expression",
  "type_pattern",
  "record_pattern_component",
]);

function patternVariableName(node: SyntaxNodeLike): SyntaxNodeLike | null {
  if (!PATTERN_DECLARATION_TYPES.has(node.type)) return null;
  const named = node.childForFieldName("name");
  if (named) return named;
  if (node.type === "instanceof_expression") return null;
  return node.namedChildren.findLast((child) => child.type === "identifier") ?? null;
}

/** The first start of each pattern variable a member declares, by normalized name, read once per member and tree. */
const PATTERN_VARIABLE_STARTS = new WeakMap<SyntaxTreeLike, Map<string, ReadonlyMap<string, number>>>();

function patternVariableStarts(
  tree: SyntaxTreeLike,
  member: SyntaxNodeLike,
  normalize: (name: string) => string,
): ReadonlyMap<string, number> {
  let members = PATTERN_VARIABLE_STARTS.get(tree);
  if (!members) {
    members = new Map();
    PATTERN_VARIABLE_STARTS.set(tree, members);
  }
  const key = `${member.type}:${member.startIndex}:${member.endIndex}`;
  const cached = members.get(key);
  if (cached) return cached;
  const starts = new Map<string, number>();
  const visit = (node: SyntaxNodeLike): void => {
    const variable = patternVariableName(node);
    if (variable) {
      const name = normalize(variable.text);
      const known = starts.get(name);
      if (known === undefined || variable.startIndex < known) starts.set(name, variable.startIndex);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(member);
  members.set(key, starts);
  return starts;
}

/** Whether the member holding `use` declares a pattern variable spelled `wanted` at or before the use. */
function patternVariableBefore(
  tree: SyntaxTreeLike,
  use: SyntaxNodeLike,
  wanted: string,
  normalize: (name: string) => string,
): boolean {
  let member = use;
  while (member.parent && member.parent.type !== "class_body") member = member.parent;
  // The variable's own declaration token is as unproven as its uses.
  const start = patternVariableStarts(tree, member, normalize).get(wanted);
  return start !== undefined && start <= use.startIndex;
}

function sameNode(left: SyntaxNodeLike, right: SyntaxNodeLike): boolean {
  return left.type === right.type && left.startIndex === right.startIndex && left.endIndex === right.endIndex;
}

function within(use: SyntaxNodeLike, region: SyntaxNodeLike | null | undefined): boolean {
  return !!region && region.startIndex <= use.startIndex && use.endIndex <= region.endIndex;
}

/** The parameter names of a lambda: a bare name, a typed list, or an inferred list. */
function lambdaParameterNames(lambda: SyntaxNodeLike): SyntaxNodeLike[] {
  const parameters = lambda.childForFieldName("parameters");
  if (!parameters) return [];
  if (parameters.type === "identifier") return [parameters];
  const names: SyntaxNodeLike[] = [];
  for (const parameter of parameters.namedChildren) {
    if (parameter.type === "identifier") {
      names.push(parameter);
      continue;
    }
    // A varargs parameter keeps its name in a declarator.
    const declarator = parameter.namedChildren.find((child) => child.type === "variable_declarator");
    const name = parameter.childForFieldName("name") ?? declarator?.childForFieldName("name");
    if (name) names.push(name);
  }
  return names;
}

/**
 * Whether a lambda parameter, an enhanced-`for` variable, a `catch` parameter, or a try-with-resources variable that the
 * scope does not bind, spelled `wanted`, is in scope at `use` below the record `owner`. It, not the component, is the name.
 */
function unmodeledBinderInScope(
  use: SyntaxNodeLike,
  owner: SyntaxNodeLike,
  wanted: string,
  normalize: (name: string) => string,
): boolean {
  // A name is the binder's own declaration token, or a variable of the binder that reaches `use`.
  const bindsUse = (name: SyntaxNodeLike | null | undefined, inScope: boolean): boolean =>
    !!name && (sameNode(name, use) || (inScope && normalize(name.text) === wanted));
  for (let node = use.parent; node && !sameNode(node, owner); node = node.parent) {
    // Only these nodes bind a name; reading a field of any other ancestor would scan every statement of a large block.
    switch (node.type) {
      case "lambda_expression": {
        const body = node.childForFieldName("body");
        if (lambdaParameterNames(node).some((name) => bindsUse(name, within(use, body)))) return true;
        break;
      }
      case "enhanced_for_statement":
        if (bindsUse(node.childForFieldName("name"), within(use, node.childForFieldName("body")))) return true;
        break;
      case "catch_clause": {
        const parameter = node.namedChildren.find((child) => child.type === "catch_formal_parameter");
        if (bindsUse(parameter?.childForFieldName("name"), within(use, node.childForFieldName("body")))) return true;
        break;
      }
      case "try_with_resources_statement": {
        const specification = node.namedChildren.find((child) => child.type === "resource_specification");
        // A resource is in scope in the try block and in the resources that follow it, not in `catch` or `finally`.
        const inResourceScope = within(use, node.childForFieldName("body")) || within(use, specification);
        const declared = (specification?.namedChildren ?? []).some((resource) =>
          bindsUse(resource.childForFieldName("name"), inResourceScope && resource.endIndex <= use.startIndex),
        );
        if (declared) return true;
        break;
      }
    }
  }
  return false;
}

/** The key of an annotation's `name = value` pair names an element of the annotation type. */
function isAnnotationElementName(node: SyntaxNodeLike): boolean {
  const parent = node.parent;
  const key = parent?.type === "element_value_pair" ? parent.namedChildren[0] : undefined;
  return !!key && key.startIndex === node.startIndex && key.endIndex === node.endIndex;
}

/** A use that binds a record component but may name an unbound variable or an annotation element stops unresolved. */
export function javaRecordComponentUse(state: NameLookupState): NameResolution | undefined {
  const { use, closestBinding } = state;
  if (closestBinding?.kind !== "param" || !closestBinding.node) return undefined;
  const owner = headerParameterOwner("java", closestBinding.node);
  if (!owner) return undefined;
  const { normalizeIdentifier } = use.parsed.sup;
  const wanted = normalizeIdentifier(state.lookupName);
  const shadowed =
    isAnnotationElementName(use.node) ||
    unmodeledBinderInScope(use.node, owner, wanted, normalizeIdentifier) ||
    patternVariableBefore(use.parsed.tree, use.node, wanted, normalizeIdentifier);
  return shadowed ? { status: "not_found", reason: UNPROVEN_JAVA_RECORD_COMPONENT_REASON } : undefined;
}
