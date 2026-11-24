/**
 * C# header parameters: a record's positional parameters and a class's or struct's primary-constructor parameters. The
 * scope index binds them in the declaration's own scope (`headerParameters` in `scope-nodes.ts`), so a closer local,
 * parameter, or member of the body already wins. This policy settles the uses that Roslyn binds differently:
 *  - an initializer or base-constructor argument reads the parameter even when the body declares a same-named member;
 *  - a member body reads a member of another `partial` part or a project base class before the parameter (a derived
 *    record that repeats a base record's parameter reads the inherited property);
 *  - a name written before `=` or `:` (`with { X = 1 }`, `new Dto { X = 1 }`, `F(x: 1)`, `{ X: 1 }`) designates a
 *    member of another type, not the parameter.
 */
import { nearestMemberContainer } from "../../graphs/symbol-graph-detailed/receiver-calls.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { csharpShadowedByUnmodeledBinder } from "../../util/csharp-bindings.js";
import { isCsharpMemberDesignator } from "../../util/csharp-designators.js";
import { normalizeCsharpIdentifier } from "../../util/identifiers.js";
import { UNPROVEN_CSHARP_BINDER_REASON, UNPROVEN_CSHARP_MEMBER_DESIGNATOR_REASON } from "../ambiguous-resolution.js";
import { csharpOwnerMayHaveOuterMembers } from "../navigation-goto.js";
import { definitionForBinding } from "../navigation-local.js";
import { okGoToResult } from "../navigation-provenance.js";
import type { NameLookupState, NameResolution } from "../name-resolution-types.js";
import { headerParameterOwner as headerParameterOwnerOf, scopeNodesFor } from "../scope-nodes.js";
import type { Binding } from "../scope-types.js";

const HEADER_PARAMETERS = scopeNodesFor("csharp").headerParameters;

/** Members whose names an initializer's parameter read outranks. */
const BODY_MEMBER_TYPES: ReadonlySet<string> = new Set([
  "field_declaration",
  "event_field_declaration",
  "property_declaration",
]);

/** How a use reads a header parameter, relative to the declaration whose header declares it. */
export type HeaderParameterContext = "header" | "initializer" | "member" | "designator";

function sameNode(left: SyntaxNodeLike | null | undefined, right: SyntaxNodeLike): boolean {
  if (!left) return false;
  if (left.id !== undefined && right.id !== undefined) return left.id === right.id;
  return left.type === right.type && left.startIndex === right.startIndex && left.endIndex === right.endIndex;
}

/** The declaration whose header parameter list declares `binding`, or null for every other binding. */
export function headerParameterOwner(binding: Binding | null | undefined): SyntaxNodeLike | null {
  return binding?.kind === "param" && binding.node ? headerParameterOwnerOf("csharp", binding.node) : null;
}

/** The name node of the header parameter of `owner` that `name` spells. */
function headerParameterNamed(owner: SyntaxNodeLike, name: string): SyntaxNodeLike | null {
  if (!HEADER_PARAMETERS?.declarationTypes.has(owner.type)) return null;
  const wanted = normalizeCsharpIdentifier(name);
  const list = owner.namedChildren.find((child) => HEADER_PARAMETERS.listTypes.has(child.type));
  for (const parameter of list?.namedChildren ?? []) {
    const nameNode = parameter.childForFieldName("name");
    if (nameNode && normalizeCsharpIdentifier(nameNode.text) === wanted) return nameNode;
  }
  return null;
}

/** Whether `use` sits in the initializer of a field or property: where a parameter binds before the members. */
function inMemberInitializer(use: SyntaxNodeLike, member: SyntaxNodeLike): boolean {
  if (member.type === "property_declaration") {
    const value = member.childForFieldName("value");
    // An expression-bodied property is a getter body; only `= value` is an initializer.
    return (
      !!value &&
      value.type !== "arrow_expression_clause" &&
      value.startIndex <= use.startIndex &&
      use.endIndex <= value.endIndex
    );
  }
  if (member.type !== "field_declaration" && member.type !== "event_field_declaration") return false;
  for (let current = use.parent; current && !sameNode(current, member); current = current.parent) {
    if (current.type === "variable_declarator") return true;
  }
  return false;
}

