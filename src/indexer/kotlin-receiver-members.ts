/**
 * The member a typed implicit receiver, such as a Kotlin lambda's or extension function's, gives a bare call, as Kotlin
 * sees it from the call: a member the receiver type owns or inherits, or an extension in scope at the call (this
 * file's scopes, an explicit or alias import, the package, a star import), that is accessible there. A member the
 * call cannot reach (a `private` member of another class, a `protected` member the call's class cannot reach) and an
 * extension that is not in scope or on another type are no candidates, so the lookup goes on to the next receiver and
 * finally to the enclosing type, as kotlinc does. A member that accepts the call always outranks an extension.
 */
import { kotlinExtensionReceiverType } from "../graphs/symbol-graph-detailed/ast.js";
import { memberContainerDef, nearestMemberContainer } from "../graphs/symbol-graph-detailed/receiver-calls.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import { normalizeKotlinIdentifier } from "../util/identifiers.js";
import { fileIdentityKey } from "../util/paths.js";
import { getPackageDeclarationName } from "./compilation-units.js";
import { projectCallablesNamed } from "./kotlin-callable-index.js";
import { externalTypeNames, resolveExternalType } from "./kotlin-external-receivers.js";
import {
  declarationReaches,
  findReceiverTypeMember,
  type ExternalBaseOmits,
  type ReceiverTypeMember,
} from "./navigation-goto.js";
import { findClosestScopeBinding, getOrBuildScopeIndex } from "./navigation-local.js";
import { definitionWithoutDeferredSteps, type JvmTypeNameResolver } from "./name-resolution-types.js";
import {
  declarationNodeOf,
  kotlinCallableAcceptsTrailingLambda,
  kotlinHasTrailingLambda,
  unindexedType,
} from "./kotlin-call-compatibility.js";
import { bindsTypeParameter, kotlinSingleUpperBound } from "./type-parameters.js";
import type { ParsedFileContext } from "./parse-context.js";
import type { ScopeIndex } from "./scope.js";
import { type ModuleIndex, type ProjectIndex, type SymbolDef, SymbolKind } from "./types.js";

/** Whether the member can be called at the use: proven either way, or "unproven" when nothing indexed settles it. */
type MemberAccess = "visible" | "hidden" | "unproven";

type Visibility = "public" | "private" | "protected" | "internal";

type ReceiverTypeEvidence = {
  node: SyntaxNodeLike;
  site: { mod: ModuleIndex; parsed: ParsedFileContext; scopeIndex: ScopeIndex };
};

/** Where a receiver member is looked up from. */
type AccessSite = {
  index: ProjectIndex;
  mod: ModuleIndex;
  use: SyntaxNodeLike;
  receiver?: SymbolDef;
  externalReceiver?: string;
  unindexedReceiver?: ReceiverTypeEvidence;
};

const OMITTED: ReceiverTypeMember = { status: "omitted" };
const UNPROVEN: ReceiverTypeMember = { status: "unproven" };

const UNPROVEN_SHADOWING: ReceiverTypeMember = { status: "unproven", blocksFallback: true };

/** The visibility modifier a declaration spells; a declaration with none is public. */
export function declaredVisibility(declaration: SyntaxNodeLike): Visibility {
  const modifiers = declaration.namedChildren.find((child) => child.type === "modifiers");
  const keyword = modifiers?.namedChildren.find((child) => child.type === "visibility_modifier")?.text.trim();
  if (keyword === "private" || keyword === "protected" || keyword === "internal") return keyword;
  return "public";
}

function usesFile(site: AccessSite, file: string): boolean {
  return fileIdentityKey(site.mod.file) === fileIdentityKey(file);
}

/** Whether the use sits lexically inside `container`, a class declared in `file`. */
function usesInside(site: AccessSite, container: SyntaxNodeLike, file: string): boolean {
  const { use } = site;
  return usesFile(site, file) && container.startIndex <= use.startIndex && use.endIndex <= container.endIndex;
}

