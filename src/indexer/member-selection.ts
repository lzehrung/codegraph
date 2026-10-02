import type { CallableArity, CallableIdentity } from "../languages/callable-arity.js";
import { foldPhpIdentifierCase } from "../util/identifiers.js";

export type MemberScope = "any" | "static" | "instance";

/** A consumer supplies indexed owners or graph ownership edges without changing lookup order. */
export type MemberModel<Owner, Member> = {
  ownerKey(owner: Owner): string;
  members(owner: Owner): readonly Member[];
  supertypes(owner: Owner, classOnly: boolean): readonly Owner[];
  name(member: Member): string;
  key(member: Member): string;
  callable(member: Member): CallableIdentity | undefined;
  scope(member: Member): MemberScope;
  visible(member: Member, useFile: string): boolean;
  /** Only needed by languages that inherit otherwise hidden overloads. */
  sameSignature?(derived: Member, inherited: Member): boolean;
};

export type MemberSelection<Member> =
  | { status: "none"; named: false }
  | { status: "unique"; named: true; member: Member }
  | { status: "ambiguous"; named: true };

export type MemberSelectionOptions = {
  name: string;
  argumentCount: number | null;
  scope: MemberScope;
  useFile: string;
  phpCaseInsensitive?: boolean;
  classAncestorsOnly?: boolean;
  startAtAncestor?: boolean;
  keepUniqueArityMismatch?: boolean;
  inheritOverloads?: boolean;
};

const MAX_DEPTH = 16;

function accepts(range: CallableArity | null | undefined, count: number | null): boolean {
  return count === null || !range || (count >= range.minArgs && (range.maxArgs === null || count <= range.maxArgs));
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

function memberNameMatches<Owner, Member>(
  member: Member,
  model: MemberModel<Owner, Member>,
  options: MemberSelectionOptions,
  queryName: string,
): boolean {
  const name = model.name(member);
  if (!options.phpCaseInsensitive) return name === queryName;
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
        if (memberNameMatches(member, model, options, queryName) && model.visible(member, options.useFile)) return true;
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
    accepted: Array<{ member: Member; owner: string }>;
  } | null = options.inheritOverloads ? { subclasses: new Map(), accepted: [] } : null;
  let lenient: Member | undefined;
  let named = false;
  const queryName = options.phpCaseInsensitive ? foldPhpIdentifierCase(options.name) : options.name;
  for (let depth = 0; depth < MAX_DEPTH && level.length; depth += 1) {
    const candidates: Member[] = [];
    const owners = overloadState ? new Map<Member, string>() : undefined;
    for (const owner of level) {
      const ownerKey = model.ownerKey(owner);
      for (const member of model.members(owner)) {
        if (!memberNameMatches(member, model, options, queryName) || !model.visible(member, options.useFile)) continue;
        named = true;
        if (options.scope !== "any" && model.scope(member) !== options.scope) continue;
        candidates.push(member);
        owners?.set(member, ownerKey);
      }
    }
    const unique = distinctCandidates(candidates, model, options.argumentCount);
    if (!overloadState) {
      if (named) {
        let match: Member | undefined;
        for (const member of unique) {
          if (!accepts(model.callable(member)?.arity, options.argumentCount)) continue;
          if (match !== undefined) return { status: "ambiguous", named: true };
          match = member;
        }
        if (match !== undefined) return { status: "unique", named: true, member: match };
        if (
          options.keepUniqueArityMismatch &&
          unique.length === 1 &&
          !hasNamedAncestor(level, model, options, queryName)
        ) {
          return { status: "unique", named: true, member: unique[0]! };
        }
        return { status: "ambiguous", named: true };
      }
    }
    if (overloadState) {
      const matching = unique.filter((member) => accepts(model.callable(member)?.arity, options.argumentCount));
      for (const member of matching) {
        const owner = owners?.get(member) ?? "";
        const descendants = overloadState.subclasses.get(owner);
        if (
          overloadState.accepted.some(
            (entry) => descendants?.has(entry.owner) && model.sameSignature?.(entry.member, member),
          )
        )
          continue;
        overloadState.accepted.push({ member, owner });
      }
      if (lenient === undefined && depth === 0 && options.keepUniqueArityMismatch && unique.length === 1)
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
  return named ? { status: "ambiguous", named: true } : { status: "none", named: false };
}
