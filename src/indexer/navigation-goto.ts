import type { LanguageSupport } from "../languages.js";
import { isJsTsLanguage } from "../languages/js-family.js";
import { isPythonReceiverAttributeAssignmentName } from "../languages/definitions/python.js";
import type { SyntaxNodeLike } from "../languages/types.js";
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
} from "../util/member-access.js";
import {
  keywordReceiverKind,
  MEMBER_ACCESS_ROWS,
  supportsReceiverMemberNavigation,
} from "../util/member-access-tables.js";
import { cppCallableShapeForNode } from "./cpp-callables.js";
import {
  cppOutOfLineOwnerPath,
  cppQualifiedNameSegments,
  declarationNodeIsStatic,
  declaresMembers,
  hasStaticMemberDistinction,
  nearestMemberContainer,
  keywordReceiverCrossesDynamicBoundary,
  isUnprovenHeritageExpression,
  keywordReceiverMemberScope,
  receiverConstructorExpression,
  unwrapNamedType,
  type ReceiverMemberScope,
} from "../graphs/symbol-graph-detailed/receiver-calls.js";
import { getCallableArity, getCallArgumentCount, type CallableArity } from "../languages/callable-arity.js";
import { getCompilationUnitPeers } from "./compilation-units.js";
import { ensureParsedContext, type ParsedFileContext } from "./parse-context.js";
import { resolveCppQualifiedMemberContainer } from "./navigation-cpp.js";
import { okGoToResult } from "./navigation-provenance.js";
import { comparePhpReferenceNames, findPhpImportAlias } from "./navigation-php.js";
import { resolveExport, resolveImported, resolvePhpExportByImportType } from "./navigation-resolve.js";
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
type SharedOwnerIdentity = {
  languageId: string;
  fullPath: string;
};

const CSHARP_PARTIAL_CONTAINER_TYPES = new Set([
  "class_declaration",
  "struct_declaration",
  "record_declaration",
  "interface_declaration",
]);

function csharpModifierIsPartial(node: SyntaxNodeLike, source: string): boolean {
  const text = sliceText(node, source).trim();
  return text === "partial" || text.split(/\s+/).includes("partial");
}

function isCSharpPartialContainer(container: SyntaxNodeLike, source: string): boolean {
  if (!CSHARP_PARTIAL_CONTAINER_TYPES.has(container.type)) return false;
  const body = container.childForFieldName("body");
  for (const child of container.namedChildren ?? []) {
    if (body && child.id === body.id) continue;
    if (child.type === "declaration_list" || child.type === "class_body" || child.type === "base_list") {
      continue;
    }
    if (child.type === "modifier" && csharpModifierIsPartial(child, source)) return true;
    if (child.type === "modifiers") {
      for (const nested of child.namedChildren ?? []) {
        if (nested.type === "modifier" && csharpModifierIsPartial(nested, source)) return true;
      }
    }
  }
  return false;
}

function csharpNameText(node: SyntaxNodeLike | null, source: string): string {
  if (!node) return "";
  return sliceText(node, source).trim();
}

function getCSharpFullPath(container: SyntaxNodeLike, source: string): string | null {
  const nameNode = container.childForFieldName("name");
  const typeName = csharpNameText(nameNode, source);
  if (!typeName) return null;
  const outer: string[] = [];
  const namespaces: string[] = [];
  let current = container.parent;
  while (current) {
    if (CSHARP_PARTIAL_CONTAINER_TYPES.has(current.type)) {
      const outerName = csharpNameText(current.childForFieldName("name"), source);
      if (outerName) outer.push(outerName);
    }
    if (current.type === "namespace_declaration" || current.type === "file_scoped_namespace_declaration") {
      const nsNode =
        current.childForFieldName("name") ??
        (current.namedChildren ?? []).find((child) => child.type === "identifier" || child.type === "qualified_name");
      const nsText = csharpNameText(nsNode ?? null, source);
      if (nsText) namespaces.push(nsText);
    }
    current = current.parent;
  }
  outer.reverse();
  namespaces.reverse();
  const parts = [...namespaces, ...outer, typeName];
  return parts.join(".");
}

function swiftKeywordText(container: SyntaxNodeLike, source: string): string {
  const kind = container.childForFieldName("declaration_kind");
  if (kind) {
    const text = sliceText(kind, source).trim();
    if (text) return text;
  }
  const first = container.child(0);
  return first ? sliceText(first, source).trim() : "";
}

function isSwiftExtensionContainer(container: SyntaxNodeLike, source: string): boolean {
  return container.type === "class_declaration" && swiftKeywordText(container, source) === "extension";
}

