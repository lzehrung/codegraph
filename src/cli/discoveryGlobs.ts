import path from "node:path";
import picomatch from "picomatch";
import { normalizePath } from "../util/paths.js";
import { isRelativePathInside, matchesDiscoveryGlob } from "../util/discoveryPath.js";
import type { ProjectFileDiscoveryOptions } from "../util/projectFiles.js";

function normalizeCliGlobPattern(globPattern: string): string {
  return globPattern.trim().replace(/\\/g, "/");
}

export function isCliDiscoveryRelativePathInside(relativePath: string): boolean {
  return isRelativePathInside(relativePath);
}

export type CliDiscoveryGlobDiagnostic = {
  kind: "include" | "ignore";
  glob: string;
  scanRoot: string;
  suggestion?: string;
};

export function filterFilesByCliDiscoveryGlobs(
  files: readonly string[],
  scanRoot: string,
  discovery: ProjectFileDiscoveryOptions,
): string[] {
  const includeMatchers = (discovery.includeGlobs ?? [])
    .map(normalizeCliGlobPattern)
    .filter(Boolean)
    .map((globPattern) => picomatch(globPattern, { dot: true }));
  const ignoreMatchers = (discovery.ignoreGlobs ?? [])
    .map(normalizeCliGlobPattern)
    .filter(Boolean)
    .map((globPattern) => picomatch(globPattern, { dot: true }));

  if (!includeMatchers.length && !ignoreMatchers.length) {
    return [...files];
  }

  return files.filter((filePath) => {
    if (
      includeMatchers.length &&
      !includeMatchers.some((matcher) => matchesDiscoveryGlob(filePath, scanRoot, matcher))
    ) {
      return false;
    }
    return !ignoreMatchers.some((matcher) => matchesDiscoveryGlob(filePath, scanRoot, matcher));
  });
}

function scanRootRelativeGlobSuggestion(
  globPattern: string,
  scanRoot: string,
  projectRoot: string,
): string | undefined {
  const relativeScanRoot = normalizePath(path.relative(projectRoot, scanRoot));
  if (!isCliDiscoveryRelativePathInside(relativeScanRoot)) return undefined;
  if (!relativeScanRoot) return undefined;
  const normalizedPattern = normalizeCliGlobPattern(globPattern);
  const prefix = `${relativeScanRoot}/`;
  if (!normalizedPattern.startsWith(prefix)) return undefined;
  const suggestion = normalizedPattern.slice(prefix.length);
  return suggestion || "**";
}

function diagnosticForCliGlob(
  files: readonly string[],
  scanRoot: string,
  projectRoot: string,
  globPattern: string,
  kind: "include" | "ignore",
): CliDiscoveryGlobDiagnostic | undefined {
  const normalizedPattern = normalizeCliGlobPattern(globPattern);
  if (!normalizedPattern) return undefined;
  const matcher = picomatch(normalizedPattern, { dot: true });
  const matched = files.some((filePath) => matchesDiscoveryGlob(filePath, scanRoot, matcher));
  if (matched) return undefined;
  const suggestion = scanRootRelativeGlobSuggestion(normalizedPattern, scanRoot, projectRoot);
  return {
    kind,
    glob: normalizedPattern,
    scanRoot: normalizePath(scanRoot),
    ...(suggestion !== undefined ? { suggestion } : {}),
  };
}

export function diagnoseCliDiscoveryGlobs(
  files: readonly string[],
  scanRoot: string,
  projectRoot: string,
  discovery: ProjectFileDiscoveryOptions,
): CliDiscoveryGlobDiagnostic[] {
  const diagnostics: CliDiscoveryGlobDiagnostic[] = [];
  for (const globPattern of discovery.includeGlobs ?? []) {
    const diagnostic = diagnosticForCliGlob(files, scanRoot, projectRoot, globPattern, "include");
    if (diagnostic) diagnostics.push(diagnostic);
  }
  for (const globPattern of discovery.ignoreGlobs ?? []) {
    const diagnostic = diagnosticForCliGlob(files, scanRoot, projectRoot, globPattern, "ignore");
    if (diagnostic) diagnostics.push(diagnostic);
  }
  return diagnostics;
}
