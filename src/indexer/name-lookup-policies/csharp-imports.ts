import { normalizeCsharpIdentifier, normalizeCsharpQualifiedName } from "../../util/identifiers.js";
import { fileIdentityKey } from "../../util/paths.js";
import { phpNamedImportRole } from "../import-types.js";
import { coalesceEquivalentCsharpPartialExports } from "../member-lookup-policies/csharp-owner.js";
import type { ImportBinding } from "../types.js";
import type { ImportNameRules } from "../import-name-types.js";

/**
 * Qualified name a C# using-alias binds. `from` is either the namespace (`N.Inner`
 * for `using PT = N.Inner.Point`) or the full dotted type when an earlier resolver
 * already kept it (`Utils.UtilsClass`). A bare imported name must not be searched on
 * its own: compilation-unit lookup would accept a same-named type in another namespace.
 */
function csharpNamedImportLookupName(from: string, exportedName: string): string {
  if (!exportedName || exportedName.includes(".") || exportedName.startsWith("global::")) return exportedName;
  const normalizedFrom = from.trim();
  if (!normalizedFrom) return exportedName;
  const parts = normalizedFrom.split(".").filter(Boolean);
  const tail = parts[parts.length - 1];
  if (!tail) return exportedName;
  if (normalizeCsharpIdentifier(tail) === normalizeCsharpIdentifier(exportedName)) return normalizedFrom;
  return `${normalizedFrom}.${exportedName}`;
}

/**
 * The name a C# binding looks up. A named binding qualifies with its alias target. A `using N;`
 * star binding qualifies with `N`: its resolved file is one of the files that declare `N`, and
 * the qualified lookup reaches exactly the types of `N` in every declaring file, not types of
 * other namespaces the bound file also declares.
 */
function csharpImportLookupName(imp: ImportBinding, exportedName: string): string {
  if (imp.kind === "named") return csharpNamedImportLookupName(imp.from, exportedName);
  if (imp.kind !== "star" || imp.staticMembersOf) return exportedName;
  if (!exportedName || exportedName.includes(".") || exportedName.startsWith("global::")) return exportedName;
  const namespaceName = imp.from.trim();
  return namespaceName ? `${namespaceName}.${exportedName}` : exportedName;
}

export const CSHARP_IMPORT_NAME_RULES: ImportNameRules = {
  namespaceLookup: {
    separator: ".",
    globalPrefix: "global::",
    normalizeQualifier: normalizeCsharpQualifiedName,
    qualifiedUnitOptions: { csharpQualifiedName: true },
    coalesce: coalesceEquivalentCsharpPartialExports,
  },
  resolveTarget(index, imp, targetFile, exportedName, options, namespace, deps) {
    if (deps.csharpShadowedImports(index).has(imp)) return null;
    const lookupName = csharpImportLookupName(imp, exportedName);
    if (imp.kind === "star" && !imp.staticMembersOf) {
      return deps.resolveCsharpNamespaceImport(index, imp, targetFile, lookupName, {
        ...options,
        ...(namespace ? { cNamespace: namespace } : {}),
      });
    }
    const role = phpNamedImportRole(imp);
    const hit = role
      ? deps.resolvePhpExportByImportType(index, targetFile, exportedName, role)
      : deps.resolveExport(index, targetFile, lookupName, {
          ...options,
          ...(namespace ? { cNamespace: namespace } : {}),
        });
    if (hit?.kind === "resolved") {
      if (imp.kind === "named" && hit.def.javaPackagePrivate && !imp.jvmSamePackage) return null;
      return hit.def;
    }
    if (hit?.kind === "namespace") return { namespace: hit.file };
    if (imp.kind === "default" && exportedName === "default") {
      const module = index.byFile.get(fileIdentityKey(targetFile));
      const directValue = module && deps.directModuleValueEntry(module);
      if (directValue) return directValue.target;
    }
    return null;
  },
};
