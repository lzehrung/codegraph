import { cTagRole } from "../../languages/definitions/c.js";
import { isCppNamedModuleSpecifier } from "../../util/resolution/cpp.js";
import type { DeclarationHooks, ModuleIndexHooks } from "../language-hook-types.js";
import { SymbolKind } from "../types.js";

export const cFamilyModule: ModuleIndexHooks = {
  specifierNeedsSource: (edge) => edge.includeForm === undefined && !isCppNamedModuleSpecifier(edge.raw),
};

/** C function and tag redeclarations share an identity; tags stay separate from typedefs. */
export const cDeclarations: DeclarationHooks = {
  tagRole: cTagRole,
  localExportKey(entry) {
    if (entry.target.kind === SymbolKind.Function) return `${entry.exportedAs}\0function`;
    if (entry.target.cTag) return `${entry.exportedAs}\0tag`;
    return `${entry.exportedAs}\0${entry.target.localName}\0${entry.target.range.start.index ?? 0}\0${entry.target.range.end.index ?? 0}`;
  },
  preferredTagRole: "declaration",
};
