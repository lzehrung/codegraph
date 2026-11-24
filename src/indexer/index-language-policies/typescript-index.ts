import type { DeclarationHooks, ModuleIndexHooks } from "../language-hook-types.js";
import { typescriptSplitMethodName } from "../ts-callables.js";
import { SymbolKind, type SymbolDef } from "../types.js";

function mergeTypeScriptNamespaceDeclarations(items: SymbolDef[]): SymbolDef[] {
  const byName = new Map<string, SymbolDef[]>();
  for (const item of items) {
    const group = byName.get(item.localName);
    if (group) group.push(item);
    else byName.set(item.localName, [item]);
  }
  const out: SymbolDef[] = [];
  const rank = (k: SymbolKind): number => {
    if (k === SymbolKind.Class) return 5;
    if (k === SymbolKind.Interface) return 4;
    if (k === SymbolKind.TypeAlias) return 3;
    if (k === SymbolKind.Function) return 2;
    return 1;
  };
  for (const group of byName.values()) {
    if (group.length === 1) {
      out.push(group[0]!);
      continue;
    }
    if (group.every((item) => item.kind === SymbolKind.Function)) {
      out.push(...group);
      continue;
    }
    const sorted = [...group].sort((a, b) => rank(b.kind) - rank(a.kind));
    out.push(sorted[0]!);
  }
  return out;
}

export const typescriptDeclarations: DeclarationHooks = {
  mergeLocals: mergeTypeScriptNamespaceDeclarations,
  splitMethodName: typescriptSplitMethodName,
};
export const typescriptModule: ModuleIndexHooks = { tsconfigPaths: true };
