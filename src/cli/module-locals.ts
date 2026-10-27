import type { SymbolDef } from "../indexer/types.js";

/** JSON projection of a module's local definitions, shared by `index --full` and `dumpmod`. */
export function compactModuleLocals(locals: readonly SymbolDef[]): Array<{
  name: string;
  kind: SymbolDef["kind"];
  start: SymbolDef["range"]["start"];
}> {
  return locals.map((local) => ({
    name: local.localName,
    kind: local.kind,
    start: local.range.start,
  }));
}
