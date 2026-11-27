/** Types of the per-language member lookup policies in this directory. */
import type { ReceiverBinding, ReceiverMemberScope } from "../../graphs/symbol-graph-detailed/receiver-types.js";
import type { LanguageSupport } from "../../languages.js";
import type { CallableArity, CallableIdentity, GraphParameterShapes } from "../../languages/callable-arity.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../../languages/types.js";
import type { MemberAccessRow } from "../../util/member-access-tables.js";
import type { FileId, Range } from "../../types.js";
import type { MemberScope, MemberSelectionOptions } from "../member-selection-types.js";
import type { MemberModel } from "../member-selection.js";
import type { JvmTypeNameResolver } from "../name-resolution-types.js";
import type { ImportNameResolutionOptions } from "../import-name-types.js";
import type { ParsedFileContext } from "../parse-context.js";
import type { ScopeIndex } from "../scope-types.js";
import type { ParameterReferenceScanFilter } from "../reference-scan-types.js";
import type {
  GoToResult,
  ImportBinding,
  ModuleIndex,
  ProjectIndex,
  Reference,
  ResolvedExport,
  SymbolDef,
} from "../types.js";
import type { SharedOwnerRules } from "./owner-identity-types.js";
import type { ImplicitReceiverRules, MemberUseSyntax } from "./receiver-syntax-types.js";
import type { PhpObjectCreationKeyword } from "./receiver-operation-types.js";
import type { RubyConstantReference } from "./ruby-owner-types.js";

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
  memberContainerForDefinition(index: ProjectIndex, definition: SymbolDef): SymbolDef | undefined;
  resolveQualifiedCppOwner(
    index: ProjectIndex,
    module: ModuleIndex,
    path: readonly string[],
  ): Promise<SymbolDef | null>;
  resolveRubyConstantReference(
    index: ProjectIndex,
    module: ModuleIndex,
    reference: RubyConstantReference,
  ): SymbolDef | null;
  resolveJvmQualifiedPath(
    index: ProjectIndex,
    useFile: string,
    languageId: "java" | "kotlin",
    owner: SymbolDef | null,
    path: readonly string[],
    typeOnly: boolean,
  ): SymbolDef | null;
  getScopeIndex(
    index: ProjectIndex,
    module: ModuleIndex,
    source: string,
    support: LanguageSupport,
    tree: SyntaxTreeLike,
  ): ScopeIndex;
  pythonImportAtUse(
    module: ModuleIndex,
    node: SyntaxNodeLike,
    source: string,
    tree: SyntaxTreeLike,
    support: LanguageSupport,
    scope: ScopeIndex,
  ): ImportBinding | null | undefined;
  pythonDottedPhraseAtUse(
    index: ProjectIndex,
    module: ModuleIndex,
    node: SyntaxNodeLike,
    phrase: string,
    source: string,
    tree: SyntaxTreeLike,
    support: LanguageSupport,
    scope: ScopeIndex,
  ): string | null | undefined;
  resolveExportPath(
    index: ProjectIndex,
    file: string,
    path: readonly string[],
    support: LanguageSupport,
  ): SymbolDef | undefined;
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
  /** Whether another part or a base may provide a header parameter's property instead of synthesizing it here. */
  headerParameterMayBeInherited(index: ProjectIndex, owner: MemberOwnerRef, name: string): Promise<boolean>;
  /** Existing C# partial-type lookup, including whether every source part can be inspected. */
  sharedOwnerParts(
    index: ProjectIndex,
    owner: MemberOwnerRef,
  ): Promise<{ parts: readonly MemberOwnerRef[]; complete: boolean }>;
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
  /** The type declaration (or typealias) a type name names in `mod`, when the project declares exactly one. */
  resolveTypeContainer(
    index: ProjectIndex,
    mod: ModuleIndex,
    name: string,
    normalize: (name: string) => string,
  ): SymbolDef | undefined;
  /** Appends to `matches` the locals named `name` that `container` declares directly, as keyword lookup reads them. */
  appendDirectKeywordMembers(
    locals: readonly SymbolDef[],
    name: string,
    container: SyntaxNodeLike,
    context: ParsedFileContext,
    normalize: (name: string) => string,
    predicate: ((local: SymbolDef) => boolean) | undefined,
    matches: SymbolDef[],
  ): void;
  /** The selection model of one owner's indexed candidate members, with their callable facts. */
  indexedMemberModel(
    index: ProjectIndex,
    members: readonly SymbolDef[],
    languageId: string,
  ): MemberModel<SymbolDef, SymbolDef>;
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
  /** The bases one part of a type declares reach every other part: a Swift type and its extensions are one type. */
  partsShareBases: boolean;
  /** The owners that a constraint on the owner's own syntax adds as bases: a Swift `where Self: Q` extension. */
  constraintBases(owner: MemberOwnerRef): Promise<MemberOwnerRef[]>;
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

