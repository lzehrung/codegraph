/**
 * Swift additions to member navigation, to the call edges of resolved member calls, and to reference collection. This
 * module imports no navigation module: those import the policy registry, so the helpers it needs arrive as `deps`.
 */
import { supportForFileWithoutHeaderSample } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import {
  isSwiftBareName,
  isSwiftCallee,
  isSwiftInvocableVariable,
  isSwiftShorthandCallee,
  isSwiftShorthandCase,
  swiftCallLabels,
  swiftLabelsFit,
  swiftNameMayBeRebound,
  swiftParametersAcceptLabels,
} from "../../util/swift-tree.js";
import { normalizeSwiftIdentifier } from "../../util/identifiers.js";
import { fileIdentityKey } from "../../util/paths.js";
import { getCompilationUnitPeers } from "../compilation-units.js";
import {
  isPrivateDeclaration,
  isSwiftCrossFileHiddenSharedOwnerMember,
  isSwiftFileHiddenSharedOwnerMember,
} from "../declaration-visibility.js";
import type { ParsedFileContext } from "../parse-context.js";
import { ensureParsedContextForIndex, rethrowStaleQuerySource } from "../parsed-cache.js";
import { getSharedOwnerIdentity, sharedOwnerCanUseMembers } from "../shared-owner-identity.js";
import { SymbolKind, type ProjectIndex, type SymbolDef } from "../types.js";
import type { MemberLookupDeps, MemberLookupPolicy, MemberOwnerRef, MemberUse } from "./types.js";

/** Whether the declaration of the Swift variable `member` proves a call of it: an enum case or a function value. */
async function variableIsInvocable(index: ProjectIndex, member: SymbolDef, deps: MemberLookupDeps): Promise<boolean> {
  try {
    const context = await ensureParsedContextForIndex(index, member.file);
    const name = deps.nameNodeForDef(context, member);
    return !!name && isSwiftInvocableVariable(name);
  } catch (error) {
    rethrowStaleQuerySource(error);
    return false;
  }
}

/** A Swift subscript or plain read names a value; only a call invokes its callee. */
function useOf(memberNode: SyntaxNodeLike): MemberUse {
  return isSwiftCallee(memberNode) ? "call" : "value";
}

/**
 * Swift private members are lexical to their type, its same-file extensions, and the types nested in either (so also
 * an extension of a nested type); fileprivate is file-wide. An extension header names an existing type: it is no
 * member of that type, or of any type that inherits from it.
 */
function swiftMemberVisible(
  useFile: string,
  use: SyntaxNodeLike,
  useContext: ParsedFileContext,
  member: SymbolDef,
  memberContext: ParsedFileContext,
  deps: MemberLookupDeps,
): boolean {
  if (member.swiftExtensionOwner) return false;
  const name = deps.nameNodeForDef(memberContext, member);
  if (!name) return false;
  if (isSwiftCrossFileHiddenSharedOwnerMember("swift", useFile, member.file, name)) return false;
  if (!isPrivateDeclaration("swift", name)) return true;
  if (fileIdentityKey(useFile) !== fileIdentityKey(member.file)) return false;
  const owner = deps.nearestMemberContainer(name);
  if (!owner) return true;
  if (use.startIndex >= owner.startIndex && use.endIndex <= owner.endIndex) return true;
  const useOwner = deps.nearestMemberContainer(use);
  if (!useOwner) return false;
  const memberIdentity = getSharedOwnerIdentity(owner, memberContext.source, "swift", member.file);
  const useIdentity = getSharedOwnerIdentity(useOwner, useContext.source, "swift", useFile);
  if (!memberIdentity || !useIdentity) return false;
  if (sharedOwnerCanUseMembers(useIdentity, memberIdentity)) return true;
  return memberIdentity.swiftConstraint === undefined && useIdentity.fullPath.startsWith(`${memberIdentity.fullPath}.`);
}

type RenameGraph = Parameters<NonNullable<MemberLookupPolicy["renameLinkageUnproven"]>>[0];

/**
 * A Swift witness and a protocol requirement/default can be selected by different
 * static receiver types. Until their complete callable family is proven, do not
 * merge graph members by name or call a concrete-only rename safe.
 */
