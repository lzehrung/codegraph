import fs from "node:fs";
import path from "node:path";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import { languageHasDeclarationVisibility } from "./declaration-visibility.js";
import type { FileId } from "../types.js";
import { foldPhpIdentifierCase, normalizeCsharpQualifiedName } from "../util/identifiers.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";
import {
  getCompilationUnitPeers,
  getPackageDeclarationName,
  IMPLICIT_UNIT_LANGUAGES,
  isUnitBareNameVisible,
} from "./compilation-units.js";
import { phpNamedImportRole } from "./import-types.js";
import { coalesceEquivalentCsharpPartialExports } from "./shared-owner-identity.js";
import {
  type ExportEntry,
  type ImportBinding,
  type ModuleIndex,
  type ProjectIndex,
  type ResolvedExport,
  type SymbolDef,
  SymbolKind,
} from "./types.js";

/**
 * Files that can carry the package declaration each lookup language searches for. Java and Kotlin
 * stay one group because they share a JVM package namespace and each pattern already accepts the
 * other's declaration; every other language is skipped instead of read for a keyword it never uses.
 */
const PACKAGE_DECLARING_LANGUAGE_IDS: Record<"go" | "java" | "kotlin", ReadonlySet<string>> = {
  go: new Set(["go"]),
  java: new Set(["java", "kotlin"]),
  kotlin: new Set(["java", "kotlin"]),
};

function cacheKey(file: FileId, canonicalName: string): string {
  return `${fileIdentityKey(file)}::canonical::${canonicalName}`;
}
type ModuleNameLookup = {
  normalizeIdentifier: (name: string) => string;
  localExports: Map<string, SymbolDef[]>;
  namespaceReexports: Map<string, Extract<ExportEntry, { type: "namespaceReexport" }>[]>;
  reexports: Map<string, Extract<ExportEntry, { type: "reexport" }>[]>;
  locals: Map<string, SymbolDef[]>;
};

type PackageDirectoryLookup = {
  byName: Map<string, ModuleIndex[]>;
};

const moduleNameLookups = new WeakMap<ProjectIndex, Map<string, ModuleNameLookup>>();
const packageDirectoryLookups = new WeakMap<
  ProjectIndex,
  Map<"go" | "java" | "kotlin", Map<string, PackageDirectoryLookup>>
>();

export type ResolveExportOptions = {
  preferredKind?: SymbolKind;
  allowLocalFallback?: boolean;
  cNamespace?: "tag" | "ordinary";
  /** Source position for implicit C# namespace lookup in the initial file. */
  referenceIndex?: number;
};
const PHP_CLASS_NAMESPACE_KINDS = [SymbolKind.Class, SymbolKind.Interface, SymbolKind.TypeAlias] as const;

function moduleFor(index: ProjectIndex, file: FileId): ModuleIndex | undefined {
  return index.byFile.get(fileIdentityKey(file));
}

/**
 * Languages with a visibility row already omitted hidden declarations from `exports`.
 * Falling back to locals would re-bind those names across modules.
 *
 * Safe without a "was the export list computed?" check because locals and exports
 * come from the same `collectLocalsAndExportsFromSource` pass. If a local candidate
 * exists for the fallback to read, extraction ran and an absent name was filtered
 * on purpose, including the all-hidden file whose computed export list is empty.
 * If extraction did not run (reduced or graph-only, empty syntax tree), there are
 * no locals either, so the fallback finds nothing and this guard is irrelevant.
 * Reduced or graph-only extraction produces neither locals nor exports for rust,
 * java, csharp, kotlin, or swift, so this guard needs no reduced-mode branch.
 * Languages with no visibility row keep today's local fallback.
 */
function shouldSkipVisibilityLocalFallback(index: ProjectIndex, moduleEntry: ModuleIndex): boolean {
  const languageId = supportForFileWithoutHeaderSample(moduleEntry.file, index.languageExtensions)?.id;
  return languageId !== undefined && languageHasDeclarationVisibility(languageId);
}