/** Parsed class facts cached by the existing receiver-resolution path. */
export type ReceiverClassRef = {
  def: SymbolDef;
  container: SyntaxNodeLike;
  context: ParsedFileContext;
  module: ModuleIndex;
};

export type ReceiverResolutionCache = {
  classRefs: Map<string, Promise<ReceiverClassRef | null>>;
  members: Map<string, Promise<SymbolDef | undefined>>;
};

/** Arguments already available to positioned member access resolution. */
export type ReceiverAccessContext = {
  index: ProjectIndex;
  mod: ModuleIndex;
  node: SyntaxNodeLike;
  source: string;
  tree: SyntaxTreeLike;
  sup: LanguageSupport;
  scopeIndex?: ScopeIndex;
  resolveLexicalBinding?: (expression: SyntaxNodeLike) => SymbolDef | null;
  resolveJvmTypeName: JvmTypeNameResolver;
  loadParsedFile?: (file: string) => Promise<ParsedFileContext | null>;
  pythonReceiverResolutionCache?: ReceiverResolutionCache;
};

/** Receiver facts and dependencies already available to member navigation. */
export type ReceiverResolutionContext = {
  index: ProjectIndex;
  object: SyntaxNodeLike;
  source: string;
  support: LanguageSupport;
  resolveExpression: (expression: SyntaxNodeLike) => Promise<ResolvedExport | null>;
  module: ModuleIndex;
  getScopeIndex: () => ScopeIndex;
  proof?: ReceiverBinding | null;
  resolvedDirect?: ResolvedExport | null;
  hiddenReceiverType?: (expression: SyntaxNodeLike) => Promise<SymbolDef | null>;
  tree?: SyntaxTreeLike;
};

export type ResolvedReceiver = {
  def: SymbolDef;
  memberScope: ReceiverMemberScope;
  runtimeTypeOnly?: true;
};

/**
 * How a constructed receiver (`new T()`, `T()`, `T.new`) names its type where the language departs from the generic
 * local, expression, and named lookup.
 */
export type ReceiverConstructionRules = Readonly<{
  /** A qualified type resolves through namespace-aware qualified lookup, any other through the receiver expression. */
  namespaceQualifiedTypes?: true;
  /** A scope path (`a::B`) names the owner the qualified owner lookup proves, before any other lookup. */
  scopePathTypes?: true;
  /** The type resolves through the namespace symbol table before any other lookup. */
  namespaceSymbolTypes?: true;
  /** A type no local declares resolves through the file's named lookup, which reaches the package's other files. */
  namedPeerTypes?: true;
  /** A type no local declares resolves as a constant that a `require` made visible. */
  visibleConstantTypes?: true;
}>;

/**
 * How a member access (`a.b.c`) resolves its receiver chain and member where the language departs from the generic
 * lexical, import, local, star, receiver, and member path of `resolveMemberAccessDefinition`.
 */
