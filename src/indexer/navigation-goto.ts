import {
  CSHARP_SUPPORT,
  JAVA_SUPPORT,
  KOTLIN_SUPPORT,
  supportForFileWithoutHeaderSample,
  type LanguageSupport,
} from "../languages.js";
import { pythonPropertyDecorator, type PythonPropertyDecorator } from "./python-property-decorator.js";
import {
  isPythonDottedImportBinding,
  pythonDottedImportPackageFile,
  pythonImportPosition,
  pythonLaterImportScopeSpan,
  pythonImportPrecedesUse,
  pythonDottedPhraseFile,
} from "./python-dotted-imports.js";
import { isJsTsLanguage } from "../languages/js-family.js";
import { isPythonReceiverAttributeAssignmentName } from "../languages/definitions/python.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { sliceText, toRange } from "../util/ast.js";
import { foldPhpIdentifierCase, normalizeCsharpQualifiedName, normalizeKotlinIdentifier } from "../util/identifiers.js";
import {
  csharpNamespaceAtIndex,
  csharpNamespaceRegionAtIndex,
  csharpTypeArgumentArity,
  csharpTypeNameWithArity,
  type CsharpNamespaceRegion,
} from "../util/csharp-tree.js";
import { fileIdentityKey } from "../util/paths.js";
import {
  collectMemberAccessChain,
  getMemberAccessParts,
  getNavigationExpressionProperty,
  isMemberAccessNode,
  isQualifiedTypeSuffix,
  isReceiverNameNode,
  memberAccessTraversalTypes,
} from "../util/member-access.js";
import { definitionIdentityKey } from "./reference-context.js";
import { toTreeSitterPosition } from "./shared.js";
import {
  anonymousOwnerForm,
  MEMBER_ACCESS_ROWS,
  supportsReceiverMemberNavigation,
} from "../util/member-access-tables.js";
import { typescriptCallableContainerKey, typescriptMergedNamespaceContainers } from "./ts-callables.js";
import {
  effectiveExplicitBinding,
  isExpandedStarBinding,
  decideStarImportCandidates,
  resolveStarImportedDefinition,
  type StarImportCandidate,
  resolveStarImportedName,
  resolveStarImportedNamespace,
  starImportPrecedence,
} from "./star-import-precedence.js";
import {
  classifyReceiver,
  cppOutOfLineOwnerPath,
  cppQualifiedNameSegments,
  declarationIsStaticEquivalent,
  declarationNodeIsStatic,
  declaredTypeNameNode,
  declaresMembers,
  declaredSupertypeKind,
  hasStaticMemberDistinction,
  isAnonymousMemberContainer,
  memberContainerDef,
  nearestMemberContainer,
  isNonBaseHeritageArgument,
  isUnprovenHeritageExpression,
  kotlinExtensionReceiverTypeNode,
  kotlinMayNameClassBare,
  kotlinSupertypeEntry,
  csharpDottedNameRoot,
  nodeInStaticMemberContext,
  importTypeQuerySpecifier,
  rustImplSelfTypeNode,
  supportsStaticMemberScope,
  TRANSPARENT_MEMBER_CONTAINER_TYPES,
  type KotlinSupertypeEntry,
  type ReceiverBinding,
  type ReceiverMemberScope,
  unwrapNamedType,
  type PhpObjectCreationKeyword,
} from "../graphs/symbol-graph-detailed/receiver-calls.js";
import { getCallArgumentCount, memberLookupBinding } from "../languages/callable-arity.js";
import {
  csharpNamespaceChainDeclares,
  csharpNamespaceMemberKind,
  csharpProjectDeclarationsUnknown,
  csharpUsingTargetShadowed,
  getCompilationUnitPeers,
  getPackageDeclarationName,
} from "./compilation-units.js";
import {
  isExportedDeclaration,
  isJvmPackageSymbolVisible,
  isPrivateDeclaration,
  isGoExportedMemberName,
  isSwiftCrossFileHiddenSharedOwnerMember,
} from "./declaration-visibility.js";
import { isJvmTypeWildcardMember } from "./expand-star-imports.js";
import type { ParsedFileContext } from "./parse-context.js";
import {
  createLoadingParsedFileProvider,
  ensureParsedContextForIndex,
  ignoreQueryParseFailure,
  rethrowStaleQuerySource,
  withParsedFiles,
  type LoadingParsedFileProvider,
  type ParsedFileProvider,
} from "./parsed-cache.js";
import {
  csharpLookupName,
  csharpQualifiedThroughGenericOwner,
  csharpQualifiedNameNode,
  definitionForBinding,
  findClosestScopeBinding,
  getOrBuildScopeIndex,
  laterLocalShadowsUse,
  resolveNamedDefinition,
} from "./navigation-local.js";
import { definitionWithoutDeferredSteps, type JvmTypeNameResolver } from "./name-resolution-types.js";
import { csharpUsingStaticTypeCandidates } from "./name-lookup-policies/csharp-using-static.js";
import { csharpTypeOnlyName } from "./scope-nodes.js";
import { bindsTypeParameter, typeParameterNamesInScope } from "./type-parameters.js";
import {
  AMBIGUOUS_CSHARP_ALIAS_MEMBER_REASON,
  AMBIGUOUS_STAR_IMPORT_REASON,
  CSHARP_NAMESPACE_NAME_REASON,
  isAmbiguousResolutionReason,
  UNPROVEN_CSHARP_ALIAS_MEMBER_REASON,
  UNRESOLVED_QUALIFIED_TYPE_REASON,
} from "./ambiguous-resolution.js";
import { fileBindingIsUnshadowed, type Binding, type ScopeIndex } from "./scope.js";
import { resolveCppQualifiedMemberContainer, cppFunctionHasImplicitThis } from "./navigation-cpp.js";
import { okGoToResult } from "./navigation-provenance.js";
import { comparePhpReferenceNames, findPhpImportAlias } from "./navigation-php.js";
import { resolveIndexedPhpClassReference, resolvePhpNamespaceSymbol } from "./php-namespace-symbols.js";
import {
  cjsRequireValueBinding,
  csharpShadowedImports,
  csharpShadowedStarsMayHold,
  memberContainerForDefinition,
  resolveCsharpQualifiedName,
  resolveExport,
  resolveImported,
  resolvePhpExportByImportType,
  resolveImportTypeMember,
} from "./navigation-resolve.js";
import {
  CSHARP_PARTIAL_CONTAINER_TYPES,
  getSharedOwnerIdentity,
  isSwiftExtensionContainer,
  sharedOwnerCanUseMembers,
} from "./shared-owner-identity.js";
import {
  hasSeparateMemberScopes,
  inheritsMemberOverloads,
  selectMember,
  type MemberModel,
} from "./member-selection.js";
import {
  SymbolKind,
  type GoToResult,
  type ImportBinding,
  type ModuleIndex,
  type ProjectIndex,
  type ResolvedExport,
  type SymbolDef,
} from "./types.js";

const DECLARED_FIELD_CHAIN_LANGUAGES: Readonly<Record<string, true>> = {
  ts: true,
  tsx: true,
  java: true,
  csharp: true,
  kotlin: true,
};
/** Type-syntax nodes that wrap a declared type name together with its qualifier. */
const QUALIFIED_TYPE_NODE_TYPES: Readonly<Record<string, true>> = {
  qualified_name: true,
  scoped_type_identifier: true,
  nested_type_identifier: true,
  user_type: true,
  generic_name: true,
  generic_type: true,
};

/**
 * The full spelling of a declared type, e.g. `B.Repo` for `B.Repo<T>`: the last segment alone
 * would resolve to a same-named type of another namespace.
 */
function qualifiedDeclaredTypeText(typeName: SyntaxNodeLike, source: string): string {
  let top = typeName;
  for (let parent = typeName.parent; parent && QUALIFIED_TYPE_NODE_TYPES[parent.type]; parent = parent.parent) {
    top = parent;
  }
  let text = sliceText(top, source).replace(/\s+/g, "");
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(/<[^<>]*>/g, "");
  }
  return text;
}

export function supportsDeclaredFieldChains(languageId: string): boolean {
  return !!DECLARED_FIELD_CHAIN_LANGUAGES[languageId];
}
function noLexicalBinding(): boolean {
  return false;
}
/** A Rust named `use crate::mod` binding names the indexed module, not a class export. */
export function resolveRustModuleNamespace(index: ProjectIndex, binding: ImportBinding): string | null {
  if (binding.kind !== "named" || typeof binding.resolved !== "string") return null;
  const owner = index.byFile.get(fileIdentityKey(binding.resolved));
  if (!owner) return null;
  const modules = owner.imports.filter(
    (candidate) => candidate.kind === "namespace" && candidate.localNS === binding.imported,
  );
  if (modules.length !== 1) return null;
  const resolved = modules[0]?.resolved;
  return typeof resolved === "string" ? resolved : null;
}
/**
 * One bound for every receiver-hierarchy walk in this module: keyword `super`/`parent` lookup,
 * Go struct embedding, and Python base classes. Each walk keeps its own visited set, so this is a
 * resource bound rather than a cycle guard; keeping a single constant stops the three walks from
 * drifting to different semantic cutoffs.
 */
const RECEIVER_HIERARCHY_DEPTH = 16;

function collectSharedOwnerContainers(root: SyntaxNodeLike, languageId: string, out: SyntaxNodeLike[]): void {
  if (languageId === "csharp") {
    if (CSHARP_PARTIAL_CONTAINER_TYPES.has(root.type)) out.push(root);
  } else if (languageId === "swift") {
    if (root.type === "class_declaration" || root.type === "protocol_declaration") out.push(root);
  }
  for (const child of root.namedChildren ?? []) collectSharedOwnerContainers(child, languageId, out);
}

const sharedOwnerContainersByRoot = new WeakMap<SyntaxNodeLike, Map<string, readonly SyntaxNodeLike[]>>();

function sharedOwnerContainersInTree(root: SyntaxNodeLike, languageId: string): readonly SyntaxNodeLike[] {
  let byLanguage = sharedOwnerContainersByRoot.get(root);
  if (!byLanguage) {
    byLanguage = new Map();
    sharedOwnerContainersByRoot.set(root, byLanguage);
  }
  const cached = byLanguage.get(languageId);
  if (cached) return cached;
  const collected: SyntaxNodeLike[] = [];
  collectSharedOwnerContainers(root, languageId, collected);
  byLanguage.set(languageId, collected);
  return collected;
}

/**
 * Same-identity compilation-unit owners excluding `ownerContainer` itself.
 * C# requires a proven `partial` modifier and the full namespace/type path.
 * Swift pairs a type with extensions (and extensions with each other), never two
 * same-named type declarations that are not extensions. Peers come from
 * `getCompilationUnitPeers` and stay directory/language-group bounded.
 * Graph membership should reuse this export rather than a per-name lookup.
 */
export type SharedOwnerContainer = {
  file: string;
  container: SyntaxNodeLike;
  context: ParsedFileContext;
  module: ModuleIndex;
};

const moduleDeclaredNames = new WeakMap<readonly SymbolDef[], { size: number; names: ReadonlySet<string> }>();

/** Whether a module declares `normalizedName` anywhere, from a name set built once per locals list. */
function moduleDeclaresName(mod: ModuleIndex, normalizedName: string, normalize: (name: string) => string): boolean {
  let cached = moduleDeclaredNames.get(mod.locals);
  if (cached?.size !== mod.locals.length) {
    cached = { size: mod.locals.length, names: new Set(mod.locals.map((def) => normalize(def.localName))) };
    moduleDeclaredNames.set(mod.locals, cached);
  }
  return cached.names.has(normalizedName);
}

export async function resolveSharedOwnerContainers(params: {
  index: ProjectIndex;
  ownerFile: string;
  ownerContainer: SyntaxNodeLike;
  ownerSource: string;
  languageId: string;
}): Promise<SharedOwnerContainer[]> {
  const { index, ownerFile, ownerContainer, ownerSource, languageId } = params;
  if (languageId !== "csharp" && languageId !== "swift") return [];
  const ownerIdentity = getSharedOwnerIdentity(ownerContainer, ownerSource, languageId, ownerFile);
  if (!ownerIdentity) return [];
  // A C# `file` owner has only same-file parts, so no other file is a candidate peer.
  const peers = ownerIdentity.fileLocalTo
    ? { files: new Set([ownerFile]), complete: true }
    : getCompilationUnitPeers(index, ownerFile);
  const out: SharedOwnerContainer[] = [];
  const seen = new Set<string>();
  const ownerIsExtension = languageId === "swift" ? isSwiftExtensionContainer(ownerContainer, ownerSource) : false;
  const ownerKey = fileIdentityKey(ownerFile);
  // Every part of a C# type declares a type of its simple name, so a peer without one is never read.
  const normalizeName = CSHARP_SUPPORT.normalizeIdentifier;
  const ownerName = languageId === "csharp" ? normalizeName(ownerContainer.childForFieldName("name")?.text ?? "") : "";
  const units: ModuleIndex[] = [];
  for (const file of peers.files) {
    const peer = index.byFile.get(fileIdentityKey(file));
    if (!peer) continue;
    if (ownerName && !moduleDeclaresName(peer, ownerName, normalizeName)) continue;
    units.push(peer);
  }
  for (const peer of units) {
    let peerContext: ParsedFileContext;
    try {
      peerContext = await ensureParsedContextForIndex(index, peer.file);
    } catch (error) {
      rethrowStaleQuerySource(error);
      continue;
    }
    if (peerContext.sup.id !== languageId) continue;
    const containers = sharedOwnerContainersInTree(peerContext.tree.rootNode, languageId);
    for (const container of containers) {
      if (
        fileIdentityKey(peer.file) === ownerKey &&
        container.startIndex === ownerContainer.startIndex &&
        container.endIndex === ownerContainer.endIndex
      ) {
        continue;
      }
      const identity = getSharedOwnerIdentity(container, peerContext.source, languageId, peer.file);
      if (!identity || !sharedOwnerCanUseMembers(ownerIdentity, identity)) continue;
      if (languageId === "swift") {
        const peerIsExtension = isSwiftExtensionContainer(container, peerContext.source);
        if (!ownerIsExtension && !peerIsExtension) continue;
      }
      const key = fileIdentityKey(peer.file) + ":" + container.startIndex + ":" + container.endIndex;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: peer.file, container, context: peerContext, module: peer });
    }
  }
  return out;
}

/**
 * Unit-boundary completeness for a C# partial or Swift type/extension member. Its other
 * owner parts, and therefore its uses, are bounded by `getCompilationUnitPeers`, so an
 * unproven unit boundary leaves the member's reference set incomplete. Returns null when
 * the member's owner cannot be shared across files.
 */
export async function sharedOwnerMemberUnitComplete(index: ProjectIndex, def: SymbolDef): Promise<boolean | null> {
  if (!def.isMember) return null;
  let context: ParsedFileContext;
  try {
    context = await ensureParsedContextForIndex(index, def.file);
  } catch (error) {
    rethrowStaleQuerySource(error);
    return null;
  }
  const languageId = context.sup.id;
  if (languageId !== "csharp" && languageId !== "swift") return null;
  const nameNode = nameNodeForDef(context, def);
  const container = nameNode ? nearestMemberContainer(nameNode) : null;
  const identity = container ? getSharedOwnerIdentity(container, context.source, languageId, def.file) : null;
  if (!identity) return null;
  // File-local owners have no parts in other files, so the reference set is complete.
  if (identity.fileLocalTo) return true;
  // A C# member is reachable through a qualified owner (`P.Box`) from any namespace, so use the
  // same qualified peer relation as reference candidate discovery.
  return getCompilationUnitPeers(index, def.file, languageId === "csharp" ? { csharpQualifiedName: true } : undefined)
    .complete;
}

/**
 * Other C# `partial` type parts that share owner identity with `def`.
 * Reference collection treats them as one type so uses that resolve to the
 * coalesced representative still match a query started on any part.
 */
export async function findCsharpPartialTypeEquivalents(index: ProjectIndex, def: SymbolDef): Promise<SymbolDef[]> {
  if (!declaresMembers(def)) return [];
  const module = index.byFile.get(fileIdentityKey(def.file));
  if (!module) return [];
  let context: ParsedFileContext;
  try {
    context = await ensureParsedContextForIndex(index, def.file);
  } catch (error) {
    rethrowStaleQuerySource(error);
    return [];
  }
  if (context.sup.id !== "csharp") return [];
  const start = def.range.start;
  const nameNode = context.tree.rootNode.descendantForPosition(
    toTreeSitterPosition(start),
    toTreeSitterPosition(start),
  );
  const container = nearestMemberContainer(nameNode);
  if (!container) return [];
  const peers = await resolveSharedOwnerContainers({
    index,
    ownerFile: def.file,
    ownerContainer: container,
    ownerSource: context.source,
    languageId: "csharp",
  });
  const out: SymbolDef[] = [];
  for (const peer of peers) {
    const peerName = peer.container.childForFieldName("name");
    if (!peerName) continue;
    const peerDef = peer.module.locals.find(
      (local) => declaresMembers(local) && local.range.start.index === peerName.startIndex,
    );
    if (peerDef) out.push(peerDef);
  }
  return out;
}

/** Reusable shared-owner member lookup for keyword navigation and receiver graphs. */
export async function findSharedOwnerMemberDefinitions(params: {
  index: ProjectIndex;
  ownerFile: string;
  ownerContainer: SyntaxNodeLike;
  ownerSource: string;
  languageId: string;
  member: string;
  memberScope?: ReceiverMemberScope;
}): Promise<SymbolDef[]> {
  const { index, ownerFile, ownerContainer, ownerSource, languageId, member, memberScope } = params;
  const peers = await resolveSharedOwnerContainers({ index, ownerFile, ownerContainer, ownerSource, languageId });
  const out: SymbolDef[] = [];
  for (const peer of peers) {
    const predicate =
      !memberScope || memberScope === "any"
        ? undefined
        : (local: SymbolDef) => matchesReceiverMemberScope(local, memberScope, peer.context, peer.container);
    const hits = findDirectLocalsWithinNode(
      peer.module.locals,
      member,
      peer.container,
      peer.context,
      peer.context.sup.normalizeIdentifier,
      predicate,
    );
    for (const hit of hits) {
      const hitNode = nameNodeForDef(peer.context, hit);
      if (languageId === "swift" && fileIdentityKey(ownerFile) !== fileIdentityKey(peer.file)) {
        if (!hitNode || isSwiftCrossFileHiddenSharedOwnerMember(languageId, ownerFile, peer.file, hitNode)) continue;
      }
      if (!out.includes(hit)) out.push(hit);
    }
  }
  return out;
}

function nameNodeForDef(context: ParsedFileContext, def: SymbolDef): SyntaxNodeLike | null {
  const start = def.range.start;
  const index = start.index;
  if (index !== undefined) return context.tree.rootNode.descendantForIndex(index, index);
  const position = toTreeSitterPosition(start);
  return context.tree.rootNode.descendantForPosition(position, position);
}

function enclosingImportScope(declarationName: SyntaxNodeLike): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = declarationName;
  while (current && current.type !== "variable_declaration" && current.type !== "using_directive") {
    current = current.parent;
  }
  return current?.parent ?? null;
}

/** The scope of the import whose local name token starts at `start`, found by descending from `root`. */
function importScopeAt(root: SyntaxNodeLike, start: number): SyntaxNodeLike | null {
  let nameNode = root;
  for (;;) {
    const child = nameNode.namedChildren.find(
      (candidate) => candidate.startIndex <= start && start < candidate.endIndex,
    );
    if (!child) break;
    nameNode = child;
  }
  return enclosingImportScope(nameNode);
}

const CSHARP_SHADOWED_ALIAS_REASON = "C# alias is shadowed by an enclosing namespace member";
const CSHARP_SHADOWED_TARGET_REASON = "C# alias target is shadowed by a member of an enclosing namespace";
const CSHARP_INCOMPLETE_ALIAS_REASON = "C# namespace alias may name a type in a project file that could not be read";

export function isCsharpAliasQualifier(node: SyntaxNodeLike, sup: LanguageSupport): boolean {
  return (
    sup.id === "csharp" &&
    node.parent?.type === "alias_qualified_name" &&
    getMemberAccessParts(sup, node.parent).object?.id === node.id
  );
}

/** The leading name `X` of a C# dotted or alias-qualified name (`X.Y.Z`, `X::Y`) and the names it qualifies. */
export function csharpChainQualifier(
  chainNode: SyntaxNodeLike,
  source: string,
): { qualifier: SyntaxNodeLike; names: string[] } | null {
  const chain = collectMemberAccessChain({ sup: CSHARP_SUPPORT, source, chainNode });
  if (!chain || !isReceiverNameNode(CSHARP_SUPPORT, chain.base.type)) return null;
  return { qualifier: chain.base, names: chain.names };
}

/**
 * Whether a nearer namespace shadows the namespace alias that `qualifier` (the `X` of `X.Type`) names. C# searches
 * each enclosing namespace together with its own aliases before the next one out, so a namespace or type `X` in a
 * namespace deeper than the alias's own comes before the alias. The answer comes from the index's own C# declarations
 * when the lookup runs, never from the alias binding a cached module holds. An alias under `#if`, `#elif`, or
 * `#else` belongs to the namespace that contains the conditional block. `X::Type` binds only aliases.
 */
function csharpAliasShadowedAt(
  index: ProjectIndex,
  mod: ModuleIndex,
  qualifier: SyntaxNodeLike,
  source: string,
): boolean {
  if (qualifier.parent?.type === "alias_qualified_name") return false;
  const name = sliceText(qualifier, source);
  const alias = innermostNamespaceImport(mod.imports, name, qualifier, CSHARP_SUPPORT.normalizeIdentifier);
  const aliasStart = alias?.kind === "namespace" ? alias.localRange?.start.index : undefined;
  const regions = mod.csharpNamespaceFacts?.regions;
  if (aliasStart === undefined || !regions) return false;
  const enclosing = csharpNamespaceAtIndex(regions, qualifier.startIndex);
  return (
    !!enclosing &&
    csharpNamespaceChainDeclares(
      index,
      mod,
      enclosing,
      CSHARP_SUPPORT.normalizeIdentifier(name),
      csharpNamespaceAtIndex(regions, aliasStart),
    )
  );
}

/**
 * Why a use led by the namespace alias `qualifier` names (`X.Type`, `X::Type`) is unproven, or `null` when the alias
 * stands. A nearer namespace can shadow the alias, and an enclosing namespace of the alias's own directive can shadow
 * the first segment of its target. A project file whose declarations are unknown (no syntax tree) may declare the
 * same type name as one the alias reaches, so no type found through a namespace alias is proven to be the only one.
 * All three answers come from the index's own C# declarations when the lookup runs, never from a flag a cached
 * module holds.
 */
export function csharpAliasUnprovenReason(
  index: ProjectIndex,
  mod: ModuleIndex,
  qualifier: SyntaxNodeLike,
  source: string,
): string | null {
  if (csharpAliasShadowedAt(index, mod, qualifier, source)) return CSHARP_SHADOWED_ALIAS_REASON;
  const alias = innermostNamespaceImport(
    mod.imports,
    sliceText(qualifier, source),
    qualifier,
    CSHARP_SUPPORT.normalizeIdentifier,
  );
  if (alias?.kind !== "namespace") return null;
  // An incomplete scan is the reason when it is the only one, and a declaration that was read names the shadowing one.
  if (csharpProjectDeclarationsUnknown(index, mod)) return CSHARP_INCOMPLETE_ALIAS_REASON;
  return csharpUsingTargetShadowed(index, mod, alias.localRange?.start.index, alias.from)
    ? CSHARP_SHADOWED_TARGET_REASON
    : null;
}

export type CsharpNameRoot =
  | { kind: "none" | "ambiguous" | "unavailable" }
  | { kind: "namespace"; name: string }
  | { kind: "resolved"; definition: SymbolDef };

type CsharpStarImport = {
  binding: Extract<ImportBinding, { kind: "star" }>;
  /** The namespace block holding the directive, absent for the compilation unit. */
  region: CsharpNamespaceRegion | undefined;
  /** The imported namespace as the project's declaration table spells it. */
  imported: string;
};

const csharpStarImportTables = new WeakMap<
  readonly ImportBinding[],
  { size: number; byNamespace: Map<string, CsharpStarImport[]> }
>();

/** The `using N;` and `using static` directives that sit directly in `namespace`, read from the import list once. */
function csharpStarImportsIn(mod: ModuleIndex, namespace: string): readonly CsharpStarImport[] {
  let cached = csharpStarImportTables.get(mod.imports);
  if (cached?.size !== mod.imports.length) {
    const regions = mod.csharpNamespaceFacts?.regions;
    const byNamespace = new Map<string, CsharpStarImport[]>();
    for (const binding of mod.imports) {
      if (binding.kind !== "star") continue;
      const region = regions && csharpNamespaceRegionAtIndex(regions, binding.csharpDirectiveStartIndex);
      const imported = normalizeCsharpQualifiedName(binding.from).replace(/^global::/u, "");
      const key = region?.name ?? "";
      const entry: CsharpStarImport = { binding, region: region || undefined, imported };
      const bucket = byNamespace.get(key);
      if (bucket) bucket.push(entry);
      else byNamespace.set(key, [entry]);
    }
    cached = { size: mod.imports.length, byNamespace };
    csharpStarImportTables.set(mod.imports, cached);
  }
  return cached.byNamespace.get(namespace) ?? [];
}

/**
 * C# searches each enclosing namespace's own members, then its directives, before moving
 * outward. Global members therefore precede compilation-unit directives. Explicit aliases
 * keep their existing positioned lookup; unread project members never become namespace guesses.
 */
export function resolveCsharpNameRoot(
  index: ProjectIndex,
  mod: ModuleIndex,
  qualifier: SyntaxNodeLike,
  source: string,
  files?: ParsedFileProvider,
): CsharpNameRoot {
  if (qualifier.parent?.type === "alias_qualified_name") return { kind: "none" };
  const name = sliceText(qualifier, source);
  if (csharpAliasAt(mod, name, qualifier)) return { kind: "none" };
  const normalized = CSHARP_SUPPORT.normalizeIdentifier(name);
  const genericArity = csharpTypeArgumentArity(qualifier);
  const regions = mod.csharpNamespaceFacts?.regions;
  let namespace = regions ? csharpNamespaceAtIndex(regions, qualifier.startIndex) : "";
  for (;;) {
    const member = csharpNamespaceMemberKind(index, mod, namespace, normalized, genericArity);
    const qualified = namespace ? `${namespace}.${normalized}` : normalized;
    if (member === "namespace") return { kind: "namespace", name: qualified };
    if (member === "type") {
      // Only this namespace's own declaration counts here: a bare lookup would also match an enclosing namespace's.
      const resolved = resolveCsharpQualifiedName(
        index,
        mod,
        `global::${qualified}`,
        qualifier.startIndex,
        genericArity,
      );
      return resolved?.kind === "resolved" ? { kind: "resolved", definition: resolved.def } : { kind: "unavailable" };
    }
    // A name that is both a namespace and a type there is a conflict. One that an incomplete table merely lacks is not:
    // a project file without a syntax tree must not unbind every ordinary name, so the directives still answer for it.
    if (member === "ambiguous") return { kind: "unavailable" };
    const candidates: StarImportCandidate[] = [];
    let unavailable = false;
    for (const { binding: imp, region, imported } of csharpStarImportsIn(mod, namespace)) {
      if (region && (qualifier.startIndex < region.start || qualifier.startIndex >= region.end)) continue;
      if (imp.staticMembersOf) {
        const use = { index, mod, ...(files ? { files } : {}) };
        const types = csharpUsingStaticTypeCandidates(use, imp, name, genericArity);
        if (!types) unavailable = true;
        for (const def of types ?? []) candidates.push({ imp, def });
        continue;
      }
      if (
        csharpShadowedImports(index).has(imp) &&
        csharpShadowedStarsMayHold(index, mod, csharpTypeNameWithArity(name, genericArity))
      ) {
        unavailable = true;
        continue;
      }
      // `B<T>` binds only the matching generic declaration; a bare `B` still needs arity zero.
      if (csharpNamespaceMemberKind(index, mod, imported, normalized, genericArity) !== "type") continue;
      const def = resolveImported(index, imp, name, { csharpGenericArity: genericArity });
      if (def && !("namespace" in def)) candidates.push({ imp, def });
    }
    if (unavailable) return { kind: "unavailable" };
    const imported = decideStarImportCandidates(index, "csharp", candidates, mod.file);
    if (imported.status === "ambiguous") return { kind: "ambiguous" };
    if (imported.status === "resolved") return { kind: "resolved", definition: imported.definition };
    if (!namespace) return { kind: "none" };
    const separator = namespace.lastIndexOf(".");
    namespace = separator < 0 ? "" : namespace.slice(0, separator);
  }
}

/** An unresolved type root, including an ambiguous using, must not become a namespace. */
export function csharpNamespaceFallbackReason(
  index: ProjectIndex,
  mod: ModuleIndex,
  qualifier: SyntaxNodeLike,
  source: string,
  files?: ParsedFileProvider,
): string | null {
  const root = resolveCsharpNameRoot(index, mod, qualifier, source, files);
  if (root.kind === "ambiguous") return AMBIGUOUS_STAR_IMPORT_REASON;
  if (root.kind === "resolved" || root.kind === "unavailable") return UNRESOLVED_QUALIFIED_TYPE_REASON;
  return null;
}

/**
 * The namespace block whose directives include the alias `binding`, read from the file's own namespace regions, so an
 * alias under `#if` keeps the scope of the block around it. `undefined` for the compilation unit, and for a binding or
 * file with no recorded position.
 */
function csharpAliasRegion(mod: ModuleIndex, binding: ImportBinding): CsharpNamespaceRegion | undefined {
  const aliasStart =
    binding.kind === "named" || binding.kind === "namespace" ? binding.localRange?.start.index : undefined;
  const regions = mod.csharpNamespaceFacts?.regions;
  return regions ? csharpNamespaceRegionAtIndex(regions, aliasStart) : undefined;
}

/**
 * The alias of `candidates` that C# finds first for a use at `useIndex`. An alias binds only inside the block of the
 * namespace its directive sits in (a directive before every namespace belongs to the whole file), and the aliases of a
 * block come before those of the blocks around it, so of the aliases in scope the one in the smallest block wins. A
 * binding or file with no recorded position counts as in scope and as outermost. Aliases of one block can only differ
 * under conditional compilation, and the first stays.
 */
function nearestCsharpAlias(
  mod: ModuleIndex,
  candidates: readonly ImportBinding[],
  useIndex: number,
): ImportBinding | undefined {
  let nearest: ImportBinding | undefined;
  let nearestSpan = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const region = csharpAliasRegion(mod, candidate);
    if (region && (useIndex < region.start || useIndex >= region.end)) continue;
    const span = region ? region.end - region.start : Number.POSITIVE_INFINITY;
    if (!nearest || span < nearestSpan) {
      nearest = candidate;
      nearestSpan = span;
    }
  }
  return nearest;
}

type CsharpAliasTable = {
  size: number;
  /** The type aliases (`using B = N.Plain;`) by normalized local name; `@B` and `B` are one alias. */
  types: Map<string, ImportBinding[]>;
  /** The namespace aliases (`using X = N;`) by normalized local name. */
  namespaces: Map<string, ImportBinding[]>;
};

const csharpAliasTables = new WeakMap<readonly ImportBinding[], CsharpAliasTable>();

