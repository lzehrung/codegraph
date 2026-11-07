import type { ModuleIndex, ProjectIndex, ResolvedExport, SymbolDef } from "../../indexer/types.js";
import type { ImportBinding } from "../../indexer/types.js";
import type { Binding, ScopeIndex } from "../../indexer/scope-types.js";
import { phpNamedImportRole } from "../../indexer/import-types.js";
import {
  cjsRequireValueBinding,
  directModuleValueEntry,
  memberContainerForDefinition,
  resolveImported,
} from "../../indexer/navigation-resolve.js";
import { languageHasDeclarationVisibility } from "../../indexer/declaration-visibility.js";
import { resolveRustModuleNamespace } from "../../indexer/navigation-goto.js";
import { resolvePhpExplicitImport } from "../../indexer/php-namespace-symbols.js";
import {
  effectiveExplicitOrLocalBinding,
  isExpandedStarBinding,
  resolveStarImportedName,
  starImportPrecedence,
} from "../../indexer/star-import-precedence.js";
import { supportForFileWithoutHeaderSample } from "../../languages.js";
import { isJsTsLanguage } from "../../languages/js-family.js";
import { fileIdentityKey, normalizePath } from "../../util/paths.js";
import { normalizeKotlinIdentifier } from "../../util/identifiers.js";

export type ImportAliasMaps = {
  aliasToTargetDef: Map<string, SymbolDef>;
  aliasToTargetModule: Map<string, string>;
  /** The key both tables are written and read by; a use-site spelling must go through it first. */
  aliasKey: (name: string) => string;
};

type ResolveExportNamespace = (file: string, exportedName: string) => ResolvedExport | null;
type ResolveExportFrom = (file: string, exportedName: string) => SymbolDef | null;

function targetModuleForImport(index: ProjectIndex, imp: ImportBinding): ModuleIndex | undefined {
  const targetFile = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;
  return targetFile ? index.byFile.get(fileIdentityKey(targetFile)) : undefined;
}

/**
 * A C/C++ `#include` expands into named bindings tagged with `cNamespace`. They are the only
 * way a C file names header declarations, and their tag/ordinary split needs the namespace-aware
 * lookup below, so they are resolved as ordinary bindings rather than as star-only names.
 */
function isCIncludeBinding(imp: ImportBinding): boolean {
  return imp.kind === "named" && !!imp.cNamespace;
}

function explicitBindingLocalName(imp: ImportBinding): string | undefined {
  if (imp.kind === "namespace") return imp.localNS;
  if (imp.kind === "named" || imp.kind === "default") return imp.local;
  return undefined;
}

/**
 * Every simple name reachable only through a star import, read off the extra bindings
 * `expandStarImports` already appended to `moduleEntry.imports` (one per exported name per star
 * import). A copy's own attached target is not used here: `resolveStarImportedName` re-derives
 * the winner below so multi-star precedence and ambiguity match navigation, instead of trusting
 * whichever copy this array happens to place last.
 */
function starReachableNames(moduleEntry: ModuleIndex): Set<string> {
  const names = new Set<string>();
  for (const imp of moduleEntry.imports) {
    if (isCIncludeBinding(imp) || !isExpandedStarBinding(imp, moduleEntry.imports)) continue;
    if (imp.kind === "named") names.add(imp.local);
    else if (imp.kind === "namespace") names.add(imp.localNS);
  }
  return names;
}

