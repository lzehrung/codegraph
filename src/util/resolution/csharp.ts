import {
  languageExtensionPatterns,
  normalizeLanguageExtensions,
  supportForFileWithoutHeaderSample,
  type LanguageExtensionMap,
} from "../../languages.js";
import { confineResolvedPath, fileIdentityKey, readUtf8WithoutBom } from "../paths.js";
import { normalizeCsharpIdentifier, normalizeCsharpQualifiedName } from "../identifiers.js";
import { getImportableLanguageGlobs } from "../resolution-candidates.js";
import { selectUniqueCsharpNamespaceTypeFile } from "../../indexer/shared-owner-identity.js";
import { CSHARP_PACKAGE_MANIFEST_NAMES, resolveNearestManifestRoot } from "./files.js";
import { buildDeclaredContainerIndex, type LanguageProjectSymbolIndex } from "./project-symbols.js";
import { recordParserBackendDegradation } from "../../native/native-backend-report.js";
import type { BuildReport } from "../../indexer/types.js";
import type { ParsedFileContext } from "../../indexer/parse-context.js";
import type { SyntaxTreeLike } from "../../languages/types.js";
import { collectCsharpNamespaceFacts, parseCsharpSyntaxTree } from "../csharp-tree.js";

type CsharpNamespaceIndexEntry = {
  namespaces: string[];
  symbolsByNamespace: ReadonlyMap<string, ReadonlySet<string>>;
};

type CsharpProjectNamespaceIndexResult = {
  index: LanguageProjectSymbolIndex;
  complete: boolean;
};

/**
 * A namespace-qualified type name found in more than one declaring file.
 * `found` is the one declaration, or the partial-type representative when every
 * part shares one owner. `ambiguous` and `partial` never name a file: ambiguity
 * is proven, and `partial` means a candidate could not be read so uniqueness is
 * not proven. Callers must not fall through to the first path match.
 */
export type CsharpNamespaceTypeResolution =
  | { status: "found"; file: string }
  | { status: "not_found" }
  | { status: "ambiguous" }
  | { status: "partial" };

const csharpNamespaceFileCache = new Map<string, CsharpNamespaceIndexEntry>();
const csharpProjectNamespaceIndexCache = new Map<string, Promise<CsharpProjectNamespaceIndexResult>>();
function csharpNamespaceCacheKey(anchor: string, languageExtensions?: LanguageExtensionMap): string {
  const mappings = Object.entries(normalizeLanguageExtensions(languageExtensions) ?? {});
  return anchor + "\0" + JSON.stringify(mappings);
}
/** The built-in C# suffixes plus every extension the active mapping assigns to C#. */
function csharpCandidateGlobs(languageExtensions: LanguageExtensionMap | undefined): string[] {
  const csharpMappings = Object.fromEntries(
    Object.entries(normalizeLanguageExtensions(languageExtensions) ?? {}).filter(
      ([, languageId]) => languageId === "csharp",
    ),
  );
  return [...getImportableLanguageGlobs("csharp"), ...languageExtensionPatterns(csharpMappings)];
}
function collectCsharpNamespaceIndex(
  source: string,
  filePath: string,
  languageExtensions: LanguageExtensionMap | undefined,
  report: BuildReport | undefined,
  retainedTree?: SyntaxTreeLike,
): CsharpNamespaceIndexEntry | null {
  const support = supportForFileWithoutHeaderSample(filePath, languageExtensions);
  if (support?.id !== "csharp") {
    return { namespaces: [], symbolsByNamespace: new Map() };
  }
  let tree = retainedTree;
  if (!tree) {
    const parsed = parseCsharpSyntaxTree(source, support);
    if (!parsed.tree) {
      recordParserBackendDegradation(report, {
        file: slashPath(filePath),
        languageId: support.id,
        ...(parsed.fallbackReason ? { nativeFallbackReason: parsed.fallbackReason } : {}),
        ...(parsed.error ? { nativeError: parsed.error } : {}),
      });
      return null;
    }
    tree = parsed.tree;
  }
  const facts = collectCsharpNamespaceFacts(tree, source.length);
  return {
    namespaces: facts.namespaces,
    symbolsByNamespace: facts.symbolsByNamespace,
  };
}