/** The explicit aliases of a C# file by name, read from its import list once. A star import's expanded copies are no aliases. */
function csharpAliasTable(mod: ModuleIndex): CsharpAliasTable {
  const cached = csharpAliasTables.get(mod.imports);
  if (cached?.size === mod.imports.length) return cached;
  const table: CsharpAliasTable = { size: mod.imports.length, types: new Map(), namespaces: new Map() };
  const add = (aliases: Map<string, ImportBinding[]>, name: string, binding: ImportBinding): void => {
    const named = aliases.get(name);
    if (named) named.push(binding);
    else aliases.set(name, [binding]);
  };
  for (const imp of mod.imports) {
    if (imp.kind === "namespace") {
      add(table.namespaces, CSHARP_SUPPORT.normalizeIdentifier(imp.localNS), imp);
    } else if ((imp.kind === "named" || imp.kind === "default") && !isExpandedStarBinding(imp, mod.imports)) {
      add(table.types, CSHARP_SUPPORT.normalizeIdentifier(imp.local), imp);
    }
  }
  csharpAliasTables.set(mod.imports, table);
  return table;
}

/**
 * The alias, namespace or type, that C# binds the name `name` to at `useNode`: the one declared in the nearest namespace
 * block that contains the use. `undefined` when no alias is in scope there.
 */
export function csharpAliasAt(mod: ModuleIndex, name: string, useNode: SyntaxNodeLike): ImportBinding | undefined {
  const table = csharpAliasTable(mod);
  const normalized = CSHARP_SUPPORT.normalizeIdentifier(name);
  const typeAliases = table.types.get(normalized);
  // Most names have no alias at all, which the table proves without reading the import list again.
  if (!typeAliases && !table.namespaces.has(normalized)) return undefined;
  const namespaceAlias = innermostNamespaceImport(mod.imports, name, useNode, CSHARP_SUPPORT.normalizeIdentifier);
  return nearestCsharpAlias(
    mod,
    namespaceAlias ? [namespaceAlias, ...(typeAliases ?? [])] : (typeAliases ?? []),
    useNode.startIndex,
  );
}

/**
 * Whether a table of the file's imports keyed by name, built once for the whole file, answers for `name` at `useNode`.
 * C# aliases bind only inside the block of their directive, so the table is right only for a name that no alias
 * declares, or whose single alias is the one in scope at the use. A name that two aliases share, or whose alias sits in
 * another block, has no answer a whole-file table can give.
 */
export function csharpAliasTableAnswers(mod: ModuleIndex, name: string, useNode: SyntaxNodeLike): boolean {
  const table = csharpAliasTable(mod);
  const types = table.types.get(CSHARP_SUPPORT.normalizeIdentifier(name));
  const namespaces = table.namespaces.get(CSHARP_SUPPORT.normalizeIdentifier(name));
  const declared = (types?.length ?? 0) + (namespaces?.length ?? 0);
  if (!declared) return true;
  return declared === 1 && csharpAliasAt(mod, name, useNode) === (types?.[0] ?? namespaces?.[0]);
}

/**
 * Rewrites a valid C# `using X = Namespace;` lookup (`X.Target` or `X::Target`) into the
 * dotted form export resolution understands. `global::` and unknown aliases keep their source spelling.
 */
export function csharpAliasQualifiedLookupName(
  node: SyntaxNodeLike,
  source: string,
  fallback: string,
  imports: readonly ImportBinding[],
): string {
  const raw = csharpLookupName(node, source, fallback);
  if (raw.startsWith("global::")) return raw;
  const chainNode = csharpQualifiedNameNode(node);
  const lead = chainNode && csharpChainQualifier(chainNode, source);
  if (!lead) return raw;
  const alias = sliceText(lead.qualifier, source);
  if (alias === "global") return raw;
  const imported = innermostNamespaceImport(imports, alias, lead.qualifier, CSHARP_SUPPORT.normalizeIdentifier);
  return imported ? `${imported.from}.${lead.names.toReversed().join(".")}` : raw;
}

/** A C# dotted path can fall back to a namespace only when no nearer lexical name binds its root. */
function csharpNameUnshadowed(scopeIndex: ScopeIndex, node: SyntaxNodeLike, name: string): boolean {
  const closest = findClosestScopeBinding(scopeIndex, name, node, CSHARP_SUPPORT);
  return fileBindingIsUnshadowed(scopeIndex, closest);
}

/** A C# receiver type proven through its lexical owner or its unshadowed namespace path. */
export function resolveCsharpQualifiedReceiverType(
  index: ProjectIndex,
  mod: ModuleIndex,
  typeNode: SyntaxNodeLike,
  source: string,
  scopeIndex: ScopeIndex,
  files?: ParsedFileProvider,
): SymbolDef | null {
  const qualified = csharpQualifiedNameNode(typeNode);
  if (!qualified || csharpQualifiedThroughGenericOwner(qualified)) return null;
  const lead = csharpChainQualifier(qualified, source);
  if (!lead) return null;
  if (csharpAliasUnprovenReason(index, mod, lead.qualifier, source)) return null;
  const rootName = CSHARP_SUPPORT.normalizeIdentifier(sliceText(lead.qualifier, source));
  const aliasQualified = lead.qualifier.parent?.type === "alias_qualified_name";
  if (!aliasQualified && !csharpNameUnshadowed(scopeIndex, lead.qualifier, rootName)) {
    const root = findClosestScopeBinding(scopeIndex, rootName, lead.qualifier, CSHARP_SUPPORT);
    const declaration = root?.node?.parent;
    if (!declaration) return null;
    // An enclosing type's members precede namespaces, but a namespace-level type can be shadowed by a nearer namespace.
    if (!nearestMemberContainer(declaration)) {
      const regions = mod.csharpNamespaceFacts?.regions;
      const useNamespace = regions ? csharpNamespaceAtIndex(regions, typeNode.startIndex) : "";
      const declarationNamespace = regions ? csharpNamespaceAtIndex(regions, declaration.startIndex) : "";
      if (csharpNamespaceChainDeclares(index, mod, useNamespace, rootName, declarationNamespace)) return null;
    }
    // Reuse dotted lexical lookup for nested types; a missing member never falls back to a global namespace.
    const name = csharpLookupName(typeNode, source, sliceText(qualified, source));
    const nested = findClosestScopeBinding(scopeIndex, name, typeNode, CSHARP_SUPPORT);
    const def = nested?.def && mod.locals.find((local) => local.range.start.index === nested.def?.start.index);
    return def && declaresMembers(def) ? def : null;
  }
  const alias = csharpAliasAt(mod, rootName, lead.qualifier);
  if (alias && alias.kind !== "namespace") return null;
  const name = csharpAliasQualifiedLookupName(typeNode, source, sliceText(qualified, source), mod.imports);
  if (!alias && !aliasQualified) {
    // The other parts and project base classes of an enclosing type bind the root before any namespace does. Their
    // nested lookup is not modeled here, so a receiver type led by such a member stays unresolved.
    if (peekCsharpOuterMember(index, mod.file, lead.qualifier, rootName)?.status === "member") return null;
    const root = resolveCsharpNameRoot(index, mod, lead.qualifier, source, files);
    if (root.kind === "namespace") {
      const suffix = lead.names.toReversed().join(".");
      const resolved = resolveCsharpQualifiedName(
        index,
        mod,
        `global::${root.name}.${suffix}`,
        typeNode.startIndex,
        csharpTypeArgumentArity(typeNode),
      );
      return resolved?.kind === "resolved" && declaresMembers(resolved.def) ? resolved.def : null;
    }
    if (root.kind !== "none") return null;
  }
  const resolved = resolveCsharpQualifiedName(index, mod, name, typeNode.startIndex, csharpTypeArgumentArity(typeNode));
  return resolved?.kind === "resolved" && declaresMembers(resolved.def) ? resolved.def : null;
}

/**
 * Innermost in-scope namespace import bound to `alias`. `normalize` applies the language's
 * identifier equality (C# `@X` and `X` are one alias); the default compares exact spelling.
 */
export function innermostNamespaceImport(
  imports: readonly ImportBinding[],
  alias: string,
  useNode: SyntaxNodeLike,
  normalize: (name: string) => string = (name) => name,
): ImportBinding | undefined {
  const normalizedAlias = normalize(alias);
  const matches = imports.filter(
    (candidate): candidate is Extract<ImportBinding, { kind: "namespace" }> =>
      candidate.kind === "namespace" && normalize(candidate.localNS) === normalizedAlias,
  );
  if (!matches.length) return undefined;
  let root: SyntaxNodeLike = useNode;
  while (root.parent) root = root.parent;
  let best: ImportBinding | undefined;
  let bestScopeSpan = Number.POSITIVE_INFINITY;
  let bestStart = -1;
  for (const match of matches) {
    const start = match.localRange?.start.index;
    if (start === undefined) continue;
    const scope = importScopeAt(root, start);
    if (!scope) continue;
    if (start > useNode.startIndex && scope.parent) continue;
    if (scope.startIndex > useNode.startIndex || scope.endIndex < useNode.endIndex) continue;
    const span = scope.endIndex - scope.startIndex;
    if (span < bestScopeSpan || (span === bestScopeSpan && start >= bestStart)) {
      bestScopeSpan = span;
      bestStart = start;
      best = match;
    }
  }
  if (best) return best;
  const unlocated = matches.filter((match) => match.localRange?.start.index === undefined);
  if (unlocated.length === 1) return unlocated[0];
  const files = new Map<string, ImportBinding>();
  for (const match of unlocated) {
    if (typeof match.resolved !== "string") continue;
    const key = fileIdentityKey(match.resolved);
    if (!files.has(key)) files.set(key, match);
  }
  if (files.size === 1) return [...files.values()][0];
  return undefined;
}

/**
 * A Ruby constant path as written, and where its lookup starts: `A::B` searches the lexical namespaces outward,
 * `::A::B` starts at the top level, and `self::B` names a member of the enclosing namespace.
 */
export type RubyConstantReference = {
  /** The constant names, root first (`Outer`, `Inner`, `Tool` for `Outer::Inner::Tool`). */
  names: readonly string[];
  anchor: "lexical" | "top-level" | "self";
  /** The full constant path of each module and class enclosing the use, outermost first. */
  namespaces: readonly string[];
  /** A qualified enclosing declaration whose root could not be established. */
  unprovenNamespace?: boolean;
};

/**
 * The modules and classes enclosing a Ruby node, as the full constant path of each, outermost first. A class's own name
 * and superclass expression are evaluated in the scope outside it, so they never count that class.
 */
function rubyEnclosingNamespaces(node: SyntaxNodeLike, index: ProjectIndex, mod: ModuleIndex): string[] | null {
  const scopes: SyntaxNodeLike[] = [];
  let child = node;
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "class" || current.type === "module") {
      const evaluatedOutside =
        current.childForFieldName("name")?.id === child.id || current.childForFieldName("superclass")?.id === child.id;
      if (!evaluatedOutside) scopes.unshift(current);
    }
    child = current;
  }
  const namespaces: string[] = [];
  for (const scope of scopes) {
    const name = scope.childForFieldName("name");
    if (!name) return null;
    if (name.type === "constant") {
      const parent = namespaces.at(-1);
      namespaces.push(parent ? `${parent}::${name.text}` : name.text);
      continue;
    }
    const written = rubyConstantPath(name);
    if (!written) return null;
    if (written.names.length === 1 && written.anchor !== "lexical") {
      if (written.anchor === "top-level") namespaces.push(written.names[0]!);
      else {
        const parent = namespaces.at(-1);
        if (!parent) return null;
        namespaces.push(`${parent}::${written.names[0]}`);
      }
      continue;
    }
    const candidates = rubyConstantCandidates({ names: [written.names[0]!], anchor: written.anchor, namespaces });
    const filesByRoot = rubyConstantFilesByRoot(mod, new Set(candidates.map(rubyConstantRoot)));
    let root: string | undefined;
    for (const candidate of candidates) {
      const found = resolveRubyQualifiedConstantPath(
        index,
        candidate,
        filesByRoot.get(rubyConstantRoot(candidate)) ?? [],
      );
      if (found === null) return null;
      if (found && !declaresMembers(found)) return null;
      if (found) {
        root = candidate;
        break;
      }
    }
    if (!root) return null;
    namespaces.push([root, ...written.names.slice(1)].join("::"));
  }
  return namespaces;
}

/** Read a Ruby constant path without assuming where its root is declared. */
function rubyConstantPath(node: SyntaxNodeLike): Pick<RubyConstantReference, "names" | "anchor"> | null {
  if (node.type !== "scope_resolution") return null;
  const names: string[] = [];
  let current: SyntaxNodeLike | null = node;
  while (current?.type === "scope_resolution") {
    const name = current.childForFieldName("name");
    if (name?.type !== "constant") return null;
    names.unshift(name.text);
    current = current.childForFieldName("scope");
  }
  if (!current) return { names, anchor: "top-level" };
  if (current.type === "self") return { names, anchor: "self" };
  if (current.type !== "constant") return null;
  return { names: [current.text, ...names], anchor: "lexical" };
}

/** A Ruby constant path and its proven lexical namespaces. */
export function readRubyConstantReference(
  scopeResolution: SyntaxNodeLike,
  index: ProjectIndex,
  mod: ModuleIndex,
): RubyConstantReference | null {
  const path = rubyConstantPath(scopeResolution);
  if (!path) return null;
  const namespaces = rubyEnclosingNamespaces(scopeResolution, index, mod);
  return { ...path, namespaces: namespaces ?? [], ...(namespaces ? {} : { unprovenNamespace: true }) };
}

/** The exports a Ruby constant path may name, nearest scope first: each lexical namespace outward, then the top level. */
function rubyConstantCandidates({ names, anchor, namespaces }: RubyConstantReference): string[] {
  const written = names.join("::");
  if (anchor === "top-level") return [written];
  if (anchor === "self") return namespaces.length ? [`${namespaces[namespaces.length - 1]!}::${written}`] : [];
  return [...namespaces.toReversed().map((namespace) => `${namespace}::${written}`), written];
}

/** The first constant of a Ruby constant path (`Outer` for `Outer::Inner::Tool`). */
function rubyConstantRoot(path: string): string {
  return path.split("::", 1)[0]!;
}

/**
 * The files each root constant may be declared in: the current file, and every file a `require` brought a top-level
 * constant of that name from (those arrive as namespace imports named for the constant). One pass reads the imports for
 * every candidate path of a reference.
 */