function isSwiftTypeContainer(container: SyntaxNodeLike, source: string): boolean {
  if (container.type !== "class_declaration") return false;
  const text = swiftKeywordText(container, source);
  return text === "class" || text === "struct" || text === "enum" || text === "actor";
}

function swiftNameText(container: SyntaxNodeLike, source: string): string | null {
  const nameNode = container.childForFieldName("name");
  if (!nameNode) return null;
  const text = sliceText(nameNode, source).trim();
  return text ? text : null;
}

function getSwiftFullPath(container: SyntaxNodeLike, source: string): string | null {
  const raw = swiftNameText(container, source);
  if (!raw) return null;
  const nameParts = raw
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (!nameParts.length) return null;
  const outer: string[] = [];
  let current = container.parent;
  while (current) {
    if (current.type === "class_declaration") {
      const outerRaw = swiftNameText(current, source);
      if (outerRaw) {
        const outerParts = outerRaw
          .split(".")
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        for (let i = outerParts.length - 1; i >= 0; i -= 1) outer.push(outerParts[i] as string);
      }
    }
    current = current.parent;
  }
  outer.reverse();
  return [...outer, ...nameParts].join(".");
}

function getSharedOwnerIdentity(
  container: SyntaxNodeLike,
  source: string,
  languageId: string,
): SharedOwnerIdentity | null {
  if (languageId === "csharp") {
    if (!isCSharpPartialContainer(container, source)) return null;
    const fullPath = getCSharpFullPath(container, source);
    if (!fullPath) return null;
    return { languageId, fullPath };
  }
  if (languageId === "swift") {
    if (isSwiftExtensionContainer(container, source) || isSwiftTypeContainer(container, source)) {
      const fullPath = getSwiftFullPath(container, source);
      if (!fullPath) return null;
      return { languageId, fullPath };
    }
    return null;
  }
  return null;
}

function sharedOwnerIdentitiesEqual(left: SharedOwnerIdentity, right: SharedOwnerIdentity): boolean {
  return left.languageId === right.languageId && left.fullPath === right.fullPath;
}

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
  const ownerIdentity = getSharedOwnerIdentity(ownerContainer, ownerSource, languageId);
  if (!ownerIdentity) return [];
  const peers = getCompilationUnitPeers(index, ownerFile);
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
      const identity = getSharedOwnerIdentity(container, peerContext.source, languageId);
      if (!identity || !sharedOwnerIdentitiesEqual(ownerIdentity, identity)) continue;
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
      if (!out.includes(hit)) out.push(hit);
    }
  }
  return out;
}

function enclosingImportScope(declarationName: SyntaxNodeLike): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = declarationName;
  while (current && current.type !== "variable_declaration") current = current.parent;
  return current?.parent ?? null;
}