function moduleNameLookup(index: ProjectIndex, file: FileId): ModuleNameLookup | undefined {
  let lookups = moduleNameLookups.get(index);
  if (!lookups) {
    lookups = new Map<string, ModuleNameLookup>();
    for (const moduleEntry of index.byFile.values()) {
      // Only the normalizer is needed, and C and C++ share the default one, so a `.h` header
      // never has to be sampled here.
      const normalizeIdentifier =
        supportForFileWithoutHeaderSample(moduleEntry.file, index.languageExtensions)?.normalizeIdentifier ??
        ((name) => name);
      const localExports = new Map<string, SymbolDef[]>();
      const namespaceReexports = new Map<string, Extract<ExportEntry, { type: "namespaceReexport" }>[]>();
      const reexports = new Map<string, Extract<ExportEntry, { type: "reexport" }>[]>();
      const locals = new Map<string, SymbolDef[]>();
      for (const entry of moduleEntry.exports) {
        if (entry.type === "local") {
          const canonicalName = normalizeIdentifier(entry.exportedAs);
          const entries = localExports.get(canonicalName) ?? [];
          entries.push(entry.target);
          localExports.set(canonicalName, entries);
        } else if (entry.type === "namespaceReexport") {
          const canonicalName = normalizeIdentifier(entry.exportedAs);
          const entries = namespaceReexports.get(canonicalName) ?? [];
          entries.push(entry);
          namespaceReexports.set(canonicalName, entries);
        } else if (entry.type === "reexport") {
          const canonicalName = normalizeIdentifier(entry.exportedAs);
          const entries = reexports.get(canonicalName) ?? [];
          entries.push(entry);
          reexports.set(canonicalName, entries);
        }
      }
      for (const local of moduleEntry.locals) {
        const canonicalName = normalizeIdentifier(local.localName);
        const entries = locals.get(canonicalName) ?? [];
        entries.push(local);
        locals.set(canonicalName, entries);
      }
      lookups.set(fileIdentityKey(moduleEntry.file), {
        normalizeIdentifier,
        localExports,
        namespaceReexports,
        reexports,
        locals,
      });
    }
    moduleNameLookups.set(index, lookups);
  }
  return lookups.get(fileIdentityKey(file));
}

function sameSymbolDef(index: ProjectIndex, left: SymbolDef, right: SymbolDef): boolean {
  if (fileIdentityKey(left.file) !== fileIdentityKey(right.file) || left.kind !== right.kind) {
    return false;
  }
  // Same reasoning as `moduleNameLookup`: the normalizer is identical for C and C++.
  const normalizeIdentifier =
    supportForFileWithoutHeaderSample(left.file, index.languageExtensions)?.normalizeIdentifier ?? ((name) => name);
  if (normalizeIdentifier(left.localName) !== normalizeIdentifier(right.localName)) {
    return false;
  }

  const leftIndex = left.range.start.index;
  const rightIndex = right.range.start.index;
  if (typeof leftIndex === "number" && typeof rightIndex === "number") {
    return leftIndex === rightIndex;
  }

  return left.range.start.line === right.range.start.line && left.range.start.column === right.range.start.column;
}

function sameResolvedExport(index: ProjectIndex, left: ResolvedExport, right: ResolvedExport): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "resolved" && right.kind === "resolved") {
    return sameSymbolDef(index, left.def, right.def);
  }
  if (left.kind === "namespace" && right.kind === "namespace") {
    return fileIdentityKey(left.file) === fileIdentityKey(right.file);
  }
  return false;
}

/**
 * Unique same-compilation-unit match for a bare name. Go, the JVM languages, C#, and Swift can
 * name top-level declarations of their package, namespace, or module without an import;
 * candidates come from the same proven unit relation used for reference-candidate discovery
 * (`getCompilationUnitPeers`), never from a project-wide name scan. A name matching more than
 * one unit declaration is ambiguous and stays unresolved, except proven-equivalent C# `partial`
 * type parts, which collapse to one representative before uniqueness is judged. Members are
 * excluded because they resolve through receiver/owner identity rather than as bare unit names.
 */