/**
 * Whether a top-level declaration of another file is in scope in `mod`: its package is the file's, or it is imported
 * by name or by star.
 */
export function topLevelDeclarationInScope(index: ProjectIndex, mod: ModuleIndex, def: SymbolDef): boolean {
  const packageName = getPackageDeclarationName(index, def.file, "kotlin");
  if (packageName === getPackageDeclarationName(index, mod.file, "kotlin")) return true;
  const name = normalizeKotlinIdentifier(def.localName);
  const qualified = packageName ? `${packageName}.${name}` : name;
  return mod.imports.some((imp) => {
    if (imp.kind === "star") return !!packageName && imp.from === packageName;
    return imp.kind === "named" && imp.from === qualified && normalizeKotlinIdentifier(imp.imported) === name;
  });
}

/**
 * A `protected` member is callable from a class that derives from its declaring class, on a receiver of that class's
 * own kind: kotlinc skips `Base.prot()` called on a `Base` receiver from inside a subclass, and calls the subclass's.
 */
async function protectedAccess(site: AccessSite, member: SymbolDef, declaring: SyntaxNodeLike): Promise<MemberAccess> {
  if (!site.receiver) return "unproven";
  const target = { file: member.file, containerStart: declaring.startIndex };
  for (let using = nearestMemberContainer(site.use); using; using = nearestMemberContainer(using)) {
    const usingDef = memberContainerDef(site.mod, using);
    if (!usingDef) return "unproven";
    const derives = await declarationReaches(site.index, usingDef, target);
    if (derives === "unknown") return "unproven";
    if (derives === "no") continue;
    const fits = await declarationReaches(site.index, site.receiver, {
      file: site.mod.file,
      containerStart: using.startIndex,
    });
    if (fits !== "no") return fits === "yes" ? "visible" : "unproven";
  }
  return "hidden";
}

function privateAccess(site: AccessSite, member: SymbolDef, container: SyntaxNodeLike | null): MemberAccess {
  if (!container) return usesFile(site, member.file) ? "visible" : "hidden";
  return usesInside(site, container, member.file) ? "visible" : "hidden";
}

async function memberAccess(site: AccessSite, member: SymbolDef): Promise<MemberAccess> {
  const declared = await declarationNodeOf(site.index, member);
  if (!declared) return "unproven";
  const { node } = declared;
  const topLevel = node.parent?.type === "source_file";
  const container = topLevel ? null : nearestMemberContainer(node);
  const extension = !!kotlinExtensionReceiverType(node);
  // A member extension needs the `this` of the class that declares it.
  if (extension && container && !usesInside(site, container, member.file)) return "hidden";
  const visibility = declaredVisibility(node);
  if (visibility === "private") return privateAccess(site, member, container);
  if (visibility === "protected") {
    if (extension && container && usesInside(site, container, member.file)) return "visible";
    return container ? protectedAccess(site, member, container) : "unproven";
  }
  // `internal` is visible within a module, and no module is modeled: only the same file is proven.
  if (visibility === "internal" && !usesFile(site, member.file)) return "unproven";
  if (extension && topLevel && !usesFile(site, member.file)) {
    return topLevelDeclarationInScope(site.index, site.mod, member) ? "visible" : "hidden";
  }
  return "visible";
}

/** A supertype outside the project that is a known external type lacking `name` cannot declare it. */
function externalBasesLacking(name: string): ExternalBaseOmits {
  const normalized = normalizeKotlinIdentifier(name);
  return (spelling, module) => {
    const fqn = resolveExternalType(module, spelling);
    const names = fqn ? externalTypeNames(fqn) : undefined;
    return !!names && !names.has(normalized);
  };
}

