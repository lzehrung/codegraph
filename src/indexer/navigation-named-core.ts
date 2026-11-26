/**
 * The local-export, explicit-import, compilation-unit and star arbitration behind every named lookup. Each language's
 * stage is built here once from its `NamedImportRules`; `./name-import-stages/` selects it. This module imports no
 * navigation consumer or policy registry.
 */
import { getCallArgumentCount } from "../languages/callable-arity.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import type { FileId } from "../types.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";
import { AMBIGUOUS_STAR_IMPORT_REASON } from "./ambiguous-resolution.js";
import { withCsharpGlobalUsings } from "./csharp-global-usings.js";
import { phpNamedImportRole } from "./import-types.js";
import type { NamedImportRules, NamedImportStage } from "./name-import-stage-types.js";
import { okGoToResult } from "./navigation-provenance.js";
import {
  cjsRequireValueBinding,
  exportsOwnImportBinding,
  resolveExport,
  resolveImported,
} from "./navigation-resolve.js";
import { cachedScopeIndexForIndex } from "./parsed-cache.js";
import { resolvePhpExplicitImport } from "./php-namespace-symbols.js";
import { isPythonDottedImportBinding, pythonDottedImportPackageFile } from "./python-dotted-imports.js";
import { fileScopeDefinitionCoversUse, pythonFunctionPendingInDefault, typeOnlyName } from "./scope-nodes.js";
import {
  decideStarImportCandidates,
  effectiveExplicitOrLocalBinding,
  explicitBindingStartIndex,
  isExpandedStarBinding,
  resolveStarImportedDefinition,
  starImportPrecedence,
  type StarImportCandidate,
} from "./star-import-precedence.js";
import {
  SymbolKind,
  type GoToResult,
  type ImportBinding,
  type ModuleIndex,
  type ProjectIndex,
  type ResolvedExport,
  type SymbolDef,
} from "./types.js";

export function toModuleRef(resolved?: FileId | { external: string }): string | undefined {
  if (!resolved) return undefined;
  return typeof resolved === "string" ? resolved : resolved.external;
}

/** Whether a source position names an import's source or local declaration token, not a later use. */
function importBindingCoversIndex(imp: ImportBinding, index: number): boolean {
  if (imp.kind === "star") return false;
  const localRange = imp.localRange;
  const localStart = localRange?.start.index;
  const localEnd = localRange?.end.index;
  if (localStart !== undefined && localEnd !== undefined && index >= localStart && index < localEnd) return true;
  if (imp.kind !== "named") return false;
  const importedStart = imp.importedRange?.start.index;
  const importedEnd = imp.importedRange?.end.index;
  return importedStart !== undefined && importedEnd !== undefined && index >= importedStart && index < importedEnd;
}

function starImportGoTo(index: ProjectIndex, imp: ImportBinding, def: SymbolDef, name: string): GoToResult {
  return okGoToResult(index, def, {
    via: {
      ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
      exportedName: name,
    },
    resolution: "import-star",
    confidence: "medium",
  });
}

const CALL_ARGUMENT_PARENT_TYPES: ReadonlySet<string> = new Set([
  "call",
  "call_expression",
  "function_call_expression",
  "invocation_expression",
  "method_invocation",
  "scoped_call_expression",
]);

/** Argument count when `node` is a callee: null for an unknown count, undefined for a non-call. */
function explicitCallArgumentCount(
  languageId: string,
  source: string,
  node: SyntaxNodeLike,
): number | null | undefined {
  const call = node.parent;
  if (!call || !CALL_ARGUMENT_PARENT_TYPES.has(call.type)) return undefined;
  const callee = call.childForFieldName("name") ?? call.childForFieldName("function") ?? call.namedChildren[0] ?? null;
  if (!callee || node.startIndex < callee.startIndex || node.endIndex > callee.endIndex) return undefined;
  return getCallArgumentCount({ languageId, source, call });
}

/**
 * The complete named/import traversal for one language, built once per rules row. The generic rules (`{}`) read no
 * scope facts; a stage that needs type-only names, generic arity or runtime module bindings carries its scope row.
 */
