import type { CallableArity, CallableIdentity } from "../languages/callable-arity.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import type { SymbolDef } from "./types.js";
import { typescriptCollapsedOverloadTarget } from "./ts-callables.js";
import { foldPhpIdentifierCase } from "../util/identifiers.js";

export type MemberScope = "any" | "static" | "instance";
/** Decode escapes within an already parsed ECMAScript private identifier token. */
export function ecmaPrivateNameKey(name: string): string {
  if (!name.includes("\\")) return name;
  return name.replace(
    /\\u(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/gu,
    (escape: string, braced?: string, fixed?: string) => {
      const hex = braced ?? fixed;
      if (!hex) return escape;
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : escape;
    },
  );
}

type PrivateNameResolution =
  | { status: "resolved"; definitions: SymbolDef[]; target: SymbolDef | null; owner: SyntaxNodeLike }
  | { status: "ambiguous"; owner: SyntaxNodeLike }
  | { status: "not_found" };

/** Accessor and static modifiers are syntax children before the private declaration's name. */
function privateMemberModifiers(
  declaration: SyntaxNodeLike,
  name: SyntaxNodeLike,
): { accessor: "get" | "set" | null; isStatic: boolean } {
  let accessor: "get" | "set" | null = null;
  let isStatic = false;
  for (let index = 0; ; index += 1) {
    const child = declaration.child(index);
    if (!child || child.startIndex >= name.startIndex) break;
    if (child.type === "get" || child.type === "set") accessor = child.type;
    if (child.type === "static") isStatic = true;
  }
  return { accessor, isStatic };
}

/**
 * Private names belong to the nearest enclosing class body that declares them, independently of
 * the receiver's type. An unindexed or conflicting declaration still shadows outer classes.
 */
export function resolveEcmaPrivateName(
  node: SyntaxNodeLike,
  locals: readonly SymbolDef[],
  requestedName?: string,
): PrivateNameResolution {
  if (node.type !== "private_property_identifier") return { status: "not_found" };
  const name = ecmaPrivateNameKey(requestedName ?? node.text);
  for (let body = node.parent; body; body = body.parent) {
    if (body.type !== "class_body") continue;
    const definitions: SymbolDef[] = [];
    const accessorKinds: string[] = [];
    let overloadStatic: boolean | undefined;
    let validOverloadGroup = true;
    for (const member of body.namedChildren) {
      const declaredName = member.childForFieldName("name") ?? member.childForFieldName("property");
      if (declaredName?.type !== "private_property_identifier") continue;
      if (ecmaPrivateNameKey(declaredName.text) !== name) continue;
      const definition = locals.find(
        (local) =>
          local.range.start.index === declaredName.startIndex && local.range.end.index === declaredName.endIndex,
      );
      if (!definition) return { status: "ambiguous", owner: body };
      definitions.push(definition);
      const { accessor, isStatic } = privateMemberModifiers(member, declaredName);
      if (accessor) accessorKinds.push(`${isStatic ? "static:" : "instance:"}${accessor}`);
      if (overloadStatic === undefined) overloadStatic = isStatic;
      if (overloadStatic !== isStatic) validOverloadGroup = false;
      const signature = member.type === "method_signature" && definition.callable?.role === "signature";
      const implementation = member.type === "method_definition" && definition.callable?.role === "implementation";
      if (accessor || (!signature && !implementation)) validOverloadGroup = false;
    }
    if (!definitions.length) continue;
    if (definitions.length === 1) return { status: "resolved", definitions, target: definitions[0]!, owner: body };
    const instanceAccessorPair = accessorKinds.includes("instance:get") && accessorKinds.includes("instance:set");
    const staticAccessorPair = accessorKinds.includes("static:get") && accessorKinds.includes("static:set");
    const accessorPair = definitions.length === 2 && (instanceAccessorPair || staticAccessorPair);
    if (accessorPair) return { status: "resolved", definitions, target: null, owner: body };
    if (validOverloadGroup) {
      const implementation = typescriptCollapsedOverloadTarget(definitions, (definition) => definition.callable);
      if (implementation) return { status: "resolved", definitions, target: implementation, owner: body };
    }
    return { status: "ambiguous", owner: body };
  }
  return { status: "not_found" };
}

/** A consumer supplies indexed owners or graph ownership edges without changing lookup order. */
export type MemberModel<Owner, Member> = {
  ownerKey(owner: Owner): string;
  members(owner: Owner): readonly Member[];
  supertypes(owner: Owner, classOnly: boolean): readonly Owner[];
  name(member: Member): string;
  key(member: Member): string;
  callable(member: Member): CallableIdentity | undefined;
  /** Function-valued or potentially callable properties participate without becoming method declarations. */
  invocationArity?(member: Member): CallableArity | null | undefined;
  scope(member: Member): MemberScope;
  visible(member: Member, useFile: string): boolean;
  /** Only needed by languages that inherit otherwise hidden overloads. */
  sameSignature?(derived: Member, inherited: Member): boolean;
  /** Syntax-specific call compatibility beyond argument count; an unproven shape keeps the candidate. */
  acceptsCall?(member: Member): boolean;
};

export type MemberSelection<Member> =
  | { status: "none"; named: false }
  | { status: "unique"; named: true; member: Member }
  | {
      status: "ambiguous";
      named: true;
      /** Every named member rejects the call and none stands in for it: the name is hidden, not contested. */
      inapplicable?: true;
    };

export type MemberSelectionOptions = {
  name: string;
  argumentCount: number | null;
  scope: MemberScope;
  useFile: string;
  phpCaseInsensitive?: boolean;
  separateMemberScopes?: boolean;
  classAncestorsOnly?: boolean;
  startAtAncestor?: boolean;
  keepUniqueArityMismatch?: boolean;
  inheritOverloads?: boolean;
  /** Ruby reopening uses the first indexed declaration for a method name. */
  firstDeclarationWins?: boolean;
  /** Language-specific identifier equality; source names remain unchanged. */
  normalizeIdentifier?: ((name: string) => string) | undefined;
  /** A call prefers methods and invokable properties; a value read prefers non-method members. */
  callSite?: boolean;
  valueRead?: boolean;
};

/** Static and instance members have independent lookup chains in these languages. */
const SEPARATE_MEMBER_SCOPES = new Set(["js", "ts", "tsx", "ruby", "swift", "kotlin"]);

export function hasSeparateMemberScopes(languageId: string): boolean {
  return SEPARATE_MEMBER_SCOPES.has(languageId);
}
const MAX_DEPTH = 16;

/** Java, Kotlin, and C# inherit overloads beyond the first declaring class. */
export function inheritsMemberOverloads(languageId: string): boolean {
  return languageId === "java" || languageId === "kotlin" || languageId === "csharp";
}

function accepts(range: CallableArity | null | undefined, count: number | null): boolean {
  return count === null || !range || (count >= range.minArgs && (range.maxArgs === null || count <= range.maxArgs));
}
/** A Kotlin property is invokable when its declared function type or initializer proves it. */
export function kotlinPropertyInvocationArity(nameNode: SyntaxNodeLike): CallableArity | null | undefined {
  const variable = nameNode.parent;
  if (variable?.type !== "variable_declaration" || variable.parent?.type !== "property_declaration") return undefined;
  const type = variable.namedChildren.find((child) => child.type === "function_type");
  const parameters = type?.namedChildren.find((child) => child.type === "function_type_parameters");
  if (parameters) {
    const count = parameters.namedChildren.length;
    return { minArgs: count, maxArgs: count };
  }
  const initializer = variable.parent.namedChildren.find((child) => child !== variable);
  if (initializer?.type === "callable_reference") return null;
  if (initializer?.type !== "lambda_literal") return undefined;
  const lambdaParameters = initializer.namedChildren.find((child) => child.type === "lambda_parameters");
  if (!lambdaParameters) return null;
  const count = lambdaParameters.namedChildren.length;
  return { minArgs: count, maxArgs: count };
}

/**
 * An ECMAScript field or property with no proven non-callable annotation hides inherited methods.
 * Named types may alias functions; missing annotations, function types, `any`, and `unknown` prove no exclusion.
 */
export function ecmaPropertyMayBeCallable(nameNode: SyntaxNodeLike): boolean {
  const declaration = nameNode.parent;
  if (
    declaration?.type !== "property_signature" &&
    declaration?.type !== "public_field_definition" &&
    declaration?.type !== "field_definition"
  )
    return false;
  const name = declaration.childForFieldName("name") ?? declaration.childForFieldName("property");
  if (name?.id !== nameNode.id) return false;
  let type = declaration.childForFieldName("type");
  while (type?.type === "type_annotation" || type?.type === "parenthesized_type") {
    type = type.namedChildren.find((child) => child.type !== "comment") ?? null;
  }
  if (type?.type === "predefined_type") return type.text === "any" || type.text === "unknown";
  return type?.type !== "literal_type" && type?.type !== "array_type" && type?.type !== "tuple_type";
}

const ECMA_NON_CALLABLE_INITIALIZER_TYPES: Readonly<Record<string, true>> = {
  number: true,
  string: true,
  true: true,
  false: true,
  null: true,
  regex: true,
  array: true,
  object: true,
  template_string: true,
};

/** A literal field value can hide a method without proving a callable graph target. */
export function ecmaPropertyHasNonCallableInitializer(nameNode: SyntaxNodeLike): boolean {
  const value = nameNode.parent?.childForFieldName("value");
  return !!value && !!ECMA_NON_CALLABLE_INITIALIZER_TYPES[value.type];
}

/** Fold equivalent declarations only after their overload signatures have been checked. */
function distinctCandidates<Owner, Member>(
  candidates: readonly Member[],
  model: MemberModel<Owner, Member>,
  count: number | null,
): readonly Member[] {
  if (candidates.length < 2) return candidates;
  const groups = new Map<string, Member[]>();
  for (const member of candidates) {
    const key = model.key(member);
    const group = groups.get(key);
    if (group) group.push(member);
    else groups.set(key, [member]);
  }
  const selected: Member[] = [];
  for (const group of groups.values()) {
    const implementation = group.filter((member) => model.callable(member)?.role === "implementation");
    if (implementation.length === 1 && group.length > 1) {
      const signatures = group.filter((member) => model.callable(member)?.role === "signature");
      if (signatures.length && !signatures.some((member) => accepts(model.callable(member)?.arity, count))) continue;
      selected.push(implementation[0]!);
      continue;
    }
    if (group.length > 1 && group.some((member) => model.callable(member)?.role)) {
      selected.push(...group);
      continue;
    }
    selected.push(group[0]!);
  }
  return selected;
}

/** A call keeps function-valued properties beside methods, while a plain read still names the property. */
function preferByUse<Owner, Member>(
  candidates: readonly Member[],
  model: MemberModel<Owner, Member>,
  options: MemberSelectionOptions,
): readonly Member[] {
  if (candidates.length < 2 || (!options.callSite && !options.valueRead)) return candidates;
  const matching = candidates.filter((member) =>
    options.callSite
      ? !!model.callable(member) || model.invocationArity?.(member) !== undefined
      : !model.callable(member),
  );
  return matching.length ? matching : candidates;
}

function memberNameMatches<Owner, Member>(
  member: Member,
  model: MemberModel<Owner, Member>,
  options: MemberSelectionOptions,
  queryName: string,
): boolean {
  const name = model.name(member);
  if (!options.phpCaseInsensitive) {
    if (name === queryName) return true;
    return options.normalizeIdentifier ? options.normalizeIdentifier(name) === queryName : false;
  }
  if (model.callable(member)) return foldPhpIdentifierCase(name) === queryName;
  if (name === options.name) return true;
  return name.startsWith("$") && !options.name.startsWith("$") && name.slice(1) === options.name;
}
/** A hidden ancestor makes a mismatched shallow declaration no longer the only candidate. */
function hasNamedAncestor<Owner, Member>(
  level: readonly Owner[],
  model: MemberModel<Owner, Member>,
  options: MemberSelectionOptions,
  queryName: string,
): boolean {
  const seen = new Set(level.map((owner) => model.ownerKey(owner)));
  let parents = level.flatMap((owner) => model.supertypes(owner, false));
  for (let depth = 0; depth < MAX_DEPTH && parents.length; depth += 1) {
    const next: Owner[] = [];
    for (const owner of parents) {
      const key = model.ownerKey(owner);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const member of model.members(owner)) {
        if (
          memberNameMatches(member, model, options, queryName) &&
          model.visible(member, options.useFile) &&
          (!options.separateMemberScopes || options.scope === "any" || model.scope(member) === options.scope)
        )
          return true;
      }
      next.push(...model.supertypes(owner, false));
    }
    parents = next;
  }
  return false;
}
/** Level-order member lookup shared by navigation and the detailed call graph. */
export function selectMember<Owner, Member>(
  starts: readonly Owner[],
  model: MemberModel<Owner, Member>,
  options: MemberSelectionOptions,
): MemberSelection<Member> {
  let level = options.startAtAncestor ? starts.flatMap((owner) => model.supertypes(owner, true)) : [...starts];
  const visited = new Set(starts.map((owner) => model.ownerKey(owner)));
  const overloadState: {
    subclasses: Map<string, Set<string>>;
    declarations: Array<{ member: Member; owner: string }>;
    accepted: Array<{ member: Member; owner: string }>;
  } | null = options.inheritOverloads ? { subclasses: new Map(), declarations: [], accepted: [] } : null;
  let lenient: Member | undefined;
  let named = false;
  const queryName = options.phpCaseInsensitive
    ? foldPhpIdentifierCase(options.name)
    : (options.normalizeIdentifier?.(options.name) ?? options.name);
  for (let depth = 0; depth < MAX_DEPTH && level.length; depth += 1) {
    const candidates: Member[] = [];
    const owners = overloadState ? new Map<Member, string>() : undefined;
    for (const owner of level) {
      const ownerKey = model.ownerKey(owner);
      for (const member of model.members(owner)) {
        if (!memberNameMatches(member, model, options, queryName) || !model.visible(member, options.useFile)) continue;
        const matchesScope = options.scope === "any" || model.scope(member) === options.scope;
        if (matchesScope || !options.separateMemberScopes) named = true;
        if (matchesScope) {
          candidates.push(member);
          owners?.set(member, ownerKey);
        }
        if (options.firstDeclarationWins && (matchesScope || !options.separateMemberScopes)) break;
      }
    }
    const distinct = distinctCandidates(candidates, model, options.argumentCount);
    const byUse = preferByUse(distinct, model, options);
    const unique = model.acceptsCall ? byUse.filter((member) => model.acceptsCall?.(member)) : byUse;
    if (!overloadState) {
      if (named) {
        let match: Member | undefined;
        for (const member of unique) {
          const arity = model.callable(member)?.arity ?? model.invocationArity?.(member);
          if (!accepts(arity, options.argumentCount)) continue;
          if (match !== undefined) return { status: "ambiguous", named: true };
          match = member;
        }
        if (match !== undefined) return { status: "unique", named: true, member: match };
        // No member accepts the call. A lone mismatched member still stands in for it unless an ancestor declares
        // the name too, which leaves the target open instead of proving the name hidden.
        const loneArityMismatch =
          options.keepUniqueArityMismatch && unique.length === 1 && (!model.invocationArity || distinct.length === 1);
        if (loneArityMismatch) {
          if (hasNamedAncestor(level, model, options, queryName)) return { status: "ambiguous", named: true };
          return { status: "unique", named: true, member: unique[0]! };
        }
        return { status: "ambiguous", named: true, inapplicable: true };
      }
    }
    if (overloadState) {
      for (const member of unique) {
        const owner = owners?.get(member) ?? "";
        const descendants = overloadState.subclasses.get(owner);
        if (
          overloadState.declarations.some(
            (entry) => descendants?.has(entry.owner) && model.sameSignature?.(entry.member, member),
          )
        )
          continue;
        overloadState.declarations.push({ member, owner });
        const arity = model.callable(member)?.arity ?? model.invocationArity?.(member);
        if (accepts(arity, options.argumentCount)) {
          overloadState.accepted.push({ member, owner });
        }
      }
      if (
        lenient === undefined &&
        depth === 0 &&
        options.keepUniqueArityMismatch &&
        unique.length === 1 &&
        (!model.invocationArity || distinct.length === 1)
      )
        lenient = unique[0];
    }
    const next: Owner[] = [];
    for (const owner of level) {
      const child = model.ownerKey(owner);
      for (const parent of model.supertypes(owner, !!options.classAncestorsOnly || !!options.startAtAncestor)) {
        const key = model.ownerKey(parent);
        if (overloadState) {
          const descendants = overloadState.subclasses.get(key) ?? new Set<string>();
          descendants.add(child);
          for (const descendant of overloadState.subclasses.get(child) ?? []) descendants.add(descendant);
          overloadState.subclasses.set(key, descendants);
        }
        if (visited.has(key)) continue;
        visited.add(key);
        next.push(parent);
      }
    }
    level = next;
  }
  if (overloadState?.accepted.length === 1)
    return { status: "unique", named: true, member: overloadState.accepted[0]!.member };
  if (overloadState && overloadState.accepted.length > 1) return { status: "ambiguous", named: true };
  if (lenient !== undefined) return { status: "unique", named: true, member: lenient };
  return named ? { status: "ambiguous", named: true, inapplicable: true } : { status: "none", named: false };
}
