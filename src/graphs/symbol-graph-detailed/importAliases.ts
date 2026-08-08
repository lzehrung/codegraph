import type { ModuleIndex, ProjectIndex, ResolvedExport, SymbolDef } from "../../indexer/types.js";
import type { ImportBinding } from "../../indexer/types.js";
import { normalizePath } from "../../util/paths.js";

export type ImportAliasMaps = {
  aliasToTargetDef: Map<string, SymbolDef>;
  aliasToTargetModule: Map<string, string>;
};

type ResolveExportNamespace = (file: string, exportedName: string) => ResolvedExport | null;
type ResolveExportFrom = (file: string, exportedName: string) => SymbolDef | null;

function targetModuleForImport(index: ProjectIndex, imp: ImportBinding): ModuleIndex | undefined {
  const targetFile = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;
  return targetFile ? index.byFile.get(targetFile) : undefined;
}

export function buildImportAliasMaps(
  index: ProjectIndex,
  moduleEntry: ModuleIndex,
  resolveExportNamespace: ResolveExportNamespace,
  resolveExportFrom: ResolveExportFrom,
): ImportAliasMaps {
  const aliasToTargetDef = new Map<string, SymbolDef>();
  const aliasToTargetModule = new Map<string, string>();

  for (const imp of moduleEntry.imports) {
    const targetModule = targetModuleForImport(index, imp);
    const targetFile = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;
    if (!targetModule || !targetFile) continue;
    if (imp.kind === "named") {
      const localFallback = targetModule.locals.find((local) => local.localName === imp.imported);
      const fallbackResolved: ResolvedExport | null = localFallback
        ? {
            kind: "resolved",
            def: localFallback,
          }
        : null;
      const resolved = resolveExportNamespace(targetFile, imp.imported) ?? fallbackResolved;
      if (resolved?.kind === "resolved") {
        aliasToTargetDef.set(imp.local, resolved.def);
      } else if (resolved?.kind === "namespace") {
        aliasToTargetModule.set(imp.local, normalizePath(resolved.file));
      }
    } else if (imp.kind === "default") {
      const defaultExport = resolveExportFrom(targetFile, "default");
      const fallbackExport = targetModule.exports.find((entry) => entry.type === "local")?.target;
      const def = defaultExport ?? fallbackExport;
      if (def) aliasToTargetDef.set(imp.local, def);
      aliasToTargetModule.set(imp.local, targetFile);
    } else if (imp.kind === "namespace") {
      aliasToTargetModule.set(imp.localNS, targetFile);
    }
  }

  return { aliasToTargetDef, aliasToTargetModule };
}
