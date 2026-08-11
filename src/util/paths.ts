import fsp from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "./errors.js";

export function normalizePath(p: string): string {
  return typeof p === "string" ? p.replace(/\\/g, "/") : "";
}

function normalizeWindowsComparablePath(filePath: string): string {
  return normalizePath(filePath).replace(/^([A-Za-z]):/, (_, driveLetter: string) => `${driveLetter.toUpperCase()}:`);
}

const defaultCaseInsensitiveFileIdentity = process.platform === "win32" || process.platform === "darwin";
let caseInsensitiveFileIdentity = defaultCaseInsensitiveFileIdentity;
let fileIdentityCaseSensitivityProbe: Promise<void> | undefined;

/**
 * Overrides the assumed filesystem case sensitivity used by {@link fileIdentityKey}.
 * Call once per process after probing the volume that holds the project root.
 */
export function setFileIdentityCaseInsensitive(caseInsensitive: boolean): void {
  caseInsensitiveFileIdentity = caseInsensitive;
}

export function isFileIdentityCaseInsensitive(): boolean {
  return caseInsensitiveFileIdentity;
}

/**
 * Probes the project-root volume once per process, then configures {@link fileIdentityKey}
 * with the observed case sensitivity. Probe failures retain the platform default.
 */
export function initializeFileIdentityCaseSensitivity(projectRoot: string): Promise<void> {
  fileIdentityCaseSensitivityProbe ??= probeFileIdentityCaseSensitivity(projectRoot);
  return fileIdentityCaseSensitivityProbe;
}

async function probeFileIdentityCaseSensitivity(projectRoot: string): Promise<void> {
  let caseInsensitive = defaultCaseInsensitiveFileIdentity;
  try {
    const resolvedRoot = path.resolve(projectRoot);
    const caseFlippedRoot = flipPathCharacterCase(resolvedRoot);
    if (caseFlippedRoot) {
      const rootStat = await fsp.stat(resolvedRoot);
      try {
        const caseFlippedStat = await fsp.stat(caseFlippedRoot);
        caseInsensitive = rootStat.dev === caseFlippedStat.dev && rootStat.ino === caseFlippedStat.ino;
      } catch (error) {
        if (isMissingPathError(error)) caseInsensitive = false;
      }
    }
  } catch {
    // Some filesystems cannot be probed. Keep the platform default.
  }
  setFileIdentityCaseInsensitive(caseInsensitive);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function flipPathCharacterCase(filePath: string): string | null {
  const rootLength = path.parse(filePath).root.length;
  for (let index = filePath.length - 1; index >= rootLength; index -= 1) {
    const character = filePath[index];
    if (!character) continue;
    if (character >= "a" && character <= "z") {
      return `${filePath.slice(0, index)}${character.toUpperCase()}${filePath.slice(index + 1)}`;
    }
    if (character >= "A" && character <= "Z") {
      return `${filePath.slice(0, index)}${character.toLowerCase()}${filePath.slice(index + 1)}`;
    }
  }
  return null;
}

/**
 * Canonical comparison key for a file path.
 *
 * Use this for every map key, set membership test, dedup check, and path equality
 * comparison so one physical file can never be keyed two different ways (for example
 * `./Util` resolving beside a discovered `util.ts` on a case-insensitive volume).
 *
 * Never persist or display this value. Keep {@link normalizePath} output for storage,
 * serialized artifacts, and user-facing output.
 */
export function fileIdentityKey(filePath: string): string {
  const normalized = normalizeWindowsComparablePath(filePath);
  return caseInsensitiveFileIdentity ? normalized.toLowerCase() : normalized;
}

function isWindowsQualifiedAbsolutePath(filePath: string): boolean {
  const normalizedPath = normalizePath(filePath);
  return /^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.startsWith("//");
}

function isPosixQualifiedAbsolutePath(filePath: string): boolean {
  const normalizedPath = normalizePath(filePath);
  return path.posix.isAbsolute(normalizedPath) && !isWindowsQualifiedAbsolutePath(normalizedPath);
}

export function isAbsoluteFilePath(filePath: string): boolean {
  return path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath);
}

