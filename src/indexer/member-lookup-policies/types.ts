/** Types of the per-language member lookup policies in this directory. */
import type { SyntaxNodeLike } from "../../languages/types.js";
import type { MemberScope } from "../member-selection.js";
import type { ParsedFileContext } from "../parse-context.js";
import type { ModuleIndex, ProjectIndex, SymbolDef } from "../types.js";

/** The detailed-graph edge a resolved member call records. */
export type MemberCallEdge = "calls" | "instantiates";

/**
 * How a member name is used at its site. `unbound` is an unapplied `Type.member`, which can name a static member or
 * a method but not an instance property.
 */
export type MemberUse = "call" | "value" | "unbound";

/**
 * Navigation helpers a policy needs but cannot import: the modules that define them import this registry, and a policy
 * that imported them back would close a dependency cycle. Each consumer passes the helpers it already imports.
 */
export type MemberLookupDeps = {
  nameNodeForDef(context: ParsedFileContext, def: SymbolDef): SyntaxNodeLike | null;
  sameParameterTypes(index: ProjectIndex, left: SymbolDef, right: SymbolDef): Promise<boolean>;
  memberAcceptsCallAt(
    index: ProjectIndex,
    member: SymbolDef,
    callee: SyntaxNodeLike,
    source: string,
    languageId: string,
  ): boolean;
  /** The type `name` declared inside the body of the type `owner`, for a language that nests types. */
  nestedTypeOf(index: ProjectIndex, owner: SymbolDef, name: string): Promise<SymbolDef | undefined>;
  declaresMembers(def: SymbolDef): boolean;
  nearestMemberContainer(node: SyntaxNodeLike): SyntaxNodeLike | null;
  keywordClassRefFromDef(index: ProjectIndex, def: SymbolDef): Promise<MemberOwnerRef | null>;
  keywordClassRefFromNode(index: ProjectIndex, mod: ModuleIndex, node: SyntaxNodeLike): Promise<MemberOwnerRef | null>;
  /** The types `owner` inherits from or conforms to that the project declares. */
  baseOwnersOf(index: ProjectIndex, owner: MemberOwnerRef): Promise<MemberOwnerRef[]>;
  resolveSharedOwnerContainers(params: {
    index: ProjectIndex;
    ownerFile: string;
    ownerContainer: SyntaxNodeLike;
    ownerSource: string;
    languageId: string;
  }): Promise<MemberOwnerRef[]>;
  findDirectLocalsWithinNode(
    locals: readonly SymbolDef[],
    name: string,
    container: SyntaxNodeLike,
    context: ParsedFileContext,
    normalize: (name: string) => string,
  ): SymbolDef[];
  hasStaticModifier(local: SymbolDef, context: ParsedFileContext, container: SyntaxNodeLike): boolean;
  /** The type a typealias provably names, or the declaration itself when it is not an alias. */
  typeAliasTarget(index: ProjectIndex, def: SymbolDef): Promise<SymbolDef | undefined>;
};

/** A type that declares members: where it is written, and the syntax of its body. */
export type MemberWalkOwner = { file: string; context: ParsedFileContext; container: SyntaxNodeLike };

/** A type's owner record: where it is written, the syntax of its body, and its module's facts. */
export type MemberOwnerRef = MemberWalkOwner & { module: ModuleIndex };

/** The symbol graph facts a rename linkage check reads. */
export type RenameLinkageGraph = {
  nodes: ReadonlyMap<string, { name: string }>;
  edges: readonly { from: string; to: string; label?: string }[];
};

/** What one language decides inside a member lookup that visits every level of a type hierarchy. */
export type MemberWalkRules = {
  /** Overloads declared at different levels of the hierarchy compete, so the walk visits every level first. */
  spansHierarchy: boolean;
  /** Whether the use may name `member`, whose own file and syntax are `memberContext` (lexical access rules). */
  memberVisible(member: SymbolDef, memberContext: ParsedFileContext): boolean;
  /** Runs after one owner's matching members are collected; may remove members another one of them stands for. */
  afterOwnerMatches(
    owner: MemberWalkOwner,
    start: MemberWalkOwner,
    matches: readonly SymbolDef[],
    visible: Set<SymbolDef>,
    scopeByMember: ReadonlyMap<SymbolDef, MemberScope>,
  ): Promise<void>;
  /** Narrows `visible` to the members the use can name, and returns the use kind the selection may still prefer. */
  selectionUse(
    visible: Set<SymbolDef>,
    use: MemberUse | undefined,
    scopeByMember: ReadonlyMap<SymbolDef, MemberScope>,
  ): MemberUse | undefined;
  /** Whether a member of the type hides an inherited one without matching its signature. */
  hidesInherited(member: SymbolDef, inherited: SymbolDef): boolean;
  /** Whether the call's syntax accepts the member, labels included. */
  acceptsCall(member: SymbolDef): boolean;
  /** Whether the call's syntax fits the member when only its argument count may differ. */
  fitsCall(member: SymbolDef): boolean;
  /** Whether the first level of the hierarchy that declares the name offers the stand-in for a call it does not fit. */
  standInAtFirstDeclaringLevel: boolean;
};

