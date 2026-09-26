import { CSHARP_SUPPORT, type LanguageSupport } from "../languages.js";
import { isJsTsLanguage } from "../languages/js-family.js";
import { isPythonReceiverAttributeAssignmentName } from "../languages/definitions/python.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { sliceText } from "../util/ast.js";
import { foldPhpIdentifierCase } from "../util/identifiers.js";
import { fileIdentityKey } from "../util/paths.js";
import {
  collectMemberAccessChain,
  getMemberAccessParts,
  getNavigationExpressionProperty,
  isMemberAccessNode,
  isReceiverNameNode,
  memberAccessTraversalTypes,
  receiverKeywordText,
} from "../util/member-access.js";
import {
  keywordReceiverKind,
  MEMBER_ACCESS_ROWS,
  supportsReceiverMemberNavigation,
} from "../util/member-access-tables.js";
import { cppCallableShapeForNode } from "./cpp-callables.js";
import { earliestSymbolDef, typescriptCallableRoleAt } from "./ts-callables.js";
import {
  classifyReceiver,
  cppOutOfLineOwnerPath,
  cppQualifiedNameSegments,
  declarationNodeIsStatic,
  declaresMembers,
  hasStaticMemberDistinction,
  memberContainerDef,
  nearestMemberContainer,
  keywordReceiverCrossesDynamicBoundary,
  isUnprovenHeritageExpression,
  keywordReceiverMemberScope,
  kotlinExtensionReceiverTypeNode,
  nodeInStaticMemberContext,
  receiverConstructorExpression,
  rustImplSelfTypeNode,
  TRANSPARENT_MEMBER_CONTAINER_TYPES,
  unwrapNamedType,
  type PhpObjectCreationKeyword,
  type ReceiverMemberScope,
} from "../graphs/symbol-graph-detailed/receiver-calls.js";
import {
  getCallableArity,
  getCallArgumentCount,
  memberLookupBinding,
  type CallableArity,
} from "../languages/callable-arity.js";
import { getCompilationUnitPeers } from "./compilation-units.js";
import {
  isExportedDeclaration,
  isGoExportedMemberName,
  isSwiftCrossFileHiddenSharedOwnerMember,
} from "./declaration-visibility.js";
import { ensureParsedContext, type ParsedFileContext } from "./parse-context.js";
import { csharpLookupName, csharpQualifiedNameNode, resolveNamedDefinition } from "./navigation-local.js";
import { resolveCppQualifiedMemberContainer } from "./navigation-cpp.js";
import { okGoToResult } from "./navigation-provenance.js";
import { comparePhpReferenceNames, findPhpImportAlias } from "./navigation-php.js";
import { resolveIndexedPhpClassReference, resolvePhpNamespaceSymbol } from "./php-namespace-symbols.js";
import {
  cjsRequireValueBinding,
  memberContainerForDefinition,
  resolveExport,
  resolveImported,
  resolvePhpExportByImportType,
  resolvePythonSubmodule,
} from "./navigation-resolve.js";
import {
  CSHARP_PARTIAL_CONTAINER_TYPES,
  getSharedOwnerIdentity,
  isSwiftExtensionContainer,
  sharedOwnerCanUseMembers,
} from "./shared-owner-identity.js";
import {
  SymbolKind,
  type GoToResult,
  type ImportBinding,
  type ModuleIndex,
  type ProjectIndex,
  type ResolvedExport,
  type SymbolDef,
} from "./types.js";

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
    if (root.type === "class_declaration") out.push(root);
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
  const units: ModuleIndex[] = [];
  for (const file of peers.files) {
    const peer = index.byFile.get(fileIdentityKey(file));
    if (peer) units.push(peer);
  }
  for (const peer of units) {
    let peerContext: ParsedFileContext;
    try {
      peerContext = await ensureParsedContext(
        peer.file,
        index.parsed?.get(fileIdentityKey(peer.file)),
        index.languageExtensions,
      );
    } catch {
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
    context = await ensureParsedContext(
      def.file,
      index.parsed?.get(fileIdentityKey(def.file)),
      index.languageExtensions,
    );
  } catch {
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
    context = await ensureParsedContext(
      def.file,
      index.parsed?.get(fileIdentityKey(def.file)),
      index.languageExtensions,
    );
  } catch {
    return [];
  }
  if (context.sup.id !== "csharp") return [];
  const start = def.range.start;
  const nameNode = context.tree.rootNode.descendantForPosition(
    { row: start.line - 1, column: start.column - 1 },
    { row: start.line - 1, column: start.column - 1 },
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
  const position = { row: start.line - 1, column: start.column - 1 };
  return context.tree.rootNode.descendantForPosition(position, position);
}

function enclosingImportScope(declarationName: SyntaxNodeLike): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = declarationName;
  while (current && current.type !== "variable_declaration" && current.type !== "using_directive") {
    current = current.parent;
  }
  return current?.parent ?? null;
}