function resolveImplicitUnitExport(
  index: ProjectIndex,
  file: FileId,
  exportedName: string,
  matchesOptions: (def: SymbolDef, namespace: ResolveExportOptions["cNamespace"]) => boolean,
  namespace: ResolveExportOptions["cNamespace"],
  useIndex?: number,
  qualification?: string,
): SymbolDef | null {
  // Only the implicit compilation-unit languages have bare-name unit visibility. C and C++
  // keep their include-scope tag precedence and PHP its case-folded namespaces; the unit
  // lookup must not preempt those established fallbacks.
  const languageId = supportForFileWithoutHeaderSample(file, index.languageExtensions)?.id;
  if (!languageId || !IMPLICIT_UNIT_LANGUAGES[languageId]) return null;
  const matches: SymbolDef[] = [];
  const peers = getCompilationUnitPeers(
    index,
    file,
    languageId === "csharp" && qualification !== undefined ? { csharpQualifiedName: true } : undefined,
  );
  for (const peerFile of peers.files) {
    const names = moduleNameLookup(index, peerFile);
    if (!names) continue;
    for (const target of names.localExports.get(names.normalizeIdentifier(exportedName)) ?? []) {
      if (target.isMember || !matchesOptions(target, namespace)) continue;
      if (
        !isUnitBareNameVisible({
          index,
          declarationFile: target.file,
          declaration: target.range,
          useFile: file,
          ...(useIndex !== undefined ? { useIndex } : {}),
          ...(qualification !== undefined ? { qualification } : {}),
        })
      ) {
        continue;
      }
      if (!matches.some((candidate) => sameSymbolDef(index, candidate, target))) {
        matches.push(target);
      }
    }
  }
  const unique = languageId === "csharp" ? coalesceEquivalentCsharpPartialExports(index, matches) : matches;
  return unique.length === 1 ? (unique[0] ?? null) : null;
}

