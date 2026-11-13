import type { NameResolution } from "../../indexer/name-resolution-types.js";
import type { ParsedFileProvider } from "../../indexer/parsed-cache.js";
import { SymbolKind, type ModuleIndex, type ProjectIndex, type SymbolDef } from "../../indexer/types.js";

import { getCompilationUnitPeers } from "../../indexer/compilation-units.js";
import {
  isExportedDeclaration,
  isGoExportedMemberName,
  isSwiftCrossFileHiddenSharedOwnerMember,
  isSwiftFileHiddenSharedOwnerMember,
} from "../../indexer/declaration-visibility.js";
import { resolveCppQualifiedMemberContainer } from "../../indexer/navigation-cpp.js";
import {
  cppQualifiedOwnerHasImplicitThis,
  csharpAliasAt,
  resolveCsharpQualifiedReceiverType,
  findTypeScriptNamespaceMemberCandidates,
  innermostNamespaceImport,
  isDirectKeywordMemberDeclaration,
  memberAcceptsCallAt,
  qualifiedBaseNames,
  pythonAnnotationTypeAtUse,
  readRubyConstantReference,
  resolvePhpObjectCreationTarget,
  resolveQualifiedMemberContainer,
  resolveRubyConstantReference,
  resolveRubyVisibleConstant,
  resolveSharedOwnerContainers,
  resolveSwiftAliasContainer,
  resolveSwiftAliasHeritage,
  supportsDeclaredFieldChains,
  type SharedOwnerContainer,
} from "../../indexer/navigation-goto.js";
import { csharpQualifiedNameNode, findClosestScopeBinding } from "../../indexer/navigation-local.js";
import { bindsTypeParameter } from "../../indexer/type-parameters.js";
import type { ScopeIndex } from "../../indexer/scope-types.js";
import { csharpTypeOnlyName } from "../../indexer/scope-nodes.js";
import { findPhpImportAlias, inferPhpQualifiedReferenceImportType } from "../../indexer/navigation-php.js";
import {
  cjsRequireValueBinding,
  resolveImportTypeMember,
  resolvePhpExportByImportType,
} from "../../indexer/navigation-resolve.js";
import { resolveEcmaPrivateName, selectMember } from "../../indexer/member-selection.js";
import { kotlinThisNeedsScopeProof } from "../../indexer/kotlin-lambda-receiver.js";
import { kotlinHasTrailingLambda } from "../../indexer/kotlin-call-compatibility.js";
import { effectiveExplicitBinding } from "../../indexer/star-import-precedence.js";
import {
  isSwiftConstrainedExtension,
  isSwiftExtensionContainer,
  selectCsharpPartialRepresentative,
} from "../../indexer/shared-owner-identity.js";
import type { LanguageSupport } from "../../languages.js";
import { isJsTsLanguage } from "../../languages/js-family.js";
import { getCallArgumentCount, memberLookupBinding } from "../../languages/callable-arity.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../../languages/types.js";
import { sliceText, toRange } from "../../util/ast.js";
import {
  collectMemberAccessChain,
  getMemberAccessParts,
  isMemberAccessNode,
  isReceiverNameNode,
  isQualifiedTypeSuffix,
  kotlinQualifiedExpression,
  rustTokenTreeHoldsExpressions,
  rustTokenTreeNameFollowsSeparator,
} from "../../util/member-access.js";
import { foldPhpIdentifierCase } from "../../util/identifiers.js";
import { isSwiftQualifiedTypeSuffix } from "../../util/swift-tree.js";
import {
  MEMBER_ACCESS_ROWS,
  type ReceiverAncestorClause,
  type ReceiverAncestorEmbed,
  type ReceiverAncestryRelation,
} from "../../util/member-access-tables.js";
import { fileIdentityKey } from "../../util/paths.js";
import { defNodeId, nodeForDef, type SymbolGraph } from "../symbol-graph.js";
import type { DetailedClassNode, DetailedFunctionNode } from "./ast.js";
import { declarationMemberArity, findFirstNodeByType, isIdentifierType } from "./ast.js";
import {
  CALL_ARGUMENT_NODE_TYPES,
  classifyReceiver,
  constructionTypeName,
  declarationIsStaticEquivalent,
  declarationNodeIsStatic,
  cppOutOfLineOwnerPath,
  cppOutOfLineMemberDeclarationNode,
  cppQualifiedNameSegments,
  declaredSupertypeKind,
  declaresMembers,
  isAnonymousMemberContainer,
  isNonBaseHeritageArgument,
  isUnprovenHeritageExpression,
  kotlinExtensionReceiverTypeNode,
  kotlinMayNameClassBare,
  kotlinSupertypeEntry,
  memberContainerDef,
  nearestMemberContainer,
  nodeInStaticMemberContext,
  phpObjectCreationKeyword,
  receiverCallAccess,
  rustImplSelfTypeNode,
  supportsImplicitSelfMemberCalls,
  supportsReceiverMemberOverloads,
  type ReceiverBinding,
  type ReceiverCallAccess,
  type ReceiverCallCandidate,
  type ReceiverMemberScope,
  type MemberArityRange,
  type ReceiverProof,
  importTypeQuerySpecifier,
} from "./receiver-calls.js";

type EdgePassContext = {
  index: ProjectIndex;
  sup: LanguageSupport;
  source: string;
  tree: SyntaxTreeLike;
  moduleEntry: ModuleIndex;
  scopeIndex: ScopeIndex;
  nodes: SymbolGraph["nodes"];
  membersOnly: boolean;
  memberExpressionType: string;
  propertyIdentifierTypes: string[];
  optionalMemberTypes: Set<string>;
  aliasToTargetDef: Map<string, SymbolDef>;
  aliasToTargetModule: Map<string, string>;
  /** The key both alias tables above are stored under; a use-site spelling must go through it. */
  aliasKey: (name: string) => string;
  /** Whether the two alias tables above, built for the whole file, answer for `name` at `node`. */
  aliasTableAnswers: (name: string, node: SyntaxNodeLike, positionedResolution?: NameResolution | null) => boolean;
  resolveIdentifier: (name: string, node: SyntaxNodeLike) => SymbolDef | null;
  /** The shared lookup's raw answer, including steps deferred to async member lookup. */
  resolveName: (name: string, node: SyntaxNodeLike, skipKotlinQualifiedExpression?: boolean) => NameResolution | null;
  /** Runs deferred steps with the graph's rules; returns an indexed target or null. */
  settleName: (name: string, node: SyntaxNodeLike, resolution: NameResolution | null) => Promise<SymbolDef | null>;
  /** Whether a text-indexed import alias remains visible after lexical scope lookup. */
  moduleAliasIsUnshadowed: (name: string, node: SyntaxNodeLike) => boolean;
  resolveExportFrom: (file: string, exportedName: string) => SymbolDef | null;
  resolveMemberChainTarget: (chainNode: SyntaxNodeLike) => SymbolDef | null;
  resolveMemberAccessTarget: (node: SyntaxNodeLike) => Promise<SymbolDef | null>;
  /** Whether a C++ definition declares a class, struct, or union (not a namespace). */
  cppDeclaresClass: (def: SymbolDef) => boolean;
  recordEdge: (fromId: string, toId: string, label?: string, site?: SymbolGraph["edges"][number]["site"]) => boolean;
  /** Receiver calls whose target needs the completed graph; resolved after every module. */
  receiverCalls: ReceiverCallCandidate[];
  /** Proven static or instance scope for callable members, keyed by graph node id. */
  receiverMemberScopes: Map<string, ReceiverMemberScope>;
  /** Accepted argument-count range for arity-selected members, keyed by graph node id. */
  receiverMemberArities: Map<string, MemberArityRange>;
  /**
   * Memoized shared-owner peer defs, keyed by owner file and container span. The map is
   * shared across the per-file passes, so the owner file must stay in the key: two files
   * can declare same-spanned containers (identical partial bodies) whose peer sets differ.
   */
  sharedOwnerPeers: Map<string, Promise<SharedOwnerPeer[]>>;
  /** Swift extension / C# partial owner def id mapped to the coalesced type identity. */
  sharedOwnerAnchors: Map<string, string>;
  /** Visible members a constrained Swift owner can use without donating them to its nominal type. */
  sharedOwnerAccessibleMembers: Map<string, Set<string>>;
  /**
   * Members hidden from other files: Java `private`, Kotlin `private`/`internal`, and Swift
   * `private`/`fileprivate` (including a private extension). Same-file calls stay.
   */
  fileHiddenMemberIds: Set<string>;
  /** Definition-node ids that collapse into their declaration-node id. */
  nodeAliases: Map<string, string>;
  /** Registers a name the detailed pass proved callable (function-valued bindings). */
  noteCallableName: (
    name: string,
    phpCaseInsensitive?: boolean,
    normalizeIdentifier?: (name: string) => string,
  ) => void;
  /** Loads syntax needed to recover declaration metadata for cross-file member definitions. */
  loadParsedFile: (file: string) => Promise<{ source: string; tree: SyntaxTreeLike } | null>;
  /** Files the shared name lookup reads synchronously for this module, such as `using static` targets. */
  parsedFiles: ParsedFileProvider;
};

function ensureNode(context: EdgePassContext, def: SymbolDef): string {
  const id = defNodeId(def);
  if (!context.nodes.has(id)) context.nodes.set(id, nodeForDef(def));
  return id;
}
function markImplementationTarget(
  context: EdgePassContext,
  id: string,
  declarationNode: SyntaxNodeLike,
  declarationSource: string,
  def: SymbolDef,
): void {
  const declaration = sliceText(declarationNode, declarationSource);
  const nameIndex = declaration.indexOf(def.localName);
  const prefix = nameIndex >= 0 ? declaration.slice(0, nameIndex) : declaration;
  if (!/\b(?:abstract|virtual|override)\b/.test(prefix)) return;
  const node = context.nodes.get(id);
  if (node) node.implementationTarget = true;
}
function markMemberArity(context: EdgePassContext, id: string, declarationNode: SyntaxNodeLike): void {
  const arity = declarationMemberArity(declarationNode, context.sup.id);
  if (arity === undefined) return;
  const node = context.nodes.get(id);
  if (node) node.memberArity = arity;
}

function mergeCppCallableShapes(...defs: Array<SymbolDef | undefined>): MemberArityRange | undefined {
  let merged: MemberArityRange | undefined;
  for (const def of defs) {
    const arity = def?.callable?.arity;
    if (!arity) continue;
    if (!merged) {
      merged = { min: arity.minArgs, max: arity.maxArgs };
      continue;
    }
    merged.min = Math.min(merged.min, arity.minArgs);
    if (merged.max === null || arity.maxArgs === null) merged.max = null;
    else merged.max = Math.max(merged.max, arity.maxArgs);
  }
  return merged;
}

/** The member call form determines whether a declared receiver takes an argument. */
function acceptedMemberArityRange(context: EdgePassContext, def: SymbolDef): MemberArityRange | undefined {
  if (!supportsReceiverMemberOverloads(context.sup.id)) return undefined;
  const callable = def.callable;
  const range =
    memberLookupBinding(context.sup.id) === "unbound" ? (callable?.unboundArity ?? callable?.arity) : callable?.arity;
  return range ? { min: range.minArgs, max: range.maxArgs } : undefined;
}

function recordMemberLookupIdentity(
  context: EdgePassContext,
  definitionId: string,
  memberId: string,
  memberScope: ReceiverMemberScope,
  arityRange: MemberArityRange | undefined,
): void {
  context.receiverMemberScopes.set(definitionId, memberScope);
  if (memberId !== definitionId) context.receiverMemberScopes.set(memberId, memberScope);
  if (!arityRange) return;
  context.receiverMemberArities.set(definitionId, arityRange);
  if (memberId !== definitionId) context.receiverMemberArities.set(memberId, arityRange);
}

function recordDefEdge(
  context: EdgePassContext,
  fromId: string,
  target: SymbolDef,
  label: string,
  siteNode?: SyntaxNodeLike,
): boolean {
  const toId = ensureNode(context, target);
  return context.recordEdge(
    fromId,
    toId,
    label,
    siteNode ? { file: context.moduleEntry.file, range: toRange(siteNode) } : undefined,
  );
}

function tryResolveChain(context: EdgePassContext, node: SyntaxNodeLike, fromId?: string, label = "uses"): boolean {
  const targetDef = context.resolveMemberChainTarget(node);
  if (targetDef && fromId) {
    recordDefEdge(context, fromId, targetDef, label, node);
    return true;
  }
  return !!targetDef;
}

