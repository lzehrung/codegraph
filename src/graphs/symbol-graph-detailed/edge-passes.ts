import type { NameResolution } from "../../indexer/name-resolution-types.js";
import { SymbolKind, type ModuleIndex, type ProjectIndex, type SymbolDef } from "../../indexer/types.js";

import { cppCallableShapeForNode, type CppCallableShape } from "../../indexer/cpp-callables.js";
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
  findTypeScriptNamespaceMemberCandidates,
  innermostNamespaceImport,
  isDirectKeywordMemberDeclaration,
  resolvePhpObjectCreationTarget,
  resolveRubyVisibleConstant,
  resolveSharedOwnerContainers,
  type SharedOwnerContainer,
} from "../../indexer/navigation-goto.js";
import { findClosestScopeBinding } from "../../indexer/navigation-local.js";
import { findPhpImportAlias, inferPhpQualifiedReferenceImportType } from "../../indexer/navigation-php.js";
import {
  cjsRequireValueBinding,
  resolveImportTypeMember,
  resolvePhpExportByImportType,
} from "../../indexer/navigation-resolve.js";
import { effectiveExplicitBinding } from "../../indexer/star-import-precedence.js";
import { typescriptSelectOverloadCandidate } from "../../indexer/ts-callables.js";
import {
  isSwiftConstrainedExtension,
  isSwiftExtensionContainer,
  selectCsharpPartialRepresentative,
} from "../../indexer/shared-owner-identity.js";
import type { LanguageSupport } from "../../languages.js";
import { isJsTsLanguage } from "../../languages/js-family.js";
import { getCallableArity, getCallArgumentCount, memberLookupBinding } from "../../languages/callable-arity.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../../languages/types.js";
import { sliceText, toRange } from "../../util/ast.js";
import {
  getMemberAccessParts,
  isMemberAccessNode,
  rustTokenTreeHoldsExpressions,
  rustTokenTreeNameFollowsSeparator,
} from "../../util/member-access.js";
import { foldPhpIdentifierCase } from "../../util/identifiers.js";
import {
  MEMBER_ACCESS_ROWS,
  keywordReceiverKind,
  type ReceiverAncestorClause,
  type ReceiverAncestorEmbed,
  type ReceiverAncestryRelation,
} from "../../util/member-access-tables.js";
import { fileIdentityKey } from "../../util/paths.js";
import { defNodeId, nodeForDef, type SymbolGraph } from "../symbol-graph.js";
import type { DetailedClassNode, DetailedFunctionNode } from "./ast.js";
import { collectNodesByType, declarationMemberArity, findFirstNodeByType, isIdentifierType } from "./ast.js";
import {
  CALL_ARGUMENT_NODE_TYPES,
  classifyReceiver,
  constructionTypeName,
  declarationIsStaticEquivalent,
  declarationNodeIsStatic,
  cppOutOfLineOwnerPath,
  cppOutOfLineMemberDeclarationNode,
  cppQualifiedNameSegments,
  declaresMembers,
  isUnprovenHeritageExpression,
  kotlinExtensionReceiverTypeNode,
  memberContainerDef,
  nearestMemberContainer,
  nodeInStaticMemberContext,
  phpObjectCreationKeyword,
  receiverCallAccess,
  rustImplSelfTypeNode,
  supportsImplicitSelfMemberCalls,
  supportsReceiverMemberOverloads,
  type ReceiverCallAccess,
  type ReceiverCallCandidate,
  type ReceiverMemberScope,
  type MemberArityRange,
  type ReceiverProof,
  receiverConstructorExpression,
  importTypeQuerySpecifier,
} from "./receiver-calls.js";

