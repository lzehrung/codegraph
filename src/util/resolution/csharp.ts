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
import {
  buildDeclaredContainerIndex,
  type DeclaredContainer,
  type LanguageProjectSymbolIndex,
} from "./project-symbols.js";
import { recordParserBackendDegradation } from "../../native/native-backend-report.js";
import type { BuildReport } from "../../indexer/types.js";
import type { ParsedFileContext } from "../../indexer/parse-context.js";
import { CSHARP_FILE_LOCAL_PREFIX, collectCsharpNamespaceFacts, type CsharpNamespaceFacts } from "../csharp-tree.js";
import { parseSyntaxTree } from "../syntax-tree.js";

type CsharpProjectNamespaceIndexResult = {
  index: LanguageProjectSymbolIndex;
  complete: boolean;
};

/**
 * A namespace-qualified type name found in more than one declaring file.
 * `found` is the one declaration, or the partial-type representative when every
 * part shares one owner; `parts` is then the number of declaring files, so a caller that needs every
 * part can tell it holds only one. `ambiguous` and `partial` never name a file: ambiguity
 * is proven, and `partial` means a candidate could not be read so uniqueness is
 * not proven. Callers must not fall through to the first path match.
 */
export type CsharpNamespaceTypeResolution =
  | { status: "found"; file: string; parts?: number }
  | { status: "not_found" }
  | { status: "ambiguous" }
  | { status: "partial" };

/** The namespace facts known per file during one build, from a reused module or from the file's own tree. */
const csharpNamespaceFileCache = new Map<string, CsharpNamespaceFacts>();
const csharpProjectNamespaceIndexCache = new Map<string, Promise<CsharpProjectNamespaceIndexResult>>();
const NO_CSHARP_NAMESPACE_FACTS: CsharpNamespaceFacts = { regions: [], types: [] };
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

/**
 * Gives the project scan the namespace facts a build already holds for `file`, so the scan parses nothing for
 * it. A module's facts come from its own syntax tree and depend on no other file, so they stay valid while the
 * file's content does. Call this after the build's caches are cleared and before its first resolution.
 */
export function primeCsharpNamespaceFacts(
  file: string,
  facts: CsharpNamespaceFacts,
  languageExtensions?: LanguageExtensionMap,
): void {
  csharpNamespaceFileCache.set(csharpNamespaceCacheKey(fileIdentityKey(file), languageExtensions), facts);
}

/** The namespaces `facts` declare, each with the types declared directly in it. */
function declaredContainersOf(facts: CsharpNamespaceFacts): DeclaredContainer[] {
  const symbolsByNamespace = new Map<string, Set<string>>();
  for (const region of facts.regions) {
    if (region.name && !symbolsByNamespace.has(region.name)) symbolsByNamespace.set(region.name, new Set<string>());
  }
  for (const type of facts.types) {
    const declared = type.startsWith(CSHARP_FILE_LOCAL_PREFIX) ? type.slice(CSHARP_FILE_LOCAL_PREFIX.length) : type;
    const separator = declared.lastIndexOf(".");
    if (separator > 0) symbolsByNamespace.get(declared.slice(0, separator))?.add(declared.slice(separator + 1));
  }
  return Array.from(symbolsByNamespace, ([name, symbols]) => ({ name, symbols }));
}

/**
 * The namespace facts of one file: the facts a build primed, else those of its retained tree, else those of a
 * fresh parse. `null` when its tree is unavailable, which leaves the file's declarations unknown.
 */
async function readCsharpNamespaceFacts(
  filePath: string,
  languageExtensions: LanguageExtensionMap | undefined,
  report: BuildReport | undefined,
  parsedFiles?: ReadonlyMap<string, ParsedFileContext>,
): Promise<CsharpNamespaceFacts | null> {
  const fileKey = fileIdentityKey(filePath);
  const cacheKey = csharpNamespaceCacheKey(fileKey, languageExtensions);
  const cached = csharpNamespaceFileCache.get(cacheKey);
  if (cached) return cached;

  const support = supportForFileWithoutHeaderSample(filePath, languageExtensions);
  // An active mapping can give a C# suffix to another language; such a file declares no namespace.
  if (support?.id !== "csharp") return NO_CSHARP_NAMESPACE_FACTS;
  const retained = parsedFiles?.get(fileKey);
  let tree = retained?.sup?.id === "csharp" ? retained.tree : undefined;
  if (!tree) {
    const parsed = parseSyntaxTree(await readUtf8WithoutBom(filePath), support);
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
  const facts = collectCsharpNamespaceFacts(tree);
  csharpNamespaceFileCache.set(cacheKey, facts);
  return facts;
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
      let facts: CsharpNamespaceFacts | null;
      try {
        facts = await readCsharpNamespaceFacts(filePath, languageExtensions, report, parsedFiles);
      } catch {
        complete = false;
        return [];
      }
      if (!facts) {
        complete = false;
        return [];
      }
      return declaredContainersOf(facts);
    })
      .then((index) => ({ index, complete }))
      .catch((error: unknown) => {
        csharpProjectNamespaceIndexCache.delete(cacheKey);
        throw error;
      });
    csharpProjectNamespaceIndexCache.set(cacheKey, pending);
  }
  return await pending;
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
  const selected = selectUniqueCsharpNamespaceTypeFile(
    confined,
    namespaceLookup,
    normalizedType,
    languageExtensions,
    parsedFiles,
  );
  return selected.status === "found" ? { ...selected, parts: confined.length } : selected;
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
