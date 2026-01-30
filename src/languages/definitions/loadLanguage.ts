import path from "node:path";
import { createRequire } from "node:module";
import type { Language } from "tree-sitter";

type NodeGypBuild = (root: string) => Language;
type NodeTypeInfoHolder = { nodeTypeInfo?: unknown };
type TypeScriptGrammars = {
  typescript: Language;
  tsx: Language;
};

const require = createRequire(import.meta.url);
const languageCache = new Map<string, Language>();
let typescriptCache: TypeScriptGrammars | null = null;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractDefaultExport(value: unknown): unknown {
  if (isObject(value) && "default" in value) {
    return value.default;
  }
  return value;
}

function shouldFallbackToBinding(error: unknown): boolean {
  if (isObject(error) && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && code === "ERR_REQUIRE_ESM") return true;
  }
  if (error instanceof Error) {
    return (
      error.message.includes("require() cannot be used on an ESM graph") ||
      error.message.includes("Top-level await is currently not supported")
    );
  }
  return false;
}

function loadBindingFromPackage(packageName: string): Language {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageRoot = path.dirname(packageJsonPath);
  const packageRequire = createRequire(packageJsonPath);
  const nodeGypBuild = packageRequire("node-gyp-build") as NodeGypBuild;
  const binding = nodeGypBuild(packageRoot);
  try {
    const nodeTypes = packageRequire(
      path.join(packageRoot, "src", "node-types.json"),
    ) as unknown;
    if (isObject(binding)) {
      (binding as NodeTypeInfoHolder).nodeTypeInfo = nodeTypes;
    }
  } catch {
    // Optional node-types metadata.
  }
  return binding;
}

function loadPackageModule(packageName: string): unknown {
  try {
    return require(packageName);
  } catch (error) {
    if (shouldFallbackToBinding(error)) {
      return loadBindingFromPackage(packageName);
    }
    throw error;
  }
}

export function loadTreeSitterLanguage(packageName: string): Language {
  const cached = languageCache.get(packageName);
  if (cached) return cached;

  const mod = loadPackageModule(packageName);
  const candidate = extractDefaultExport(mod);
  if (!candidate) {
    throw new Error(`Failed to load Tree-sitter language from ${packageName}`);
  }
  const language = candidate as Language;
  languageCache.set(packageName, language);
  return language;
}

export function loadTypeScriptGrammars(): TypeScriptGrammars {
  if (typescriptCache) return typescriptCache;
  const mod = loadPackageModule("tree-sitter-typescript");
  const candidate = extractDefaultExport(mod);
  if (isObject(candidate)) {
    const typescript = candidate.typescript;
    const tsx = candidate.tsx;
    if (typescript && tsx) {
      const grammars = {
        typescript: typescript as Language,
        tsx: tsx as Language,
      };
      typescriptCache = grammars;
      return grammars;
    }
  }
  throw new Error("Failed to load tree-sitter-typescript grammars");
}