/**
 * Rewrites a valid C# `using X = Namespace; X::Target` lookup into the dotted form
 * export resolution already understands. `global::` and ordinary dotted names keep
 * their source spelling; an unknown alias stays `X::Target` instead of a bare name.
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
  if (!chainNode || !raw.includes("::")) return raw;
  const names: string[] = [];
  let current: SyntaxNodeLike | null = chainNode;
  let base: SyntaxNodeLike | null = null;
  while (current && (current.type === "qualified_name" || current.type === "alias_qualified_name")) {
    const parts = getMemberAccessParts(CSHARP_SUPPORT, current);
    base = parts.object ?? base;
    let property = parts.property;
    if (property?.type === "generic_name") {
      property = property.childForFieldName("name") ?? property.namedChildren[0] ?? property;
    }
    if (property?.type === "identifier") names.push(sliceText(property, source));
    current = base;
  }
  if (!base || !isReceiverNameNode(CSHARP_SUPPORT, base.type) || !names.length) return raw;
  const alias = sliceText(base, source);
  if (alias === "global") return raw;
  const imported = innermostNamespaceImport(imports, alias, base, CSHARP_SUPPORT.normalizeIdentifier);
  if (!imported) return raw;
  return `${imported.from}.${[...names].reverse().join(".")}`;
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
    let nameNode = root;
    for (;;) {
      const child = nameNode.namedChildren.find(
        (candidate) => candidate.startIndex <= start && start < candidate.endIndex,
      );
      if (!child) break;
      nameNode = child;
    }
    const scope = enclosingImportScope(nameNode);
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

function rubyScopeResolutionPath(node: SyntaxNodeLike, source: string): { path: string; root: string } | null {
  if (node.type !== "constant") return null;
  const owner = node.parent;
  if (owner?.type !== "scope_resolution") return null;
  const ownerName = owner.childForFieldName("name");
  if (!ownerName || ownerName.startIndex !== node.startIndex || ownerName.endIndex !== node.endIndex) return null;
  // `Outer::Inner::Tool` nests scope_resolution on `scope`, so flatten from the
  // clicked name instead of stopping at the first nested scope.
  const segments: string[] = [];
  let current: SyntaxNodeLike | null = owner;
  while (current?.type === "scope_resolution") {
    const name = current.childForFieldName("name");
    const scope = current.childForFieldName("scope");
    if (!name || name.type !== "constant") return null;
    const text = sliceText(name, source);
    if (!text) return null;
    segments.unshift(text);
    current = scope;
  }
  if (!current || current.type !== "constant" || segments.length === 0) return null;
  const root = sliceText(current, source);
  if (!root) return null;
  return { path: `${root}::${segments.join("::")}`, root };
}

/**
 * `Outer::Inner::Tool` is one constant path. Nested classes are exported under that
 * path, not as bare `Tool`, so the chain has to ask for the qualified export.
 */