export function namedImportStage(rules: NamedImportRules): NamedImportStage {
  const scopeRow = rules.scopeRow;
  const typeArgumentArity = scopeRow?.bindingRules?.typeArgumentArity;
  const moduleBindingsAtFunctionRuntime = !!scopeRow?.moduleBindingsAtFunctionRuntime;
  const typeOnlyUseRow = rules.typeOnlyUses ? scopeRow : undefined;
  return (index, mod, file, support, name, cNamespace, referenceIndex, callSite, scopeIndex) => {
    mod = withCsharpGlobalUsings(index, mod);
    const callArgumentCount = callSite
      ? explicitCallArgumentCount(support.id, callSite.source, callSite.node)
      : undefined;
    const callableReferenceType = rules.callableReferenceType;
    const callableReference =
      callableReferenceType && callArgumentCount === undefined ? callSite?.node.parent : undefined;
    // `::Name` may name a constructor or factory; the type receiver in `Name::member` is not that target.
    const referencesCallable =
      !!callableReference &&
      callableReference.type === callableReferenceType &&
      callableReference.namedChildren.at(-1)?.id === callSite?.node.id;
    const isCallableUse = callArgumentCount !== undefined || referencesCallable;
    const argumentCount = callArgumentCount ?? undefined;
    const typeUse =
      !!typeOnlyUseRow && !!callSite && (callSite.typeOnly || typeOnlyName(typeOnlyUseRow, callSite.node));
    const genericArity = callSite && typeArgumentArity ? typeArgumentArity(callSite.node) : undefined;
    const arityOptions = {
      ...(isCallableUse ? { isCallableUse } : {}),
      ...(argumentCount !== undefined ? { argumentCount } : {}),
      ...(genericArity !== undefined ? { csharpGenericArity: genericArity } : {}),
      ...(typeUse ? { typeOnly: true } : {}),
    };
    const normalizedName = support.normalizeIdentifier(name);
    const importsForName = rules.importsForName;
    const lookupImports = importsForName
      ? importsForName(mod, normalizedName, arityOptions.csharpGenericArity)
      : mod.imports;
    const requiresExplicitReceiver = !support.membersAreImplicitlyInScope;
    const directExport =
      requiresExplicitReceiver && !rules.splitExportNamespaces
        ? mod.exports.find(
            (entry) =>
              entry.type === "local" &&
              support.normalizeIdentifier(entry.exportedAs) === normalizedName &&
              !entry.target.isMember,
          )
        : undefined;
    const exportLookupSeparator = rules.exportLookupSeparator;
    const skipsExportLookup = !!exportLookupSeparator && !name.includes(exportLookupSeparator);
    let hit: ResolvedExport | null = null;
    const precedence = starImportPrecedence(support.id);
    const matchesExplicitBinding = (imp: ImportBinding): boolean => {
      if (isExpandedStarBinding(imp, mod.imports)) return false;
      if (imp.kind === "default") return support.normalizeIdentifier(imp.local) === normalizedName;
      if (imp.kind === "named") return !imp.cNamespace && support.normalizeIdentifier(imp.local) === normalizedName;
      return imp.kind === "namespace" && support.normalizeIdentifier(imp.localNS) === normalizedName;
    };
    // Explicit-beats-star languages: an explicit import, then the compilation unit (Java and
    // Kotlin same-package peers), then a wildcard. resolveExport's compilation-unit hit must wait
    // until explicit imports have had a chance to win and must still beat star imports. In Rust a
    // `use` and a same-named local item are a compile error, so the order changes nothing there.
    const deferCompilationUnitPeers = precedence === "explicit-beats-star";
    if (!skipsExportLookup) {
      if (directExport && directExport.type === "local") {
        hit = { kind: "resolved", def: directExport.target };
      } else if (!deferCompilationUnitPeers) {
        hit = resolveExport(index, file, name, {
          allowLocalFallback: support.membersAreImplicitlyInScope,
          ...(cNamespace ? { cNamespace } : {}),
          ...(rules.positionedExportLookup && referenceIndex !== undefined ? { referenceIndex } : {}),
          ...arityOptions,
        });
      }
    }
    // An import this file also exports (`import { X } from "./x"; export { X }`) stays the binding in force at its own
    // uses: the clause forwards that binding without declaring a name, so the import answers.
    if (hit && exportsOwnImportBinding(index, file, name)) hit = null;
    let localDefinition: SymbolDef | undefined;
    if (hit?.kind === "resolved" && fileIdentityKey(file) === fileIdentityKey(hit.def.file)) {
      localDefinition = hit.def;
    }
    const moduleLookupAtRuntime =
      moduleBindingsAtFunctionRuntime &&
      !!localDefinition &&
      referenceIndex !== undefined &&
      !!(scopeIndex ?? cachedScopeIndexForIndex(index, file))?.allScopes.some((scope) => {
        if (scope.kind !== "function") return false;
        const body = scope.node.childForFieldName("body");
        return !!body && referenceIndex >= body.startIndex && referenceIndex < body.endIndex;
      });
    let pendingOwnFunction = false;
    if (moduleBindingsAtFunctionRuntime && hit?.kind === "resolved" && hit.def.kind === SymbolKind.Function) {
      const sameFile = fileIdentityKey(file) === fileIdentityKey(hit.def.file);
      if (sameFile && callSite) {
        pendingOwnFunction = pythonFunctionPendingInDefault(hit.def.range.start.index, callSite.node);
      }
    }
    const effectiveBinding = effectiveExplicitOrLocalBinding(
      lookupImports,
      support.id,
      matchesExplicitBinding,
      pendingOwnFunction ? undefined : localDefinition?.range.start.index,
      referenceIndex,
      moduleLookupAtRuntime,
    );
    const effectiveExplicitImport = effectiveBinding?.kind === "explicit" ? effectiveBinding.binding : undefined;
    const declarationOutOfScope =
      hit?.kind === "resolved" &&
      referenceIndex !== undefined &&
      fileIdentityKey(file) === fileIdentityKey(hit.def.file) &&
      (pendingOwnFunction ||
        !fileScopeDefinitionCoversUse(support.id, hit.def.range, referenceIndex, hit.def.kind, moduleLookupAtRuntime));
    if (hit?.kind === "resolved" && (!requiresExplicitReceiver || !hit.def.isMember)) {
      // Under last-wins order the module binding in force at this use may be an import that a later
      // same-file declaration replaces, so the source-order veto must not answer for it. Only a
      // module-level import binds the module scope; a conditional, type-checking, or function-suite
      // import keeps the veto, and an arbitration that names neither side stays unresolved.
      const earlierModuleImportWins = precedence === "last-wins" && !!effectiveExplicitImport?.moduleLevel;
      if (declarationOutOfScope && !earlierModuleImportWins) return null;
      // Under last-wins order the declaration answers only when source order puts it in force.
      if (!declarationOutOfScope && (precedence !== "last-wins" || effectiveBinding?.kind === "local")) {
        const importedFrom =
          rules.crossFileExportsAreImports && fileIdentityKey(file) !== fileIdentityKey(hit.def.file)
            ? hit.def.file
            : undefined;
        return okGoToResult(index, hit.def, {
          via: { exportedName: name, ...(importedFrom ? { importedFrom } : {}) },
          resolution: importedFrom ? "import" : "exact",
          confidence: "high",
        });
      }
    }
    if (hit?.kind === "namespace" && effectiveBinding?.kind !== "explicit") {
      const namespaceExportFile = rules.namespaceExportFile;
      const namespaceFile = namespaceExportFile ? namespaceExportFile(index, mod.imports, name, hit.file) : hit.file;
      const targetMod = namespaceFile ? index.byFile.get(fileIdentityKey(namespaceFile)) : undefined;
      const firstExport = targetMod?.exports.find((entry) => entry.type === "local");
      if (firstExport) {
        return okGoToResult(index, firstExport.target, {
          via: { exportedName: name },
          resolution: "namespace",
          confidence: "medium",
        });
      }
    }

    const starCandidates: StarImportCandidate[] = [];
    let lastWinsResult: GoToResult | null = null;
    const checksEarlierModuleBinding = declarationOutOfScope && precedence === "last-wins";
    const acceptBinding = (result: GoToResult, imp: ImportBinding): GoToResult | null => {
      // A click on the binding's own token names that import, not a later rebinding.
      if (precedence === "last-wins" && referenceIndex !== undefined && importBindingCoversIndex(imp, referenceIndex)) {
        return result;
      }
      if (precedence === "last-wins") {
        lastWinsResult = result;
        return null;
      }
      return result;
    };

    for (const imp of lookupImports) {
      // Star expansion republishes the same names. Judging those copies as explicit
      // imports would hide a second star import behind the first expanded binding.
      if (isExpandedStarBinding(imp, mod.imports)) continue;
      const matchesExplicit = matchesExplicitBinding(imp);
      if (matchesExplicit && effectiveExplicitImport !== imp) continue;

      let matched: GoToResult | null = null;
      if (imp.kind === "default" && support.normalizeIdentifier(imp.local) === normalizedName) {
        const result = resolveImported(index, imp, "default", arityOptions);
        if (result && !("namespace" in result)) {
          matched = okGoToResult(index, result, {
            via: {
              ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
              exportedName: "default",
            },
            resolution: "import",
            confidence: "high",
          });
        }
      } else if (imp.kind === "named" && support.normalizeIdentifier(imp.local) === normalizedName) {
        const phpRole = phpNamedImportRole(imp);
        let result: SymbolDef | { namespace: FileId } | null;
        if (phpRole) {
          // This role-blind fallback cannot choose between PHP class, function, and constant aliases.
          const hasPhpRoleCollision = mod.imports.some(
            (candidate) =>
              candidate !== imp &&
              candidate.kind === "named" &&
              phpNamedImportRole(candidate) !== undefined &&
              support.normalizeIdentifier(candidate.local) === normalizedName,
          );
          if (hasPhpRoleCollision) {
            result = null;
          } else {
            result = resolvePhpExplicitImport(index, imp, phpRole);
          }
        } else {
          result = resolveImported(index, imp, imp.imported, {
            ...(cNamespace ? { cNamespace } : {}),
            ...arityOptions,
          });
        }
        if (result && !("namespace" in result)) {
          matched = okGoToResult(index, result, {
            via: {
              ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
              exportedName: imp.imported,
            },
            resolution: "import",
            confidence: "high",
          });
        }
      } else if (imp.kind === "star") {
        let targetModule: ModuleIndex | undefined;
        // This fallback is for an earlier explicit module binding, not a star that executes later.
        if (checksEarlierModuleBinding && referenceIndex !== undefined) {
          if (imp.pythonStatementStartIndex === undefined) {
            lastWinsResult = { status: "not_found", reason: AMBIGUOUS_STAR_IMPORT_REASON };
            continue;
          }
          if (imp.pythonStatementStartIndex > referenceIndex) continue;
          const explicitStartIndex = effectiveExplicitImport
            ? explicitBindingStartIndex(effectiveExplicitImport)
            : undefined;
          // A subsequent explicit import overwrites even an unchecked star.
          if (explicitStartIndex !== undefined && imp.pythonStatementStartIndex < explicitStartIndex) continue;
          if (!imp.moduleLevel) {
            lastWinsResult = { status: "not_found", reason: AMBIGUOUS_STAR_IMPORT_REASON };
            continue;
          }
          targetModule = typeof imp.resolved === "string" ? index.byFile.get(fileIdentityKey(imp.resolved)) : undefined;
          if (
            !targetModule ||
            targetModule.parserDegraded ||
            targetModule.nativeOutcome === "skipped" ||
            targetModule.parseErrorRanges?.length
          ) {
            lastWinsResult = { status: "not_found", reason: AMBIGUOUS_STAR_IMPORT_REASON };
            continue;
          }
        }
        const def = resolveStarImportedDefinition(
          index,
          imp,
          name,
          support.id,
          cNamespace,
          argumentCount,
          isCallableUse,
          arityOptions.csharpGenericArity,
          arityOptions.typeOnly,
        );
        // A resolved export can still be replaced by forwarding of the same name. Keep that
        // uncertainty until a later proven binding overwrites it; unrelated imports are harmless.
        if (targetModule) {
          const hasUncheckedNameImports = targetModule.imports.some((binding) => {
            if (binding.kind === "star") return true;
            const bindingName = binding.kind === "namespace" ? binding.localNS : binding.local;
            return support.normalizeIdentifier(bindingName) === normalizedName;
          });
          const hasUncheckedNameExports =
            hasUncheckedNameImports ||
            targetModule.exports.some((entry) => {
              if (entry.type === "exportStar") return true;
              const exportsRequestedName = support.normalizeIdentifier(entry.exportedAs) === normalizedName;
              if (entry.type === "local") return !def && exportsRequestedName;
              return exportsRequestedName;
            });
          const cannotProveStarBinding =
            hasUncheckedNameExports ||
            (!def &&
              targetModule.locals.some((local) => support.normalizeIdentifier(local.localName) === normalizedName));
          if (cannotProveStarBinding) {
            lastWinsResult = { status: "not_found", reason: AMBIGUOUS_STAR_IMPORT_REASON };
            continue;
          }
        }
        if (def) {
          const starResult = starImportGoTo(index, imp, def, name);
          if (precedence === "last-wins") {
            const taken = acceptBinding(starResult, imp);
            if (taken) return taken;
          } else {
            starCandidates.push({ imp, def });
          }
        }
      } else if (imp.kind === "namespace" && support.normalizeIdentifier(imp.localNS) === normalizedName) {
        // An unaliased `import a.b` binds the package `a`, not the leaf module its binding resolves to.
        let targetFile: string | undefined;
        if (isPythonDottedImportBinding(imp)) targetFile = pythonDottedImportPackageFile(index, imp);
        else if (typeof imp.resolved === "string") targetFile = normalizePath(imp.resolved);
        if (imp.mechanism === "cjs" && targetFile) {
          const classValue = cjsRequireValueBinding(index, targetFile);
          if (classValue) {
            matched = okGoToResult(index, classValue, {
              via: {
                ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
                exportedName: classValue.localName,
              },
              resolution: "import",
              confidence: "high",
            });
          }
        }
        if (!matched) {
          const targetMod = targetFile ? index.byFile.get(fileIdentityKey(targetFile)) : undefined;
          const firstExport = targetMod?.exports.find((entry) => entry.type === "local");
          if (firstExport) {
            matched = okGoToResult(index, firstExport.target, {
              via: {
                ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
                exportedName: firstExport.exportedAs,
              },
              resolution: "namespace",
              confidence: "medium",
            });
          }
        }
      }

      if (!matched) {
        if (matchesExplicit && effectiveExplicitImport === imp) {
          if (precedence !== "last-wins") return null;
          lastWinsResult = null;
        }
        continue;
      }
      const taken = acceptBinding(matched, imp);
      if (taken) return taken;
    }

    // A local binding name always wins above so a grouped import's own aliases never collide with
    // each other. An aliased import's source spelling is not itself a bound name anywhere in the
    // file (Python: `from a import helper as h` binds only `h`; a bare `helper()` elsewhere is
    // unbound and must stay not_found), so only resolve it when the click falls inside that exact
    // import statement's own source-name token, never by re-matching the spelling anywhere else.
    if (referenceIndex !== undefined) {
      for (const imp of mod.imports) {
        if (
          imp.kind !== "named" ||
          imp.local === imp.imported ||
          support.normalizeIdentifier(imp.imported) !== normalizedName ||
          !imp.importedRange ||
          imp.importedRange.start.index === undefined ||
          imp.importedRange.end.index === undefined ||
          referenceIndex < imp.importedRange.start.index ||
          referenceIndex >= imp.importedRange.end.index
        ) {
          continue;
        }
        const result = resolveImported(index, imp, imp.imported, {
          ...(cNamespace ? { cNamespace } : {}),
          ...arityOptions,
        });
        if (result && !("namespace" in result)) {
          return okGoToResult(index, result, {
            via: {
              ...(toModuleRef(imp.resolved) ? { importedFrom: toModuleRef(imp.resolved) } : {}),
              exportedName: imp.imported,
            },
            resolution: "import",
            confidence: "high",
          });
        }
      }
    }

    if (precedence === "last-wins") {
      if (lastWinsResult) return lastWinsResult;
    } else {
      if (deferCompilationUnitPeers) {
        const unitHit = resolveExport(index, file, name, {
          allowLocalFallback: support.membersAreImplicitlyInScope,
          ...arityOptions,
        });
        if (unitHit?.kind === "resolved" && (!requiresExplicitReceiver || !unitHit.def.isMember)) {
          return okGoToResult(index, unitHit.def, {
            via: { exportedName: name },
            resolution: "exact",
            confidence: "high",
          });
        }
        if (unitHit?.kind === "namespace") {
          const targetMod = index.byFile.get(fileIdentityKey(unitHit.file));
          const firstExport = targetMod?.exports.find((entry) => entry.type === "local");
          if (firstExport) {
            return okGoToResult(index, firstExport.target, {
              via: { exportedName: name },
              resolution: "namespace",
              confidence: "medium",
            });
          }
        }
      }
      if (!starCandidates.length) return null;
      const starsMayHoldName = rules.starsMayHoldName;
      const blocked = !!starsMayHoldName && starsMayHoldName(index, mod, name);
      const decision = decideStarImportCandidates(index, support.id, starCandidates, file, blocked, isCallableUse);
      if (decision.status === "ambiguous") {
        return { status: "not_found", reason: AMBIGUOUS_STAR_IMPORT_REASON };
      }
      if (decision.status === "resolved") {
        return starImportGoTo(index, decision.imp, decision.definition, name);
      }
    }

    return null;
  };
}

/** The stage of every language without its own named/import rules. */
export const genericNamedImportStage = namedImportStage({});
