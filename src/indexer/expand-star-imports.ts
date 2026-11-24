import { supportForFileWithoutHeaderSample } from "../languages.js";
import { fileIdentityKey } from "../util/paths.js";
import type { FileId } from "../types.js";
import { SymbolKind, type BuildOptions, type ModuleIndex, type SymbolDef } from "./types.js";
import type { ImportBinding } from "./import-types.js";
import { importNamePolicyFor } from "./name-lookup-policies/imports.js";
import { IMPORT_RESOLUTION_ROWS } from "./import-resolution-tables.js";
import { isJvmLanguage } from "../util/syntax-tree.js";
import type { StarExpansionRules } from "./import-name-types.js";

type StarImportSymbol = {
  name: string;
  symbol: SymbolDef;
};

const DEFAULT_CLASSIFIER_KINDS: Readonly<Partial<Record<SymbolKind, true>>> = {
  [SymbolKind.Class]: true,
  [SymbolKind.Interface]: true,
};

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
  rules: StarExpansionRules | undefined,
  packageOnly: boolean,
  typeOwnerStartIndex?: number,
  staticOnly = false,
): StarImportSymbol[] {
  const excludesMembers = rules?.excludeMembers || packageOnly;
  const classifierKinds = rules?.classifierKinds ?? DEFAULT_CLASSIFIER_KINDS;
  const localExports: StarImportSymbol[] = [];
  for (const entry of target.exports) {
    if (
      entry.type === "local" &&
      (!excludesMembers || !entry.target.isMember) &&
      (typeOwnerStartIndex === undefined ||
        (staticOnly
          ? isJvmStaticWildcardMember(entry.target, typeOwnerStartIndex)
          : isTypeWildcardMember(entry.target, typeOwnerStartIndex, classifierKinds)))
    ) {
      localExports.push({ name: entry.exportedAs, symbol: entry.target });
    }
  }
  if (
    localExports.length ||
    rules?.localFallback === "exports-only" ||
    packageOnly ||
    typeOwnerStartIndex !== undefined
  )
    return localExports;
  const visible: StarImportSymbol[] = [];
  for (const local of target.locals) {
    if (local.localName.startsWith("_") || (rules?.excludeMembers && local.isMember)) continue;
    visible.push({ name: local.localName, symbol: local });
  }
  return visible;
}

function isTypeWildcardMember(
  symbol: SymbolDef,
  ownerStartIndex: number,
  classifierKinds: Readonly<Partial<Record<SymbolKind, true>>>,
): boolean {
  return !!classifierKinds[symbol.kind] && symbol.jvmTypeOwnerStartIndex === ownerStartIndex;
}

/** The owner must be unique within the resolved JVM file. */
export function jvmWildcardTypeOwner(
  target: ModuleIndex,
  typeName: string,
  languageId: string | undefined,
): SymbolDef | undefined {
  const rules = importNamePolicyFor(languageId).starExpansion;
  const normalizeIdentifier = rules?.normalizeTypeName;
  const classifierKinds = rules?.classifierKinds ?? DEFAULT_CLASSIFIER_KINDS;
  const normalizedTypeName = normalizeIdentifier ? normalizeIdentifier(typeName) : typeName;
  let owner: SymbolDef | undefined;
  for (const entry of target.exports) {
    if (
      entry.type !== "local" ||
      (normalizeIdentifier ? normalizeIdentifier(entry.exportedAs) : entry.exportedAs) !== normalizedTypeName ||
      entry.target.isMember ||
      !classifierKinds[entry.target.kind]
    )
      continue;
    if (owner && owner.range.start.index !== entry.target.range.start.index) return undefined;
    owner = entry.target;
  }
  return owner;
}

