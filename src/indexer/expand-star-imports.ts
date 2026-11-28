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

/** Each expanded copy's source: the module as extracted, before a star import added a binding to it. */
const unexpandedSources = new WeakMap<ModuleIndex, ModuleIndex>();
/** The latest expanded copy of each source, reused while its star imports bind the same names. */
const expandedCopies = new WeakMap<ModuleIndex, ModuleIndex>();

/** The module `mod` was expanded from, or `mod` itself when it holds only the bindings extraction produced. */
export function unexpandedModule(mod: ModuleIndex): ModuleIndex {
  return unexpandedSources.get(mod) ?? mod;
}

function expandedImportKey(binding: ImportBinding): string | null {
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
}

function boundImportKeys(imports: readonly ImportBinding[]): Set<string> {
  const keys = new Set<string>();
  for (const binding of imports) {
    const key = expandedImportKey(binding);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Expand `kind: "star"` import bindings into named or namespace imports so
 * later resolution can see the target's locals without re-parsing.
 *
 * A star importer is replaced in `modules` by a copy whose `imports` append
 * the expanded bindings. A module is never written to, so a cached or frozen
 * module stays as extracted. The names come from the resolved target's local
 * exports (or non-private locals). It does not rewrite `mod.exports` or
 * `exportStar` entries (TypeScript `export *`).
 *
 * The names depend on other files, so each call starts again from the
 * extracted bindings: a copy from an earlier call is expanded from its source,
 * and a name its target no longer exports is dropped.
 */
export function expandStarImports(modules: Map<FileId, ModuleIndex>, opts?: BuildOptions): void {
  for (const [key, current] of modules) {
    const source = unexpandedModule(current);
    const expansion = starImportExpansion(source, modules, opts);
    const expanded = expansion.bindings.length ? expandedCopy(source, expansion) : source;
    if (expanded !== current) modules.set(key, expanded);
  }
}

/** The bindings star imports add to one module, with each binding's `expandedImportKey`. */
type StarImportExpansion = { bindings: ImportBinding[]; keys: string[] };

/** The copy of `source` that appends the expansion: the previous copy when that appended the same bindings. */
function expandedCopy(source: ModuleIndex, expansion: StarImportExpansion): ModuleIndex {
  const previous = expandedCopies.get(source);
  if (previous && appendsSameBindings(previous, source, expansion.keys)) return previous;
  const copy: ModuleIndex = { ...source, imports: [...source.imports, ...expansion.bindings] };
  unexpandedSources.set(copy, source);
  expandedCopies.set(source, copy);
  return copy;
}

/**
 * The copy shares the source's own bindings. Every expanded field a key leaves out comes from the star import
 * that produced the binding, which the same key from the same source always names.
 */
function appendsSameBindings(copy: ModuleIndex, source: ModuleIndex, keys: readonly string[]): boolean {
  const start = source.imports.length;
  if (copy.imports.length !== start + keys.length) return false;
  return keys.every((key, index) => expandedImportKey(copy.imports[start + index]!) === key);
}

/**
 * The bindings the star imports of `mod` add, in a cold build's order: one per name of each target, minus the
 * names `mod` already binds the same way.
 */
function starImportExpansion(
  mod: ModuleIndex,
  modules: ReadonlyMap<FileId, ModuleIndex>,
  opts: BuildOptions | undefined,
): StarImportExpansion {
  const expansion: StarImportExpansion = { bindings: [], keys: [] };
  let boundKeys: Set<string> | undefined;
  for (const imp of mod.imports) {
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
      const staticOnDemand = !packageFiles && !!imp.jvmStaticWildcardName && targetPackageSyntax?.importKind === "type";
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
        if (!expandedImportKeyValue) continue;
        boundKeys ??= boundImportKeys(mod.imports);
        if (boundKeys.has(expandedImportKeyValue)) continue;
        boundKeys.add(expandedImportKeyValue);
        expansion.bindings.push(expandedImport);
        expansion.keys.push(expandedImportKeyValue);
      }
    }
  }
  return expansion;
}
