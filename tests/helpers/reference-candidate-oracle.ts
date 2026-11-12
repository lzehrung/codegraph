import path from "node:path";
import { supportForFileWithoutHeaderSample } from "../../src/languages.js";
import { isJsTsLanguage } from "../../src/languages/js-family.js";
import { getCompilationUnitPeers, getPackageDeclarationName } from "../../src/indexer/compilation-units.js";
import { isJvmPackageSymbolVisible } from "../../src/indexer/declaration-visibility.js";
import {
  cppCanonicalStructuralExport,
  csharpNamespaceImportTargetsDefinition,
  importCanReferenceDefinition,
  moduleExportProbeNames,
  pythonParentPackageNamespacePaths,
} from "../../src/indexer/navigation-references.js";
import { hasNamespaceReexport, resolveExport } from "../../src/indexer/navigation-resolve.js";
import { candidateFilesImportingTarget } from "../../src/indexer/reference-candidates.js";
import { sameDef } from "../../src/indexer/reference-context.js";
import { withCsharpGlobalUsings } from "../../src/indexer/csharp-global-usings.js";
import { csharpGlobalUsingReferenceMatcher } from "../../src/indexer/reference-query-index.js";
import type { ProjectIndex, SymbolDef } from "../../src/indexer/types.js";
import { JAVA_UNICODE_ESCAPE_BLOOM_TOKEN } from "../../src/util/bloom-filter.js";
import { fileIdentityKey } from "../../src/util/paths.js";

/**
 * Every module that exports `def`, found by testing every module of the index. This is the enumeration that
 * `getCachedReferenceCandidateFiles` narrows to the modules that can reach the definition.
 */
function exportingFilesByFullScan(
  index: ProjectIndex,
  def: SymbolDef,
  exportedNames: readonly string[],
  languageId: string,
): string[] {
  const files = new Map<string, string>([[fileIdentityKey(def.file), def.file]]);
  const namespaceLinks: Array<{ sourceFile: string; exportedAs: string; targetFile: string }> = [];
  const mayLinkNamespaces = hasNamespaceReexport(index);
  for (const moduleIndex of index.byFile.values()) {
    if (!moduleIndex.exports.length) continue;
    const fileId = moduleIndex.file;
    const visibleExportNames = moduleExportProbeNames(index, moduleIndex, exportedNames);
    if (mayLinkNamespaces) {
      for (const exportedName of visibleExportNames) {
        const visible = resolveExport(index, fileId, exportedName, { allowLocalFallback: false });
        if (visible?.kind !== "namespace") continue;
        namespaceLinks.push({ sourceFile: fileId, exportedAs: exportedName, targetFile: visible.file });
      }
    }
    if (fileIdentityKey(fileId) === fileIdentityKey(def.file)) continue;
    for (const exportedName of visibleExportNames) {
      const resolved = resolveExport(index, fileId, exportedName);
      if (resolved?.kind === "resolved" && sameDef(resolved.def, def, index.languageExtensions)) {
        files.set(fileIdentityKey(fileId), fileId);
        break;
      }
      if (cppCanonicalStructuralExport(index, fileId, exportedName, def, languageId)) {
        files.set(fileIdentityKey(fileId), fileId);
        break;
      }
    }
    if (
      moduleIndex.exports.some(
        (entry) =>
          entry.type === "reexport" &&
          exportedNames.includes(entry.sourceSpecifier) &&
          resolveExport(index, entry.fromModule, entry.sourceSpecifier)?.kind !== "resolved",
      )
    ) {
      files.set(fileIdentityKey(fileId), fileId);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const link of namespaceLinks) {
      const sourceKey = fileIdentityKey(link.sourceFile);
      if (files.has(sourceKey) || !files.has(fileIdentityKey(link.targetFile))) continue;
      const visible = resolveExport(index, link.sourceFile, link.exportedAs, { allowLocalFallback: false });
      if (visible?.kind !== "namespace" || fileIdentityKey(visible.file) !== fileIdentityKey(link.targetFile)) continue;
      files.set(sourceKey, link.sourceFile);
      grew = true;
    }
  }
  return [...files.values()];
}

/**
 * The reference candidate files of `def` found by testing every module's imports, the way candidate selection did before
 * it used reverse indexes. `getCachedReferenceCandidateFiles` must return exactly this list for a definition that is
 * not PHP.
 */
