/**
 * One lookup order for a bare name at a use site, shared by go-to-definition, references (which
 * verify through go-to-definition), and the detailed call graph.
 *
 * `resolveBareName` is synchronous: it reads parsed files through a parsed-file provider
 * and never awaits. The few steps that need async member lookup return a `deferred` resolution
 * with the answer to use when that lookup finds nothing; {@link settleNameResolution} runs those
 * steps. Navigation settles immediately; the graph settles after its body walk.
 */

import type { SyntaxNodeLike } from "../languages/types.js";
import type { FileId } from "../types.js";

import { sliceText } from "../util/ast.js";
import {
  collectMemberAccessChain,
  isReceiverNameNode,
  isQualifiedTypeSuffix,
  jvmQualifiedTypeSegments,
  kotlinQualifiedExpression,
} from "../util/member-access.js";
import { isSwiftQualifiedTypeSuffix, swiftQualifiedTypeSegments } from "../util/swift-tree.js";
import { fileIdentityKey } from "../util/paths.js";
import {
  isAmbiguousResolutionReason,
  AMBIGUOUS_CSHARP_ALIAS_MEMBER_REASON,
  AMBIGUOUS_IMPLICIT_MEMBER_REASON,
  UNPROVEN_CSHARP_ALIAS_MEMBER_REASON,
  UNRESOLVED_QUALIFIED_TYPE_REASON,
} from "./ambiguous-resolution.js";
import { declaresMembers } from "../graphs/symbol-graph-detailed/receiver-calls.js";

import {
  csharpAliasAt,
  csharpAliasMemberLookup,
  memberAcceptsCallAt,
  resolveCppOutOfLineImplicitMember,
  resolveImplicitSelfMember,
  resolveJvmQualifiedPath,
  resolveSwiftNestedTypePath,
} from "./navigation-goto.js";
import {
  definitionForBinding,
  findClosestScopeBinding,
  laterLocalShadowsUse,
  resolveNamedDefinition,
} from "./navigation-local.js";

import { okGoToResult } from "./navigation-provenance.js";

import { createLoadingParsedFileProvider, withParsedFiles } from "./parsed-cache.js";

import { nameLookupPolicyFor } from "./name-lookup-policies/index.js";
import type { BareNameUse, JvmTypeNameResolver, NameLookupState, NameResolution } from "./name-resolution-types.js";

export type {
  BareNameUse,
  DeferredNameRequest,
  NameLookupPolicy,
  NameLookupState,
  NameResolution,
} from "./name-resolution-types.js";

import { type GoToResult, type ImportBinding, type ModuleIndex, type ProjectIndex, type SymbolDef } from "./types.js";
import { fileBindingIsUnshadowed } from "./scope.js";

import { importBindingReferenceSites } from "./navigation-references.js";

import { rangeContains } from "./reference-context.js";

/** PHP import role (class, function, or const) of the import that covers a 0-based position. */
export function phpImportTypeAtPosition(
  imports: readonly ImportBinding[],
  line: number,
  column: number,
): "class" | "function" | "const" | undefined {
  for (const imp of imports) {
    if (imp.kind !== "named" || imp.mechanism !== "php") continue;
    if (
      importBindingReferenceSites(imp).some((site) => rangeContains(site.range, { row: line + 1, column: column + 1 }))
    ) {
      return imp.phpImportType ?? "class";
    }
  }
  return undefined;
}

/** Resolve JVM type syntax using the same on-demand parsed files as positioned navigation. */
export const resolveJvmTypeName: JvmTypeNameResolver = (index, mod, parsed, scopeIndex, node) => {
  const files = createLoadingParsedFileProvider(index, { file: mod.file, parsed });
  const use: BareNameUse = {
    index,
    mod,
    file: mod.file,
    parsed,
    scopeIndex,
    files,
    node,
    name: sliceText(node, parsed.source),
  };
  return withParsedFiles(files, () => resolveBareName(use));
};