async function readCsharpNamespaceIndex(
  filePath: string,
  languageExtensions: LanguageExtensionMap | undefined,
  report: BuildReport | undefined,
  parsedFiles?: ReadonlyMap<string, ParsedFileContext>,
): Promise<CsharpNamespaceIndexEntry | null> {
  const fileKey = fileIdentityKey(filePath);
  const cacheKey = csharpNamespaceCacheKey(fileKey, languageExtensions);
  const cached = csharpNamespaceFileCache.get(cacheKey);
  if (cached) return cached;

  const retained = parsedFiles?.get(fileKey);
  const source = retained?.source ?? (await readUtf8WithoutBom(filePath));
  const tree = retained?.sup?.id === "csharp" ? retained.tree : undefined;
  const entry = collectCsharpNamespaceIndex(source, filePath, languageExtensions, report, tree);
  if (entry) csharpNamespaceFileCache.set(cacheKey, entry);
  return entry;
}

async function getCsharpProjectNamespaceIndex(
  indexRoot: string,
  languageExtensions: LanguageExtensionMap | undefined = undefined,
  report: BuildReport | undefined = undefined,
  parsedFiles?: ReadonlyMap<string, ParsedFileContext>,
): Promise<CsharpProjectNamespaceIndexResult> {
  const cacheKey = csharpNamespaceCacheKey(indexRoot, languageExtensions);
  let pending = csharpProjectNamespaceIndexCache.get(cacheKey);
  if (!pending) {
    let complete = true;
    pending = buildDeclaredContainerIndex(indexRoot, csharpCandidateGlobs(languageExtensions), async (filePath) => {
      let entry: CsharpNamespaceIndexEntry | null;
      try {
        entry = await readCsharpNamespaceIndex(filePath, languageExtensions, report, parsedFiles);
      } catch {
        complete = false;
        return [];
      }
      if (!entry) {
        complete = false;
        return [];
      }
      return entry.namespaces.map((name) => {
        const symbols = entry.symbolsByNamespace.get(name);
        return symbols ? { name, symbols } : { name };
      });
    })
      .then((index) => ({ index, complete }))
      .catch((error: unknown) => {
        csharpProjectNamespaceIndexCache.delete(cacheKey);
        throw error;
      });
    csharpProjectNamespaceIndexCache.set(cacheKey, pending);
  }
  const result = await pending;
  if (!result.complete && csharpProjectNamespaceIndexCache.get(cacheKey) === pending) {
    csharpProjectNamespaceIndexCache.delete(cacheKey);
  }
  return result;
}

/**
 * Every file under the nearest C# project manifest (or `projectRoot` when none
 * exists) that declares `spec` as a namespace, via either a block-scoped or a
 * file-scoped namespace declaration. Sorted by the shared project symbol index.
 */
export async function resolveCsharpNamespaceImportPaths(
  projectRoot: string,
  spec: string,
  fromFile: string,
  languageExtensions?: LanguageExtensionMap,
  report?: BuildReport,
  parsedFiles?: ReadonlyMap<string, ParsedFileContext>,
): Promise<string[]> {
  const indexRoot = await resolveNearestManifestRoot(projectRoot, fromFile, CSHARP_PACKAGE_MANIFEST_NAMES);
  const projectIndex = await getCsharpProjectNamespaceIndex(indexRoot, languageExtensions, report, parsedFiles);
  const normalized = normalizeCsharpQualifiedName(spec);
  const lookup = normalized.startsWith("global::") ? normalized.slice("global::".length) : normalized;
  if (!lookup) return [];
  const packageCandidates = projectIndex.index.filesByPackage.get(lookup) ?? [];
  const confined: string[] = [];
  for (const candidate of packageCandidates) {
    const hit = await confineResolvedPath(projectRoot, candidate);
    if (hit && isActiveCsharpFile(hit, languageExtensions)) confined.push(hit);
  }
  return confined;
}

function slashPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/**
 * Candidate discovery uses C# filename globs. An active extension mapping can assign one of those
 * suffixes to another language, and such a file is never a C# namespace or type target.
 */
function isActiveCsharpFile(file: string, languageExtensions: LanguageExtensionMap | undefined): boolean {
  return !languageExtensions || supportForFileWithoutHeaderSample(file, languageExtensions)?.id === "csharp";
}

async function confineCsharpTypeFiles(
  projectRoot: string,
  files: readonly string[],
  languageExtensions: LanguageExtensionMap | undefined,
): Promise<string[]> {
  const confined: string[] = [];
  const seen = new Set<string>();
  for (const candidate of files) {
    const hit = await confineResolvedPath(projectRoot, candidate);
    if (!hit || !isActiveCsharpFile(hit, languageExtensions)) continue;
    const normalized = slashPath(hit);
    const key = fileIdentityKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    confined.push(normalized);
  }
  return confined;
}

/**
 * The file that declares `typeName` directly in `namespaceName`.
 * One file binds immediately. Several files bind only when partial-type ownership
 * collapses them to one representative; otherwise the result is `ambiguous` or
 * `partial` and never the first path.
 */
export async function resolveCsharpNamespaceTypePath(
  projectRoot: string,
  namespaceName: string,
  typeName: string,
  fromFile: string,
  languageExtensions?: LanguageExtensionMap,
  report?: BuildReport,
  parsedFiles?: ReadonlyMap<string, ParsedFileContext>,
): Promise<CsharpNamespaceTypeResolution> {
  const normalizedNamespace = normalizeCsharpQualifiedName(namespaceName);
  const namespaceLookup = normalizedNamespace.startsWith("global::")
    ? normalizedNamespace.slice("global::".length)
    : normalizedNamespace;
  const normalizedType = normalizeCsharpIdentifier(typeName);
  if (!namespaceLookup || !normalizedType) return { status: "not_found" };

  const indexRoot = await resolveNearestManifestRoot(projectRoot, fromFile, CSHARP_PACKAGE_MANIFEST_NAMES);
  const projectIndexResult = await getCsharpProjectNamespaceIndex(indexRoot, languageExtensions, report, parsedFiles);
  if (!projectIndexResult.complete) return { status: "partial" };
  const files = projectIndexResult.index.filesByPackageSymbol.get(namespaceLookup)?.get(normalizedType) ?? [];
  const confined = await confineCsharpTypeFiles(projectRoot, files, languageExtensions);
  if (confined.length === 0) return { status: "not_found" };
  if (confined.length === 1) return { status: "found", file: confined[0]! };
  return selectUniqueCsharpNamespaceTypeFile(confined, namespaceLookup, normalizedType);
}

/** Resolves a C# namespace-qualified type from its source name. */
export async function resolveCsharpDottedTypeImportPath(
  projectRoot: string,
  spec: string,
  fromFile: string,
  languageExtensions?: LanguageExtensionMap,
  report?: BuildReport,
  parsedFiles?: ReadonlyMap<string, ParsedFileContext>,
): Promise<CsharpNamespaceTypeResolution> {
  const normalized = normalizeCsharpQualifiedName(spec);
  if (normalized.includes("<") || normalized.includes(">")) return { status: "not_found" };
  const body = normalized.startsWith("global::") ? normalized.slice("global::".length) : normalized;
  const parts = body.split(".").filter(Boolean);
  if (parts.length < 2) return { status: "not_found" };
  const typeName = parts[parts.length - 1]!;
  const namespaceName = parts.slice(0, -1).join(".");
  return await resolveCsharpNamespaceTypePath(
    projectRoot,
    namespaceName,
    typeName,
    fromFile,
    languageExtensions,
    report,
    parsedFiles,
  );
}

export function clearCsharpResolutionCaches(): void {
  csharpNamespaceFileCache.clear();
  csharpProjectNamespaceIndexCache.clear();
}
