import path from "node:path";
import type { ModuleSpecifier } from "../util.js";

const DOCUMENT_RELATIVE_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".astro",
  ".hbs",
  ".handlebars",
  ".rst",
  ".adoc",
  ".asciidoc",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".ogg",
  ".txt",
  ".yaml",
  ".yml",
]);

export function dedupeModuleSpecifiers(entries: ModuleSpecifier[]): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.spec}::${entry.typeOnly ? 1 : 0}::${entry.resolutionKind ?? ""}::${entry.dropIfUnresolved ? 1 : 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export function normalizeLinkSpecifier(
  rawSpecifier: string,
  opts?: {
    preferRelative?: boolean;
    forceRelative?: boolean;
    resolutionKind?: "document" | "source";
  },
): ModuleSpecifier | null {
  const original = rawSpecifier.trim();
  if (!original) return null;

  let normalized = original;
  if (normalized.startsWith("<") && normalized.endsWith(">")) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (!normalized || normalized.startsWith("#")) return null;
  if (isObviouslyDynamicSpecifier(normalized)) return null;

  const hasSchemePrefix = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized);
  const isWindowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(normalized);
  const isProtocolRelative = normalized.startsWith("//");

  if (!hasSchemePrefix && !isProtocolRelative && !isWindowsAbsolutePath) {
    const hashIndex = normalized.indexOf("#");
    if (hashIndex >= 0) normalized = normalized.slice(0, hashIndex);
    const queryIndex = normalized.indexOf("?");
    if (queryIndex >= 0) normalized = normalized.slice(0, queryIndex);
  }

  normalized = normalized.trim();
  if (!normalized) return null;

  if (opts?.forceRelative && shouldForceRelativePath(normalized)) {
    normalized = `./${normalized}`;
  } else if (opts?.preferRelative && shouldPreferRelativePath(normalized)) {
    normalized = `./${normalized}`;
  }

  if (normalized === original) {
    return {
      spec: normalized,
      ...(opts?.resolutionKind ? { resolutionKind: opts.resolutionKind } : {}),
    };
  }
  return {
    spec: normalized,
    raw: original,
    ...(opts?.resolutionKind ? { resolutionKind: opts.resolutionKind } : {}),
  };
}

export function markResolutionKind(
  entries: ModuleSpecifier[],
  resolutionKind: "document" | "source",
): ModuleSpecifier[] {
  return entries.map((entry) => ({
    ...entry,
    resolutionKind,
  }));
}

export function normalizeReferenceLabel(label: string | undefined): string | null {
  const normalized = label?.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized ? normalized : null;
}

function shouldForceRelativePath(specifier: string): boolean {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("@") ||
    specifier.startsWith("//")
  ) {
    return false;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) return false;
  if (/^[A-Za-z]:[\\/]/.test(specifier)) return false;
  return true;
}

function shouldPreferRelativePath(specifier: string): boolean {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("@") ||
    specifier.startsWith("//")
  ) {
    return false;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) return false;
  if (/^[A-Za-z]:[\\/]/.test(specifier)) return false;
  if (specifier.includes("/")) {
    const firstSegment = specifier.split(/[\\/]/, 1)[0] ?? "";
    if (/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/i.test(firstSegment)) {
      return false;
    }
    return true;
  }

  const ext = path.extname(specifier).toLowerCase();
  return DOCUMENT_RELATIVE_EXTENSIONS.has(ext);
}

export function isObviouslyDynamicSpecifier(specifier: string): boolean {
  return (
    specifier.includes("{") ||
    specifier.includes("}") ||
    specifier.includes("{{") ||
    specifier.includes("}}") ||
    specifier.includes("{%") ||
    specifier.includes("%}") ||
    specifier.includes("<%") ||
    specifier.includes("%>") ||
    specifier.includes("${")
  );
}