export function isJvmTypeWildcardMember(
  symbol: SymbolDef,
  ownerStartIndex: number,
  languageId: string | undefined,
): boolean {
  const classifierKinds = importNamePolicyFor(languageId).starExpansion?.classifierKinds ?? DEFAULT_CLASSIFIER_KINDS;
  return isTypeWildcardMember(symbol, ownerStartIndex, classifierKinds);
}
/** A Java static import admits only direct static members of its declared owner. */
export function isJvmStaticWildcardMember(symbol: SymbolDef, ownerStartIndex: number): boolean {
  return !!symbol.isMember && !!symbol.jvmStaticMember && symbol.jvmTypeOwnerStartIndex === ownerStartIndex;
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
        binding.jvmTypeOwnerStartIndex,
        binding.jvmStaticWildcardName,
        binding.jvmPackageIncomplete,
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
        const targetRules = importNamePolicyFor(targetSupport?.id).starExpansion;
        const targetPackageSyntax = targetSupport ? IMPORT_RESOLUTION_ROWS[targetSupport.id]?.packageSyntax : undefined;
        const typeOnDemand = !packageFiles && !!imp.jvmTypeWildcardName && isJvmLanguage(targetSupport?.id);
        const staticOnDemand =
          !packageFiles && !!imp.jvmStaticWildcardName && targetPackageSyntax?.importKind === "type";
        const ownerName = imp.jvmTypeWildcardName ?? imp.jvmStaticWildcardName;
        const typeOwner =
          (typeOnDemand || staticOnDemand) && ownerName
            ? jvmWildcardTypeOwner(target, ownerName, targetSupport?.id)
            : undefined;
        const typeOwnerStartIndex = typeOwner?.range.start.index;
        if (
          (typeOnDemand || staticOnDemand) &&
          (typeOwnerStartIndex === undefined || (typeOwner?.javaPackagePrivate && !imp.jvmSamePackage))
        )
          continue;
        const exportedSymbols = symbolsForStarImport(
          target,
          targetRules,
          !!packageFiles,
          typeOwnerStartIndex,
          staticOnDemand,
        );
        const importerPackageSyntax = imp.jvmPackageLanguageId
          ? IMPORT_RESOLUTION_ROWS[imp.jvmPackageLanguageId]?.packageSyntax
          : undefined;
        const importsPeerTypesOnly =
          importerPackageSyntax?.importKind === "type" && targetPackageSyntax?.importKind === "declaration";
        // Header files default to C in filename-only lookup. Only extracted C tags prove the namespace split.
        const hasCTagExports = exportedSymbols.some(({ symbol }) => Boolean(symbol.cTag));
        const seen = new Set<string>();
        for (const { name, symbol } of exportedSymbols) {
          if (importsPeerTypesOnly && symbol.kind !== SymbolKind.Class && symbol.kind !== SymbolKind.Interface) {
            continue;
          }
          if (packageFiles && symbol.javaPackagePrivate && !imp.jvmSamePackage) continue;
          if ((typeOnDemand || staticOnDemand) && symbol.javaPackagePrivate && !imp.jvmSamePackage) continue;
          let namespace: "tag" | "ordinary" | undefined;
          if (symbol.cTag) namespace = "tag";
          else if (hasCTagExports) namespace = "ordinary";
          const symbolKey = namespace ? `${name}\0${namespace}` : name;
          if (!name || seen.has(symbolKey)) continue;
          seen.add(symbolKey);
          const treatAsNamespace = targetRules?.namespaceKinds?.[symbol.kind];
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
                ...((typeOnDemand || staticOnDemand) && typeOwnerStartIndex !== undefined
                  ? { jvmTypeOwnerStartIndex: typeOwnerStartIndex }
                  : {}),
                ...(staticOnDemand && imp.jvmStaticWildcardName
                  ? { jvmStaticWildcardName: imp.jvmStaticWildcardName }
                  : {}),
                ...(imp.jvmSamePackage !== undefined ? { jvmSamePackage: imp.jvmSamePackage } : {}),
                ...(packageFiles
                  ? {
                      jvmPackageLanguageId: imp.jvmPackageLanguageId,
                      jvmPackageIncomplete: imp.jvmPackageIncomplete,
                    }
                  : {}),
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
