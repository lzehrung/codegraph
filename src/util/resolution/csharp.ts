import fsp from "node:fs/promises";
import path from "node:path";
import {
  buildProjectSymbolIndex,
  getOrCreateProjectSymbolIndex,
  type LanguageProjectSymbolIndex,
} from "./project-symbols.js";
import { CSHARP_IDENTIFIER_SOURCE } from "../identifiers.js";

// A namespace name may be qualified (`namespace A.B { }`) and either block-scoped (closing
// `{`) or file-scoped (closing `;`). Both forms declare the same namespace for a file.
const CSHARP_NAMESPACE_DECLARATION_PATTERN = new RegExp(
  String.raw`^\s*namespace\s+(${CSHARP_IDENTIFIER_SOURCE}(?:\s*\.\s*${CSHARP_IDENTIFIER_SOURCE})*)\s*[;{]`,
  "mu",
);

type CsharpNamespaceIndexEntry = {
  packageName: string | null;
  symbols: Set<string>;
};

const csharpNamespaceFileCache = new Map<string, CsharpNamespaceIndexEntry>();
const csharpProjectNamespaceIndexCache = new Map<string, Promise<LanguageProjectSymbolIndex>>();

async function readCsharpNamespaceIndex(filePath: string): Promise<CsharpNamespaceIndexEntry> {
  const cached = csharpNamespaceFileCache.get(filePath);
  if (cached) return cached;

  const source = await fsp.readFile(filePath, "utf8");
  // Only the namespace-to-file mapping is needed, so the shared entry's symbol set stays empty
  // rather than scanning declarations no lookup consumes.
  const entry = {
    packageName: source.match(CSHARP_NAMESPACE_DECLARATION_PATTERN)?.[1] ?? null,
    symbols: new Set<string>(),
  };
  csharpNamespaceFileCache.set(filePath, entry);
  return entry;
}

async function getCsharpProjectNamespaceIndex(projectRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(
    csharpProjectNamespaceIndexCache,
    projectRoot,
    async () => await buildProjectSymbolIndex(projectRoot, ["**/*.cs", "**/*.csx"], readCsharpNamespaceIndex),
  );
}

/**
 * Every file under `projectRoot` that declares `spec` as a namespace, via either a block-scoped
 * or a file-scoped namespace declaration. Sorted by the shared project symbol index.
 */
export async function resolveCsharpNamespaceImportPaths(projectRoot: string, spec: string): Promise<string[]> {
  const projectIndex = await getCsharpProjectNamespaceIndex(projectRoot);
  const packageCandidates = projectIndex.filesByPackage.get(spec) ?? [];
  return packageCandidates.map((candidate) => path.resolve(candidate));
}

export function clearCsharpResolutionCaches(): void {
  csharpNamespaceFileCache.clear();
  csharpProjectNamespaceIndexCache.clear();
}