function resolveRubyQualifiedConstantDefinition(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  source: string,
): GoToResult | null {
  const qualified = rubyScopeResolutionPath(node, source);
  if (!qualified) return null;
  const files: string[] = [];
  const seen = new Set<string>();
  const add = (file: string | undefined): void => {
    if (!file) return;
    const key = fileIdentityKey(file);
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };
  for (const imp of mod.imports) {
    if (imp.kind === "namespace" && imp.localNS === qualified.root && typeof imp.resolved === "string") {
      add(imp.resolved);
    }
  }
  add(mod.file);
  const hits: SymbolDef[] = [];
  for (const file of files) {
    const hit = resolveExport(index, file, qualified.path, { allowLocalFallback: false });
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
  if (hits.length !== 1) return null;
  return okGoToResult(index, hits[0]!, {
    via: { exportedName: qualified.path },
    resolution: "member-access",
    confidence: "medium",
  });
}

export async function resolveMemberAccessDefinition(params: {
  index: ProjectIndex;
  mod: ModuleIndex;
  node: SyntaxNodeLike;
  source: string;
  tree: SyntaxTreeLike;
  sup: LanguageSupport;
  resolveLexicalBinding?: (expression: SyntaxNodeLike) => SymbolDef | null;
}): Promise<GoToResult | null> {
  const { index, mod, node, source, tree, sup, resolveLexicalBinding } = params;
  if (sup.id === "ruby") {
    const qualified = resolveRubyQualifiedConstantDefinition(index, mod, node, source);
    if (qualified) return qualified;
  }
  const parent = node.parent;
  if (!parent || !sup.supportsCrossModuleSymbols) {
    return null;
  }
  let memberNode: SyntaxNodeLike | null = null;
  if (isMemberAccessNode(sup, parent)) {
    memberNode = parent;
  } else if (parent.parent && isMemberAccessNode(sup, parent.parent)) {
    memberNode = parent.parent;
  }
  if (!memberNode) return null;
  const { object: obj, property: prop } = getMemberAccessParts(sup, memberNode);
  const optionalMemberTypes = memberAccessTraversalTypes(sup);

  const resolveExpression = async (expr: SyntaxNodeLike): Promise<ResolvedExport | null> => {
    const exprIsId = isReceiverNameNode(sup, expr.type) && !isMemberAccessNode(sup, expr);
    if (exprIsId) {
      const aliasQualifier =
        sup.id === "csharp" &&
        expr.parent?.type === "alias_qualified_name" &&
        getMemberAccessParts(sup, expr.parent).object?.id === expr.id;
      if (!aliasQualifier) {
        const lexicalBinding = resolveLexicalBinding?.(expr);
        if (lexicalBinding) return { kind: "resolved", def: lexicalBinding };
      }
      const exprName = sliceText(expr, source);
      let imp: ImportBinding | undefined;
      if (sup.id === "php") {
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
          imp = innermostNamespaceImport(mod.imports, exprName, expr, sup.normalizeIdentifier);
          if (!imp) {
            imp = mod.imports.find(
              (candidate) =>
                (candidate.kind === "named" || candidate.kind === "default") && candidate.local === exprName,
            );
          }
        }
      } else {
        imp = mod.imports.find(
          (candidate) => (candidate.kind === "named" || candidate.kind === "default") && candidate.local === exprName,
        );
        if (!imp && isJsTsLanguage(sup.id)) {
          imp = innermostNamespaceImport(mod.imports, exprName, expr);
        }
        if (!imp) {
          imp = mod.imports.find((candidate) => candidate.kind === "namespace" && candidate.localNS === exprName);
        }
      }
      if (imp) {
        if (imp.kind === "namespace") {
          if (imp.mechanism === "cjs" && typeof imp.resolved === "string") {
            const classValue = cjsRequireValueBinding(index, imp.resolved);
            if (classValue) return { kind: "resolved", def: classValue };
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
        const result = resolveImported(index, imp, imp.kind === "named" ? imp.imported : "default");
        if (result) {
          if ("namespace" in result) {
            return { kind: "namespace", file: result.namespace };
          }
          const container = asMemberContainer(index, result);
          return { kind: "resolved", def: container ?? result };
        }
      }

      if (sup.id === "csharp") {
        const local = resolveExport(index, mod.file, exprName, { referenceIndex: expr.startIndex });
        if (local) return local;
      } else {
        const local = mod.locals.find((candidate) => {
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

      for (const starImport of mod.imports.filter((candidate) => candidate.kind === "star")) {
        const result = resolveImported(index, starImport, exprName);
        if (result) {
          if ("namespace" in result) {
            return { kind: "namespace", file: result.namespace };
          }
          return { kind: "resolved", def: result };
        }
      }
      return null;
    }

    if (optionalMemberTypes.has(expr.type)) {
      // A Python unaliased dotted import (`import a.b`) binds only the first segment `a`,
      // resolved to the leaf module `a.b` names; the source can only ever repeat that whole
      // dotted phrase to reach it again (`a.b.symbol(...)`), never a bare intermediate segment
      // on its own. Recognize that literal phrase up front so the chain walk below lands on the
      // leaf module the import machinery already resolved, instead of treating each dot as an
      // ordinary member-access hop and failing on the segment duplicating the import's spelling.
      if (sup.id === "python") {
        const dottedText = sliceText(expr, source);
        if (dottedText.includes(".")) {
          const dottedImport = mod.imports.find(
            (imp) =>
              imp.kind === "namespace" &&
              imp.mechanism === "python" &&
              imp.from === dottedText &&
              typeof imp.resolved === "string",
          );
          if (dottedImport && typeof dottedImport.resolved === "string") {
            return { kind: "namespace", file: dottedImport.resolved.replace(/\\/g, "/") };
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
        const memberName = sliceText(subProp, source);
        if (base?.kind === "namespace") {
          if (!isGoExportedMemberName(sup.id, memberName)) return null;
          const hit = resolveExport(index, base.file, memberName, { allowLocalFallback: false });
          if (hit) return hit;
          // A resolved package/namespace file with no matching export may still have an
          // unimported submodule of that exact name, mirroring the same fallback `resolveImported`
          // already applies for a direct import binding.
          if (sup.id === "python") {
            const submodule = resolvePythonSubmodule(base.file, memberName);
            if (submodule) return { kind: "namespace", file: submodule };
          }
          return null;
        }
        if (base?.kind === "resolved") {
          if (sup.id === "java" || sup.id === "csharp") {
            const memberDef = await resolveMemberDefinitionForBase(index, base.def, memberName);
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
        const memberName = sliceText(subProp, source);
        if (base?.kind === "namespace") {
          return resolveExport(index, base.file, memberName, { allowLocalFallback: false });
        }
        if (base?.kind === "resolved") {
          const memberDef = await resolveMemberDefinitionForBase(index, base.def, memberName);
          return memberDef ? { kind: "resolved", def: memberDef } : null;
        }
      }
    }

    return null;
  };

  const chain = await resolveExpression(memberNode);
  if (chain && prop && node.id === prop.id) {
    if (chain.kind === "resolved") {
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

  const receiverName = obj ? sliceText(obj, source) : "";
  const receiverKind = keywordReceiverKind(sup.id, receiverName);
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
      );
      if (!memberDef) return null;
      return okGoToResult(index, memberDef, {
        via: { exportedName: member },
        resolution: "member-access",
        confidence: "medium",
      });
    }
    if (receiverKind && keywordReceiverCrossesDynamicBoundary(sup, node)) {
      return null;
    }
    const keywordScope = receiverKind ? keywordReceiverMemberScope(sup, receiverName, node, source) : "any";
    if (receiverKind === "own") {
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
    } else if (receiverKind === "supertype") {
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

    const receiver = await resolveReceiverDefinition(index, obj, source, sup, resolveExpression, mod);

    if (receiver) {
      const objDef = receiver.def;
      const targetContext = await ensureParsedContext(objDef.file, undefined, index.languageExtensions);
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
          if (receiver.runtimeTypeOnly || targetContext.sup.id === "java") {
            const candidates = findDirectLocalsWithinNode(
              targetModule.locals,
              member,
              container,
              targetContext,
              normalizeIdentifier,
              memberPredicate,
            );
            memberDef = await selectReceiverMemberCandidates(index, candidates, knownArgumentCount);
          } else {
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

          if (memberDef && !crossFilePeerMemberHidden(mod.file, memberDef, targetContext)) {
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

function keywordClassKey(def: SymbolDef): string {
  const start = def.range.start;
  return `${fileIdentityKey(def.file)}:${start.index ?? `${start.line}:${start.column}`}`;
}

function keywordContainerKey(file: string, container: SyntaxNodeLike): string {
  return `${fileIdentityKey(file)}:${container.startIndex}:${container.endIndex}`;
}

type DeclaredBaseType =
  | { kind: "simple"; name: string; invoked?: boolean }
  | { kind: "qualified"; base: string; path: readonly string[]; invoked?: boolean };

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

function collectDeclaredBaseTypes(
  container: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  superclassOnly = false,
): DeclaredBaseType[] {
  const ancestry = MEMBER_ACCESS_ROWS[sup.id]?.receiverAncestry;
  if (!ancestry || (ancestry.clauses.length === 0 && !ancestry.mixinCalls?.length)) return [];
  const bases: DeclaredBaseType[] = [];
  const seen = new Set<string>();
  let usedFirstMatch = false;
  const addSimple = (name: string, invoked: boolean): void => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    bases.push(invoked ? { kind: "simple", name, invoked } : { kind: "simple", name });
  };
  const addQualified = (base: string, path: string[], invoked: boolean): void => {
    if (!base || path.length === 0) return;
    const key = `${base}.${path.join(".")}`;

    if (seen.has(key)) return;
    seen.add(key);
    bases.push(invoked ? { kind: "qualified", base, path, invoked } : { kind: "qualified", base, path });
  };
  const collectType = (node: SyntaxNodeLike, invoked: boolean): void => {
    const core = peelTypeWrappers(node);
    if (core.type === "constructor_invocation") {
      // Kotlin writes the superclass as a constructor invocation (`Base()`); its callees are
      // superclass entries, while bare types in the same base list are interfaces.
      for (const child of core.namedChildren) {
        if (child.type === "value_arguments") continue;
        collectType(child, true);
      }
      return;
    }
    // A computed heritage expression can name the runtime base factory rather than a class.
    // Its descendants do not prove an inheritance edge.
    if (isUnprovenHeritageExpression(core)) return;
    if (sup.id === "cpp" && core.type === "base_class_clause") {
      for (const child of core.namedChildren) {
        if (child.type === "access_specifier" || child.type === "virtual_specifier") continue;
        collectType(child, invoked);
      }
      return;
    }
    if (sup.id === "cpp") {
      const qualified = parseCppBaseType(core, source);
      if (qualified) {
        if (qualified.path.length) addQualified(qualified.base, qualified.path, invoked);
        else addSimple(qualified.base, invoked);
        return;
      }
    }
    const unwrapped = unwrapNamedType(core, sup);
    if (unwrapped) {
      addSimple(sliceText(unwrapped, source), invoked);
      return;
    }
    if (isMemberAccessNode(sup, core)) {
      const chain = collectMemberAccessChain({ sup, source, chainNode: core });
      if (chain && isSimpleTypeNameNode(chain.base, sup) && chain.names.length) {
        addQualified(sliceText(chain.base, source), [...chain.names].reverse(), invoked);
      }
      return;
    }
    if (memberAccessTraversalTypes(sup).has(core.type)) return;
    for (const child of core.namedChildren) {
      if (child.type === "type_arguments") continue;
      collectType(child, invoked);
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
      collectType(target, false);
    }
    if (superclassOnly || node.type !== "call" || !ancestry.mixinCalls?.length) return;
    if (node.childForFieldName("receiver")) return;
    const methodNode = node.childForFieldName("method");
    const methodName = methodNode ? sliceText(methodNode, source) : undefined;
    if (!methodName || !ancestry.mixinCalls.includes(methodName)) return;
    const args = node.childForFieldName("arguments");
    if (args) collectType(args, false);
  };
  for (const child of container.namedChildren) {
    consider(child);
    for (const grand of child.namedChildren) consider(grand);
  }
  return bases;
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

  for (const imp of mod.imports) {
    if (imp.kind === "named" && normalize(imp.local) === normalizedName) {
      const container = importedMemberContainer(index, resolveImported(index, imp, imp.imported));
      if (container) return container;
    }
    if (imp.kind === "default" && normalize(imp.local) === normalizedName) {
      const container = importedMemberContainer(index, resolveImported(index, imp, "default"));
      if (container) return container;
    }
    if (imp.kind === "star") {
      const container = importedMemberContainer(index, resolveImported(index, imp, name));
      if (container) return container;
    }
  }
  const exported = resolveExport(index, mod.file, name, { allowLocalFallback: false });
  if (exported?.kind === "resolved") return asMemberContainer(index, exported.def);
  return undefined;
}

async function resolveQualifiedMemberContainer(
  index: ProjectIndex,
  mod: ModuleIndex,
  baseName: string,
  path: readonly string[],
  normalize: (name: string) => string,
  sup: LanguageSupport,
): Promise<SymbolDef | undefined> {
  if (path.length === 0) return undefined;
  if (sup.id === "cpp") {
    return (await resolveCppQualifiedMemberContainer(index, mod, [baseName, ...path])) ?? undefined;
  }
  const namespaceImports = mod.imports.filter(
    (imp) => imp.kind === "namespace" && normalize(imp.localNS) === normalize(baseName),
  );
  if (namespaceImports.length !== 1) return undefined;
  const resolved = namespaceImports[0]!.resolved;
  let file = typeof resolved === "string" ? resolved : undefined;
  if (!file) return undefined;
  for (let partIndex = 0; partIndex < path.length; partIndex += 1) {
    const part = path[partIndex]!;
    const last = partIndex === path.length - 1;
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

function nodeContainsUnprovenHeritage(node: SyntaxNodeLike): boolean {
  if (isUnprovenHeritageExpression(node)) return true;
  return node.namedChildren.some((child) => nodeContainsUnprovenHeritage(child));
}

/** A heritage or mixin clause whose type expression is not a resolvable name. */
function containerHeritageIsUnproven(container: SyntaxNodeLike, source: string, sup: LanguageSupport): boolean {
  const ancestry = MEMBER_ACCESS_ROWS[sup.id]?.receiverAncestry;
  if (!ancestry) return false;
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

async function resolveDeclaredBase(
  index: ProjectIndex,
  mod: ModuleIndex,
  sup: LanguageSupport,
  base: DeclaredBaseType,
): Promise<SymbolDef | undefined> {
  const normalize = sup.normalizeIdentifier;
  if (base.kind === "simple") return resolveNamedMemberContainer(index, mod, base.name, normalize);
  return resolveQualifiedMemberContainer(index, mod, base.base, base.path, normalize, sup);
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
      ownerFile: containerDef.file,
      ownerContainer: ref.container,
      ownerSource: ref.context.source,
      languageId: ref.context.sup.id,
      member: memberName,
      memberScope,
    });
    if (shared.length > 0) return false;
  }
  if (containerHeritageIsUnproven(ref.container, ref.context.source, ref.context.sup)) return false;
  const bases = collectDeclaredBaseTypes(ref.container, ref.context.source, ref.context.sup, false);
  for (const base of bases) {
    const baseDef = await resolveDeclaredBase(index, ref.module, ref.context.sup, base);
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
  );
  if (!receiver) return false;
  if (receiver.kind === "named-type") {
    const def = await resolveReceiverTypeName(index, mod, parsed.sup, receiver.typeName);
    if (!def) return false;
    return hierarchyOmitsMember(index, def, memberName, receiver.memberScope, new Set());
  }
  const container = nearestMemberContainer(accessNode);
  if (!container) return false;
  if (receiver.kind === "supertype") {
    if (containerHeritageIsUnproven(container, parsed.source, parsed.sup)) return false;
    const bases = collectDeclaredBaseTypes(container, parsed.source, parsed.sup, true);
    if (!bases.length) return false;
    const seen = new Set<string>();
    for (const base of bases) {
      const baseDef = await resolveDeclaredBase(index, mod, parsed.sup, base);
      if (!baseDef) return false;
      if (!(await hierarchyOmitsMember(index, baseDef, memberName, receiver.memberScope, seen))) return false;
    }
    return true;
  }
  const def = definitionForContainer(mod, container);
  if (!def) return false;
  return hierarchyOmitsMember(index, def, memberName, receiver.memberScope, new Set());
}

async function keywordClassRefFromDef(index: ProjectIndex, def: SymbolDef): Promise<KeywordClassRef | null> {
  const module = index.byFile.get(fileIdentityKey(def.file));
  if (!module) return null;
  const context = await ensureParsedContext(def.file, undefined, index.languageExtensions);
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
  const context = await ensureParsedContext(mod.file, undefined, index.languageExtensions);
  const memberNode = context.tree.rootNode.descendantForPosition(node.startPosition, node.startPosition);
  const container = findEnclosingClassContainer(memberNode);
  if (!container) return null;
  return { file: mod.file, container, context, module: mod };
}

function crossFilePeerMemberHidden(useFile: string, memberDef: SymbolDef, targetContext: ParsedFileContext): boolean {
  const languageId = targetContext.sup.id;
  if (languageId !== "java" && languageId !== "kotlin" && languageId !== "swift") return false;
  const start = memberDef.range.start;
  const position = { row: Math.max(0, start.line - 1), column: Math.max(0, start.column - 1) };
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
  const bases = collectDeclaredBaseTypes(container, source, sup, superclassOnly);
  const refs: KeywordClassRef[] = [];
  const seen = new Set<string>();
  const normalize = (name: string): string => {
    const normalized = sup.normalizeIdentifier(name);
    return sup.id === "php" ? foldPhpIdentifierCase(normalized) : normalized;
  };
  for (const base of bases) {
    let def =
      base.kind === "simple"
        ? resolveNamedMemberContainer(index, mod, base.name, normalize)
        : await resolveQualifiedMemberContainer(index, mod, base.base, base.path, normalize, sup);
    if (!def && sup.id === "php" && base.kind === "simple") {
      def = resolvePhpNamespaceSymbol(index, source, tree, container, base.name, mod.imports, "class") ?? undefined;
    }
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
    // Kotlin classifies interfaces as SymbolKind.Class too, so the superclass is identified
    // syntactically: `Base()` is a constructor invocation, while bare delegation-specifier
    // entries (`Face`, `by` delegations) are interfaces. Interface-only super lookup stays
    // unresolved, while an own receiver can inherit their default members.
    if (superclassOnly && sup.id === "kotlin" && !base.invoked) continue;
    const key = keywordClassKey(def);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

async function resolveKeywordReceiverMember(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  member: string,
  memberScope: ReceiverMemberScope,
  startAtAncestor: boolean,
  knownArgumentCount?: number,
  explicitClassDef?: SymbolDef,
): Promise<SymbolDef | undefined> {
  const current = explicitClassDef
    ? await keywordClassRefFromDef(index, explicitClassDef)
    : await keywordClassRefFromNode(index, mod, node);
  if (!current) return undefined;
  let level = startAtAncestor
    ? await baseRefsFromContainer(
        index,
        current.module,
        current.container,
        current.context.source,
        current.context.sup,
        true,
        current.context.tree,
      )
    : [current];
  if (level.length === 0) return undefined;
  const visited = new Set<string>([
    keywordContainerKey(current.file, current.container),
    ...level.map((candidate) => keywordContainerKey(candidate.file, candidate.container)),
  ]);
  for (let depth = 0; depth < RECEIVER_HIERARCHY_DEPTH && level.length; depth += 1) {
    const matches: SymbolDef[] = [];
    for (const candidate of level) {
      const memberPredicate =
        memberScope === "any"
          ? undefined
          : (local: SymbolDef) =>
              matchesReceiverMemberScope(local, memberScope, candidate.context, candidate.container);
      appendDirectKeywordMembers(
        candidate.module.locals,
        member,
        candidate.container,
        candidate.context,
        candidate.context.sup.normalizeIdentifier,
        memberPredicate,
        matches,
      );
    }
    for (const candidate of level) {
      if (candidate.context.sup.id !== "csharp" && candidate.context.sup.id !== "swift") continue;
      const sharedContainers = await resolveSharedOwnerContainers({
        index,
        ownerFile: candidate.file,
        ownerContainer: candidate.container,
        ownerSource: candidate.context.source,
        languageId: candidate.context.sup.id,
      });
      for (const shared of sharedContainers) {
        const crossFileSwift =
          candidate.context.sup.id === "swift" && fileIdentityKey(candidate.file) !== fileIdentityKey(shared.file);
        const sharedPredicate = (local: SymbolDef): boolean => {
          if (
            memberScope !== "any" &&
            !matchesReceiverMemberScope(local, memberScope, shared.context, shared.container)
          ) {
            return false;
          }
          if (!crossFileSwift) return true;
          const nameNode = nameNodeForDef(shared.context, local);
          return !!nameNode && !isSwiftCrossFileHiddenSharedOwnerMember("swift", candidate.file, shared.file, nameNode);
        };
        appendDirectKeywordMembers(
          shared.module.locals,
          member,
          shared.container,
          shared.context,
          shared.context.sup.normalizeIdentifier,
          sharedPredicate,
          matches,
        );
      }
    }
    const uniqueMatches = uniqueReceiverMemberCandidates(matches);
    if (uniqueMatches.length) {
      const allowUniqueArityMismatch = !startAtAncestor && depth === 0;
      return await selectReceiverMemberCandidates(index, uniqueMatches, knownArgumentCount, allowUniqueArityMismatch);
    }
    const next: KeywordClassRef[] = [];
    for (const candidate of level) {
      for (const parent of await baseRefsFromContainer(
        index,
        candidate.module,
        candidate.container,
        candidate.context.source,
        candidate.context.sup,
        startAtAncestor,
        candidate.context.tree,
      )) {
        const key = keywordContainerKey(parent.file, parent.container);
        if (visited.has(key)) continue;
        visited.add(key);
        next.push(parent);
      }
    }
    level = next;
  }
  return undefined;
}
/**
 * Validate an unqualified member use against its actual lexical owner, including shared
 * owner parts in other files. Swift checks every bare name; C# checks only invocation
 * callees, matching the detailed graph's implicit-self call candidates. A C# static
 * context reaches only static members.
 */
export async function resolveImplicitSelfMember(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  name: string,
  source: string,
  languageId: string,
): Promise<SymbolDef | undefined> {
  const call = node.parent ?? node;
  if (languageId === "csharp") {
    const callee = call.type === "invocation_expression" ? call.childForFieldName("function") : null;
    if (!callee || callee.startIndex !== node.startIndex || callee.endIndex !== node.endIndex) return undefined;
  } else if (languageId !== "swift") {
    return undefined;
  }
  const memberScope: ReceiverMemberScope =
    languageId === "csharp" && nodeInStaticMemberContext(node, source) ? "static" : "any";
  return resolveKeywordReceiverMember(
    index,
    mod,
    node,
    name,
    memberScope,
    false,
    getCallArgumentCount({ languageId, source, call }) ?? undefined,
  );
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
  const bases = collectDeclaredBaseTypes(classNode, source, sup, true);
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

async function resolveReceiverDefinition(
  index: ProjectIndex,
  obj: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  resolveExpression: (expr: SyntaxNodeLike) => Promise<ResolvedExport | null>,
  mod: ModuleIndex,
): Promise<ResolvedReceiverDefinition | null> {
  const constructor = receiverConstructorExpression(obj, source, sup);
  if (constructor) {
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
    const typedLocals = memberDeclaringLocals(mod, typeName, sup.normalizeIdentifier);
    if (typedLocals.length === 1) {
      return {
        def: typedLocals[0]!,
        memberScope: hasStaticMemberDistinction(sup.id) ? "instance" : "any",
      };
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
  const direct = await resolveExpression(obj);
  const directContainer = direct?.kind === "resolved" ? asMemberContainer(index, direct.def) : undefined;
  if (directContainer) {
    if (isJsTsLanguage(sup.id) && directContainer.kind === SymbolKind.TypeAlias) {
      return { def: directContainer, memberScope: "any", runtimeTypeOnly: true };
    }
    const memberScope = hasStaticMemberDistinction(sup.id) ? "static" : "any";
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

async function resolveMemberDefinitionForBase(
  index: ProjectIndex,
  baseDef: SymbolDef,
  member: string,
): Promise<SymbolDef | undefined> {
  const targetContext = await ensureParsedContext(baseDef.file, undefined, index.languageExtensions);
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
  const normalizeIdentifier = targetContext.sup.normalizeIdentifier;
  const directHit = findDirectLocalWithinNode(
    targetModule.locals,
    member,
    container,
    targetContext,
    normalizeIdentifier,
  );
  if (directHit) return directHit;
  if (targetContext.sup.id === "java") return undefined;
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
  const containerMatches = findDirectLocalsWithinNode(
    locals,
    member,
    container,
    targetContext,
    normalizeIdentifier,
    memberPredicate,
  );
  const allReceiverMatches = [...containerMatches];
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
    return await selectReceiverMemberCandidates(index, allReceiverMatches, knownArgumentCount);
  }
  if (targetContext.sup.id === "rust") {
    const matches: SymbolDef[] = [];
    for (const implNode of findRustImplsForType(
      targetContext.tree.rootNode,
      receiverDef.localName,
      targetContext.source,
      targetContext.sup,
    )) {
      appendDirectKeywordMembers(locals, member, implNode, targetContext, normalizeIdentifier, undefined, matches);
    }
    return await selectReceiverMemberCandidates(index, matches, knownArgumentCount);
  }
  if (targetContext.sup.id === "go") {
    return findGoReceiverMember(locals, member, receiverDef.localName, targetContext, normalizeIdentifier);
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
      return await selectReceiverMemberCandidates(index, extensionMatches, knownArgumentCount);
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

function findLocalWithinNode(
  locals: readonly SymbolDef[],
  member: string,
  node: SyntaxNodeLike,
  normalizeIdentifier: (name: string) => string = (name) => name,
  predicate?: (local: SymbolDef) => boolean,
): SymbolDef | undefined {
  return findLocalsWithinNode(locals, member, node, normalizeIdentifier, predicate)[0];
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

async function getCallableArityForDef(index: ProjectIndex, def: SymbolDef): Promise<CallableArity | undefined> {
  const context = await ensureParsedContext(def.file, undefined, index.languageExtensions);
  const start = def.range.start;
  const position = { row: start.line - 1, column: start.column - 1 };
  const nameNode = context.tree.rootNode.descendantForPosition(position, position);
  const container = nearestMemberContainer(nameNode);
  let current: SyntaxNodeLike | null = nameNode;
  while (current && current !== container) {
    const range = getCallableArity({
      languageId: context.sup.id,
      source: context.source,
      declaration: current,
      binding: memberLookupBinding(context.sup.id),
    });
    if (range) return range;
    current = current.parent;
  }
  return undefined;
}

async function receiverMemberAcceptsArgumentCount(
  index: ProjectIndex,
  def: SymbolDef,
  argumentCount: number,
): Promise<boolean | undefined> {
  const context = await ensureParsedContext(def.file, undefined, index.languageExtensions);
  const start = def.range.start;
  const position = {
    row: start.line - 1,
    column: start.column - 1,
  };
  const nameNode = context.tree.rootNode.descendantForPosition(position, position);
  if (context.sup.id === "cpp") {
    const shape = cppCallableShapeForNode(nameNode);
    return shape
      ? argumentCount >= shape.minArity && (shape.maxArity === null || argumentCount <= shape.maxArity)
      : undefined;
  }
  const range = await getCallableArityForDef(index, def);
  if (!range) return undefined;
  return argumentCount >= range.minArgs && (range.maxArgs === null || argumentCount <= range.maxArgs);
}

function uniqueReceiverMemberCandidates(candidates: readonly SymbolDef[]): SymbolDef[] {
  const seen = new Set<string>();
  const unique: SymbolDef[] = [];
  for (const candidate of candidates) {
    const key = keywordClassKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

async function collapseTypeScriptOverloadCandidates(
  index: ProjectIndex,
  candidates: readonly SymbolDef[],
): Promise<SymbolDef[]> {
  if (candidates.length < 2) return [...candidates];
  const file = candidates[0]?.file;
  if (!file || candidates.some((candidate) => candidate.file !== file)) return [...candidates];
  const context = await ensureParsedContext(file, undefined, index.languageExtensions);
  if (!isJsTsLanguage(context.sup.id)) return [...candidates];
  const roles = candidates.map((candidate) => ({
    candidate,
    role: typescriptCallableRoleAt(
      context.tree,
      candidate.range.start.index ?? 0,
      candidate.range.end.index ?? candidate.range.start.index ?? 0,
    ),
  }));
  if (roles.every((item) => item.role === "other")) return [...candidates];
  const implementations = roles.filter((item) => item.role === "implementation").map((item) => item.candidate);
  if (implementations.length === 1) return implementations;
  if (implementations.length > 1) {
    return roles.filter((item) => item.role !== "signature").map((item) => item.candidate);
  }
  const signatures = roles.filter((item) => item.role === "signature").map((item) => item.candidate);
  if (signatures.length === 0) return [...candidates];
  return [earliestSymbolDef(signatures)];
}

function selectReceiverMemberCandidates(
  index: ProjectIndex,
  candidates: readonly SymbolDef[],
  knownArgumentCount?: number,
  allowUniqueArityMismatch = true,
): Promise<SymbolDef | undefined> {
  return selectCollapsedReceiverMemberCandidates(index, candidates, knownArgumentCount, allowUniqueArityMismatch);
}

async function selectCollapsedReceiverMemberCandidates(
  index: ProjectIndex,
  candidates: readonly SymbolDef[],
  knownArgumentCount?: number,
  allowUniqueArityMismatch = true,
): Promise<SymbolDef | undefined> {
  const unique = uniqueReceiverMemberCandidates(await collapseTypeScriptOverloadCandidates(index, candidates));
  if (unique.length === 1 && (allowUniqueArityMismatch || knownArgumentCount === undefined)) return unique[0];
  if (knownArgumentCount === undefined) return undefined;
  const matches: SymbolDef[] = [];
  for (const candidate of unique) {
    if ((await receiverMemberAcceptsArgumentCount(index, candidate, knownArgumentCount)) !== false) {
      matches.push(candidate);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function hasStaticModifier(local: SymbolDef, targetContext: ParsedFileContext, container: SyntaxNodeLike): boolean {
  const position = {
    row: local.range.start.line - 1,
    column: local.range.start.column - 1,
  };
  let current: SyntaxNodeLike | null = targetContext.tree.rootNode.descendantForPosition(position, position);
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
  const matches: SymbolDef[] = [];
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
      if (
        !isDeclarationParent &&
        !isDirectBody &&
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

function findDirectLocalWithinNode(
  locals: readonly SymbolDef[],
  member: string,
  container: SyntaxNodeLike,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
  predicate?: (local: SymbolDef) => boolean,
): SymbolDef | undefined {
  return findDirectLocalsWithinNode(locals, member, container, targetContext, normalizeIdentifier, predicate)[0];
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
        const local = findLocalWithinNode(locals, member, node, normalizeIdentifier);
        if (local && !matches.includes(local)) matches.push(local);
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
        const local = findLocalWithinNode(locals, member, node, normalizeIdentifier);
        if (local && !matches.includes(local)) matches.push(local);
      }
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(targetContext.tree.rootNode);
  return matches;
}

function findGoReceiverMember(
  locals: readonly SymbolDef[],
  member: string,
  typeName: string,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
): SymbolDef | undefined {
  const visited = new Set<string>();
  let level = [typeName];
  for (let depth = 0; depth < RECEIVER_HIERARCHY_DEPTH && level.length; depth += 1) {
    const matches: SymbolDef[] = [];
    const next: string[] = [];
    for (const currentType of level) {
      if (visited.has(currentType)) continue;
      visited.add(currentType);
      for (const method of goMethodsNamedOnType(locals, member, currentType, targetContext, normalizeIdentifier)) {
        if (!matches.includes(method)) matches.push(method);
      }
      for (const embedded of goEmbeddedTypeNames(currentType, targetContext, normalizeIdentifier)) {
        if (!visited.has(embedded) && !next.includes(embedded)) next.push(embedded);
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
    level = next;
  }
  return undefined;
}

type PythonClassRef = {
  def: SymbolDef;
  container: SyntaxNodeLike;
  context: ParsedFileContext;
  module: ModuleIndex;
};

function pythonClassKey(def: SymbolDef): string {
  const start = def.range.start;
  return `${fileIdentityKey(def.file)}:${start.index ?? `${start.line}:${start.column}`}`;
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
): Promise<SymbolDef | undefined> {
  const classRef = await pythonReceiverClassRef(index, mod, node, obj, source, sup, resolveExpression);
  if (!classRef) return undefined;
  return lookupPythonClassMember(index, classRef.ref, member, classRef.startAtSupertype);
}

type PythonReceiverClassRef = { ref: PythonClassRef; startAtSupertype: boolean };

async function pythonReceiverClassRef(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  obj: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  resolveExpression: (expr: SyntaxNodeLike) => Promise<ResolvedExport | null>,
): Promise<PythonReceiverClassRef | null> {
  const receiverName = receiverKeywordText(sup, obj, source);
  const keywordKind = keywordReceiverKind(sup.id, receiverName);
  if (keywordKind) {
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
    const ref = await pythonClassRefFromDef(index, def);
    return ref ? { ref, startAtSupertype: keywordKind === "supertype" } : null;
  }

  let classDef: SymbolDef | undefined;
  const constructor = receiverConstructorExpression(obj, source, sup);
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
  const ref = await pythonClassRefFromDef(index, classDef);
  return ref ? { ref, startAtSupertype: false } : null;
}

async function pythonClassRefFromDef(index: ProjectIndex, def: SymbolDef): Promise<PythonClassRef | null> {
  const module = index.byFile.get(fileIdentityKey(def.file));
  if (!module) return null;
  const context = await ensureParsedContext(def.file, undefined, index.languageExtensions);
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
}

function pythonMembersOnClass(classRef: PythonClassRef, member: string): SymbolDef[] {
  const normalizeIdentifier = classRef.context.sup.normalizeIdentifier;
  const direct = findDirectLocalWithinNode(
    classRef.module.locals,
    member,
    classRef.container,
    classRef.context,
    normalizeIdentifier,
  );
  if (direct) return [direct];
  const attribute = findPythonInstanceAttributeWithinClass(
    classRef.module.locals,
    member,
    classRef.container,
    classRef.context,
    normalizeIdentifier,
  );
  return attribute ? [attribute] : [];
}

function findPythonInstanceAttributeWithinClass(
  locals: readonly SymbolDef[],
  member: string,
  container: SyntaxNodeLike,
  targetContext: ParsedFileContext,
  normalizeIdentifier: (name: string) => string,
): SymbolDef | undefined {
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
    if (isPythonReceiverAttributeAssignmentName(nameNode)) return local;
  }
  return undefined;
}

function pythonBaseIdentifierNodes(classNode: SyntaxNodeLike): SyntaxNodeLike[] {
  const bases =
    classNode.childForFieldName("superclasses") ??
    (classNode.namedChildren ?? []).find((child) => child.type === "argument_list");
  if (!bases) return [];
  const names: SyntaxNodeLike[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === "keyword_argument" || node.type === "dictionary_splat" || node.type === "list_splat") {
      return;
    }
    if (node.type === "identifier") {
      names.push(node);
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
  return names;
}

function resolvePythonNamedClass(index: ProjectIndex, mod: ModuleIndex, name: string): SymbolDef | undefined {
  const classes = mod.locals.filter((local) => local.kind === SymbolKind.Class && local.localName === name);
  const topLevel = classes.filter((local) => !local.isMember);
  const candidates = topLevel.length ? topLevel : classes;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return undefined;

  for (const imp of mod.imports) {
    if (imp.kind === "named" && imp.local === name) {
      const result = resolveImported(index, imp, imp.imported);
      if (result && !("namespace" in result) && result.kind === SymbolKind.Class) return result;
    }
    if (imp.kind === "star") {
      const result = resolveImported(index, imp, name);
      if (result && !("namespace" in result) && result.kind === SymbolKind.Class) return result;
    }
  }
  const exported = resolveExport(index, mod.file, name, { preferredKind: SymbolKind.Class, allowLocalFallback: false });
  if (exported?.kind === "resolved" && exported.def.kind === SymbolKind.Class) return exported.def;
  return undefined;
}

async function pythonBaseClassRefs(index: ProjectIndex, classRef: PythonClassRef): Promise<PythonClassRef[]> {
  const names = pythonBaseIdentifierNodes(classRef.container);
  const refs: PythonClassRef[] = [];
  const seen = new Set<string>();
  for (const nameNode of names) {
    const def = resolvePythonNamedClass(index, classRef.module, sliceText(nameNode, classRef.context.source));
    if (!def) continue;
    const key = pythonClassKey(def);
    if (seen.has(key)) continue;
    seen.add(key);
    const ref = await pythonClassRefFromDef(index, def);
    if (ref) refs.push(ref);
  }
  return refs;
}

async function lookupPythonClassMember(
  index: ProjectIndex,
  start: PythonClassRef,
  member: string,
  startAtSupertype = false,
): Promise<SymbolDef | undefined> {
  if (!startAtSupertype) {
    const own = pythonMembersOnClass(start, member);
    if (own.length === 1) return own[0];
    if (own.length > 1) return undefined;
  }
  let level = await pythonBaseClassRefs(index, start);
  const visited = new Set<string>([pythonClassKey(start.def), ...level.map((base) => pythonClassKey(base.def))]);
  for (let depth = 0; depth < RECEIVER_HIERARCHY_DEPTH && level.length; depth += 1) {
    const matches: SymbolDef[] = [];
    const seenMatch = new Set<string>();
    for (const base of level) {
      for (const hit of pythonMembersOnClass(base, member)) {
        const key = pythonClassKey(hit);
        if (seenMatch.has(key)) continue;
        seenMatch.add(key);
        matches.push(hit);
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
    const next: PythonClassRef[] = [];
    for (const base of level) {
      for (const parent of await pythonBaseClassRefs(index, base)) {
        const key = pythonClassKey(parent.def);
        if (visited.has(key)) continue;
        visited.add(key);
        next.push(parent);
      }
    }
    level = next;
  }
  return undefined;
}