/** File import aliases yield to closer lexical bindings unless a language policy says otherwise. */
export function moduleAliasIsUnshadowed(use: BareNameUse, aliasFrom?: string): boolean {
  const policy = nameLookupPolicyFor(use.parsed.sup.id);
  if (policy.shadowsModuleAlias?.(use)) return false;
  const closestBinding = findClosestScopeBinding(use.scopeIndex, use.name, use.node, use.parsed.sup);
  if (policy.moduleAliasIsUnshadowed) {
    return policy.moduleAliasIsUnshadowed({ use, lookupName: use.name, closestBinding });
  }
  return fileBindingIsUnshadowed(use.scopeIndex, closestBinding, aliasFrom);
}

/** Resolves a qualified JVM name through a visible type owner or a declared package, never a bare suffix. */
function resolveQualifiedJvmName(
  use: BareNameUse,
  root: SyntaxNodeLike,
  parts: readonly string[],
  typeOnly: boolean,
): SymbolDef | null {
  const { index, file, parsed, scopeIndex } = use;
  const languageId = parsed.sup.id === "java" ? "java" : "kotlin";
  const rootName = parts[0]!;
  let rootResult = resolveBareName({ ...use, node: root, name: rootName }, typeOnly);
  while (rootResult?.status === "deferred") rootResult = rootResult.fallback;
  const definition = rootResult?.status === "ok" ? rootResult.definition : null;
  const rootDefinition = typeOnly && definition && !declaresMembers(definition) ? null : definition;
  const rootBinding = findClosestScopeBinding(scopeIndex, rootName, root, parsed.sup, typeOnly);
  if (rootDefinition || rootBinding) {
    if (!rootDefinition || !declaresMembers(rootDefinition)) return null;
    return resolveJvmQualifiedPath(index, file, languageId, rootDefinition, parts, typeOnly);
  }
  if (rootResult?.status === "not_found" && isAmbiguousResolutionReason(rootResult.reason)) return null;
  return resolveJvmQualifiedPath(index, file, languageId, null, parts, typeOnly);
}

/**
 * A later segment of a dotted Swift type (`Base` in `Other.Base`) names a type nested in the segments before it, so its
 * own spelling never binds a bare name. The first segment is looked up as an ordinary name and must declare members;
 * the nested walk runs when the resolution is settled. A root that binds nothing, or a generic owner, proves no path.
 */