function packageDirectoryLookup(
  index: ProjectIndex,
  languageId: "go" | "java" | "kotlin",
): Map<string, PackageDirectoryLookup> {
  let byLanguage = packageDirectoryLookups.get(index);
  if (!byLanguage) {
    byLanguage = new Map<"go" | "java" | "kotlin", Map<string, PackageDirectoryLookup>>();
    packageDirectoryLookups.set(index, byLanguage);
  }
  const cached = byLanguage.get(languageId);
  if (cached) return cached;

  const directories = new Map<string, PackageDirectoryLookup>();
  for (const moduleEntry of index.byFile.values()) {
    const directoryKey = fileIdentityKey(path.dirname(moduleEntry.file));
    let directory = directories.get(directoryKey);
    if (!directory) {
      directory = { byName: new Map<string, ModuleIndex[]>() };
      directories.set(directoryKey, directory);
    }
    const moduleLanguageId = supportForFileWithoutHeaderSample(moduleEntry.file, index.languageExtensions)?.id;
    if (!moduleLanguageId || !PACKAGE_DECLARING_LANGUAGE_IDS[languageId].has(moduleLanguageId)) continue;
    const packageName =
      languageId === "go"
        ? getPackageDeclarationName(index, moduleEntry.file, "go")
        : getPackageDeclarationName(index, moduleEntry.file, languageId);
    if (!packageName) continue;
    const entries = directory.byName.get(packageName) ?? [];
    entries.push(moduleEntry);
    directory.byName.set(packageName, entries);
  }
  byLanguage.set(languageId, directories);
  return directories;
}
function resolveSiblingPackageExport(
  index: ProjectIndex,
  targetFile: string,
  exportedName: string,
  languageId: "java" | "kotlin",
): ResolvedExport | null {
  const packageName = getPackageDeclarationName(index, targetFile, languageId);
  if (!packageName) return null;
  const directory = packageDirectoryLookup(index, languageId).get(fileIdentityKey(path.dirname(targetFile)));
  if (!directory) return null;
  const targetFileKey = fileIdentityKey(targetFile);
  const matches: ResolvedExport[] = [];
  for (const moduleEntry of directory.byName.get(packageName) ?? []) {
    if (fileIdentityKey(moduleEntry.file) === targetFileKey) continue;
    const hit = resolveExport(index, moduleEntry.file, exportedName);
    if (hit && !matches.some((candidate) => sameResolvedExport(index, candidate, hit))) {
      matches.push(hit);
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function resolvePythonSubmodule(targetFile: string, exportedName: string): FileId | null {
  let baseDir: string;
  try {
    const targetStat = fs.statSync(targetFile);
    if (targetStat.isDirectory()) {
      baseDir = targetFile;
    } else if (path.basename(targetFile) === "__init__.py" || path.basename(targetFile) === "__init__.pyi") {
      baseDir = path.dirname(targetFile);
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const moduleFile = path.join(baseDir, `${exportedName}.py`);
  const stubModuleFile = path.join(baseDir, `${exportedName}.pyi`);
  const packageInit = path.join(baseDir, exportedName, "__init__.py");
  const stubPackageInit = path.join(baseDir, exportedName, "__init__.pyi");
  const namespacePackage = path.join(baseDir, exportedName);
  for (const candidate of [moduleFile, stubModuleFile, packageInit, stubPackageInit, namespacePackage]) {
    try {
      const candidateStat = fs.statSync(candidate);
      if (candidate === namespacePackage ? candidateStat.isDirectory() : candidateStat.isFile()) {
        return normalizePath(candidate);
      }
    } catch {
      // The next candidate can still be a real submodule.
    }
  }

  return null;
}

export function resolveExport(
  index: ProjectIndex,
  file: FileId,
  exportedName: string,
  opts?: ResolveExportOptions,
): ResolvedExport | null {
  const visited = new Set<string>();
  const matchesOptions = (def: SymbolDef, namespace: ResolveExportOptions["cNamespace"]): boolean =>
    (!opts?.preferredKind || def.kind === opts.preferredKind) &&
    (namespace === undefined || (def.cTag ? "tag" : "ordinary") === namespace);
  const allowLocalFallback = opts?.allowLocalFallback ?? true;

  function resolveFromFile(fileInner: FileId, name: string, namespace = opts?.cNamespace): ResolvedExport | null {
    const moduleEntry = moduleFor(index, fileInner);
    if (!moduleEntry) return null;
    const names = moduleNameLookup(index, moduleEntry.file);
    if (!names) return null;
    const normalizedFile = normalizePath(moduleEntry.file);
    const referenceIndex = fileIdentityKey(fileInner) === fileIdentityKey(file) ? opts?.referenceIndex : undefined;
    const filtersUseNamespace =
      referenceIndex !== undefined &&
      supportForFileWithoutHeaderSample(normalizedFile, index.languageExtensions)?.id === "csharp";
    const separator = filtersUseNamespace ? name.lastIndexOf(".") : -1;
    let qualification: string | undefined;
    let unqualifiedName = name;
    if (separator >= 0) {
      // `@P.Target` and `P.Target` name the same namespace path.
      qualification = normalizeCsharpQualifiedName(name.slice(0, separator));
      unqualifiedName = name.slice(separator + 1);
    } else if (filtersUseNamespace && name.startsWith("global::")) {
      qualification = "global::";
      unqualifiedName = name.slice("global::".length);
    }
    const canonicalName = names.normalizeIdentifier(unqualifiedName);
    const key = `${cacheKey(normalizedFile, names.normalizeIdentifier(name))}::${opts?.preferredKind ?? ""}::${namespace ?? ""}::${allowLocalFallback ? "local" : "export"}::${referenceIndex ?? ""}`;
    if (index.exportCache.has(key)) return index.exportCache.get(key)!;

    const cycleKey = `${cacheKey(normalizedFile, canonicalName)}::${namespace ?? ""}`;
    if (visited.has(cycleKey)) return null;
    visited.add(cycleKey);

    const implicitUnitExport = resolveImplicitUnitExport(
      index,
      normalizedFile,
      canonicalName,
      matchesOptions,
      namespace,
      referenceIndex,
      qualification,
    );
    if (implicitUnitExport) {
      const result: ResolvedExport = { kind: "resolved", def: implicitUnitExport };
      index.exportCache.set(key, result);
      return result;
    }

    const localCandidates: SymbolDef[] = [];
    for (const target of names.localExports.get(canonicalName) ?? []) {
      if (
        matchesOptions(target, namespace) &&
        // Nested types resolve through their owner, not as bare namespace names.
        (!filtersUseNamespace ||
          (!target.isMember &&
            isUnitBareNameVisible({
              index,
              declarationFile: target.file,
              declaration: target.range,
              useFile: file,
              useIndex: referenceIndex,
              ...(qualification !== undefined ? { qualification } : {}),
            }))) &&
        !localCandidates.some((candidate) => sameSymbolDef(index, candidate, target))
      ) {
        localCandidates.push(target);
      }
    }
    // A bodyless C tag use can introduce an incomplete tag, but must reuse a tag
    // already brought into scope by an include. Do not let that use hide its header.
    if (
      namespace &&
      (!localCandidates.length ||
        localCandidates.every((candidate) => candidate.cTag === "reference" || candidate.cTag === "forward"))
    ) {
      const included: ResolvedExport[] = [];
      for (const imp of moduleEntry.imports) {
        if (typeof imp.resolved !== "string") continue;
        if (imp.kind !== "star" && !(imp.kind === "named" && imp.local === name)) continue;
        if (imp.kind === "named" && (imp.cNamespace ?? "ordinary") !== namespace) continue;
        const downstream = resolveFromFile(imp.resolved, imp.kind === "named" ? imp.imported : name, namespace);
        if (downstream && !included.some((candidate) => sameResolvedExport(index, candidate, downstream))) {
          included.push(downstream);
        }
      }
      if (included.length) {
        const result = included.length === 1 ? included[0]! : null;
        index.exportCache.set(key, result);
        return result;
      }
    }
    if (localCandidates.length === 1) {
      const target = localCandidates[0]!;
      const result: ResolvedExport = { kind: "resolved", def: target };
      index.exportCache.set(key, result);
      return result;
    }
    if (localCandidates.length) {
      index.exportCache.set(key, null);
      return null;
    }

    const namespaceCandidates = new Map<string, ResolvedExport>();
    for (const entry of names.namespaceReexports.get(canonicalName) ?? []) {
      const result: ResolvedExport = { kind: "namespace", file: normalizePath(entry.fromModule) };
      namespaceCandidates.set(fileIdentityKey(result.file), result);
    }
    if (namespaceCandidates.size === 1) {
      const result = namespaceCandidates.values().next().value!;
      index.exportCache.set(key, result);
      return result;
    }
    if (namespaceCandidates.size) {
      index.exportCache.set(key, null);
      return null;
    }

    const reexportCandidates: ResolvedExport[] = [];
    for (const entry of names.reexports.get(canonicalName) ?? []) {
      const downstream =
        resolveFromFile(entry.fromModule, entry.sourceSpecifier || canonicalName, namespace) ??
        // A qualified using target cannot fall back to an unrelated bare export.
        (entry.sourceSpecifier.includes("::") ? null : resolveFromFile(entry.fromModule, canonicalName, namespace));
      if (downstream && !reexportCandidates.some((candidate) => sameResolvedExport(index, candidate, downstream))) {
        reexportCandidates.push(downstream);
      }
    }
    if (reexportCandidates.length === 1) {
      const result = reexportCandidates[0]!;
      index.exportCache.set(key, result);
      return result;
    }
    if (reexportCandidates.length) {
      index.exportCache.set(key, null);
      return null;
    }

    const starCandidates: ResolvedExport[] = [];
    for (const entry of moduleEntry.exports) {
      if (entry.type !== "exportStar") continue;
      const downstream = resolveFromFile(entry.fromModule, canonicalName, namespace);
      if (downstream && !starCandidates.some((candidate) => sameResolvedExport(index, candidate, downstream))) {
        starCandidates.push(downstream);
      }
    }
    const [onlyStarCandidate] = starCandidates;
    if (starCandidates.length === 1 && onlyStarCandidate) {
      index.exportCache.set(key, onlyStarCandidate);
      return onlyStarCandidate;
    }
    if (starCandidates.length) {
      index.exportCache.set(key, null);
      return null;
    }

    const localFallbackCandidates: SymbolDef[] = [];
    // C# lexical bindings have already been checked. Only namespace-level types
    // can remain visible from another region without a shared lexical scope.
    if (allowLocalFallback && (filtersUseNamespace || !shouldSkipVisibilityLocalFallback(index, moduleEntry))) {
      for (const local of names.locals.get(canonicalName) ?? []) {
        if (
          filtersUseNamespace &&
          (local.isMember ||
            (local.kind !== SymbolKind.Class &&
              local.kind !== SymbolKind.Interface &&
              local.kind !== SymbolKind.TypeAlias) ||
            !isUnitBareNameVisible({
              index,
              declarationFile: local.file,
              declaration: local.range,
              useFile: file,
              useIndex: referenceIndex,
              ...(qualification !== undefined ? { qualification } : {}),
            }))
        ) {
          continue;
        }
        if (
          matchesOptions(local, namespace) &&
          !localFallbackCandidates.some((candidate) => sameSymbolDef(index, candidate, local))
        ) {
          localFallbackCandidates.push(local);
        }
      }
    }
    // Hidden same-file C# types are omitted from exports, so equivalent internal
    // `partial` parts both land here. Collapse them with the same shared-owner
    // identity used for exported candidates before uniqueness is judged.
    const uniqueLocalFallback = filtersUseNamespace
      ? coalesceEquivalentCsharpPartialExports(index, localFallbackCandidates)
      : localFallbackCandidates;
    if (uniqueLocalFallback.length === 1) {
      const local = uniqueLocalFallback[0]!;
      const result: ResolvedExport = { kind: "resolved", def: local };
      index.exportCache.set(key, result);
      return result;
    }
    if (uniqueLocalFallback.length) {
      index.exportCache.set(key, null);
      return null;
    }

    index.exportCache.set(key, null);
    return null;
  }

  return resolveFromFile(file, exportedName);
}

function resolvePhpCaseInsensitiveExport(
  index: ProjectIndex,
  targetFile: FileId,
  exportedName: string,
  preferredKind: SymbolKind,
): ResolvedExport | null {
  const exactExport = resolveExport(index, targetFile, exportedName, { preferredKind, allowLocalFallback: false });
  if (exactExport) return exactExport;

  const moduleEntry = moduleFor(index, targetFile);
  if (!moduleEntry) return null;
  const foldedName = foldPhpIdentifierCase(exportedName);
  const resolveUnique = (sourceSpellings: Set<string>, allowLocalFallback: boolean): ResolvedExport | null => {
    const matches: ResolvedExport[] = [];
    for (const sourceSpelling of sourceSpellings) {
      const hit = resolveExport(index, targetFile, sourceSpelling, { preferredKind, allowLocalFallback });
      if (hit && !matches.some((candidate) => sameResolvedExport(index, candidate, hit))) {
        matches.push(hit);
      }
    }
    return matches.length === 1 ? matches[0]! : null;
  };

  const exportSpellings = new Set<string>();
  for (const entry of moduleEntry.exports) {
    if (
      entry.type === "local" &&
      entry.target.kind === preferredKind &&
      foldPhpIdentifierCase(entry.exportedAs) === foldedName
    ) {
      exportSpellings.add(entry.exportedAs);
    }
  }
  if (exportSpellings.size) return resolveUnique(exportSpellings, false);

  const exactLocal = resolveExport(index, targetFile, exportedName, { preferredKind });
  if (exactLocal) return exactLocal;
  const localSpellings = new Set<string>();
  for (const local of moduleEntry.locals) {
    if (local.kind === preferredKind && foldPhpIdentifierCase(local.localName) === foldedName) {
      localSpellings.add(local.localName);
    }
  }
  return resolveUnique(localSpellings, true);
}

/** Resolves a PHP symbol through its separate class, function, or constant import namespace. */
export function resolvePhpExportByImportType(
  index: ProjectIndex,
  targetFile: FileId,
  exportedName: string,
  importType: "class" | "function" | "const" | undefined,
): ResolvedExport | null {
  if (importType === "class") {
    for (const preferredKind of PHP_CLASS_NAMESPACE_KINDS) {
      const hit = resolvePhpCaseInsensitiveExport(index, targetFile, exportedName, preferredKind);
      if (hit) return hit;
    }
    return null;
  }
  if (importType === "function") {
    return resolvePhpCaseInsensitiveExport(index, targetFile, exportedName, SymbolKind.Function);
  }
  if (importType === "const") {
    return resolveExport(index, targetFile, exportedName, { preferredKind: SymbolKind.Variable });
  }
  return resolveExport(index, targetFile, exportedName);
}

function collectExportedNames(
  index: ProjectIndex,
  file: FileId,
  includeLocalFallback: boolean,
  names: Set<string>,
  visited: Set<FileId>,
): void {
  const fileKey = fileIdentityKey(file);
  if (visited.has(fileKey)) return;
  visited.add(fileKey);

  const moduleEntry = moduleFor(index, file);
  if (!moduleEntry) return;
  for (const entry of moduleEntry.exports) {
    if (entry.type === "exportStar") {
      collectExportedNames(index, entry.fromModule, includeLocalFallback, names, visited);
    } else {
      names.add(entry.exportedAs);
    }
  }
  if (includeLocalFallback) {
    for (const local of moduleEntry.locals) {
      names.add(local.localName);
    }
  }
}

export function resolveModuleExports(
  index: ProjectIndex,
  file: FileId,
  opts?: ResolveExportOptions,
): Map<string, ResolvedExport> {
  const names = new Set<string>();
  const includeLocalFallback = opts?.allowLocalFallback ?? true;
  collectExportedNames(index, file, includeLocalFallback, names, new Set<FileId>());

  const resolved = new Map<string, ResolvedExport>();
  for (const name of names) {
    const hit = resolveExport(index, file, name, opts);
    if (hit) resolved.set(name, hit);
  }
  return resolved;
}

export function resolveImported(
  index: ProjectIndex,
  imp: ImportBinding,
  exportedName: string,
  opts?: ResolveExportOptions,
): SymbolDef | { namespace: FileId } | null {
  const targetFile = typeof imp.resolved === "string" ? imp.resolved : undefined;
  if (!targetFile) return null;
  const namespace = opts?.cNamespace ?? (imp.kind === "named" ? imp.cNamespace : undefined);
  if (opts?.cNamespace && imp.kind === "named" && (imp.cNamespace ?? "ordinary") !== opts.cNamespace) return null;

  const phpRole = phpNamedImportRole(imp);
  const hit = phpRole
    ? resolvePhpExportByImportType(index, targetFile, exportedName, phpRole)
    : resolveExport(index, targetFile, exportedName, {
        ...opts,
        ...(namespace ? { cNamespace: namespace } : {}),
      });
  if (hit?.kind === "resolved") return hit.def;
  if (hit?.kind === "namespace") return { namespace: hit.file };

  // Only Java, Kotlin, and Python matter below, so a `.h` target never needs its sample read.
  const support = supportForFileWithoutHeaderSample(targetFile, index.languageExtensions);
  if (support?.id === "java" || support?.id === "kotlin") {
    const siblingHit = resolveSiblingPackageExport(index, targetFile, exportedName, support.id);
    if (siblingHit?.kind === "resolved") return siblingHit.def;
    if (siblingHit?.kind === "namespace") {
      return { namespace: siblingHit.file };
    }
  }

  if (support?.id === "python") {
    const submodule = resolvePythonSubmodule(targetFile, exportedName);
    if (submodule) return { namespace: submodule };
  }

  return null;
}
