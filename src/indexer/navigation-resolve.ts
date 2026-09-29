import path from "node:path";
import { supportForFileWithoutHeaderSample } from "../languages.js";
import { languageHasDeclarationVisibility } from "./declaration-visibility.js";
import type { FileId } from "../types.js";
import { foldPhpIdentifierCase, normalizeCsharpIdentifier, normalizeCsharpQualifiedName } from "../util/identifiers.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";
import { getCompilationUnitPeers, IMPLICIT_UNIT_LANGUAGES, isUnitBareNameVisible } from "./compilation-units.js";
import { phpNamedImportRole } from "./import-types.js";
import { resolvePythonSubmoduleExact } from "../util/resolution/python.js";
import { PHP_CLASS_LIKE_KINDS } from "./php-namespace-symbols.js";
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

const moduleNameLookups = new WeakMap<ProjectIndex, Map<string, ModuleNameLookup>>();

export type ResolveExportOptions = {
  preferredKind?: SymbolKind;
  allowLocalFallback?: boolean;
  cNamespace?: "tag" | "ordinary";
  /** Source position for implicit C# namespace lookup in the initial file. */
  referenceIndex?: number;
};

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
): ResolvedExport | null {
  const peers = getCompilationUnitPeers(index, targetFile);
  if (!peers.complete) return null;
  const targetFileKey = fileIdentityKey(targetFile);
  const matches: ResolvedExport[] = [];
  for (const peerFile of peers.files) {
    if (fileIdentityKey(peerFile) === targetFileKey) continue;
    const hit = resolveExport(index, peerFile, exportedName);
    if (hit && !matches.some((candidate) => sameResolvedExport(index, candidate, hit))) {
      matches.push(hit);
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function declaresMemberKind(def: SymbolDef): boolean {
  return def.kind === SymbolKind.Class || def.kind === SymbolKind.Interface || def.kind === SymbolKind.TypeAlias;
}

/**
 * A default-export wrapper keeps `SymbolKind.Default` so the export name stays `default`.
 * Member lookup needs the class, interface, or type alias that wrapper was copied from.
 */
export function memberContainerForDefinition(index: ProjectIndex, def: SymbolDef): SymbolDef | undefined {
  if (declaresMemberKind(def)) return def;
  if (def.kind !== SymbolKind.Default) return undefined;
  const moduleEntry = index.byFile.get(fileIdentityKey(def.file));
  if (!moduleEntry) return undefined;
  const sameRange = moduleEntry.locals.filter(
    (local) =>
      declaresMemberKind(local) &&
      local.range.start.line === def.range.start.line &&
      local.range.start.column === def.range.start.column,
  );
  if (sameRange.length === 1) return sameRange[0];
}

/** The export entry that proves a direct CommonJS or TypeScript module value, whatever its public name. */
export function directModuleValueEntry(moduleEntry: ModuleIndex): Extract<ExportEntry, { type: "local" }> | undefined {
  return moduleEntry.exports.find(
    (entry): entry is Extract<ExportEntry, { type: "local" }> =>
      entry.type === "local" && (entry.mechanism === "cjs-module-value" || entry.mechanism === "ts-export-assignment"),
  );
}

/**
 * `require()` and `import x = require()` return a proven direct `module.exports = X` or
 * TypeScript `export = X` value. A default export accompanied by named exports instead returns
 * a namespace object, including non-local and star re-exports.
 */
export function cjsRequireValueBinding(index: ProjectIndex, targetFile: FileId): SymbolDef | undefined {
  const moduleEntry = index.byFile.get(fileIdentityKey(targetFile));
  const directValue = moduleEntry && directModuleValueEntry(moduleEntry);
  if (directValue) return memberContainerForDefinition(index, directValue.target) ?? directValue.target;

  const resolved = resolveExport(index, targetFile, "default");
  if (resolved?.kind !== "resolved") return undefined;
  const hasNamedExport = moduleEntry?.exports.some((entry) => {
    if (entry.type === "exportStar") return !entry.typeOnly;
    if (entry.type === "local") return entry.exportedAs !== "default" && !entry.target.isMember;
    return entry.exportedAs !== "default" && !entry.typeOnly;
  });
  if (hasNamedExport) return undefined;
  return memberContainerForDefinition(index, resolved.def) ?? resolved.def;
}

type FileEdgeTargets = { edges: ProjectIndex["graph"]["edges"]; length: number; targets: Map<string, FileId> };

const fileEdgeTargetsCache = new WeakMap<ProjectIndex, FileEdgeTargets>();

/** First resolved file target per importer and raw specifier; rebuilt when the edge list changes. */
function fileEdgeTargetsFor(index: ProjectIndex): ReadonlyMap<string, FileId> {
  const edges = index.graph.edges;
  const cached = fileEdgeTargetsCache.get(index);
  if (cached && cached.edges === edges && cached.length === edges.length) return cached.targets;
  const targets = new Map<string, FileId>();
  for (const edge of edges) {
    if (edge.to.type !== "file") continue;
    const key = `${fileIdentityKey(edge.from)}\0${edge.raw}`;
    if (!targets.has(key)) targets.set(key, edge.to.path);
  }
  fileEdgeTargetsCache.set(index, { edges, length: edges.length, targets });
  return targets;
}

/**
 * A member of the module a `typeof import("spec")` receiver holds, resolved through the file
 * dependency edge the index recorded for that specifier.
 */
export function resolveImportTypeMember(
  index: ProjectIndex,
  fromFile: FileId,
  specifier: string,
  member: string,
): SymbolDef | null {
  const target = fileEdgeTargetsFor(index).get(`${fileIdentityKey(fromFile)}\0${specifier}`);
  if (!target) return null;
  const hit = resolveExport(index, target, member);
  return hit?.kind === "resolved" ? hit.def : null;
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
    const csharpFile = supportForFileWithoutHeaderSample(normalizedFile, index.languageExtensions)?.id === "csharp";
    // A dotted name is a namespace path even when the caller has no source position
    // (`using PT = N.Inner.Point` resolves through the bound file, not a use site).
    // A bare name still needs a source position before namespace visibility applies.
    const filtersUseNamespace =
      csharpFile && (referenceIndex !== undefined || name.includes(".") || name.startsWith("global::"));
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
              ...(referenceIndex !== undefined ? { useIndex: referenceIndex } : {}),
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
              ...(referenceIndex !== undefined ? { useIndex: referenceIndex } : {}),
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
    for (const preferredKind of PHP_CLASS_LIKE_KINDS) {
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

const csharpNamespaceImportDirectoryFiles = new WeakMap<ProjectIndex, Map<string, FileId[]>>();

function csharpNamespaceImportKey(namespaceName: string, boundFile: string): string {
  return `${normalizeCsharpQualifiedName(namespaceName)}\u0000${fileIdentityKey(boundFile)}`;
}

/**
 * For each C# `using N;` binding (namespace and bound file), one declaring file per directory.
 * The file graph links the directive to every file that declares `N` within the importer's
 * project, and a qualified lookup from one file reaches the rest of its directory, so one file
 * per directory covers every declaration of `N`. Built once per index.
 */
function csharpNamespaceImportDirectories(index: ProjectIndex): Map<string, FileId[]> {
  const cached = csharpNamespaceImportDirectoryFiles.get(index);
  if (cached) return cached;
  const edgesByImporter = new Map<string, Map<string, Map<string, FileId>>>();
  for (const edge of index.graph.edges) {
    if (edge.to.type !== "file") continue;
    if (supportForFileWithoutHeaderSample(edge.to.path, index.languageExtensions)?.id !== "csharp") continue;
    const importerKey = fileIdentityKey(edge.from);
    let byRaw = edgesByImporter.get(importerKey);
    if (!byRaw) edgesByImporter.set(importerKey, (byRaw = new Map()));
    const raw = normalizeCsharpQualifiedName(edge.raw);
    let byDirectory = byRaw.get(raw);
    if (!byDirectory) byRaw.set(raw, (byDirectory = new Map()));
    const directoryKey = fileIdentityKey(path.posix.dirname(normalizePath(edge.to.path)));
    if (!byDirectory.has(directoryKey)) byDirectory.set(directoryKey, edge.to.path);
  }
  const directories = new Map<string, Map<string, FileId>>();
  for (const mod of index.byFile.values()) {
    for (const imp of mod.imports) {
      if (imp.kind !== "star" || imp.staticMembersOf || typeof imp.resolved !== "string") continue;
      if (supportForFileWithoutHeaderSample(imp.resolved, index.languageExtensions)?.id !== "csharp") continue;
      const key = csharpNamespaceImportKey(imp.from, imp.resolved);
      let files = directories.get(key);
      if (!files) directories.set(key, (files = new Map()));
      const boundDirectory = fileIdentityKey(path.posix.dirname(normalizePath(imp.resolved)));
      if (!files.has(boundDirectory)) files.set(boundDirectory, imp.resolved);
      const targets = edgesByImporter.get(fileIdentityKey(mod.file))?.get(normalizeCsharpQualifiedName(imp.from));
      for (const [directoryKey, file] of targets ?? []) if (!files.has(directoryKey)) files.set(directoryKey, file);
    }
  }
  const result = new Map<string, FileId[]>();
  for (const [key, files] of directories) result.set(key, [...files.values()]);
  csharpNamespaceImportDirectoryFiles.set(index, result);
  return result;
}

/**
 * A name imported by C# `using N;`, looked up as `N.Name` from one declaring file per
 * directory. Distinct declarations (other than parts of one partial type) are ambiguous.
 */
function resolveCsharpNamespaceImport(
  index: ProjectIndex,
  imp: Extract<ImportBinding, { kind: "star" }>,
  boundFile: string,
  lookupName: string,
  opts: ResolveExportOptions | undefined,
): SymbolDef | { namespace: FileId } | null {
  const files = csharpNamespaceImportDirectories(index).get(csharpNamespaceImportKey(imp.from, boundFile)) ?? [
    boundFile,
  ];
  const matches: SymbolDef[] = [];
  let namespaceHit: FileId | undefined;
  for (const file of files) {
    const hit = resolveExport(index, file, lookupName, opts);
    if (hit?.kind === "namespace") namespaceHit ??= hit.file;
    if (hit?.kind !== "resolved" || matches.some((candidate) => sameSymbolDef(index, candidate, hit.def))) continue;
    matches.push(hit.def);
  }
  const unique = coalesceEquivalentCsharpPartialExports(index, matches);
  if (unique.length === 1) return unique[0]!;
  if (unique.length) return null;
  return namespaceHit ? { namespace: namespaceHit } : null;
}

/**
 * A C# namespace-qualified type name (`N.Type`) used in `mod`. Qualified export lookup from the
 * use file covers its own directory; a `using N;` in the file also reaches every other directory
 * that declares `N`, as the unqualified name does.
 */
export function resolveCsharpQualifiedName(
  index: ProjectIndex,
  mod: ModuleIndex,
  qualifiedName: string,
  referenceIndex: number,
): ResolvedExport | null {
  const direct = resolveExport(index, mod.file, qualifiedName, { referenceIndex });
  if (direct) return direct;
  const separator = qualifiedName.lastIndexOf(".");
  if (separator <= 0) return null;
  const namespaceName = normalizeCsharpQualifiedName(qualifiedName.slice(0, separator)).replace(/^global::/u, "");
  const typeName = qualifiedName.slice(separator + 1);
  for (const imp of mod.imports) {
    if (imp.kind !== "star" || imp.staticMembersOf || typeof imp.resolved !== "string") continue;
    if (normalizeCsharpQualifiedName(imp.from).replace(/^global::/u, "") !== namespaceName) continue;
    const hit = resolveImported(index, imp, typeName);
    if (!hit) return null;
    return "namespace" in hit ? { kind: "namespace", file: hit.namespace } : { kind: "resolved", def: hit };
  }
  return null;
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
  // A C# `using PT = N.Inner.Point` stores the namespace in `from` and the type in
  // `imported`. A bare `Point` lookup is an implicit compilation-unit search, so a peer
  // `N.Point` is the only bare-visible match when this file also declares outer `N`.
  // The alias names one namespace, and that qualified name is what every consumer resolves.
  const support = supportForFileWithoutHeaderSample(targetFile, index.languageExtensions);
  const lookupName = support?.id === "csharp" ? csharpImportLookupName(imp, exportedName) : exportedName;
  if (support?.id === "csharp" && imp.kind === "star" && !imp.staticMembersOf) {
    return resolveCsharpNamespaceImport(index, imp, targetFile, lookupName, {
      ...opts,
      ...(namespace ? { cNamespace: namespace } : {}),
    });
  }
  const hit = phpRole
    ? resolvePhpExportByImportType(index, targetFile, exportedName, phpRole)
    : resolveExport(index, targetFile, lookupName, {
        ...opts,
        ...(namespace ? { cNamespace: namespace } : {}),
      });
  if (hit?.kind === "resolved") return hit.def;
  if (hit?.kind === "namespace") return { namespace: hit.file };

  if (imp.kind === "default" && exportedName === "default") {
    const moduleEntry = moduleFor(index, targetFile);
    const directValue = moduleEntry && directModuleValueEntry(moduleEntry);
    if (directValue) return directValue.target;
  }

  // Only Java, Kotlin, and Python matter below, so a `.h` target never needs its sample read.
  if (support?.id === "java" || support?.id === "kotlin") {
    const siblingHit = resolveSiblingPackageExport(index, targetFile, exportedName);
    if (siblingHit?.kind === "resolved") return siblingHit.def;
    if (siblingHit?.kind === "namespace") {
      return { namespace: siblingHit.file };
    }
  }

  // A named `from pkg import child` may load child as a submodule. A plain
  // namespace import of pkg cannot gain child solely because child.py exists.
  if (support?.id === "python" && imp.kind === "named" && imp.mechanism === "python") {
    const submodule = resolvePythonSubmoduleExact(targetFile, exportedName);
    if (submodule) return { namespace: submodule };
  }

  return null;
}