/** Records an edge for a resolvable target node. Returns whether a target was resolved. */
function tryResolveNode(context: EdgePassContext, node: SyntaxNodeLike, fromId: string, label: string): boolean {
  if (context.sup.id === "cpp" && node.type === "qualified_identifier") {
    const name = cppQualifiedNameSegments(node, context.source).join("::");
    const target = context.resolveIdentifier(name, node);
    if (target) {
      recordDefEdge(context, fromId, target, label, node);
      return true;
    }
    return false;
  }
  if (
    isIdentifierType(context.sup, node.type) ||
    node.type === "type_identifier" ||
    (context.sup.id === "csharp" && (node.type === "qualified_name" || node.type === "alias_qualified_name")) ||
    (context.sup.id === "php" && (node.type === "qualified_name" || node.type === "relative_name")) ||
    (context.sup.id === "cpp" && (node.type === "operator_name" || node.type === "destructor_name"))
  ) {
    const name = sliceText(node, context.source);
    const target = context.resolveIdentifier(name, node);
    if (target) {
      // Zig struct declarations require an explicit type receiver (`Self.helper()`).
      // An unqualified identifier is not a call to a member of its enclosing struct.
      if (label === "calls" && context.sup.id === "zig" && target.isMember) return false;
      recordDefEdge(context, fromId, target, label, node);
      return true;
    }
  }
  if (context.optionalMemberTypes.has(node.type)) {
    return tryResolveChain(context, node, fromId, label);
  }
  return false;
}

/**
 * Rust macro arguments stay unparsed token trees, so `println!("{}", greet())` never forms a
 * call node even though goto resolves the identifier. An `identifier` directly followed by a
 * `(` group is a call in the argument list, resolved like a bare call. The macro's own name
 * sits outside the token tree and is never a call; a `!` gap marks a nested macro invocation,
 * and a `.` or `::` gap marks a member or path receiver that raw tokens cannot prove, matching
 * navigation's refusals inside token trees.
 */
function recordRustMacroArgumentCalls(context: EdgePassContext, tokenTree: SyntaxNodeLike, fromId: string): void {
  if (!rustTokenTreeHoldsExpressions(tokenTree)) return;
  const children = tokenTree.namedChildren;
  for (let index = 0; index + 1 < children.length; index += 1) {
    const name = children[index]!;
    const args = children[index + 1]!;
    if (name.type !== "identifier" || args.type !== "token_tree") continue;
    if (!args.text.startsWith("(")) continue;
    if (context.source.slice(name.endIndex, args.startIndex).trim()) continue;
    if (rustTokenTreeNameFollowsSeparator(name)) continue;
    tryResolveNode(context, name, fromId, "calls");
  }
}

function getCallTarget(node: SyntaxNodeLike): SyntaxNodeLike | null {
  const explicitTarget =
    node.childForFieldName("function") ??
    node.childForFieldName("callee") ??
    node.childForFieldName("name") ??
    node.childForFieldName("method") ??
    node.childForFieldName("member") ??
    node.childForFieldName("expression");
  // tree-sitter-typescript parses `await f<T>(x)` as a call whose callee is `await f`; the awaited
  // value is the call's result, so the callee is `f`.
  if (explicitTarget?.type === "await_expression" && node.childForFieldName("type_arguments")) {
    return explicitTarget.namedChildren[0] ?? null;
  }
  if (explicitTarget) return explicitTarget;
  // Kotlin and Swift calls name no callee field, so the sole non-argument child is it.
  const nonArgumentChildren = node.namedChildren.filter((child) => !CALL_ARGUMENT_NODE_TYPES[child.type]);
  return nonArgumentChildren.length === 1 ? (nonArgumentChildren[0] ?? null) : null;
}

function getNewTarget(node: SyntaxNodeLike): SyntaxNodeLike | null {
  const field =
    node.childForFieldName("constructor") ?? node.childForFieldName("type") ?? node.childForFieldName("name");
  if (field) return field;
  // PHP `new Base()` has no type field; the type is a `name` / `qualified_name` child and
  // `child(0)` is the `new` keyword, which is not a type.
  const namedType = node.namedChildren.find(
    (child) =>
      child.type === "type_identifier" ||
      child.type === "name" ||
      child.type === "qualified_name" ||
      child.type === "relative_name",
  );
  return namedType ?? node.child(0);
}

export function emitPythonDecoratorEdges(context: EdgePassContext, rootNode: SyntaxNodeLike): void {
  const addDecoratorUses = (node: SyntaxNodeLike): void => {
    if (node.type === "decorated_definition") {
      const fn = node.namedChildren.find((child) => child.type === "function_definition");
      if (fn) addDecoratorUses(fn);
      for (const decoratorChild of node.namedChildren) {
        if (decoratorChild.type !== "decorator") continue;
        const nameNode = fn?.childForFieldName("name");
        if (!nameNode) continue;
        const name = sliceText(nameNode, context.source);
        const def = context.moduleEntry.locals.find((local) => local.localName === name);
        if (!def) continue;
        const fromId = ensureNode(context, def);
        const expr =
          decoratorChild.childForFieldName?.("name") ?? decoratorChild.namedChildren?.[0] ?? decoratorChild.child(1);
        if (expr) tryResolveNode(context, expr, fromId, "decorates");
      }
    } else if (node.type === "function_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const name = sliceText(nameNode, context.source);
        const def = context.moduleEntry.locals.find((local) => local.localName === name);
        if (def) {
          const fromId = ensureNode(context, def);
          let prev = node.previousSibling;
          while (prev) {
            if (prev.type === "decorated_definition") {
              for (const decoratorChild of prev.namedChildren) {
                if (decoratorChild.type === "decorator") {
                  const expr =
                    decoratorChild.childForFieldName?.("name") ??
                    decoratorChild.namedChildren?.[0] ??
                    decoratorChild.child(1);
                  if (expr) tryResolveNode(context, expr, fromId, "decorates");
                } else if (decoratorChild.type === "attribute") {
                  tryResolveNode(context, decoratorChild, fromId, "decorates");
                }
              }
            } else if (prev.type === "decorator") {
              const expr = prev.childForFieldName?.("name") ?? prev.namedChildren?.[0] ?? prev.child(1);
              if (expr) tryResolveNode(context, expr, fromId, "decorates");
            }
            prev = prev.previousSibling;
          }
        }
      }
    }
    for (const child of node.namedChildren) addDecoratorUses(child);
  };

  addDecoratorUses(rootNode);
}

/** Whether a function declaration can participate in class member lookup and ownership. */
function isClassMemberFunction(fn: DetailedFunctionNode): boolean {
  return fn.node.type !== "local_function_statement";
}

export async function emitMemberOwnershipEdges(
  context: EdgePassContext,
  functionNodes: DetailedFunctionNode[],
  classNodes: DetailedClassNode[],
): Promise<void> {
  for (const fn of functionNodes) {
    const owner = await memberOwner(context, fn, classNodes);
    if (!owner) continue;
    const outOfLineDeclaration = owner.cppOutOfLine
      ? await cppOutOfLineMemberDeclaration(context, fn, owner.def)
      : null;
    const definitionId = ensureNode(context, fn.def);
    let memberDef = fn.def;
    if (outOfLineDeclaration) {
      const declarationModule = context.index.byFile.get(fileIdentityKey(owner.def.file));
      const declarationDef = declarationModule?.locals.find(
        (candidate) =>
          candidate.localName === fn.def.localName &&
          candidate.kind === fn.def.kind &&
          candidate.range.start.index === outOfLineDeclaration.nameNode.startIndex &&
          candidate.range.end.index === outOfLineDeclaration.nameNode.endIndex,
      );
      if (declarationDef) memberDef = declarationDef;
    }
    const memberId = ensureNode(context, memberDef);
    if (definitionId !== memberId) context.nodeAliases.set(definitionId, memberId);
    if (context.sup.id === "java" || context.sup.id === "kotlin" || context.sup.id === "swift") {
      const declarationNode = outOfLineDeclaration?.node ?? fn.node;
      const hidden =
        context.sup.id === "swift"
          ? isSwiftFileHiddenSharedOwnerMember(context.sup.id, declarationNode)
          : !isExportedDeclaration(context.sup.id, declarationNode);
      if (hidden) {
        context.fileHiddenMemberIds.add(memberId);
        if (definitionId !== memberId) context.fileHiddenMemberIds.add(definitionId);
      }
    }
    markImplementationTarget(
      context,
      memberId,
      outOfLineDeclaration?.node ?? fn.modifierNode ?? fn.node,
      outOfLineDeclaration?.source ?? context.source,
      fn.def,
    );
    const arityNode = outOfLineDeclaration?.node ?? fn.node;
    markMemberArity(context, definitionId, arityNode);
    if (memberId !== definitionId) markMemberArity(context, memberId, arityNode);
    const memberScope = memberScopeForDefinition(context, fn, owner.cppOutOfLine, outOfLineDeclaration);
    const outOfLineMember = outOfLineDeclaration ? memberDef : undefined;
    const arityRange =
      context.sup.id === "cpp"
        ? mergeCppCallableShapes(fn.def, outOfLineMember)
        : acceptedMemberArityRange(context, memberDef);
    recordMemberLookupIdentity(context, definitionId, memberId, memberScope, arityRange);
    recordDefEdge(context, definitionId, owner.def, "member_of");
    await emitSharedOwnerMembershipEdges(context, owner, definitionId, fn.node);
  }
}

/** Owner def of a shared-owner container, matched by its declaration name range. */
function sharedOwnerPeerDef(peer: SharedOwnerContainer, callerFile?: string): SharedOwnerPeer | null {
  const nameNode = peer.container.childForFieldName("name");
  if (!nameNode) return null;
  const def = peer.module.locals.find(
    (local) => declaresMembers(local) && local.range.start.index === nameNode.startIndex,
  );
  if (!def) return null;
  if (!callerFile) return { def, isExtension: isSwiftExtensionContainer(peer.container, peer.context.source) };
  const visibleMemberIds: string[] = [];
  for (const local of peer.module.locals) {
    const start = local.range.start.index;
    if (start === undefined || start < peer.container.startIndex || start >= peer.container.endIndex) continue;
    const name = peer.context.tree.rootNode.descendantForIndex(start, start);
    if (!isDirectKeywordMemberDeclaration(name, peer.container)) continue;
    if (isSwiftCrossFileHiddenSharedOwnerMember("swift", callerFile, peer.file, name)) continue;
    visibleMemberIds.push(defNodeId(local));
  }
  return { def, isExtension: isSwiftExtensionContainer(peer.container, peer.context.source), visibleMemberIds };
}

/**
 * C# partial declarations and unconstrained Swift extensions share type membership
 * across proven peers. Constrained Swift extensions instead retain their own members
 * and record only the peer members their lexical owner can use. This keeps unproven
 * receivers from inheriting constrained members while preserving calls inside the
 * extension. Same-named types in other namespaces or paths remain separate.
 */
async function emitSharedOwnerMembershipEdges(
  context: EdgePassContext,
  owner: MemberOwner,
  definitionId: string,
  memberNode: SyntaxNodeLike,
): Promise<void> {
  const container = owner.container;
  if (!container) return;
  if (context.sup.id !== "csharp" && context.sup.id !== "swift") return;
  const isExtension = context.sup.id === "swift" && isSwiftExtensionContainer(container, context.source);
  // Swift base types already own their full member set; only extensions and C#
  // partials reach across owner declarations. Non-partial C# containers resolve
  // to no peers inside the shared-owner relation.
  // Constrained extensions can use nominal members but cannot donate their own
  // members to every instance of the nominal type without proving the where clause.
  const constrained = context.sup.id === "swift" && isSwiftConstrainedExtension(container, context.source);
  if (constrained && context.sharedOwnerAccessibleMembers.has(defNodeId(owner.def))) return;
  const cacheKey = `${fileIdentityKey(context.moduleEntry.file)}\u0000${container.startIndex}\u0000${container.endIndex}`;
  let peers = context.sharedOwnerPeers.get(cacheKey);
  if (!peers) {
    peers = resolveSharedOwnerContainers({
      index: context.index,
      ownerFile: context.moduleEntry.file,
      ownerContainer: container,
      ownerSource: context.source,
      languageId: context.sup.id,
    }).then((resolved) =>
      resolved
        .map((peer) => sharedOwnerPeerDef(peer, constrained ? context.moduleEntry.file : undefined))
        .filter((peer): peer is SharedOwnerPeer => !!peer),
    );
    context.sharedOwnerPeers.set(cacheKey, peers);
  }
  const peerDefs = await peers;
  if (constrained) {
    const ownerId = defNodeId(owner.def);
    const accessible = context.sharedOwnerAccessibleMembers.get(ownerId) ?? new Set<string>();
    for (const peer of peerDefs) for (const memberId of peer.visibleMemberIds ?? []) accessible.add(memberId);
    context.sharedOwnerAccessibleMembers.set(ownerId, accessible);
    return;
  }
  for (const peer of peerDefs) {
    if (isSwiftCrossFileHiddenSharedOwnerMember(context.sup.id, peer.def.file, context.moduleEntry.file, memberNode)) {
      continue;
    }
    recordDefEdge(context, definitionId, peer.def, "member_of");
  }
  if (isExtension) {
    const anchor = peerDefs.find((peer) => !peer.isExtension);
    context.sharedOwnerAnchors.set(defNodeId(owner.def), defNodeId(anchor ? anchor.def : owner.def));
    return;
  }
  if (context.sup.id === "csharp" && peerDefs.length) {
    const representative = selectCsharpPartialRepresentative([owner.def, ...peerDefs.map((peer) => peer.def)]);
    context.sharedOwnerAnchors.set(defNodeId(owner.def), defNodeId(representative));
  }
}

