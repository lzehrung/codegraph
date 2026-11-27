/**
 * The Swift types a type name reaches: the types a typealias chain provably names, and the types declared in the body
 * of another type. Each reads Swift syntax only from a Swift file. This module imports no navigation module: those
 * import the policy registry, so the helpers it needs arrive as `deps`.
 */
import { declaresMembers, unwrapNamedType } from "../../graphs/symbol-graph-detailed/receiver-calls.js";
import { sliceText } from "../../util/ast.js";
import { fileIdentityKey } from "../../util/paths.js";
import { genericNamedImportStage } from "../navigation-named-core.js";
import { memberContainerForDefinition } from "../navigation-resolve.js";
import { ensureParsedContextForIndex } from "../parsed-cache.js";
import { SymbolKind, type ProjectIndex, type SymbolDef } from "../types.js";
import type { MemberLookupDeps } from "./types.js";

/** The one type named `name` that the body of the Swift type `owner` declares. A nested type declared in an extension is not read. */
export async function swiftNestedType(
  index: ProjectIndex,
  owner: SymbolDef,
  name: string,
  deps: MemberLookupDeps,
): Promise<SymbolDef | undefined> {
  const ref = await deps.keywordClassRefFromDef(index, owner);
  if (ref?.context.sup.id !== "swift") return undefined;
  const nested = deps
    .findDirectLocalsWithinNode(
      ref.module.locals,
      name,
      ref.container,
      ref.context,
      ref.context.sup.normalizeIdentifier,
    )
    .filter((local) => local.isMember && declaresMembers(local));
  return nested.length === 1 ? nested[0] : undefined;
}

/** Whether a declaration ends a Swift alias chain: a nominal type, or a protocol where the caller accepts one. */
function endsSwiftAliasChain(declarationType: string | undefined, acceptsProtocol: boolean): boolean {
  if (declarationType === "class_declaration") return true;
  return acceptsProtocol && declarationType === "protocol_declaration";
}

/** The declaration a Swift typealias chain provably reaches: each alias must name one indexed nominal type. */
export async function followSwiftAlias(
  index: ProjectIndex,
  alias: SymbolDef,
  acceptsProtocol: boolean,
  deps: MemberLookupDeps,
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
    const declaration = deps.nameNodeForDef(context, current)?.parent;
    if (declaration?.type !== "typealias_declaration") {
      return endsSwiftAliasChain(declaration?.type, acceptsProtocol) && declaresMembers(current) ? current : undefined;
    }
    const target = declaration.namedChildren.find((child) => child.type === "user_type");
    const named = target ? unwrapNamedType(target, context.sup) : null;
    if (!named || target?.namedChildren.length !== 1) return undefined;
    const targetName = sliceText(named, context.source);
    const namedTarget = genericNamedImportStage(
      index,
      mod,
      mod.file,
      context.sup,
      targetName,
      undefined,
      declaration.startIndex,
    );
    const next =
      deps.resolveTypeContainer(index, mod, targetName, context.sup.normalizeIdentifier) ??
      (namedTarget?.status === "ok" ? memberContainerForDefinition(index, namedTarget.definition) : undefined);
    if (!next) return undefined;
    current = next;
  }
  return declaresMembers(current) ? current : undefined;
}