export function innermostNamespaceImport(
  imports: readonly ImportBinding[],
  alias: string,
  useNode: SyntaxNodeLike,
): ImportBinding | undefined {
  const matches = imports.filter(
    (candidate): candidate is Extract<ImportBinding, { kind: "namespace" }> =>
      candidate.kind === "namespace" && candidate.localNS === alias,
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

export async function resolveMemberAccessDefinition(params: {
  index: ProjectIndex;
  mod: ModuleIndex;
  node: SyntaxNodeLike;
  source: string;
  sup: LanguageSupport;
  resolveLexicalBinding?: (expression: SyntaxNodeLike) => SymbolDef | null;
}): Promise<GoToResult | null> {
  const { index, mod, node, source, sup, resolveLexicalBinding } = params;
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
      const lexicalBinding = resolveLexicalBinding?.(expr);
      if (lexicalBinding) return { kind: "resolved", def: lexicalBinding };
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
      } else {
        imp = mod.imports.find((candidate) => {
          if (candidate.kind === "named" || candidate.kind === "default") return candidate.local === exprName;
          return candidate.kind === "namespace" && candidate.localNS === exprName;
        });
      }
      if (imp) {
        if (imp.kind === "namespace") {
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
          return { kind: "resolved", def: result };
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
          return resolveExport(index, base.file, memberName, { allowLocalFallback: false });
        }
        if (base?.kind === "resolved") {
          if (sup.id === "java" || sup.id === "csharp") {
            const memberDef = await resolveMemberDefinitionForBase(index, base.def, memberName);
            return memberDef ? { kind: "resolved", def: memberDef } : null;
          }
          if (sup.id === "ruby") {
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

          if (memberDef) {
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
  if (declaresMembers(def)) return def;
  if (def.kind !== SymbolKind.Default) return undefined;
  const module = index.byFile.get(fileIdentityKey(def.file));
  if (!module) return undefined;
  const sameRange = module.locals.filter(
    (local) =>
      declaresMembers(local) &&
      local.range.start.line === def.range.start.line &&
      local.range.start.column === def.range.start.column,
  );
  if (sameRange.length === 1) return sameRange[0];
  const sameName = module.locals.filter((local) => declaresMembers(local) && local.localName === def.localName);
  return sameName.length === 1 ? sameName[0] : undefined;
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

async function baseRefsFromContainer(
  index: ProjectIndex,
  mod: ModuleIndex,
  container: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  superclassOnly: boolean,
): Promise<KeywordClassRef[]> {
  const bases = collectDeclaredBaseTypes(container, source, sup, superclassOnly);
  const refs: KeywordClassRef[] = [];
  const seen = new Set<string>();
  const normalize = (name: string): string => {
    const normalized = sup.normalizeIdentifier(name);
    return sup.id === "php" ? foldPhpIdentifierCase(normalized) : normalized;
  };
  for (const base of bases) {
    const def =
      base.kind === "simple"
        ? resolveNamedMemberContainer(index, mod, base.name, normalize)
        : await resolveQualifiedMemberContainer(index, mod, base.base, base.path, normalize, sup);
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
        const sharedPredicate =
          memberScope === "any"
            ? undefined
            : (local: SymbolDef) => matchesReceiverMemberScope(local, memberScope, shared.context, shared.container);
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
    if (result?.kind === "resolved" && declaresMembers(result.def)) {
      return {
        def: result.def,
        memberScope: hasStaticMemberDistinction(sup.id) ? "instance" : "any",
      };
    }
    if (typedLocals[0]) {
      return {
        def: typedLocals[0],
        memberScope: hasStaticMemberDistinction(sup.id) ? "instance" : "any",
      };
    }
  }
  const direct = await resolveExpression(obj);
  if (direct?.kind === "resolved" && declaresMembers(direct.def)) {
    if (isJsTsLanguage(sup.id) && direct.def.kind === SymbolKind.TypeAlias) {
      return { def: direct.def, memberScope: "any", runtimeTypeOnly: true };
    }
    const memberScope = hasStaticMemberDistinction(sup.id) ? "static" : "any";
    return { def: direct.def, memberScope };
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
    const implNode = findRustImplForType(targetContext.tree.rootNode, receiverDef.localName, targetContext.source);
    return implNode ? findLocalWithinNode(locals, member, implNode, normalizeIdentifier) : undefined;
  }
  if (targetContext.sup.id === "go") {
    return findGoReceiverMember(locals, member, receiverDef.localName, targetContext, normalizeIdentifier);
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
    const range = getCallableArity({ languageId: context.sup.id, source: context.source, declaration: current });
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

async function selectReceiverMemberCandidates(
  index: ProjectIndex,
  candidates: readonly SymbolDef[],
  knownArgumentCount?: number,
  allowUniqueArityMismatch = true,
): Promise<SymbolDef | undefined> {
  const unique = uniqueReceiverMemberCandidates(candidates);
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
      if (
        !isDeclarationParent &&
        !isDirectBody &&
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

function isDirectKeywordMemberDeclaration(declarationNode: SyntaxNodeLike, container: SyntaxNodeLike): boolean {
  if (nearestMemberContainer(declarationNode) !== container) return false;
  let current: SyntaxNodeLike | null = declarationNode;
  while (current && current !== container) {
    const isMethodBody =
      (current.type === "block" || current.type === "compound_statement" || current.type === "statement_block") &&
      current.parent !== container;
    if (isMethodBody) return false;
    current = current.parent;
  }
  return current === container;
}

function findRustImplForType(root: SyntaxNodeLike, typeName: string, source: string): SyntaxNodeLike | null {
  let found: SyntaxNodeLike | null = null;
  const visit = (node: SyntaxNodeLike): boolean => {
    if (node.type === "impl_item") {
      const text = sliceText(node, source);
      if (new RegExp(`^\\s*impl\\s+${escapeRegExp(typeName)}\\b`).test(text)) {
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
  return lookupPythonClassMember(index, classRef, member);
}

async function pythonReceiverClassRef(
  index: ProjectIndex,
  mod: ModuleIndex,
  node: SyntaxNodeLike,
  obj: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  resolveExpression: (expr: SyntaxNodeLike) => Promise<ResolvedExport | null>,
): Promise<PythonClassRef | null> {
  const receiverName = sliceText(obj, source);
  if (receiverName === "self" || receiverName === "cls") {
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
    return pythonClassRefFromDef(index, def);
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
  return pythonClassRefFromDef(index, classDef);
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
): Promise<SymbolDef | undefined> {
  const own = pythonMembersOnClass(start, member);
  if (own.length === 1) return own[0];
  if (own.length > 1) return undefined;

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