/** How `use` reads a parameter declared in the header of `owner`. */
export function headerParameterContext(use: SyntaxNodeLike, owner: SyntaxNodeLike): HeaderParameterContext {
  if (isCsharpMemberDesignator(use)) return "designator";
  const body = owner.childForFieldName("body");
  if (!body || use.startIndex < body.startIndex || use.endIndex > body.endIndex) return "header";
  let member: SyntaxNodeLike = use;
  while (member.parent && !sameNode(member.parent, body)) member = member.parent;
  return inMemberInitializer(use, member) ? "initializer" : "member";
}

/**
 * Whether `name` is the declared name of a field, event field, or property directly in the body of `owner`: the members
 * an initializer's parameter read outranks. A lambda, pattern, or `out` variable of an initializer is nearer than the
 * parameter and never one.
 */
function namesBodyMember(name: SyntaxNodeLike, owner: SyntaxNodeLike): boolean {
  const declarator = name.parent;
  const declaration = declarator?.type === "variable_declarator" ? declarator.parent?.parent : declarator;
  if (!declaration || !BODY_MEMBER_TYPES.has(declaration.type)) return false;
  return sameNode(declaration.parent?.parent, owner);
}

/** A stop: a binder the scope index does not model sits between the use and the parameter or member the lookup picks. */
function unmodeledBinderStop(state: NameLookupState, owner: SyntaxNodeLike): NameResolution | undefined {
  const wanted = normalizeCsharpIdentifier(state.lookupName);
  if (!csharpShadowedByUnmodeledBinder(state.use.parsed.tree, state.use.node, owner, wanted)) return undefined;
  return { status: "not_found", reason: UNPROVEN_CSHARP_BINDER_REASON };
}

/**
 * The parameter binding a use reads, or a deferred member check, or a stop. `undefined` leaves the lookup to its
 * ordinary order: the closest binding already answers.
 */
export function csharpHeaderParameterUse(state: NameLookupState): NameResolution | undefined {
  const owner = headerParameterOwner(state.closestBinding);
  if (owner) return nearestParameterUse(state, owner);
  return initializerParameterUse(state);
}

/** The closest binding is a header parameter of `owner`: no closer local, parameter, or member of the body. */
function nearestParameterUse(state: NameLookupState, owner: SyntaxNodeLike): NameResolution | undefined {
  const { use, closestBinding } = state;
  const context = headerParameterContext(use.node, owner);
  if (context === "designator") return { status: "not_found", reason: UNPROVEN_CSHARP_MEMBER_DESIGNATOR_REASON };
  const stop = unmodeledBinderStop(state, owner);
  if (stop) return stop;
  if (context !== "member" || !csharpOwnerMayHaveOuterMembers(owner)) return undefined;
  const parameter = closestBinding ? definitionForBinding(closestBinding, use.file, use.node, use.parsed.sup) : null;
  return {
    status: "deferred",
    request: { kind: "csharp-header-parameter-member", lookupName: use.name, owner },
    fallback: parameter ? okGoToResult(use.index, parameter, { resolution: "exact", confidence: "high" }) : null,
  };
}

/** The closest binding is a field or property of the body that shares a header parameter's name, and the use is in an initializer. */
function initializerParameterUse(state: NameLookupState): NameResolution | undefined {
  const { use, closestBinding } = state;
  const declaration = closestBinding?.node;
  const owner = declaration ? nearestMemberContainer(declaration) : null;
  if (!declaration || !owner || !headerParameterNamed(owner, state.lookupName)) return undefined;
  if (!namesBodyMember(declaration, owner)) return undefined;
  if (headerParameterContext(use.node, owner) !== "initializer") return undefined;
  const stop = unmodeledBinderStop(state, owner);
  if (stop) return stop;
  const canonical = normalizeCsharpIdentifier(state.lookupName);
  const parameter = use.scopeIndex.bindings
    .get(canonical)
    ?.find((candidate) => sameNode(headerParameterOwner(candidate), owner));
  const def = parameter ? definitionForBinding(parameter, use.file, use.node, use.parsed.sup) : null;
  return def ? okGoToResult(use.index, def, { resolution: "exact", confidence: "high" }) : undefined;
}
