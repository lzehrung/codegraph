/**
 * The member a typed implicit receiver, such as a Kotlin lambda's, gives a bare call, as Kotlin sees it from the call:
 * a member the receiver type owns or inherits, or an extension declared beside it, that is accessible there. A
 * `private` member of another class, a `protected` member the call's class cannot reach, and an extension that is not
 * in scope (not imported, another package) are no candidates, so the lookup goes on to the next receiver and finally
 * to the enclosing type, as kotlinc does.
 */
import {
  kotlinExtensionReceiverTypeNode,
  memberContainerDef,
  nearestMemberContainer,
} from "../graphs/symbol-graph-detailed/receiver-calls.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import { normalizeKotlinIdentifier } from "../util/identifiers.js";
import { fileIdentityKey } from "../util/paths.js";
import { getPackageDeclarationName } from "./compilation-units.js";
import { externalTypeNames, resolveExternalType } from "./kotlin-external-receivers.js";
import {
  declarationReaches,
  findReceiverTypeMember,
  type ExternalBaseOmits,
  type ReceiverTypeMember,
} from "./navigation-goto.js";
import type { ParsedFileContext } from "./parse-context.js";
import { ensureParsedContextForIndex, rethrowStaleQuerySource } from "./parsed-cache.js";
import type { ModuleIndex, ProjectIndex, SymbolDef } from "./types.js";

/** Whether the member can be called at the use: proven either way, or "unproven" when nothing indexed settles it. */
type MemberAccess = "visible" | "hidden" | "unproven";

type Visibility = "public" | "private" | "protected" | "internal";

/** Where a receiver member is looked up from. */
type AccessSite = { index: ProjectIndex; mod: ModuleIndex; use: SyntaxNodeLike; receiver: SymbolDef };

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
  const { node, parsed } = declared;
  const topLevel = node.parent?.type === "source_file";
  const container = topLevel ? null : nearestMemberContainer(node);
  const extension = !!kotlinExtensionReceiverTypeNode(node, parsed.sup);
  // A member extension needs the `this` of the class that declares it.
  if (extension && container && !usesInside(site, container, member.file)) return "hidden";
  const visibility = declaredVisibility(node);
  if (visibility === "private") return privateAccess(site, member, container);
  if (visibility === "protected") return container ? protectedAccess(site, member, container) : "unproven";
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

/**
 * Looks `member` up on the type `receiver` of an implicit receiver and keeps only what the call at `use` can reach: a
 * member that is not accessible there is `omitted`, so the next receiver and the enclosing type decide, and one whose
 * accessibility nothing indexed proves leaves the call `unproven`. `memberUse` says whether `use` calls the member or
 * reads it, which the shared member selection needs to prefer a method or an invokable property for a call.
 */
export async function lookupReceiverTypeMember(
  index: ProjectIndex,
  mod: ModuleIndex,
  use: SyntaxNodeLike,
  receiver: SymbolDef,
  member: string,
  argumentCount: number | undefined,
  memberUse?: "call" | "value",
): Promise<ReceiverTypeMember> {
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
  if (found.status !== "member") return found;
  const access = await memberAccess({ index, mod, use, receiver }, found.member);
  if (access === "visible") return found;
  return access === "hidden" ? OMITTED : UNPROVEN;
}