function memberScopeForDefinition(
  context: EdgePassContext,
  fn: DetailedFunctionNode,
  cppOutOfLine: boolean,
  outOfLineDeclaration: MemberDeclarationSource | null,
): ReceiverMemberScope {
  if (outOfLineDeclaration) {
    return declarationNodeIsStatic(outOfLineDeclaration.node, outOfLineDeclaration.source) ? "static" : "instance";
  }
  if (cppOutOfLine) return "any";
  // Kotlin has no `static` keyword; a member of a `companion object` or a named `object`
  // declaration is the language's static-equivalent mechanism (reachable as `Outer.member()`).
  if (declarationIsStaticEquivalent(context.sup.id, fn.node)) return "static";
  let declarationNode = fn.node;
  if (fn.modifierNode?.type === "public_field_definition") {
    declarationNode = fn.modifierNode;
  } else if (fn.node.parent?.type === "public_field_definition" || fn.node.parent?.type === "field_definition") {
    declarationNode = fn.node.parent;
  }
  return declarationNodeIsStatic(declarationNode, context.source) ? "static" : "instance";
}

type MemberOwner = { def: SymbolDef; container: SyntaxNodeLike | null; cppOutOfLine: boolean };

/** Peer owner defs sharing one type identity, with the container's Swift extension kind. */
export type SharedOwnerPeer = { def: SymbolDef; isExtension: boolean; visibleMemberIds?: string[] };

/** Lexical type body, named Go receiver type, or named C++ out-of-line owner. */
async function memberOwner(
  context: EdgePassContext,
  fn: DetailedFunctionNode,
  classNodes: DetailedClassNode[],
): Promise<MemberOwner | null> {
  if (!isClassMemberFunction(fn)) return null;
  if (context.sup.id === "go" && fn.node.type === "method_declaration") {
    const def = goMethodReceiverTypeDef(context, fn.node);
    return def ? { def, container: null, cppOutOfLine: false } : null;
  }
  const owners = classNodes
    .filter(
      (candidate) => candidate.node.startIndex <= fn.node.startIndex && candidate.node.endIndex >= fn.node.endIndex,
    )
    .sort((left, right) => left.node.endIndex - left.node.startIndex - (right.node.endIndex - right.node.startIndex));
  if (owners[0]?.def) {
    if (!isDirectKeywordMemberDeclaration(fn.node, owners[0].node)) return null;
    return { def: owners[0].def, container: owners[0].node, cppOutOfLine: false };
  }
  if (context.sup.id === "cpp") {
    const ownerPath = cppOutOfLineOwnerPath(fn.node, context.source, context.sup);
    const def = ownerPath
      ? await resolveCppQualifiedMemberContainer(context.index, context.moduleEntry, ownerPath, context.loadParsedFile)
      : null;
    return def ? { def, container: null, cppOutOfLine: true } : null;
  }
  if (context.sup.id === "kotlin") {
    // `fun Widget.describe()` is a top-level declaration outside Widget's own body, so it is
    // never one of `owners` above; its receiver-type prefix is the only proof of ownership.
    const receiverTypeNode = kotlinExtensionReceiverTypeNode(fn.node, context.sup);
    if (!receiverTypeNode) return null;
    const def = resolveNamedType(context, sliceText(receiverTypeNode, context.source), receiverTypeNode);
    return def ? { def, container: null, cppOutOfLine: false } : null;
  }
  if (context.sup.id === "rust") {
    // A Rust impl method sits beside its self type, not inside it (like Go's receiver type);
    // the `impl` block's self type is the owner, and only direct impl members count.
    const container = nearestMemberContainer(fn.node);
    if (!container || container.type !== "impl_item" || !isDirectKeywordMemberDeclaration(fn.node, container)) {
      return null;
    }
    const nameNode = rustImplSelfTypeNode(container, context.sup);
    const def = nameNode ? resolveNamedType(context, sliceText(nameNode, context.source), nameNode) : null;
    return def ? { def, container, cppOutOfLine: false } : null;
  }
  if (context.sup.id !== "zig") return null;
  const container = nearestMemberContainer(fn.node);
  if (container?.type !== "struct_declaration") return null;
  const name = container.parent?.namedChildren.find((child) => child.type === "identifier");
  const def = name ? resolveNamedType(context, sliceText(name, context.source), name) : null;
  return def ? { def, container, cppOutOfLine: false } : null;
}

type MemberDeclarationSource = { node: SyntaxNodeLike; nameNode: SyntaxNodeLike; source: string };

async function cppOutOfLineMemberDeclaration(
  context: EdgePassContext,
  fn: DetailedFunctionNode,
  ownerDef: SymbolDef,
): Promise<MemberDeclarationSource | null> {
  const parsed = await context.loadParsedFile(ownerDef.file);
  const startIndex = ownerDef.range.start.index;
  const endIndex = ownerDef.range.end.index;
  if (!parsed || startIndex === undefined || endIndex === undefined) return null;
  const ownerNameNode = parsed.tree.rootNode.descendantForIndex(startIndex, endIndex);
  const declaration = cppOutOfLineMemberDeclarationNode(
    fn.node,
    fn.def.localName,
    ownerNameNode,
    parsed.source,
    context.sup,
  );
  return declaration ? { node: declaration.node, nameNode: declaration.nameNode, source: parsed.source } : null;
}

/** Receiver type of `func (b *T) M()` / `func (b T) M()`, unwrapped through pointers. */
function goMethodReceiverTypeDef(context: EdgePassContext, methodNode: SyntaxNodeLike): SymbolDef | null {
  const receiver = methodNode.childForFieldName("receiver");
  const parameter =
    receiver?.namedChildren.find((child) => child.type === "parameter_declaration") ?? receiver?.namedChildren[0];
  const typeNode = parameter?.childForFieldName("type");
  const namedType = typeNode ? unwrapGoNamedType(typeNode) : null;
  if (!namedType) return null;
  const target = context.resolveIdentifier(sliceText(namedType, context.source), namedType);
  return target && declaresMembers(target) ? target : null;
}

/** Base type identifier of a Go receiver type, or null if it is not a named type. */
function unwrapGoNamedType(node: SyntaxNodeLike): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (current.type === "parenthesized_type" || current.type === "pointer_type") {
      current = current.namedChildren[0] ?? null;
      continue;
    }
    if (current.type === "generic_type") {
      current = current.childForFieldName("type") ?? current.namedChildren[0] ?? null;
      continue;
    }
    break;
  }
  return current?.type === "type_identifier" ? current : null;
}

/** Type-like defs only, so a PHP `use function` alias cannot steal `Example::m()`. */
function resolveNamedType(
  context: EdgePassContext,
  name: string,
  node: SyntaxNodeLike,
  rubyConstructed = false,
): SymbolDef | null {
  if (context.sup.id === "csharp" && csharpQualifiedNameNode(node)) {
    return resolveCsharpQualifiedReceiverType(
      context.index,
      context.moduleEntry,
      node,
      context.source,
      context.scopeIndex,
      context.parsedFiles,
    );
  }
  // A Go composite literal or Zig struct initializer can name a qualified cross-file type
  // (`pkg.Type{}` / `ns.Type{}`); the receiver's typeName is then dotted text, not one
  // identifier, so resolve the chain directly instead of treating it as a plain name.
  if ((context.sup.id === "go" || context.sup.id === "zig") && context.optionalMemberTypes.has(node.type)) {
    const qualified = context.resolveMemberChainTarget(node);
    return qualified && declaresMembers(qualified) ? qualified : null;
  }
  // A type parameter shadows a same-named class, and it declares no members.
  if (bindsTypeParameter(name, node, context.source, context.sup)) return null;
  if (context.sup.id === "python") {
    const annotation = pythonAnnotationTypeAtUse(
      context.index,
      context.moduleEntry,
      node,
      context.source,
      context.tree,
      context.sup,
      context.scopeIndex,
    );
    if (annotation !== undefined) return annotation && declaresMembers(annotation) ? annotation : null;
  }
  const target = context.resolveIdentifier(name, node);
  if (target && declaresMembers(target)) return target;
  // C# type roots, including generic arity, are settled by the shared positioned lookup.
  if (context.sup.id === "csharp") return null;
  // A parameter/annotation type name is a closer scope binding than the class it names.
  const normalized = context.sup.normalizeIdentifier(name);
  const typed = context.moduleEntry.locals.filter(
    (local) => context.sup.normalizeIdentifier(local.localName) === normalized && declaresMembers(local),
  );
  if (typed.length === 1) return typed[0]!;
  const imported = context.aliasToTargetDef.get(context.aliasKey(name));
  if (imported && context.aliasTableAnswers(name, node) && declaresMembers(imported)) return imported;
  // A constructed `Klass.new` type, or (Ruby only) a bare capitalized constant receiver
  // (`Calc.add(1, 2)`), uses Ruby's bare-constant visibility, and only when this file does not
  // already have several classes of that name. Inheritance names stay on resolveIdentifier so
  // an unproven superclass is not invented.
  const triesRubyVisibleConstant = rubyConstructed || context.sup.id === "ruby";
  if (!triesRubyVisibleConstant || typed.length > 1) return null;
  return resolveRubyVisibleConstant(context.index, context.moduleEntry, context.sup, name);
}

/**
 * Zig's static-receiver call form (`module.Type.member()`): the receiver is itself a qualified
 * member-access node naming a type through another file's export (`counter.Counter` in
 * `counter.Counter.zero()`). `classifyReceiver` only proves an identifier or keyword receiver,
 * so this resolves the receiver's own chain directly and defers the member lookup through the
 * same cross-file receiver-call pipeline every other member call uses.
 */
function recordZigQualifiedTypeReceiverCall(
  context: EdgePassContext,
  node: SyntaxNodeLike,
  access: ReceiverCallAccess,
  fromId: string,
): boolean {
  const typeDef = context.resolveMemberChainTarget(access.receiver);
  if (!typeDef || !declaresMembers(typeDef)) return false;
  const memberName = sliceText(access.property, context.source);
  if (!memberName) return false;
  const argumentCount = supportsReceiverMemberOverloads(context.sup.id)
    ? getCallArgumentCount({ languageId: context.sup.id, source: context.source, call: node })
    : null;
  context.receiverCalls.push({
    callerId: fromId,
    ownerId: ensureNode(context, typeDef),
    viaSupertypes: false,
    memberName,
    argumentCount,
    site: { file: context.moduleEntry.file, range: toRange(access.property) },
    memberScope: "any",
  });
  return true;
}

/**
 * Go's `d.Base.Run()`: `d.Base` explicitly names an embedded field to reach a promoted method
 * that a derived type's own same-named method would otherwise shadow, Go's equivalent of
 * `super`/`base`. `classifyReceiver` only proves an identifier or keyword receiver, so a
 * dotted `d.Base` receiver is never classified. This resolves `d`'s own type, confirms `Base`
 * is really a nameless embedded field declared on it (not an unrelated named field that merely
 * shares the name), then defers the member lookup through the same cross-file receiver-call
 * pipeline every other member call uses. Limited to a same-file owner declaration: the AST
 * needed to read the field list is only synchronously available there.
 */
function recordGoEmbeddedFieldReceiverCall(
  context: EdgePassContext,
  access: ReceiverCallAccess,
  fromId: string,
  hasLexicalBinding: (callee: SyntaxNodeLike) => boolean,
): boolean {
  const parts = getMemberAccessParts(context.sup, access.receiver);
  const objectNode = parts.object;
  const fieldNode = parts.property;
  if (!objectNode || !fieldNode || !isIdentifierType(context.sup, fieldNode.type)) return false;
  const ownerBinding = classifyReceiver(
    context.sup,
    objectNode,
    context.source,
    null,
    0,
    access.receiver,
    hasLexicalBinding,
  );
  if (ownerBinding?.kind !== "named-type") return false;
  const ownerDef = resolveNamedType(context, ownerBinding.typeName, ownerBinding.typeNode, ownerBinding.constructed);
  if (!ownerDef || fileIdentityKey(ownerDef.file) !== fileIdentityKey(context.moduleEntry.file)) return false;
  const embeds = MEMBER_ACCESS_ROWS.go?.receiverAncestry?.embeds;
  if (!embeds) return false;
  const start = ownerDef.range.start.index ?? 0;
  const nameNode = context.tree.rootNode.descendantForIndex(start, ownerDef.range.end.index ?? start);
  const declaration = nameNode.parent;
  const declaredType = declaration?.childForFieldName("type");
  if (!declaration || !declaredType) return false;
  const fieldName = sliceText(fieldNode, context.source);
  for (const rule of embeds) {
    if (declaredType.type !== rule.body) continue;
    const list = rule.memberList ? findFirstNodeByType(declaredType, rule.memberList) : declaredType;
    if (!list) continue;
    for (const member of list.namedChildren ?? []) {
      if (member.type !== rule.member) continue;
      if (rule.nameless && member.childForFieldName("name")) continue;
      const specifier = rule.typeField ? member.childForFieldName(rule.typeField) : member;
      if (!specifier || sliceText(specifier, context.source) !== fieldName) continue;
      const embeddedDef = context.resolveIdentifier(fieldName, specifier);
      if (!embeddedDef || !declaresMembers(embeddedDef)) return false;
      const memberName = sliceText(access.property, context.source);
      if (!memberName) return false;
      context.receiverCalls.push({
        callerId: fromId,
        ownerId: ensureNode(context, embeddedDef),
        viaSupertypes: false,
        memberName,
        argumentCount: null,
        site: { file: context.moduleEntry.file, range: toRange(access.property) },
        memberScope: "any",
      });
      return true;
    }
  }
  return false;
}

