import { supportForFileWithoutHeaderSample } from "../languages.js";
import { fileIdentityKey } from "../util/paths.js";
import type { FileId } from "../types.js";
import { SymbolKind, type BuildOptions, type ModuleIndex, type SymbolDef } from "./types.js";
import type { ImportBinding } from "./import-types.js";

type StarImportSymbol = {
  name: string;
  symbol: SymbolDef;
};

const STYLESHEET_LANGUAGE_IDS = new Set(["css", "scss", "less"]);

/**
 * Prefer explicit local exports when the target has any. Otherwise fall back
 * to non-private locals. Collect `{ exportedAs, target }` in one pass so star
 * expansion keeps renamed export names and does not filter `target.exports`
 * twice.
 *
 * Stylesheets never use the locals fallback. Their locals include every class
 * and id selector, which are not importable names; only the module-level
 * mixins, functions, variables and placeholders the exports query captures are.
 * JVM package wildcards only import proven top-level exports. Local fallbacks
 * can contain declarations inside members or function bodies.
 */
function symbolsForStarImport(
  target: ModuleIndex,
  isStylesheet: boolean,
  isRuby: boolean,
  packageOnly: boolean,
): StarImportSymbol[] {
  const localExports: StarImportSymbol[] = [];
  for (const entry of target.exports) {
    if (entry.type === "local" && (!(isRuby || packageOnly) || !entry.target.isMember)) {
      localExports.push({ name: entry.exportedAs, symbol: entry.target });
    }
  }
  if (localExports.length || isStylesheet || packageOnly) return localExports;
  const visible: StarImportSymbol[] = [];
  for (const local of target.locals) {
    if (local.localName.startsWith("_") || (isRuby && local.isMember)) continue;
    visible.push({ name: local.localName, symbol: local });
  }
  return visible;
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
      return JSON.stringify([
        "named",
        binding.from,
        binding.resolved,
        typeOnly,
        binding.local,
        binding.imported,
        binding.cNamespace,
      ]);
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
      // A C# `using static` imports one type's static members, not the file's exports.
      if (imp.kind !== "star" || imp.staticMembersOf || typeof imp.resolved !== "string") continue;
      const packageFiles = imp.jvmPackageFiles;
      const targetCount = packageFiles?.length ?? 1;
      for (let packageIndex = 0; packageIndex < targetCount; packageIndex += 1) {
        const targetFile = packageFiles ? packageFiles[packageIndex]! : imp.resolved;
        const target = modules.get(fileIdentityKey(targetFile));
        if (!target) continue;
        // Only stylesheet and Ruby membership is asked below, and C and C++ answer both the same,
        // so a header target must not pay for a header sample read here.
        const targetSupport = supportForFileWithoutHeaderSample(targetFile, opts?.languageExtensions);
        const exportedSymbols = symbolsForStarImport(
          target,
          !!targetSupport && STYLESHEET_LANGUAGE_IDS.has(targetSupport.id),
          targetSupport?.id === "ruby",
          !!packageFiles,
        );
        const javaImportsKotlinTypes = imp.jvmPackageLanguageId === "java" && targetSupport?.id === "kotlin";
        // Header files default to C in filename-only lookup. Only extracted C tags prove the namespace split.
        const hasCTagExports = exportedSymbols.some(({ symbol }) => Boolean(symbol.cTag));
        const seen = new Set<string>();
        for (const { name, symbol } of exportedSymbols) {
          if (javaImportsKotlinTypes && symbol.kind !== SymbolKind.Class && symbol.kind !== SymbolKind.Interface) {
            continue;
          }
          let namespace: "tag" | "ordinary" | undefined;
          if (symbol.cTag) namespace = "tag";
          else if (hasCTagExports) namespace = "ordinary";
          const symbolKey = namespace ? `${name}\0${namespace}` : name;
          if (!name || seen.has(symbolKey)) continue;
          seen.add(symbolKey);
          const treatAsNamespace = targetSupport?.id === "ruby" && symbol.kind === SymbolKind.Class;
          const expandedImport: ImportBinding = treatAsNamespace
            ? {
                kind: "namespace",
                localNS: name,
                from: imp.from,
                resolved: targetFile,
                ...(imp.typeOnly !== undefined ? { typeOnly: imp.typeOnly } : {}),
                ...(imp.includeForm ? { includeForm: imp.includeForm } : {}),
              }
            : {
                kind: "named",
                local: name,
                imported: name,
                from: imp.from,
                resolved: targetFile,
                ...(namespace ? { cNamespace: namespace } : {}),
                ...(imp.typeOnly !== undefined ? { typeOnly: imp.typeOnly } : {}),
                ...(imp.includeForm ? { includeForm: imp.includeForm } : {}),
              };
          const expandedImportKeyValue = expandedImportKey(expandedImport);
          if (!expandedImportKeyValue || expandedImportKeys.has(expandedImportKeyValue)) continue;
          expandedImportKeys.add(expandedImportKeyValue);
          mod.imports.push(expandedImport);
        }
      }
    }
  }
}