function swiftProtocolRenameUnproven(graph: RenameGraph, target: SymbolDef, targetId: string): boolean {
  if (target.kind !== SymbolKind.Function) return false;
  if (!graph.nodes.has(targetId)) return !!target.isMember;

  const owners = new Set<string>();
  const namedOwners = new Set<string>();
  const parents = new Map<string, Array<{ id: string; relation: "extends" | "implements" }>>();
  const children = new Map<string, string[]>();
  const protocolRoots = new Set<string>();
  const name = normalizeSwiftIdentifier(target.localName);
  for (const edge of graph.edges) {
    if (edge.label === "member_of") {
      if (edge.from === targetId) owners.add(edge.to);
      const member = graph.nodes.get(edge.from);
      if (member && normalizeSwiftIdentifier(member.name) === name) namedOwners.add(edge.to);
      continue;
    }
    if (edge.label !== "extends" && edge.label !== "implements") continue;
    const bases = parents.get(edge.from);
    const base: { id: string; relation: "extends" | "implements" } = { id: edge.to, relation: edge.label };
    if (bases) bases.push(base);
    else parents.set(edge.from, [base]);
    if (edge.label === "implements") {
      protocolRoots.add(edge.to);
      continue;
    }
    const descendants = children.get(edge.to);
    if (descendants) descendants.push(edge.from);
    else children.set(edge.to, [edge.from]);
  }
  if (!owners.size) return !!target.isMember;

  const protocols = new Set(protocolRoots);
  const protocolQueue = [...protocolRoots];
  for (let cursor = 0; cursor < protocolQueue.length; cursor += 1) {
    for (const parent of parents.get(protocolQueue[cursor]!) ?? []) {
      if (parent.relation !== "extends" || protocols.has(parent.id)) continue;
      protocols.add(parent.id);
      protocolQueue.push(parent.id);
    }
  }
  if ([...owners].some((owner) => protocols.has(owner))) return true;

  const related = new Set(owners);
  const descendants = [...owners];
  for (let cursor = 0; cursor < descendants.length; cursor += 1) {
    for (const child of children.get(descendants[cursor]!) ?? []) {
      if (related.has(child)) continue;
      related.add(child);
      descendants.push(child);
    }
  }
  const ancestors = [...related];
  for (let cursor = 0; cursor < ancestors.length; cursor += 1) {
    for (const parent of parents.get(ancestors[cursor]!) ?? []) {
      if (parent.relation !== "extends" || related.has(parent.id)) continue;
      related.add(parent.id);
      ancestors.push(parent.id);
    }
  }
  const contracts = new Set<string>();
  const queue: string[] = [];
  for (const owner of related) {
    for (const parent of parents.get(owner) ?? []) {
      if (parent.relation !== "implements" || contracts.has(parent.id)) continue;
      contracts.add(parent.id);
      queue.push(parent.id);
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const contract = queue[cursor]!;
    if (namedOwners.has(contract)) return true;
    for (const parent of parents.get(contract) ?? []) {
      if (parent.relation !== "extends" || contracts.has(parent.id)) continue;
      contracts.add(parent.id);
      queue.push(parent.id);
    }
  }
  return false;
}

/**
 * The one enum case or static member `name` that a Swift type declares in its body or its extensions. An `OptionSet`
 * literal element has to name a type that lists `OptionSet` among its bases. A call (`.make(1)`) names an enum case, a
 * function, or a function-valued variable.
 */
async function swiftContextualMember(
  index: ProjectIndex,
  ref: MemberOwnerRef,
  name: string,
  optionSet: boolean,
  labels: readonly string[] | null,
  call: boolean,
  deps: MemberLookupDeps,
): Promise<SymbolDef | undefined> {
  const peers = await deps.resolveSharedOwnerContainers({
    index,
    ownerFile: ref.file,
    ownerContainer: ref.container,
    ownerSource: ref.context.source,
    languageId: "swift",
  });
  const owners = [ref, ...peers];
  const listsOptionSet = (owner: MemberOwnerRef): boolean =>
    owner.container.namedChildren.some(
      (child) => child.type === "inheritance_specifier" && child.text.trim() === "OptionSet",
    );
  if (optionSet && !owners.some(listsOptionSet)) return undefined;
  const members = new Set<SymbolDef>();
  for (const owner of owners) {
    const normalize = owner.context.sup.normalizeIdentifier;
    for (const local of deps.findDirectLocalsWithinNode(
      owner.module.locals,
      name,
      owner.container,
      owner.context,
      normalize,
    )) {
      const nameNode = deps.nameNodeForDef(owner.context, local);
      const isCase = nameNode?.parent?.type === "enum_entry";
      const isValue = local.kind === SymbolKind.Variable || local.kind === SymbolKind.Function;
      const parameters = local.kind === SymbolKind.Function ? local.callable?.swiftParameters : undefined;
      // Argument labels pick among same-named static functions without ranking their types.
      const labelsFit = !labels || !parameters || swiftParametersAcceptLabels(parameters, labels);
      // A variable holds a value, so a call names it only when its declaration is a function.
      const callFits =
        !call || local.kind === SymbolKind.Function || (!!nameNode && isSwiftInvocableVariable(nameNode));
      const staticValue =
        isValue && labelsFit && callFits && deps.hasStaticModifier(local, owner.context, owner.container);
      if (isCase || staticValue) members.add(local);
    }
  }
  return members.size === 1 ? [...members][0] : undefined;
}

/**
 * A static or class variable or function of a type: the leading-dot names a bare lookup may keep without a context. A
 * call (`.make(1)`) can only name a function or a function-valued variable.
 */
async function isSwiftStaticMember(
  index: ProjectIndex,
  def: SymbolDef,
  call: boolean,
  deps: MemberLookupDeps,
): Promise<boolean> {
  const isValue = def.kind === SymbolKind.Variable || def.kind === SymbolKind.Function;
  // A resolution's definition omits `isMember`; the indexed local carries it.
  const local = index.byFile
    .get(fileIdentityKey(def.file))
    ?.locals.find(
      (candidate) => candidate.range.start.index === def.range.start.index && candidate.localName === def.localName,
    );
  if (!local?.isMember || !isValue) return false;
  let context: ParsedFileContext;
  try {
    context = await ensureParsedContextForIndex(index, def.file);
  } catch (error) {
    rethrowStaleQuerySource(error);
    return false;
  }
  const name = deps.nameNodeForDef(context, def);
  const container = name ? deps.nearestMemberContainer(name) : null;
  if (!name || !container || name.parent?.type === "enum_entry") return false;
  if (!deps.hasStaticModifier(def, context, container)) return false;
  if (!call) return true;
  // The lookup that found a function already judged its labels, so a function is callable.
  return def.kind === SymbolKind.Function || isSwiftInvocableVariable(name);
}

const NO_ASSOCIATED_TYPES: ReadonlySet<string> = new Set();
/** Associated-type names of one owner, reused across the overload pairs of one index. */
const associatedTypesByIndex = new WeakMap<ProjectIndex, Map<string, ReadonlySet<string>>>();
/** Protocol refinement is shallow; the cap only stops a cyclic base clause. */
const SWIFT_ASSOCIATED_TYPE_WALK_LIMIT = 32;

/** Dotted type chains in a parameter spelling, whitespace already removed. */
function swiftTypeChains(type: string): RegExpMatchArray[] {
  return [...type.matchAll(/[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*/gu)];
}

function typeChainHead(chain: string): string {
  const dot = chain.indexOf(".");
  return dot < 0 ? chain : chain.slice(0, dot);
}

function typeMentionsStandIn(type: string, standIns: ReadonlySet<string>): boolean {
  return swiftTypeChains(type).some((chain) => standIns.has(typeChainHead(chain[0])));
}

/** Advance past one Swift type in `text` from `start`, keeping `()`, `[]`, `<>` balanced. */
function advanceSwiftType(text: string, start: number, nextLiteral: string): number {
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i]!;
    if (paren === 0 && bracket === 0 && angle === 0) {
      if (nextLiteral && text.startsWith(nextLiteral, i)) break;
      if (ch === "," || ch === ")" || ch === "]" || ch === ">" || ch === ":" || ch === "=") break;
    }
    if (ch === "(") paren += 1;
    else if (ch === ")") {
      if (paren === 0) break;
      paren -= 1;
    } else if (ch === "[") bracket += 1;
    else if (ch === "]") {
      if (bracket === 0) break;
      bracket -= 1;
    } else if (ch === "<") angle += 1;
    else if (ch === ">") {
      if (angle === 0) break;
      angle -= 1;
    }
    i += 1;
  }
  return i > start && paren === 0 && bracket === 0 && angle === 0 ? i : -1;
}