/** Whether a call with `argumentCount` arguments can be made to `def`: unknown counts and arities accept. */
export function acceptsArgumentCount(def: SymbolDef, argumentCount: number | undefined): boolean {
  const arity = def.callable?.arity;
  if (argumentCount === undefined || !arity) return true;
  return argumentCount >= arity.minArgs && (arity.maxArgs === null || argumentCount <= arity.maxArgs);
}

/** Scope priority for a callable extension, with explicit imports before package peers and star imports. */
function extensionScopeRank(
  site: AccessSite,
  def: SymbolDef,
  declaration: SyntaxNodeLike,
  name: string,
): number | null {
  const sameFile = usesFile(site, def.file);
  const parent = declaration.parent;
  if (!parent) return null;
  if (parent.type !== "source_file") {
    if (!sameFile || parent.startIndex > site.use.startIndex || parent.endIndex < site.use.endIndex) return null;
    return 0;
  }
  const declaredName = normalizeKotlinIdentifier(def.localName);
  const useName = normalizeKotlinIdentifier(name);
  const packageName = getPackageDeclarationName(site.index, def.file, "kotlin");
  const qualified = packageName ? `${packageName}.${declaredName}` : declaredName;
  for (const imp of site.mod.imports) {
    if (imp.kind !== "named" || imp.jvmPackageLanguageId) continue;
    if (imp.from !== qualified || normalizeKotlinIdentifier(imp.local) !== useName) continue;
    if (normalizeKotlinIdentifier(imp.imported) === declaredName) return 1;
  }
  if (useName !== declaredName) return null;
  if (sameFile || packageName === getPackageDeclarationName(site.index, site.mod.file, "kotlin")) return 2;
  return site.mod.imports.some((imp) => imp.kind === "star" && imp.from === packageName) ? 3 : null;
}

/** Identical declared bindings prove an external receiver's identity, but never an external subtype. */
export function sameUnindexedReceiver(receiver: ReceiverTypeEvidence, extension: ReceiverTypeEvidence): boolean {
  const receiverType = unindexedType(receiver.node);
  const extensionType = unindexedType(extension.node);
  if (receiverType.nullable && !extensionType.nullable) return false;
  const receiverName = receiverType.name;
  const extensionName = extensionType.name;
  const name = receiverName.text;
  const { parsed, scopeIndex } = receiver.site;
  if (bindsTypeParameter(name, receiverName, parsed.source, parsed.sup)) return false;
  const target = extension.site;
  if (bindsTypeParameter(extensionName.text, extensionName, target.parsed.source, target.parsed.sup)) return false;
  const receiverBinding = findClosestScopeBinding(scopeIndex, name, receiverName, parsed.sup, true);
  const extensionBinding = findClosestScopeBinding(
    target.scopeIndex,
    extensionName.text,
    extensionName,
    target.parsed.sup,
    true,
  );
  if (fileIdentityKey(receiver.site.mod.file) === fileIdentityKey(target.mod.file)) {
    return name === extensionName.text && receiverBinding === extensionBinding;
  }
  const receiverImport = receiverBinding?.import;
  const extensionImport = extensionBinding?.import;
  if (receiverBinding && !receiverImport) return false;
  if (extensionBinding && !extensionImport) return false;
  if (receiverImport?.kind === "named") {
    return !!resolveExternalType(target.mod, extensionName.text, [receiverImport.from]);
  }
  if (extensionImport?.kind === "named") {
    return !!resolveExternalType(receiver.site.mod, name, [extensionImport.from]);
  }
  return false;
}