function rubyConstantFilesByRoot(mod: ModuleIndex, roots: ReadonlySet<string>): Map<string, string[]> {
  const filesByRoot = new Map<string, string[]>();
  const seen = new Set<string>();
  const add = (root: string, file: string): void => {
    const key = `${root}\0${fileIdentityKey(file)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const files = filesByRoot.get(root);
    if (files) files.push(file);
    else filesByRoot.set(root, [file]);
  };
  for (const imp of mod.imports) {
    if (imp.kind !== "namespace" || typeof imp.resolved !== "string" || !roots.has(imp.localNS)) continue;
    add(imp.localNS, imp.resolved);
  }
  for (const root of roots) add(root, mod.file);
  return filesByRoot;
}

/**
 * `Outer::Inner::Tool` is one constant path. Nested classes are exported under that path, not as bare `Tool`, so the
 * chain has to ask for the qualified export of each file that may declare it. The definition is the one declaration the
 * path names; `null` is an ambiguous path, and `undefined` one no export names.
 */
function resolveRubyQualifiedConstantPath(
  index: ProjectIndex,
  path: string,
  files: readonly string[],
): SymbolDef | null | undefined {
  const hits: SymbolDef[] = [];
  for (const file of files) {
    const hit = resolveExport(index, file, path, { allowLocalFallback: false });
    if (hit?.kind !== "resolved") continue;
    if (
      hits.some(
        (candidate) =>
          fileIdentityKey(candidate.file) === fileIdentityKey(hit.def.file) &&
          candidate.localName === hit.def.localName &&
          candidate.range.start.line === hit.def.range.start.line &&
          candidate.range.start.column === hit.def.range.start.column,
      )
    ) {
      continue;
    }
    hits.push(hit.def);
  }
  if (!hits.length) return undefined;
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * The one declaration a Ruby constant path names, searching the lexical namespaces as Ruby does: the nearest scope that
 * declares the path decides, and an ambiguous declaration there ends the search with no answer. Shared by goto, the
 * detailed graph, and member navigation, so a qualified base names the same constant everywhere.
 */
export function resolveRubyConstantReference(
  index: ProjectIndex,
  mod: ModuleIndex,
  reference: RubyConstantReference,
): SymbolDef | null {
  if (reference.unprovenNamespace) return null;
  const candidates = rubyConstantCandidates(reference);
  if (!candidates.length) return null;
  const filesByRoot = rubyConstantFilesByRoot(mod, new Set(candidates.map(rubyConstantRoot)));
  for (const candidate of candidates) {
    const found = resolveRubyQualifiedConstantPath(
      index,
      candidate,
      filesByRoot.get(rubyConstantRoot(candidate)) ?? [],
    );
    if (found !== undefined) return found;
  }
  return null;
}

/** The Ruby constant path whose last name is `node`: the name of a `scope_resolution`. */
function rubyConstantReferenceEndingAt(
  node: SyntaxNodeLike,
  index: ProjectIndex,
  mod: ModuleIndex,
): RubyConstantReference | null {
  if (node.type !== "constant") return null;
  const owner = node.parent;
  if (owner?.type !== "scope_resolution") return null;
  const ownerName = owner.childForFieldName("name");
  if (!ownerName || ownerName.startIndex !== node.startIndex || ownerName.endIndex !== node.endIndex) return null;
  return readRubyConstantReference(owner, index, mod);
}

/**
 * Whether a Ruby constant path that no declaration proves cannot name anything a project declares: it has no qualifier
 * to read through (`::Base`), or its qualifier is declared nowhere (`ActiveRecord::Base`). A `self::Base` path may reach
 * an inherited constant, and a declared qualifier may be reopened in several files, so both keep the generic lookup.
 */
function rubyConstantPathIsUndeclared(
  index: ProjectIndex,
  mod: ModuleIndex,
  sup: LanguageSupport,
  reference: RubyConstantReference,
): boolean {
  if (reference.anchor === "self") return false;
  if (reference.names.length === 1) return true;
  return !resolveRubyVisibleConstant(index, mod, sup, reference.names[0]!);
}

type JvmPackageSymbolIndex = {
  byFile: ProjectIndex["byFile"];
  size: number;
  languageExtensions: ProjectIndex["languageExtensions"];
  names: Map<string, SymbolDef[]>;
};

const jvmPackageSymbolIndexes = new WeakMap<ProjectIndex, JvmPackageSymbolIndex>();
const JVM_PACKAGE_SUPPORTS = [JAVA_SUPPORT, KOTLIN_SUPPORT] as const;

/** Builds the package/name lookup once per index instead of rescanning the project per qualified use. */
function jvmPackageSymbolIndex(index: ProjectIndex): Map<string, SymbolDef[]> {
  const cached = jvmPackageSymbolIndexes.get(index);
  if (
    cached &&
    cached.byFile === index.byFile &&
    cached.size === index.byFile.size &&
    cached.languageExtensions === index.languageExtensions
  ) {
    return cached.names;
  }
  const names = new Map<string, SymbolDef[]>();
  for (const candidate of index.byFile.values()) {
    const support = supportForFileWithoutHeaderSample(candidate.file, index.languageExtensions);
    if (support?.id !== "java" && support?.id !== "kotlin") continue;
    const packageName = getPackageDeclarationName(index, candidate.file, support.id);
    if (!packageName) continue;
    for (const entry of candidate.exports) {
      if (entry.type !== "local" || entry.target.isMember) continue;
      const key = `${support.id}\0${packageName}\0${support.normalizeIdentifier(entry.exportedAs)}`;
      const declarations = names.get(key);
      if (declarations) declarations.push(entry.target);
      else names.set(key, [entry.target]);
    }
  }
  jvmPackageSymbolIndexes.set(index, {
    byFile: index.byFile,
    size: index.byFile.size,
    languageExtensions: index.languageExtensions,
    names,
  });
  return names;
}

/** A qualified JVM package symbol; null is an ambiguity, while undefined is an absent candidate. */
export function resolveJvmPackageSymbol(
  index: ProjectIndex,
  packageName: string,
  symbolName: string,
  languageId: "java" | "kotlin",
  useFile: string,
  typeOnly = false,
): SymbolDef | null | undefined {
  const samePackage = getPackageDeclarationName(index, useFile, languageId) === packageName;
  const names = jvmPackageSymbolIndex(index);
  const unquoted = normalizeKotlinIdentifier(symbolName);
  let target: SymbolDef | undefined;
  for (const support of JVM_PACKAGE_SUPPORTS) {
    const targetLanguage = support.id === "java" ? "java" : "kotlin";
    const key = `${targetLanguage}\0${packageName}\0${support.normalizeIdentifier(unquoted)}`;
    for (const candidate of names.get(key) ?? []) {
      if (typeOnly && !declaresMembers(candidate)) continue;
      if (!isJvmPackageSymbolVisible(candidate, targetLanguage, languageId, samePackage)) continue;
      if (target && (target.file !== candidate.file || target.range.start.index !== candidate.range.start.index)) {
        return null;
      }
      target = candidate;
    }
  }
  return target;
}

/** A nested classifier is proven only by its recorded direct owner and visible declaration. */
function jvmNestedType(
  index: ProjectIndex,
  useFile: string,
  consumerLanguage: "java" | "kotlin",
  owner: SymbolDef,
  name: string,
): SymbolDef | undefined {
  const module = index.byFile.get(fileIdentityKey(owner.file));
  const support = supportForFileWithoutHeaderSample(owner.file, index.languageExtensions);
  const ownerStart = owner.range.start.index;
  if (!module || ownerStart === undefined || (support?.id !== "java" && support?.id !== "kotlin")) return undefined;
  const samePackage =
    getPackageDeclarationName(index, owner.file, support.id) ===
    getPackageDeclarationName(index, useFile, consumerLanguage);
  const normalized = support.normalizeIdentifier(normalizeKotlinIdentifier(name));
  let result: SymbolDef | undefined;
  for (const entry of module.exports) {
    if (entry.type !== "local" || support.normalizeIdentifier(entry.exportedAs) !== normalized) continue;
    if (!isJvmTypeWildcardMember(entry.target, ownerStart, support.id)) continue;
    if (!isJvmPackageSymbolVisible(entry.target, support.id, consumerLanguage, samePackage)) continue;
    if (result && result.range.start.index !== entry.target.range.start.index) return undefined;
    result = entry.target;
  }
  return result;
}

function jvmNestedPath(
  index: ProjectIndex,
  useFile: string,
  consumerLanguage: "java" | "kotlin",
  owner: SymbolDef,
  parts: readonly string[],
  start: number,
): SymbolDef | null {
  let current = owner;
  for (let position = start; position < parts.length; position += 1) {
    const nested = jvmNestedType(index, useFile, consumerLanguage, current, parts[position]!);
    if (!nested) return null;
    current = nested;
  }
  return current;
}

/**
 * The type a qualified JVM name reaches from its first segment: a type nested in `rootOwner`, the visible type that
 * segment names, or, when the first segment binds no type (`rootOwner` null), a type of the package the leading
 * segments spell. An ambiguous or unread package, and a nested type no declaration proves, reach nothing (null).
 * Shared by the lookup of a qualified type name and by the base-clause readers, so a qualified base names the same
 * type everywhere.
 */
export function resolveJvmQualifiedPath(
  index: ProjectIndex,
  useFile: string,
  languageId: "java" | "kotlin",
  rootOwner: SymbolDef | null,
  parts: readonly string[],
  typeOnly: boolean,
): SymbolDef | null {
  if (rootOwner) return jvmNestedPath(index, useFile, languageId, rootOwner, parts, 1);
  let target: SymbolDef | null = null;
  let packageName = normalizeKotlinIdentifier(parts[0]!);
  for (let position = 1; position < parts.length; position += 1) {
    const name = parts[position]!;
    const hasNestedSuffix = position + 1 < parts.length;
    const owner = resolveJvmPackageSymbol(index, packageName, name, languageId, useFile, typeOnly || hasNestedSuffix);
    if (owner === null) return null;
    const resolved = owner ? jvmNestedPath(index, useFile, languageId, owner, parts, position + 1) : null;
    if (owner && !resolved) return null;
    if (resolved) {
      if (
        target &&
        (fileIdentityKey(target.file) !== fileIdentityKey(resolved.file) ||
          target.range.start.index !== resolved.range.start.index)
      )
        return null;
      target = resolved;
    }
    packageName += `.${normalizeKotlinIdentifier(name)}`;
  }
  return target;
}

/** Package paths only bind when the leftmost name is not a lexical value or imported alias. */
function resolveJvmPackageExpression(
  index: ProjectIndex,
  sup: LanguageSupport,
  source: string,
  expr: SyntaxNodeLike,
  resolveLexicalBinding: ((expression: SyntaxNodeLike) => SymbolDef | null) | undefined,
  useFile: string,
): ResolvedExport | null {
  if (sup.id !== "java" && sup.id !== "kotlin") return null;
  const chain = collectMemberAccessChain({ sup, source, chainNode: expr });
  if (!chain || !isReceiverNameNode(sup, chain.base.type) || resolveLexicalBinding?.(chain.base)) return null;
  const parts = [sliceText(chain.base, source), ...chain.names.toReversed()];
  const member = parts.pop();
  if (!member) return null;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const quoted = sup.id === "kotlin" && part.length >= 2 && part.startsWith("`") && part.endsWith("`");
    if (!quoted && !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(part)) return null;
    if (quoted) parts[index] = normalizeKotlinIdentifier(part);
  }
  const target = resolveJvmPackageSymbol(index, parts.join("."), member, sup.id, useFile);
  return target ? { kind: "resolved", def: target } : null;
}

/** The current scope builder also records the type in `x: T` as a parameter named `T`. */
function isPythonAnnotationParameter(binding: Binding | null, node: SyntaxNodeLike): boolean {
  if (binding?.kind !== "param" || binding.def?.start.index !== node.startIndex) return false;
  const type = node.parent;
  return type?.type === "type" && type.parent?.type === "typed_parameter";
}

type PythonImportLookup = {
  imports: readonly ImportBinding[];
  length: number;
  byName: Map<string, ImportBinding[]>;
  stars: Array<Extract<ImportBinding, { kind: "star" }>>;
  hasDottedImports: boolean;
  atUse: WeakMap<SyntaxNodeLike, { binding: ImportBinding | null | undefined }>;
};

// A scope index and its source tree belong to one parsed module. Retain positioned answers only
// while that scope is alive, and discard them if its module's import list changes.
const pythonImportLookups = new WeakMap<ScopeIndex, PythonImportLookup>();

function pythonImportLookup(mod: ModuleIndex, scopeIndex: ScopeIndex): PythonImportLookup {
  const cached = pythonImportLookups.get(scopeIndex);
  if (cached && cached.imports === mod.imports && cached.length === mod.imports.length) return cached;
  const byName = new Map<string, ImportBinding[]>();
  const stars: Array<Extract<ImportBinding, { kind: "star" }>> = [];
  let hasDottedImports = false;
  for (const imp of mod.imports) {
    if (imp.kind === "star") {
      stars.push(imp);
      continue;
    }
    if (!hasDottedImports && isPythonDottedImportBinding(imp)) hasDottedImports = true;
    const name = imp.kind === "namespace" ? imp.localNS : imp.local;
    const entries = byName.get(name);
    if (entries) entries.push(imp);
    else byName.set(name, [imp]);
  }
  const lookup: PythonImportLookup = {
    imports: mod.imports,
    length: mod.imports.length,
    byName,
    stars,
    hasDottedImports,
    atUse: new WeakMap(),
  };
  pythonImportLookups.set(scopeIndex, lookup);
  return lookup;
}

/** A positioned result is specific to the identifier node, not just its function or spelling. */
function rememberPythonImportAtUse(
  lookup: PythonImportLookup,
  root: SyntaxNodeLike,
  binding: ImportBinding | null | undefined,
): ImportBinding | null | undefined {
  lookup.atUse.set(root, { binding });
  return binding;
}

/** Module names in a nested function body are read after module initialization. */
function pythonUsesModuleRuntimeBindings(node: SyntaxNodeLike): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type !== "function_definition") continue;
    const body = current.childForFieldName("body");
    if (body && body.startIndex <= node.startIndex && body.endIndex >= node.endIndex) return true;
  }
  return false;
}

/** The Python import binding selected at a receiver use, after lexical shadowing and source-order lookup. */
export function pythonImportAtUse(
  mod: ModuleIndex,
  root: SyntaxNodeLike,
  source: string,
  tree: SyntaxTreeLike,
  sup: LanguageSupport,
  scopeIndex: ScopeIndex,
): ImportBinding | null | undefined {
  const name = sliceText(root, source);
  const lookup = pythonImportLookup(mod, scopeIndex);
  const imports = lookup.byName.get(name);
  if (!imports?.length) return undefined;
  const cached = lookup.atUse.get(root);
  if (cached) return cached.binding;
  let closest = findClosestScopeBinding(scopeIndex, name, root, sup);
  const annotationParameter = isPythonAnnotationParameter(closest, root);
  if (annotationParameter) closest = findClosestScopeBinding(scopeIndex, name, root, sup, false, true);
  if (closest && !closest.import) return rememberPythonImportAtUse(lookup, root, undefined);
  if (laterLocalShadowsUse(scopeIndex, name, root, sup, annotationParameter)) {
    return rememberPythonImportAtUse(lookup, root, null);
  }
  const insideFunction = pythonUsesModuleRuntimeBindings(root);
  let winner: ImportBinding | undefined;
  let best: { span: number; start: number } | undefined;
  let laterLocalSpan: number | undefined;
  for (const imp of imports) {
    if (isExpandedStarBinding(imp, mod.imports)) continue;
    const laterSpan = pythonLaterImportScopeSpan(imp, root, tree);
    if (laterSpan !== undefined && (laterLocalSpan === undefined || laterSpan < laterLocalSpan)) {
      laterLocalSpan = laterSpan;
    }
    const position = pythonImportPosition(imp, root, tree, insideFunction, true);
    if (!position) continue;
    if (!best || position.span < best.span || (position.span === best.span && position.start > best.start)) {
      best = position;
      winner = imp;
    }
  }
  if (laterLocalSpan !== undefined && (!best || best.span > laterLocalSpan)) {
    return rememberPythonImportAtUse(lookup, root, null);
  }
  return rememberPythonImportAtUse(lookup, root, winner);
}

/**
 * Resolve a plain typed parameter's annotation outside its synthetic parameter binding.
 * Undefined means this is not that annotation; null means it has no proven declaration.
 */
export function pythonAnnotationTypeAtUse(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  source: string,
  tree: SyntaxTreeLike,
  sup: LanguageSupport,
  scopeIndex: ScopeIndex,
): SymbolDef | null | undefined {
  if (node.parent?.type !== "type" || node.parent.parent?.type !== "typed_parameter") return undefined;
  const name = sliceText(node, source);
  const closest = findClosestScopeBinding(scopeIndex, name, node, sup);
  if (!isPythonAnnotationParameter(closest, node)) return undefined;
  if (bindsTypeParameter(name, node, source, sup)) return null;
  const outer = findClosestScopeBinding(scopeIndex, name, node, sup, false, true);
  const stars = pythonImportLookup(mod, scopeIndex).stars;
  let winner: SymbolDef | null = null;
  let winnerStart = -1;
  if (outer && !outer.import) {
    const definition = definitionForBinding(outer, mod.file, node, sup, source, tree);
    if (!stars.length) return definition;
    let moduleBinding = scopeIndex.allScopes[0]?.map.get(outer.canonicalName);
    while (moduleBinding && moduleBinding !== outer) moduleBinding = moduleBinding.earlierSameScope;
    // A class, parameter, or other local in an enclosing scope beats module-level stars.
    if (!moduleBinding) return definition;
    winner = definition;
    winnerStart = outer.def?.start.index ?? -1;
  }
  const positioned = pythonImportAtUse(mod, node, source, tree, sup, scopeIndex);
  if (positioned === null) return null;
  const insideFunction = pythonUsesModuleRuntimeBindings(node);
  if (positioned) {
    const position = pythonImportPosition(positioned, node, tree, insideFunction, true);
    const imported =
      positioned.kind === "named" || positioned.kind === "default"
        ? resolveImported(index, positioned, positioned.kind === "named" ? positioned.imported : "default")
        : null;
    const definition = imported && !("namespace" in imported) ? (asMemberContainer(index, imported) ?? imported) : null;
    if (position && position.span !== Number.POSITIVE_INFINITY) return definition;
    if (position && position.start > winnerStart) {
      winner = definition;
      winnerStart = position.start;
    }
  }
  for (const star of stars) {
    const start = star.pythonStatementStartIndex;
    if (start === undefined) return null;
    if (!insideFunction && start >= node.startIndex) continue;
    if (start <= winnerStart) continue;
    if (!star.moduleLevel) return null;
    const target = typeof star.resolved === "string" ? index.byFile.get(fileIdentityKey(star.resolved)) : undefined;
    if (!target || target.parserDegraded || target.nativeOutcome === "skipped" || target.parseErrorRanges?.length) {
      return null;
    }
    const definition = resolveStarImportedDefinition(index, star, name, "python");
    if (!definition) continue;
    winner = definition;
    winnerStart = start;
  }
  return winner;
}

/** A dotted phrase names an imported module only when its root still names the imported package. */
export function pythonDottedPhraseAtUse(
  index: ProjectIndex,
  mod: ModuleIndex,
  root: SyntaxNodeLike,
  phrase: string,
  source: string,
  tree: SyntaxTreeLike,
  sup: LanguageSupport,
  scopeIndex: ScopeIndex,
): string | null | undefined {
  const rootName = sliceText(root, source);
  const imports = pythonImportLookup(mod, scopeIndex).byName.get(rootName);
  if (!imports?.some(isPythonDottedImportBinding)) return undefined;
  const binding = pythonImportAtUse(mod, root, source, tree, sup, scopeIndex);
  if (!binding || binding.kind !== "namespace") return undefined;
  return pythonDottedPhraseFile(index, mod.imports, phrase, (candidate) => {
    if (!isPythonDottedImportBinding(candidate) || !pythonImportPrecedesUse(candidate, root, tree)) return false;
    if (isPythonDottedImportBinding(binding)) return binding.localNS === rootName;
    const packageFile = pythonDottedImportPackageFile(index, candidate);
    return (
      binding.from === rootName &&
      typeof binding.resolved === "string" &&
      !!packageFile &&
      fileIdentityKey(binding.resolved) === fileIdentityKey(packageFile)
    );
  });
}

export async function resolveMemberAccessDefinition(params: {
  index: ProjectIndex;
  mod: ModuleIndex;
  node: SyntaxNodeLike;
  source: string;
  tree: SyntaxTreeLike;
  sup: LanguageSupport;
  scopeIndex?: ScopeIndex;
  resolveLexicalBinding?: (expression: SyntaxNodeLike) => SymbolDef | null;
  resolveJvmTypeName: JvmTypeNameResolver;
  loadParsedFile?: PythonParsedFileLoader;
  pythonReceiverResolutionCache?: PythonReceiverResolutionCache;
}): Promise<GoToResult | null> {
  const {
    index,
    mod,
    node,
    source,
    tree,
    sup,
    scopeIndex: ownedScopeIndex,
    resolveLexicalBinding,
    resolveJvmTypeName,
    loadParsedFile,
    pythonReceiverResolutionCache,
  } = params;
  const ensureScopeIndex = (): ScopeIndex =>
    ownedScopeIndex ?? getOrBuildScopeIndex(index, mod.file, source, sup, mod, tree);
  if (sup.id === "ruby") {
    const reference = rubyConstantReferenceEndingAt(node, index, mod);
    if (reference) {
      const definition = resolveRubyConstantReference(index, mod, reference);
      if (definition) {
        return okGoToResult(index, definition, {
          via: { exportedName: reference.names.join("::") },
          resolution: "member-access",
          confidence: "medium",
        });
      }
      if (reference.unprovenNamespace) return { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
      // The tail of a constant whose qualifier no project file declares (`ActiveRecord::Base`) is a member of that
      // external qualifier, and a top-level `::Base` has no qualifier to read through, so its own spelling must not bind
      // a constant of that name.
      if (rubyConstantPathIsUndeclared(index, mod, sup, reference)) {
        return { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
      }
    }
  }
  const parent = node.parent;
  if (!parent || !sup.supportsCrossModuleSymbols) {
    return null;
  }
  if (sup.id === "java" && isQualifiedTypeSuffix(sup, node)) {
    const resolution = await resolveJvmTypeName(index, mod, { source, tree, sup }, ensureScopeIndex(), node);
    if (resolution && resolution.status !== "deferred") return resolution;
    return { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
  }
  let memberNode: SyntaxNodeLike | null = null;
  if (isMemberAccessNode(sup, parent)) {
    memberNode = parent;
  } else if (parent.parent && isMemberAccessNode(sup, parent.parent)) {
    memberNode = parent.parent;
  }
  if (!memberNode) return null;
  const csharpLead = sup.id === "csharp" ? csharpChainQualifier(memberNode, source) : null;
  if (csharpLead) {
    const reason = csharpAliasUnprovenReason(index, mod, csharpLead.qualifier, source);
    if (reason) {
      // A parameter, local, or member named like the alias is a value that C# binds before any alias,
      // except after `::`, which reaches aliases only.
      const scopeIndex = ensureScopeIndex();
      const closest = findClosestScopeBinding(
        scopeIndex,
        sliceText(csharpLead.qualifier, source),
        csharpLead.qualifier,
        sup,
      );
      const aliasQualified = csharpLead.qualifier.parent?.type === "alias_qualified_name";
      if (aliasQualified || !closest || closest.import) return { status: "not_found", reason };
    }
  }
  const { object: obj, property: prop } = getMemberAccessParts(sup, memberNode);
  const optionalMemberTypes = memberAccessTraversalTypes(sup);

  // Only the outermost access is the callee; an inner hop (`A.B` in `A.B.C()`) is not called.
  const callArgumentCountFor = (expr: SyntaxNodeLike): number | undefined =>
    expr.id === memberNode.id
      ? (getCallArgumentCount({ languageId: sup.id, source, call: memberNode.parent ?? memberNode }) ?? undefined)
      : undefined;

  // C# enclosing members precede aliases (only nested types in type positions). Unknown project declarations
  // prevent proof; external bases do not participate. Navigation, references, and the graph share this lookup.
  const aliasMemberLookups = new Map<number, Promise<CsharpAliasMemberLookup>>();
  const aliasMemberLookup = (expr: SyntaxNodeLike, exprName: string): Promise<CsharpAliasMemberLookup> => {
    let lookup = aliasMemberLookups.get(expr.startIndex);
    if (!lookup) {
      lookup = csharpAliasMemberLookup(index, mod, expr, exprName);
      aliasMemberLookups.set(expr.startIndex, lookup);
    }
    return lookup;
  };
  let csharpRootFiles: LoadingParsedFileProvider | undefined;
  const hasCsharpStaticImports =
    sup.id === "csharp" && mod.imports.some((imp) => imp.kind === "star" && imp.staticMembersOf);
  const csharpNameRoot = async (expr: SyntaxNodeLike): Promise<CsharpNameRoot> => {
    if (!hasCsharpStaticImports) return resolveCsharpNameRoot(index, mod, expr, source);
    csharpRootFiles ??= createLoadingParsedFileProvider(index, { file: mod.file, parsed: { source, tree, sup } });
    return withParsedFiles(csharpRootFiles, () => resolveCsharpNameRoot(index, mod, expr, source, csharpRootFiles));
  };
  /** `::` and closer lexical bindings bypass enclosing-member alias lookup. */
  const aliasBindsExpressionName = (expr: SyntaxNodeLike, exprName: string): boolean => {
    if (isCsharpAliasQualifier(expr, sup)) return false;
    if (resolveLexicalBinding?.(expr) || !csharpNameUnshadowed(ensureScopeIndex(), expr, exprName)) return false;
    return !!csharpAliasAt(mod, exprName, expr);
  };
  if (csharpLead) {
    const leadName = sliceText(csharpLead.qualifier, source);
    if (aliasBindsExpressionName(csharpLead.qualifier, leadName)) {
      const lookup = await aliasMemberLookup(csharpLead.qualifier, leadName);
      if (lookup.status === "unproven") return { status: "not_found", reason: UNPROVEN_CSHARP_ALIAS_MEMBER_REASON };
    }
  }
  /** The declared type of the member that binds an alias-named receiver first, when that type is proven. */
  const hiddenReceiverType = async (expr: SyntaxNodeLike): Promise<SymbolDef | null> => {
    if (sup.id !== "csharp" || !isReceiverNameNode(sup, expr.type)) return null;
    const exprName = sliceText(expr, source);
    if (!aliasBindsExpressionName(expr, exprName)) return null;
    const lookup = await aliasMemberLookup(expr, exprName);
    if (lookup.status !== "member" || !lookup.member || declaresMembers(lookup.member)) return null;
    return await csharpMemberDeclaredType(index, lookup.member);
  };

  const resolveExpression = async (expr: SyntaxNodeLike): Promise<ResolvedExport | null> => {
    if (sup.id === "kotlin" && expr.type === "user_type") {
      const resolution = await resolveJvmTypeName(index, mod, { source, tree, sup }, ensureScopeIndex(), expr);
      const definition = definitionWithoutDeferredSteps(resolution);
      return definition ? { kind: "resolved", def: definition } : null;
    }
    const exprIsId = isReceiverNameNode(sup, expr.type) && !isMemberAccessNode(sup, expr);
    if (exprIsId) {
      if (sup.id === "python") {
        const annotation = pythonAnnotationTypeAtUse(index, mod, expr, source, tree, sup, ensureScopeIndex());
        if (annotation !== undefined) return annotation ? { kind: "resolved", def: annotation } : null;
      }
      const aliasQualifier = isCsharpAliasQualifier(expr, sup);
      const exprName = sliceText(expr, source);
      const pythonImport =
        sup.id === "python" ? pythonImportAtUse(mod, expr, source, tree, sup, ensureScopeIndex()) : undefined;
      if (pythonImport === null) return null;
      const pythonBinding =
        sup.id === "python" ? findClosestScopeBinding(ensureScopeIndex(), exprName, expr, sup) : null;
      // A name bound by star expansion has no explicit import to position; the last-star rule below picks its source.
      const pythonStarBound = !!pythonBinding?.import && isExpandedStarBinding(pythonBinding.import, mod.imports);
      if (!aliasQualifier && !(pythonImport && pythonBinding?.import)) {
        const lexicalBinding = resolveLexicalBinding?.(expr);
        if (lexicalBinding) return { kind: "resolved", def: lexicalBinding };
        if (sup.id === "csharp" && !csharpNameUnshadowed(ensureScopeIndex(), expr, exprName)) return null;
      }
      let imp: ImportBinding | undefined;
      if (sup.id === "python") {
        imp = pythonImport;
        // A local value must not fall back to a same-named module declaration or star import.
        if (pythonBinding && !pythonBinding.import) return null;
        if (!imp && !pythonStarBound) {
          const importBindsName = !!pythonBinding?.import;
          const importedNameIsShadowed =
            pythonImportLookup(mod, ensureScopeIndex()).byName.has(exprName) &&
            laterLocalShadowsUse(ensureScopeIndex(), exprName, expr, sup);
          if (importBindsName || importedNameIsShadowed) return null;
        }
      } else if (sup.id === "php") {
        imp = findPhpImportAlias(mod.imports, exprName, "class") ?? undefined;
      } else if (sup.id === "zig") {
        imp = innermostNamespaceImport(mod.imports, exprName, expr);
        if (!imp) {
          imp = mod.imports.find(
            (candidate) => (candidate.kind === "named" || candidate.kind === "default") && candidate.local === exprName,
          );
        }
      } else if (sup.id === "csharp") {
        if (aliasQualifier) {
          if (exprName !== "global")
            imp = innermostNamespaceImport(mod.imports, exprName, expr, sup.normalizeIdentifier);
          if (!imp) return null;
        } else {
          imp = csharpAliasAt(mod, exprName, expr);
          if (imp) {
            const lookup = await aliasMemberLookup(expr, exprName);
            // An inherited nested type binds the name as a type receiver; any other member is a value of unknown type.
            if (lookup.status === "member" && lookup.member && declaresMembers(lookup.member)) {
              return { kind: "resolved", def: lookup.member };
            }
            if (lookup.status !== "none") return null;
          }
        }
      } else {
        imp = effectiveExplicitBinding(
          mod.imports,
          sup.id,
          (candidate) =>
            ((candidate.kind === "named" || candidate.kind === "default") && candidate.local === exprName) ||
            (candidate.kind === "namespace" && candidate.localNS === exprName),
        );
        if (!imp && isJsTsLanguage(sup.id)) {
          imp = innermostNamespaceImport(mod.imports, exprName, expr);
        }
      }
      if (imp) {
        if (imp.kind === "namespace") {
          if (imp.mechanism === "cjs" && typeof imp.resolved === "string") {
            const classValue = cjsRequireValueBinding(index, imp.resolved);
            if (classValue) return { kind: "resolved", def: classValue };
          }
          // An unaliased `import a.b` binds the package `a`, not the leaf module its binding resolves to.
          if (sup.id === "python" && isPythonDottedImportBinding(imp)) {
            const packageFile = pythonDottedImportPackageFile(index, imp);
            return packageFile ? { kind: "namespace", file: packageFile.replace(/\\/g, "/") } : null;
          }
          return {
            kind: "namespace",
            file: typeof imp.resolved === "string" ? imp.resolved.replace(/\\/g, "/") : imp.resolved?.external || "",
          };
        }
        if (sup.id === "php" && imp.kind === "named" && typeof imp.resolved === "string") {
          const result = resolvePhpExportByImportType(index, imp.resolved, imp.imported, "class");
          if (result) return result;
        }
        if (sup.id === "rust") {
          const moduleFile = resolveRustModuleNamespace(index, imp);
          if (moduleFile) return { kind: "namespace", file: moduleFile };
        }
        const result = resolveImported(index, imp, imp.kind === "named" ? imp.imported : "default");
        if (result) {
          if ("namespace" in result) {
            return { kind: "namespace", file: result.namespace };
          }
          const container = asMemberContainer(index, result);
          return { kind: "resolved", def: container ?? result };
        }
        // Last-wins precedence (Python): the explicit import rebound the name, and an
        // unresolved winner stays unresolved instead of falling back to an older star import.
        if (starImportPrecedence(sup.id) === "last-wins") return null;
      }

      if (sup.id === "csharp") {
        if (imp) return null;
        if (csharpTypeRootName(expr)) {
          // A nested type or member an enclosing type receives from another part or a base class binds before any namespace.
          const enclosing = await aliasMemberLookup(expr, exprName);
          if (enclosing.status === "member") {
            return enclosing.member && declaresMembers(enclosing.member)
              ? { kind: "resolved", def: enclosing.member }
              : null;
          }
        }
        const root = await csharpNameRoot(expr);
        return root.kind === "resolved" ? { kind: "resolved", def: root.definition } : null;
      } else {
        // JVM locals must come from the positioned scope lookup above, not an unrelated method's parameter.
        const positionedJvmLookup = !!resolveLexicalBinding && (sup.id === "java" || sup.id === "kotlin");
        const local = positionedJvmLookup
          ? undefined
          : mod.locals.find((candidate) => {
              if (candidate.localName === exprName) return true;
              return (
                sup.id === "php" &&
                declaresMembers(candidate) &&
                foldPhpIdentifierCase(candidate.localName) === foldPhpIdentifierCase(exprName)
              );
            });
        if (local) return { kind: "resolved", def: local };
        if (sup.id === "java" || sup.id === "kotlin" || sup.id === "swift") {
          const peer = resolveExport(index, mod.file, exprName);
          if (peer) return peer;
        } else if (sup.id === "php") {
          const phpClass = resolveIndexedPhpClassReference(index, source, tree, expr, exprName, mod.imports);
          if (phpClass) return { kind: "resolved", def: phpClass };
        }
      }

      const starDecision = resolveStarImportedName(index, mod, sup.id, exprName);
      if (starDecision.status === "resolved") return { kind: "resolved", def: starDecision.definition };
      if (starDecision.status === "ambiguous") return null;
      const starNamespaceDecision = resolveStarImportedNamespace(index, mod, sup.id, exprName);
      if (starNamespaceDecision.status === "resolved") {
        return { kind: "namespace", file: starNamespaceDecision.namespace };
      }
      if (starNamespaceDecision.status === "ambiguous") return null;
      return null;
    }

    if (optionalMemberTypes.has(expr.type)) {
      // A Python unaliased dotted import (`import a.b.c`) binds the package `a`, and the source reaches the package
      // `a.b` and the leaf `a.b.c` by repeating their dotted phrases (`a.b.symbol(...)`, `a.b.c.symbol(...)`).
      // Recognize those literal phrases up front so the chain walk below lands on the module each one names, instead
      // of treating each dot as an ordinary member-access hop and failing on a segment the import only spells.
      if (sup.id === "python" && pythonImportLookup(mod, ensureScopeIndex()).hasDottedImports) {
        const chain = collectMemberAccessChain({ sup, source, chainNode: expr });
        if (chain && isReceiverNameNode(sup, chain.base.type)) {
          const phraseFile = pythonDottedPhraseAtUse(
            index,
            mod,
            chain.base,
            sliceText(expr, source),
            source,
            tree,
            sup,
            ensureScopeIndex(),
          );
          if (phraseFile !== undefined) {
            return phraseFile ? { kind: "namespace", file: phraseFile.replace(/\\/g, "/") } : null;
          }
        }
      }
      const parts = getMemberAccessParts(sup, expr);
      const subObj = parts.object;
      let subProp = parts.property;
      if (!subProp && expr.type === "navigation_expression") {
        subProp = getNavigationExpressionProperty(sup, expr);
      }
      if (subObj && subProp) {
        const base = await resolveExpression(subObj);
        if (!base) {
          const qualified = resolveJvmPackageExpression(index, sup, source, expr, resolveLexicalBinding, mod.file);
          if (qualified) return qualified;
        }
        const memberName = sliceText(subProp, source);
        // An unresolved type root, including an ambiguous using, cannot become a namespace.
        const dottedRoot = !base && sup.id === "csharp" ? csharpDottedNameRoot(expr) : null;
        const qualifiedRoot =
          !base && !dottedRoot && sup.id === "csharp" ? csharpChainQualifier(expr, source)?.qualifier : null;
        const globalQualified =
          qualifiedRoot?.parent?.type === "alias_qualified_name" && sliceText(qualifiedRoot, source) === "global";
        let namespaceName = globalQualified ? sliceText(expr, source).replace(/\s+/gu, "") : null;
        if (dottedRoot) {
          const rootName = sliceText(dottedRoot, source);
          const lexicalRoot =
            !!resolveLexicalBinding?.(dottedRoot) || !csharpNameUnshadowed(ensureScopeIndex(), dottedRoot, rootName);
          if (!lexicalRoot && !csharpAliasAt(mod, rootName, dottedRoot)) {
            // A member an enclosing type receives from another part or a base class binds the root: it is no namespace.
            const enclosing = csharpTypeRootName(dottedRoot) ? await aliasMemberLookup(dottedRoot, rootName) : null;
            if (enclosing?.status === "member") return null;
            const root = await csharpNameRoot(dottedRoot);
            if (root.kind === "namespace") {
              const suffix = source.slice(dottedRoot.endIndex, expr.endIndex).replace(/\s+/gu, "");
              namespaceName = `global::${root.name}${suffix}`;
            } else if (root.kind === "none") {
              namespaceName = sliceText(expr, source).replace(/\s+/gu, "");
            }
          }
        }
        if (namespaceName) return resolveCsharpQualifiedName(index, mod, namespaceName, expr.startIndex);
        if (base?.kind === "namespace") {
          if (!isGoExportedMemberName(sup.id, memberName)) return null;
          return resolveExport(index, base.file, memberName, { allowLocalFallback: false });
        }
        if (base?.kind === "resolved") {
          if (sup.id === "go") {
            const receiver = await resolveReceiverDefinition(
              index,
              subObj,
              source,
              sup,
              resolveExpression,
              mod,
              ensureScopeIndex,
              undefined,
              base,
            );
            if (receiver && declaresMembers(receiver.def)) {
              const context = await ensureParsedContextForIndex(index, receiver.def.file);
              const embedded = goEmbeddedTypeNames(receiver.def.localName, context, context.sup.normalizeIdentifier);
              if (embedded.includes(memberName)) {
                const ownerModule = index.byFile.get(fileIdentityKey(receiver.def.file));
                const named = ownerModule
                  ? resolveNamedDefinition(index, ownerModule, ownerModule.file, context.sup, memberName)
                  : null;
                if (named?.status === "ok") {
                  const type = asMemberContainer(index, named.definition);
                  if (type) return { kind: "resolved", def: type };
                }
              }
            }
          }
          if (sup.id === "java" || sup.id === "csharp") {
            const memberDef = await resolveMemberDefinitionForBase(
              index,
              base.def,
              memberName,
              callArgumentCountFor(expr),
            );
            return memberDef ? { kind: "resolved", def: memberDef } : null;
          }
          if (sup.id === "ruby" && declaresMembers(base.def)) {
            const memberDef = await resolveMemberDefinitionForBase(index, base.def, memberName);
            if (memberDef) return { kind: "resolved", def: memberDef };
            const localHit = resolveExport(index, base.def.file, memberName);
            if (localHit) return localHit;
          }
          return null;
        }
      }
    }

    if (sup.id === "java" && (expr.type === "scoped_identifier" || expr.type === "scoped_type_identifier")) {
      const subObj = expr.childForFieldName("scope") ?? expr.child(0);
      const subProp = expr.childForFieldName("name") ?? expr.child(2);
      if (subObj && subProp) {
        const base = await resolveExpression(subObj);
        if (!base) {
          const qualified = resolveJvmPackageExpression(index, sup, source, expr, resolveLexicalBinding, mod.file);
          if (qualified) return qualified;
        }
        const memberName = sliceText(subProp, source);
        if (base?.kind === "namespace") {
          return resolveExport(index, base.file, memberName, { allowLocalFallback: false });
        }
        if (base?.kind === "resolved") {
          const memberDef = await resolveMemberDefinitionForBase(
            index,
            base.def,
            memberName,
            callArgumentCountFor(expr),
          );
          return memberDef ? { kind: "resolved", def: memberDef } : null;
        }
      }
    }

    return null;
  };

  const receiverHasLexicalBinding =
    sup.id === "python"
      ? (callee: SyntaxNodeLike): boolean => {
          const scope = getOrBuildScopeIndex(index, mod.file, source, sup, mod, tree);
          return !!findClosestScopeBinding(scope, sliceText(callee, source), callee, sup);
        }
      : noLexicalBinding;
  const resolvedReceiver = obj && prop && node.id === prop.id ? await resolveExpression(obj) : null;
  const receiverProof =
    obj && prop && node.id === prop.id
      ? classifyReceiver(sup, obj, source, null, 0, memberNode, receiverHasLexicalBinding, () => {
          if (resolvedReceiver?.kind === "namespace") return "module-import";
          if (resolvedReceiver?.kind === "resolved" && declaresMembers(resolvedReceiver.def)) return "static-type";
          return null;
        })
      : null;
  const pythonInstanceReceiver =
    sup.id === "python" &&
    ((receiverProof?.kind === "own-type" && obj?.type === "identifier" && sliceText(obj, source) === "self") ||
      (receiverProof?.kind === "named-type" && receiverProof.proof !== "static-type"));
  const chain = await resolveExpression(memberNode);
  if (!chain && csharpLead) {
    const qualifier = csharpLead.qualifier;
    const name = sliceText(qualifier, source);
    const lexical = resolveLexicalBinding?.(qualifier) || !csharpNameUnshadowed(ensureScopeIndex(), qualifier, name);
    if (!lexical) {
      const root = await csharpNameRoot(qualifier);
      if (root.kind === "namespace") {
        const qualified = `${root.name}.${csharpLead.names.toReversed().join(".")}`;
        if (csharpNamespaceMemberKind(index, mod, "", qualified) === "namespace") {
          return { status: "not_found", reason: CSHARP_NAMESPACE_NAME_REASON };
        }
      }
    }
  }
  if (chain && prop && node.id === prop.id) {
    if (chain.kind === "resolved" && !pythonInstanceReceiver) {
      return okGoToResult(index, chain.def, {
        via: { exportedName: sliceText(prop, source) },
        resolution: "member-access",
        confidence: "medium",
      });
    }
    if (chain.kind === "namespace") {
      const targetMod = index.byFile.get(fileIdentityKey(chain.file));
      const first = targetMod?.exports.find((entry) => entry.type === "local");
      if (first) {
        return okGoToResult(index, first.target, {
          via: { exportedName: first.exportedAs },
          resolution: "namespace",
          confidence: "medium",
        });
      }
    }
  }

  if (obj && prop && node.id === prop.id && supportsReceiverMemberNavigation(sup.id)) {
    const member = sliceText(prop, source);
    if (sup.id === "python") {
      const memberDef = await resolvePythonReceiverMember(
        index,
        mod,
        node,
        obj,
        member,
        source,
        sup,
        resolveExpression,
        receiverProof,
        loadParsedFile,
        pythonReceiverResolutionCache,
      );
      if (!memberDef) return null;
      return okGoToResult(index, memberDef, {
        via: { exportedName: member },
        resolution: "member-access",
        confidence: "medium",
      });
    }
    const keywordScope =
      receiverProof?.kind === "own-type" || receiverProof?.kind === "supertype" ? receiverProof.memberScope : "any";
    if (receiverProof?.kind === "own-type") {
      const memberDef = await resolveKeywordReceiverMember(
        index,
        mod,
        node,
        member,
        keywordScope,
        false,
        getCallArgumentCount({ languageId: sup.id, source, call: memberNode.parent ?? memberNode }) ?? undefined,
      );
      if (memberDef) {
        return okGoToResult(index, memberDef, {
          via: { exportedName: member },
          resolution: "member-access",
          confidence: "medium",
        });
      }
      const outOfLineOwnerPath = cppOutOfLineOwnerPath(node, source, sup);
      const outOfLineOwner = outOfLineOwnerPath
        ? await resolveCppQualifiedMemberContainer(index, mod, outOfLineOwnerPath)
        : null;
      if (outOfLineOwner) {
        const outOfLineMember = await resolveKeywordReceiverMember(
          index,
          mod,
          node,
          member,
          keywordScope,
          false,
          getCallArgumentCount({ languageId: sup.id, source, call: memberNode.parent ?? memberNode }) ?? undefined,
          outOfLineOwner,
        );
        if (outOfLineMember) {
          return okGoToResult(index, outOfLineMember, {
            resolution: "exact",
            confidence: "high",
          });
        }
      }
      // A failed `self` lookup is not a license to bind an unrelated same-file
      // extension member by its bare name (including an unproven where clause).
      if (sup.id === "swift") return { status: "not_found", reason: "No matching Swift member definition" };
    } else if (receiverProof?.kind === "supertype") {
      const memberDef = await resolveKeywordReceiverMember(
        index,
        mod,
        node,
        member,
        keywordScope,
        true,
        getCallArgumentCount({ languageId: sup.id, source, call: memberNode.parent ?? memberNode }) ?? undefined,
      );
      if (!memberDef) return { status: "not_found", reason: "No matching supertype member definition" };
      return okGoToResult(index, memberDef, {
        via: { exportedName: member },
        resolution: "member-access",
        confidence: "medium",
      });
    }

    if (sup.id === "cpp" && memberNode.type === "qualified_identifier") {
      // `a::C::run` nests `C::run` inside `a::(...)`; only the outermost node carries the full owner.
      let outermost = memberNode;
      while (outermost.parent?.type === "qualified_identifier") outermost = outermost.parent;
      // The declarator of an out-of-line definition (`int Box<T>::f() {}`) names the declaration
      // itself, not a member call; the declaration lookup below resolves it.
      if (outermost.parent?.type === "function_declarator") return null;
      const qualified = cppQualifiedNameSegments(outermost, source);
      const ownerPath = qualified.slice(0, -1);
      const owner = await resolveCppQualifiedMemberContainer(index, mod, ownerPath);
      if (owner) {
        const knownArgumentCount =
          getCallArgumentCount({ languageId: sup.id, source, call: memberNode.parent ?? memberNode }) ?? undefined;
        // Inside a member function, `Owner::member()` can name an instance member of the class or a
        // base through the implicit `this`; elsewhere only static members qualify.
        const implicitThis = await cppQualifiedOwnerHasImplicitThis(index, mod, memberNode, source, sup, owner);
        const memberScope = implicitThis ? "any" : "static";
        const memberDef = await resolveKeywordReceiverMember(
          index,
          mod,
          node,
          member,
          memberScope,
          false,
          knownArgumentCount,
          owner,
        );
        return memberDef
          ? okGoToResult(index, memberDef, { resolution: "member-access", confidence: "high" })
          : { status: "not_found", reason: "No matching C++ static member definition" };
      }
      // A qualifier that is not a class (a namespace) names a free function, which the qualified
      // function lookup resolves; the short name must not be read as a same-named class receiver.
      return null;
    }

    const importType = isJsTsLanguage(sup.id) && receiverProof?.kind === "named-type" ? receiverProof.typeNode : null;
    const importSpecifier = importType?.type === "type_query" ? importTypeQuerySpecifier(importType) : null;
    if (importSpecifier) {
      const memberDef = resolveImportTypeMember(index, mod.file, importSpecifier, member);
      return memberDef
        ? okGoToResult(index, memberDef, {
            via: { exportedName: member },
            resolution: "member-access",
            confidence: "medium",
          })
        : null;
    }
    const receiver = await resolveReceiverDefinition(
      index,
      obj,
      source,
      sup,
      resolveExpression,
      mod,
      ensureScopeIndex,
      receiverProof,
      resolvedReceiver,
      hiddenReceiverType,
    );

    if (receiver) {
      const objDef = receiver.def;
      const targetContext = await ensureParsedContextForIndex(index, objDef.file);
      const start = objDef.range.start;
      const targetPosition = {
        row: start.line - 1,
        column: start.column - 1,
      };
      const nameNode = targetContext.tree.rootNode.descendantForPosition(targetPosition, targetPosition);
      const container = nameNode.parent;
      if (
        receiver.runtimeTypeOnly &&
        container &&
        container.type !== "enum_declaration" &&
        container.type !== "internal_module" &&
        container.type !== "module"
      ) {
        return null;
      }
      if (container) {
        const targetModule = index.byFile.get(fileIdentityKey(objDef.file));
        if (targetModule) {
          const normalizeIdentifier = targetContext.sup.normalizeIdentifier;
          const memberPredicate =
            receiver.memberScope === "any"
              ? undefined
              : (local: SymbolDef) => matchesReceiverMemberScope(local, receiver.memberScope, targetContext, container);
          const knownArgumentCount =
            getCallArgumentCount({ languageId: sup.id, source, call: memberNode.parent ?? memberNode }) ?? undefined;
          let memberDef: SymbolDef | undefined;
          const hierarchyLanguage =
            isJsTsLanguage(targetContext.sup.id) ||
            targetContext.sup.id === "ruby" ||
            targetContext.sup.id === "cpp" ||
            targetContext.sup.id === "csharp" ||
            targetContext.sup.id === "java" ||
            targetContext.sup.id === "kotlin" ||
            targetContext.sup.id === "php" ||
            targetContext.sup.id === "swift";
          if (hierarchyLanguage && declaresMembers(objDef) && !receiver.runtimeTypeOnly) {
            const report = { named: false, ambiguous: false };
            memberDef = await resolveKeywordReceiverMember(
              index,
              mod,
              node,
              member,
              receiver.memberScope,
              false,
              knownArgumentCount,
              objDef,
              report,
            );
            if (!memberDef && report.named) return { status: "not_found", reason: "No unique receiver member" };
          }
          if (
            !memberDef &&
            (targetContext.sup.id === "ts" || targetContext.sup.id === "tsx") &&
            (container.type === "internal_module" || container.type === "module")
          ) {
            memberDef = await findReceiverMemberDefinition(
              index,
              targetModule.locals,
              member,
              objDef,
              container,
              targetContext,
              normalizeIdentifier,
              receiver.memberScope,
              knownArgumentCount,
            );
          } else if (!memberDef && (receiver.runtimeTypeOnly || targetContext.sup.id === "java")) {
            const candidates = findDirectLocalsWithinNode(
              targetModule.locals,
              member,
              container,
              targetContext,
              normalizeIdentifier,
              memberPredicate,
            );
            const selected = selectMember([objDef], indexedMemberModel(index, candidates, targetContext.sup.id), {
              name: member,
              argumentCount: knownArgumentCount ?? null,
              scope: "any",
              useFile: mod.file,
              phpCaseInsensitive: targetContext.sup.id === "php",
              normalizeIdentifier: targetContext.sup.id === "swift" ? normalizeIdentifier : undefined,
              keepUniqueArityMismatch: true,
            });
            memberDef = selected.status === "unique" ? selected.member : undefined;
          } else if (!memberDef) {
            memberDef = await findReceiverMemberDefinition(
              index,
              targetModule.locals,
              member,
              objDef,
              container,
              targetContext,
              normalizeIdentifier,
              receiver.memberScope,
              knownArgumentCount,
            );
          }
          const memberContext =
            memberDef && fileIdentityKey(memberDef.file) !== fileIdentityKey(objDef.file)
              ? await ensureParsedContextForIndex(index, memberDef.file)
              : targetContext;
          if (
            memberDef &&
            (sup.id === "cpp" ||
              isGoExportedMemberName(sup.id, member) ||
              getCompilationUnitPeers(index, mod.file).files.has(memberDef.file)) &&
            !crossFilePeerMemberHidden(mod.file, memberDef, memberContext)
          ) {
            return okGoToResult(index, memberDef, {
              via: { exportedName: member },
              resolution: "member-access",
              confidence: "medium",
            });
          }
        }
      }
    }
  }

  return null;
}

function findEnclosingClassContainer(node: SyntaxNodeLike): SyntaxNodeLike | null {
  return nearestMemberContainer(node);
}

type KeywordClassRef = {
  file: string;
  container: SyntaxNodeLike;
  context: ParsedFileContext;
  module: ModuleIndex;
};

function keywordContainerKey(file: string, container: SyntaxNodeLike): string {
  return `${fileIdentityKey(file)}:${container.startIndex}:${container.endIndex}`;
}

/**
 * One direct base a class declares. `unproven` is a base clause entry that names a type no reader can resolve (a
 * computed expression, a generic owner, a path without a constant root); it keeps the hierarchy from counting as
 * known, where dropping it would make an absent base look like no base. A `simple` base keeps the offset of its name
 * (`at`), so a scope lookup can read the binding that spelling names.
 */
type DeclaredBaseType =
  | { kind: "simple"; name: string; at: number; kotlinEntry?: KotlinSupertypeEntry }
  | {
      kind: "qualified";
      base: string;
      path: readonly string[];
      node: SyntaxNodeLike;
      kotlinEntry?: KotlinSupertypeEntry;
    }
  | { kind: "ruby-constant"; reference: RubyConstantReference }
  | { kind: "unproven" };

/** The child type holding one name segment of a dotted `user_type`. */
const USER_TYPE_SEGMENT_NODE_TYPES: Readonly<Record<string, string>> = {
  kotlin: "identifier",
  swift: "type_identifier",
};

/**
 * The name segments of a Kotlin or Swift `user_type` that spells a dotted name (`Other.Base`), root first. Type arguments
 * are not segments; one between two segments makes the owner generic (`Outer<T>.Inner`), which proves no path.
 */
function dottedUserTypeSegments(
  sup: LanguageSupport,
  node: SyntaxNodeLike,
): { segments: SyntaxNodeLike[]; genericOwner: boolean } | null {
  const segmentType = USER_TYPE_SEGMENT_NODE_TYPES[sup.id];
  if (!segmentType || node.type !== "user_type") return null;
  const segments: SyntaxNodeLike[] = [];
  let genericOwner = false;
  let sawArguments = false;
  for (const child of node.namedChildren) {
    if (child.type === "type_arguments") {
      sawArguments = true;
      continue;
    }
    if (child.type !== segmentType) continue;
    if (sawArguments) genericOwner = true;
    segments.push(child);
  }
  return segments.length > 1 ? { segments, genericOwner } : null;
}

function peelTypeWrappers(node: SyntaxNodeLike): SyntaxNodeLike {
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (
      current.type === "type_annotation" ||
      current.type === "named_type" ||
      current.type === "user_type" ||
      current.type === "type" ||
      current.type === "parenthesized_type" ||
      current.type === "pointer_type" ||
      current.type === "reference_type" ||
      current.type === "optional_type" ||
      current.type === "nullable_type" ||
      current.type === "generic_type" ||
      current.type === "generic_name"
    ) {
      current = current.childForFieldName("type") ?? current.namedChildren[0] ?? null;
      continue;
    }
    break;
  }
  return current ?? node;
}

function isSimpleTypeNameNode(node: SyntaxNodeLike, sup: LanguageSupport): boolean {
  return isReceiverNameNode(sup, node.type) || node.type === "type_identifier" || node.type === "name";
}

function parseCppBaseType(node: SyntaxNodeLike, source: string): { base: string; path: string[] } | null {
  let current = node;
  while (
    current.type === "base_class_clause" ||
    current.type === "access_specifier" ||
    current.type === "virtual_specifier" ||
    current.type === "type_descriptor"
  ) {
    const nested = current.namedChildren.at(-1);
    if (!nested || nested.id === current.id) break;
    current = nested;
  }
  const names = cppQualifiedNameSegments(current, source);
  return names.length ? { base: names[0]!, path: names.slice(1) } : null;
}

/**
 * The names a qualified base spells, root first: `other` and `Base` for Python `other.Base`, `Outer`, `Inner`, and `Tool`
 * for Ruby `Outer::Inner::Tool`, `pkg` and `Base` for Go `pkg.Base`. Null when the spelling is no path of plain names
 * (a call, a subscript, a Ruby path without a constant root). The detailed graph and member navigation both read a
 * qualified base through this, so they resolve the same path.
 */
export function qualifiedBaseNames(sup: LanguageSupport, source: string, node: SyntaxNodeLike): string[] | null {
  if (sup.id === "go" && node.type === "qualified_type") {
    const packageName = node.childForFieldName("package");
    const name = node.childForFieldName("name");
    return packageName && name ? [sliceText(packageName, source), sliceText(name, source)] : null;
  }
  const chain = collectMemberAccessChain({ sup, source, chainNode: node });
  if (!chain || !isSimpleTypeNameNode(chain.base, sup) || !chain.names.length) return null;
  return [sliceText(chain.base, source), ...chain.names.toReversed()];
}

function collectDeclaredBaseTypes(
  container: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  index: ProjectIndex,
  mod: ModuleIndex,
  superclassOnly = false,
): DeclaredBaseType[] {
  const ancestry = MEMBER_ACCESS_ROWS[sup.id]?.receiverAncestry;
  if (!ancestry || (ancestry.clauses.length === 0 && !ancestry.mixinCalls?.length)) return [];
  const bases: DeclaredBaseType[] = [];
  const seen = new Set<string>();
  let usedFirstMatch = false;
  const addSimple = (name: string, node: SyntaxNodeLike): void => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    const kotlinEntry = sup.id === "kotlin" ? kotlinSupertypeEntry(node) : null;
    bases.push({ kind: "simple", name, at: node.startIndex, ...(kotlinEntry ? { kotlinEntry } : {}) });
  };
  const addQualified = (base: string, path: string[], node: SyntaxNodeLike, nameNode: SyntaxNodeLike = node): void => {
    if (!base || path.length === 0) return;
    const key = `${base}.${path.join(".")}`;

    if (seen.has(key)) return;
    seen.add(key);
    const kotlinEntry = sup.id === "kotlin" ? kotlinSupertypeEntry(nameNode) : null;
    bases.push(
      kotlinEntry ? { kind: "qualified", base, path, node, kotlinEntry } : { kind: "qualified", base, path, node },
    );
  };
  let sawUnproven = false;
  const addUnproven = (): void => {
    if (sawUnproven) return;
    sawUnproven = true;
    bases.push({ kind: "unproven" });
  };
  const collectType = (node: SyntaxNodeLike): void => {
    // A dotted Kotlin or Swift type reads through its qualifier; its first segment alone would name the qualifier.
    const dotted = dottedUserTypeSegments(sup, node);
    if (dotted) {
      const [root, ...path] = dotted.segments.map((segment) => sliceText(segment, source));
      if (dotted.genericOwner) addUnproven();
      else addQualified(root!, path, node, dotted.segments.at(-1)!);
      return;
    }
    const core = peelTypeWrappers(node);
    if (core.type === "constructor_invocation") {
      // Kotlin writes a superclass call as `Base(args)`: its callee is the base type, and its arguments are expressions.
      for (const child of core.namedChildren) {
        if (child.type === "value_arguments") continue;
        collectType(child);
      }
      return;
    }
    // A computed heritage expression can name the runtime base factory rather than a class.
    // Its descendants do not prove an inheritance edge.
    if (isUnprovenHeritageExpression(core)) return;
    if (sup.id === "cpp" && core.type === "base_class_clause") {
      for (const child of core.namedChildren) {
        if (child.type === "access_specifier" || child.type === "virtual_specifier") continue;
        collectType(child);
      }
      return;
    }
    if (sup.id === "cpp") {
      const qualified = parseCppBaseType(core, source);
      if (qualified) {
        if (qualified.path.length) addQualified(qualified.base, qualified.path, core);
        else addSimple(qualified.base, core);
        return;
      }
    }
    if (sup.id === "ruby" && core.type === "scope_resolution") {
      const reference = readRubyConstantReference(core, index, mod);
      if (!reference) {
        addUnproven();
        return;
      }
      const key = `ruby:${reference.anchor}:${reference.namespaces.join("/")}:${reference.names.join("::")}`;
      if (!seen.has(key)) {
        seen.add(key);
        bases.push({ kind: "ruby-constant", reference });
      }
      return;
    }
    const unwrapped = unwrapNamedType(core, sup);
    if (unwrapped) {
      addSimple(sliceText(unwrapped, source), unwrapped);
      return;
    }
    if (isMemberAccessNode(sup, core)) {
      const names = qualifiedBaseNames(sup, source, core);
      if (names) addQualified(names[0]!, names.slice(1), core);
      else addUnproven();
      return;
    }
    if (memberAccessTraversalTypes(sup).has(core.type)) return;
    for (const child of core.namedChildren) {
      if (child.type === "type_arguments") continue;
      collectType(child);
    }
  };
  const consider = (node: SyntaxNodeLike): void => {
    for (const rule of ancestry.clauses) {
      if (node.type !== rule.nodeType) continue;
      if (superclassOnly && !rule.supertype) continue;
      if (superclassOnly && rule.supertype === "first-match") {
        if (usedFirstMatch) continue;
        usedFirstMatch = true;
      }
      let target = node;
      if (superclassOnly && rule.supertype === "first-child") {
        target = target.namedChildren[0] ?? target;
      }
      collectType(target);
    }
    if (superclassOnly || node.type !== "call" || !ancestry.mixinCalls?.length) return;
    if (node.childForFieldName("receiver")) return;
    const methodNode = node.childForFieldName("method");
    const methodName = methodNode ? sliceText(methodNode, source) : undefined;
    if (!methodName || !ancestry.mixinCalls.includes(methodName)) return;
    const args = node.childForFieldName("arguments");
    if (args) collectType(args);
  };
  for (const child of container.namedChildren) {
    consider(child);
    for (const grand of child.namedChildren) consider(grand);
  }
  const unnamedBase = unnamedTypeBase(container, sup);
  if (unnamedBase?.proven) collectType(unnamedBase.node);
  return bases;
}

/**
 * The base type an unnamed type names in its own header: Java `new Base() { ... }` has no clause node, so
 * its creation's `type` field is the base. A creation that also names an enclosing instance
 * (`outer.new Inner() { ... }`) resolves that type inside the instance's class, which a bare name cannot prove.
 */
function unnamedTypeBase(
  container: SyntaxNodeLike,
  sup: LanguageSupport,
): { node: SyntaxNodeLike; proven: boolean } | null {
  const field = anonymousOwnerForm(sup.id, container.type)?.baseField;
  const node = field ? container.childForFieldName(field) : null;
  if (!node) return null;
  const namesEnclosingInstance = container.namedChildren.some(
    (child) => child.endIndex <= node.startIndex && child.type !== "type_arguments",
  );
  return { node, proven: !namesEnclosingInstance };
}

function asMemberContainer(index: ProjectIndex, def: SymbolDef): SymbolDef | undefined {
  return memberContainerForDefinition(index, def);
}

function importedMemberContainer(
  index: ProjectIndex,
  result: SymbolDef | { namespace: string } | null,
): SymbolDef | undefined {
  if (!result || "namespace" in result) return undefined;
  return asMemberContainer(index, result);
}

function resolveNamedMemberContainer(
  index: ProjectIndex,
  mod: ModuleIndex,
  name: string,
  normalize: (name: string) => string,
): SymbolDef | undefined {
  const typedLocals = memberDeclaringLocals(mod, name, normalize);
  const topLevel = typedLocals.filter((local) => !local.isMember);
  const candidates = topLevel.length ? topLevel : typedLocals;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return undefined;
  const normalizedName = normalize(name);

  const languageId = supportForFileWithoutHeaderSample(mod.file, index.languageExtensions)?.id;
  const explicitBinding = effectiveExplicitBinding(
    mod.imports,
    languageId ?? "",
    (binding) =>
      (binding.kind === "named" || binding.kind === "default") && normalize(binding.local) === normalizedName,
  );
  if (explicitBinding?.kind === "named") {
    const container = importedMemberContainer(index, resolveImported(index, explicitBinding, explicitBinding.imported));
    if (container) return container;
  } else if (explicitBinding?.kind === "default") {
    const container = importedMemberContainer(index, resolveImported(index, explicitBinding, "default"));
    if (container) return container;
  }
  if (languageId) {
    const starDecision = resolveStarImportedName(index, mod, languageId, name);
    if (starDecision.status === "ambiguous") return undefined;
    if (starDecision.status === "resolved") {
      const container = asMemberContainer(index, starDecision.definition);
      if (container) return container;
    }
  }
  const exported = resolveExport(index, mod.file, name, { allowLocalFallback: false });
  if (exported?.kind === "resolved") return asMemberContainer(index, exported.def);
  return undefined;
}

/**
 * The type a qualified base names, read through its qualifier: a module's export (Python, JavaScript, TypeScript), a
 * constant path (Ruby), a type nested in the body of another (Swift), or a C++ scope. A qualifier that proves nothing
 * leaves the base unresolved; the base's own last name is never looked up by itself.
 */
export async function resolveQualifiedMemberContainer(
  index: ProjectIndex,
  mod: ModuleIndex,
  baseName: string,
  path: readonly string[],
  normalize: (name: string) => string,
  sup: LanguageSupport,
  use?: { node: SyntaxNodeLike; source: string; tree: SyntaxTreeLike; scopeIndex?: ScopeIndex },
): Promise<SymbolDef | undefined> {
  if (path.length === 0) return undefined;
  if (sup.id === "cpp") {
    return (await resolveCppQualifiedMemberContainer(index, mod, [baseName, ...path])) ?? undefined;
  }
  if (sup.id === "ruby") {
    const reference: RubyConstantReference = { names: [baseName, ...path], anchor: "lexical", namespaces: [] };
    const definition = resolveRubyConstantReference(index, mod, reference);
    return definition ? asMemberContainer(index, definition) : undefined;
  }
  if (sup.id === "swift") {
    const owner = resolveNamedMemberContainer(index, mod, baseName, normalize);
    return owner ? await resolveSwiftNestedTypePath(index, owner, path) : undefined;
  }
  if (sup.id === "java" || sup.id === "kotlin") {
    // The first segment names a visible type (the rest are nested types) or, when it names none, a package.
    let root = resolveNamedMemberContainer(index, mod, baseName, normalize);
    if (!root) {
      const named = resolveNamedDefinition(index, mod, mod.file, sup, baseName);
      if (named?.status === "ok" && declaresMembers(named.definition)) root = named.definition;
    }
    return resolveJvmQualifiedPath(index, mod.file, sup.id, root ?? null, [baseName, ...path], true) ?? undefined;
  }
  if (sup.id === "python") {
    if (!use) return undefined;
    const chain = collectMemberAccessChain({ sup, source: use.source, chainNode: use.node });
    if (!chain || !isReceiverNameNode(sup, chain.base.type)) return undefined;
    const scope = use.scopeIndex ?? getOrBuildScopeIndex(index, mod.file, use.source, sup, mod, use.tree);
    const binding = pythonImportAtUse(mod, chain.base, use.source, use.tree, sup, scope);
    if (!binding || binding.kind !== "namespace") return undefined;
    const names = [baseName, ...path];
    for (let count = names.length - 1; count >= 1; count -= 1) {
      const moduleFile = pythonDottedPhraseAtUse(
        index,
        mod,
        chain.base,
        names.slice(0, count).join("."),
        use.source,
        use.tree,
        sup,
        scope,
      );
      if (moduleFile === undefined) continue;
      return moduleFile ? resolveExportPath(index, moduleFile, names.slice(count), sup) : undefined;
    }
    const file = isPythonDottedImportBinding(binding)
      ? pythonDottedImportPackageFile(index, binding)
      : binding.resolved;
    return typeof file === "string" ? resolveExportPath(index, file, path, sup) : undefined;
  }
  const namespaceImports = mod.imports.filter(
    (imp) => imp.kind === "namespace" && normalize(imp.localNS) === normalize(baseName),
  );
  if (namespaceImports.length !== 1) return undefined;
  const resolved = namespaceImports[0]!.resolved;
  return typeof resolved === "string" ? resolveExportPath(index, resolved, path, sup) : undefined;
}

/** The container `path` names when each part is an export of the module the part before it named, from `startFile`. */
function resolveExportPath(
  index: ProjectIndex,
  startFile: string,
  path: readonly string[],
  sup: LanguageSupport,
): SymbolDef | undefined {
  let file = startFile;
  for (let partIndex = 0; partIndex < path.length; partIndex += 1) {
    const part = path[partIndex]!;
    const last = partIndex === path.length - 1;
    // Go reaches another package through its exported names only.
    if (!isGoExportedMemberName(sup.id, part)) return undefined;
    const hit = resolveExport(index, file, part, { allowLocalFallback: false });
    if (!hit) return undefined;
    if (hit.kind === "namespace") {
      if (last) return undefined;
      file = hit.file;
      continue;
    }
    if (!last) return undefined;
    return asMemberContainer(index, hit.def);
  }
  return undefined;
}

/** Whether `child` of the heritage node `parent` can decide which base the clause names. */
function decidesHeritage(parent: SyntaxNodeLike, child: SyntaxNodeLike): boolean {
  // A type argument names a type in its own scope, and a keyword or splat argument names no base.
  if (child.type === "type_arguments" || isNonBaseHeritageArgument(child)) return false;
  // A Kotlin constructor call (`Base(args)`) names its base by its callee type; its arguments are expressions.
  const isConstructorCallArgument = parent.type === "constructor_invocation" && child.type === "value_arguments";
  return !isConstructorCallArgument;
}

function nodeContainsUnprovenHeritage(node: SyntaxNodeLike): boolean {
  if (isUnprovenHeritageExpression(node)) return true;
  return node.namedChildren.some((child) => decidesHeritage(node, child) && nodeContainsUnprovenHeritage(child));
}

/** A Java interface's static method is reachable through that interface alone; sub-interfaces and classes never inherit it. */
function isUninheritedJavaInterfaceStaticMethod(
  hit: SymbolDef,
  owner: KeywordClassRef,
  scope: ReceiverMemberScope | undefined,
): boolean {
  if (owner.context.sup.id !== "java" || owner.container.type !== "interface_declaration") return false;
  return hit.kind === SymbolKind.Function && scope === "static";
}

/** A heritage or mixin clause whose type expression is not a resolvable name, or a base that an enclosing instance qualifies. */
function containerHeritageIsUnproven(container: SyntaxNodeLike, source: string, sup: LanguageSupport): boolean {
  const ancestry = MEMBER_ACCESS_ROWS[sup.id]?.receiverAncestry;
  if (!ancestry) return false;
  const unnamedBase = unnamedTypeBase(container, sup);
  if (unnamedBase && !unnamedBase.proven) return true;
  const clauseTypes = new Set(ancestry.clauses.map((rule) => rule.nodeType));
  const nodes: SyntaxNodeLike[] = [];
  for (const child of container.namedChildren) {
    nodes.push(child);
    for (const grand of child.namedChildren) nodes.push(grand);
  }
  if (nodes.some((node) => clauseTypes.has(node.type) && nodeContainsUnprovenHeritage(node))) return true;
  const mixinCalls = ancestry.mixinCalls;
  if (!mixinCalls?.length) return false;
  return nodes.some((node) => {
    if (node.type !== "call" || node.childForFieldName("receiver")) return false;
    const methodNode = node.childForFieldName("method");
    const methodName = methodNode ? sliceText(methodNode, source) : undefined;
    if (!methodName || !mixinCalls.includes(methodName)) return false;
    const args = node.childForFieldName("arguments");
    return !!args && nodeContainsUnprovenHeritage(args);
  });
}

function definitionForContainer(mod: ModuleIndex, container: SyntaxNodeLike): SymbolDef | undefined {
  const nameNode = container.childForFieldName("name");
  if (!nameNode) return undefined;
  const matches = mod.locals.filter(
    (local) => declaresMembers(local) && local.range.start.index === nameNode.startIndex,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

async function resolveReceiverTypeName(
  index: ProjectIndex,
  mod: ModuleIndex,
  sup: LanguageSupport,
  typeName: string,
): Promise<SymbolDef | undefined> {
  const trimmed = typeName.trim().replace(/^\\+/, "");
  if (!trimmed) return undefined;
  const normalize = sup.normalizeIdentifier;
  for (const separator of ["::", "\\", "."]) {
    if (!trimmed.includes(separator)) continue;
    const parts = trimmed.split(separator).filter(Boolean);
    if (parts.length < 2) return undefined;
    return resolveQualifiedMemberContainer(index, mod, parts[0]!, parts.slice(1), normalize, sup);
  }
  return resolveNamedMemberContainer(index, mod, trimmed, normalize);
}

/** The name that starts a base's spelling and the node that spells it: the base itself, or the root of a qualified one. */
function heritageRoot(
  parsed: ParsedFileContext,
  base: DeclaredBaseType,
): { name: string; node: SyntaxNodeLike } | null {
  if (base.kind === "simple") {
    return { name: base.name, node: parsed.tree.rootNode.descendantForIndex(base.at, base.at + base.name.length) };
  }
  if (base.kind !== "qualified") return null;
  const chain = collectMemberAccessChain({ sup: parsed.sup, source: parsed.source, chainNode: base.node });
  return chain ? { name: base.base, node: chain.base } : null;
}

/**
 * A JavaScript or TypeScript heritage name can be a parameter or variable that holds the base class
 * (`(Base) => class extends Base { ... }`), and a qualified one can hang off such a value
 * (`(ns) => class extends ns.Base { ... }`). No declaration names that base, however a same-named class or
 * namespace import elsewhere in the module resolves, so it stays unproven.
 */
function heritageNameBoundToValue(
  index: ProjectIndex,
  mod: ModuleIndex,
  parsed: ParsedFileContext,
  base: DeclaredBaseType,
): boolean {
  if (!isJsTsLanguage(parsed.sup.id)) return false;
  const root = heritageRoot(parsed, base);
  if (!root) return false;
  const scope = getOrBuildScopeIndex(index, mod.file, parsed.source, parsed.sup, mod, parsed.tree);
  const binding = findClosestScopeBinding(scope, root.name, root.node, parsed.sup);
  return binding?.kind === "param" || binding?.kind === "local";
}

async function resolveDeclaredBase(
  index: ProjectIndex,
  mod: ModuleIndex,
  parsed: ParsedFileContext,
  base: DeclaredBaseType,
): Promise<SymbolDef | undefined> {
  const sup = parsed.sup;
  if (base.kind === "unproven") return undefined;
  if (heritageNameBoundToValue(index, mod, parsed, base)) return undefined;
  if (base.kind === "ruby-constant") {
    const constant = resolveRubyConstantReference(index, mod, base.reference);
    return constant ? asMemberContainer(index, constant) : undefined;
  }
  const normalize = sup.normalizeIdentifier;
  const named =
    base.kind === "simple"
      ? resolveNamedMemberContainer(index, mod, base.name, normalize)
      : await resolveQualifiedMemberContainer(index, mod, base.base, base.path, normalize, sup, {
          node: base.node,
          source: parsed.source,
          tree: parsed.tree,
        });
  if (!named || sup.id !== "swift") return named;
  return await swiftBaseDeclaration(index, named);
}

/**
 * True when `def` and every resolved supertype lack a direct `memberName`. An unresolved
 * supertype, an unreadable declaration, or a declared member returns false.
 */
async function hierarchyOmitsMember(
  index: ProjectIndex,
  def: SymbolDef,
  memberName: string,
  memberScope: ReceiverMemberScope,
  seen: Set<string>,
): Promise<boolean> {
  const containerDef = asMemberContainer(index, def);
  if (!containerDef) return false;
  const start = containerDef.range.start;
  const key = `${fileIdentityKey(containerDef.file)}:${start.index ?? `${start.line}:${start.column}`}`;
  if (seen.has(key)) return true;
  seen.add(key);
  const ref = await keywordClassRefFromDef(index, containerDef);
  if (!ref) return false;
  return containerOmitsMember(index, ref, memberName, memberScope, seen);
}

/** `hierarchyOmitsMember` for a declaration body already in hand: its own members, then every base. */
async function containerOmitsMember(
  index: ProjectIndex,
  ref: KeywordClassRef,
  memberName: string,
  memberScope: ReceiverMemberScope,
  seen: Set<string>,
): Promise<boolean> {
  const normalize = ref.context.sup.normalizeIdentifier;
  const memberPredicate =
    memberScope === "any"
      ? undefined
      : (local: SymbolDef) => matchesReceiverMemberScope(local, memberScope, ref.context, ref.container);
  if (
    findDirectLocalsWithinNode(ref.module.locals, memberName, ref.container, ref.context, normalize, memberPredicate)
      .length > 0
  ) {
    return false;
  }
  if (ref.context.sup.id === "csharp" || ref.context.sup.id === "swift") {
    const shared = await findSharedOwnerMemberDefinitions({
      index,
      ownerFile: ref.file,
      ownerContainer: ref.container,
      ownerSource: ref.context.source,
      languageId: ref.context.sup.id,
      member: memberName,
      memberScope,
    });
    if (shared.length > 0) return false;
  }
  if (containerHeritageIsUnproven(ref.container, ref.context.source, ref.context.sup)) return false;
  const bases = collectDeclaredBaseTypes(ref.container, ref.context.source, ref.context.sup, index, ref.module, false);
  for (const base of bases) {
    const baseDef = await resolveDeclaredBase(index, ref.module, ref.context, base);
    if (!baseDef) return false;
    if (!(await hierarchyOmitsMember(index, baseDef, memberName, memberScope, seen))) return false;
  }
  return true;
}

/**
 * A classified receiver (`new Widget()`, a named type, `this`, or `super`) excludes a failed
 * member lookup only when its type resolves to a member-declaring definition, no supertype is
 * unresolved, and that type does not declare `memberName`. Otherwise the site stays unproven.
 */
export async function provenClassifiedReceiverOmitsMember(
  index: ProjectIndex,
  fileId: string,
  parsed: ParsedFileContext,
  accessNode: SyntaxNodeLike,
  objectNode: SyntaxNodeLike,
  memberName: string,
): Promise<boolean> {
  const mod = index.byFile.get(fileIdentityKey(fileId));
  if (!mod) return false;
  const receiver = classifyReceiver(
    parsed.sup,
    objectNode,
    parsed.source,
    new Map(),
    accessNode.startIndex,
    accessNode,
    (callee) => {
      const scope = getOrBuildScopeIndex(index, fileId, parsed.source, parsed.sup, mod, parsed.tree);
      return !!findClosestScopeBinding(scope, sliceText(callee, parsed.source), callee, parsed.sup);
    },
  );
  if (receiver.kind === "unknown" || receiver.kind === "module-import") return false;
  if (receiver.kind === "named-type") {
    const def = await resolveReceiverTypeName(index, mod, parsed.sup, receiver.typeName);
    if (!def) return false;
    return hierarchyOmitsMember(index, def, memberName, receiver.memberScope, new Set());
  }
  const container = nearestMemberContainer(accessNode);
  if (!container) return false;
  if (receiver.kind === "supertype") {
    if (containerHeritageIsUnproven(container, parsed.source, parsed.sup)) return false;
    const bases = collectDeclaredBaseTypes(container, parsed.source, parsed.sup, index, mod, true);
    if (!bases.length) return false;
    const seen = new Set<string>();
    for (const base of bases) {
      const baseDef = await resolveDeclaredBase(index, mod, parsed, base);
      if (!baseDef) return false;
      if (!(await hierarchyOmitsMember(index, baseDef, memberName, receiver.memberScope, seen))) return false;
    }
    return true;
  }
  const def = definitionForContainer(mod, container);
  if (def) return hierarchyOmitsMember(index, def, memberName, receiver.memberScope, new Set());
  // An unnamed type body has no definition to start from: it omits the member when its own members and
  // every base do.
  if (!isAnonymousMemberContainer(parsed.sup.id, container)) return false;
  const ref = { file: mod.file, container, context: parsed, module: mod };
  return containerOmitsMember(index, ref, memberName, receiver.memberScope, new Set());
}

async function keywordClassRefFromDef(index: ProjectIndex, def: SymbolDef): Promise<KeywordClassRef | null> {
  const module = index.byFile.get(fileIdentityKey(def.file));
  if (!module) return null;
  const context = await ensureParsedContextForIndex(index, def.file);
  const start = def.range.start;
  const position = {
    row: start.line - 1,
    column: start.column - 1,
  };
  const nameNode = context.tree.rootNode.descendantForPosition(position, position);
  const container = nearestMemberContainer(nameNode);
  if (!container) return null;
  return { file: def.file, container, context, module };
}

async function keywordClassRefFromNode(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
): Promise<KeywordClassRef | null> {
  const context = await ensureParsedContextForIndex(index, mod.file);
  const memberNode = context.tree.rootNode.descendantForPosition(node.startPosition, node.startPosition);
  const container = findEnclosingClassContainer(memberNode);
  if (!container) return null;
  return { file: mod.file, container, context, module: mod };
}

function crossFilePeerMemberHidden(useFile: string, memberDef: SymbolDef, targetContext: ParsedFileContext): boolean {
  const languageId = targetContext.sup.id;
  if (languageId !== "java" && languageId !== "kotlin" && languageId !== "swift") return false;
  const start = memberDef.range.start;
  const position = toTreeSitterPosition(start);
  const nameNode = targetContext.tree.rootNode.descendantForPosition(position, position);
  if (!nameNode) return false;
  if (languageId === "swift") {
    return isSwiftCrossFileHiddenSharedOwnerMember(languageId, useFile, memberDef.file, nameNode);
  }
  if (fileIdentityKey(useFile) === fileIdentityKey(memberDef.file)) return false;
  return !isExportedDeclaration(languageId, nameNode);
}

async function baseRefsFromContainer(
  index: ProjectIndex,
  mod: ModuleIndex,
  container: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  superclassOnly: boolean,
  tree: SyntaxTreeLike,
): Promise<KeywordClassRef[]> {
  if (sup.id === "csharp") {
    const part = { file: mod.file, container, context: { source, tree, sup }, module: mod };
    const { parts } = await csharpTypeParts(index, part);
    // A class exposes its base class chain only; an interface also exposes the members of its base interfaces.
    if (container.type === "interface_declaration")
      return superclassOnly ? [] : await csharpInterfaceBaseRefs(index, parts);
    const base = await csharpBaseClassRef(index, parts);
    return base && base !== "unproven" ? [base] : [];
  }
  const bases = collectDeclaredBaseTypes(container, source, sup, index, mod, superclassOnly);
  const refs: KeywordClassRef[] = [];
  const seen = new Set<string>();
  const normalize = (name: string): string => {
    const normalized = sup.normalizeIdentifier(name);
    return sup.id === "php" ? foldPhpIdentifierCase(normalized) : normalized;
  };
  const parsed: ParsedFileContext = { source, tree, sup };
  for (const base of bases) {
    // An unreadable base contributes no members; the walk never substitutes another type for it.
    if (base.kind === "unproven") continue;
    if (heritageNameBoundToValue(index, mod, parsed, base)) continue;
    let def: SymbolDef | undefined;
    if (base.kind === "simple") {
      def = resolveNamedMemberContainer(index, mod, base.name, normalize);
    } else if (base.kind === "ruby-constant") {
      const constant = resolveRubyConstantReference(index, mod, base.reference);
      def = constant ? asMemberContainer(index, constant) : undefined;
    } else {
      def = await resolveQualifiedMemberContainer(index, mod, base.base, base.path, normalize, sup, {
        node: base.node,
        source,
        tree,
      });
    }
    if (!def && base.kind === "simple" && sup.id !== "php") {
      const scope = sup.id === "python" ? getOrBuildScopeIndex(index, mod.file, source, sup, mod, tree) : undefined;
      const named = resolveNamedDefinition(
        index,
        mod,
        mod.file,
        sup,
        base.name,
        undefined,
        container.startIndex,
        undefined,
        scope,
      );
      if (named?.status === "ok") def = asMemberContainer(index, named.definition);
    }
    if (!def && sup.id === "php" && base.kind === "simple") {
      def = resolvePhpNamespaceSymbol(index, source, tree, container, base.name, mod.imports, "class") ?? undefined;
    }
    if (def && sup.id === "swift") def = await swiftBaseDeclaration(index, def);
    if (!def) continue;
    const ref = await keywordClassRefFromDef(index, def);
    if (!ref) continue;
    // `super`, `base`, and `parent` follow class ancestors only. An own receiver also inherits
    // interface or protocol members, so apply the class-only filter only to supertype lookup.
    const interfaceLike =
      ref.container.type === "interface_declaration" ||
      ref.container.type === "protocol_declaration" ||
      ref.container.type === "trait_item" ||
      /^(?:interface|protocol|trait)\b/.test(sliceText(ref.container, ref.context.source).trimStart());
    if (superclassOnly && (def.kind !== SymbolKind.Class || interfaceLike)) continue;
    // Kotlin classifies interfaces as SymbolKind.Class too, so its superclass is the entry written as a constructor
    // call (`Base()`) or, in a class that declares only secondary constructors, a bare entry whose declaration is a
    // class. Every other bare entry is an interface or not a whole type name: it never answers `super`, while an own
    // receiver still inherits interface default members.
    const kotlinEntry = base.kind === "ruby-constant" ? undefined : base.kotlinEntry;
    const isBareKotlinClass =
      kotlinEntry === "bare" && kotlinMayNameClassBare(container) && declaredSupertypeKind(ref.container) === "class";
    if (superclassOnly && sup.id === "kotlin" && kotlinEntry !== "invoked" && !isBareKotlinClass) continue;
    const key = definitionIdentityKey(def);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/** What a hierarchy member walk saw, for callers that must not fall back past it. */
type KeywordMemberReport = { named: boolean; ambiguous: boolean };

async function resolveKeywordReceiverMember(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  member: string,
  memberScope: ReceiverMemberScope,
  startAtAncestor: boolean,
  knownArgumentCount?: number,
  explicitClassDef?: SymbolDef,
  report?: KeywordMemberReport,
): Promise<SymbolDef | undefined> {
  const current = explicitClassDef
    ? await keywordClassRefFromDef(index, explicitClassDef)
    : await keywordClassRefFromNode(index, mod, node);
  if (!current) return undefined;
  const spansHierarchy = inheritsMemberOverloads(current.context.sup.id);
  const ownerKey = (ref: KeywordClassRef): string => keywordContainerKey(ref.file, ref.container);
  const preloadHiddenNames = isJsTsLanguage(current.context.sup.id) && knownArgumentCount !== undefined;
  const memberKey = (def: SymbolDef): string => `${fileIdentityKey(def.file)}:${def.range.start.index}`;
  const parentsByKey = new Map<string, KeywordClassRef[]>();
  const membersByKey = new Map<string, SymbolDef[]>();
  const scopeByMember = new Map<SymbolDef, ReceiverMemberScope>();
  const visible = new Set<SymbolDef>();
  let level: KeywordClassRef[] = [current];
  const seen = new Set<string>([ownerKey(current)]);
  for (let depth = 0; depth < RECEIVER_HIERARCHY_DEPTH && level.length; depth += 1) {
    const next: KeywordClassRef[] = [];
    let nameFound = false;
    for (const ref of level) {
      const key = ownerKey(ref);
      const matches: SymbolDef[] = [];
      if (!startAtAncestor || depth) {
        appendDirectKeywordMembers(
          ref.module.locals,
          member,
          ref.container,
          ref.context,
          ref.context.sup.normalizeIdentifier,
          undefined,
          matches,
        );
        if (isJsTsLanguage(ref.context.sup.id) && ref.container.type === "interface_declaration") {
          const owner = memberContainerDef(ref.module, ref.container);
          if (owner) {
            for (const hit of typescriptMergedInterfaceMemberCandidates(
              ref.module.locals,
              member,
              owner,
              ref.container,
              ref.context,
              ref.context.sup.normalizeIdentifier,
              undefined,
            )) {
              if (!matches.includes(hit)) matches.push(hit);
            }
          }
        }
        if (ref.context.sup.id === "csharp" || ref.context.sup.id === "swift") {
          const shared = await resolveSharedOwnerContainers({
            index,
            ownerFile: ref.file,
            ownerContainer: ref.container,
            ownerSource: ref.context.source,
            languageId: ref.context.sup.id,
          });
          for (const peer of shared) {
            const peerMatches: SymbolDef[] = [];
            appendDirectKeywordMembers(
              peer.module.locals,
              member,
              peer.container,
              peer.context,
              peer.context.sup.normalizeIdentifier,
              undefined,
              peerMatches,
            );
            for (const hit of peerMatches) {
              if (peer.context.sup.id === "swift" && crossFilePeerMemberHidden(mod.file, hit, peer.context)) continue;
              matches.push(hit);
              scopeByMember.set(hit, hasStaticModifier(hit, peer.context, peer.container) ? "static" : "instance");
            }
          }
        }
      }
      membersByKey.set(key, matches);
      for (const hit of matches) {
        if (!scopeByMember.has(hit)) {
          scopeByMember.set(hit, hasStaticModifier(hit, ref.context, ref.container) ? "static" : "instance");
        }
        if (spansHierarchy && (startAtAncestor || depth) && (await isUninheritedPrivateMember(index, mod, node, hit))) {
          continue;
        }
        if (depth && isUninheritedJavaInterfaceStaticMethod(hit, ref, scopeByMember.get(hit))) continue;
        visible.add(hit);
        nameFound = true;
      }
      if (nameFound && !spansHierarchy && !preloadHiddenNames) continue;
      const bases = await baseRefsFromContainer(
        index,
        ref.module,
        ref.container,
        ref.context.source,
        ref.context.sup,
        startAtAncestor,
        ref.context.tree,
      );
      parentsByKey.set(key, bases);
      for (const base of bases) {
        const baseKey = ownerKey(base);
        if (seen.has(baseKey)) continue;
        seen.add(baseKey);
        next.push(base);
      }
    }
    if (nameFound && !spansHierarchy && !preloadHiddenNames) break;
    level = next;
  }
  const sameSignatures = new Map<string, Set<string>>();
  if (spansHierarchy) {
    const all = [...membersByKey.values()].flat().filter((candidate) => visible.has(candidate));
    for (let left = 0; left < all.length; left += 1) {
      for (let right = left + 1; right < all.length; right += 1) {
        const a = all[left]!;
        const b = all[right]!;
        if (!(await sameParameterTypes(index, a, b))) continue;
        const aKey = memberKey(a);
        const bKey = memberKey(b);
        const identical = sameSignatures.get(aKey) ?? new Set<string>();
        identical.add(bKey);
        sameSignatures.set(aKey, identical);
      }
    }
  }
  const model: MemberModel<KeywordClassRef, SymbolDef> = {
    ownerKey,
    members: (ref) => membersByKey.get(ownerKey(ref)) ?? [],
    supertypes: (ref) => parentsByKey.get(ownerKey(ref)) ?? [],
    name: (def) => def.localName,
    key: (def) => def.callable?.key ?? memberKey(def),
    callable: (def) => {
      const facts = def.callable;
      if (!facts || memberLookupBinding(current.context.sup.id) !== "unbound") return facts;
      return facts.unboundArity ? { ...facts, arity: facts.unboundArity } : facts;
    },
    scope: (def) => scopeByMember.get(def) ?? "any",
    visible: (def) => visible.has(def),
    sameSignature: (a, b) => sameSignatures.get(memberKey(a))?.has(memberKey(b)) ?? false,
  };
  const selected = selectMember([current], model, {
    name: member,
    argumentCount: knownArgumentCount ?? null,
    scope: memberScope,
    useFile: mod.file,
    startAtAncestor,
    keepUniqueArityMismatch: !startAtAncestor,
    inheritOverloads: spansHierarchy,
    phpCaseInsensitive: current.context.sup.id === "php",
    normalizeIdentifier: current.context.sup.id === "swift" ? current.context.sup.normalizeIdentifier : undefined,
    separateMemberScopes: hasSeparateMemberScopes(current.context.sup.id),
  });
  if (report) {
    report.named = selected.named;
    report.ambiguous = selected.status === "ambiguous";
  }
  return selected.status === "unique" ? selected.member : undefined;
}

/** The parameter list of a Java, Kotlin, or C# method declaration. */
async function memberParameterList(index: ProjectIndex, def: SymbolDef): Promise<SyntaxNodeLike | null> {
  const context = await ensureParsedContextForIndex(index, def.file).catch(ignoreQueryParseFailure);
  const start = def.range.start.index;
  if (!context || start === undefined) return null;
  const declaration = context.tree.rootNode.descendantForIndex(start, def.range.end.index ?? start).parent;
  return (
    declaration?.childForFieldName("parameters") ??
    declaration?.namedChildren.find((child) => child.type === "function_value_parameters") ??
    null
  );
}

/** Parameter type texts of a Java, Kotlin, or C# method; null when a type cannot be read. */
async function memberParameterTypes(index: ProjectIndex, def: SymbolDef): Promise<string[] | null> {
  const parameters = await memberParameterList(index, def);
  if (!parameters) return null;
  const types: string[] = [];
  for (const parameter of parameters.namedChildren) {
    const type = parameter.childForFieldName("type") ?? parameter.namedChildren.at(-1);
    if (!type) return null;
    types.push(type.text.replace(/\s+/g, ""));
  }
  return types;
}

/** The import that binds a type name in a module, as text; empty when no import binds it. */
function importedTypeSource(module: ModuleIndex, name: string): string {
  for (const imp of module.imports) {
    if (imp.kind !== "named" || imp.local !== name) continue;
    const target = typeof imp.resolved === "string" ? imp.resolved : (imp.resolved?.external ?? "");
    return `${target}:${imp.imported}`;
  }
  return "";
}

/** Type parameter names declared by a method or any type enclosing it. */
async function typeParameterNamesAround(index: ProjectIndex, def: SymbolDef): Promise<Set<string>> {
  const names = new Set<string>();
  const context = await ensureParsedContextForIndex(index, def.file).catch(ignoreQueryParseFailure);
  const start = def.range.start.index;
  if (!context || start === undefined) return names;
  let current: SyntaxNodeLike | null = context.tree.rootNode.descendantForIndex(start, def.range.end.index ?? start);
  for (; current; current = current.parent) {
    const parameters =
      current.childForFieldName("type_parameters") ??
      current.namedChildren.find((child) => child.type === "type_parameters" || child.type === "type_parameter_list");
    if (!parameters) continue;
    for (const parameter of parameters.namedChildren) {
      const name =
        parameter.childForFieldName("name") ??
        parameter.namedChildren.find((child) => /identifier/u.test(child.type)) ??
        (/identifier/u.test(parameter.type) ? parameter : null);
      if (name) names.add(name.text);
    }
  }
  return names;
}

/** Built-in parameter types whose spelling names one type in every file. */
const BUILTIN_PARAMETER_TYPES: Readonly<Record<string, ReadonlySet<string>>> = {
  java: new Set([
    "int",
    "long",
    "short",
    "byte",
    "char",
    "boolean",
    "float",
    "double",
    "String",
    "Object",
    "Integer",
    "Long",
    "Boolean",
    "Double",
    "Float",
    "Short",
    "Byte",
    "Character",
  ]),
  kotlin: new Set(["Int", "Long", "Short", "Byte", "Char", "Boolean", "Float", "Double", "String", "Any", "Unit"]),
  csharp: new Set([
    "int",
    "long",
    "short",
    "byte",
    "char",
    "bool",
    "float",
    "double",
    "decimal",
    "string",
    "object",
    "uint",
    "ulong",
    "ushort",
    "sbyte",
  ]),
};

/**
 * Whether two methods take the same parameter types, so the one in a derived class overrides the
 * other. Equal spelling is proof only within one file or for built-in types; elsewhere each
 * spelling must resolve to the same declaration from its own file.
 */
export async function sameParameterTypes(index: ProjectIndex, left: SymbolDef, right: SymbolDef): Promise<boolean> {
  // A type parameter (`T`) names a different type in each declaration after substitution, so
  // equal spelling proves nothing.
  const [leftGenerics, rightGenerics] = await Promise.all([
    typeParameterNamesAround(index, left),
    typeParameterNamesAround(index, right),
  ]);
  const [leftTypes, rightTypes] = await Promise.all([
    memberParameterTypes(index, left),
    memberParameterTypes(index, right),
  ]);
  if (!leftTypes || !rightTypes || leftTypes.length !== rightTypes.length) return false;
  const sameFile = fileIdentityKey(left.file) === fileIdentityKey(right.file);
  const leftContext = await ensureParsedContextForIndex(index, left.file).catch(ignoreQueryParseFailure);
  if (!leftContext) return false;
  for (let at = 0; at < leftTypes.length; at += 1) {
    const text = leftTypes[at]!;
    if (text !== rightTypes[at]) return false;
    const typeNames = text.match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? [];
    if (typeNames.some((typeName) => leftGenerics.has(typeName) || rightGenerics.has(typeName))) return false;
    // One Java or Kotlin file declares one package; a C# file can open several namespaces, so the
    // same spelling there still needs resolution.
    if (sameFile && leftContext.sup.id !== "csharp") continue;
    const base =
      text
        .replace(/<.*$/su, "")
        .replace(/[?\[\].]+$/u, "")
        .split(".")
        .pop() ?? text;
    if (BUILTIN_PARAMETER_TYPES[leftContext.sup.id]?.has(base)) continue;
    const rightContext = await ensureParsedContextForIndex(index, right.file).catch(ignoreQueryParseFailure);
    const leftModule = index.byFile.get(fileIdentityKey(left.file));
    const rightModule = index.byFile.get(fileIdentityKey(right.file));
    if (!rightContext || !leftModule || !rightModule) return false;
    // Resolve at each declaration so a C# spelling reads its own namespace region.
    const leftType = resolveNamedDefinition(
      index,
      leftModule,
      left.file,
      leftContext.sup,
      base,
      undefined,
      left.range.start.index,
    );
    const rightType = resolveNamedDefinition(
      index,
      rightModule,
      right.file,
      rightContext.sup,
      base,
      undefined,
      right.range.start.index,
    );
    if (leftType?.status !== "ok" && rightType?.status !== "ok") {
      // Neither names a project type: both files must name it through the same import (or none).
      if (importedTypeSource(leftModule, base) !== importedTypeSource(rightModule, base)) return false;
      continue;
    }
    if (leftType?.status !== "ok" || rightType?.status !== "ok") return false;
    if (
      fileIdentityKey(leftType.definition.file) !== fileIdentityKey(rightType.definition.file) ||
      leftType.definition.range.start.index !== rightType.definition.range.start.index
    ) {
      return false;
    }
  }
  return true;
}
/**
 * Validate an unqualified member use against its actual lexical owner, including shared
 * owner parts in other files and inherited members. Swift checks every bare name; C#, Java, and
 * Kotlin check only bare call callees. A static context reaches only static members.
 */
/** The callee of a receiverless call (`f()`), which may name a member through the implicit `this`. */
export function implicitSelfCallee(languageId: string, call: SyntaxNodeLike): SyntaxNodeLike | null {
  if (languageId === "csharp") return call.type === "invocation_expression" ? call.childForFieldName("function") : null;
  if (languageId === "java") {
    if (call.type !== "method_invocation" || call.childForFieldName("object")) return null;
    return call.childForFieldName("name");
  }
  if (languageId === "kotlin") return call.type === "call_expression" ? (call.namedChildren[0] ?? null) : null;
  return null;
}

export async function resolveImplicitSelfMember(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  name: string,
  source: string,
  languageId: string,
): Promise<SymbolDef | null | undefined> {
  const call = node.parent ?? node;
  if (languageId !== "swift" && implicitSelfCallee(languageId, call)?.id !== node.id) return undefined;
  const argumentCount = getCallArgumentCount({ languageId, source, call }) ?? undefined;
  // An unnamed type body (`new Base() { ... }`) sees its own hierarchy first; a name that hierarchy lacks
  // belongs to the enclosing owner, innermost first, so each hop runs from the container it just left.
  let anchor = node;
  for (;;) {
    const resolved = await resolveImplicitSelfAt(index, mod, anchor, name, source, languageId, argumentCount);
    if (resolved !== undefined) return resolved;
    const container = nearestMemberContainer(anchor);
    if (!container || !isAnonymousMemberContainer(languageId, container)) return undefined;
    anchor = container;
  }
}

/** The implicit-`this` member lookup in the owner that lexically encloses `anchor`; `undefined` leaves the name open. */
async function resolveImplicitSelfAt(
  index: ProjectIndex,
  mod: ModuleIndex,
  anchor: SyntaxNodeLike,
  name: string,
  source: string,
  languageId: string,
  argumentCount: number | undefined,
): Promise<SymbolDef | null | undefined> {
  const jvm = languageId === "java" || languageId === "kotlin";
  const staticScoped = languageId === "csharp" || jvm;
  const memberScope: ReceiverMemberScope = staticScoped && nodeInStaticMemberContext(anchor, source) ? "static" : "any";
  const report = { named: false, ambiguous: false };
  const member = await resolveKeywordReceiverMember(
    index,
    mod,
    anchor,
    name,
    memberScope,
    false,
    argumentCount,
    undefined,
    report,
  );
  if (member) return member;
  // Two inherited overloads of one arity are ambiguous without type ranking; in Java and C# any
  // inherited method of that name hides imports even when none accepts the call.
  if (report.ambiguous || (report.named && (languageId === "java" || languageId === "csharp"))) return null;
  if (memberScope !== "static" || !jvm) return undefined;
  // In a static context an inherited instance method still shadows a static import or package
  // function; the call is invalid, so it has no target.
  const instanceReport = { named: false, ambiguous: false };
  const instance = await resolveKeywordReceiverMember(
    index,
    mod,
    anchor,
    name,
    "any",
    false,
    argumentCount,
    undefined,
    instanceReport,
  );
  // Any inherited instance method of that name hides the import, even when none applies.
  return instance || instanceReport.named ? null : undefined;
}

/**
 * What C# simple-name lookup finds for the name of a using alias before it reaches the alias: a member of an
 * enclosing type (its own, a `partial` part's, or a non-private one inherited from a base class), or nothing. `member`
 * carries the one member found, `null` when no unique applicable member exists. `unproven` means a project base or
 * `partial` part cannot be inspected. External base members are outside the index.
 */
export type CsharpAliasMemberLookup =
  | { status: "member"; member: SymbolDef | null }
  | { status: "unproven" }
  | { status: "none" };

/** One C# type: its own declaration and its other `partial` parts, and whether the peer scan proves them all. */
async function csharpTypeParts(
  index: ProjectIndex,
  ref: KeywordClassRef,
): Promise<{ parts: KeywordClassRef[]; complete: boolean }> {
  const identity = getSharedOwnerIdentity(ref.container, ref.context.source, "csharp", ref.file);
  if (!identity) return { parts: [ref], complete: true };
  const peers = await resolveSharedOwnerContainers({
    index,
    ownerFile: ref.file,
    ownerContainer: ref.container,
    ownerSource: ref.context.source,
    languageId: "csharp",
  });
  const complete = !!identity.fileLocalTo || getCompilationUnitPeers(index, ref.file).complete;
  return { parts: [ref, ...peers], complete };
}

/** Every primary-constructor parameter of one C# type part, as a variable definition. */
function csharpPrimaryParameters(part: KeywordClassRef): SymbolDef[] {
  const { container, context, module, file } = part;
  const list = container.namedChildren.find((child) => child.type === "parameter_list");
  const parameters: SymbolDef[] = [];
  for (const parameter of list?.namedChildren ?? []) {
    const nameNode = parameter.childForFieldName("name");
    if (!nameNode) continue;
    const declared = module.locals.find((local) => local.range.start.index === nameNode.startIndex);
    const kind = SymbolKind.Variable;
    parameters.push(
      declared ?? { file, localName: sliceText(nameNode, context.source), kind, range: toRange(nameNode) },
    );
  }
  return parameters;
}

/**
 * The primary-constructor parameters of one C# type part named `name`. A record's become properties that derived
 * records inherit; a class's or struct's are in scope only in that type's own body.
 */
function csharpPrimaryParametersNamed(part: KeywordClassRef, name: string, inherited: boolean): SymbolDef[] {
  if (inherited && part.container.type !== "record_declaration") return [];
  const normalize = part.context.sup.normalizeIdentifier;
  const wanted = normalize(name);
  return csharpPrimaryParameters(part).filter((parameter) => normalize(parameter.localName) === wanted);
}

/**
 * The members named `name` that the parts of one type declare, nested types and primary-constructor parameters
 * included; a derived type reaches only the non-private ones.
 */
function csharpPartMembersNamed(
  parts: readonly KeywordClassRef[],
  name: string,
  inherited: boolean,
  typeOnly: boolean,
): SymbolDef[] {
  const members: SymbolDef[] = [];
  for (const part of parts) {
    const { container, context, module } = part;
    const normalize = context.sup.normalizeIdentifier;
    for (const member of findDirectLocalsWithinNode(module.locals, name, container, context, normalize)) {
      if (typeOnly && !declaresMembers(member)) continue;
      const nameNode = nameNodeForDef(context, member);
      if (declaresMembers(member)) {
        const generic = nameNode?.parent?.namedChildren.some((child) => child.type === "type_parameter_list");
        if (generic) continue;
      }
      if (inherited && nameNode && isPrivateDeclaration(context.sup.id, nameNode)) continue;
      members.push(member);
    }
    if (!typeOnly) members.push(...csharpPrimaryParametersNamed(part, name, inherited));
  }
  return members;
}

/** A C# base through positioned namespace-aware lookup; only unreadable project state is unproven. */
async function csharpDeclaredBaseRef(
  index: ProjectIndex,
  part: KeywordClassRef,
  baseNode: SyntaxNodeLike,
): Promise<KeywordClassRef | null | "unproven"> {
  const { module, context, file } = part;
  try {
    const scopeIndex = getOrBuildScopeIndex(index, file, context.source, context.sup, module, context.tree);
    const typeNode =
      baseNode.type === "primary_constructor_base_type" ? (baseNode.namedChildren[0] ?? baseNode) : baseNode;
    const core = peelTypeWrappers(typeNode);
    let def: SymbolDef | null = null;
    if (csharpQualifiedNameNode(typeNode)) {
      if (csharpQualifiedThroughGenericOwner(typeNode)) return "unproven";
      const files = createLoadingParsedFileProvider(index, { file, parsed: context });
      def = await withParsedFiles(files, () =>
        resolveCsharpQualifiedReceiverType(index, module, typeNode, context.source, scopeIndex, files),
      );
    } else {
      const resolved = resolveNamedDefinition(
        index,
        module,
        file,
        context.sup,
        sliceText(core, context.source),
        undefined,
        core.startIndex,
        undefined,
        scopeIndex,
      );
      if (resolved?.status === "not_found" && isAmbiguousResolutionReason(resolved.reason)) return "unproven";
      if (resolved?.status === "ok") def = resolved.definition;
    }
    if (!def) return csharpProjectDeclarationsUnknown(index, module) ? "unproven" : null;
    if (def.kind !== SymbolKind.Class && def.kind !== SymbolKind.Interface) return "unproven";
    return (await keywordClassRefFromDef(index, def)) ?? "unproven";
  } catch (error) {
    rethrowStaleQuerySource(error);
    return "unproven";
  }
}

/**
 * Only project-declared base classes participate. An external base has no visible members in the index.
 * A class lists its base class first; an unreadable project base or incomplete declaration remains unproven.
 */
async function csharpBaseClassRef(
  index: ProjectIndex,
  parts: readonly KeywordClassRef[],
): Promise<KeywordClassRef | null | "unproven"> {
  let baseClass: KeywordClassRef | null = null;
  for (const part of parts) {
    const { container, context } = part;
    // A struct or enum has no base class: its base list names interfaces or an underlying type.
    if (container.type === "struct_declaration" || container.type === "enum_declaration") continue;
    const baseList = container.namedChildren.find((child) => child.type === "base_list");
    if (!baseList?.namedChildren.length) continue;
    // An interface inherits the members of its base interfaces; that walk is not modeled.
    if (container.type === "interface_declaration") return "unproven";
    if (containerHeritageIsUnproven(container, context.source, context.sup)) return "unproven";
    const baseNode = baseList.namedChildren[0]!;
    const base = await csharpDeclaredBaseRef(index, part, baseNode);
    if (base === "unproven") return "unproven";
    if (!base) continue;
    if (base.container.type === "interface_declaration") continue;
    if (baseClass) {
      const sameClass =
        keywordContainerKey(base.file, base.container) === keywordContainerKey(baseClass.file, baseClass.container);
      if (!sameClass) return "unproven";
    }
    baseClass = base;
  }
  return baseClass;
}

/**
 * The project-declared interfaces a C# interface extends, across its `partial` parts. One unreadable, ambiguous, or
 * unprovable entry leaves the walk empty instead of guessing among the others; `csharpBaseClassRef` keeps an interface
 * container unproven for alias binding, so an inherited interface member never hides an alias.
 */
async function csharpInterfaceBaseRefs(
  index: ProjectIndex,
  parts: readonly KeywordClassRef[],
): Promise<KeywordClassRef[]> {
  const refs: KeywordClassRef[] = [];
  for (const part of parts) {
    const baseList = part.container.namedChildren.find((child) => child.type === "base_list");
    if (!baseList) continue;
    if (containerHeritageIsUnproven(part.container, part.context.source, part.context.sup)) return [];
    for (const baseNode of baseList.namedChildren) {
      const base = await csharpDeclaredBaseRef(index, part, baseNode);
      if (base === "unproven") return [];
      if (base?.container.type === "interface_declaration") refs.push(base);
    }
  }
  return refs;
}

/**
 * Enclosing-member lookup, excluding values in type positions. Calls check the whole project base chain before
 * shared overload selection; a non-call name stops at the nearest declaring type.
 */
async function csharpTypeChainMembersNamed(
  index: ProjectIndex,
  start: KeywordClassRef,
  name: string,
  typeOnly: boolean,
  call: boolean,
): Promise<SymbolDef[] | "unproven"> {
  const seen = new Set<string>();
  let nearest: SymbolDef[] = [];
  let current: KeywordClassRef | null = start;
  for (let depth = 0; current; depth += 1) {
    const key = keywordContainerKey(current.file, current.container);
    if (depth >= RECEIVER_HIERARCHY_DEPTH || seen.has(key)) return "unproven";
    seen.add(key);
    const { parts, complete } = await csharpTypeParts(index, current);
    const members = csharpPartMembersNamed(parts, name, depth > 0, typeOnly);
    if (members.length) {
      const hidesBaseOverloads = !call || members.some((member) => member.kind !== SymbolKind.Function);
      if (hidesBaseOverloads) return nearest.length ? nearest : members;
      if (!nearest.length) nearest = members;
    }
    if (!complete) return "unproven";
    const baseClass = await csharpBaseClassRef(index, parts);
    if (baseClass === "unproven") return "unproven";
    current = baseClass;
  }
  return nearest;
}

/**
 * What an enclosing C# type receives from outside its own declaration: the members of its other `partial` parts and
 * the non-private ones its project base classes declare. One chain per owner declaration is built once per index,
 * from names only, so reading a root name costs map lookups instead of a peer scan and a base walk.
 */
type CsharpOwnerMember = {
  def: SymbolDef;
  /** A nested type a bare name can bind; a generic one cannot and is never listed. */
  type: boolean;
  /** A private member is not inherited by a derived type. */
  inheritable: boolean;
  /** A field or property typed by a type of its own name (`Color Color`), which C# lets name that type too. */
  sameNamedType: boolean;
};

type CsharpOwnerPartMembers = ReadonlyMap<string, readonly CsharpOwnerMember[]>;

/** The owner's own type, then each project base class; each level holds the members of every part of one type. */
type CsharpOwnerChain = readonly (readonly CsharpOwnerPartMembers[])[];

type CsharpOwnerCache = {
  source: ProjectIndex["byFile"];
  size: number;
  /** `null` for an owner that nothing outside its own declaration can give a member. */
  chains: Map<string, CsharpOwnerChain | null>;
  pending: Map<string, Promise<CsharpOwnerChain | null>>;
  parts: Map<string, CsharpOwnerPartMembers>;
};

const csharpOwnerCaches = new WeakMap<ProjectIndex, CsharpOwnerCache>();

function csharpOwnerCache(index: ProjectIndex): CsharpOwnerCache {
  const cached = csharpOwnerCaches.get(index);
  if (cached && cached.source === index.byFile && cached.size === index.byFile.size) return cached;
  const fresh: CsharpOwnerCache = {
    source: index.byFile,
    size: index.byFile.size,
    chains: new Map(),
    pending: new Map(),
    parts: new Map(),
  };
  csharpOwnerCaches.set(index, fresh);
  return fresh;
}

/** Whether anything outside an owner's own declaration can give it members: another `partial` part or a base class. */
function csharpOwnerMayHaveOuterMembers(container: SyntaxNodeLike): boolean {
  let hasBaseList = false;
  for (const child of container.namedChildren) {
    if (child.type === "modifier" && child.text === "partial") return true;
    if (child.type === "base_list" && child.namedChildren.length) hasBaseList = true;
  }
  // A struct lists no base class, an interface's bases are not modeled, and an enum has none.
  const hasNoBaseClass =
    container.type === "struct_declaration" ||
    container.type === "interface_declaration" ||
    container.type === "enum_declaration";
  return hasBaseList && !hasNoBaseClass;
}

/** The type declarations whose body holds `node`, innermost first: a base list or an attribute is not in the body. */
function csharpEnclosingOwners(node: SyntaxNodeLike): SyntaxNodeLike[] {
  const owners: SyntaxNodeLike[] = [];
  for (let owner = nearestMemberContainer(node); owner; owner = nearestMemberContainer(owner)) {
    const body = owner.childForFieldName("body");
    if (body && body.startIndex <= node.startIndex && node.endIndex <= body.endIndex) owners.push(owner);
  }
  return owners;
}

/** `directLocalsWithinNode` stops at a nested class, interface, or enum, but not at a nested struct or record. */
function declaredInNestedValueType(nameNode: SyntaxNodeLike, container: SyntaxNodeLike): boolean {
  for (let current = nameNode.parent?.parent; current && current !== container; current = current.parent) {
    if (current.type === "struct_declaration" || current.type === "record_declaration") return true;
  }
  return false;
}

/** A field or property whose declared type has its own name (`Color Color`), which C# lets name that type as well. */
function csharpSameNamedTypeMember(def: SymbolDef, nameNode: SyntaxNodeLike, context: ParsedFileContext): boolean {
  if (def.kind !== SymbolKind.Variable) return false;
  let declaration = nameNode.parent;
  if (declaration?.type === "variable_declarator") declaration = declaration.parent;
  const typeNode = declaration ? declaredTypeNameNode(declaration, context.sup) : null;
  if (!typeNode) return false;
  const typeName = qualifiedDeclaredTypeText(typeNode, context.source).split(/[.:]/u).at(-1);
  const normalize = context.sup.normalizeIdentifier;
  return !!typeName && normalize(typeName) === normalize(def.localName);
}

/** Every member one part of a C# type declares, by normalized name. */
function csharpPartMemberTable(part: KeywordClassRef): CsharpOwnerPartMembers {
  const { container, context, module } = part;
  const normalize = context.sup.normalizeIdentifier;
  const table = new Map<string, CsharpOwnerMember[]>();
  const add = (def: SymbolDef, member: Omit<CsharpOwnerMember, "def">): void => {
    const key = normalize(def.localName);
    const entry = { def, ...member };
    const members = table.get(key);
    if (members) members.push(entry);
    else table.set(key, [entry]);
  };
  for (const def of directLocalsWithinNode(module.locals, container, context, () => true)) {
    const nameNode = nameNodeForDef(context, def);
    if (!nameNode || declaredInNestedValueType(nameNode, container)) continue;
    const type = declaresMembers(def);
    if (type && nameNode.parent?.namedChildren.some((child) => child.type === "type_parameter_list")) continue;
    add(def, {
      type,
      inheritable: !isPrivateDeclaration(context.sup.id, nameNode),
      sameNamedType: csharpSameNamedTypeMember(def, nameNode, context),
    });
  }
  for (const def of csharpPrimaryParameters(part)) {
    add(def, { type: false, inheritable: container.type === "record_declaration", sameNamedType: false });
  }
  return table;
}

async function buildCsharpOwnerChain(
  index: ProjectIndex,
  owner: KeywordClassRef,
  cache: CsharpOwnerCache,
): Promise<CsharpOwnerChain | null> {
  if (!csharpOwnerMayHaveOuterMembers(owner.container)) return null;
  const levels: (readonly CsharpOwnerPartMembers[])[] = [];
  const seen = new Set<string>();
  let current: KeywordClassRef | null = owner;
  while (current && levels.length < RECEIVER_HIERARCHY_DEPTH) {
    const key = keywordContainerKey(current.file, current.container);
    if (seen.has(key)) break;
    seen.add(key);
    const { parts } = await csharpTypeParts(index, current);
    levels.push(
      parts.map((part) => {
        const partKey = keywordContainerKey(part.file, part.container);
        let table = cache.parts.get(partKey);
        if (!table) {
          table = csharpPartMemberTable(part);
          cache.parts.set(partKey, table);
        }
        return table;
      }),
    );
    // An unreadable or unproven base ends the chain: a root name it might hold is treated as unbound.
    const base = await csharpBaseClassRef(index, parts);
    current = base === "unproven" ? null : base;
  }
  return levels;
}

function csharpOwnerChainOf(index: ProjectIndex, owner: KeywordClassRef): Promise<CsharpOwnerChain | null> {
  const cache = csharpOwnerCache(index);
  const key = keywordContainerKey(owner.file, owner.container);
  const ready = cache.chains.get(key);
  if (ready !== undefined) return Promise.resolve(ready);
  let pending = cache.pending.get(key);
  if (!pending) {
    pending = buildCsharpOwnerChain(index, owner, cache).then(
      (chain) => {
        cache.chains.set(key, chain);
        cache.pending.delete(key);
        return chain;
      },
      (error: unknown) => {
        cache.pending.delete(key);
        throw error;
      },
    );
    cache.pending.set(key, pending);
  }
  return pending;
}

const NO_CSHARP_OUTER_MEMBER: CsharpAliasMemberLookup = { status: "none" };

/**
 * What an owner's chain finds for `name`: the nearest type that declares it. A nested type matches a type position; a
 * value member of a different type than its own name hides the name too, while `Color Color` leaves it to the type.
 */
function lookupCsharpOwnerChain(chain: CsharpOwnerChain, name: string, typeOnly: boolean): CsharpAliasMemberLookup {
  for (const [depth, parts] of chain.entries()) {
    const found: SymbolDef[] = [];
    let sameNamedType = false;
    for (const part of parts) {
      for (const member of part.get(name) ?? []) {
        if ((typeOnly && !member.type) || (depth > 0 && !member.inheritable)) continue;
        if (member.sameNamedType) sameNamedType = true;
        else found.push(member.def);
      }
    }
    if (found.length) return { status: "member", member: found.length === 1 ? found[0]! : null };
    if (sameNamedType) return NO_CSHARP_OUTER_MEMBER;
  }
  return NO_CSHARP_OUTER_MEMBER;
}

/**
 * The member of an enclosing type's other parts or project base classes that binds the root name `name` at `node`,
 * read from owner chains an earlier {@link csharpOuterMember} or {@link warmCsharpOwnerChains} built. `undefined`
 * until every enclosing owner has one. An unproven part scan or base is no member: the name goes on to its namespace.
 */
export function peekCsharpOuterMember(
  index: ProjectIndex,
  file: string,
  node: SyntaxNodeLike,
  name: string,
): CsharpAliasMemberLookup | undefined {
  const owners = csharpEnclosingOwners(node);
  if (!owners.length) return NO_CSHARP_OUTER_MEMBER;
  const { chains } = csharpOwnerCache(index);
  const normalized = CSHARP_SUPPORT.normalizeIdentifier(name);
  const typeOnly = csharpTypeOnlyName(node, true);
  for (const owner of owners) {
    const chain = chains.get(keywordContainerKey(file, owner));
    if (chain === undefined) return undefined;
    if (!chain) continue;
    const found = lookupCsharpOwnerChain(chain, normalized, typeOnly);
    if (found.status === "member") return found;
  }
  return NO_CSHARP_OUTER_MEMBER;
}

/** {@link peekCsharpOuterMember}, building the owner chains it needs. */
export async function csharpOuterMember(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  name: string,
): Promise<CsharpAliasMemberLookup> {
  const context = await ensureParsedContextForIndex(index, mod.file);
  const located = context.tree.rootNode.descendantForPosition(node.startPosition, node.startPosition);
  const normalized = CSHARP_SUPPORT.normalizeIdentifier(name);
  const typeOnly = csharpTypeOnlyName(node, true);
  for (const container of csharpEnclosingOwners(located)) {
    const chain = await csharpOwnerChainOf(index, { file: mod.file, container, context, module: mod });
    if (!chain) continue;
    const found = lookupCsharpOwnerChain(chain, normalized, typeOnly);
    if (found.status === "member") return found;
  }
  return NO_CSHARP_OUTER_MEMBER;
}

/** Builds the owner chain of every type a C# module declares, so its sync lookups can read them with a peek. */
export async function warmCsharpOwnerChains(
  index: ProjectIndex,
  mod: ModuleIndex,
  parsed: ParsedFileContext,
): Promise<void> {
  for (const def of mod.locals) {
    if (!declaresMembers(def)) continue;
    const nameNode = nameNodeForDef(parsed, def);
    const container = nameNode && nearestMemberContainer(nameNode);
    if (container) await csharpOwnerChainOf(index, { file: mod.file, container, context: parsed, module: mod });
  }
}

/**
 * C# searches the enclosing types, innermost first, each with its project base classes, before an alias.
 * Type positions consider only nested types; bare calls use shared arity-aware inherited-member selection.
 * A name no alias holds is a type root, read from the cached owner chains and never left unproven.
 */
export async function csharpAliasMemberLookup(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  name: string,
): Promise<CsharpAliasMemberLookup> {
  const typeOnly = csharpTypeOnlyName(node, true);
  const call = !typeOnly && implicitSelfCallee("csharp", node.parent ?? node)?.id === node.id;
  if (!call && !csharpAliasAt(mod, name, node)) return csharpOuterMember(index, mod, node, name);
  let ref = await keywordClassRefFromNode(index, mod, node);
  while (ref) {
    const members = await csharpTypeChainMembersNamed(index, ref, name, typeOnly, call);
    if (members === "unproven") return { status: "unproven" };
    const [first] = members;
    if (first) {
      if (!call || first.kind !== SymbolKind.Function) {
        return { status: "member", member: members.length === 1 ? first : null };
      }
      const owner = definitionForContainer(ref.module, ref.container);
      if (!owner) return { status: "unproven" };
      const { source } = ref.context;
      const memberScope = nodeInStaticMemberContext(node, source) ? "static" : "any";
      const argumentCount = getCallArgumentCount({ languageId: "csharp", source, call: node.parent ?? node });
      const selected = await resolveKeywordReceiverMember(
        index,
        mod,
        node,
        name,
        memberScope,
        false,
        argumentCount ?? undefined,
        owner,
      );
      const applicable = selected && memberAcceptsCallAt(index, selected, node, source, "csharp");
      return { status: "member", member: applicable ? selected : null };
    }
    const outer = nearestMemberContainer(ref.container);
    ref = outer ? { ...ref, container: outer } : null;
  }
  return { status: "none" };
}

/**
 * {@link resolveCsharpQualifiedReceiverType} for an async caller: the `using static` target files its root lookup reads
 * are loaded first, and so are the owner chains that decide whether an enclosing type's member binds the root.
 */
async function csharpQualifiedReceiverTypeLoaded(
  index: ProjectIndex,
  mod: ModuleIndex,
  typeNode: SyntaxNodeLike,
  source: string,
  scopeIndex: ScopeIndex,
): Promise<SymbolDef | null> {
  const context = await ensureParsedContextForIndex(index, mod.file);
  const qualified = csharpQualifiedNameNode(typeNode);
  const lead = qualified && csharpChainQualifier(qualified, source);
  if (lead) await csharpOuterMember(index, mod, lead.qualifier, sliceText(lead.qualifier, source));
  const files = createLoadingParsedFileProvider(index, { file: mod.file, parsed: context });
  return withParsedFiles(files, () =>
    resolveCsharpQualifiedReceiverType(index, mod, typeNode, source, scopeIndex, files),
  );
}

/**
 * The type a C# field, property, or parameter declares, read in the file that declares it: a nominal type the project
 * declares. `null` for a method, a type parameter, or a name no project file declares.
 */
async function csharpMemberDeclaredType(index: ProjectIndex, member: SymbolDef): Promise<SymbolDef | null> {
  if (member.kind !== SymbolKind.Variable) return null;
  const context = await ensureParsedContextForIndex(index, member.file).catch(ignoreQueryParseFailure);
  const module = index.byFile.get(fileIdentityKey(member.file));
  if (!context || !module) return null;
  const nameNode = nameNodeForDef(context, member);
  let declaration = nameNode?.parent ?? null;
  if (declaration?.type === "variable_declarator") declaration = declaration.parent;
  const typeNode = declaration ? declaredTypeNameNode(declaration, context.sup) : null;
  if (!declaration || !typeNode) return null;
  const typeText = qualifiedDeclaredTypeText(typeNode, context.source);
  if (typeParameterNamesInScope(declaration, context.source).has(typeText.split(/[.:]/)[0]!)) return null;
  const scopeIndex = getOrBuildScopeIndex(index, member.file, context.source, context.sup, module, context.tree);
  return csharpQualifiedReceiverTypeLoaded(index, module, typeNode, context.source, scopeIndex);
}

/** A simple alias-named use: not a declaration, `::` alias qualifier, or qualified suffix. */
function isCsharpAliasSimpleName(sup: LanguageSupport, node: SyntaxNodeLike): boolean {
  if (sup.isDeclarationName(node) || isCsharpAliasQualifier(node, sup)) return false;
  const access = node.parent && isMemberAccessNode(sup, node.parent) ? node.parent : null;
  return !access || getMemberAccessParts(sup, access).property?.id !== node.id;
}

/** A simple name C# binds as a type or as the root of a dotted name; not a qualified suffix or an alias qualifier. */
export function csharpTypeRootName(node: SyntaxNodeLike): boolean {
  if (node.parent?.type === "alias_qualified_name") return false;
  const qualified = csharpQualifiedNameNode(node);
  if (qualified && qualified.startIndex < node.startIndex) return false;
  if (csharpTypeOnlyName(node, true)) return true;
  const dotted = node.parent && csharpDottedNameRoot(node.parent);
  return dotted?.id === node.id;
}

/**
 * Whether the lexical binding a use found is declared inside the innermost type around it. Another part or a base class
 * cannot declare the same member, and a local or parameter is closer still, so nothing outside the file binds the name
 * first. A type declared outside that type, in this file or another, can still be hidden by what the type receives.
 */
export function csharpBindingWithinOwner(binding: Binding | null, node: SyntaxNodeLike): boolean {
  const declared = binding?.def?.start.index;
  const owner = nearestMemberContainer(node);
  return declared !== undefined && !!owner && owner.startIndex <= declared && declared < owner.endIndex;
}

/** The outcome of a member of an enclosing type's other parts or bases binding a name, as a go-to-definition answer. */
export function csharpOuterMemberResolution(index: ProjectIndex, lookup: CsharpAliasMemberLookup): GoToResult | null {
  if (lookup.status !== "member") return null;
  if (!lookup.member) return { status: "not_found", reason: AMBIGUOUS_CSHARP_ALIAS_MEMBER_REASON };
  return okGoToResult(index, lookup.member, { resolution: "member-access", confidence: "medium" });
}

/**
 * Positioned alias uses hidden by enclosing members, with their shared lookup results. The graph reads these facts
 * synchronously, including nested types in type positions, after this one async pass per module.
 */
export async function csharpAliasUsesHiddenByMembers(
  index: ProjectIndex,
  mod: ModuleIndex,
  parsed: ParsedFileContext,
  scopeIndex: ScopeIndex,
): Promise<ReadonlyMap<number, CsharpAliasMemberLookup>> {
  const hidden = new Map<number, CsharpAliasMemberLookup>();
  const aliasTable = csharpAliasTable(mod);
  if (!aliasTable.types.size && !aliasTable.namespaces.size) return hidden;
  const { sup, source, tree } = parsed;
  const namesAlias = (node: SyntaxNodeLike): boolean => {
    if (node.type !== "identifier") return false;
    const normalized = sup.normalizeIdentifier(sliceText(node, source));
    return aliasTable.types.has(normalized) || aliasTable.namespaces.has(normalized);
  };
  const uses: SyntaxNodeLike[] = [];
  const collect = (node: SyntaxNodeLike): void => {
    if (namesAlias(node) && isCsharpAliasSimpleName(sup, node)) uses.push(node);
    for (const child of node.namedChildren) collect(child);
  };
  collect(tree.rootNode);
  const lookups = new Map<string, CsharpAliasMemberLookup>();
  for (const node of uses) {
    const name = sliceText(node, source);
    // A closer binding hides the alias on its own, and an alias that is not in scope here is not hidden by a member.
    const closest = findClosestScopeBinding(scopeIndex, name, node, sup);
    if (!fileBindingIsUnshadowed(scopeIndex, closest) || !csharpAliasAt(mod, name, node)) continue;
    const typeOnly = csharpTypeOnlyName(node, true);
    const call = implicitSelfCallee("csharp", node.parent ?? node)?.id === node.id;
    const argumentCount = call ? getCallArgumentCount({ languageId: "csharp", source, call: node.parent ?? node }) : "";
    const staticContext = call && nodeInStaticMemberContext(node, source);
    const key = `${nearestMemberContainer(node)?.startIndex ?? -1}\0${sup.normalizeIdentifier(name)}\0${typeOnly}\0${staticContext}\0${argumentCount}`;
    let lookup = lookups.get(key);
    if (!lookup) {
      lookup = await csharpAliasMemberLookup(index, mod, node, name);
      lookups.set(key, lookup);
    }
    if (lookup.status !== "none") hidden.set(node.startIndex, lookup);
  }
  return hidden;
}

/** Whether an inherited JVM member is inaccessible through this receiver. */
async function isUninheritedPrivateMember(
  index: ProjectIndex,
  mod: ModuleIndex,
  use: SyntaxNodeLike,
  member: SymbolDef,
): Promise<boolean> {
  const container = findEnclosingClassContainer(use);
  const start = member.range.start.index ?? -1;
  const ownMember =
    !!container &&
    fileIdentityKey(member.file) === fileIdentityKey(mod.file) &&
    start >= container.startIndex &&
    start < container.endIndex;
  if (ownMember) return false;
  if (member.javaPackagePrivate && !member.javaProtectedMember) {
    const memberPackage = getPackageDeclarationName(index, member.file, "java");
    const useLanguage = supportForFileWithoutHeaderSample(mod.file, index.languageExtensions)?.id;
    const usePackage = getPackageDeclarationName(index, mod.file, useLanguage === "kotlin" ? "kotlin" : "java");
    if (memberPackage !== usePackage) return true;
  }
  const parsed = await ensureParsedContextForIndex(index, member.file).catch(ignoreQueryParseFailure);
  const nameNode = parsed?.tree.rootNode.descendantForIndex(start, member.range.end.index ?? start);
  return !!parsed && !!nameNode && isPrivateDeclaration(parsed.sup.id, nameNode);
}

/**
 * Whether `Owner::member()` at `use` can reach an instance member of `owner` through an implicit
 * `this`: the enclosing function is a non-static member function of `owner` or of a class that
 * derives from `owner` through proven bases. Any other context can only name a static member.
 */
export async function cppQualifiedOwnerHasImplicitThis(
  index: ProjectIndex,
  mod: ModuleIndex,
  use: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  owner: SymbolDef,
): Promise<boolean> {
  const definition = cppEnclosingFunctionDefinition(use);
  if (!definition || !(await cppFunctionHasImplicitThis(index, mod, definition, source, sup))) return false;
  const outOfLinePath = cppOutOfLineOwnerPath(definition, source, sup);
  const enclosingDef = outOfLinePath ? await resolveCppQualifiedMemberContainer(index, mod, outOfLinePath) : null;
  const enclosing = enclosingDef
    ? await keywordClassRefFromDef(index, enclosingDef)
    : await keywordClassRefFromNode(index, mod, definition);
  const target = await keywordClassRefFromDef(index, owner);
  if (!enclosing || !target) return false;
  const targetKey = keywordContainerKey(target.file, target.container);
  const visited = new Set<string>();
  let level: KeywordClassRef[] = [enclosing];
  for (let depth = 0; depth < RECEIVER_HIERARCHY_DEPTH && level.length; depth += 1) {
    const next: KeywordClassRef[] = [];
    for (const candidate of level) {
      const key = keywordContainerKey(candidate.file, candidate.container);
      if (key === targetKey) return true;
      if (visited.has(key)) continue;
      visited.add(key);
      next.push(
        ...(await baseRefsFromContainer(
          index,
          candidate.module,
          candidate.container,
          candidate.context.source,
          candidate.context.sup,
          false,
          candidate.context.tree,
        )),
      );
    }
    level = next;
  }
  return false;
}

/** The C++ function definition enclosing a use, if any. */
export function cppEnclosingFunctionDefinition(node: SyntaxNodeLike): SyntaxNodeLike | null {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "function_definition") return current;
  }
  return null;
}

/** Proven unqualified member call from an out-of-line C++ method definition. */
export async function resolveCppOutOfLineImplicitMember(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  name: string,
  source: string,
  sup: LanguageSupport,
  requireAcceptedArity = false,
): Promise<SymbolDef | null | undefined> {
  if (node.parent?.type !== "call_expression" || node.parent.childForFieldName("function")?.id !== node.id) {
    return undefined;
  }
  const ownerPath = cppOutOfLineOwnerPath(node, source, sup);
  const owner = ownerPath ? await resolveCppQualifiedMemberContainer(index, mod, ownerPath) : null;
  if (!owner) return undefined;
  const argumentCount = getCallArgumentCount({ languageId: "cpp", source, call: node.parent }) ?? undefined;
  const enclosingFunction = cppEnclosingFunctionDefinition(node);
  const memberScope =
    enclosingFunction && (await cppFunctionHasImplicitThis(index, mod, enclosingFunction, source, sup))
      ? "any"
      : "static";
  const matching = await resolveKeywordReceiverMember(index, mod, node, name, memberScope, false, argumentCount, owner);
  // A class member hides a same-named global even when this call cannot accept its arity. The
  // only member is still the call's target for navigation; an ambiguous overload set is not.
  const member =
    matching ??
    (argumentCount === undefined
      ? undefined
      : await resolveKeywordReceiverMember(index, mod, node, name, memberScope, false, undefined, owner));
  if (!member) {
    // In a static member function, an instance member still hides a same-named global: the call
    // is ill-formed, so neither consumer may fall back to the global.
    const hidden =
      memberScope === "static" &&
      (await resolveKeywordReceiverMember(index, mod, node, name, "any", false, undefined, owner));
    return hidden ? null : undefined;
  }
  // The call graph records no edge for a call its target cannot accept. `null` means a member hides
  // the name but is not the call's target, so no consumer may fall back to a same-named free function.
  const rejected =
    requireAcceptedArity &&
    argumentCount !== undefined &&
    !receiverMemberAcceptsArgumentCount(index, member, argumentCount);
  return rejected ? null : member;
}

export { supportsReceiverCallEdges, supportsReceiverMemberNavigation } from "../util/member-access-tables.js";

type ResolvedReceiverDefinition = {
  def: SymbolDef;
  memberScope: ReceiverMemberScope;
  runtimeTypeOnly?: true;
};

function memberDeclaringLocals(mod: ModuleIndex, typeName: string, normalize: (name: string) => string): SymbolDef[] {
  const normalized = normalize(typeName);
  return mod.locals.filter((local) => normalize(local.localName) === normalized && declaresMembers(local));
}

/**
 * Ruby constant visible the same way go-to-definition resolves a bare `Widget`:
 * a same-file declaration, or the class a `require` brought in. Not project-wide.
 */
export function resolveRubyVisibleConstant(
  index: ProjectIndex,
  mod: ModuleIndex,
  sup: LanguageSupport,
  typeName: string,
): SymbolDef | null {
  if (sup.id !== "ruby") return null;
  const resolved = resolveNamedDefinition(index, mod, mod.file, sup, typeName);
  if (resolved?.status !== "ok") return null;
  return declaresMembers(resolved.definition) ? resolved.definition : null;
}

/** Proven PHP `extends` base, using the same simple-name lookup as `parent::`. */
function resolvePhpProvenBaseClass(
  index: ProjectIndex,
  mod: ModuleIndex,
  classNode: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
): SymbolDef | null {
  const bases = collectDeclaredBaseTypes(classNode, source, sup, index, mod, true);
  if (bases.length !== 1) return null;
  const base = bases[0];
  if (!base || base.kind !== "simple") return null;
  const normalize = (name: string): string => foldPhpIdentifierCase(sup.normalizeIdentifier(name));
  return resolveNamedMemberContainer(index, mod, base.name, normalize) ?? null;
}

/**
 * Class named by `new self()`, `new static()`, or `new parent()`.
 * `self` and `static` are the enclosing class. `parent` is the proven base.
 * Returns null when the keyword is not proven, so a class named `Parent` cannot win.
 */
export function resolvePhpObjectCreationTarget(
  index: ProjectIndex,
  mod: ModuleIndex,
  keyword: PhpObjectCreationKeyword,
  source: string,
  sup: LanguageSupport,
): SymbolDef | null {
  if (!keyword.classNode) return null;
  if (keyword.keyword === "self" || keyword.keyword === "static") {
    return memberContainerDef(mod, keyword.classNode);
  }
  return resolvePhpProvenBaseClass(index, mod, keyword.classNode, source, sup);
}

function enclosingRubyMethod(node: SyntaxNodeLike): SyntaxNodeLike | null {
  let current = node.parent;
  while (current) {
    if (current.type === "method" || current.type === "singleton_method") return current;
    current = current.parent;
  }
  return null;
}

/** Bare `super` / `super()` targets the same-named method on a proven superclass. */
export async function resolveRubySuperDefinition(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
): Promise<SymbolDef | undefined> {
  if (sup.id !== "ruby" || node.type !== "super") return undefined;
  const method = enclosingRubyMethod(node);
  const nameNode = method?.childForFieldName("name") ?? null;
  if (!nameNode) return undefined;
  const member = sliceText(nameNode, source);
  if (!member) return undefined;
  return resolveKeywordReceiverMember(index, mod, node, member, "any", true);
}

/**
 * Follow a Swift typealias only when its right-hand side is a single indexed nominal type. Shared by receiver
 * navigation and the detailed graph, so an alias names the same type everywhere.
 */
export async function resolveSwiftAliasContainer(
  index: ProjectIndex,
  alias: SymbolDef,
): Promise<SymbolDef | undefined> {
  return await followSwiftAlias(index, alias, false);
}

/**
 * `resolveSwiftAliasContainer` for an inheritance clause, which may also name a protocol: the single class,
 * struct, enum, actor, or protocol declaration a typealias chain provably reaches. An extension header declares no
 * type, so an alias that lands on one reaches no proven declaration. Shared by member lookup through a base and
 * by the detailed graph's base-clause edges, so a base alias names the same type everywhere.
 */
export async function resolveSwiftAliasHeritage(index: ProjectIndex, alias: SymbolDef): Promise<SymbolDef | undefined> {
  const reached = await followSwiftAlias(index, alias, true);
  return reached?.swiftExtensionOwner ? undefined : reached;
}

/** A Swift base clause may name a typealias: the declaration it provably reaches is the base, and an unproven alias names none. */
async function swiftBaseDeclaration(index: ProjectIndex, named: SymbolDef): Promise<SymbolDef | undefined> {
  if (named.kind !== SymbolKind.TypeAlias) return named;
  return await resolveSwiftAliasHeritage(index, named);
}

/** The one type named `name` that the body of the Swift type `owner` declares. A nested type declared in an extension is not read. */
async function swiftNestedType(index: ProjectIndex, owner: SymbolDef, name: string): Promise<SymbolDef | undefined> {
  const ref = await keywordClassRefFromDef(index, owner);
  if (ref?.context.sup.id !== "swift") return undefined;
  const nested = findDirectLocalsWithinNode(
    ref.module.locals,
    name,
    ref.container,
    ref.context,
    ref.context.sup.normalizeIdentifier,
  ).filter((local) => local.isMember && declaresMembers(local));
  return nested.length === 1 ? nested[0] : undefined;
}

/**
 * The type a dotted Swift name reaches from the declaration of its first segment: every later segment is a type declared
 * in the body of the segment before it, and a typealias in the chain is followed to the nominal type it provably names.
 * A missing, ambiguous, or extension-declared nested type proves no path. Shared by the lookup of a qualified type name
 * and by the base-clause readers, so a nested base names the same type everywhere.
 */
export async function resolveSwiftNestedTypePath(
  index: ProjectIndex,
  owner: SymbolDef,
  names: readonly string[],
): Promise<SymbolDef | undefined> {
  let current = owner;
  for (const name of names) {
    const container = await swiftBaseDeclaration(index, current);
    if (!container) return undefined;
    const nested = await swiftNestedType(index, container, name);
    if (!nested) return undefined;
    current = nested;
  }
  return current;
}

/** Whether a declaration ends a Swift alias chain: a nominal type, or a protocol where the caller accepts one. */
function endsSwiftAliasChain(declarationType: string | undefined, acceptsProtocol: boolean): boolean {
  if (declarationType === "class_declaration") return true;
  return acceptsProtocol && declarationType === "protocol_declaration";
}

async function followSwiftAlias(
  index: ProjectIndex,
  alias: SymbolDef,
  acceptsProtocol: boolean,
): Promise<SymbolDef | undefined> {
  let current = alias;
  const seen = new Set<string>();
  while (current.kind === SymbolKind.TypeAlias) {
    const key = `${fileIdentityKey(current.file)}:${current.range.start.index}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const mod = index.byFile.get(fileIdentityKey(current.file));
    if (!mod) return undefined;
    const context = await ensureParsedContextForIndex(index, current.file);
    if (context.sup.id !== "swift") return undefined;
    const declaration = nameNodeForDef(context, current)?.parent;
    if (declaration?.type !== "typealias_declaration") {
      return endsSwiftAliasChain(declaration?.type, acceptsProtocol) && declaresMembers(current) ? current : undefined;
    }
    const target = declaration.namedChildren.find((child) => child.type === "user_type");
    const named = target ? unwrapNamedType(target, context.sup) : null;
    if (!named || target?.namedChildren.length !== 1) return undefined;
    const targetName = sliceText(named, context.source);
    const namedTarget = resolveNamedDefinition(
      index,
      mod,
      mod.file,
      context.sup,
      targetName,
      undefined,
      declaration.startIndex,
    );
    const next =
      resolveNamedMemberContainer(index, mod, targetName, context.sup.normalizeIdentifier) ??
      (namedTarget?.status === "ok" ? asMemberContainer(index, namedTarget.definition) : undefined);
    if (!next) return undefined;
    current = next;
  }
  return declaresMembers(current) ? current : undefined;
}
async function resolveReceiverDefinition(
  index: ProjectIndex,
  obj: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  resolveExpression: (expr: SyntaxNodeLike) => Promise<ResolvedExport | null>,
  mod: ModuleIndex,
  getScopeIndex: () => ScopeIndex,
  proof?: ReceiverBinding | null,
  resolvedDirect?: ResolvedExport | null,
  hiddenReceiverType?: (expr: SyntaxNodeLike) => Promise<SymbolDef | null>,
): Promise<ResolvedReceiverDefinition | null> {
  // A C# member that binds the receiver's name before an alias types it by its own declaration.
  const hiddenType = await hiddenReceiverType?.(obj);
  if (hiddenType) return { def: hiddenType, memberScope: "instance" };
  const direct = resolvedDirect === undefined ? await resolveExpression(obj) : resolvedDirect;
  const receiver =
    proof ??
    classifyReceiver(sup, obj, source, null, 0, obj.parent ?? obj, noLexicalBinding, () => {
      if (direct?.kind === "namespace") return "module-import";
      if (direct?.kind === "resolved" && declaresMembers(direct.def)) return "static-type";
      return null;
    });
  if (receiver.kind === "module-import") return null;
  if (supportsDeclaredFieldChains(sup.id) && isMemberAccessNode(sup, obj)) {
    const directType = direct?.kind === "resolved" ? asMemberContainer(index, direct.def) : undefined;
    if (!directType) {
      const { object, property } = getMemberAccessParts(sup, obj);
      if (!object || !property) return null;
      const owner = await resolveReceiverDefinition(
        index,
        object,
        source,
        sup,
        resolveExpression,
        mod,
        getScopeIndex,
        undefined,
        undefined,
        hiddenReceiverType,
      );
      if (!owner || owner.runtimeTypeOnly) return null;
      const field = await resolveKeywordReceiverMember(
        index,
        mod,
        property,
        sliceText(property, source),
        owner.memberScope,
        false,
        undefined,
        owner.def,
      );
      if (!field || field.kind !== SymbolKind.Variable || !field.isMember) return null;
      const fieldContext = await ensureParsedContextForIndex(index, field.file);
      const name = nameNodeForDef(fieldContext, field);
      let declaration = name?.parent ?? null;
      if (declaration?.type === "variable_declarator") declaration = declaration.parent;
      if (!declaration) return null;
      const annotatedType = declaredTypeNameNode(declaration, fieldContext.sup);
      if (!annotatedType) return null;
      const fieldModule = index.byFile.get(fileIdentityKey(field.file));
      if (!fieldModule) return null;
      const typeText = qualifiedDeclaredTypeText(annotatedType, fieldContext.source);
      // A type parameter in scope (`class Host<Repo>`) is not a nominal type; bounds are not solved.
      if (typeParameterNamesInScope(declaration, fieldContext.source).has(typeText.split(/[.:]/)[0]!)) return null;
      const type = await resolveReceiverTypeName(index, fieldModule, fieldContext.sup, typeText);
      return type ? { def: type, memberScope: "instance" } : null;
    }
  }
  if (receiver.kind === "own-type") {
    const container = nearestMemberContainer(obj);
    const owner = container ? definitionForContainer(mod, container) : undefined;
    return owner ? { def: owner, memberScope: receiver.memberScope } : null;
  }
  const constructor = receiver.kind === "named-type" && receiver.proof !== "static-type" ? receiver.typeNode : null;
  if (constructor) {
    if (sup.id === "csharp") {
      const qualified = csharpQualifiedNameNode(constructor);
      if (qualified) {
        const def = await csharpQualifiedReceiverTypeLoaded(index, mod, constructor, source, getScopeIndex());
        return def ? { def, memberScope: "instance" } : null;
      }
      const resolved = await resolveExpression(constructor);
      const def = resolved?.kind === "resolved" ? asMemberContainer(index, resolved.def) : undefined;
      return def ? { def, memberScope: "instance" } : null;
    }
    if (sup.id === "cpp") {
      const qualifiedType = cppQualifiedNameSegments(constructor, source);
      if (qualifiedType.length > 1) {
        const def = await resolveCppQualifiedMemberContainer(index, mod, qualifiedType);
        if (def) {
          return {
            def,
            memberScope: hasStaticMemberDistinction(sup.id) ? "instance" : "any",
          };
        }
      }
    }
    const typeName = sliceText(constructor, source);
    if (bindsTypeParameter(typeName, constructor, source, sup)) return null;
    const typedLocals = memberDeclaringLocals(mod, typeName, sup.normalizeIdentifier);
    if (typedLocals.length === 1) {
      return {
        def: typedLocals[0]!,
        memberScope: hasStaticMemberDistinction(sup.id) ? "instance" : "any",
      };
    }
    if (sup.id === "go") {
      const named = resolveNamedDefinition(index, mod, mod.file, sup, typeName, undefined, constructor.startIndex);
      const peer = named?.status === "ok" ? asMemberContainer(index, named.definition) : undefined;
      if (peer) return { def: peer, memberScope: "any" };
    }
    if (sup.id === "php") {
      const normalizeTypeName = (name: string): string => foldPhpIdentifierCase(sup.normalizeIdentifier(name));
      const namedContainer = resolveNamedMemberContainer(index, mod, typeName, normalizeTypeName);
      if (namedContainer) {
        return {
          def: namedContainer,
          memberScope: hasStaticMemberDistinction(sup.id) ? "instance" : "any",
        };
      }
    }
    const result = await resolveExpression(constructor);
    const constructed = result?.kind === "resolved" ? asMemberContainer(index, result.def) : undefined;
    if (constructed) {
      return {
        def: constructed,
        memberScope: hasStaticMemberDistinction(sup.id) ? "instance" : "any",
      };
    }
    // Ruby `require` exposes a class as a namespace import. A bare constant already
    // resolves through resolveNamedDefinition; `Klass.new` must use that same path
    // so goto, references, and call edges agree. Same-file classes returned above.
    if (sup.id === "ruby" && typedLocals.length === 0) {
      const rubyType = resolveRubyVisibleConstant(index, mod, sup, typeName);
      if (rubyType) {
        return {
          def: rubyType,
          memberScope: hasStaticMemberDistinction(sup.id) ? "instance" : "any",
        };
      }
    }
    if (typedLocals[0]) {
      return {
        def: typedLocals[0],
        memberScope: hasStaticMemberDistinction(sup.id) ? "instance" : "any",
      };
    }
  }
  if (sup.id === "swift" && direct?.kind === "resolved" && direct.def.kind === SymbolKind.TypeAlias) {
    const aliased = await resolveSwiftAliasContainer(index, direct.def);
    if (aliased) return { def: aliased, memberScope: "static" };
    return null;
  }
  const directContainer = direct?.kind === "resolved" ? asMemberContainer(index, direct.def) : undefined;
  if (directContainer) {
    if (isJsTsLanguage(sup.id) && directContainer.kind === SymbolKind.TypeAlias) {
      return { def: directContainer, memberScope: "any", runtimeTypeOnly: true };
    }
    const memberScope = supportsStaticMemberScope(sup.id) ? "static" : "any";
    return { def: directContainer, memberScope };
  }
  if (isJsTsLanguage(sup.id) && isReceiverNameNode(sup, obj.type)) {
    return null;
  }
  if (direct?.kind === "resolved") {
    return { def: direct.def, memberScope: "any" };
  }
  return null;
}

