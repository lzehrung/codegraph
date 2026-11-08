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
import { getOrBuildScopeIndex } from "./navigation-local.js";
import { definitionWithoutDeferredSteps, type JvmTypeNameResolver } from "./name-resolution-types.js";
import { bindsTypeParameter } from "./type-parameters.js";
import type { ParsedFileContext } from "./parse-context.js";
import { ensureParsedContextForIndex, rethrowStaleQuerySource } from "./parsed-cache.js";
import { type ModuleIndex, type ProjectIndex, type SymbolDef, SymbolKind } from "./types.js";

/** Whether the member can be called at the use: proven either way, or "unproven" when nothing indexed settles it. */
type MemberAccess = "visible" | "hidden" | "unproven";

type Visibility = "public" | "private" | "protected" | "internal";

/** Where a receiver member is looked up from. */
type AccessSite = {
  index: ProjectIndex;
  mod: ModuleIndex;
  use: SyntaxNodeLike;
  receiver?: SymbolDef;
  externalReceiver?: string;
};

const OMITTED: ReceiverTypeMember = { status: "omitted" };
const UNPROVEN: ReceiverTypeMember = { status: "unproven" };

/** Nodes that carry the modifiers of a declaration. */
const DECLARATION_NODE_TYPES: Readonly<Record<string, true>> = {
  class_parameter: true,
  function_declaration: true,
  property_declaration: true,
  class_declaration: true,
  object_declaration: true,
  enum_entry: true,
};

/** The declaration a definition names, with its parsed file; null when that file cannot be read. */
export async function declarationNodeOf(
  index: ProjectIndex,
  def: SymbolDef,
): Promise<{ node: SyntaxNodeLike; parsed: ParsedFileContext } | null> {
  const start = def.range.start.index;
  if (start === undefined) return null;
  try {
    const parsed = await ensureParsedContextForIndex(index, def.file);
    let node: SyntaxNodeLike | null = parsed.tree.rootNode.descendantForIndex(start, start);
    for (; node; node = node.parent) {
      if (DECLARATION_NODE_TYPES[node.type]) return { node, parsed };
    }
  } catch (error) {
    rethrowStaleQuerySource(error);
  }
  return null;
}

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

async function extensionReceiverApplies(
  site: AccessSite,
  def: SymbolDef,
  declared: { node: SyntaxNodeLike; parsed: ParsedFileContext },
  typeNode: SyntaxNodeLike,
  resolveTypeName: JvmTypeNameResolver,
): Promise<{ applies: "yes" | "no" | "unknown"; target: SymbolDef | null }> {
  const mod = site.index.byFile.get(fileIdentityKey(def.file));
  const type = typeNode.type === "nullable_type" ? typeNode.namedChildren[0] : typeNode;
  if (!mod || !type) return { applies: "no", target: null };
  const ids = type.namedChildren.filter((child) => child.type === "identifier");
  const lookup = ids.length === 1 ? ids[0]! : type;
  if (bindsTypeParameter(lookup.text, lookup, declared.parsed.source, declared.parsed.sup)) {
    return { applies: "unknown", target: null };
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
  for (const candidateName of names) {
    for (const def of projectCallablesNamed(site.index, candidateName)) {
      if (def.kind !== SymbolKind.Function) continue;
      if (!usesFile(site, def.file)) {
        if (def.isMember || !topLevelDeclarationInScope(site.index, site.mod, def)) continue;
      }
      if (!acceptsArgumentCount(def, argumentCount)) continue;
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
  if (uncertain) return UNPROVEN;
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
  if (found.status === "unproven") return found;
  if (found.status === "member") {
    const access = await memberAccess(site, found.member);
    if (access === "unproven") return UNPROVEN;
    if (access === "visible" && acceptsArgumentCount(found.member, argumentCount)) return found;
  }
  return inScopeExtension(site, member, argumentCount, resolveTypeName);
}