/**
 * Whether `derived` fills `inherited` when each stand-in chain (`Item`, `Self`, `T`) matches one balanced Swift type
 * without crossing unenclosed punctuation such as tuple or generic commas.
 */
function inheritedTypeFits(inherited: string, derived: string, standIns: ReadonlySet<string>): boolean {
  const tokens: Array<{ kind: "lit"; text: string } | { kind: "standin" }> = [];
  let cursor = 0;
  for (const chain of swiftTypeChains(inherited)) {
    const text = chain[0];
    const at = chain.index ?? cursor;
    if (at > cursor) tokens.push({ kind: "lit", text: inherited.slice(cursor, at) });
    tokens.push(standIns.has(typeChainHead(text)) ? { kind: "standin" } : { kind: "lit", text });
    cursor = at + text.length;
  }
  if (cursor < inherited.length) tokens.push({ kind: "lit", text: inherited.slice(cursor) });

  const matchAt = (tokIndex: number, pos: number): boolean => {
    if (tokIndex === tokens.length) return pos === derived.length;
    const token = tokens[tokIndex]!;
    if (token.kind === "lit") {
      return derived.startsWith(token.text, pos) && matchAt(tokIndex + 1, pos + token.text.length);
    }
    const next = tokens[tokIndex + 1];
    const nextLit = next?.kind === "lit" ? next.text : "";
    const end = advanceSwiftType(derived, pos, nextLit);
    return end > pos && matchAt(tokIndex + 1, end);
  };
  return matchAt(0, 0);
}