export type AccessTraversalRules = Readonly<{
  /** A name that ends a constant path (`Outer::Tool`) names that constant first; an unproven or undeclared qualifier misses. */
  constantPaths?: true;
  /** The last name of a qualified type in a type position is decided by the JVM type-name lookup. */
  qualifiedTypeNames?: true;
  /** A receiver of this node type is a type name (`Outer.Inner` as a user type), resolved by the JVM type-name lookup. */
  typeNameType?: string;
  /**
   * Names follow enclosing-namespace lookup: a nearer lexical name or enclosing member hides an alias, aliases and
   * `using` directives apply per namespace block, `X::` reads aliases only, and an unbound dotted root is a namespace.
   */
  namespaceScopes?: true;
  /** A typed parameter's annotation (`x: T`) names `T` as a type, outside its synthetic parameter binding. */
  annotationTypes?: true;
  /** The import binding in force at a use decides it, in source order; a local value never falls back to an import. */
  positionedImports?: true;
  /** An unaliased dotted import (`import a.b`) binds the package `a`, and its dotted phrases name the modules. */
  dottedImports?: true;
  /** The innermost namespace import of a name binds it first, then a named or default import. */
  innermostNamespaceImports?: true;
  /** A named import of a module (`use crate::util`) names that module's namespace. */
  moduleNamedImports?: true;
  /** An unbound name may name a declaration of the same package or module. */
  unitPeerNames?: true;
  /** A selector that names an embedded field (`outer.Inner`) resolves to the embedded type. */
  embeddedFieldTypes?: true;
  /** A member of a named type resolves on the type, then among the type file's functions that its name reaches. */
  typeFileMembers?: true;
  /** Node types of a scoped name (`a.b.C`) whose scope and name fields read as a receiver chain. */
  scopedNameTypes?: Readonly<Record<string, true>>;
  /** A receiver member resolves through the class hierarchy, where instance attributes and properties take part. */
  classAttributeMembers?: true;
  /** A property access of this node type inside a trait may name a property that a class using the trait declares. */
  traitPropertyAccessType?: string;
  /** A scope-qualified member of this node type (`Owner::member`) resolves on the owner its qualifier names. */
  scopedMemberType?: string;
}>;

/** Language-specific receiver paths; undefined continues the generic lookup. */
export type ReceiverHooks = Readonly<{
  ownMemberMissReason?: string;
  namedOwnMemberMissReason?: string;
  callablePropertyArity?: (name: SyntaxNodeLike) => CallableArity | null | undefined;
  implicit?: ImplicitReceiverRules;
  memberUse?: MemberUseSyntax;
  syntax?: ReceiverSyntaxRules;
  construction?: ReceiverConstructionRules;
  access?: AccessTraversalRules;
  /** A call's trailing lambda must fit a callable's last parameter, so a member that cannot take one rejects the call. */
  trailingLambdaCalls?: true;
  resolveAccess?: (context: ReceiverAccessContext) => Promise<GoToResult | null | undefined>;
  resolveReceiver?: (context: ReceiverResolutionContext) => Promise<ResolvedReceiver | null | undefined>;
}>;

type OwnerMemberHidden = (useFile: string, member: SymbolDef, context: ParsedFileContext) => boolean;

/** Language-specific shared-owner, qualified-owner, and base lookup. */
export type OwnerHooks = Readonly<{
  shared?: SharedOwnerRules;
  supertypeEntry?: (name: SyntaxNodeLike) => "invoked" | "bare" | null;
  implicitBase?: Readonly<{ clauseType: string; members: Readonly<Record<string, number>> }>;
  lookup?: Readonly<{
    hierarchy?: boolean;
    directFallback?: boolean;
    namespaceContainers?: Readonly<Record<string, true>>;
  }>;
  parameterTypeScope?: "namespace-region";
  memberHidden?: OwnerMemberHidden;
  sharedMemberHidden?: OwnerMemberHidden;
  nonInheritedStaticOwners?: Readonly<{
    nodeTypes: Readonly<Record<string, true>>;
    graphKinds: Readonly<Record<string, true>>;
  }>;
  parts?: (args: {
    index: ProjectIndex;
    ownerFile: string;
    ownerContainer: SyntaxNodeLike;
    ownerSource: string;
    languageId: string;
  }) => Promise<readonly MemberOwnerRef[] | undefined>;
  qualified?: (
    index: ProjectIndex,
    mod: ModuleIndex,
    baseName: string,
    path: readonly string[],
    normalize: (name: string) => string,
    sup: LanguageSupport,
    use: { node: SyntaxNodeLike; source: string; tree: SyntaxTreeLike; scopeIndex?: ScopeIndex } | undefined,
    deps: MemberLookupDeps,
  ) => SymbolDef | null | undefined | Promise<SymbolDef | null | undefined>;
  bases?: (
    index: ProjectIndex,
    owner: MemberOwnerRef,
    deps: MemberLookupDeps,
  ) => Promise<readonly MemberOwnerRef[] | undefined>;
  /** A typealias names the declaration it provably reaches, so a base or receiver that names one reads that type. */
  aliasesReachDeclarations?: true;
  /** How a base clause spells its bases, where the grammar departs from the generic name and member-access walk. */
  heritage?: Readonly<{
    /** Base lists hold scope paths (`a::B`) behind access and `virtual` specifiers; each path names a qualified owner. */
    scopePaths?: true;
    /** Node type of a base spelled as a constant path (`Outer::Base`), read through the lexical constant scopes. */
    constantPathType?: string;
  }>;
  /** A qualified owner (`Outer.Inner`) is the type declared in the body of the type its first segment names. */
  nestedTypePaths?: true;
  /** A type's bases come from all of its parts; an interface offers its base interfaces only to an own receiver. */
  basesFromParts?: true;
  /** A simple base's named lookup reads the module scope, whose bindings depend on where the class body runs. */
  scopedBaseNames?: true;
  /**
   * Declaration type of an owner composed into a class body (a trait): selection reads composed owners, to any depth,
   * before the parent, and a supertype walk reads them only past its first, class-only level.
   */
  composedOwnerType?: string;
  /**
   * The member of the receiver type `receiverDef` that its own body does not declare: a method of a Rust `impl` block,
   * a Go method or embedded member across the package, or a Kotlin extension function of the type's file. `context`
   * and `locals` belong to the type's file, and the lookup runs once the body and its parts declare no such member.
   */
  receiverMembers?: (
    index: ProjectIndex,
    receiverDef: SymbolDef,
    member: string,
    context: ParsedFileContext,
    locals: readonly SymbolDef[],
    normalizeIdentifier: (name: string) => string,
    knownArgumentCount: number | undefined,
    deps: MemberLookupDeps,
  ) => SymbolDef | undefined | Promise<SymbolDef | undefined>;
}>;