/** A fallback extension is a target only when the implicit receiver proves its declared receiver type. */
export async function extensionReceiverApplies(
  site: AccessSite,
  def: SymbolDef,
  declared: { node: SyntaxNodeLike; parsed: ParsedFileContext },
  typeNode: SyntaxNodeLike,
  resolveTypeName: JvmTypeNameResolver,
): Promise<{ applies: "yes" | "no" | "unknown"; target: SymbolDef | null }> {
  const mod = site.index.byFile.get(fileIdentityKey(def.file));
  let type = typeNode.type === "nullable_type" ? typeNode.namedChildren[0] : typeNode;
  if (!mod || !type) return { applies: "no", target: null };
  let matchingType = typeNode;
  let lookup = unindexedType(type).name;
  if (bindsTypeParameter(lookup.text, lookup, declared.parsed.source, declared.parsed.sup)) {
    const bound = kotlinSingleUpperBound(lookup, declared.parsed.source, declared.parsed.sup);
    if (!bound) return { applies: "unknown", target: null };
    type = bound;
    matchingType = bound;
    lookup = unindexedType(bound).name;
  }
  const scopeIndex = getOrBuildScopeIndex(
    site.index,
    def.file,
    declared.parsed.source,
    declared.parsed.sup,
    mod,
    declared.parsed.tree,
  );
  const target = definitionWithoutDeferredSteps(
    await resolveTypeName(site.index, mod, declared.parsed, scopeIndex, lookup),
  );
  if (!target && resolveExternalType(mod, type.text, ["kotlin.Any"])) {
    const nullableReceiver = site.unindexedReceiver && unindexedType(site.unindexedReceiver.node).nullable;
    const acceptsNullable = typeNode.type === "nullable_type";
    return { applies: nullableReceiver && !acceptsNullable ? "no" : "yes", target: null };
  }
  if (site.unindexedReceiver) {
    const matches = sameUnindexedReceiver(site.unindexedReceiver, {
      node: matchingType,
      site: { mod, parsed: declared.parsed, scopeIndex },
    });
    return { applies: matches ? "yes" : "no", target: null };
  }
  if (target && (target.kind === SymbolKind.Class || target.kind === SymbolKind.Interface)) {
    if (!site.receiver) return { applies: "no", target };
    const sameReceiver =
      fileIdentityKey(target.file) === fileIdentityKey(site.receiver.file) &&
      target.range.start.index === site.receiver.range.start.index;
    if (sameReceiver) return { applies: "yes", target };
    const owner = await declarationNodeOf(site.index, target);
    const applies = owner
      ? await declarationReaches(site.index, site.receiver, {
          file: target.file,
          containerStart: owner.node.startIndex,
        })
      : "unknown";
    return { applies, target };
  }
  if (!target && site.receiver) {
    const owner = await declarationNodeOf(site.index, site.receiver);
    const packageName = getPackageDeclarationName(site.index, site.receiver.file, "kotlin");
    const qualified = packageName ? `${packageName}.${site.receiver.localName}` : site.receiver.localName;
    const importedReceiver =
      owner?.node.parent?.type === "source_file" && resolveExternalType(mod, type.text, [qualified]);
    if (importedReceiver) return { applies: "yes", target: site.receiver };
  }
  if (!target && site.externalReceiver && resolveExternalType(mod, type.text, [site.externalReceiver])) {
    return { applies: "yes", target: null };
  }
  return { applies: "unknown", target };
}

async function compareExtensionOwnerSpecificity(
  index: ProjectIndex,
  candidate: SymbolDef,
  previous: SymbolDef,
): Promise<"more-specific" | "less-specific" | "ambiguous"> {
  const previousOwner = await declarationNodeOf(index, previous);
  const candidateOwner = await declarationNodeOf(index, candidate);
  if (!previousOwner || !candidateOwner) return "ambiguous";
  const candidateReachesPrevious = await declarationReaches(index, candidate, {
    file: previous.file,
    containerStart: previousOwner.node.startIndex,
  });
  const previousReachesCandidate = await declarationReaches(index, previous, {
    file: candidate.file,
    containerStart: candidateOwner.node.startIndex,
  });
  if (candidateReachesPrevious === "yes" && previousReachesCandidate === "no") return "more-specific";
  if (previousReachesCandidate === "yes" && candidateReachesPrevious === "no") return "less-specific";
  return "ambiguous";
}