/**
 * Collection can attach an arrow to any same-name local when the binding site is
 * not that local (`obj.helper = () => 1` beside `const helper = 1`). Prove that
 * this function is the value of `fn.def` itself: the declarator name is that
 * definition, or an identifier assignment resolves to it. Member and pattern
 * left-hand sides do not prove a local binding.
 */
function provesCallableBinding(context: EdgePassContext, fn: DetailedFunctionNode): boolean {
  const parent = fn.node.parent;
  if (!parent) return false;
  const start = fn.def.range.start.index;
  const end = fn.def.range.end.index;
  if (start === undefined || end === undefined) return false;

  const sameNodeRange = (candidate: SyntaxNodeLike | null): boolean =>
    !!candidate && candidate.startIndex === fn.node.startIndex && candidate.endIndex === fn.node.endIndex;
  if (
    (parent.type === "variable_declarator" ||
      parent.type === "public_field_definition" ||
      parent.type === "field_definition") &&
    sameNodeRange(parent.childForFieldName("value"))
  ) {
    const bindingName = parent.childForFieldName("name") ?? parent.childForFieldName("property");
    return (
      !!bindingName &&
      (isIdentifierType(context.sup, bindingName.type) || context.propertyIdentifierTypes.includes(bindingName.type)) &&
      bindingName.startIndex === start &&
      bindingName.endIndex === end
    );
  }

  if (parent.type === "assignment_expression" && sameNodeRange(parent.childForFieldName("right"))) {
    const left = parent.childForFieldName("left");
    if (!left || !isIdentifierType(context.sup, left.type)) return false;
    const resolved = context.resolveIdentifier(sliceText(left, context.source), left);
    return !!resolved && defNodeId(resolved) === defNodeId(fn.def);
  }

  return false;
}

/**
 * Whether a resolved member can be a `calls` target: a function, a class, or a binding the
 * declaration pass proved holds a function. A plain value (`export const value = 1`) is not.
 */
/** A JS/TS class is not callable without `new`; construction is an `instantiates` edge instead. */
function isCallTarget(context: EdgePassContext, def: SymbolDef): boolean {
  return def.kind === SymbolKind.Function || !!context.nodes.get(defNodeId(def))?.callable;
}

/**
 * A member of a proven same-file TS namespace receiver, selected with navigation's container and
 * overload rules. `undefined` means the receiver is not such a namespace.
 */
function resolveTypeScriptNamespaceMember(
  context: EdgePassContext,
  call: SyntaxNodeLike,
  receiverNode: SyntaxNodeLike,
  property: SyntaxNodeLike,
): SymbolDef | null | undefined {
  if ((context.sup.id !== "ts" && context.sup.id !== "tsx") || !isIdentifierType(context.sup, receiverNode.type))
    return undefined;
  const receiver = context.resolveIdentifier(sliceText(receiverNode, context.source), receiverNode);
  if (!receiver || fileIdentityKey(receiver.file) !== fileIdentityKey(context.moduleEntry.file)) return undefined;
  const member = sliceText(property, context.source);
  const candidates = findTypeScriptNamespaceMemberCandidates(context.moduleEntry.locals, member, receiver, context);
  if (!candidates.length) return undefined;
  const selected = selectMember(
    [receiver],
    {
      ownerKey: (def) => def.callable?.owner ?? fileIdentityKey(def.file),
      members: () => candidates,
      supertypes: () => [],
      name: (def) => def.localName,
      key: (def) => def.callable?.key ?? `${fileIdentityKey(def.file)}:${def.range.start.index}`,
      callable: (def) => def.callable,
      scope: () => "any",
      visible: () => true,
    },
    {
      name: member,
      argumentCount: getCallArgumentCount({ languageId: context.sup.id, source: context.source, call }),
      scope: "any",
      useFile: context.moduleEntry.file,
    },
  );
  return selected.status === "unique" ? selected.member : null;
}

function recordTypeScriptNamespaceCall(
  context: EdgePassContext,
  call: SyntaxNodeLike,
  access: ReceiverCallAccess,
  fromId: string,
): boolean {
  const selected = resolveTypeScriptNamespaceMember(context, call, access.receiver, access.property);
  if (selected === undefined) return false;
  if (selected && isCallTarget(context, selected)) recordDefEdge(context, fromId, selected, "calls", access.property);
  return true;
}

/** `new N.C()` on a same-file TS namespace constructs the namespace's class. */
function recordTypeScriptNamespaceConstruction(
  context: EdgePassContext,
  node: SyntaxNodeLike,
  target: SyntaxNodeLike,
  fromId: string,
): boolean {
  if (!isMemberAccessNode(context.sup, target)) return false;
  const { object, property } = getMemberAccessParts(context.sup, target);
  if (!object || !property) return false;
  const selected = resolveTypeScriptNamespaceMember(context, node, object, property);
  if (selected === undefined) return false;
  if (selected?.kind === SymbolKind.Class) recordDefEdge(context, fromId, selected, "instantiates", property);
  return true;
}

/** A member call on a `typeof import("spec")` binding names that module's export. */
function recordImportTypeCall(
  context: EdgePassContext,
  access: ReceiverCallAccess,
  fromId: string,
  proof: ReceiverBinding,
): boolean {
  if (!isJsTsLanguage(context.sup.id)) return false;
  const importType = proof.kind === "named-type" ? proof.typeNode : null;
  const specifier = importType?.type === "type_query" ? importTypeQuerySpecifier(importType) : null;
  if (!specifier) return false;
  const member = sliceText(access.property, context.source);
  const target = resolveImportTypeMember(context.index, context.moduleEntry.file, specifier, member);
  if (target && isCallTarget(context, target)) recordDefEdge(context, fromId, target, "calls", access.property);
  return true;
}

/** Swift `Foo()` / `Worker(name:)` is construction. Record `instantiates` and skip the call path. */
function recordSwiftCapitalizedConstruction(context: EdgePassContext, node: SyntaxNodeLike, fromId: string): boolean {
  const constructed = constructionTypeName(node, context.source, context.sup);
  if (!constructed) return false;
  const name = sliceText(constructed, context.source);
  // An inherited method can share a type's name; a deferred member lookup decides after the walk.
  if (context.resolveName(name, constructed)?.status === "deferred") return false;
  const target = context.resolveIdentifier(name, constructed);
  if (!target || !declaresMembers(target)) return false;
  recordDefEdge(context, fromId, target, "instantiates", constructed);
  return true;
}

function recordGoBuiltinConstruction(
  context: EdgePassContext,
  node: SyntaxNodeLike,
  fromId: string,
): boolean | undefined {
  const callTarget = getCallTarget(node);
  const calleeName =
    callTarget && isIdentifierType(context.sup, callTarget.type) ? sliceText(callTarget, context.source) : null;
  if (calleeName !== "new" && calleeName !== "make") return undefined;
  const argList = node.childForFieldName("arguments") ?? node.childForFieldName("argument_list");
  const typeNode = argList?.namedChildren?.find((child) => child.type === "type_identifier") ?? null;
  if (typeNode) tryResolveNode(context, typeNode, fromId, "instantiates");
  return false;
}

function recordRubySuper(
  context: EdgePassContext,
  fn: DetailedFunctionNode,
  superNode: SyntaxNodeLike,
  fromId: string,
): void {
  const container = nearestMemberContainer(fn.node);
  if (!container || container.type !== "class") return;
  const owner = memberContainerDef(context.moduleEntry, container);
  if (!owner) return;
  context.receiverCalls.push({
    callerId: fromId,
    ownerId: ensureNode(context, owner),
    viaSupertypes: true,
    memberName: fn.def.localName,
    argumentCount: null,
    site: { file: context.moduleEntry.file, range: toRange(superNode) },
    memberScope: "any",
  });
}

function recordRubyCall(
  context: EdgePassContext,
  node: SyntaxNodeLike,
  fromId: string,
  resolveCallTarget: (node: SyntaxNodeLike, callee: SyntaxNodeLike | null) => void,
): boolean | undefined {
  if (node.type !== "call") return undefined;
  const methodNode = node.childForFieldName("method");
  const receiverNode = node.childForFieldName("receiver");
  const methodName = methodNode ? sliceText(methodNode, context.source) : null;
  if (methodName === "new" && receiverNode) {
    const recorded = tryResolveNode(context, receiverNode, fromId, "instantiates");
    if (!recorded) {
      const rubyType = resolveRubyVisibleConstant(
        context.index,
        context.moduleEntry,
        context.sup,
        sliceText(receiverNode, context.source),
      );
      if (rubyType) recordDefEdge(context, fromId, rubyType, "instantiates", receiverNode);
    }
    return false;
  }
  if (methodNode?.type === "super") return true;
  if (methodNode) {
    resolveCallTarget(node, methodNode);
    return false;
  }
  const callee = getCallTarget(node);
  if (callee?.type === "super") return true;
  resolveCallTarget(node, callee);
  return false;
}

type SpecializedEdgePassRow = {
  beforeModule?: (context: EdgePassContext, rootNode: SyntaxNodeLike) => void;
  afterModule?: (context: EdgePassContext, rootNode: SyntaxNodeLike) => void;
  onNode?: (
    context: EdgePassContext,
    fn: DetailedFunctionNode,
    node: SyntaxNodeLike,
    fromId: string,
  ) => boolean | undefined;
  onReceiverCall?: (
    context: EdgePassContext,
    access: ReceiverCallAccess,
    fromId: string,
    hasLexicalBinding: (callee: SyntaxNodeLike) => boolean,
  ) => boolean;
  onCall?: (
    context: EdgePassContext,
    node: SyntaxNodeLike,
    fromId: string,
    resolveCallTarget: (node: SyntaxNodeLike, callee: SyntaxNodeLike | null) => void,
  ) => boolean | undefined;
};

/** Specialized syntax stays with its language; the common walker only dispatches these hooks. */
export const SPECIALIZED_EDGE_PASSES: Readonly<Record<string, SpecializedEdgePassRow>> = {
  python: { beforeModule: emitPythonDecoratorEdges },
  rust: {
    afterModule: emitRustImplEdges,
    onNode(context, _fn, node, fromId) {
      if (node.type === "token_tree") recordRustMacroArgumentCalls(context, node, fromId);
      return undefined;
    },
  },
  go: {
    onReceiverCall(context, access, fromId, hasLexicalBinding) {
      return (
        context.optionalMemberTypes.has(access.receiver.type) &&
        recordGoEmbeddedFieldReceiverCall(context, access, fromId, hasLexicalBinding)
      );
    },
    onCall: recordGoBuiltinConstruction,
  },
  ruby: {
    onNode(context, fn, node, fromId) {
      if (node.type !== "super") return undefined;
      recordRubySuper(context, fn, node, fromId);
      return true;
    },
    onCall: recordRubyCall,
  },
  swift: {
    onCall(context, node, fromId) {
      return recordSwiftCapitalizedConstruction(context, node, fromId) ? true : undefined;
    },
  },
};

