/**
 * Java record components are bound in the record's own scope (`headerParameters` in `scope-nodes.ts`), where the body,
 * the compact constructor, and inner classes read them. Names the scope walker does not bind as variables would read a
 * component by mistake, so the lookup stops there instead of guessing:
 *  - a pattern variable declared earlier in the same member (`o instanceof T name`, `T(var name)`, `case T name`);
 *  - a lambda parameter, an enhanced-`for` variable, a `catch` parameter, or a try-with-resources variable in scope;
 *  - an annotation element name (`@A(name = 1)`).
 */
import type { SyntaxNodeLike, SyntaxTreeLike } from "../../languages/types.js";
import { isJavaAnnotationElementName } from "../../util/java-designators.js";
import {
  isJavaPatternVariableName,
  javaPatternMayReachUse,
  javaPatternMember,
  javaPatternVariableName,
} from "../../util/java-patterns.js";
import { UNPROVEN_JAVA_RECORD_COMPONENT_REASON } from "../ambiguous-resolution.js";
import type { NameLookupState, NameResolution } from "../name-resolution-types.js";
import { headerParameterOwner } from "../scope-nodes.js";

/** Pattern declarations in each member, keyed by normalized name and read once per member and tree. */
const PATTERN_VARIABLES = new WeakMap<SyntaxTreeLike, Map<string, ReadonlyMap<string, readonly SyntaxNodeLike[]>>>();

function patternVariables(
  tree: SyntaxTreeLike,
  member: SyntaxNodeLike,
  normalize: (name: string) => string,
): ReadonlyMap<string, readonly SyntaxNodeLike[]> {
  let members = PATTERN_VARIABLES.get(tree);
  if (!members) {
    members = new Map();
    PATTERN_VARIABLES.set(tree, members);
  }
  const key = `${member.type}:${member.startIndex}:${member.endIndex}`;
  const cached = members.get(key);
  if (cached) return cached;
  const variables = new Map<string, SyntaxNodeLike[]>();
  const visit = (node: SyntaxNodeLike): void => {
    const variable = javaPatternVariableName(node);
    if (variable) {
      const name = normalize(variable.text);
      const known = variables.get(name);
      if (known) known.push(variable);
      else variables.set(name, [variable]);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(member);
  members.set(key, variables);
  return variables;
}

/** Whether the member holding `use` declares a pattern variable spelled `wanted` at or before the use. */
function patternVariableBefore(
  tree: SyntaxTreeLike,
  use: SyntaxNodeLike,
  wanted: string,
  normalize: (name: string) => string,
): boolean {
  const member = javaPatternMember(use);
  // The variable's own declaration token is as unproven as its uses.
  const declarations = patternVariables(tree, member, normalize).get(wanted);
  return !!declarations?.some((declaration) => javaPatternMayReachUse(declaration, use));
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

/** A not-yet-modeled pattern must not fall through to a same-named field or import. */
export function javaPatternVariableFallback(state: NameLookupState): NameResolution | undefined {
  const { use, closestBinding } = state;
  const bindingName = closestBinding?.node;
  if (bindingName && isJavaPatternVariableName(bindingName)) return undefined;
  const declaration = bindingName?.parent;
  const field = declaration?.type === "variable_declarator" && declaration.parent?.type === "field_declaration";
  if (closestBinding && !closestBinding.import && !field) return undefined;
  const { normalizeIdentifier } = use.parsed.sup;
  const wanted = normalizeIdentifier(state.lookupName);
  const member = javaPatternMember(use.node);
  const declarations = patternVariables(use.parsed.tree, member, normalizeIdentifier).get(wanted);
  return declarations?.some((name) => javaPatternMayReachUse(name, use.node))
    ? { status: "not_found", reason: UNPROVEN_JAVA_RECORD_COMPONENT_REASON }
    : undefined;
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
    isJavaAnnotationElementName(use.node) ||
    unmodeledBinderInScope(use.node, owner, wanted, normalizeIdentifier) ||
    patternVariableBefore(use.parsed.tree, use.node, wanted, normalizeIdentifier);
  return shadowed ? { status: "not_found", reason: UNPROVEN_JAVA_RECORD_COMPONENT_REASON } : undefined;
}