function resolveSwiftQualifiedTypeSuffix(use: BareNameUse): NameResolution | undefined {
  const { node, parsed } = use;
  if (!isSwiftQualifiedTypeSuffix(node)) return undefined;
  const unproven: NameResolution = { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
  const segments = swiftQualifiedTypeSegments(node);
  if (!segments) return unproven;
  const root = segments[0]!;
  let rootResult = resolveBareName({ ...use, node: root, name: sliceText(root, parsed.source) });
  while (rootResult?.status === "deferred") rootResult = rootResult.fallback;
  const owner = rootResult?.status === "ok" ? rootResult.definition : null;
  if (!owner || !declaresMembers(owner)) return unproven;
  const names = segments.slice(1).map((segment) => sliceText(segment, parsed.source));
  return { status: "deferred", request: { kind: "swift-nested-type", owner, names }, fallback: unproven };
}

/**
 * Resolves a bare (unqualified or C++-qualified) name at a use site. Returns `null` when no
 * lookup step answers; go-to-definition then tries a declaration at the position.
 *
 * Shared order: language pre-lexical steps, closest scope binding, its definition (with
 * overloads chosen by arity), a local declared later in the same scope, then cross-module
 * lookup (imports, compilation-unit peers, star imports) through {@link resolveNamedDefinition}.
 */
export function resolveBareName(
  use: BareNameUse,
  jvmTypeOnly = false,
  skipKotlinQualifiedExpression = false,
): NameResolution | null {
  const { index, mod, file, parsed, scopeIndex, node } = use;
  const { sup, source, tree } = parsed;
  if (sup.id === "java" || sup.id === "kotlin") {
    const qualifiedSuffix = isQualifiedTypeSuffix(sup, node);
    const qualifiedContainer = node.type === "user_type" || node.type === "scoped_type_identifier";
    const segments = qualifiedSuffix || qualifiedContainer ? jvmQualifiedTypeSegments(sup, node) : null;
    if (segments) {
      const parts = segments.map((segment) => sliceText(segment, source));
      const target = resolveQualifiedJvmName(use, segments[0]!, parts, true);
      return target
        ? okGoToResult(index, target, { resolution: "member-access", confidence: "medium" })
        : { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
    }
    if (qualifiedSuffix) {
      return { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
    }
    const expression = skipKotlinQualifiedExpression ? null : kotlinQualifiedExpression(sup, node);
    if (expression) {
      const chain = collectMemberAccessChain({ sup, source, chainNode: expression });
      if (!chain || !isReceiverNameNode(sup, chain.base.type)) {
        return { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
      }
      const parts = [sliceText(chain.base, source), ...chain.names.toReversed()];
      const target = resolveQualifiedJvmName(use, chain.base, parts, false);
      return target
        ? okGoToResult(index, target, { resolution: "member-access", confidence: "medium" })
        : { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
    }
  }
  if (sup.id === "swift") {
    const qualifiedType = resolveSwiftQualifiedTypeSuffix(use);
    if (qualifiedType) return qualifiedType;
  }
  const policy = nameLookupPolicyFor(sup.id);
  const lookupName = policy.lookupName?.(use) ?? use.name;
  const early = policy.beforeLexical?.(use, lookupName);
  if (early !== undefined) return early;
  let found = findClosestScopeBinding(scopeIndex, lookupName, node, sup, jvmTypeOnly);
  // A binding the language never reads at this use gives way to the earlier one declared in the same scope.
  while (found && policy.ignoresBinding?.(use, found)) found = found.earlierSameScope ?? null;
  const state: NameLookupState = {
    use,
    lookupName,
    closestBinding: found,
  };
  const fromBinding = policy.fromClosestBinding?.(state);
  if (fromBinding !== undefined) return fromBinding;
  const rest = (): NameResolution | null => {
    const beforeLocal = policy.beforeLocal?.(state);
    if (beforeLocal !== undefined) return beforeLocal;
    const { closestBinding } = state;
    const local = closestBinding ? definitionForBinding(closestBinding, file, node, sup, source, tree) : null;
    if (local) {
      const adjusted = policy.onLocal?.(state, local);
      if (adjusted !== undefined) return adjusted;
      return okGoToResult(index, local, { resolution: "exact", confidence: "high" });
    }
    const unbound = policy.onUnboundLocal?.(state);
    if (unbound !== undefined) return unbound;
    if (!jvmTypeOnly && laterLocalShadowsUse(scopeIndex, lookupName, node, sup)) {
      return { status: "not_found", reason: "Local is not in scope before its declaration" };
    }
    const beforeCrossModule = policy.beforeCrossModule?.(state);
    if (beforeCrossModule !== undefined) return beforeCrossModule;
    if (!sup.supportsCrossModuleSymbols) return null;
    const resolved = resolveNamedDefinition(
      index,
      mod,
      file,
      sup,
      policy.crossModuleName?.(state) ?? lookupName,
      policy.cNamespace?.(node),
      node.startIndex,
      { node, source },
      scopeIndex,
    );
    const adjusted = policy.afterCrossModule?.(state, resolved);
    return adjusted !== undefined ? adjusted : resolved;
  };
  return policy.wrapRest ? policy.wrapRest(state, rest) : rest();
}

/** How a consumer settles deferred steps. */
export type SettleNameOptions = {
  /** The graph records no edge when the member a call names cannot accept its argument count. */
  requireAcceptedArity?: boolean;
  /** Resolves included C/C++ star candidates; navigation owns this recovery. */
  recoverIncludedStar?: (lookupName: string, cNamespace: "tag" | "ordinary" | undefined) => Promise<GoToResult | null>;
};

/**
 * A C# name that a using alias also names: a member of an enclosing type binds it first (only a nested type in a type
 * position). Project bases and partial parts must be readable; members of external bases are not indexed.
 */
async function settleCsharpAliasMember(use: BareNameUse, lookupName: string): Promise<GoToResult | undefined> {
  const { index, mod, node } = use;
  const lookup = await csharpAliasMemberLookup(index, mod, node, lookupName);
  if (lookup.status === "none") return undefined;
  if (lookup.status === "unproven") {
    if (!csharpAliasAt(mod, lookupName, node)) return undefined;
    return { status: "not_found", reason: UNPROVEN_CSHARP_ALIAS_MEMBER_REASON };
  }
  if (!lookup.member) return { status: "not_found", reason: AMBIGUOUS_CSHARP_ALIAS_MEMBER_REASON };
  return okGoToResult(index, lookup.member, { resolution: "member-access", confidence: "medium" });
}

/** Runs the async member steps a {@link resolveBareName} result deferred. */
export async function settleNameResolution(
  use: BareNameUse,
  resolution: NameResolution | null,
  options: SettleNameOptions = {},
): Promise<GoToResult | null> {
  let current = resolution;
  while (current?.status === "deferred") {
    const { request, fallback, hidden } = current;
    const { index, mod, node, name, parsed } = use;
    if (request.kind === "cpp-out-of-line-member") {
      const member = await resolveCppOutOfLineImplicitMember(
        index,
        mod,
        node,
        name,
        parsed.source,
        parsed.sup,
        options.requireAcceptedArity,
      );
      if (member) return okGoToResult(index, member, { resolution: "member-access", confidence: "high" });
      if (member === null) return hidden ?? null;
    } else if (request.kind === "implicit-self-member") {
      const member = await resolveImplicitSelfMember(
        index,
        mod,
        node,
        request.lookupName,
        parsed.source,
        parsed.sup.id,
      );
      // The graph records no edge for a call its target cannot accept, and does not fall back.
      if (
        member &&
        options.requireAcceptedArity &&
        !memberAcceptsCallAt(index, member, node, parsed.source, parsed.sup.id)
      ) {
        return null;
      }
      if (member) return okGoToResult(index, member, { resolution: "member-access", confidence: "medium" });
      // A member hides the name but none is a unique, reachable target (static context, ambiguity).
      if (member === null) return { status: "not_found", reason: AMBIGUOUS_IMPLICIT_MEMBER_REASON };
    } else if (request.kind === "csharp-alias-member") {
      const settled = await settleCsharpAliasMember(use, request.lookupName);
      if (settled) return settled;
    } else if (request.kind === "swift-nested-type") {
      const nested = await resolveSwiftNestedTypePath(index, request.owner, request.names);
      if (nested) return okGoToResult(index, nested, { resolution: "member-access", confidence: "medium" });
    } else {
      const recovered = await options.recoverIncludedStar?.(request.lookupName, request.cNamespace);
      if (recovered) return recovered;
    }
    current = fallback;
  }
  return current;
}

/**
 * Files a synchronous consumer must load before resolving names in `mod`: the file itself, its
 * resolved imports (TS/TSX overload checks read import targets), and for C++ the transitive
 * include closure. A lookup that reads any other file finds it missing and skips that check.
 */
export function nameResolutionPreloadFiles(index: ProjectIndex, mod: ModuleIndex, languageId: string): FileId[] {
  const files = new Map<string, FileId>([[fileIdentityKey(mod.file), mod.file]]);
  for (const file of nameLookupPolicyFor(languageId).preloadFiles?.(index, mod) ?? []) {
    files.set(fileIdentityKey(file), file);
  }
  return [...files.values()];
}