/** Existing graph-pass state used by language-specific graph additions. */
export type GraphHookContext = {
  index: ProjectIndex;
  sup: LanguageSupport;
  source: string;
  tree: SyntaxTreeLike;
  moduleEntry: ModuleIndex;
  scopeIndex: ScopeIndex;
  deps: MemberLookupDeps;
  recordEdge: (fromId: string, toId: string, label?: string, site?: { file: FileId; range: Range }) => boolean;
};

/** Language-specific graph facts at declaration, owner, and resolved-call events. */
export type GraphHooks = Readonly<{
  callableBindingGroups?: "canonical-name" | "equivalent-signature";
  callableNameForm?: "case-folded" | "normalized";
  aliasExportOptions?: ImportNameResolutionOptions;
  /** The import resolver enforces this language's member visibility, so a named import of its declarations uses it. */
  importResolverVisibility?: true;
  collapseLocalAliases?: <T>(
    group: readonly T[],
    identityOf: (entry: T) => CallableIdentity | undefined,
  ) => T | undefined;
  namedNodeTypes?: Readonly<Record<string, true>>;
  abstractMemberOwnerType?: string;
  memberVisibility?: "file-hidden" | "not-exported";
  ignoredBaseSpecifierTypes?: Readonly<Record<string, true>>;
  preservedBaseSpecifierTypes?: Readonly<Record<string, true>>;
  singleSuperclass?: Readonly<{ declarationType: string; heritageType: string; clauseType: string }>;
  /** Declaration-only grammar shapes, selected before the graph's syntax traversal. */
  declarationShapes?: Readonly<{
    splitMethodName?: (node: SyntaxNodeLike) => SyntaxNodeLike | undefined;
    propertyAccessors?: Readonly<{
      declarationType: string;
      receiverType: (node: SyntaxNodeLike) => SyntaxNodeLike | null;
      variableType: string;
      nameType: string;
      accessorTypes: Readonly<Record<string, true>>;
    }>;
    objectTypeAlias?: Readonly<{ declarationType: string; valueType: string }>;
    assignedFactoryType?: Readonly<{
      assignmentType: string;
      targetType: string;
      callType: string;
      receiverName: string;
      methodName: string;
    }>;
  }>;
  declaration?: (context: GraphHookContext, node: SyntaxNodeLike, definition: SymbolDef) => void | Promise<void>;
  owner?: (context: GraphHookContext, owner: MemberOwnerRef) => void | Promise<void>;
  call?: (context: GraphHookContext, node: SyntaxNodeLike, definition: SymbolDef) => void | Promise<void>;
}>;