/** Whether a type-qualified access (`Util.M`) can name `def`: a nested type or a static member. */
async function reachableThroughTypeName(index: ProjectIndex, def: SymbolDef): Promise<boolean> {
  if (declaresMembers(def)) return true;
  const context = await ensureParsedContextForIndex(index, def.file);
  const nameNode = nameNodeForDef(context, def);
  if (!nameNode) return false;
  return hasStaticModifier(def, context, nearestMemberContainer(nameNode) ?? context.tree.rootNode);
}

/**
 * A member declared directly in the type `baseDef` names (`Util.Two`), including the other parts
 * of a C# partial type, or inherited through it. Same-named overloads are narrowed to members a
 * type name reaches (static members and nested types) when the base is a type, then chosen by
 * the call's argument count; without a count, or when several accept it, the lookup is
 * ambiguous. A sole reachable candidate is kept even when the count does not fit, as for other
 * calls; the graph records no edge for it. Ruby reopens a method by redefining it, so it keeps the first match.
 */
async function resolveMemberDefinitionForBase(
  index: ProjectIndex,
  baseDef: SymbolDef,
  member: string,
  knownArgumentCount?: number,
): Promise<SymbolDef | undefined> {
  const targetContext = await ensureParsedContextForIndex(index, baseDef.file);
  const start = baseDef.range.start;
  const targetPosition = {
    row: start.line - 1,
    column: start.column - 1,
  };
  const nameNode = targetContext.tree.rootNode.descendantForPosition(targetPosition, targetPosition);
  const container = nameNode.parent;
  if (!container) return undefined;
  const targetModule = index.byFile.get(fileIdentityKey(baseDef.file));
  if (!targetModule) return undefined;
  const languageId = targetContext.sup.id;
  const normalizeIdentifier = targetContext.sup.normalizeIdentifier;
  const candidates = findDirectLocalsWithinNode(
    targetModule.locals,
    member,
    container,
    targetContext,
    normalizeIdentifier,
  );
  if (languageId === "csharp") {
    const partialParts = await findSharedOwnerMemberDefinitions({
      index,
      ownerFile: baseDef.file,
      ownerContainer: container,
      ownerSource: targetContext.source,
      languageId,
      member,
    });
    for (const hit of partialParts) {
      if (!candidates.includes(hit)) candidates.push(hit);
    }
  }
  if (candidates.length) {
    let reachable = candidates;
    if (languageId !== "ruby" && candidates.length > 1) {
      reachable = [];
      for (const candidate of candidates) {
        if (!declaresMembers(baseDef) || (await reachableThroughTypeName(index, candidate))) reachable.push(candidate);
      }
    }
    const selected = selectMember([baseDef], indexedMemberModel(index, reachable, languageId), {
      name: member,
      argumentCount: knownArgumentCount ?? null,
      scope: "any",
      useFile: baseDef.file,
      phpCaseInsensitive: languageId === "php",
      normalizeIdentifier: languageId === "swift" ? normalizeIdentifier : undefined,
      firstDeclarationWins: languageId === "ruby",
      keepUniqueArityMismatch: true,
    });
    return selected.status === "unique" ? selected.member : undefined;
  }
  if (languageId === "java") return undefined;
  return await findReceiverMemberDefinition(
    index,
    targetModule.locals,
    member,
    baseDef,
    container,
    targetContext,
    normalizeIdentifier,
  );
}

