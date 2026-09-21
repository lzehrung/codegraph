import { normalizePath } from "../paths.js";
import { listProjectFiles } from "../project-files.js";
import { mapLimitSemaphore } from "../concurrency.js";

export type LanguageProjectSymbolIndex = {
  files: string[];
  filesByPackage: Map<string, string[]>;
  filesByPackageSymbol: Map<string, Map<string, string[]>>;
};

export type DeclaredContainer = {
  name: string;
  symbols?: Iterable<string>;
};

async function listProjectLanguageFiles(projectRoot: string, patterns: string[]): Promise<string[]> {
  return await listProjectFiles(projectRoot, patterns);
}

function addProjectSymbolFile(
  index: LanguageProjectSymbolIndex,
  packageName: string,
  filePath: string,
  symbols: Set<string>,
): void {
  const packageFiles = index.filesByPackage.get(packageName) ?? [];
  packageFiles.push(filePath);
  index.filesByPackage.set(packageName, packageFiles);

  let symbolFiles = index.filesByPackageSymbol.get(packageName);
  if (!symbolFiles) {
    symbolFiles = new Map<string, string[]>();
    index.filesByPackageSymbol.set(packageName, symbolFiles);
  }
  for (const symbolName of symbols) {
    const files = symbolFiles.get(symbolName) ?? [];
    files.push(filePath);
    symbolFiles.set(symbolName, files);
  }
}

function sortProjectSymbolIndex(index: LanguageProjectSymbolIndex): void {
  for (const [packageName, files] of index.filesByPackage) {
    files.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
    index.filesByPackage.set(packageName, files);
  }
  for (const symbolFiles of index.filesByPackageSymbol.values()) {
    for (const [symbolName, files] of symbolFiles) {
      files.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
      symbolFiles.set(symbolName, files);
    }
  }
}

function mergeDeclaredContainers(containers: readonly DeclaredContainer[]): Map<string, Set<string>> {
  const merged = new Map<string, Set<string>>();
  for (const container of containers) {
    const symbols = merged.get(container.name) ?? new Set<string>();
    if (container.symbols) {
      for (const symbolName of container.symbols) symbols.add(symbolName);
    }
    merged.set(container.name, symbols);
  }
  return merged;
}

export async function buildDeclaredContainerIndex(
  projectRoot: string,
  globs: string[],
  readContainers: (filePath: string) => Promise<readonly DeclaredContainer[]>,
): Promise<LanguageProjectSymbolIndex> {
  const files = await listProjectLanguageFiles(projectRoot, globs);
  const index: LanguageProjectSymbolIndex = {
    files,
    filesByPackage: new Map<string, string[]>(),
    filesByPackageSymbol: new Map<string, Map<string, string[]>>(),
  };

  const indexEntries = await mapLimitSemaphore(files, 8, async (filePath) => {
    try {
      const containers = await readContainers(filePath);
      return { filePath, containers };
    } catch {
      // Ignore unreadable files and keep indexing the project.
      return null;
    }
  });

  for (const indexEntry of indexEntries) {
    if (!indexEntry) continue;
    for (const [containerName, symbols] of mergeDeclaredContainers(indexEntry.containers)) {
      addProjectSymbolFile(index, containerName, indexEntry.filePath, symbols);
    }
  }

  sortProjectSymbolIndex(index);
  return index;
}

export function getOrCreateProjectSymbolIndex(
  cache: Map<string, Promise<LanguageProjectSymbolIndex>>,
  projectRoot: string,
  buildIndex: () => Promise<LanguageProjectSymbolIndex>,
): Promise<LanguageProjectSymbolIndex> {
  const cached = cache.get(projectRoot);
  if (cached) return cached;
  const pending = buildIndex().catch((error) => {
    cache.delete(projectRoot);
    throw error;
  });
  cache.set(projectRoot, pending);
  return pending;
}
