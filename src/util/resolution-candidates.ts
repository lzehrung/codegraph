import path from "node:path";

export const STYLESHEET_RESOLUTION_EXTENSIONS = [".css", ".scss", ".less"] as const;

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
  ".html",
  ".vue",
  ".svelte",
  ".go",
  ".java",
  ".cs",
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
  if (!baseExt) {
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