export async function emitFunctionBodyEdges(
  context: EdgePassContext,
  functionNodes: DetailedFunctionNode[],
): Promise<void> {
  const specialized = SPECIALIZED_EDGE_PASSES[context.sup.id];
  const qualifiedConstructionTargets: Array<{
    fromId: string;
    member: SyntaxNodeLike;
    target: SyntaxNodeLike;
  }> = [];
  // Calls whose target navigation's member-access resolution decides after the walk, so both consumers agree:
  // C# calls through a dotted receiver (`P.Mix.M()`, `Imported.Outer.Inner.M()`), and `this`/`super` calls in an
  // unnamed type body (`new Base() { ... }`), which no declaration owns for the deferred hierarchy lookup.
  const dottedReceiverCalls: Array<{ fromId: string; access: ReceiverCallAccess }> = [];
  // An arrow field declared later becomes known callable when its own body is visited.
  const pendingPrivateCalls: Array<{ fromId: string; member: SymbolDef; access: ReceiverCallAccess }> = [];
  const callNodeTypes = new Set<string>([
    "call_expression",
    "call",
    "method_invocation",
    "invocation_expression",
    // PHP models plain calls and receiver calls as three distinct call nodes.
    "function_call_expression",
    "member_call_expression",
    "nullsafe_member_call_expression",
    "scoped_call_expression",
  ]);
  const newNodeTypes: Record<string, true> = {
    new_expression: true,
    object_creation_expression: true,
    struct_expression: true,
    composite_literal: true,
    // tree-sitter-zig's own struct-literal node, e.g. `Widget{}` or a qualified `ns.Widget{}`.
    struct_initializer: true,
  };
  // Receiver typing and lexical member lookup are initialized only for receiver calls.
  const receiverProofs = new Map<string, ReceiverProof>();
  const hasLexicalBinding = (callee: SyntaxNodeLike): boolean =>
    !!findClosestScopeBinding(context.scopeIndex, sliceText(callee, context.source), callee, context.sup);
  let membersByContainer: Map<number, DetailedFunctionNode[]> | undefined;
  const lexicalMembers = (container: SyntaxNodeLike): DetailedFunctionNode[] => {
    if (!membersByContainer) {
      membersByContainer = new Map();
      for (const candidate of functionNodes) {
        if (!isClassMemberFunction(candidate)) continue;
        const owner = nearestMemberContainer(candidate.node);
        if (!owner || !isDirectKeywordMemberDeclaration(candidate.node, owner)) continue;
        const members = membersByContainer.get(owner.startIndex);
        if (members) members.push(candidate);
        else membersByContainer.set(owner.startIndex, [candidate]);
      }
    }
    return membersByContainer.get(container.startIndex) ?? [];
  };
  /** Whether the type that `this`/`super` at `site` name is an unnamed body, which has no declaration to read. */
  const receiverOwnerIsUnnamed = (site: SyntaxNodeLike): boolean => {
    const container = nearestMemberContainer(site);
    if (!container || !isAnonymousMemberContainer(context.sup.id, container)) return false;
    return !memberContainerDef(context.moduleEntry, container);
  };

  for (const fn of functionNodes) {
    const phpCaseInsensitive = context.sup.id === "php";
    const fromId = ensureNode(context, fn.def);
    const provenNode = context.nodes.get(fromId);
    // Function-valued bindings (`const helper = () => 1`) keep their `variable` kind;
    // the callable metadata records that this binding was proven to hold a function.
    if (provenNode && provenNode.kind !== "function" && provesCallableBinding(context, fn)) {
      provenNode.callable = true;
      context.noteCallableName(
        fn.name,
        context.sup.id === "php",
        context.sup.id === "swift" ? context.sup.normalizeIdentifier : undefined,
      );
    }
    const seenAliases = new Set<string>();
    // Calls whose target needs an async member lookup (C++ out-of-line owner members, included
    // C/C++ declarations of one callable); settled after the walk.
    const deferredCalls: Array<{ callee: SyntaxNodeLike; name: string; resolution: NameResolution }> = [];
    const deferredAliasUses: Array<{
      node: SyntaxNodeLike;
      name: string;
      resolution: NameResolution;
      target: SymbolDef;
    }> = [];
    const qualifiedCppCalls: Array<{
      node: SyntaxNodeLike;
      access: ReceiverCallAccess;
      target: SymbolDef | null;
      ownerPath: string[];
    }> = [];
    const nestedFunctions = new Set(
      functionNodes
        .filter(
          (candidate) =>
            candidate.node !== fn.node &&
            candidate.node.startIndex >= fn.node.startIndex &&
            candidate.node.endIndex <= fn.node.endIndex,
        )
        .map((candidate) => candidate.node),
    );

    const recordAliasUse = (node: SyntaxNodeLike): void => {
      if (context.membersOnly || !isIdentifierType(context.sup, node.type)) return;
      if (context.sup.id === "csharp" && context.sup.isDeclarationName(node)) return;
      const name = sliceText(node, context.source);
      if (context.sup.id === "php") {
        // Resolve the occurrence's namespace; a plain-name map cannot distinguish PHP roles.
        const importType = inferPhpQualifiedReferenceImportType(node) ?? "const";
        const aliasName = importType === "const" ? name : foldPhpIdentifierCase(name);
        const seenKey = `${importType}:${aliasName}`;
        if (seenAliases.has(seenKey)) return;
        seenAliases.add(seenKey);
        const phpImport = findPhpImportAlias(context.moduleEntry.imports, name, importType);
        if (!phpImport || typeof phpImport.resolved !== "string") return;
        const resolved = resolvePhpExportByImportType(
          context.index,
          phpImport.resolved,
          phpImport.imported,
          importType,
        );
        if (resolved?.kind === "resolved") recordDefEdge(context, fromId, resolved.def, "uses");
        return;
      }
      const nameKey = context.aliasKey(name);
      const tableDef = context.aliasToTargetDef.get(nameKey);
      const jvmLanguage = context.sup.id === "java" || context.sup.id === "kotlin";
      const qualifiedType = isQualifiedTypeSuffix(context.sup, node);
      let qualifiedExpression = false;
      let valueReceiver = false;
      if (context.sup.id === "kotlin" && node.parent?.type === "navigation_expression") {
        const first = name[0];
        const capitalized = !!first && first === first.toUpperCase() && first !== first.toLowerCase();
        const importedName = !!tableDef || context.aliasToTargetModule.has(nameKey);
        const expression = importedName || capitalized ? kotlinQualifiedExpression(context.sup, node) : null;
        if (expression) {
          const chain = collectMemberAccessChain({ sup: context.sup, source: context.source, chainNode: expression });
          if (chain) {
            const base = chain.base;
            if (!isReceiverNameNode(context.sup, base.type) || sliceText(base, context.source) === "this") {
              valueReceiver = true;
            } else {
              const binding = findClosestScopeBinding(
                context.scopeIndex,
                sliceText(base, context.source),
                base,
                context.sup,
              );
              valueReceiver = binding?.kind === "local" || binding?.kind === "param" || binding?.kind === "function";
            }
          }
          valueReceiver &&= tableDef?.kind === SymbolKind.Function;
          qualifiedExpression = !valueReceiver;
        }
      }
      const resolvableQualifiedType = qualifiedType && (jvmLanguage || !!tableDef);
      if (resolvableQualifiedType || qualifiedExpression) {
        // The shared lookup may prove the qualified target, but the bare alias cannot.
        const qualified = context.resolveIdentifier(name, node);
        if (qualified) recordDefEdge(context, fromId, qualified, "uses");
        return;
      }
      if (seenAliases.has(nameKey)) return;
      if (tableDef && context.sup.id === "csharp" && csharpTypeOnlyName(node, true)) {
        const target = context.resolveIdentifier(name, node);
        if (target && declaresMembers(target)) {
          seenAliases.add(nameKey);
          recordDefEdge(context, fromId, target, "uses");
        }
        return;
      }
      let positionedResolution: NameResolution | null | undefined;
      const kotlinExpression = context.sup.id === "kotlin" && node.parent?.type !== "user_type";
      if (tableDef && kotlinExpression) {
        positionedResolution = context.resolveName(name, node, valueReceiver);
        if (positionedResolution?.status === "deferred") {
          deferredAliasUses.push({ node, name, resolution: positionedResolution, target: tableDef });
          return;
        }
      }
      let target: SymbolDef | null =
        tableDef && context.aliasTableAnswers(name, node, positionedResolution) ? tableDef : null;
      if (!target) {
        const modFile = context.aliasToTargetModule.get(nameKey);
        if (modFile && context.aliasTableAnswers(name, node) && context.moduleAliasIsUnshadowed(name, node)) {
          let exportedName: string | null = null;
          const parent = node.parent;
          if (
            parent &&
            (parent.type === context.memberExpressionType || parent.type === "optional_member_expression")
          ) {
            const { property: prop } = getMemberAccessParts(context.sup, parent);
            if (prop && context.propertyIdentifierTypes.includes(prop.type)) {
              exportedName = sliceText(prop, context.source);
            }
          }
          // An unaliased Python `import a.b` makes `a.b` the submodule, whatever `a`'s `__init__` declares as `b`.
          const namesDottedModule =
            !!exportedName &&
            context.sup.id === "python" &&
            context.aliasToTargetModule.has(`${nameKey}.${exportedName}`);
          if (exportedName && !namesDottedModule) {
            target = context.resolveExportFrom(modFile, exportedName);
            if (!target && (context.sup.id !== "go" || isGoExportedMemberName(context.sup.id, exportedName))) {
              const targetModule = context.index.byFile.get(fileIdentityKey(modFile));
              target = (targetModule?.locals ?? []).find((local) => local.localName === exportedName) ?? null;
            }
          }
        }
      }
      if (!target) return;
      seenAliases.add(nameKey);
      recordDefEdge(context, fromId, target, "uses");
    };

    const recordMemberUse = (node: SyntaxNodeLike): void => {
      if (!context.optionalMemberTypes.has(node.type)) return;
      const targetDef = context.resolveMemberChainTarget(node);
      if (targetDef) {
        recordDefEdge(context, fromId, targetDef, "uses");
      }
    };

    const classifyImport = (name: string, node: SyntaxNodeLike): "module-import" | "static-type" | null => {
      if (context.sup.id === "csharp") {
        const alias = csharpAliasAt(context.index, context.moduleEntry, name, node);
        if (alias?.kind === "named" && context.moduleAliasIsUnshadowed(name, node)) {
          const target = context.resolveIdentifier(name, node);
          if (target && declaresMembers(target)) return "static-type";
        }
      }
      if (isJsTsLanguage(context.sup.id) && isIdentifierType(context.sup, node.type)) {
        const imported =
          effectiveExplicitBinding(
            context.moduleEntry.imports,
            context.sup.id,
            (candidate) => candidate.kind === "namespace" && candidate.localNS === name,
            node.startIndex,
          ) ?? innermostNamespaceImport(context.moduleEntry.imports, name, node);
        if (imported?.mechanism === "cjs" && typeof imported.resolved === "string") {
          const value = cjsRequireValueBinding(context.index, imported.resolved);
          const lexical = value ? context.resolveIdentifier(name, node) : null;
          if (value && declaresMembers(value) && lexical && defNodeId(value) === defNodeId(lexical)) {
            return "static-type";
          }
          return "module-import";
        }
      }
      if (context.aliasToTargetModule.has(context.aliasKey(name)) && context.moduleAliasIsUnshadowed(name, node)) {
        return "module-import";
      }
      return null;
    };

    /**
     * Resolves a receiver method call against the receiver's type. Members declared
     * alongside the caller resolve here; anything needing another module's members
     * becomes a deferred candidate.
     */
    const recordReceiverCall = (
      node: SyntaxNodeLike,
      access: ReceiverCallAccess,
      forcedMemberScope?: ReceiverMemberScope,
      proof?: ReceiverBinding,
    ): void => {
      const memberName = sliceText(access.property, context.source);
      if (!memberName) return;
      const binding =
        proof ??
        classifyReceiver(
          context.sup,
          access.receiver,
          context.source,
          receiverProofs,
          fn.node.startIndex,
          access.accessNode,
          hasLexicalBinding,
          classifyImport,
        );
      const pythonInstanceReceiver =
        context.sup.id === "python" &&
        ((binding.kind === "own-type" && sliceText(access.receiver, context.source) === "self") ||
          (binding.kind === "named-type" && binding.proof !== "static-type"));
      if (binding.kind === "module-import" || binding.kind === "unknown") return;

      const site = { file: context.moduleEntry.file, range: toRange(access.property) };
      // Shared call-count facts treat unproven spread expansions as unknown (null),
      // so overload selection never fabricates an argument count.
      const argumentCount = supportsReceiverMemberOverloads(context.sup.id)
        ? getCallArgumentCount({ languageId: context.sup.id, source: context.source, call: node })
        : null;
      if (binding.kind === "named-type") {
        const typeDef = resolveNamedType(context, binding.typeName, binding.typeNode, binding.constructed);
        if (!typeDef) return;
        context.receiverCalls.push({
          callerId: fromId,
          ownerId: ensureNode(context, typeDef),
          viaSupertypes: false,
          memberName,
          argumentCount,
          site,
          ...(context.sup.id === "kotlin" && kotlinHasTrailingLambda(access.property)
            ? { kotlinTrailingLambda: true }
            : {}),
          memberScope: forcedMemberScope ?? binding.memberScope,
          ...(pythonInstanceReceiver ? { pythonInstanceReceiver: true } : {}),
          ...(context.sup.id === "go" && !isGoExportedMemberName(context.sup.id, memberName)
            ? { goPackagePeerFiles: getCompilationUnitPeers(context.index, context.moduleEntry.file).files }
            : {}),
          caseInsensitiveMemberName: phpCaseInsensitive,
        });
        return;
      }
      if (binding.kind === "own-type") {
        const normalizedMemberName =
          context.sup.id === "swift" ? context.sup.normalizeIdentifier(memberName) : memberName;
        const container = nearestMemberContainer(fn.node);
        const declared = container
          ? lexicalMembers(container).filter((candidate) => {
              const candidateName =
                context.sup.id === "swift"
                  ? context.sup.normalizeIdentifier(candidate.def.localName)
                  : candidate.def.localName;
              const nameMatches = phpCaseInsensitive
                ? foldPhpIdentifierCase(candidateName) === foldPhpIdentifierCase(memberName)
                : candidateName === normalizedMemberName;
              if (!nameMatches) return false;
              if (binding.memberScope === "any") return true;
              return declarationNodeIsStatic(candidate.node, context.source) === (binding.memberScope === "static");
            })
          : [];
        const hasKotlinPropertyCollision =
          context.sup.id === "kotlin" &&
          !!container &&
          context.moduleEntry.locals.some((local) => {
            if (local.kind !== SymbolKind.Variable || local.localName !== memberName) return false;
            const start = local.range.start.index;
            if (start === undefined || start < container.startIndex || start >= container.endIndex) return false;
            const nameNode = context.tree.rootNode.descendantForIndex(start, start);
            return isDirectKeywordMemberDeclaration(nameNode, container);
          });
        if (declared.length === 1 && !hasKotlinPropertyCollision) {
          const unique = declared[0]!;
          recordDefEdge(context, fromId, unique.def, "calls", access.property);
          // File-hidden Swift members stay off cross-file shared owners. Skipping the
          // coalesced deferred lookup keeps a same-container private call from being stripped.
          if (isSwiftFileHiddenSharedOwnerMember(context.sup.id, unique.node)) return;
        }
      }

      const receiverContainer = nearestMemberContainer(access.accessNode);
      const receiverContainerName = receiverContainer?.childForFieldName("name");
      const receiverOwnerDef = receiverContainerName
        ? context.moduleEntry.locals.find(
            (local) => local.range.start.index === receiverContainerName.startIndex && declaresMembers(local),
          )
        : undefined;

      context.receiverCalls.push({
        callerId: fromId,
        ownerId: receiverOwnerDef ? ensureNode(context, receiverOwnerDef) : null,
        viaSupertypes: binding.kind === "supertype",
        memberName,
        argumentCount,
        site,
        ...(context.sup.id === "kotlin" && kotlinHasTrailingLambda(access.property)
          ? { kotlinTrailingLambda: true }
          : {}),
        memberScope: binding.memberScope,
        ...(pythonInstanceReceiver ? { pythonInstanceReceiver: true } : {}),
        caseInsensitiveMemberName: phpCaseInsensitive,
      });
    };

    /**
     * A bare call inside a member function carries no receiver syntax, but in
     * languages where that implicitly targets `this` it can still name an
     * inherited member. Deferred like `recordReceiverCall`'s own-type/supertype
     * candidates so cross-file base-type members resolve once every module's
     * `member_of` and hierarchy edges are known.
     */
    const recordImplicitSelfMemberCall = (
      node: SyntaxNodeLike,
      callee: SyntaxNodeLike,
      fallbackDef: SymbolDef | null = null,
    ): void => {
      if (!supportsImplicitSelfMemberCalls(context.sup.id) || !isIdentifierType(context.sup, callee.type)) return;
      const container = nearestMemberContainer(fn.node);
      const containerName = container?.childForFieldName("name");
      const ownerDef = containerName
        ? context.moduleEntry.locals.find(
            (local) => local.range.start.index === containerName.startIndex && declaresMembers(local),
          )
        : undefined;
      if (!ownerDef) return;
      const memberName = sliceText(callee, context.source);
      if (!memberName) return;
      const argumentCount = supportsReceiverMemberOverloads(context.sup.id)
        ? getCallArgumentCount({ languageId: context.sup.id, source: context.source, call: node })
        : null;
      context.receiverCalls.push({
        callerId: fromId,
        ownerId: ensureNode(context, ownerDef),
        viaSupertypes: false,
        memberName,
        argumentCount,
        site: { file: context.moduleEntry.file, range: toRange(callee) },
        ...(context.sup.id === "kotlin" && kotlinHasTrailingLambda(callee) ? { kotlinTrailingLambda: true } : {}),
        // A static caller can only reach a static bare member; an instance caller
        // may bare-call either, matching C#'s unqualified invocation rules.
        memberScope: nodeInStaticMemberContext(fn.node, context.source) ? "static" : "any",
        caseInsensitiveMemberName: phpCaseInsensitive,
        fallbackTargetId: fallbackDef ? ensureNode(context, fallbackDef) : undefined,
      });
    };

    /**
     * Records the `calls` edge for one call node. A call with a receiver is resolved
     * only through its import chain or its receiver's type: matching the bare member
     * name against module locals and import aliases would attribute `$this->helper()`
     * to an unrelated imported `helper`.
     */
    const resolveCallTarget = (node: SyntaxNodeLike, callee: SyntaxNodeLike | null): void => {
      const access = receiverCallAccess(context.sup, node, callee);
      if (access) {
        if (isJsTsLanguage(context.sup.id) && access.property.type === "private_property_identifier") {
          const target = resolveEcmaPrivateName(access.property, context.moduleEntry.locals);
          if (target.status === "resolved" && target.target) {
            const member = target.target;
            const acceptsCall = memberAcceptsCallAt(
              context.index,
              member,
              access.accessNode,
              context.source,
              context.sup.id,
            );
            if (acceptsCall && isCallTarget(context, member)) {
              recordDefEdge(context, fromId, member, "calls", access.property);
            } else if (acceptsCall && member.kind === SymbolKind.Variable) {
              pendingPrivateCalls.push({ fromId, member, access });
            }
          }
          return;
        }
        if (recordTypeScriptNamespaceCall(context, node, access, fromId)) return;
        const typeScopedCppCall =
          context.sup.id === "cpp" &&
          context.source.slice(access.receiver.endIndex, access.property.startIndex).includes("::");
        if (typeScopedCppCall) {
          const qualifiedName = cppQualifiedNameSegments(access.accessNode, context.source).join("::");
          const qualifiedTarget = context.resolveIdentifier(qualifiedName, access.property);
          // Whether the owner is a class, and whether the caller has an implicit `this` of that class,
          // needs the exact qualified path, so the decision waits until the function body is walked.
          qualifiedCppCalls.push({
            node,
            access,
            target: qualifiedTarget,
            ownerPath: qualifiedName.split("::").slice(0, -1),
          });
          return;
        }
        const receiverProof = classifyReceiver(
          context.sup,
          access.receiver,
          context.source,
          receiverProofs,
          fn.node.startIndex,
          access.accessNode,
          hasLexicalBinding,
          classifyImport,
        );
        if (recordImportTypeCall(context, access, fromId, receiverProof)) return;
        if (supportsDeclaredFieldChains(context.sup.id) && isMemberAccessNode(context.sup, access.receiver)) {
          dottedReceiverCalls.push({ fromId, access });
          return;
        }
        const scopedCsharpAlias =
          context.sup.id === "csharp" &&
          isIdentifierType(context.sup, access.receiver.type) &&
          !context.aliasTableAnswers(sliceText(access.receiver, context.source), access.receiver);
        if (scopedCsharpAlias) {
          // Let the shared member resolver select the alias in scope, not a file-wide receiver type.
          dottedReceiverCalls.push({ fromId, access });
          return;
        }
        // A Kotlin `this` inside a lambda that may have a receiver, or `this@label`, names a receiver or type that only
        // the shared member lookup can prove, as navigation does.
        if (context.sup.id === "kotlin" && kotlinThisNeedsScopeProof(access.receiver)) {
          dottedReceiverCalls.push({ fromId, access });
          return;
        }
        if (receiverProof.kind === "own-type" || receiverProof.kind === "supertype") {
          if (receiverOwnerIsUnnamed(access.accessNode)) {
            dottedReceiverCalls.push({ fromId, access });
            return;
          }
          recordReceiverCall(node, access, undefined, receiverProof);
          return;
        }
        if (
          context.sup.id === "swift" &&
          isIdentifierType(context.sup, access.receiver.type) &&
          context.resolveIdentifier(sliceText(access.receiver, context.source), access.receiver)?.kind ===
            SymbolKind.TypeAlias
        ) {
          dottedReceiverCalls.push({ fromId, access });
          return;
        }
        if (tryResolveChain(context, access.accessNode, fromId, "calls")) return;
        if (
          context.sup.id === "zig" &&
          context.optionalMemberTypes.has(access.receiver.type) &&
          recordZigQualifiedTypeReceiverCall(context, node, access, fromId)
        ) {
          return;
        }
        if (specialized?.onReceiverCall?.(context, access, fromId, hasLexicalBinding)) return;
        const javaConstructionType =
          context.sup.id === "java" && access.receiver.type === "object_creation_expression"
            ? constructionTypeName(access.receiver, context.source, context.sup)
            : null;
        if (
          context.sup.id === "java" &&
          javaConstructionType &&
          isMemberAccessNode(context.sup, javaConstructionType)
        ) {
          dottedReceiverCalls.push({ fromId, access });
          return;
        }
        if (
          context.sup.id === "kotlin" &&
          (isIdentifierType(context.sup, access.receiver.type) || access.receiver.type === "navigation_expression") &&
          !context.resolveIdentifier(sliceText(access.receiver, context.source), access.receiver)
        ) {
          dottedReceiverCalls.push({ fromId, access });
          return;
        }
        recordReceiverCall(node, access, undefined, receiverProof);
        return;
      }
      if (!callee) return;
      // A name whose lookup waits on an async member step (implicit `this`/`self`, C++ out-of-line
      // owners, included C/C++ declarations) settles after the walk exactly as navigation does.
      if (isIdentifierType(context.sup, callee.type)) {
        const name = sliceText(callee, context.source);
        const resolution = context.resolveName(name, callee);
        if (resolution?.status === "deferred") {
          deferredCalls.push({ callee, name, resolution });
          return;
        }
      }
      if (!tryResolveNode(context, callee, fromId, "calls")) recordImplicitSelfMemberCall(node, callee);
    };

    const recordCallOrInstantiation = (node: SyntaxNodeLike): boolean => {
      const nodeResult = specialized?.onNode?.(context, fn, node, fromId);
      if (nodeResult !== undefined) return nodeResult;
      if (callNodeTypes.has(node.type)) {
        const callResult = specialized?.onCall?.(context, node, fromId, resolveCallTarget);
        if (callResult !== undefined) return callResult;
        resolveCallTarget(node, getCallTarget(node));
      }
      if (newNodeTypes[node.type]) {
        const keyword = phpObjectCreationKeyword(node, context.source, context.sup);
        if (keyword) {
          const created = resolvePhpObjectCreationTarget(
            context.index,
            context.moduleEntry,
            keyword,
            context.source,
            context.sup,
          );
          if (created) recordDefEdge(context, fromId, created, "instantiates", keyword.nameNode);
        } else {
          const target = constructionTypeName(node, context.source, context.sup) ?? getNewTarget(node);
          if (target) {
            if (recordTypeScriptNamespaceConstruction(context, node, target, fromId)) return true;
            const property = isMemberAccessNode(context.sup, target)
              ? getMemberAccessParts(context.sup, target).property
              : null;
            if ((context.sup.id === "java" || context.sup.id === "csharp") && property) {
              qualifiedConstructionTargets.push({ fromId, member: property, target });
            } else {
              tryResolveNode(context, target, fromId, "instantiates");
            }
          }
        }
      }
      return true;
    };

    const walkFunctionBody = (node: SyntaxNodeLike, allowCallProcessing: boolean): void => {
      if (node !== fn.node && nestedFunctions.has(node)) return;
      recordAliasUse(node);
      recordMemberUse(node);
      const allowChildCallProcessing = allowCallProcessing ? recordCallOrInstantiation(node) : false;
      for (const child of node.namedChildren ?? []) walkFunctionBody(child, allowChildCallProcessing);
    };

    walkFunctionBody(fn.node, true);
    for (const call of deferredCalls) {
      const target = await context.settleName(call.name, call.callee, call.resolution);
      // Swift `Foo()` whose deferred lookup settles on a type is construction.
      const label = context.sup.id === "swift" && target && declaresMembers(target) ? "instantiates" : "calls";
      if (target) recordDefEdge(context, fromId, target, label, call.callee);
    }
    for (const use of deferredAliasUses) {
      const nameKey = context.aliasKey(use.name);
      if (seenAliases.has(nameKey)) continue;
      const target = await context.settleName(use.name, use.node, use.resolution);
      if (!target || defNodeId(target) !== defNodeId(use.target)) continue;
      seenAliases.add(nameKey);
      recordDefEdge(context, fromId, target, "uses");
    }
    for (const call of qualifiedCppCalls) {
      const owner = call.ownerPath.length
        ? await resolveCppQualifiedMemberContainer(
            context.index,
            context.moduleEntry,
            call.ownerPath,
            context.loadParsedFile,
          )
        : null;
      if (!owner) {
        // A namespace (or no) qualifier names the free function directly.
        if (call.target) recordDefEdge(context, fromId, call.target, "calls", call.access.property);
        continue;
      }
      const implicitThis = await cppQualifiedOwnerHasImplicitThis(
        context.index,
        context.moduleEntry,
        call.access.accessNode,
        context.source,
        context.sup,
        owner,
      );
      if (implicitThis && call.target) {
        recordDefEdge(context, fromId, call.target, "calls", call.access.property);
      } else {
        // Without an implicit `this` of the owner, `Owner::member()` can only name a static member.
        recordReceiverCall(call.node, call.access, implicitThis ? "any" : "static");
      }
    }
  }
  for (const { fromId, member, access } of pendingPrivateCalls) {
    if (isCallTarget(context, member)) recordDefEdge(context, fromId, member, "calls", access.property);
  }
  for (const { fromId, access } of dottedReceiverCalls) {
    const member = await context.resolveMemberAccessTarget(access.property);
    // The graph records no edge for a call its target cannot accept, as for other member calls.
    if (member && memberAcceptsCallAt(context.index, member, access.accessNode, context.source, context.sup.id)) {
      recordDefEdge(context, fromId, member, "calls", access.property);
    }
  }
  for (const target of qualifiedConstructionTargets) {
    const resolved = await context.resolveMemberAccessTarget(target.member);
    if (resolved) {
      recordDefEdge(context, target.fromId, resolved, "instantiates", target.member);
    } else {
      tryResolveNode(context, target.target, target.fromId, "instantiates");
    }
  }
}