export type MemberLookupPolicy = {
  /**
   * A class name resolves through the file's class-role `use` aliases and the namespace symbol table, never through the
   * generic import, local, and named lookup.
   */
  namespaceClassNames?: true;
  /** Member scopes are distinct for this language; absent means false. */
  separateMemberScopes?: boolean;
  /** Existing selector options shared by navigation and graph consumers. */
  selection?: Readonly<
    Pick<
      MemberSelectionOptions,
      "inheritOverloads" | "firstDeclarationWins" | "caseInsensitiveCallableNames" | "normalizeIdentifier" | "callSite"
    >
  >;
  /** Specialized receiver lookup; absent keeps the generic member path. */
  receiverResolution?: ReceiverHooks;
  /** Specialized owner and ancestry lookup; absent keeps generic owner lookup. */
  ownerResolution?: OwnerHooks;
  /** Additional graph facts; absent adds none. */
  graph?: GraphHooks;
  /**
   * The declaration of a type is not one of its members: a member lookup skips the type's own name token. A language
   * sets this where member names fold case, so a method called `deep` would otherwise match `class Deep`.
   */
  excludesContainerNameFromMembers?: boolean;
  /** Superset key for normalized member names; final selection still checks symbol-specific name equality. */
  memberNameKey?: (normalizedName: string) => string;
  /** Equality key for class/type names, separate from callable and data member names. */
  typeNameKey?: (name: string) => string;
  /** Symbol-kind-aware equality where methods and data members use different name namespaces. */
  compareMemberNames?: (
    reference: string,
    symbol: string,
    options?: { symbolKind?: string },
  ) => "equivalent" | "different" | "unverified";
  /** Node kinds that are static declarations without a modifier. */
  staticDeclarationTypes?: Readonly<Record<string, true>>;
  /** Resolve a declared receiver type through positioned source-unit lookup; a value itself cannot own members. */
  declaredReceiverUsesNameLookup?: boolean;
  /** A declarator gets its explicit type from this parent node, rather than from its initializer. */
  receiverDeclaratorTypeParent?: string;
  /** Later assignments cannot change a value's explicitly declared receiver type. */
  receiverDeclaredTypeSurvivesAssignment?: boolean;
  /** Whether a declared receiver proof belongs to the binding visible at the use. */
  receiverDeclaredBindingVisible?: (
    tree: SyntaxTreeLike,
    receiver: SyntaxNodeLike,
    declaration: SyntaxNodeLike,
    closest: SyntaxNodeLike | null,
  ) => boolean;
  /** A nominal receiver's members are resolved on that receiver, not through its source file's exports. */
  membersBeforeFileExports?: boolean;
  /**
   * The ones among `candidates`, the same-named members one type declares, that a call through the type's name runs,
   * where the language keeps one of them: a Ruby class method over an instance method, and a later `def` over an
   * earlier one, unless the call at `sameFileUse` runs before the later `def` does.
   */
  typeNameMembers?(
    this: void,
    candidates: readonly SymbolDef[],
    context: ParsedFileContext,
    sameFileUse: SyntaxNodeLike | undefined,
  ): readonly SymbolDef[];
  /**
   * Whether a call through the name of the type declared at `ownerName` may run a member that the type's file declares
   * under the member's name: one of the type, of a body reopening it, or of a type its heritage names, never one of a
   * type that merely encloses it.
   */
  typeNameMayReachFileMember?(this: void, ownerName: SyntaxNodeLike, memberName: SyntaxNodeLike): boolean;
  /** A source-declared stand-in for a generated instance property, after explicit members have been checked. */
  implicitMember?(
    index: ProjectIndex,
    owner: MemberOwnerRef,
    name: string,
    deps: MemberLookupDeps,
  ): Promise<SymbolDef | undefined>;
  /**
   * The edge a resolved dotted member call records, or `null` when its target cannot be the callee. Without this
   * hook, a target that accepts the call's argument count records `calls`.
   */
  callEdge?(
    this: void,
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
  /** Whether `file` sees the owned declaration token's definitions through its unit, beside imports. */
  visibleThroughUnit?(
    index: ProjectIndex,
    file: string,
    definitions: readonly SymbolDef[],
    definitionName: SyntaxNodeLike,
  ): boolean;
  /** Whether a same-named use the lookup could not place makes the references of `expected` partial. */
  uncertaintyRelevant?(
    index: ProjectIndex,
    expected: SymbolDef,
    equivalents: readonly SymbolDef[],
    definitionVisible: () => boolean,
  ): boolean;
  /** Whether the lookup's `reason` for an unplaced `node` leaves a reference possible. */
  unprovenReference?(node: SyntaxNodeLike, reason: string | undefined, definitionName: SyntaxNodeLike): boolean;
  /** An unproven reference family can only make the definition's own reference coverage partial. */
  referenceFamilyUnproven?(definitionNameNode: SyntaxNodeLike): boolean;
  /** Apply receiver exclusions before retaining an unresolved member reference marked by this policy. */
  unprovenMembersRespectReceiverProof?: boolean;
  /** Whether an unplaced use's syntax can name the target at all, using the query's owned declaration token. */
  unprovenReferenceCandidate?(node: SyntaxNodeLike, definitionName: SyntaxNodeLike): boolean;
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
  /**
   * The declarations the language requires to share `target`'s name (the witnesses of a protocol requirement), and why
   * one of them cannot be proven. A rename edits every definition returned with the uses `usesOf` proves for each;
   * `unprovenReason` makes it unsafe.
   */
  renameCompanions?(args: {
    index: ProjectIndex;
    target: SymbolDef;
    deps: MemberLookupDeps;
    /** Existing project type-hierarchy lookup; incomplete ancestry or descendants cannot prove a rename independent. */
    relatedTypes(
      owner: SymbolDef,
      direction: "super" | "sub",
    ): { definitions: readonly SymbolDef[]; complete: boolean; directCount: number } | undefined;
    /** Whether the existing implementation lookup finds project implementers of a type. */
    hasImplementers(owner: SymbolDef): boolean;
    /** Every use of `def` that rename collection proves, or null when that collection is incomplete or failed. */
    usesOf(def: SymbolDef): Promise<readonly Reference[] | null>;
  }): Promise<RenameCompanions | undefined>;
  /** Whether a declaration node declares a static member without a `static` modifier (an enum case). */
  isStaticDeclaration?(this: void, node: SyntaxNodeLike): boolean;
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
  /** Callable name for a named parameter, empty for an unprobeable constructor, or null for other bindings. */
  parameterNamedAtCall?(definition: SymbolDef, context: ParsedFileContext): string | null;
  /** Other files can refer to a parameter only through their named-argument syntax. */
  parameterReferenceScanFilter?: ParameterReferenceScanFilter;
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
  lexicalBinding?(
    this: void,
    lookup: { scopeBindingIsImport(): boolean; binding(): SymbolDef | null },
  ): SymbolDef | null;
};

/** The declarations that must be renamed with a target, and the reason one of them could not be proven. */
export type RenameCompanions = {
  definitions: readonly SymbolDef[];
  unprovenReason?: string;
};

/** File/query-owned facts passed through receiver and binding walks. */
export type ReceiverSyntaxContext = Readonly<{
  policy: MemberLookupPolicy | undefined;
  access: MemberAccessRow | undefined;
}>;

/** Existing syntax helpers supplied by the receiver consumer, without a graph-to-policy cycle. */
export type ReceiverSyntaxDeps = {
  constructionTypeName(
    node: SyntaxNodeLike,
    source: string,
    support: LanguageSupport,
    syntax: ReceiverSyntaxContext,
  ): SyntaxNodeLike | null;
  unwrapNamedType(node: SyntaxNodeLike, support: LanguageSupport): SyntaxNodeLike | null;
  sameSyntaxNode(left: SyntaxNodeLike | null, right: SyntaxNodeLike): boolean;
  constructorNameNode(node: SyntaxNodeLike, support: LanguageSupport): SyntaxNodeLike | null;
  nearestMemberContainer(node: SyntaxNodeLike): SyntaxNodeLike | null;
  qualifiedNameSegments(node: SyntaxNodeLike, source: string): string[];
  declarationMemberArity(node: SyntaxNodeLike, shapes?: GraphParameterShapes): number | undefined;
  findFirstNodeByType(node: SyntaxNodeLike, type: string): SyntaxNodeLike | null;
  isIdentifierType(support: LanguageSupport, type: string): boolean;
};
export type ReceiverSyntaxRules = Readonly<{
  parallelBindings?: Readonly<
    Record<
      string,
      Readonly<{
        names: (node: SyntaxNodeLike) => SyntaxNodeLike[];
        construction: (
          node: SyntaxNodeLike,
          receiverName: string,
          source: string,
          support: LanguageSupport,
          syntax: ReceiverSyntaxContext,
          deps: ReceiverSyntaxDeps,
        ) => SyntaxNodeLike | null;
      }>
    >
  >;
  keywordConstruction?: (
    node: SyntaxNodeLike,
    source: string,
    support: LanguageSupport,
    deps: ReceiverSyntaxDeps,
  ) => PhpObjectCreationKeyword | null;
}>;