function typescriptMergedInterfaceMemberCandidates(
  locals: readonly SymbolDef[],
  member: string,
  receiverDef: SymbolDef,
  container: SyntaxNodeLike,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
  predicate: ((local: SymbolDef) => boolean) | undefined,
): SymbolDef[] {
  const matches = findDirectLocalsWithinNode(locals, member, container, targetContext, normalizeIdentifier, predicate);
  if (!isJsTsLanguage(targetContext.sup.id) || container.type !== "interface_declaration") return matches;

  const receiverStart = receiverDef.range.start.index ?? 0;
  const receiverEnd = receiverDef.range.end.index ?? receiverStart;
  const receiverContainerKey = typescriptCallableContainerKey(targetContext.tree, receiverStart, receiverEnd);
  const seenBodies = new Set<string>();
  const appendMembers = (interfaceDeclaration: SyntaxNodeLike): void => {
    const body = interfaceDeclaration.childForFieldName("body");
    if (!body) return;
    const bodyKey = typescriptCallableContainerKey(targetContext.tree, body.startIndex, body.endIndex);
    if (seenBodies.has(bodyKey)) return;
    seenBodies.add(bodyKey);
    for (const candidate of findDirectLocalsWithinNode(
      locals,
      member,
      interfaceDeclaration,
      targetContext,
      normalizeIdentifier,
      predicate,
    )) {
      if (!matches.includes(candidate)) matches.push(candidate);
    }
  };

  const normalizedReceiverName = normalizeIdentifier(receiverDef.localName);
  for (const local of locals) {
    if (normalizeIdentifier(local.localName) !== normalizedReceiverName) continue;
    const start = local.range.start.index;
    if (start === undefined) continue;
    const end = local.range.end.index ?? start;
    if (typescriptCallableContainerKey(targetContext.tree, start, end) !== receiverContainerKey) continue;
    const nameNode = targetContext.tree.rootNode.descendantForIndex(start, end);
    const interfaceDeclaration = nameNode.parent;
    if (interfaceDeclaration?.type !== "interface_declaration") continue;
    appendMembers(interfaceDeclaration);
  }
  return matches;
}

