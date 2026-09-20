import path from "node:path";
import { confineResolvedPath, readUtf8WithoutBom } from "../paths.js";
import { maskTrivia } from "../trivia.js";
import {
  buildDeclaredContainerIndex,
  getOrCreateProjectSymbolIndex,
  type LanguageProjectSymbolIndex,
} from "./project-symbols.js";
import { getImportableLanguageExtensions, getImportableLanguageGlobs } from "../resolution-candidates.js";

const CPP_MODULE_DECLARATION_PATTERN =
  /(?<![\w])export\s+module\s+([A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_][\w]*)*(?:\s*:\s*[A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_][\w]*)*)?)\s*;/gu;

type CppModuleIndexEntry = {
  modules: string[];
};

const cppModuleFileCache = new Map<string, CppModuleIndexEntry>();
const cppProjectModuleIndexCache = new Map<string, Promise<LanguageProjectSymbolIndex>>();

const CPP_NAMED_MODULE_SPECIFIER_PATTERN = /^[A-Za-z_][\w.]*(?::[A-Za-z_][\w.]*)?$/;

export function isCppNamedModuleSpecifier(spec: string): boolean {
  if (!spec || spec.startsWith("<") || spec.endsWith(">")) return false;
  if (spec.startsWith(".") || spec.startsWith("/") || spec.includes("/") || spec.includes("\\")) return false;
  const ext = path.extname(spec).toLowerCase();
  if (ext && getImportableLanguageExtensions("cpp").includes(ext)) return false;
  if (ext === ".h" || ext === ".c" || ext === ".i") return false;
  return CPP_NAMED_MODULE_SPECIFIER_PATTERN.test(spec);
}

export function collectCppDeclaredModules(source: string): string[] {
  const masked = maskTrivia(source, "cpp");
  const names = new Set<string>();
  for (const match of masked.matchAll(CPP_MODULE_DECLARATION_PATTERN)) {
    const moduleName = match[1]?.replace(/\s+/gu, "");
    if (!moduleName || moduleName.startsWith(":")) continue;
    names.add(moduleName);
  }
  return Array.from(names);
}

async function readCppModuleIndex(filePath: string): Promise<CppModuleIndexEntry> {
  const cached = cppModuleFileCache.get(filePath);
  if (cached) return cached;

  const source = await readUtf8WithoutBom(filePath);
  const entry = { modules: collectCppDeclaredModules(source) };
  cppModuleFileCache.set(filePath, entry);
  return entry;
}

async function getCppProjectModuleIndex(projectRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(cppProjectModuleIndexCache, projectRoot, async () =>
    buildDeclaredContainerIndex(projectRoot, getImportableLanguageGlobs("cpp"), async (filePath) => {
      const entry = await readCppModuleIndex(filePath);
      return entry.modules.map((name) => ({ name }));
    }),
  );
}

export async function resolveCppModuleImportPaths(projectRoot: string, spec: string): Promise<string[]> {
  if (!isCppNamedModuleSpecifier(spec)) return [];
  const projectIndex = await getCppProjectModuleIndex(projectRoot);
  const packageCandidates = projectIndex.filesByPackage.get(spec) ?? [];
  const confined: string[] = [];
  for (const candidate of packageCandidates) {
    const hit = await confineResolvedPath(projectRoot, candidate);
    if (hit) confined.push(hit);
  }
  return confined;
}

export async function resolveCppImportPath(projectRoot: string, spec: string): Promise<string | null> {
  const moduleFiles = await resolveCppModuleImportPaths(projectRoot, spec);
  return moduleFiles.length === 1 ? moduleFiles[0]! : null;
}

export function clearCppResolutionCaches(): void {
  cppModuleFileCache.clear();
  cppProjectModuleIndexCache.clear();
}