/** Qualifiers name a container, not another base type. */
const QUALIFIER_NAME_FIELD: Record<string, string> = {
  qualified_name: "name", // C#: Namespace.Base, Outer.Inner
  alias_qualified_name: "name", // C#: X::Base, global::Namespace.Base
  qualified_identifier: "name", // C++: ns::Base
};

/**
 * The node that spells a qualified base whose qualifier the member-access lookup proves: a Python module attribute, a
 * Ruby constant path, a Go package type. The base's own last name is never looked up by itself.
 */
const MEMBER_ACCESS_BASE_NODE_TYPES: Readonly<Record<string, string>> = {
  python: "attribute",
  ruby: "scope_resolution",
  go: "qualified_type",
};

function isMemberAccessBase(sup: LanguageSupport, node: SyntaxNodeLike): boolean {
  return MEMBER_ACCESS_BASE_NODE_TYPES[sup.id] === node.type;
}

/** Generic wrappers contribute the base name, not their type arguments. */
const GENERIC_WRAPPER_TYPES: Record<string, true> = {
  generic_name: true,
  generic_type: true,
  template_type: true,
};
const GENERIC_ARGUMENT_CHILD_TYPES: Record<string, true> = {
  type_argument_list: true, // C#: generic_name
  type_arguments: true, // Java/TypeScript generic_type, Kotlin/Swift user_type
  template_argument_list: true, // C++: template_type
  type_modifiers: true, // Kotlin/Swift user_type nullability/variance modifiers
};

