import { JAVA_SUPPORT, KOTLIN_SUPPORT } from "../../languages.js";
import { normalizeKotlinIdentifier } from "../../util/identifiers.js";
import { fileIdentityKey } from "../../util/paths.js";
import { getCompilationUnitPeers } from "../compilation-units.js";
import { SymbolKind, type ProjectIndex, type ResolvedExport, type SymbolDef } from "../types.js";
import type { ImportNameDeps, ImportNameRules } from "../import-name-types.js";

/**
 * Same-package Java/Kotlin export that the bare-name unit scan does not answer (a member, for
 * example). Peers come from `getCompilationUnitPeers`, so Java and Kotlin share one package
 * rule. An incomplete set (an unreadable peer, or the same package outside this directory)
 * is not a proven unique answer.
 */
function resolveSiblingPackageExport(
  index: ProjectIndex,
  targetFile: string,
  exportedName: string,
  deps: ImportNameDeps,
): ResolvedExport | null {
  const peers = getCompilationUnitPeers(index, targetFile);
  if (!peers.complete) return null;
  const targetFileKey = fileIdentityKey(targetFile);
  const matches: ResolvedExport[] = [];
  for (const peerFile of peers.files) {
    if (fileIdentityKey(peerFile) === targetFileKey) continue;
    const hit = deps.resolveExport(index, peerFile, exportedName);
    if (hit && !matches.some((candidate) => deps.sameResolvedExport(index, candidate, hit))) {
      matches.push(hit);
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
/**
 * One function from an overload set, or null when the count is not accepted by exactly one.
 * Only indexed `callable.arity` is consulted: a missing arity does not accept, and a count
 * two overloads both accept stays unresolved.
 */
export function selectFunctionOverloadByArity(
  candidates: readonly SymbolDef[],
  argumentCount: number,
): SymbolDef | null {
  if (candidates.length < 2 || candidates.some((candidate) => candidate.kind !== SymbolKind.Function)) return null;
  const accepting = candidates.filter((candidate) => {
    const arity = candidate.callable?.arity;
    return !!arity && argumentCount >= arity.minArgs && (arity.maxArgs === null || argumentCount <= arity.maxArgs);
  });
  return accepting.length === 1 ? (accepting[0] ?? null) : null;
}

const JVM_IMPORT_NAME_RULES: ImportNameRules = {
  aliasKey: normalizeKotlinIdentifier,
  selectOverload: selectFunctionOverloadByArity,
  resolveMissingTarget(index, binding, targetFile, lookupName, deps) {
    const hit = resolveSiblingPackageExport(index, targetFile, lookupName, deps);
    if (hit?.kind === "resolved") {
      if (binding.kind === "named" && hit.def.javaPackagePrivate && !binding.jvmSamePackage) return null;
      return hit.def;
    }
    if (hit?.kind === "namespace") return { namespace: hit.file };
    return null;
  },
};

export const JAVA_IMPORT_NAME_RULES: ImportNameRules = {
  ...JVM_IMPORT_NAME_RULES,
  starExpansion: {
    normalizeTypeName: JAVA_SUPPORT.normalizeIdentifier,
    classifierKinds: { [SymbolKind.Class]: true, [SymbolKind.Interface]: true, [SymbolKind.TypeAlias]: true },
  },
};

export const KOTLIN_IMPORT_NAME_RULES: ImportNameRules = {
  ...JVM_IMPORT_NAME_RULES,
  starExpansion: {
    normalizeTypeName: KOTLIN_SUPPORT.normalizeIdentifier,
    classifierKinds: { [SymbolKind.Class]: true, [SymbolKind.Interface]: true },
  },
  star: {
    blocksCandidates(index, candidates, isCallableUse, useFile) {
      const mayOverload = isCallableUse || candidates.some((candidate) => candidate.def.kind === SymbolKind.Function);
      if (!mayOverload || !useFile) return false;
      return !!index.byFile
        .get(fileIdentityKey(useFile))
        ?.imports.some((binding) => binding.kind === "star" && binding.jvmPackageFiles && binding.jvmPackageIncomplete);
    },
  },
};
