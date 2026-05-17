import path from "node:path";

export function normalizePath(p: string): string {
  return typeof p === "string" ? p.replace(/\\/g, "/") : "";
}

function normalizeWindowsComparablePath(filePath: string): string {
  return normalizePath(filePath).replace(/^([A-Za-z]):/, (_, driveLetter: string) => `${driveLetter.toUpperCase()}:`);
}

export function isAbsoluteFilePath(filePath: string): boolean {
  return path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath);
}

export function resolveFilePathFromRoot(projectRoot: string, filePath: string): string {
  if (isAbsoluteFilePath(filePath)) {
    return filePath;
  }
  if (path.win32.isAbsolute(projectRoot)) {
    return path.win32.resolve(projectRoot, filePath);
  }
  return path.resolve(projectRoot, filePath);
}

function resolveComparableProjectRoot(projectRoot: string): string {
  if (isAbsoluteFilePath(projectRoot)) {
    return projectRoot;
  }
  return path.resolve(projectRoot);
}

function isRelativeToRoot(normalizedRoot: string, normalizedFile: string): boolean {
  const comparableRoot = path.win32.isAbsolute(normalizedRoot)
    ? normalizeWindowsComparablePath(normalizedRoot)
    : normalizedRoot;
  const comparableFile = path.win32.isAbsolute(normalizedFile)
    ? normalizeWindowsComparablePath(normalizedFile)
    : normalizedFile;

  if (path.win32.isAbsolute(comparableRoot) && path.win32.isAbsolute(comparableFile)) {
    if (comparableFile === comparableRoot) {
      return true;
    }
    const relativePath = normalizePath(path.win32.relative(comparableRoot, comparableFile));
    return !!relativePath.length && !relativePath.startsWith("..") && !path.win32.isAbsolute(relativePath);
  }

  if (comparableFile === comparableRoot) {
    return true;
  }
  const relativePath = path.relative(comparableRoot, comparableFile);
  return !!relativePath.length && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

export function isFilePathWithinRoot(projectRoot: string, filePath: string): boolean {
  const normalizedRoot = normalizePath(resolveComparableProjectRoot(projectRoot));
  const normalizedFile = normalizePath(resolveFilePathFromRoot(normalizedRoot, filePath));
  return isRelativeToRoot(normalizedRoot, normalizedFile);
}

export function assertFilePathWithinRoot(projectRoot: string, filePath: string, label: string = "File"): string {
  const normalizedRoot = normalizePath(resolveComparableProjectRoot(projectRoot));
  const normalizedFile = normalizePath(resolveFilePathFromRoot(normalizedRoot, filePath));
  if (!isFilePathWithinRoot(normalizedRoot, normalizedFile)) {
    throw new Error(`${label} is outside project root: ${normalizedFile} (root: ${normalizedRoot})`);
  }
  return normalizedFile;
}

export function toProjectRelativePath(projectRoot: string, filePath: string): string | null {
  const normalizedRoot = normalizePath(resolveComparableProjectRoot(projectRoot));
  const normalizedFile = normalizePath(resolveFilePathFromRoot(normalizedRoot, filePath));
  if (!isFilePathWithinRoot(normalizedRoot, normalizedFile)) {
    return null;
  }
  if (path.win32.isAbsolute(normalizedRoot) && path.win32.isAbsolute(normalizedFile)) {
    const comparableRoot = normalizeWindowsComparablePath(normalizedRoot);
    const comparableFile = normalizeWindowsComparablePath(normalizedFile);
    return normalizePath(path.win32.relative(comparableRoot, comparableFile));
  }
  return normalizePath(path.relative(normalizedRoot, normalizedFile));
}

export function normalizeResolutionHints(hints?: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const hint of hints ?? []) {
    const normalized = hint.replace(/\\/g, "/").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