function addAssociatedTypeNames(protocol: SyntaxNodeLike, names: Set<string>): void {
  const body =
    protocol.childForFieldName("body") ?? protocol.namedChildren.find((child) => child.type === "protocol_body");
  const members = body ? body.namedChildren : protocol.namedChildren;
  for (const member of members) {
    if (member.type !== "associatedtype_declaration") continue;
    const name =
      member.childForFieldName("name") ?? member.namedChildren.find((part) => part.type === "type_identifier");
    if (name) names.add(name.text);
  }
}

/** Associated types of the protocol that declares `start`, and of the project protocols it refines. */
async function protocolAssociatedTypeNames(
  index: ProjectIndex,
  start: MemberOwnerRef,
  deps: MemberLookupDeps,
): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  const seen = new Set<string>();
  const peers = await deps.resolveSharedOwnerContainers({
    index,
    ownerFile: start.file,
    ownerContainer: start.container,
    ownerSource: start.context.source,
    languageId: "swift",
  });
  const queue = [start, ...peers];
  for (let cursor = 0; cursor < queue.length && cursor < SWIFT_ASSOCIATED_TYPE_WALK_LIMIT; cursor += 1) {
    const current = queue[cursor]!;
    const id = `${fileIdentityKey(current.file)}:${current.container.startIndex}:${current.container.endIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (current.container.type !== "protocol_declaration") continue;
    addAssociatedTypeNames(current.container, names);
    const bases = await deps.baseOwnersOf(index, current);
    for (const base of bases) queue.push(base);
  }
  return names;
}

async function swiftAssociatedTypeNames(
  index: ProjectIndex,
  inherited: SymbolDef,
  deps: MemberLookupDeps,
): Promise<ReadonlySet<string>> {
  let owner: MemberOwnerRef | null;
  try {
    owner = await deps.keywordClassRefFromDef(index, inherited);
  } catch (error) {
    rethrowStaleQuerySource(error);
    return NO_ASSOCIATED_TYPES;
  }
  if (!owner) return NO_ASSOCIATED_TYPES;
  const key = `${fileIdentityKey(owner.file)}:${owner.container.startIndex}:${owner.container.endIndex}`;
  let byOwner = associatedTypesByIndex.get(index);
  if (!byOwner) {
    byOwner = new Map();
    associatedTypesByIndex.set(index, byOwner);
  }
  const cached = byOwner.get(key);
  if (cached) return cached;
  const names = await protocolAssociatedTypeNames(index, owner, deps);
  byOwner.set(key, names);
  return names;
}

/**
 * A parameter the inherited member spells with `Self`, an associated type, or a generic parameter is the same
 * signature as the witness's spelling of that position. `undefined` when the spelling names none of those.
 */
async function swiftGenericParameterFit(
  index: ProjectIndex,
  inherited: SymbolDef,
  inheritedType: string,
  derivedType: string,
  typeParameters: ReadonlySet<string>,
  deps: MemberLookupDeps,
): Promise<boolean | undefined> {
  const standIns = new Set(typeParameters);
  standIns.add("Self");
  if (inheritedType === derivedType) {
    if (typeMentionsStandIn(inheritedType, standIns)) return true;
    return undefined;
  }
  if (!typeMentionsStandIn(inheritedType, standIns)) {
    const associated = await swiftAssociatedTypeNames(index, inherited, deps);
    if (!associated.size) return undefined;
    for (const name of associated) standIns.add(name);
    if (!typeMentionsStandIn(inheritedType, standIns)) return undefined;
  }
  return inheritedTypeFits(inheritedType, derivedType, standIns);
}

export const swiftMemberLookupPolicy: MemberLookupPolicy = {
  async callEdge(index, member, callee, source, deps) {
    // A call of a type constructs it.
    if (deps.declaresMembers(member)) return "instantiates";
    if (!deps.memberAcceptsCallAt(index, member, callee, source, "swift")) return null;
    // A property holds a value, so a call of that name is another declaration's unless the property is a function.
    if (member.kind === SymbolKind.Variable && !(await variableIsInvocable(index, member, deps))) return null;
    return "calls";
  },
  dottedCallsUseMemberLookup: true,
  qualifiedConstruction: true,
  isStaticDeclaration: (node) => node.type === "enum_entry",
  parametersAreDirectChildren: (declaration) =>
    declaration.type === "function_declaration" || declaration.type === "protocol_function_declaration",
  genericParameterFit: ({ index, inherited, inheritedType, derivedType, typeParameters, deps }) =>
    swiftGenericParameterFit(index, inherited, inheritedType, derivedType, typeParameters, deps),
  verifiesCallableReferences: true,
  async hidesMemberFromFile(index, file, expected, hasEquivalents) {
    if (!expected.isMember || hasEquivalents || fileIdentityKey(file) === fileIdentityKey(expected.file)) return false;
    try {
      const declaration = await ensureParsedContextForIndex(index, expected.file);
      const start = expected.range.start.index;
      if (start === undefined) return false;
      const name = declaration.tree.rootNode.descendantForIndex(start, expected.range.end.index ?? start);
      return isSwiftFileHiddenSharedOwnerMember("swift", name);
    } catch (error) {
      rethrowStaleQuerySource(error);
      return false;
    }
  },
  visibleThroughUnit(index, file, definitions) {
    const peers = [...getCompilationUnitPeers(index, file).files].map((peer) => fileIdentityKey(peer));
    return definitions.some((definition) => peers.includes(fileIdentityKey(definition.file)));
  },
  // Swift has no cross-language member binding. A same-named unresolved Swift use can make coverage partial only for
  // a visible Swift unit candidate.
  uncertaintyRelevant(index, expected, equivalents, definitionVisible) {
    const isSwiftFile = (definition: SymbolDef): boolean =>
      supportForFileWithoutHeaderSample(definition.file, index.languageExtensions)?.id === "swift";
    return (isSwiftFile(expected) || equivalents.some(isSwiftFile)) && definitionVisible();
  },
  unprovenReference: (node, reason) => isSwiftShorthandCase(node) && reason === "Swift enum case type is unproven",
  async contextualMember(index, target, use, deps) {
    const labels = swiftCallLabels(use.node);
    const call = isSwiftShorthandCallee(use.node);
    let ref: MemberOwnerRef | null;
    if ("owner" in target) {
      const nominal = await deps.typeAliasTarget(index, target.owner);
      ref = nominal ? await deps.keywordClassRefFromDef(index, nominal) : null;
    } else {
      ref = await deps.keywordClassRefFromNode(index, target.mod, target.node);
    }
    return ref ? await swiftContextualMember(index, ref, use.name, use.optionSet, labels, call, deps) : undefined;
  },
  async staticFallbackFits(index, definition, node, deps) {
    return await isSwiftStaticMember(index, definition, isSwiftShorthandCallee(node), deps);
  },
  renameLinkageUnproven(graph, target, targetId) {
    if (!swiftProtocolRenameUnproven(graph, target, targetId)) return undefined;
    return {
      unsupportedReason: "Swift protocol witness linkage is unproven.",
      ambiguityReason: "Swift protocol requirement or default linkage is not proven for rename.",
    };
  },
  async nestedMember(index, owner, name, deps) {
    return deps.declaresMembers(owner) ? await deps.nestedTypeOf(index, owner, name) : undefined;
  },
  useOf,
  memberAccessRules({ memberNode, receiverIsStaticType, receiver }) {
    const unbound = receiverIsStaticType && !isSwiftCallee(memberNode);
    return {
      anyScope: unbound,
      use: unbound ? "unbound" : useOf(memberNode),
      receiverNamesNoType: receiver.kind === SymbolKind.Variable,
      missReason: "No matching Swift member definition",
      unnameableMember: (member, isStatic) =>
        unbound && !member.callable && !isStatic() ? "No matching Swift static member definition" : undefined,
    };
  },
  async memberWalk({ index, mod, node, member, start, deps }) {
    const labels = swiftCallLabels(node);
    const useContext = await ensureParsedContextForIndex(index, mod.file);
    const normalize = start.context.sup.normalizeIdentifier;
    return {
      spansHierarchy: true,
      memberVisible: (hit, hitContext) => swiftMemberVisible(mod.file, node, useContext, hit, hitContext, deps),
      async afterOwnerMatches(owner, walkStart, matches, visible, scopeByMember) {
        if (owner.container.type !== "protocol_declaration") return;
        for (const requirement of matches) {
          if (fileIdentityKey(requirement.file) !== fileIdentityKey(owner.file)) continue;
          const requirementNode = deps.nameNodeForDef(owner.context, requirement);
          if (!visible.has(requirement) || requirementNode?.parent?.type !== "protocol_function_declaration") continue;
          for (const implementation of matches) {
            if (implementation === requirement || !visible.has(implementation)) continue;
            if (scopeByMember.get(implementation) !== scopeByMember.get(requirement)) continue;
            if (!(await deps.sameParameterTypes(index, implementation, requirement))) continue;
            if (walkStart.container.type === "protocol_declaration") {
              visible.delete(implementation);
            } else {
              visible.delete(requirement);
              break;
            }
          }
        }
      },
      selectionUse(visible, use, scopeByMember) {
        if (use === "unbound") {
          // An unapplied `Type.member` cannot name an instance property.
          for (const def of visible) {
            if (def.kind === SymbolKind.Variable && scopeByMember.get(def) === "instance") visible.delete(def);
          }
          return use;
        }
        if (use !== "call" && use !== "value") return use;
        // A call names a callable and a read names a property, across every level of the hierarchy the walk visited.
        const wantsCallable = use === "call";
        const fitsUse = (def: SymbolDef): boolean => !!def.callable === wantsCallable;
        let someFit = false;
        let someMiss = false;
        for (const def of visible) {
          if (fitsUse(def)) someFit = true;
          else someMiss = true;
        }
        // A pattern, condition, or closure parameter binds a local the scope model does not declare, and a local
        // hides every member of its name: a bare read one of them may bind has no kind to prefer.
        const bareReadMayBeLocal = (): boolean =>
          isSwiftBareName(node) && swiftNameMayBeRebound(node, normalize(member), normalize);
        const hiddenByLocal = someFit && someMiss && use === "value" && bareReadMayBeLocal();
        if (hiddenByLocal) return undefined;
        if (someFit) {
          for (const def of visible) if (!fitsUse(def)) visible.delete(def);
        }
        return use;
      },
      // A Swift type holds one non-function member of a name and kind, so it hides an inherited one: a property
      // hides the property, and a typealias hides the protocol's associatedtype.
      hidesInherited: (a, b) => a.kind === b.kind && !a.callable && !b.callable,
      acceptsCall(def) {
        const parameters = def.callable?.swiftParameters;
        return !labels || !parameters || swiftParametersAcceptLabels(parameters, labels);
      },
      // A label the call spells wrongly proves another declaration; a wrong argument count does not.
      fitsCall(def) {
        const parameters = def.callable?.swiftParameters;
        return !labels || !parameters || swiftLabelsFit(parameters, labels);
      },
      standInAtFirstDeclaringLevel: true,
    };
  },
  lexicalBinding(lookup) {
    if (lookup.scopeBindingIsImport()) return null;
    return lookup.binding();
  },
};