/** Same-name namespace reopenings, excluding members of a decoy namespace or nested owner. */
export function findTypeScriptNamespaceMemberCandidates(
  locals: readonly SymbolDef[],
  member: string,
  receiverDef: SymbolDef,
  context: ParsedFileContext,
): SymbolDef[] {
  if (!isJsTsLanguage(context.sup.id)) return [];
  const containers = typescriptMergedNamespaceContainers(context.tree, locals, receiverDef);
  const matches: SymbolDef[] = [];
  for (const container of containers) {
    for (const candidate of findDirectLocalsWithinNode(
      locals,
      member,
      container,
      context,
      context.sup.normalizeIdentifier,
    )) {
      if (!matches.includes(candidate)) matches.push(candidate);
    }
  }
  return matches;
}

async function findReceiverMemberDefinition(
  index: ProjectIndex,
  locals: readonly SymbolDef[],
  member: string,
  receiverDef: SymbolDef,
  container: SyntaxNodeLike,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
  memberScope: ReceiverMemberScope = "any",
  knownArgumentCount?: number,
): Promise<SymbolDef | undefined> {
  const memberPredicate =
    memberScope === "any"
      ? undefined
      : (local: SymbolDef) => matchesReceiverMemberScope(local, memberScope, targetContext, container);
  if (
    (targetContext.sup.id === "ts" || targetContext.sup.id === "tsx") &&
    (container.type === "internal_module" || container.type === "module")
  ) {
    const candidates = findTypeScriptNamespaceMemberCandidates(locals, member, receiverDef, targetContext);
    const selected = selectMember([receiverDef], indexedMemberModel(index, candidates, targetContext.sup.id), {
      name: member,
      argumentCount: knownArgumentCount ?? null,
      scope: "any",
      useFile: receiverDef.file,
      keepUniqueArityMismatch: true,
    });
    return selected.status === "unique" ? selected.member : undefined;
  }
  const allReceiverMatches = typescriptMergedInterfaceMemberCandidates(
    locals,
    member,
    receiverDef,
    container,
    targetContext,
    normalizeIdentifier,
    memberPredicate,
  );
  if (targetContext.sup.id === "csharp" || targetContext.sup.id === "swift") {
    const shared = await findSharedOwnerMemberDefinitions({
      index,
      ownerFile: receiverDef.file,
      ownerContainer: container,
      ownerSource: targetContext.source,
      languageId: targetContext.sup.id,
      member,
      memberScope,
    });
    for (const hit of shared) {
      if (!allReceiverMatches.includes(hit)) allReceiverMatches.push(hit);
    }
  }
  if (allReceiverMatches.length) {
    const selected = selectMember([receiverDef], indexedMemberModel(index, allReceiverMatches, targetContext.sup.id), {
      name: member,
      argumentCount: knownArgumentCount ?? null,
      scope: "any",
      useFile: receiverDef.file,
      phpCaseInsensitive: targetContext.sup.id === "php",
      normalizeIdentifier: targetContext.sup.id === "swift" ? normalizeIdentifier : undefined,
      keepUniqueArityMismatch: true,
    });
    return selected.status === "unique" ? selected.member : undefined;
  }
  if (targetContext.sup.id === "rust") {
    return selectRustReceiverMember(index, receiverDef, member, targetContext, locals, knownArgumentCount);
  }
  if (targetContext.sup.id === "go") {
    return selectGoReceiverMember(
      index,
      receiverDef,
      member,
      targetContext.sup.normalizeIdentifier,
      knownArgumentCount,
    );
  }
  if (targetContext.sup.id === "kotlin") {
    const extensionMatches = kotlinExtensionFunctionsNamedOnType(
      locals,
      member,
      receiverDef.localName,
      targetContext,
      normalizeIdentifier,
    );
    if (extensionMatches.length) {
      const selected = selectMember([receiverDef], indexedMemberModel(index, extensionMatches, targetContext.sup.id), {
        name: member,
        argumentCount: knownArgumentCount ?? null,
        scope: "any",
        useFile: receiverDef.file,
        keepUniqueArityMismatch: true,
      });
      return selected.status === "unique" ? selected.member : undefined;
    }
  }
  return undefined;
}

