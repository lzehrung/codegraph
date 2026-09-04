import { supportForFile } from "../languages.js";
import { fileIdentityKey } from "../util/paths.js";
import type { FileId } from "../types.js";
import { SymbolKind, type BuildOptions, type ModuleIndex, type SymbolDef } from "./types.js";
import type { ImportBinding } from "./import-types.js";

/**
 * Prefer explicit local exports when the target has any. Otherwise fall back
 * to non-private locals. Collect local export targets in one pass so star
 * expansion does not filter `target.exports` twice.
 */
function symbolsForStarImport(target: ModuleIndex): SymbolDef[] {
  const localExports: SymbolDef[] = [];
  for (const entry of target.exports) {
    if (entry.type === "local") localExports.push(entry.target);
  }
  if (localExports.length) return localExports;
  return target.locals.filter((local) => !local.localName.startsWith("_"));
}

/**
 * Expand `kind: "star"` import bindings into named or namespace imports so
 * later resolution can see the target's locals without re-parsing.
 *
 * This rewrites `mod.imports` only. It reads the resolved target's local
 * exports (or non-private locals) to choose names. It does not rewrite
 * `mod.exports` or `exportStar` entries (TypeScript `export *`).
 *
 * Disk-cached module rows are stored before this expansion. Snapshot hydrate
 * must run it before freezing the in-memory index.
 */
export function expandStarImports(modules: Map<FileId, ModuleIndex>, opts?: BuildOptions): void {
  const expandedImportKey = (binding: ImportBinding): string | null => {
    const typeOnly = binding.typeOnly ?? false;
    if (binding.kind === "named") {
      return JSON.stringify(["named", binding.from, binding.resolved, typeOnly, binding.local, binding.imported]);
    }
    if (binding.kind === "namespace") {
      return JSON.stringify(["namespace", binding.from, binding.resolved, typeOnly, binding.localNS]);
    }
    return null;
  };

  for (const mod of modules.values()) {
    const expandedImportKeys = new Set<string>();
    for (const existing of mod.imports) {
      const key = expandedImportKey(existing);
      if (key) expandedImportKeys.add(key);
    }
    for (const imp of [...mod.imports]) {
      if (imp.kind !== "star" || typeof imp.resolved !== "string") continue;
      const target = modules.get(fileIdentityKey(imp.resolved));
      if (!target) continue;
      const targetSupport = supportForFile(imp.resolved, opts?.languageExtensions);
      const exportedSymbols = symbolsForStarImport(target);
      const seen = new Set<string>();
      for (const symbol of exportedSymbols) {
        if (!symbol.localName || seen.has(symbol.localName)) continue;
        seen.add(symbol.localName);
        const treatAsNamespace = targetSupport?.id === "ruby" && symbol.kind === SymbolKind.Class;
        const expandedImport: ImportBinding = treatAsNamespace
          ? {
              kind: "namespace",
              localNS: symbol.localName,
              from: imp.from,
              resolved: imp.resolved,
              ...(imp.typeOnly !== undefined ? { typeOnly: imp.typeOnly } : {}),
            }
          : {
              kind: "named",
              local: symbol.localName,
              imported: symbol.localName,
              from: imp.from,
              resolved: imp.resolved,
              ...(imp.typeOnly !== undefined ? { typeOnly: imp.typeOnly } : {}),
            };
        const expandedImportKeyValue = expandedImportKey(expandedImport);
        if (!expandedImportKeyValue || expandedImportKeys.has(expandedImportKeyValue)) continue;
        expandedImportKeys.add(expandedImportKeyValue);
        mod.imports.push(expandedImport);
      }
    }
  }
}
