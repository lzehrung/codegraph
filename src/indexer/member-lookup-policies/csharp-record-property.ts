import { normalizeCsharpIdentifier } from "../../util/identifiers.js";
import type { ProjectIndex, SymbolDef } from "../types.js";
import type { MemberLookupDeps, MemberOwnerRef } from "./types.js";

/** The generated property of a positional record, represented by its header parameter. */
export async function csharpRecordProperty(
  index: ProjectIndex,
  owner: MemberOwnerRef,
  name: string,
  deps: MemberLookupDeps,
): Promise<SymbolDef | undefined> {
  const { container: record, context, module } = owner;
  if (record.type !== "record_declaration") return undefined;
  if (record.namedChildren.some((child) => child.type === "modifier" && child.text === "partial")) return undefined;
  const body = record.childForFieldName("body");
  if (!body) {
    let terminated = false;
    for (let index = 0; ; index += 1) {
      const child = record.child(index);
      if (!child) break;
      if (child.type === ";") {
        terminated = true;
        break;
      }
    }
    if (!terminated) return undefined;
  }
  const locals = module.locals;
  const wanted = normalizeCsharpIdentifier(name);
  const hasBodyName = body
    ? locals.some((local) => {
        if (!local.isMember || normalizeCsharpIdentifier(local.localName) !== wanted) return false;
        const start = local.range.start.index;
        const end = local.range.end.index;
        if (start === undefined || end === undefined || start < body.startIndex || end > body.endIndex) return false;
        const token = context.tree.rootNode.descendantForIndex(start, end);
        const container = deps.nearestMemberContainer(token);
        return container?.startIndex === record.startIndex && container.type === record.type;
      })
    : false;
  if (hasBodyName) return undefined;
  const parameters = record.namedChildren.find((child) => child.type === "parameter_list");
  const parameter = parameters?.namedChildren.find((child) => {
    const token = child.childForFieldName("name");
    return !!token && normalizeCsharpIdentifier(token.text) === wanted;
  });
  const token = parameter?.childForFieldName("name");
  if (!token) return undefined;
  const hasBases = record.namedChildren.some((child) => child.type === "base_list");
  if (hasBases && (await deps.headerParameterMayBeInherited(index, owner, name))) return undefined;
  return locals.find(
    (local) => local.range.start.index === token.startIndex && local.range.end.index === token.endIndex,
  );
}