export function resolveFilePathFromRoot(projectRoot: string, filePath: string): string {
  if (isAbsoluteFilePath(filePath)) {
    return filePath;
  }
  if (isWindowsQualifiedAbsolutePath(projectRoot)) {
    return path.win32.resolve(projectRoot, filePath);
  }
  if (isPosixQualifiedAbsolutePath(projectRoot)) {
    return path.posix.resolve(normalizePath(projectRoot), normalizePath(filePath));
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
  const rootIsWindowsPath = isWindowsQualifiedAbsolutePath(normalizedRoot);
  const fileIsWindowsPath = isWindowsQualifiedAbsolutePath(normalizedFile);
  const rootIsPosixPath = isPosixQualifiedAbsolutePath(normalizedRoot);
  const fileIsPosixPath = isPosixQualifiedAbsolutePath(normalizedFile);
  const comparableRoot = rootIsWindowsPath ? normalizeWindowsComparablePath(normalizedRoot) : normalizedRoot;
  const comparableFile = fileIsWindowsPath ? normalizeWindowsComparablePath(normalizedFile) : normalizedFile;

  if (rootIsWindowsPath && fileIsWindowsPath) {
    if (comparableFile === comparableRoot) {
      return true;
    }
    const relativePath = normalizePath(path.win32.relative(comparableRoot, comparableFile));
    return !!relativePath.length && !relativePath.startsWith("..") && !path.win32.isAbsolute(relativePath);
  }

  if (rootIsWindowsPath || fileIsWindowsPath) {
    return false;
  }

  if (rootIsPosixPath && fileIsPosixPath) {
    if (comparableFile === comparableRoot) {
      return true;
    }
    const relativePath = path.posix.relative(comparableRoot, comparableFile);
    return !!relativePath.length && !relativePath.startsWith("..") && !path.posix.isAbsolute(relativePath);
  }

  if (rootIsPosixPath || fileIsPosixPath) {
    return false;
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

export type FilePathWithinRootResult =
  | { status: "ok"; file: string }
  | { status: "error"; reason: "outside_project_root"; error: string };

export function resolveFilePathWithinRoot(
  projectRoot: string,
  filePath: string,
  label?: string,
): FilePathWithinRootResult {
  try {
    return { status: "ok", file: assertFilePathWithinRoot(projectRoot, filePath, label) };
  } catch (error) {
    return {
      status: "error",
      reason: "outside_project_root",
      error: errorMessage(error),
    };
  }
}

export function toProjectRelativePath(projectRoot: string, filePath: string): string | null {
  const normalizedRoot = normalizePath(resolveComparableProjectRoot(projectRoot));
  const normalizedFile = normalizePath(resolveFilePathFromRoot(normalizedRoot, filePath));
  if (!isFilePathWithinRoot(normalizedRoot, normalizedFile)) {
    return null;
  }
  if (isWindowsQualifiedAbsolutePath(normalizedRoot) && isWindowsQualifiedAbsolutePath(normalizedFile)) {
    const comparableRoot = normalizeWindowsComparablePath(normalizedRoot);
    const comparableFile = normalizeWindowsComparablePath(normalizedFile);
    return normalizePath(path.win32.relative(comparableRoot, comparableFile));
  }
  if (isPosixQualifiedAbsolutePath(normalizedRoot) && isPosixQualifiedAbsolutePath(normalizedFile)) {
    return path.posix.relative(normalizedRoot, normalizedFile);
  }
  return normalizePath(path.relative(normalizedRoot, normalizedFile));
}

export function toProjectDisplayPath(projectRoot: string | undefined, filePath: string): string {
  if (!projectRoot) return normalizePath(filePath);
  return toProjectRelativePath(projectRoot, filePath) ?? normalizePath(filePath);
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