function findLocalsWithinNode(
  locals: readonly SymbolDef[],
  member: string,
  node: SyntaxNodeLike,
  normalizeIdentifier: (name: string) => string = (name) => name,
  predicate?: (local: SymbolDef) => boolean,
): SymbolDef[] {
  const containerStart = node.startIndex;
  const containerEnd = node.endIndex;
  const normalizedMember = normalizeIdentifier(member);
  return locals.filter((local) => {
    const startIndex = local.range.start.index;
    const endIndex = local.range.end.index;
    return (
      normalizeIdentifier(local.localName) === normalizedMember &&
      startIndex !== undefined &&
      endIndex !== undefined &&
      startIndex >= containerStart &&
      endIndex <= containerEnd &&
      (!predicate || predicate(local))
    );
  });
}

function matchesReceiverMemberScope(
  local: SymbolDef,
  memberScope: ReceiverMemberScope,
  targetContext: ParsedFileContext,
  container: SyntaxNodeLike,
): boolean {
  if (memberScope === "any") return true;
  return hasStaticModifier(local, targetContext, container) === (memberScope === "static");
}

/**
 * Whether a member found for a receiverless call can accept that call's argument count. Unknown
 * counts and unknown arities accept.
 */
export function memberAcceptsCallAt(
  index: ProjectIndex,
  member: SymbolDef,
  callee: SyntaxNodeLike,
  source: string,
  languageId: string,
): boolean {
  const argumentCount = getCallArgumentCount({ languageId, source, call: callee.parent ?? callee });
  if (argumentCount === null) return true;
  return receiverMemberAcceptsArgumentCount(index, member, argumentCount) !== false;
}

function receiverMemberAcceptsArgumentCount(
  index: ProjectIndex,
  def: SymbolDef,
  argumentCount: number,
): boolean | undefined {
  const languageId = supportForFileWithoutHeaderSample(def.file, index.languageExtensions)?.id;
  if (!languageId) return undefined;
  const callable =
    def.callable ??
    index.byFile
      .get(fileIdentityKey(def.file))
      ?.locals.find((local) => local.range.start.index === def.range.start.index && local.localName === def.localName)
      ?.callable;
  const range =
    memberLookupBinding(languageId) === "unbound" ? (callable?.unboundArity ?? callable?.arity) : callable?.arity;
  if (!range) return undefined;
  return argumentCount >= range.minArgs && (range.maxArgs === null || argumentCount <= range.maxArgs);
}

/** Indexed owner membership and callable facts for direct and merged-owner lookup. */
function indexedMemberModel(
  index: ProjectIndex,
  members: readonly SymbolDef[],
  languageId: string,
): MemberModel<SymbolDef, SymbolDef> {
  return {
    ownerKey: definitionIdentityKey,
    members: () => members,
    supertypes: () => [],
    name: (def) => def.localName,
    key: (def) => def.callable?.key ?? definitionIdentityKey(def),
    callable: (def) => {
      const facts =
        def.callable ??
        index.byFile
          .get(fileIdentityKey(def.file))
          ?.locals.find(
            (local) => local.range.start.index === def.range.start.index && local.localName === def.localName,
          )?.callable;
      if (!facts || memberLookupBinding(languageId) !== "unbound" || !facts.unboundArity) return facts;
      return { ...facts, arity: facts.unboundArity };
    },
    scope: () => "any",
    visible: () => true,
  };
}

function hasStaticModifier(local: SymbolDef, targetContext: ParsedFileContext, container: SyntaxNodeLike): boolean {
  const position = {
    row: local.range.start.line - 1,
    column: local.range.start.column - 1,
  };
  let current: SyntaxNodeLike | null = targetContext.tree.rootNode.descendantForPosition(position, position);
  if (declarationIsStaticEquivalent(targetContext.sup.id, current)) return true;
  while (current && current !== container) {
    if (targetContext.sup.id === "php" && (current.type === "const_declaration" || current.type === "enum_case"))
      return true;
    if (declarationNodeIsStatic(current, targetContext.source)) return true;
    current = current.parent;
  }
  return false;
}

const NESTED_MEMBER_LOCAL_CONTAINERS = new Set([
  "formal_parameters",
  "parameter_list",
  "parameters",
  "block",
  "class",
  "class_declaration",
  "class_definition",
  "constructor_declaration",
  "enum_declaration",
  "enum_item",
  "enum_specifier",
  "function_declaration",
  "function_definition",
  "function_item",
  "interface_declaration",
  "method",
  "method_declaration",
  "method_definition",
  "module",
  "statement_block",
]);

function matchesReceiverMemberName(
  local: SymbolDef,
  normalizedMember: string,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
): boolean {
  const localName = normalizeIdentifier(local.localName);
  if (targetContext.sup.id === "php") {
    return comparePhpReferenceNames(normalizedMember, localName, { symbolKind: local.kind }) === "equivalent";
  }
  return localName === normalizedMember;
}

function findDirectLocalsWithinNode(
  locals: readonly SymbolDef[],
  member: string,
  container: SyntaxNodeLike,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
  predicate?: (local: SymbolDef) => boolean,
): SymbolDef[] {
  const normalizedMember = normalizeIdentifier(member);
  return directLocalsWithinNode(
    locals,
    container,
    targetContext,
    (local) => matchesReceiverMemberName(local, normalizedMember, targetContext, normalizeIdentifier),
    predicate,
  );
}

/** The locals `accepts` that `container` declares directly, not those of a nested member, function, or type. */
function directLocalsWithinNode(
  locals: readonly SymbolDef[],
  container: SyntaxNodeLike,
  targetContext: ParsedFileContext,
  accepts: (local: SymbolDef) => boolean,
  predicate?: (local: SymbolDef) => boolean,
): SymbolDef[] {
  const matches: SymbolDef[] = [];
  const containerStart = container.startIndex;
  const containerEnd = container.endIndex;
  for (const local of locals) {
    const startIndex = local.range.start.index;
    const endIndex = local.range.end.index;
    if (
      !accepts(local) ||
      startIndex === undefined ||
      endIndex === undefined ||
      startIndex < containerStart ||
      endIndex > containerEnd
    ) {
      continue;
    }
    const start = local.range.start;
    const position = {
      row: start.line - 1,
      column: start.column - 1,
    };
    let current = targetContext.tree.rootNode.descendantForPosition(position, position).parent;
    let isDeclarationParent = true;
    while (current && current !== container) {
      const isDirectBody =
        (current.type === "statement_block" || current.type === "block") && current.parent === container;
      // A transparent container (Kotlin's `companion object`) donates its body's members to its
      // own enclosing class; the grammar never lets one nest under any other declaration, so its
      // body never counts as evidence of a foreign nested class here.
      const isTransparentBody =
        current.type === "class_body" &&
        !!current.parent &&
        TRANSPARENT_MEMBER_CONTAINER_TYPES[current.parent.type] === true;
      const definingDeclarator =
        current.type === "function_definition" ? current.childForFieldName("declarator") : null;
      const isOwnFunctionDeclaration =
        !!definingDeclarator && definingDeclarator.startIndex <= startIndex && definingDeclarator.endIndex >= endIndex;
      if (
        !isDeclarationParent &&
        !isDirectBody &&
        !isOwnFunctionDeclaration &&
        !isTransparentBody &&
        ((current.type === "class_body" && current.parent !== container) ||
          NESTED_MEMBER_LOCAL_CONTAINERS.has(current.type))
      ) {
        current = null;
        break;
      }
      isDeclarationParent = false;
      current = current.parent;
    }
    if (current && (!predicate || predicate(local))) matches.push(local);
  }
  return matches;
}

function appendDirectKeywordMembers(
  locals: readonly SymbolDef[],
  member: string,
  container: SyntaxNodeLike,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
  predicate: ((local: SymbolDef) => boolean) | undefined,
  matches: SymbolDef[],
): void {
  const containerStart = container.startIndex;
  const containerEnd = container.endIndex;
  const normalizedMember = normalizeIdentifier(member);
  for (const local of locals) {
    const startIndex = local.range.start.index;
    const endIndex = local.range.end.index;
    if (
      !matchesReceiverMemberName(local, normalizedMember, targetContext, normalizeIdentifier) ||
      startIndex === undefined ||
      endIndex === undefined ||
      startIndex < containerStart ||
      endIndex > containerEnd
    ) {
      continue;
    }
    const start = local.range.start;
    const position = {
      row: start.line - 1,
      column: start.column - 1,
    };
    const declarationNode = targetContext.tree.rootNode.descendantForPosition(position, position);
    if (!isDirectKeywordMemberDeclaration(declarationNode, container) || (predicate && !predicate(local))) {
      continue;
    }
    matches.push(local);
  }
}

const SWIFT_PARAMETER_OWNER_TYPES: Record<string, true> = {
  init_declaration: true,
  function_declaration: true,
  deinit_declaration: true,
  subscript_declaration: true,
  lambda_literal: true,
  protocol_function_declaration: true,
};

/**
 * Swift parameters and function-body locals share the type's byte span, but
 * `self.name` names the member. A parameter or local that shadows the bare name
 * is not a member candidate. Only `simple_identifier` names are Swift.
 */