/** Search callable extensions in the use site's scopes, proving their receiver identity instead of comparing names. */
async function inScopeExtension(
  site: AccessSite,
  name: string,
  argumentCount: number | undefined,
  resolveTypeName: JvmTypeNameResolver,
  receiverNullable = false,
): Promise<ReceiverTypeMember> {
  const names = new Set([normalizeKotlinIdentifier(name)]);
  for (const imp of site.mod.imports) {
    if (imp.kind === "named" && normalizeKotlinIdentifier(imp.local) === normalizeKotlinIdentifier(name)) {
      names.add(normalizeKotlinIdentifier(imp.imported));
    }
  }
  let bestRank = Infinity;
  let selected: SymbolDef | null = null;
  let selectedType: SymbolDef | null = null;
  let uncertain = false;
  const trailingLambda = kotlinHasTrailingLambda(site.use);
  for (const candidateName of names) {
    for (const def of projectCallablesNamed(site.index, candidateName)) {
      if (def.kind !== SymbolKind.Function) continue;
      if (!usesFile(site, def.file)) {
        if (def.isMember || !topLevelDeclarationInScope(site.index, site.mod, def)) continue;
      }
      if (!acceptsArgumentCount(def, argumentCount)) continue;
      if (trailingLambda && !(await kotlinCallableAcceptsTrailingLambda(site.index, def))) continue;
      const declared = await declarationNodeOf(site.index, def);
      if (!declared) continue;
      const typeNode = kotlinExtensionReceiverType(declared.node);
      if (!typeNode) continue;
      if (receiverNullable && typeNode.type !== "nullable_type") continue;
      const rank = extensionScopeRank(site, def, declared.node, name);
      if (rank === null || rank > bestRank) continue;
      const access = await memberAccess(site, def);
      if (access === "hidden") continue;
      const { applies, target } = await extensionReceiverApplies(site, def, declared, typeNode, resolveTypeName);
      if (applies === "no") continue;
      if (rank < bestRank) {
        bestRank = rank;
        selected = null;
        selectedType = null;
        uncertain = false;
      }
      if (applies === "unknown" || access === "unproven") {
        uncertain = true;
        continue;
      }
      if (!selected) {
        selected = def;
        selectedType = target;
        continue;
      }
      if (!selectedType || !target) {
        uncertain = true;
        continue;
      }
      const specificity = await compareExtensionOwnerSpecificity(site.index, target, selectedType);
      if (specificity === "more-specific") {
        selected = def;
        selectedType = target;
      } else if (specificity === "ambiguous") {
        uncertain = true;
      }
    }
  }
  if (uncertain) return UNPROVEN_SHADOWING;
  return selected ? { status: "member", member: selected } : OMITTED;
}

/** Project extensions visible on a known external receiver whose own name list omits the requested name. */
export function lookupExternalReceiverExtension(
  index: ProjectIndex,
  mod: ModuleIndex,
  use: SyntaxNodeLike,
  receiver: string,
  member: string,
  argumentCount: number | undefined,
  resolveTypeName: JvmTypeNameResolver,
): Promise<ReceiverTypeMember> {
  return inScopeExtension({ index, mod, use, externalReceiver: receiver }, member, argumentCount, resolveTypeName);
}

