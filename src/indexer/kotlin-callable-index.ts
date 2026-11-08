import { supportForFileWithoutHeaderSample } from "../languages.js";
import { normalizeKotlinIdentifier } from "../util/identifiers.js";
import { type ProjectIndex, type SymbolDef, SymbolKind } from "./types.js";

type CallableNames = {
  byFile: ProjectIndex["byFile"];
  size: number;
  languageExtensions: ProjectIndex["languageExtensions"];
  names: Map<string, SymbolDef[]>;
};

const callableNames = new WeakMap<ProjectIndex, CallableNames>();

const NO_CALLABLES: readonly SymbolDef[] = [];

/**
 * Every Kotlin function and class the project declares under `name`, in any file and scope, for a callee that
 * go-to-definition cannot name alone. The map is built once per index, like the package symbol index.
 */
export function projectCallablesNamed(index: ProjectIndex, name: string): readonly SymbolDef[] {
  let cached = callableNames.get(index);
  if (
    !cached ||
    cached.byFile !== index.byFile ||
    cached.size !== index.byFile.size ||
    cached.languageExtensions !== index.languageExtensions
  ) {
    const names = new Map<string, SymbolDef[]>();
    for (const mod of index.byFile.values()) {
      if (supportForFileWithoutHeaderSample(mod.file, index.languageExtensions)?.id !== "kotlin") continue;
      for (const local of mod.locals) {
        if (local.kind !== SymbolKind.Function && local.kind !== SymbolKind.Class) continue;
        const key = normalizeKotlinIdentifier(local.localName);
        const declarations = names.get(key);
        if (declarations) declarations.push(local);
        else names.set(key, [local]);
      }
    }
    cached = { byFile: index.byFile, size: index.byFile.size, languageExtensions: index.languageExtensions, names };
    callableNames.set(index, cached);
  }
  return cached.names.get(normalizeKotlinIdentifier(name)) ?? NO_CALLABLES;
}