function isSwiftShadowingNonMember(declarationNode: SyntaxNodeLike): boolean {
  if (declarationNode.type !== "simple_identifier") return false;
  let current: SyntaxNodeLike | null = declarationNode.parent;
  while (current) {
    if (current.type === "parameter" && current.parent && SWIFT_PARAMETER_OWNER_TYPES[current.parent.type]) {
      return true;
    }
    if (
      current.type === "function_body" ||
      current.type === "lambda_literal" ||
      current.type === "computed_property" ||
      current.type === "willset_didset_block"
    ) {
      return true;
    }
    if (
      current.type === "class_declaration" ||
      current.type === "protocol_declaration" ||
      current.type === "enum_class_body"
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

/** Parameter lists whose entries are locals of the function, not members of its type. */
const PARAMETER_LIST_TYPES = new Set([
  "formal_parameters",
  "parameter_list",
  "parameters",
  "function_value_parameters",
]);

/**
 * A parameter that also declares a property of the enclosing type: a TypeScript parameter
 * property (`constructor(readonly path: string)`) or a PHP promoted constructor property.
 */
function isPropertyParameter(declarationNode: SyntaxNodeLike, list: SyntaxNodeLike): boolean {
  let parameter: SyntaxNodeLike | null = declarationNode;
  while (parameter && parameter.parent !== list) parameter = parameter.parent;
  if (!parameter) return false;
  if (parameter.type === "property_promotion_parameter") return true;
  return parameter.namedChildren.some(
    (child) =>
      child.type === "accessibility_modifier" || child.type === "override_modifier" || child.text === "readonly",
  );
}

export function isDirectKeywordMemberDeclaration(declarationNode: SyntaxNodeLike, container: SyntaxNodeLike): boolean {
  if (isSwiftShadowingNonMember(declarationNode)) return false;
  if (nearestMemberContainer(declarationNode) !== container) return false;
  let functionDepth = 0;
  let current: SyntaxNodeLike | null = declarationNode;
  while (current && current !== container) {
    // Swift local functions can nest inside a member; only the outer function is a member.
    if (current.type === "function_declaration" && ++functionDepth > 1) return false;
    const isMethodBody =
      (current.type === "block" || current.type === "compound_statement" || current.type === "statement_block") &&
      current.parent !== container;
    if (isMethodBody) return false;
    // A method parameter is a local of that method, unless it also declares a property.
    if (PARAMETER_LIST_TYPES.has(current.type)) return isPropertyParameter(declarationNode, current);
    current = current.parent;
  }
  return current === container;
}

/**
 * Every Rust `impl` block whose self type is `typeName`, across inherent (`impl Circle`),
 * trait (`impl Shape for Circle`), and generic (`impl<T> Box<T>`) forms. The shared
 * self-type extraction keeps navigation and detailed-graph member ownership in agreement.
 */
function findRustImplsForType(
  root: SyntaxNodeLike,
  typeName: string,
  source: string,
  sup: LanguageSupport,
): SyntaxNodeLike[] {
  const normalized = sup.normalizeIdentifier(typeName);
  const found: SyntaxNodeLike[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === "impl_item") {
      const selfType = rustImplSelfTypeNode(node, sup);
      if (selfType && sup.normalizeIdentifier(sliceText(selfType, source)) === normalized) found.push(node);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return found;
}

async function selectRustReceiverMember(
  index: ProjectIndex,
  receiverDef: SymbolDef,
  member: string,
  context: ParsedFileContext,
  locals: readonly SymbolDef[],
  knownArgumentCount?: number,
): Promise<SymbolDef | undefined> {
  const inherent: SymbolDef[] = [];
  const implemented: SymbolDef[] = [];
  const traitMembers = new Map<string, SymbolDef[]>();
  const traitOwners: string[] = [];
  const module = index.byFile.get(fileIdentityKey(receiverDef.file));
  if (!module) return undefined;
  for (const impl of findRustImplsForType(context.tree.rootNode, receiverDef.localName, context.source, context.sup)) {
    const self = rustImplSelfTypeNode(impl, context.sup);
    const trait = impl.namedChildren.find((child) => child.type === "type_identifier" && child.id !== self?.id);
    const target = trait ? implemented : inherent;
    appendDirectKeywordMembers(locals, member, impl, context, context.sup.normalizeIdentifier, undefined, target);
    if (!trait) continue;
    const traitName = sliceText(trait, context.source);
    const traitDef = resolveNamedMemberContainer(index, module, traitName, context.sup.normalizeIdentifier);
    if (!traitDef) continue;
    const ref = await keywordClassRefFromDef(index, traitDef);
    if (!ref || ref.container.type !== "trait_item") continue;
    const key = definitionIdentityKey(traitDef);
    if (traitMembers.has(key)) continue;
    const matches: SymbolDef[] = [];
    appendDirectKeywordMembers(
      ref.module.locals,
      member,
      ref.container,
      ref.context,
      ref.context.sup.normalizeIdentifier,
      undefined,
      matches,
    );
    traitMembers.set(key, matches);
    traitOwners.push(key);
  }
  const model: MemberModel<string, SymbolDef> = {
    ownerKey: (owner) => owner,
    members: (owner) => {
      if (owner === "inherent") return inherent;
      if (owner === "implemented") return implemented;
      return traitMembers.get(owner) ?? [];
    },
    supertypes: (owner) => {
      if (owner === "type") return ["inherent"];
      if (owner === "inherent") return ["implemented"];
      return owner === "implemented" ? traitOwners : [];
    },
    name: (def) => context.sup.normalizeIdentifier(def.localName),
    key: (def) => def.callable?.key ?? definitionIdentityKey(def),
    callable: (def) => def.callable,
    scope: () => "any",
    visible: () => true,
  };
  const selected = selectMember(["type"], model, {
    name: context.sup.normalizeIdentifier(member),
    argumentCount: knownArgumentCount ?? null,
    scope: "any",
    useFile: receiverDef.file,
    keepUniqueArityMismatch: true,
  });
  return selected.status === "unique" ? selected.member : undefined;
}

function goMethodReceiverTypeName(methodNode: SyntaxNodeLike, source: string, sup: LanguageSupport): string | null {
  const receiver = methodNode.childForFieldName("receiver");
  if (!receiver) return null;
  const parameter =
    receiver.namedChildren.find((child) => child.type === "parameter_declaration") ?? receiver.namedChildren[0] ?? null;
  const typeNode = parameter?.childForFieldName("type") ?? null;
  if (!typeNode) return null;
  const named = unwrapNamedType(typeNode, sup);
  return named ? sliceText(named, source) : null;
}

function goTypeSpecNamed(
  root: SyntaxNodeLike,
  typeName: string,
  source: string,
  normalizeIdentifier: (name: string) => string,
): SyntaxNodeLike | null {
  const normalized = normalizeIdentifier(typeName);
  let found: SyntaxNodeLike | null = null;
  const visit = (node: SyntaxNodeLike): boolean => {
    if (node.type === "type_spec") {
      const name = node.childForFieldName("name");
      if (name && normalizeIdentifier(sliceText(name, source)) === normalized) {
        found = node;
        return false;
      }
    }
    for (const child of node.namedChildren) {
      if (!visit(child)) return false;
    }
    return true;
  };
  visit(root);
  return found;
}

function goEmbeddedTypeNames(
  typeName: string,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
): string[] {
  const spec = goTypeSpecNamed(targetContext.tree.rootNode, typeName, targetContext.source, normalizeIdentifier);
  if (!spec) return [];
  const typeNode = spec.childForFieldName("type");
  if (!typeNode) return [];
  const names: string[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === "field_declaration") {
      if (node.childForFieldName("name")) return;
      const fieldType = node.childForFieldName("type");
      const named = fieldType ? unwrapNamedType(fieldType, targetContext.sup) : null;
      if (named) names.push(sliceText(named, targetContext.source));
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(typeNode);
  return names;
}

function goMethodsNamedOnType(
  locals: readonly SymbolDef[],
  member: string,
  typeName: string,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
): SymbolDef[] {
  const matches: SymbolDef[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === "method_declaration") {
      const receiverType = goMethodReceiverTypeName(node, targetContext.source, targetContext.sup);
      if (receiverType && normalizeIdentifier(receiverType) === normalizeIdentifier(typeName)) {
        for (const local of findLocalsWithinNode(locals, member, node, normalizeIdentifier)) {
          if (!matches.includes(local)) matches.push(local);
        }
      }
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(targetContext.tree.rootNode);
  return matches;
}

/**
 * Kotlin extension functions declared `fun Type.member()` for a receiver type, searched across
 * the receiver type's own declaring file the same way `goMethodsNamedOnType` searches Go's file
 * for a receiver method. An ordinary class member never carries a receiver-type prefix, so this
 * never matches a real member and cannot shadow one.
 */
function kotlinExtensionFunctionsNamedOnType(
  locals: readonly SymbolDef[],
  member: string,
  typeName: string,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
): SymbolDef[] {
  const matches: SymbolDef[] = [];
  const normalizedType = normalizeIdentifier(typeName);
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === "function_declaration") {
      const receiverType = kotlinExtensionReceiverTypeNode(node, targetContext.sup);
      if (receiverType && normalizeIdentifier(sliceText(receiverType, targetContext.source)) === normalizedType) {
        for (const local of findLocalsWithinNode(locals, member, node, normalizeIdentifier)) {
          if (!matches.includes(local)) matches.push(local);
        }
      }
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(targetContext.tree.rootNode);
  return matches;
}

async function selectGoReceiverMember(
  index: ProjectIndex,
  receiverDef: SymbolDef,
  member: string,
  normalizeIdentifier: (name: string) => string,
  knownArgumentCount?: number,
): Promise<SymbolDef | undefined> {
  const peers = getCompilationUnitPeers(index, receiverDef.file).files;
  const files = await Promise.all(
    [...peers].map(async (file) => {
      const module = index.byFile.get(fileIdentityKey(file));
      if (!module) return null;
      const context = await ensureParsedContextForIndex(index, file);
      return context.sup.id === "go" ? { module, context } : null;
    }),
  );
  const contexts = files.filter((file) => file !== null);
  const members = new Map<string, SymbolDef[]>();
  const embedded = new Map<string, string[]>();
  const seen = new Set<string>();
  let level = [receiverDef.localName];
  for (let depth = 0; depth < RECEIVER_HIERARCHY_DEPTH && level.length; depth += 1) {
    const next: string[] = [];
    for (const typeName of level) {
      if (seen.has(typeName)) continue;
      seen.add(typeName);
      const matches: SymbolDef[] = [];
      const bases: string[] = [];
      for (const { module, context } of contexts) {
        const normalize = context.sup.normalizeIdentifier;
        matches.push(...goMethodsNamedOnType(module.locals, member, typeName, context, normalize));
        const spec = goTypeSpecNamed(context.tree.rootNode, typeName, context.source, normalize);
        if (!spec) continue;
        matches.push(
          ...findDirectLocalsWithinNode(module.locals, member, spec, context, normalize).filter((def) => def.isMember),
        );
        for (const base of goEmbeddedTypeNames(typeName, context, normalize)) {
          if (!bases.includes(base)) bases.push(base);
          if (!seen.has(base) && !next.includes(base)) next.push(base);
        }
      }
      members.set(typeName, matches);
      embedded.set(typeName, bases);
    }
    level = next;
  }
  const model: MemberModel<string, SymbolDef> = {
    ownerKey: (owner) => owner,
    members: (owner) => members.get(owner) ?? [],
    supertypes: (owner) => embedded.get(owner) ?? [],
    name: (def) => normalizeIdentifier(def.localName),
    key: (def) => def.callable?.key ?? definitionIdentityKey(def),
    callable: (def) => def.callable,
    scope: () => "any",
    visible: () => true,
  };
  const selected = selectMember([receiverDef.localName], model, {
    name: normalizeIdentifier(member),
    argumentCount: knownArgumentCount ?? null,
    scope: "any",
    useFile: receiverDef.file,
    keepUniqueArityMismatch: true,
  });
  return selected.status === "unique" ? selected.member : undefined;
}

type PythonClassRef = {
  def: SymbolDef;
  container: SyntaxNodeLike;
  context: ParsedFileContext;
  module: ModuleIndex;
};

type PythonParsedFileLoader = (file: string) => Promise<ParsedFileContext | null>;

type PythonReceiverResolutionCache = {
  classRefs: Map<string, Promise<PythonClassRef | null>>;
  members: Map<string, Promise<SymbolDef | undefined>>;
};

export function createPythonReceiverResolutionCache(): PythonReceiverResolutionCache {
  return { classRefs: new Map(), members: new Map() };
}

async function resolvePythonReceiverMember(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  obj: SyntaxNodeLike,
  member: string,
  source: string,
  sup: LanguageSupport,
  resolveExpression: (expr: SyntaxNodeLike) => Promise<ResolvedExport | null>,
  proof: ReceiverBinding | null,
  loadParsedFile: PythonParsedFileLoader | undefined,
  cache: PythonReceiverResolutionCache | undefined,
): Promise<SymbolDef | undefined> {
  const classRef = await pythonReceiverClassRef(
    index,
    mod,
    node,
    obj,
    source,
    sup,
    resolveExpression,
    proof,
    loadParsedFile,
    cache,
  );
  if (!classRef) return undefined;
  return lookupPythonClassMember(
    index,
    classRef.ref,
    member,
    classRef.startAtSupertype,
    classRef.preferInstanceAttributes,
    loadParsedFile,
    cache,
  );
}

type PythonReceiverClassRef = { ref: PythonClassRef; startAtSupertype: boolean; preferInstanceAttributes: boolean };

async function pythonReceiverClassRef(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  obj: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  resolveExpression: (expr: SyntaxNodeLike) => Promise<ResolvedExport | null>,
  proof: ReceiverBinding | null,
  loadParsedFile: PythonParsedFileLoader | undefined,
  cache: PythonReceiverResolutionCache | undefined,
): Promise<PythonReceiverClassRef | null> {
  const receiver = proof ?? classifyReceiver(sup, obj, source, null, 0, obj.parent ?? obj, noLexicalBinding);
  if (receiver.kind === "own-type" || receiver.kind === "supertype") {
    const container = findEnclosingClassContainer(node);
    if (!container) return null;
    const nameNode = container.childForFieldName("name");
    if (!nameNode) return null;
    const className = sliceText(nameNode, source);
    const def = mod.locals.find((local) => {
      const startIndex = local.range.start.index;
      const endIndex = local.range.end.index;
      return (
        local.kind === SymbolKind.Class &&
        local.localName === className &&
        startIndex !== undefined &&
        endIndex !== undefined &&
        startIndex >= container.startIndex &&
        endIndex <= container.endIndex
      );
    });
    if (!def) return null;
    const ref = await pythonClassRefFromDef(index, def, loadParsedFile, cache);
    const preferInstanceAttributes = receiver.kind === "own-type" && sliceText(obj, source) === "self";
    return ref ? { ref, startAtSupertype: receiver.kind === "supertype", preferInstanceAttributes } : null;
  }

  let classDef: SymbolDef | undefined;
  const constructor = receiver.kind === "named-type" && receiver.proof !== "static-type" ? receiver.typeNode : null;
  if (constructor && bindsTypeParameter(sliceText(constructor, source), constructor, source, sup)) return null;
  const preferInstanceAttributes = receiver.kind === "named-type" && receiver.proof !== "static-type";
  if (constructor) {
    const result = await resolveExpression(constructor);
    if (result?.kind === "resolved" && result.def.kind === SymbolKind.Class) {
      classDef = result.def;
    }
  }
  if (!classDef) {
    const direct = await resolveExpression(obj);
    if (direct?.kind === "resolved" && direct.def.kind === SymbolKind.Class) {
      classDef = direct.def;
    }
  }
  if (!classDef) return null;
  const ref = await pythonClassRefFromDef(index, classDef, loadParsedFile, cache);
  return ref ? { ref, startAtSupertype: false, preferInstanceAttributes } : null;
}

async function pythonClassRefFromDef(
  index: ProjectIndex,
  def: SymbolDef,
  loadParsedFile?: PythonParsedFileLoader,
  cache?: PythonReceiverResolutionCache,
): Promise<PythonClassRef | null> {
  const key = definitionIdentityKey(def);
  const cached = cache?.classRefs.get(key);
  if (cached) return cached;
  const pending = (async (): Promise<PythonClassRef | null> => {
    const module = index.byFile.get(fileIdentityKey(def.file));
    if (!module) return null;
    const context = loadParsedFile
      ? await loadParsedFile(def.file)
      : await ensureParsedContextForIndex(index, def.file);
    if (!context || context.sup.id !== "python") return null;
    const start = def.range.start;
    const position = {
      row: start.line - 1,
      column: start.column - 1,
    };
    let current: SyntaxNodeLike | null = context.tree.rootNode.descendantForPosition(position, position);
    while (current && current.type !== "class_definition") {
      current = current.parent;
    }
    if (!current) return null;
    return { def, container: current, context, module };
  })();
  cache?.classRefs.set(key, pending);
  return pending;
}

/** How a receiver lookup treats attributes assigned through `self.x = value`; see `pythonMembersOnClass`. */
type PythonInstanceAttributes = "prefer" | "fallback";

/** Whether `nameNode` names a class-level annotation without a value (`count: int`), which declares a type and binds nothing. */
function isPythonValuelessAnnotation(nameNode: SyntaxNodeLike): boolean {
  const assignment = nameNode.parent;
  return (
    assignment?.type === "assignment" &&
    assignment.childForFieldName("left")?.id === nameNode.id &&
    !assignment.childForFieldName("right")
  );
}

/** The `locals` of `classRef` that bind their name in the class namespace: every one but an annotation without a value. */
function pythonBindingLocals(classRef: PythonClassRef, locals: readonly SymbolDef[]): SymbolDef[] {
  return locals.filter((local) => {
    const nameNode = nameNodeForDef(classRef.context, local);
    return !nameNode || !isPythonValuelessAnnotation(nameNode);
  });
}

/**
 * The members of one class named `member`. `prefer` (`self` and constructed receivers) lets a property decide first and
 * then an instance attribute beat a class attribute of the same class; `fallback` reaches instance attributes only
 * when the class has no class-level member.
 */
function pythonMembersOnClass(
  classRef: PythonClassRef,
  member: string,
  instanceAttributes: PythonInstanceAttributes = "fallback",
): SymbolDef[] {
  const normalizeIdentifier = classRef.context.sup.normalizeIdentifier;
  let direct: SymbolDef[] | undefined;
  if (instanceAttributes === "prefer") {
    direct = findDirectLocalsWithinNode(
      classRef.module.locals,
      member,
      classRef.container,
      classRef.context,
      normalizeIdentifier,
    );
    const propertyMembers = pythonPropertyDescriptorMembers(classRef, member, direct);
    if (propertyMembers) return propertyMembers;
    const instanceAttributeMembers = findPythonInstanceAttributesWithinClass(
      classRef.module.locals,
      member,
      classRef.container,
      classRef.context,
      normalizeIdentifier,
      "self",
    );
    const selectedInstanceAttribute = preferredPythonInstanceAttribute(
      instanceAttributeMembers,
      classRef.container,
      classRef.context,
    );
    if (selectedInstanceAttribute) return [selectedInstanceAttribute];
  }
  direct ??= findDirectLocalsWithinNode(
    classRef.module.locals,
    member,
    classRef.container,
    classRef.context,
    normalizeIdentifier,
  );
  if (direct.length) return direct;
  return findPythonInstanceAttributesWithinClass(
    classRef.module.locals,
    member,
    classRef.container,
    classRef.context,
    normalizeIdentifier,
  );
}

/** What a function definition does to the property `member`: the role its decorators give it, `null` for a plain one. */
function pythonPropertyRole(
  decorators: readonly (PythonPropertyDecorator | null)[],
  member: string,
): "getter" | "setter" | "deleter" | null {
  for (const decorator of decorators) {
    if (decorator?.kind === "property") return "getter";
    if (decorator?.kind === "accessor" && decorator.propertyName === member) return decorator.accessor;
  }
  return null;
}

/**
 * What the class-level binding that `nameNode` names does to the property `member` holds: `property` makes a new one whose
 * getter is the binding (`property(...)`, `@property`, a replacing `@member.getter`), `update` changes the one an
 * earlier binding made (`@member.setter`, `@member.deleter`), `plain` replaces it with something else, and `annotation`
 * (`member: int`) binds nothing.
 */
function pythonPropertyBinding(
  classRef: PythonClassRef,
  nameNode: SyntaxNodeLike,
  member: string,
): "property" | "update" | "plain" | "annotation" {
  if (isPythonValuelessAnnotation(nameNode)) return "annotation";
  const assignment = nameNode.parent;
  if (assignment?.type === "assignment" && assignment.childForFieldName("left")?.id === nameNode.id) {
    const value = assignment.childForFieldName("right");
    const callee = value?.type === "call" ? value.childForFieldName("function") : null;
    const argumentsNode = value?.childForFieldName("arguments");
    return callee?.text === "property" && (argumentsNode?.namedChildren.length ?? 0) >= 1 ? "property" : "plain";
  }
  let functionNode: SyntaxNodeLike | null = nameNode;
  while (functionNode && functionNode.id !== classRef.container.id && functionNode.type !== "function_definition") {
    functionNode = functionNode.parent;
  }
  const decorated = functionNode?.type === "function_definition" ? functionNode.parent : null;
  const decorators =
    decorated?.type === "decorated_definition"
      ? decorated.namedChildren.filter((child) => child.type === "decorator")
      : [];
  const role = pythonPropertyRole(decorators.map(pythonPropertyDecorator), member);
  if (role === "getter") return "property";
  return role ? "update" : "plain";
}

/**
 * The property descriptor that `member` is in `classRef`, or `null` when it is not one. The class-level bindings of the
 * name run in source order and the last one decides what the name holds: `property(...)`, `@property`, and a replacing
 * `@member.getter` each make a new property whose getter is that definition, `@member.setter` and `@member.deleter` keep
 * the property an earlier binding made, so its getter stays the target, and any other binding replaces the property
 * (`count = 0` after `@property def count`). An annotation without a value binds nothing.
 */
function pythonPropertyDescriptorMembers(
  classRef: PythonClassRef,
  member: string,
  directMembers: readonly SymbolDef[],
): SymbolDef[] | null {
  let descriptor: SymbolDef | undefined;
  const inSourceOrder = [...directMembers].sort(
    (left, right) => (left.range.start.index ?? 0) - (right.range.start.index ?? 0),
  );
  for (const local of inSourceOrder) {
    const nameNode = nameNodeForDef(classRef.context, local);
    if (!nameNode) continue;
    const binding = pythonPropertyBinding(classRef, nameNode, member);
    if (binding === "property") descriptor = local;
    else if (binding === "update") descriptor ??= local;
    else if (binding === "plain") descriptor = undefined;
  }
  return descriptor ? [descriptor] : null;
}

function findPythonInstanceAttributesWithinClass(
  locals: readonly SymbolDef[],
  member: string,
  container: SyntaxNodeLike,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
  receiver?: "self" | "cls",
): SymbolDef[] {
  const matches: SymbolDef[] = [];
  const containerStart = container.startIndex;
  const containerEnd = container.endIndex;
  const normalizedMember = normalizeIdentifier(member);
  for (const local of locals) {
    const startIndex = local.range.start.index;
    const endIndex = local.range.end.index;
    if (
      normalizeIdentifier(local.localName) !== normalizedMember ||
      startIndex === undefined ||
      endIndex === undefined ||
      startIndex < containerStart ||
      endIndex > containerEnd
    ) {
      continue;
    }
    const start = local.range.start;
    const position = {
      row: start.line - 1,
      column: start.column - 1,
    };
    const nameNode = targetContext.tree.rootNode.descendantForPosition(position, position);
    if (!isPythonReceiverAttributeAssignmentName(nameNode)) continue;
    const object = nameNode.parent?.childForFieldName("object");
    if (receiver && object?.text !== receiver) continue;
    matches.push(local);
  }
  return matches;
}

function preferredPythonInstanceAttribute(
  attributes: readonly SymbolDef[],
  container: SyntaxNodeLike,
  context: ParsedFileContext,
): SymbolDef | undefined {
  let firstMethodAssignment: SymbolDef | undefined;
  let firstMethodStartIndex: number | undefined;
  let initializerAssignment: SymbolDef | undefined;
  let initializerStartIndex: number | undefined;
  for (const attribute of attributes) {
    const startIndex = attribute.range.start.index;
    if (startIndex === undefined) continue;
    const start = attribute.range.start;
    const position = {
      row: start.line - 1,
      column: start.column - 1,
    };
    let current: SyntaxNodeLike | null = context.tree.rootNode.descendantForPosition(position, position);
    let method: SyntaxNodeLike | null = null;
    let invalidMethodScope = false;
    while (current && current.id !== container.id) {
      if (current.type === "class_definition") {
        invalidMethodScope = true;
        break;
      }
      if (current.type === "function_definition") {
        if (method) {
          invalidMethodScope = true;
          break;
        }
        method = current;
      }
      current = current.parent;
    }
    if (invalidMethodScope || current?.id !== container.id || !method) continue;
    if (firstMethodStartIndex === undefined || startIndex < firstMethodStartIndex) {
      firstMethodAssignment = attribute;
      firstMethodStartIndex = startIndex;
    }
    if (method.childForFieldName("name")?.text !== "__init__") continue;
    if (initializerStartIndex === undefined || startIndex < initializerStartIndex) {
      initializerAssignment = attribute;
      initializerStartIndex = startIndex;
    }
  }
  return initializerAssignment ?? firstMethodAssignment;
}

/** The base specifiers of a Python class: each bare name, and each dotted `module.Name` as one qualified specifier. */
function pythonBaseSpecifierNodes(classNode: SyntaxNodeLike): SyntaxNodeLike[] {
  const bases =
    classNode.childForFieldName("superclasses") ??
    (classNode.namedChildren ?? []).find((child) => child.type === "argument_list");
  if (!bases) return [];
  const specifiers: SyntaxNodeLike[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    // A call computes its base (`Manager(BaseManager.from_queryset(QuerySet))`), so neither its callee chain nor its
    // arguments is a base, and a keyword or splat argument is never one.
    if (isNonBaseHeritageArgument(node) || isUnprovenHeritageExpression(node)) return;
    if (node.type === "identifier" || node.type === "attribute") {
      specifiers.push(node);
      return;
    }
    if (node.type === "subscript") {
      const value = node.childForFieldName("value");
      if (value) visit(value);
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(bases);
  return specifiers;
}

function resolvePythonNamedClass(index: ProjectIndex, mod: ModuleIndex, name: string): SymbolDef | undefined {
  const classes = mod.locals.filter((local) => local.kind === SymbolKind.Class && local.localName === name);
  const topLevel = classes.filter((local) => !local.isMember);
  const candidates = topLevel.length ? topLevel : classes;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return undefined;

  const explicitBinding = effectiveExplicitBinding(
    mod.imports,
    "python",
    (binding) => binding.kind === "named" && binding.local === name,
  );
  if (explicitBinding?.kind === "named") {
    const result = resolveImported(index, explicitBinding, explicitBinding.imported);
    if (result && !("namespace" in result) && result.kind === SymbolKind.Class) return result;
  }
  const starDecision = resolveStarImportedName(index, mod, "python", name);
  if (starDecision.status === "resolved") {
    return starDecision.definition.kind === SymbolKind.Class ? starDecision.definition : undefined;
  }
  const exported = resolveExport(index, mod.file, name, { preferredKind: SymbolKind.Class, allowLocalFallback: false });
  if (exported?.kind === "resolved" && exported.def.kind === SymbolKind.Class) return exported.def;
  return undefined;
}

/**
 * A dotted Python base (`other.Base`) is an attribute of the module the import binds to its leftmost name. The
 * attribute is read through that module's exports; its own last name is never looked up by itself.
 */
async function resolvePythonQualifiedBase(
  index: ProjectIndex,
  classRef: PythonClassRef,
  attribute: SyntaxNodeLike,
): Promise<SymbolDef | undefined> {
  const { source, sup } = classRef.context;
  const names = qualifiedBaseNames(sup, source, attribute);
  if (!names) return undefined;
  const [base, ...path] = names;
  const container = await resolveQualifiedMemberContainer(
    index,
    classRef.module,
    base!,
    path,
    sup.normalizeIdentifier,
    sup,
    { node: attribute, source, tree: classRef.context.tree },
  );
  return container?.kind === SymbolKind.Class ? container : undefined;
}

async function pythonBaseClassRefs(
  index: ProjectIndex,
  classRef: PythonClassRef,
  loadParsedFile: PythonParsedFileLoader | undefined,
  cache: PythonReceiverResolutionCache | undefined,
): Promise<PythonClassRef[]> {
  const specifiers = pythonBaseSpecifierNodes(classRef.container);
  const refs: PythonClassRef[] = [];
  const seen = new Set<string>();
  for (const specifier of specifiers) {
    const def =
      specifier.type === "attribute"
        ? await resolvePythonQualifiedBase(index, classRef, specifier)
        : resolvePythonNamedClass(index, classRef.module, sliceText(specifier, classRef.context.source));
    if (!def) continue;
    const key = definitionIdentityKey(def);
    if (seen.has(key)) continue;
    seen.add(key);
    const ref = await pythonClassRefFromDef(index, def, loadParsedFile, cache);
    if (ref) refs.push(ref);
  }
  return refs;
}

/**
 * What decides `self.<name>` in a class hierarchy; see `pythonPropertyPrecedence`. A property comes with the
 * definition that is its target.
 */
type PythonPropertyPrecedence = { kind: "property"; getter: SymbolDef } | { kind: "attribute" } | { kind: "unproven" };

/**
 * What decides `self.member` in `start`'s hierarchy: `property` when the first class that binds `member` at class level
 * binds a property, `attribute` when it binds anything else or no class binds it, and `unproven` when the method
 * resolution order would have to say. An annotation without a value (`member: int`) binds nothing. Python gives a
 * property (a data descriptor) precedence over the instance dictionary, so `self.member = value` writes through it
 * instead of declaring an attribute, while a plain class-level binding found first leaves the instance attribute in
 * charge. Along one chain of single bases the nearest binding is first. With several bases the order is not rebuilt: a
 * subclass always comes before its bases, so a binding class that no other binding class derives from comes first when
 * it is the only one, and with several of them it is not proven which does. A property is first only as that one class,
 * wherever it sits in the hierarchy, and it is the one whose getter answers.
 */
async function pythonPropertyPrecedence(
  index: ProjectIndex,
  start: PythonClassRef,
  member: string,
  loadParsedFile: PythonParsedFileLoader | undefined,
  cache: PythonReceiverResolutionCache | undefined,
): Promise<PythonPropertyPrecedence> {
  // The classes that bind `member`, each with the property its bindings make, or `null` when they make none.
  const declarations = new Map<string, SymbolDef | null>();
  const baseKeys = new Map<string, string[]>();
  const visited = new Set<string>([definitionIdentityKey(start.def)]);
  let level = [start];
  let singleChain = true;
  for (let depth = 0; depth < RECEIVER_HIERARCHY_DEPTH && level.length; depth += 1) {
    if (level.length > 1) singleChain = false;
    const next: PythonClassRef[] = [];
    for (const ref of level) {
      const key = definitionIdentityKey(ref.def);
      const bindings = pythonBindingLocals(
        ref,
        findDirectLocalsWithinNode(
          ref.module.locals,
          member,
          ref.container,
          ref.context,
          ref.context.sup.normalizeIdentifier,
        ),
      );
      if (bindings.length) declarations.set(key, pythonPropertyDescriptorMembers(ref, member, bindings)?.[0] ?? null);
      const bases = await pythonBaseClassRefs(index, ref, loadParsedFile, cache);
      baseKeys.set(
        key,
        bases.map((base) => definitionIdentityKey(base.def)),
      );
      for (const base of bases) {
        const baseKey = definitionIdentityKey(base.def);
        if (visited.has(baseKey)) continue;
        visited.add(baseKey);
        next.push(base);
      }
    }
    // On one chain of single bases the nearest declaration is first, so the walk ends at it.
    if (singleChain && declarations.size) break;
    level = next;
  }
  if (!declarations.size) return { kind: "attribute" };
  // A declaring class that another declaring class extends comes later in every order, so only the others can be first.
  const dominated = new Set<string>();
  for (const declaring of declarations.keys()) {
    const seen = new Set<string>();
    const pending = [...(baseKeys.get(declaring) ?? [])];
    while (pending.length) {
      const ancestor = pending.pop()!;
      if (seen.has(ancestor)) continue;
      seen.add(ancestor);
      if (declarations.has(ancestor)) dominated.add(ancestor);
      pending.push(...(baseKeys.get(ancestor) ?? []));
    }
  }
  const nearest = [...declarations].filter(([key]) => !dominated.has(key)).map(([, getter]) => getter);
  if (!nearest.length) return { kind: "unproven" };
  if (nearest.every((getter) => !getter)) return { kind: "attribute" };
  const [getter] = nearest;
  return nearest.length === 1 && getter ? { kind: "property", getter } : { kind: "unproven" };
}

async function lookupPythonClassMember(
  index: ProjectIndex,
  start: PythonClassRef,
  member: string,
  startAtSupertype = false,
  preferInstanceAttributes = false,
  loadParsedFile?: PythonParsedFileLoader,
  cache?: PythonReceiverResolutionCache,
): Promise<SymbolDef | undefined> {
  const key = `${definitionIdentityKey(start.def)}:${member}:${startAtSupertype}:${preferInstanceAttributes}`;
  const cached = cache?.members.get(key);
  if (cached) return cached;
  const pending = lookupPythonClassMemberUncached(
    index,
    start,
    member,
    startAtSupertype,
    preferInstanceAttributes,
    loadParsedFile,
    cache,
  );
  cache?.members.set(key, pending);
  return pending;
}

async function lookupPythonClassMemberUncached(
  index: ProjectIndex,
  start: PythonClassRef,
  member: string,
  startAtSupertype: boolean,
  preferInstanceAttributes: boolean,
  loadParsedFile: PythonParsedFileLoader | undefined,
  cache: PythonReceiverResolutionCache | undefined,
): Promise<SymbolDef | undefined> {
  const instanceAttributes: PythonInstanceAttributes = preferInstanceAttributes ? "prefer" : "fallback";
  if (preferInstanceAttributes) {
    // An inherited property takes the write `self.x = value` and the read after it, so no instance attribute shadows it,
    // and the class that binds it first answers, whichever level of the hierarchy it sits on.
    const precedence = await pythonPropertyPrecedence(index, start, member, loadParsedFile, cache);
    if (precedence.kind === "unproven") return undefined;
    if (precedence.kind === "property") return precedence.getter;
  }
  const membersByOwner = new Map<string, SymbolDef[]>();
  const parentsByOwner = new Map<string, PythonClassRef[]>();
  const visited = new Set<string>([definitionIdentityKey(start.def)]);
  let level = [start];
  for (let depth = 0; depth < RECEIVER_HIERARCHY_DEPTH && level.length; depth += 1) {
    let named = false;
    for (const ref of level) {
      const members = startAtSupertype && !depth ? [] : pythonMembersOnClass(ref, member, instanceAttributes);
      membersByOwner.set(definitionIdentityKey(ref.def), members);
      if (members.length) named = true;
    }
    if (named) break;
    const next: PythonClassRef[] = [];
    for (const ref of level) {
      const parents = await pythonBaseClassRefs(index, ref, loadParsedFile, cache);
      parentsByOwner.set(definitionIdentityKey(ref.def), parents);
      for (const parent of parents) {
        const key = definitionIdentityKey(parent.def);
        if (visited.has(key)) continue;
        visited.add(key);
        next.push(parent);
      }
    }
    level = next;
  }
  const model: MemberModel<PythonClassRef, SymbolDef> = {
    ownerKey: (ref) => definitionIdentityKey(ref.def),
    members: (ref) => membersByOwner.get(definitionIdentityKey(ref.def)) ?? [],
    supertypes: (ref) => parentsByOwner.get(definitionIdentityKey(ref.def)) ?? [],
    name: (def) => def.localName,
    key: (def) => def.callable?.key ?? definitionIdentityKey(def),
    callable: (def) => def.callable,
    scope: () => "any",
    visible: () => true,
  };
  const selected = selectMember([start], model, {
    name: member,
    argumentCount: null,
    scope: "any",
    useFile: start.def.file,
    startAtAncestor: startAtSupertype,
  });
  return selected.status === "unique" ? selected.member : undefined;
}