/** A unique exact-type extension may bind an external receiver, but never bypass an indexed project member. */
export async function lookupUnindexedReceiverExtension(
  index: ProjectIndex,
  mod: ModuleIndex,
  use: SyntaxNodeLike,
  receiver: ReceiverTypeEvidence,
  member: string,
  argumentCount: number | undefined,
  resolveTypeName: JvmTypeNameResolver,
): Promise<ReceiverTypeMember> {
  const extension = await inScopeExtension(
    { index, mod, use, unindexedReceiver: receiver },
    member,
    argumentCount,
    resolveTypeName,
  );
  if (extension.status !== "member") return extension;
  const declaredType = unindexedType(receiver.node);
  if (declaredType.nullable) return extension;
  const type = declaredType.name;
  let simpleName = type.text;
  for (const child of type.namedChildren) {
    if (child.type === "identifier") simpleName = child.text;
  }
  const receiverPackage = getPackageDeclarationName(index, receiver.site.mod.file, "kotlin");
  const binding = findClosestScopeBinding(receiver.site.scopeIndex, type.text, type, receiver.site.parsed.sup, true);
  const projectTypeName = binding?.import?.kind === "named" ? binding.import.imported : simpleName;
  let omitsExternalBase: ExternalBaseOmits | undefined;
  for (const candidate of projectCallablesNamed(index, projectTypeName)) {
    if (candidate.kind !== SymbolKind.Class || candidate.isMember) continue;
    const packageName = getPackageDeclarationName(index, candidate.file, "kotlin");
    const samePackageType =
      !binding?.import &&
      packageName === receiverPackage &&
      normalizeKotlinIdentifier(type.text) === normalizeKotlinIdentifier(candidate.localName);
    const qualified = packageName ? `${packageName}.${candidate.localName}` : candidate.localName;
    if (!samePackageType && !resolveExternalType(receiver.site.mod, type.text, [qualified])) continue;
    omitsExternalBase ??= externalBasesLacking(member);
    const found = await findReceiverTypeMember(
      index,
      mod,
      use,
      candidate,
      member,
      argumentCount,
      omitsExternalBase,
      "call",
    );
    if (found.status !== "omitted") return UNPROVEN_SHADOWING;
  }
  return extension;
}

/** Project extensions in scope on the project receiver type `receiver`, for a call its own members cannot take. */
export function lookupReceiverTypeExtension(
  index: ProjectIndex,
  mod: ModuleIndex,
  use: SyntaxNodeLike,
  receiver: SymbolDef,
  member: string,
  argumentCount: number | undefined,
  resolveTypeName: JvmTypeNameResolver,
): Promise<ReceiverTypeMember> {
  return inScopeExtension({ index, mod, use, receiver }, member, argumentCount, resolveTypeName);
}

/**
 * Looks `member` up on the type `receiver` of an implicit receiver and keeps only what the call at `use` can reach: an
 * accessible member that takes the call's arguments wins, else an extension in scope on the receiver. A member that is
 * not accessible there is passed over, and one whose accessibility nothing indexed proves leaves the call `unproven`.
 * `omitted` hands the call to the next receiver and the enclosing type. A nullable receiver reaches only extensions
 * declared for a nullable receiver. `memberUse` says whether `use` calls the member or reads it, which the shared
 * member selection needs to prefer a method or an invokable property for a call.
 */
export async function lookupReceiverTypeMember(
  index: ProjectIndex,
  mod: ModuleIndex,
  use: SyntaxNodeLike,
  receiver: SymbolDef,
  member: string,
  argumentCount: number | undefined,
  resolveTypeName: JvmTypeNameResolver,
  receiverNullable = false,
  memberUse?: "call" | "value",
): Promise<ReceiverTypeMember> {
  const site = { index, mod, use, receiver };
  if (receiverNullable) return inScopeExtension(site, member, argumentCount, resolveTypeName, true);
  const found = await findReceiverTypeMember(
    index,
    mod,
    use,
    receiver,
    member,
    argumentCount,
    externalBasesLacking(member),
    memberUse,
  );
  let unprovenMember = found.status === "unproven";
  if (found.status === "member") {
    const access = await memberAccess(site, found.member);
    unprovenMember = access === "unproven";
    if (access === "visible" && acceptsArgumentCount(found.member, argumentCount)) return found;
  }
  const extension = await inScopeExtension(site, member, argumentCount, resolveTypeName);
  if (!unprovenMember) return extension;
  return extension.status === "omitted" ? UNPROVEN : UNPROVEN_SHADOWING;
}
