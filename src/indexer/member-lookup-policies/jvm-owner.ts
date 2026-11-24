import { fileIdentityKey } from "../../util/paths.js";
import { isExportedDeclaration } from "../declaration-visibility.js";
import type { ParsedFileContext } from "../parse-context.js";
import { toTreeSitterPosition } from "../shared.js";
import type { SymbolDef } from "../types.js";
import type { OwnerHooks } from "./types.js";

/** Java/Kotlin cross-file members must be visible declarations, even through a proven receiver. */
export function jvmCrossFileMemberHidden(useFile: string, member: SymbolDef, context: ParsedFileContext): boolean {
  const position = toTreeSitterPosition(member.range.start);
  const name = context.tree.rootNode.descendantForPosition(position, position);
  if (!name) return false;
  if (fileIdentityKey(useFile) === fileIdentityKey(member.file)) return false;
  return !isExportedDeclaration(context.sup.id, name);
}

/** JVM paths read a visible first type, or the package named by the leading segments. */
export function jvmQualifiedOwner(languageId: "java" | "kotlin"): NonNullable<OwnerHooks["qualified"]> {
  return (index, mod, baseName, path, normalize, sup, _use, deps) => {
    let root = deps.resolveTypeContainer(index, mod, baseName, normalize);
    if (!root) {
      const named = deps.namedDefinition(index, mod, sup, baseName);
      if (named?.status === "ok" && deps.declaresMembers(named.definition)) root = named.definition;
    }
    return deps.resolveJvmQualifiedPath(index, mod.file, languageId, root ?? null, [baseName, ...path], true);
  };
}
