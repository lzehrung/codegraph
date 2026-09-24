import path from "node:path";
import { supportById } from "../languages.js";

export const STYLESHEET_RESOLUTION_EXTENSIONS = [".css", ".scss", ".less"] as const;

export const NON_IMPORTABLE_SOURCE_EXTENSIONS = new Set([".pyw", ".rbw", ".rake", ".gemspec"]);

export function getImportableLanguageExtensions(languageId: string): string[] {
  const matchExts = supportById(languageId)?.matchExts ?? [];
  return matchExts.filter((ext) => !NON_IMPORTABLE_SOURCE_EXTENSIONS.has(ext));
}

export function getImportableLanguageGlobs(languageId: string): string[] {
  return getImportableLanguageExtensions(languageId).map((ext) => `**/*${ext}`);
}

export function fileHasImportableLanguageExtension(filePath: string, languageId: string): boolean {
  const lowerPath = filePath.toLowerCase().replace(/\\/g, "/");
  return getImportableLanguageExtensions(languageId).some((ext) => lowerPath.endsWith(ext));
}

export const DEFAULT_RESOLUTION_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mts",
  ".d.mts",
  ".cts",
  ".d.cts",
  ".mjs",
  ".cjs",
  ".json",
  ...STYLESHEET_RESOLUTION_EXTENSIONS,
  ".php",
  ".phtml",
  ".php4",
  ".php8",
  ".html",
  ".vue",
  ".svelte",
  ".go",
  ".java",
  ".cs",
  ".csx",
  ".rb",
  ".rs",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".c++",
  ".hpp",
  ".hh",
  ".hxx",
  ".ipp",
  ".tpp",
  ".inl",
  ".kt",
  ".kts",
  ".ktm",
  ".swift",
] as const;

const EXPLICIT_SPECIFIER_EXTENSION_FAMILIES: Record<string, readonly string[]> = {
  ".ts": [".ts", ".tsx", ".d.ts", ".js", ".jsx"],
  ".tsx": [".tsx", ".jsx", ".ts", ".d.ts", ".js"],
  ".js": [".ts", ".tsx", ".d.ts", ".js", ".jsx"],
  ".jsx": [".tsx", ".jsx", ".ts", ".d.ts", ".js"],
  ".mts": [".mts", ".d.mts", ".mjs"],
  ".mjs": [".mts", ".d.mts", ".mjs"],
  ".cts": [".cts", ".d.cts", ".cjs"],
  ".cjs": [".cts", ".d.cts", ".cjs"],
};

export function getResolutionExtensions(resolutionExtensions?: readonly string[]): string[] {
  const extensions = resolutionExtensions === undefined ? DEFAULT_RESOLUTION_EXTENSIONS : resolutionExtensions;
  return Array.from(new Set(extensions));
}

export function listResolutionCandidates(base: string, resolutionExtensions?: readonly string[]): string[] {
  const extensions = getResolutionExtensions(resolutionExtensions);
  const baseExt = path.extname(base).toLowerCase();
  // A final dotted segment can be part of an extensionless basename (for example, `statement.model`).
  // Only a configured source extension makes the specifier explicit enough to stop suffix probing.
  const hasKnownExtension =
    !!baseExt && (extensions.includes(baseExt) || Object.hasOwn(EXPLICIT_SPECIFIER_EXTENSION_FAMILIES, baseExt));
  if (!hasKnownExtension) {
    return Array.from(
      new Set([
        base,
        ...extensions.map((extension) => `${base}${extension}`),
        ...extensions.map((extension) => path.join(base, `index${extension}`)),
      ]),
    );
  }

  const compatibleExtensions = EXPLICIT_SPECIFIER_EXTENSION_FAMILIES[baseExt] ?? [baseExt];
  const baseWithoutExt = base.slice(0, -baseExt.length);
  const candidates = compatibleExtensions
    .filter((extension) => extension === baseExt || extensions.includes(extension))
    .map((extension) => `${baseWithoutExt}${extension}`);
  return candidates.length ? Array.from(new Set(candidates)) : [base];
}
