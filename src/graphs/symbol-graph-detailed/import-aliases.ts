import type { ModuleIndex, ProjectIndex, ResolvedExport, SymbolDef } from "../../indexer/types.js";
import type { ImportBinding } from "../../indexer/types.js";
import { phpNamedImportRole } from "../../indexer/import-types.js";
import { resolveImported } from "../../indexer/navigation-resolve.js";
import { fileIdentityKey, normalizePath } from "../../util/paths.js";

export type ImportAliasMaps = {
  aliasToTargetDef: Map<string, SymbolDef>;
  aliasToTargetModule: Map<string, string>;
};

type ResolveExportNamespace = (file: string, exportedName: string) => ResolvedExport | null;
type ResolveExportFrom = (file: string, exportedName: string) => SymbolDef | null;

function targetModuleForImport(index: ProjectIndex, imp: ImportBinding): ModuleIndex | undefined {
  const targetFile = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;
  return targetFile ? index.byFile.get(fileIdentityKey(targetFile)) : undefined;
}

export function buildImportAliasMaps(
  index: ProjectIndex,
  moduleEntry: ModuleIndex,
  resolveExportNamespace: ResolveExportNamespace,
  resolveExportFrom: ResolveExportFrom,
): ImportAliasMaps {
  const aliasToTargetDef = new Map<string, SymbolDef>();
  const aliasToTargetModule = new Map<string, string>();
  const phpAliasSpellings = new Set<string>();

  for (const imp of moduleEntry.imports) {
    const targetModule = targetModuleForImport(index, imp);
    const targetFile = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;
    if (!targetModule || !targetFile) continue;
    if (imp.kind === "named") {
      if (imp.cNamespace) {
        // This map resolves expression names, not C tag-form type references.
        if (imp.cNamespace === "tag") continue;
        const resolved = resolveImported(index, imp, imp.imported, { allowLocalFallback: false });
        if (resolved && !("namespace" in resolved)) aliasToTargetDef.set(imp.local, resolved);
        continue;
      }
      if (phpNamedImportRole(imp) !== undefined) {
        // PHP class, function, and constant imports are independent namespaces that can share
        // one alias spelling. A plain-name key cannot identify a target across roles, so drop
        // the ambiguous alias instead of pinning one role's target for every use; role-aware
        // resolution picks the right declaration per use context.
        const ambiguous = phpAliasSpellings.has(imp.local);
        phpAliasSpellings.add(imp.local);
        if (ambiguous) {
          aliasToTargetDef.delete(imp.local);
          continue;
        }
        const resolved = resolveImported(index, imp, imp.imported, { allowLocalFallback: false });
        if (resolved && !("namespace" in resolved)) aliasToTargetDef.set(imp.local, resolved);
        continue;
      }
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