type EdgePassContext = {
  index: ProjectIndex;
  sup: LanguageSupport;
  source: string;
  tree: SyntaxTreeLike;
  moduleEntry: ModuleIndex;
  nodes: SymbolGraph["nodes"];
  membersOnly: boolean;
  memberExpressionType: string;
  propertyIdentifierTypes: string[];
  optionalMemberTypes: Set<string>;
  aliasToTargetDef: Map<string, SymbolDef>;
  aliasToTargetModule: Map<string, string>;
  resolveIdentifier: (name: string, node: SyntaxNodeLike) => SymbolDef | null;
  /** The shared lookup's raw answer, including steps deferred to async member lookup. */
  resolveName: (name: string, node: SyntaxNodeLike) => NameResolution | null;
  /** Runs deferred steps with the graph's rules; returns an indexed target or null. */
  settleName: (name: string, node: SyntaxNodeLike, resolution: NameResolution | null) => Promise<SymbolDef | null>;
  /** A name bound inside a Swift type/method rather than at module scope. */
  hasNonModuleBinding: (name: string, node: SyntaxNodeLike) => boolean;
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
  noteCallableName: (name: string, phpCaseInsensitive?: boolean) => void;
  /** Loads syntax needed to recover declaration metadata for cross-file member definitions. */
  loadParsedFile: (file: string) => Promise<{ source: string; tree: SyntaxTreeLike } | null>;
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

function cppShapeNode(node: SyntaxNodeLike): SyntaxNodeLike {
  return node.type === "function_declarator" ? node : (findFirstNodeByType(node, "function_declarator") ?? node);
}

function mergeCppCallableShapes(...shapes: Array<CppCallableShape | null | undefined>): MemberArityRange | undefined {
  const present = shapes.filter((shape): shape is CppCallableShape => !!shape);
  if (!present.length) return undefined;
  let min = present[0]!.minArity;
  let max = present[0]!.maxArity;
  for (const shape of present.slice(1)) {
    min = Math.min(min, shape.minArity);
    if (max === null || shape.maxArity === null) max = null;
    else max = Math.max(max, shape.maxArity);
  }
  return { min, max };
}

/**
 * Accepted explicit-argument range of a member declaration from the shared callable
 * facts (default parameters, varargs, explicit receivers), or undefined when the
 * declaration shape is unknown or the language does not select members by call arity.
 * The binding follows the call form member lookup resolves (see `memberLookupBinding`).
 */
function acceptedMemberArityRange(
  context: EdgePassContext,
  declarationNode: SyntaxNodeLike,
  source: string,
): MemberArityRange | undefined {
  if (!supportsReceiverMemberOverloads(context.sup.id)) return undefined;
  const arity = getCallableArity({
    languageId: context.sup.id,
    source,
    declaration: declarationNode,
    binding: memberLookupBinding(context.sup.id),
  });
  return arity ? { min: arity.minArgs, max: arity.maxArgs } : undefined;
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
  if (context.sup.id !== "rust" || !rustTokenTreeHoldsExpressions(tokenTree)) return;
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
  if (context.sup.id !== "python") return;

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
      outOfLineDeclaration?.node ?? fn.node,
      outOfLineDeclaration?.source ?? context.source,
      fn.def,
    );
    const arityNode = outOfLineDeclaration?.node ?? fn.node;
    markMemberArity(context, definitionId, arityNode);
    if (memberId !== definitionId) markMemberArity(context, memberId, arityNode);
    const memberScope = memberScopeForDefinition(context, fn, owner.cppOutOfLine, outOfLineDeclaration);
    const arityRange =
      context.sup.id === "cpp"
        ? mergeCppCallableShapes(
            cppCallableShapeForNode(cppShapeNode(fn.node)),
            outOfLineDeclaration ? cppCallableShapeForNode(cppShapeNode(outOfLineDeclaration.node)) : undefined,
          )
        : acceptedMemberArityRange(context, arityNode, outOfLineDeclaration?.source ?? context.source);
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
  const declarationNode =
    fn.node.parent?.type === "public_field_definition" || fn.node.parent?.type === "field_definition"
      ? fn.node.parent
      : fn.node;
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
  if (context.sup.id === "go" && context.optionalMemberTypes.has(node.type)) {
    const qualified = context.resolveMemberChainTarget(node);
    return qualified && declaresMembers(qualified) ? qualified : null;
  }
  const target = context.resolveIdentifier(name, node);
  if (target && declaresMembers(target)) return target;
  // A parameter/annotation type name is a closer scope binding than the class it names.
  const normalized = context.sup.normalizeIdentifier(name);
  const typed = context.moduleEntry.locals.filter(
    (local) => context.sup.normalizeIdentifier(local.localName) === normalized && declaresMembers(local),
  );
  if (typed.length === 1) return typed[0]!;
  const imported = context.aliasToTargetDef.get(name);
  if (imported && declaresMembers(imported)) return imported;
  // Only a constructed `Klass.new` type uses Ruby's bare-constant visibility, and
  // only when this file does not already have several classes of that name.
  // Inheritance names stay on resolveIdentifier so an unproven superclass is not invented.
  if (!rubyConstructed || typed.length > 1) return null;
  return resolveRubyVisibleConstant(context.index, context.moduleEntry, context.sup, name);
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
  return typescriptSelectOverloadCandidate({
    group: candidates,
    tree: context.tree,
    definitionOf: (candidate) => candidate,
    declarationOf: (candidate) => {
      const start = candidate.range.start.index ?? 0;
      return context.tree.rootNode.descendantForIndex(start, candidate.range.end.index ?? start).parent;
    },
    source: context.source,
    languageId: context.sup.id,
    argumentCount: getCallArgumentCount({ languageId: context.sup.id, source: context.source, call }),
  });
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
function recordImportTypeCall(context: EdgePassContext, access: ReceiverCallAccess, fromId: string): boolean {
  if (!isJsTsLanguage(context.sup.id)) return false;
  const importType = receiverConstructorExpression(access.receiver, context.source, context.sup);
  const specifier = importType?.type === "type_query" ? importTypeQuerySpecifier(importType) : null;
  if (!specifier) return false;
  const member = sliceText(access.property, context.source);
  const target = resolveImportTypeMember(context.index, context.moduleEntry.file, specifier, member);
  if (target && isCallTarget(context, target)) recordDefEdge(context, fromId, target, "calls", access.property);
  return true;
}

/** Swift `Foo()` / `Worker(name:)` is construction. Record `instantiates` and skip the call path. */
function recordSwiftCapitalizedConstruction(context: EdgePassContext, node: SyntaxNodeLike, fromId: string): boolean {
  if (context.sup.id !== "swift") return false;
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

export async function emitFunctionBodyEdges(
  context: EdgePassContext,
  functionNodes: DetailedFunctionNode[],
): Promise<void> {
  const qualifiedConstructionTargets: Array<{
    fromId: string;
    member: SyntaxNodeLike;
    target: SyntaxNodeLike;
  }> = [];
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
  const newNodeTypes = new Set<string>([
    "new_expression",
    "object_creation_expression",
    "struct_expression",
    "composite_literal",
  ]);
  // Receiver typing and lexical member lookup are initialized only for receiver calls.
  const receiverProofs = new Map<string, ReceiverProof>();
  const hasLexicalBinding = (callee: SyntaxNodeLike): boolean => {
    const scope = context.index.scopeCache.get(fileIdentityKey(context.moduleEntry.file));
    return !scope || !!findClosestScopeBinding(scope, sliceText(callee, context.source), callee, context.sup);
  };
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

  for (const fn of functionNodes) {
    const phpCaseInsensitive = context.sup.id === "php";
    const fromId = ensureNode(context, fn.def);
    const provenNode = context.nodes.get(fromId);
    // Function-valued bindings (`const helper = () => 1`) keep their `variable` kind;
    // the callable metadata records that this binding was proven to hold a function.
    if (provenNode && provenNode.kind !== "function" && provesCallableBinding(context, fn)) {
      provenNode.callable = true;
      context.noteCallableName(fn.name, context.sup.id === "php");
    }
    const seenAliases = new Set<string>();
    // Calls whose target needs an async member lookup (C++ out-of-line owner members, included
    // C/C++ declarations of one callable); settled after the walk.
    const deferredCalls: Array<{ callee: SyntaxNodeLike; name: string; resolution: NameResolution }> = [];
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
      if (seenAliases.has(name)) return;
      let target: SymbolDef | null = context.aliasToTargetDef.get(name) ?? null;
      if (!target) {
        // A local variable can shadow a Go package alias (`u := LocalU{}` alongside
        // `import u "pkg"`); aliasToTargetModule is a blind per-file text map, so refuse it
        // here too whenever a closer, non-namespace scope binding owns the name.
        const modFile =
          context.sup.id === "go" && context.hasNonModuleBinding(name, node)
            ? undefined
            : context.aliasToTargetModule.get(name);
        if (modFile) {
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
          if (exportedName) {
            target = context.resolveExportFrom(modFile, exportedName);
            if (!target && (context.sup.id !== "go" || isGoExportedMemberName(context.sup.id, exportedName))) {
              const targetModule = context.index.byFile.get(fileIdentityKey(modFile));
              target = (targetModule?.locals ?? []).find((local) => local.localName === exportedName) ?? null;
            }
          }
        }
      }
      if (!target) return;
      seenAliases.add(name);
      recordDefEdge(context, fromId, target, "uses");
    };

    const recordMemberUse = (node: SyntaxNodeLike): void => {
      if (!context.optionalMemberTypes.has(node.type)) return;
      const targetDef = context.resolveMemberChainTarget(node);
      if (targetDef) {
        recordDefEdge(context, fromId, targetDef, "uses");
      }
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
    ): void => {
      const memberName = sliceText(access.property, context.source);
      if (!memberName) return;
      let binding = classifyReceiver(
        context.sup,
        access.receiver,
        context.source,
        receiverProofs,
        fn.node.startIndex,
        access.accessNode,
        hasLexicalBinding,
      );
      if (isJsTsLanguage(context.sup.id) && isIdentifierType(context.sup, access.receiver.type)) {
        const receiverName = sliceText(access.receiver, context.source);
        const imported =
          effectiveExplicitBinding(
            context.moduleEntry.imports,
            context.sup.id,
            (candidate) => candidate.kind === "namespace" && candidate.localNS === receiverName,
            access.receiver.startIndex,
          ) ?? innermostNamespaceImport(context.moduleEntry.imports, receiverName, access.receiver);
        if (imported?.mechanism === "cjs" && typeof imported.resolved === "string") {
          const value = cjsRequireValueBinding(context.index, imported.resolved);
          const lexical = value ? context.resolveIdentifier(receiverName, access.receiver) : null;
          if (!value || !declaresMembers(value) || !lexical || defNodeId(value) !== defNodeId(lexical)) return;
          binding = { kind: "named-type", typeName: receiverName, typeNode: access.receiver, memberScope: "static" };
        }
      }
      if (!binding) return;

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
          memberScope: forcedMemberScope ?? binding.memberScope,
          ...(context.sup.id === "go" && !isGoExportedMemberName(context.sup.id, memberName)
            ? { goPackagePeerFiles: getCompilationUnitPeers(context.index, context.moduleEntry.file).files }
            : {}),
          caseInsensitiveMemberName: phpCaseInsensitive,
        });
        return;
      }
      if (binding.kind === "own-type") {
        const container = nearestMemberContainer(fn.node);
        const declared = container
          ? lexicalMembers(container).filter((candidate) => {
              const candidateName = candidate.def.localName;
              const nameMatches = phpCaseInsensitive
                ? foldPhpIdentifierCase(candidateName) === foldPhpIdentifierCase(memberName)
                : candidateName === memberName;
              if (!nameMatches) return false;
              if (binding.memberScope === "any") return true;
              return declarationNodeIsStatic(candidate.node, context.source) === (binding.memberScope === "static");
            })
          : [];
        if (declared.length === 1) {
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
        memberScope: binding.memberScope,
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
        if (recordTypeScriptNamespaceCall(context, node, access, fromId)) return;
        if (recordImportTypeCall(context, access, fromId)) return;
        const receiverName = sliceText(access.receiver, context.source);
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
        if (
          keywordReceiverKind(context.sup.id, receiverName) ||
          !tryResolveChain(context, access.accessNode, fromId, "calls")
        ) {
          recordReceiverCall(node, access);
        }
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
      const implicitOwnerLanguage = context.sup.id === "swift" || context.sup.id === "csharp";
      if (implicitOwnerLanguage && isIdentifierType(context.sup, callee.type) && nearestMemberContainer(fn.node)) {
        const name = sliceText(callee, context.source);
        const lexical = context.resolveIdentifier(name, callee);
        const importedCsharpMember =
          context.sup.id === "csharp" &&
          !!lexical?.isMember &&
          fileIdentityKey(lexical.file) !== fileIdentityKey(context.moduleEntry.file);
        if (!importedCsharpMember && (!lexical || lexical.isMember || !context.hasNonModuleBinding(name, callee))) {
          // A method's local binding wins. Type members require receiver ownership
          // and static-scope proof; only a free function can be a fallback.
          recordImplicitSelfMemberCall(node, callee, lexical?.isMember ? null : lexical);
          return;
        }
      }
      if (!tryResolveNode(context, callee, fromId, "calls")) recordImplicitSelfMemberCall(node, callee);
    };

    const recordRubySuper = (superNode: SyntaxNodeLike): void => {
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
    };

    const recordCallOrInstantiation = (node: SyntaxNodeLike): boolean => {
      if (context.sup.id === "ruby" && node.type === "super") {
        recordRubySuper(node);
        return true;
      }
      if (node.type === "token_tree") recordRustMacroArgumentCalls(context, node, fromId);
      if (callNodeTypes.has(node.type)) {
        if (context.sup.id === "go") {
          const callTarget = getCallTarget(node);
          const calleeName =
            callTarget && isIdentifierType(context.sup, callTarget.type) ? sliceText(callTarget, context.source) : null;
          if (calleeName === "new" || calleeName === "make") {
            const argList = node.childForFieldName("arguments") ?? node.childForFieldName("argument_list");
            const typeNode = argList?.namedChildren?.find((child) => child.type === "type_identifier") ?? null;
            if (typeNode) {
              tryResolveNode(context, typeNode, fromId, "instantiates");
            }
            return false;
          }
        }
        if (context.sup.id === "ruby" && node.type === "call") {
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
        if (recordSwiftCapitalizedConstruction(context, node, fromId)) return true;
        resolveCallTarget(node, getCallTarget(node));
      }
      if (newNodeTypes.has(node.type)) {
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
        recordReceiverCall(call.node, call.access, implicitThis ? undefined : "static");
      }
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
  scope_resolution: "name", // Ruby: Module::Base
  qualified_type: "name", // Go: pkg.Base
};

/** Generic wrappers contribute the base name, not their type arguments. */
const GENERIC_WRAPPER_TYPES: Record<string, true> = {
  generic_name: true,
  generic_type: true,
  user_type: true,
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

/** Python base-list entries that are never base types. */
const BASE_TYPE_IGNORED_TYPES: Record<string, true> = {
  keyword_argument: true,
  dictionary_splat: true,
  list_splat: true,
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
  if (BASE_TYPE_IGNORED_TYPES[node.type]) return;
  if (sup.id === "cpp" && node.type === "qualified_identifier") {
    out.push(node);
    return;
  }
  const narrowed = narrowBaseSpecifierNode(node);
  if ((sup.id === "ts" || sup.id === "tsx") && narrowed.type === "member_expression") {
    out.push(narrowed);
    return;
  }
  if (isIdentifierType(sup, narrowed.type) || narrowed.type === "type_identifier") {
    out.push(narrowed);
    return;
  }
  for (const child of narrowed.namedChildren ?? []) collectBaseSpecifierIdentifiers(child, sup, out);
}

async function recordIdentifierRelations(
  context: EdgePassContext,
  fromId: string,
  container: SyntaxNodeLike,
  relationForTarget: (
    target: SymbolDef,
    index: number,
    identifier: SyntaxNodeLike,
  ) => "extends" | "implements" | "trait" | "mixin",
): Promise<void> {
  const identifiers: SyntaxNodeLike[] = [];
  collectBaseSpecifierIdentifiers(container, context.sup, identifiers);
  const seen = new Set<string>();
  for (const [index, identifier] of identifiers.entries()) {
    let target: SymbolDef | null;
    if (context.sup.id === "cpp" && identifier.type === "qualified_identifier") {
      const qualifiedPath = cppQualifiedNameSegments(identifier, context.source);
      target = await resolveCppQualifiedMemberContainer(
        context.index,
        context.moduleEntry,
        qualifiedPath,
        context.loadParsedFile,
      );
      if (!target && qualifiedPath.length > 1) {
        target = context.resolveIdentifier(qualifiedPath.join("::"), identifier);
      }
    } else if ((context.sup.id === "ts" || context.sup.id === "tsx") && identifier.type === "member_expression") {
      const qualified = context.resolveMemberChainTarget(identifier);
      target = qualified && declaresMembers(qualified) ? qualified : null;
    } else {
      const name = sliceText(identifier, context.source);
      target = context.resolveIdentifier(name, identifier);
      // Ruby `require` publishes a top-level constant, not a nested one. Reuse the
      // same visibility as goto so `class Worker < Base` follows the required class.
      if (!target && context.sup.id === "ruby") {
        target = resolveRubyVisibleConstant(context.index, context.moduleEntry, context.sup, name);
      }
    }
    if (!target) continue;
    const targetId = defNodeId(target);
    if (seen.has(targetId)) continue;
    seen.add(targetId);
    recordDefEdge(context, fromId, target, relationForTarget(target, index, identifier), identifier);
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

function baseClauseRelation(
  label: ReceiverAncestorClause["relation"],
  target: SymbolDef,
  index: number,
  interfaceIds: Set<string>,
  identifier: SyntaxNodeLike,
  kotlin: boolean,
): InheritanceRelation {
  if (label !== "superclass-first") return label;
  if (kotlin) {
    let current = identifier.parent;
    while (current && current.type !== "delegation_specifiers") {
      if (current.type === "constructor_invocation") return "extends";
      current = current.parent;
    }
    return "implements";
  }
  if (interfaceIds.has(defNodeId(target)) || index > 0) return "implements";
  return "extends";
}

/** Records `implements` for every embedded type of a Go interface or struct declaration. */
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
      await recordIdentifierRelations(context, fromId, specifier, () => "implements");
    }
  }
}

export async function emitClassInheritanceEdges(
  context: EdgePassContext,
  classNodes: DetailedClassNode[],
): Promise<void> {
  const rules = MEMBER_ACCESS_ROWS[context.sup.id]?.receiverAncestry;
  if (!rules) return;

  const interfaceIds = new Set(
    classNodes
      .filter(
        (candidate) =>
          candidate.node.type === "interface_declaration" ||
          candidate.node.type === "protocol_declaration" ||
          candidate.node.type === "trait_item" ||
          /^(?:interface|protocol|trait)\b/.test(sliceText(candidate.node, context.source).trimStart()),
      )
      .map((candidate) => defNodeId(candidate.def)),
  );

  for (const cls of classNodes) {
    const fromId = ensureNode(context, cls.def);
    markImplementationTarget(context, fromId, cls.node, context.source, cls.def);

    if ((context.sup.id === "ts" || context.sup.id === "tsx") && cls.node.type === "class_declaration") {
      const heritage = cls.node.namedChildren.find((child) => child.type === "class_heritage");
      const superclass = heritage?.namedChildren.find((child) => child.type === "extends_clause");
      // TypeScript classes have one superclass. Invalid multi-base syntax proves neither target.
      if (superclass && superclass.namedChildren.length > 1) continue;
    }
    for (const rule of rules.clauses) {
      const clauses: SyntaxNodeLike[] = [];
      if (rule.each) {
        collectNodesByType(cls.node, rule.nodeType, clauses);
      } else {
        const found = findFirstNodeByType(cls.node, rule.nodeType);
        if (found) clauses.push(found);
      }
      for (const clause of clauses) {
        const specifiers = rule.field ? (clause.childForFieldName(rule.field) ?? clause) : clause;
        await recordIdentifierRelations(context, fromId, specifiers, (target, index, identifier) =>
          baseClauseRelation(rule.relation, target, index, interfaceIds, identifier, context.sup.id === "kotlin"),
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
  if (context.sup.id !== "rust") return;

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
