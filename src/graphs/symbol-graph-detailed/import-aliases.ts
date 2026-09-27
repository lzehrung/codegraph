import type { ModuleIndex, ProjectIndex, ResolvedExport, SymbolDef } from "../../indexer/types.js";
import type { ImportBinding } from "../../indexer/types.js";
import { phpNamedImportRole } from "../../indexer/import-types.js";
import {
  cjsRequireValueBinding,
  memberContainerForDefinition,
  resolveImported,
} from "../../indexer/navigation-resolve.js";
import {
  isExpandedStarBinding,
  resolveStarImportedName,
  starImportPrecedence,
} from "../../indexer/star-import-precedence.js";
import { supportForFileWithoutHeaderSample } from "../../languages.js";
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

/**
 * A C/C++ `#include` expands into named bindings tagged with `cNamespace`. They are the only
 * way a C file names header declarations, and their tag/ordinary split needs the namespace-aware
 * lookup below, so they are resolved as ordinary bindings rather than as star-only names.
 */
function isCIncludeBinding(imp: ImportBinding): boolean {
  return imp.kind === "named" && !!imp.cNamespace;
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
): ImportAliasMaps {
  const aliasToTargetDef = new Map<string, SymbolDef>();
  const aliasToTargetModule = new Map<string, string>();
  const languageId = supportForFileWithoutHeaderSample(moduleEntry.file, index.languageExtensions)?.id ?? "";
  // Position (index into moduleEntry.imports) of the explicit import that most recently claimed
  // each alias, so a `last-wins` language can still tell whether a later star import rebinds it.
  const explicitPosition = new Map<string, number>();

  moduleEntry.imports.forEach((imp, position) => {
    // Star expansion republishes the star's own names as extra bindings with no source range.
    // Resolving those here would let whichever copy this array places last silently overwrite
    // an explicit import, regardless of source order or the language's star precedence;
    // star-only names are resolved separately below instead.
    if (!isCIncludeBinding(imp) && isExpandedStarBinding(imp, moduleEntry.imports)) return;
    const targetModule = targetModuleForImport(index, imp);
    const targetFile = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;
    if (!targetModule || !targetFile) return;
    if (imp.kind === "named") {
      if (imp.cNamespace) {
        // This map resolves expression names, not C tag-form type references.
        if (imp.cNamespace === "tag") return;
        const resolved = resolveImported(index, imp, imp.imported, { allowLocalFallback: false });
        if (resolved && !("namespace" in resolved)) {
          aliasToTargetDef.set(imp.local, resolved);
          explicitPosition.set(imp.local, position);
        }
        return;
      }
      if (phpNamedImportRole(imp) !== undefined) {
        // PHP class, function, and constant imports are independent namespaces that can share
        // one alias spelling, so this plain-name map cannot identify a target across roles and
        // keeps only a fallback entry. Use recording resolves each occurrence through its own
        // namespace; this map still serves call targets and receiver typing when the
        // occurrence's namespace has no matching import.
        const resolved = resolveImported(index, imp, imp.imported, { allowLocalFallback: false });
        if (resolved && !("namespace" in resolved)) {
          aliasToTargetDef.set(imp.local, resolved);
          explicitPosition.set(imp.local, position);
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
        aliasToTargetDef.set(imp.local, resolved.def);
        explicitPosition.set(imp.local, position);
      } else if (resolved?.kind === "namespace") {
        aliasToTargetModule.set(imp.local, normalizePath(resolved.file));
        explicitPosition.set(imp.local, position);
      }
    } else if (imp.kind === "default") {
      const defaultExport = resolveExportFrom(targetFile, "default");
      const fallbackExport = targetModule.exports.find((entry) => entry.type === "local")?.target;
      const raw = defaultExport ?? fallbackExport;
      const container = raw ? memberContainerForDefinition(index, raw) : undefined;
      const def = container ?? raw;
      if (def) aliasToTargetDef.set(imp.local, def);
      aliasToTargetModule.set(imp.local, targetFile);
      explicitPosition.set(imp.local, position);
    } else if (imp.kind === "namespace") {
      const classValue = imp.mechanism === "cjs" ? cjsRequireValueBinding(index, targetFile) : undefined;
      if (classValue) {
        aliasToTargetDef.set(imp.localNS, classValue);
      } else {
        aliasToTargetModule.set(imp.localNS, targetFile);
      }
      explicitPosition.set(imp.localNS, position);
    }
  });

  // Star-only names: whatever no explicit import above already claimed.
  // `resolveStarImportedName` mirrors `resolveNamedDefinition`'s exact precedence per language:
  // Java/Kotlin/Rust keep the explicit entry above untouched (explicit beats star
  // unconditionally); Python can still let a star import that is textually after the explicit
  // one rebind it (last-wins, including explicit-vs-star order); every other language leaves
  // the name unresolved when two stars disagree (ambiguous), instead of guessing.
  const precedence = starImportPrecedence(languageId);
  for (const name of starReachableNames(moduleEntry)) {
    const decision = resolveStarImportedName(index, moduleEntry, languageId, name);
    if (decision.status !== "resolved") continue;
    const explicitAt = explicitPosition.get(name);
    if (explicitAt !== undefined) {
      if (precedence !== "last-wins") continue;
      const starAt = moduleEntry.imports.indexOf(decision.imp);
      if (explicitAt > starAt) continue;
    }
    aliasToTargetModule.delete(name);
    aliasToTargetDef.set(name, decision.definition);
  }

  return { aliasToTargetDef, aliasToTargetModule };
}