/** What one language decides for `receiver.member` once the receiver names a type or a value. */
export type MemberAccessRules = {
  /** An unapplied `Type.member` reads every member scope, not only the receiver's. */
  anyScope: boolean;
  use: MemberUse | undefined;
  /** The receiver is a variable, which names no type, so its declaration is not a member of one. */
  receiverNamesNoType: boolean;
  /** Set when a failed hierarchy lookup is final: no by-name lookup may bind another declaration. */
  missReason: string | undefined;
  /** Why a member the lookup found cannot be what the use names, if it cannot. */
  unnameableMember(member: SymbolDef, isStatic: () => boolean): string | undefined;
};

export type MemberLookupPolicy = {
  /**
   * The edge a resolved dotted member call records, or `null` when its target cannot be the callee. Without this
   * hook, a target that accepts the call's argument count records `calls`.
   */
  callEdge?(
    index: ProjectIndex,
    member: SymbolDef,
    callee: SyntaxNodeLike,
    source: string,
    deps: MemberLookupDeps,
  ): Promise<MemberCallEdge | null>;
  /** Every dotted call resolves through the shared member lookup, never through the graph's own receiver proofs. */
  dottedCallsUseMemberLookup?: boolean;
  /** A dotted callee (`Outer.Inner(...)`) can name the constructed type, so it is read as a type name. */
  qualifiedConstruction?: boolean;
  /** The file holds no reference to `expected` at all: a member another file hides from it (Swift `fileprivate`). */
  hidesMemberFromFile?(
    index: ProjectIndex,
    file: string,
    expected: SymbolDef,
    hasEquivalents: boolean,
  ): Promise<boolean>;
  /** Whether `file` sees one of `definitions` through its compilation unit, beside its imports. */
  visibleThroughUnit?(index: ProjectIndex, file: string, definitions: readonly SymbolDef[]): boolean;
  /** Whether a same-named use the lookup could not place makes the references of `expected` partial. */
  uncertaintyRelevant?(
    index: ProjectIndex,
    expected: SymbolDef,
    equivalents: readonly SymbolDef[],
    definitionVisible: () => boolean,
  ): boolean;
  /** Whether the lookup's `reason` for an unplaced `node` leaves a reference possible. */
  unprovenReference?(node: SyntaxNodeLike, reason: string | undefined): boolean;
  /** The enum case or static member a leading-dot use selects in the type `target` names (or in the type around a node). */
  contextualMember?(
    index: ProjectIndex,
    target: { owner: SymbolDef } | { mod: ModuleIndex; node: SyntaxNodeLike },
    use: { node: SyntaxNodeLike; name: string; optionSet: boolean },
    deps: MemberLookupDeps,
  ): Promise<SymbolDef | undefined>;
  /** Whether the static member a bare lookup found can be what a context-free leading-dot use at `node` names. */
  staticFallbackFits?(
    index: ProjectIndex,
    definition: SymbolDef,
    node: SyntaxNodeLike,
    deps: MemberLookupDeps,
  ): Promise<boolean>;
  /** Set when renaming `target` may break a requirement or default the graph cannot link to it. */
  renameLinkageUnproven?(
    graph: RenameLinkageGraph,
    target: SymbolDef,
    targetId: string,
  ): { unsupportedReason: string; ambiguityReason: string } | undefined;
  /** Whether a declaration node declares a static member without a `static` modifier (an enum case). */
  isStaticDeclaration?(node: SyntaxNodeLike): boolean;
  /** Whether a callable declaration lists its parameters as its own children, with no parameter-list node. */
  parametersAreDirectChildren?(declaration: SyntaxNodeLike): boolean;
  /**
   * Whether a member that overrides or implements `inherited` fills the parameter position the inherited member spells
   * `inheritedType`, when that spelling names a type its implementer chooses (an associated type, `Self`, a generic
   * parameter): the member spells `derivedType` there. `undefined` when it names none, so the spellings decide.
   */
  genericParameterFit?(args: {
    index: ProjectIndex;
    inherited: SymbolDef;
    inheritedType: string;
    derivedType: string;
    /** The generic parameters the inherited member and the types enclosing it declare. */
    typeParameters: ReadonlySet<string>;
    deps: MemberLookupDeps;
  }): Promise<boolean | undefined>;
  /** A reference scan of a callable verifies each candidate through navigation, because overloads differ in labels. */
  verifiesCallableReferences?: boolean;
  /** The type `name` that a resolved type nests, if the language nests types. */
  nestedMember?(
    index: ProjectIndex,
    owner: SymbolDef,
    name: string,
    deps: MemberLookupDeps,
  ): Promise<SymbolDef | undefined>;
  /** How the member access `memberNode` is used, where the language separates calls from value reads. */
  useOf?(memberNode: SyntaxNodeLike): MemberUse;
  memberAccessRules?(args: {
    memberNode: SyntaxNodeLike;
    receiverIsStaticType: boolean;
    receiver: SymbolDef;
  }): MemberAccessRules;
  memberWalk?(args: {
    index: ProjectIndex;
    mod: ModuleIndex;
    node: SyntaxNodeLike;
    member: string;
    start: MemberWalkOwner;
    deps: MemberLookupDeps;
  }): Promise<MemberWalkRules>;
  /** The declaration a bare receiver name binds, where the language checks the lexical scopes first. */
  lexicalBinding?(lookup: { scopeBindingIsImport(): boolean; binding(): SymbolDef | null }): SymbolDef | null;
};