export function buildImportAliasMaps(
  index: ProjectIndex,
  moduleEntry: ModuleIndex,
  resolveExportNamespace: ResolveExportNamespace,
  resolveExportFrom: ResolveExportFrom,
  scopeIndex: ScopeIndex,
): ImportAliasMaps {
  const aliasToTargetDef = new Map<string, SymbolDef>();
  const aliasToTargetModule = new Map<string, string>();
  const languageSupport = supportForFileWithoutHeaderSample(moduleEntry.file, index.languageExtensions);
  const languageId = languageSupport?.id ?? "";
  // Preserve other languages' key conventions; C# verbatim, Kotlin, and Swift quoted aliases change identity here.
  const normalizesAliasKey = languageId === "csharp" || languageId === "kotlin" || languageId === "swift";
  const aliasKey =
    languageSupport && normalizesAliasKey ? languageSupport.normalizeIdentifier : (name: string): string => name;
  const pythonLocalStartIndexes = new Map<string, number>();
  if (languageId === "python") {
    for (const binding of scopeIndex.allScopes[0]?.map.values() ?? []) {
      for (let current: Binding | undefined = binding; current; current = current.earlierSameScope) {
        const startIndex = current.def?.start.index;
        if (startIndex === undefined) continue;
        const previous = pythonLocalStartIndexes.get(current.name);
        if (previous === undefined || startIndex > previous) {
          pythonLocalStartIndexes.set(current.name, startIndex);
        }
      }
    }
  }

  moduleEntry.imports.forEach((imp) => {
    // Star expansion republishes the star's own names as extra bindings with no source range.
    // Resolving those here would let whichever copy this array places last silently overwrite
    // an explicit import, regardless of source order or the language's star precedence;
    // star-only names are resolved separately below instead.
    if (!isCIncludeBinding(imp) && isExpandedStarBinding(imp, moduleEntry.imports)) return;
    const bindingName = explicitBindingLocalName(imp);
    // C# `@B` and `B` are one binding name, so both reach the same entry; see `aliasKey`.
    const key = bindingName === undefined ? undefined : aliasKey(bindingName);
    if (languageId === "python" && bindingName) {
      const effectiveBinding = effectiveExplicitOrLocalBinding(
        moduleEntry.imports,
        languageId,
        (candidate) => explicitBindingLocalName(candidate) === bindingName,
        pythonLocalStartIndexes.get(bindingName),
      );
      if (effectiveBinding?.kind !== "explicit" || effectiveBinding.binding !== imp) return;
    }
    if (key === undefined) return;
    if (imp.kind === "named") {
      const phpRole = phpNamedImportRole(imp);
      if (phpRole) {
        const resolved = resolvePhpExplicitImport(index, imp, phpRole);
        if (resolved) aliasToTargetDef.set(key, resolved);
        return;
      }
    }
    const targetModule = targetModuleForImport(index, imp);
    const targetFile = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;
    if (!targetModule || !targetFile) return;
    if (imp.kind === "named") {
      if (imp.cNamespace) {
        // This map resolves expression names, not C tag-form type references.
        if (imp.cNamespace === "tag") return;
        const resolved = resolveImported(index, imp, imp.imported, { allowLocalFallback: false });
        if (resolved && !("namespace" in resolved)) {
          aliasToTargetDef.set(key, resolved);
        }
        return;
      }
      if (languageHasDeclarationVisibility(languageId)) {
        // A Rust `use crate::mod_name;` binding indexes as a named import pointing at the
        // crate root, not at an export; the module itself is a separate indexed namespace
        // import there (`pub mod mod_name;`). Checking this first matches navigation's order.
        if (languageId === "rust") {
          const moduleFile = resolveRustModuleNamespace(index, imp);
          if (moduleFile) {
            aliasToTargetModule.set(key, normalizePath(moduleFile));
            return;
          }
        }
        // Navigation only admits declarations exported by the imported module. The raw
        // locals also contain private Rust/JVM names and names in other C# namespaces.
        const resolved = resolveImported(index, imp, imp.imported, { allowLocalFallback: false });
        if (resolved && !("namespace" in resolved)) {
          aliasToTargetDef.set(key, resolved);
        } else if (resolved && "namespace" in resolved) {
          aliasToTargetModule.set(key, normalizePath(resolved.namespace));
        }
        return;
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
        aliasToTargetDef.set(key, resolved.def);
      } else if (resolved?.kind === "namespace") {
        aliasToTargetModule.set(key, normalizePath(resolved.file));
      }
    } else if (imp.kind === "default") {
      const defaultExport = resolveExportFrom(targetFile, "default");
      const fallbackExport = isJsTsLanguage(languageId)
        ? directModuleValueEntry(targetModule)?.target
        : targetModule.exports.find((entry) => entry.type === "local")?.target;
      const raw = defaultExport ?? fallbackExport;
      const container = raw ? memberContainerForDefinition(index, raw) : undefined;
      const def = container ?? raw;
      if (def) aliasToTargetDef.set(key, def);
      // An ES default binding names one value, never the enclosing module namespace.
      if (!isJsTsLanguage(languageId)) aliasToTargetModule.set(key, targetFile);
    } else if (imp.kind === "namespace") {
      const classValue = imp.mechanism === "cjs" ? cjsRequireValueBinding(index, targetFile) : undefined;
      if (classValue) {
        aliasToTargetDef.set(key, classValue);
      } else {
        aliasToTargetModule.set(key, targetFile);
      }
    }
  });

  // Star-only names use the same explicit/local winner as navigation. A missing effective
  // explicit binding blocks an earlier star rather than leaving a stale alias target behind.
  const precedence = starImportPrecedence(languageId);
  for (const name of starReachableNames(moduleEntry)) {
    const decision = resolveStarImportedName(index, moduleEntry, languageId, name);
    if (decision.status !== "resolved") continue;
    // An alias of the same identifier blocks the star even when the directive spells it `@B`
    // and the star publishes `B`, so the comparison goes through the language's alias key.
    const targetLanguage = supportForFileWithoutHeaderSample(decision.definition.file, index.languageExtensions)?.id;
    const nameKey =
      languageId === "java" && targetLanguage === "kotlin" ? normalizeKotlinIdentifier(name) : aliasKey(name);
    const effectiveBinding = effectiveExplicitOrLocalBinding(
      moduleEntry.imports,
      languageId,
      (candidate) => {
        const local = explicitBindingLocalName(candidate);
        return local !== undefined && aliasKey(local) === nameKey;
      },
      pythonLocalStartIndexes.get(name),
    );
    if (effectiveBinding?.kind === "local") continue;
    if (effectiveBinding?.kind === "explicit") {
      if (precedence !== "last-wins") continue;
      const starAt = moduleEntry.imports.indexOf(decision.imp);
      const explicitAt = moduleEntry.imports.indexOf(effectiveBinding.binding);
      if (explicitAt > starAt) continue;
    }
    aliasToTargetModule.delete(nameKey);
    aliasToTargetDef.set(nameKey, decision.definition);
  }

  return { aliasToTargetDef, aliasToTargetModule, aliasKey };
}