/** Kotlin delegation-specifier forms that wrap the base type with call syntax. */
const CALL_LIKE_WRAPPER_SKIP_TYPES: Record<string, Record<string, true>> = {
  constructor_invocation: { value_arguments: true }, // Base(args)
  explicit_delegation: { primary_expression: true }, // Interface by delegate
};

/** Remove type arguments and wrapper syntax before resolving a direct base. */
function narrowBaseSpecifierNode(node: SyntaxNodeLike): SyntaxNodeLike {
  let current = node;
  for (;;) {
    const qualifierField = QUALIFIER_NAME_FIELD[current.type];
    if (qualifierField) {
      const named = current.childForFieldName(qualifierField);
      if (!named || named === current) return current;
      current = named;
      continue;
    }
    if (current.type === "scoped_type_identifier") {
      let named = current.childForFieldName("name");
      if (!named) {
        const parts = current.namedChildren ?? [];
        for (let index = parts.length - 1; index >= 0; index -= 1) {
          const part = parts[index]!;
          if (part.type !== "annotation" && part.type !== "marker_annotation") {
            named = part;
            break;
          }
        }
      }
      if (!named || named === current) return current;
      current = named;
      continue;
    }
    if (current.type === "user_type") {
      // A dotted Kotlin or Swift type is its last segment, found through the segments before it.
      const named = (current.namedChildren ?? []).findLast((child) => !GENERIC_ARGUMENT_CHILD_TYPES[child.type]);
      if (!named || named === current) return current;
      current = named;
      continue;
    }
    if (GENERIC_WRAPPER_TYPES[current.type]) {
      const named =
        current.childForFieldName("name") ??
        (current.namedChildren ?? []).find((child) => !GENERIC_ARGUMENT_CHILD_TYPES[child.type]);
      if (!named || named === current) return current;
      current = named;
      continue;
    }
    if (current.type === "subscript") {
      // Python `Base[Payload]` generic base: `value` names the base type.
      const value = current.childForFieldName("value");
      if (!value) return current;
      current = value;
      continue;
    }
    const callSkipTypes = CALL_LIKE_WRAPPER_SKIP_TYPES[current.type];
    if (callSkipTypes) {
      const named = (current.namedChildren ?? []).find((child) => !callSkipTypes[child.type]);
      if (!named) return current;
      current = named;
      continue;
    }
    return current;
  }
}

/** Collect one type identifier per direct base or interface specifier. */
function collectBaseSpecifierIdentifiers(node: SyntaxNodeLike, sup: LanguageSupport, out: SyntaxNodeLike[]): void {
  if (isUnprovenHeritageExpression(node)) return;
  if (isNonBaseHeritageArgument(node)) return;
  if (sup.id === "cpp" && node.type === "qualified_identifier") {
    out.push(node);
    return;
  }
  const narrowed = narrowBaseSpecifierNode(node);
  if (isUnprovenHeritageExpression(narrowed)) return;
  if (isJsTsLanguage(sup.id) && narrowed.type === "member_expression") {
    out.push(narrowed);
    return;
  }
  if (isMemberAccessBase(sup, narrowed)) {
    out.push(narrowed);
    return;
  }
  if (isIdentifierType(sup, narrowed.type) || narrowed.type === "type_identifier") {
    out.push(narrowed);
    return;
  }
  for (const child of narrowed.namedChildren ?? []) collectBaseSpecifierIdentifiers(child, sup, out);
}

/** The syntax type of the declaration a Swift definition names (`protocol_declaration`, `typealias_declaration`, ...). */
async function swiftDeclarationType(context: EdgePassContext, def: SymbolDef): Promise<string | undefined> {
  const tree =
    fileIdentityKey(def.file) === fileIdentityKey(context.moduleEntry.file)
      ? context.tree
      : (await context.loadParsedFile(def.file))?.tree;
  const start = def.range.start.index;
  if (!tree || start === undefined) return undefined;
  return tree.rootNode.descendantForIndex(start, def.range.end.index ?? start).parent?.type;
}

/**
 * `swiftDeclarationType` for a type-kind definition: a protocol, enum, or typealias. A class, struct, or actor is
 * never type-kind, so resolving one loads no syntax tree.
 */
async function swiftTypeKindDeclarationType(context: EdgePassContext, def: SymbolDef): Promise<string | undefined> {
  if (def.kind !== SymbolKind.TypeAlias) return undefined;
  return await swiftDeclarationType(context, def);
}

/** What a Swift base clause names once typealiases are followed, and whether that declaration is a protocol. */
type SwiftBase = { target: SymbolDef; isProtocol: boolean };

/**
 * A Swift base clause names a class, a protocol, or a typealias for one. An alias is followed to the single class or
 * protocol it provably reaches, so the edge targets that declaration, never the alias; an unproven alias names none
 * and adds no edge.
 */
async function resolveSwiftBase(context: EdgePassContext, named: SymbolDef): Promise<SwiftBase | null> {
  let target = named;
  let declaration = await swiftTypeKindDeclarationType(context, target);
  if (declaration === "typealias_declaration") {
    const reached = await resolveSwiftAliasHeritage(context.index, target);
    if (!reached) return null;
    target = reached;
    declaration = await swiftTypeKindDeclarationType(context, target);
  }
  return { target, isProtocol: declaration === "protocol_declaration" };
}

/**
 * A protocol's own base clause refines other protocols (`extends`), so a protocol is never an implementation of a
 * protocol it inherits. A class, struct, enum, actor, or extension conforms to a protocol (`implements`); a class
 * base keeps the clause's superclass-first relation.
 */
function swiftBaseRelation(
  clause: SyntaxNodeLike,
  base: SwiftBase,
  clauseRelation: ReceiverAncestryRelation,
): ReceiverAncestryRelation {
  if (clause.parent?.type === "protocol_declaration") return "extends";
  return base.isProtocol ? "implements" : clauseRelation;
}

/**
 * The nominal type an unconditional extension header names: the type itself, or the single nominal type a
 * typealias provably reaches. An unproven alias names none, so it can neither gain nor donate a conformance.
 */
async function swiftExtendedNominal(context: EdgePassContext, target: SymbolDef): Promise<SymbolDef | null> {
  if ((await swiftTypeKindDeclarationType(context, target)) !== "typealias_declaration") return target;
  const nominal = await resolveSwiftAliasContainer(context.index, target);
  return nominal && !nominal.swiftExtensionOwner ? nominal : null;
}

/** A bare base name: the shared lookup, or a Swift nested type, or a Ruby constant `require` published. */
async function resolveBareBase(context: EdgePassContext, identifier: SyntaxNodeLike): Promise<SymbolDef | null> {
  const name = sliceText(identifier, context.source);
  // A later segment of a dotted Swift type names a type nested in the segments before it; settling runs that lookup.
  if (isSwiftQualifiedTypeSuffix(identifier)) {
    return await context.settleName(name, identifier, context.resolveName(name, identifier));
  }
  const target = context.resolveIdentifier(name, identifier);
  // Ruby `require` publishes a top-level constant, not a nested one. Reuse the
  // same visibility as goto so `class Worker < Base` follows the required class.
  if (!target && context.sup.id === "ruby") {
    return resolveRubyVisibleConstant(context.index, context.moduleEntry, context.sup, name);
  }
  return target;
}

/**
 * A qualified base (`other.Base`, `Other::Base`, Go `pkg.Base`) is found through its qualifier by the lookup member
 * navigation uses for the same clause, or it names nothing: the last name alone would match any same-named type. A
 * Ruby constant path is searched through the namespaces that enclose it, as goto does.
 */
async function resolveQualifiedPathBase(
  context: EdgePassContext,
  qualified: SyntaxNodeLike,
): Promise<SymbolDef | null> {
  if (context.sup.id === "ruby") {
    const reference = readRubyConstantReference(qualified, context.index, context.moduleEntry);
    return reference ? resolveRubyConstantReference(context.index, context.moduleEntry, reference) : null;
  }
  const names = qualifiedBaseNames(context.sup, context.source, qualified);
  if (!names) return null;
  const [base, ...path] = names;
  const container = await resolveQualifiedMemberContainer(
    context.index,
    context.moduleEntry,
    base!,
    path,
    context.sup.normalizeIdentifier,
    context.sup,
    { node: qualified, source: context.source, tree: context.tree, scopeIndex: context.scopeIndex },
  );
  return container ?? null;
}

async function resolveBaseSpecifier(context: EdgePassContext, identifier: SyntaxNodeLike): Promise<SymbolDef | null> {
  if (context.sup.id === "cpp" && identifier.type === "qualified_identifier") {
    const qualifiedPath = cppQualifiedNameSegments(identifier, context.source);
    const container = await resolveCppQualifiedMemberContainer(
      context.index,
      context.moduleEntry,
      qualifiedPath,
      context.loadParsedFile,
    );
    if (container || qualifiedPath.length < 2) return container;
    return context.resolveIdentifier(qualifiedPath.join("::"), identifier);
  }
  if (isJsTsLanguage(context.sup.id) && identifier.type === "member_expression") {
    const qualified = context.resolveMemberChainTarget(identifier);
    return qualified && declaresMembers(qualified) ? qualified : null;
  }
  if (isMemberAccessBase(context.sup, identifier)) return await resolveQualifiedPathBase(context, identifier);
  return await resolveBareBase(context, identifier);
}