export function referenceCandidatesByFullScan(
  index: ProjectIndex,
  def: SymbolDef,
  exportedNames: readonly string[],
  languageId: string,
): string[] {
  const definitionKey = fileIdentityKey(def.file);
  const candidates = new Map<string, string>();
  if (def.isMember) candidates.set(definitionKey, def.file);
  for (const unitPeer of getCompilationUnitPeers(
    index,
    def.file,
    languageId === "csharp" ? { csharpQualifiedName: true } : undefined,
  ).files) {
    if (fileIdentityKey(unitPeer) !== definitionKey) candidates.set(fileIdentityKey(unitPeer), unitPeer);
  }
  // Compilation globals can reach types and qualified member uses without a file-local import edge.
  const globalUsingMatches = languageId === "csharp" ? csharpGlobalUsingReferenceMatcher(index, def) : undefined;
  if (globalUsingMatches) {
    for (const indexedModule of index.byFile.values()) {
      if (fileIdentityKey(indexedModule.file) === definitionKey) continue;
      const moduleIndex = withCsharpGlobalUsings(index, indexedModule);
      if (moduleIndex.imports.some(globalUsingMatches)) {
        candidates.set(fileIdentityKey(moduleIndex.file), moduleIndex.file);
      }
    }
  }
  const exportingFileIds = exportingFilesByFullScan(index, def, exportedNames, languageId);
  const exportingFiles = new Set(exportingFileIds.map((file) => fileIdentityKey(file)));
  for (const fileId of exportingFileIds) {
    if (fileIdentityKey(fileId) !== definitionKey) candidates.set(fileIdentityKey(fileId), fileId);
  }

  // The files a module-wide scan would offer: importers of an exporting file, then any other module with a star,
  // namespace, or Python/JavaScript-family named import that can reach the definition.
  const offered = new Map<string, string>();
  for (const exportingFile of exportingFileIds) {
    for (const importingFile of candidateFilesImportingTarget(index.referenceCandidates, exportingFile) ?? []) {
      offered.set(fileIdentityKey(importingFile), importingFile);
    }
  }
  for (const moduleIndex of index.byFile.values()) {
    const fileId = moduleIndex.file;
    if (fileIdentityKey(fileId) === definitionKey || offered.has(fileIdentityKey(fileId))) continue;
    if (
      moduleIndex.imports.some(
        (imp) =>
          (languageId === "csharp" && csharpNamespaceImportTargetsDefinition(index, imp, def)) ||
          ((imp.kind === "star" ||
            imp.kind === "namespace" ||
            (imp.kind === "named" && (imp.mechanism === "python" || isJsTsLanguage(languageId)))) &&
            importCanReferenceDefinition(index, imp, def, exportedNames, languageId)),
      )
    ) {
      offered.set(fileIdentityKey(fileId), fileId);
    }
  }
  for (const fileId of offered.values()) {
    if (fileIdentityKey(fileId) === definitionKey) continue;
    const moduleIndex = index.byFile.get(fileIdentityKey(fileId));
    if (!moduleIndex) continue;
    if (
      moduleIndex.imports.some((imp) => {
        if (languageId === "csharp" && csharpNamespaceImportTargetsDefinition(index, imp, def)) return true;
        if (typeof imp.resolved !== "string") return false;
        return (
          exportingFiles.has(fileIdentityKey(imp.resolved)) ||
          importCanReferenceDefinition(index, imp, def, exportedNames, languageId)
        );
      })
    ) {
      candidates.set(fileIdentityKey(fileId), fileId);
    }
  }

  if (languageId === "java" || languageId === "kotlin") {
    const packageName = getPackageDeclarationName(index, def.file, languageId);
    const rootName = packageName?.split(".")[0];
    const exported =
      def.isMember ||
      index.byFile
        .get(definitionKey)
        ?.exports.some((entry) => entry.type === "local" && sameDef(entry.target, def, index.languageExtensions));
    if (rootName && exported) {
      for (const moduleIndex of index.byFile.values()) {
        const support = supportForFileWithoutHeaderSample(moduleIndex.file, index.languageExtensions);
        if (support?.id !== "java" && support?.id !== "kotlin") continue;
        const samePackage = getPackageDeclarationName(index, moduleIndex.file, support.id) === packageName;
        if (!isJvmPackageSymbolVisible(def, languageId, support.id, samePackage)) continue;
        const fileKey = fileIdentityKey(moduleIndex.file);
        if (candidates.has(fileKey)) continue;
        const filter = index.bloomFilters?.get(fileKey);
        const rootProbe = support.normalizeIdentifier(rootName);
        const nameProbe = support.normalizeIdentifier(def.localName);
        if (
          !filter ||
          (filter.mightContain(rootProbe) && filter.mightContain(nameProbe)) ||
          (support.id === "java" && filter.mightContain(JAVA_UNICODE_ESCAPE_BLOOM_TOKEN))
        ) {
          candidates.set(fileKey, moduleIndex.file);
        }
      }
    }
  }
  if (languageId === "python" && !def.isMember) {
    for (const moduleIndex of index.byFile.values()) {
      if (pythonParentPackageNamespacePaths(moduleIndex, def.file).length) {
        candidates.set(fileIdentityKey(moduleIndex.file), moduleIndex.file);
      }
    }
  }
  return [...candidates.values()].sort((left, right) => left.localeCompare(right));
}

/** The export names `findReferences` probes for `def`: the names its own module exports it under. */
export function exportedNamesOf(index: ProjectIndex, def: SymbolDef): string[] {
  const names: string[] = [];
  for (const entry of index.byFile.get(fileIdentityKey(def.file))?.exports ?? []) {
    if (
      entry.type === "local" &&
      sameDef(entry.target, def, index.languageExtensions) &&
      !names.includes(entry.exportedAs)
    ) {
      names.push(entry.exportedAs);
    }
  }
  return names;
}

/** Path of `file` relative to `root`, for failure messages. */
export function relativeTo(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, "/");
}