async function recordIdentifierRelations(
  context: EdgePassContext,
  fromId: string,
  container: SyntaxNodeLike,
  relationForTarget: (
    target: SymbolDef,
    index: number,
    identifier: SyntaxNodeLike,
  ) => ReceiverAncestryRelation | null | Promise<ReceiverAncestryRelation | null>,
  extensionNominal?: SymbolDef | null,
): Promise<void> {
  const identifiers: SyntaxNodeLike[] = [];
  collectBaseSpecifierIdentifiers(container, context.sup, identifiers);
  const seen = new Set<string>();
  for (const [index, identifier] of identifiers.entries()) {
    let target = await resolveBaseSpecifier(context, identifier);
    if (!target) continue;
    let swiftBase: SwiftBase | null = null;
    if (context.sup.id === "swift") {
      swiftBase = await resolveSwiftBase(context, target);
      if (!swiftBase) continue;
      target = swiftBase.target;
    }
    const targetId = defNodeId(target);
    if (seen.has(targetId)) continue;
    seen.add(targetId);
    const clauseRelation = await relationForTarget(target, index, identifier);
    // A relation the declaration does not prove records no edge.
    if (!clauseRelation) continue;
    const relation = swiftBase ? swiftBaseRelation(container, swiftBase, clauseRelation) : clauseRelation;
    if (extensionNominal !== undefined) {
      // An extension is not a second implementing type. Conditional or
      // unproven extensions cannot establish unconditional conformance.
      if (relation === "implements" && extensionNominal) {
        recordDefEdge(context, ensureNode(context, extensionNominal), target, relation, identifier);
      }
    } else {
      recordDefEdge(context, fromId, target, relation, identifier);
    }
  }
}

const RUBY_NESTED_SCOPE_TYPES = new Set(["class", "module", "method", "singleton_method", "block", "do_block"]);

/** Collects `call` nodes directly in a Ruby class/module body, not inside a nested class, module, method, or block. */
function collectDirectCallsExcludingNestedScopes(node: SyntaxNodeLike, out: SyntaxNodeLike[]): void {
  for (const child of node.namedChildren ?? []) {
    if (child.type === "call") out.push(child);
    if (RUBY_NESTED_SCOPE_TYPES.has(child.type)) continue;
    collectDirectCallsExcludingNestedScopes(child, out);
  }
}

type InheritanceRelation = ReceiverAncestryRelation;

/**
 * The syntax node that declares `def`, read from the current file's tree or, for a definition in another file, from
 * that file's loaded tree. A definition whose file or declaration cannot be read has none.
 */
async function declarationNodeOf(context: EdgePassContext, def: SymbolDef): Promise<SyntaxNodeLike | null> {
  const inCurrentFile = fileIdentityKey(def.file) === fileIdentityKey(context.moduleEntry.file);
  const tree = inCurrentFile ? context.tree : (await context.loadParsedFile(def.file))?.tree;
  const start = def.range.start.index;
  if (!tree || start === undefined) return null;
  return nearestMemberContainer(tree.rootNode.descendantForIndex(start, def.range.end.index ?? start));
}

/**
 * Kotlin indexes an interface as a class, so the graph node takes the declaration's `interface` keyword. A contract
 * with no direct implementer is then still a contract, and `super` lookup skips it as it skips every interface.
 */
function markInterfaceNode(context: EdgePassContext, id: string): void {
  const node = context.nodes.get(id);
  if (node?.kind === "class") node.kind = "interface";
}

/**
 * The clause nodes of `rule` that `declaration` itself owns: its children and their children, the depth receiver
 * lookup reads. A nested declaration's own base clause sits deeper and is never the enclosing type's.
 */
function ownClauseNodes(declaration: SyntaxNodeLike, rule: ReceiverAncestorClause): SyntaxNodeLike[] {
  const clauses: SyntaxNodeLike[] = [];
  for (const child of declaration.namedChildren) {
    if (child.type === rule.nodeType) clauses.push(child);
    for (const grandchild of child.namedChildren) {
      if (grandchild.type === rule.nodeType) clauses.push(grandchild);
    }
  }
  return rule.each ? clauses : clauses.slice(0, 1);
}

/** The type whose base list is read: its declaration node, and whether that declaration is an interface. */
type DeclaringType = { node: SyntaxNodeLike; isInterface: boolean };

/**
 * `extends` or `implements` for one Kotlin base-list entry, or `null` when the entry proves neither. A constructor call
 * (`Base(args)`) is a class by its syntax. Kotlin requires every other class to initialize its base class that way, so
 * a bare entry is an interface, except in a class that declares only secondary constructors: there the bare entry is a
 * class when the declaration it resolves to is one, and an entry whose kind is not proven records no edge.
 * Go-to-definition reads the same declaration to pick the class that `super` addresses.
 */
async function kotlinBaseRelation(
  context: EdgePassContext,
  declaring: DeclaringType,
  target: SymbolDef,
  identifier: SyntaxNodeLike,
): Promise<InheritanceRelation | null> {
  const entry = kotlinSupertypeEntry(identifier);
  if (entry === "invoked") return "extends";
  if (!kotlinMayNameClassBare(declaring.node)) return "implements";
  if (!entry) return null;
  // A Java interface is an interface symbol; Kotlin interfaces and classes are both class symbols.
  if (target.kind === SymbolKind.Interface) return "implements";
  if (target.kind !== SymbolKind.Class) return null;
  const declaration = await declarationNodeOf(context, target);
  const declared = declaration ? declaredSupertypeKind(declaration) : null;
  if (declared === "interface") return "implements";
  return declared === "class" ? "extends" : null;
}

/**
 * `extends` or `implements` for one entry of a base list that mixes classes and interfaces, or `null` when the entry
 * proves neither. An interface only refines other interfaces, so every entry of its list extends. A class-like type
 * extends at most one class and implements the rest: C# lists the class first, and Kotlin names it by a constructor
 * call or, with only secondary constructors, by a bare name.
 */
async function baseClauseRelation(
  context: EdgePassContext,
  label: ReceiverAncestorClause["relation"],
  declaring: DeclaringType,
  target: SymbolDef,
  index: number,
  identifier: SyntaxNodeLike,
): Promise<InheritanceRelation | null> {
  if (label !== "superclass-first") return label;
  if (declaring.isInterface) return "extends";
  if (context.sup.id === "kotlin") return await kotlinBaseRelation(context, declaring, target, identifier);
  if (target.kind === SymbolKind.Interface || index > 0) return "implements";
  return "extends";
}

/** Records an edge for every embedded type of a Go interface or struct declaration, labeled by the embedding rule. */
async function recordEmbedRelations(
  context: EdgePassContext,
  fromId: string,
  declaration: SyntaxNodeLike,
  embeds: readonly ReceiverAncestorEmbed[],
): Promise<void> {
  const declaredType = declaration.childForFieldName("type");
  if (!declaredType) return;
  for (const rule of embeds) {
    if (declaredType.type !== rule.body) continue;
    const list = rule.memberList ? findFirstNodeByType(declaredType, rule.memberList) : declaredType;
    if (!list) continue;
    for (const member of list.namedChildren ?? []) {
      if (member.type !== rule.member) continue;
      if (rule.nameless && member.childForFieldName("name")) continue;
      const specifier = rule.typeField ? member.childForFieldName(rule.typeField) : member;
      if (!specifier) continue;
      await recordIdentifierRelations(context, fromId, specifier, () => rule.relation);
    }
  }
}

export async function emitClassInheritanceEdges(
  context: EdgePassContext,
  classNodes: DetailedClassNode[],
): Promise<void> {
  const rules = MEMBER_ACCESS_ROWS[context.sup.id]?.receiverAncestry;
  if (!rules) return;

  for (const cls of classNodes) {
    const fromId = ensureNode(context, cls.def);
    markImplementationTarget(context, fromId, cls.node, context.source, cls.def);
    const declaring: DeclaringType = { node: cls.node, isInterface: declaredSupertypeKind(cls.node) === "interface" };
    if (declaring.isInterface) markInterfaceNode(context, fromId);
    let extensionNominal: SymbolDef | null | undefined;
    if (context.sup.id === "swift" && isSwiftExtensionContainer(cls.node, context.source)) {
      extensionNominal = null;
      const name = cls.node.childForFieldName("name");
      const singleType = name?.namedChildren.length === 1 ? name.namedChildren[0] : undefined;
      if (singleType?.type === "type_identifier") {
        const target = context.resolveIdentifier(sliceText(singleType, context.source), singleType);
        if (target && declaresMembers(target)) {
          recordDefEdge(context, fromId, target, "uses", singleType);
          const conditional = isSwiftConstrainedExtension(cls.node, context.source);
          if (!conditional) extensionNominal = await swiftExtendedNominal(context, target);
        }
      }
    }

    if ((context.sup.id === "ts" || context.sup.id === "tsx") && cls.node.type === "class_declaration") {
      const heritage = cls.node.namedChildren.find((child) => child.type === "class_heritage");
      const superclass = heritage?.namedChildren.find((child) => child.type === "extends_clause");
      // TypeScript classes have one superclass. Invalid multi-base syntax proves neither target.
      if (superclass && superclass.namedChildren.length > 1) continue;
    }
    for (const rule of rules.clauses) {
      const clauses = ownClauseNodes(cls.node, rule);
      for (const clause of clauses) {
        const specifiers = rule.field ? (clause.childForFieldName(rule.field) ?? clause) : clause;
        await recordIdentifierRelations(
          context,
          fromId,
          specifiers,
          (target, index, identifier) =>
            baseClauseRelation(context, rule.relation, declaring, target, index, identifier),
          extensionNominal,
        );
      }
    }

    if (rules.mixinCalls) {
      const calls: SyntaxNodeLike[] = [];
      collectDirectCallsExcludingNestedScopes(cls.node, calls);
      for (const call of calls) {
        if (call.childForFieldName("receiver")) continue;
        const methodNode = call.childForFieldName("method");
        const methodName = methodNode ? sliceText(methodNode, context.source) : undefined;
        if (!methodName || !rules.mixinCalls.includes(methodName)) continue;
        const args = call.childForFieldName("arguments");
        if (args) await recordIdentifierRelations(context, fromId, args, () => "mixin");
      }
    }

    if (rules.embeds) await recordEmbedRelations(context, fromId, cls.node, rules.embeds);
  }
}

export function emitRustImplEdges(context: EdgePassContext, rootNode: SyntaxNodeLike): void {
  const walkImpls = (node: SyntaxNodeLike): void => {
    if (node.type === "impl_item") {
      const typeIdentifiers = node.namedChildren?.filter((child) => child.type === "type_identifier") ?? [];
      if (typeIdentifiers.length >= 2) {
        const traitName = sliceText(typeIdentifiers[0], context.source);
        const typeName = sliceText(typeIdentifiers[1], context.source);
        const typeDef = context.resolveIdentifier(typeName, typeIdentifiers[1]!);
        const traitDef = context.resolveIdentifier(traitName, typeIdentifiers[0]!);
        if (typeDef && traitDef) {
          const fromId = ensureNode(context, typeDef);
          recordDefEdge(context, fromId, traitDef, "implements", node);
        }
      }
    }
    for (const child of node.namedChildren ?? []) walkImpls(child);
  };
  walkImpls(rootNode);
}

export function emitMemberImplementationEdges(
  graph: SymbolGraph,
  recordEdge: (fromId: string, toId: string, label?: string, site?: SymbolGraph["edges"][number]["site"]) => boolean,
): void {
  const membersByOwner = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.label !== "member_of") continue;
    const members = membersByOwner.get(edge.to) ?? [];
    members.push(edge.from);
    membersByOwner.set(edge.to, members);
  }
  const hierarchyByKey = new Map<string, SymbolGraph["edges"][number]>();
  for (const edge of graph.edges) {
    if (edge.label !== "extends" && edge.label !== "implements" && edge.label !== "trait" && edge.label !== "mixin")
      continue;
    const key = `${edge.from}->${edge.to}::${edge.label}`;
    const existing = hierarchyByKey.get(key);
    if (!existing || (!existing.site && edge.site)) hierarchyByKey.set(key, edge);
  }
  const hierarchyEdges = [...hierarchyByKey.values()];
  for (const hierarchyEdge of hierarchyEdges) {
    const parentMembers = membersByOwner.get(hierarchyEdge.to) ?? [];
    const childMembers = membersByOwner.get(hierarchyEdge.from) ?? [];
    for (const parentMemberId of parentMembers) {
      const parentMember = graph.nodes.get(parentMemberId);
      if (!parentMember) continue;
      if (parentMember.memberArity === undefined) continue;
      const parentIdentityMatches = parentMembers.filter((memberId) => {
        const candidate = graph.nodes.get(memberId);
        return candidate?.name === parentMember.name && candidate.memberArity === parentMember.memberArity;
      });
      if (parentIdentityMatches.length !== 1) continue;
      const isContractMember = hierarchyEdge.label !== "extends" || parentMember.implementationTarget;
      if (!isContractMember) continue;
      const compatibleMembers = childMembers.filter((memberId) => {
        const childMember = graph.nodes.get(memberId);
        return childMember?.name === parentMember.name && childMember.memberArity === parentMember.memberArity;
      });
      if (compatibleMembers.length !== 1) continue;
      recordEdge(
        compatibleMembers[0]!,
        parentMemberId,
        hierarchyEdge.label === "extends" ? "overrides" : "implements_member",
        hierarchyEdge.site,
      );
    }
  }
}
