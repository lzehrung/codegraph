import fs, { type BigIntStats } from "node:fs";
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
let fileIdentityCaseSensitivityFrozen = false;
let fileIdentityCaseSensitivityPinned = false;
let fileIdentityCaseSensitivityRoot: string | undefined;
const fileIdentityCaseSensitivityProbes = new Map<string, Promise<void>>();
let fileIdentityCaseSensitivityProbeGeneration = 0;
/**
 * Configures the assumed filesystem case sensitivity used by {@link fileIdentityKey}.
 * The first generated key or completed probe freezes the effective value; later
 * calls are ignored so one index cannot contain keys from mixed case modes.
 */
export function setFileIdentityCaseInsensitive(caseInsensitive: boolean): void {
  if (fileIdentityCaseSensitivityFrozen) return;
  caseInsensitiveFileIdentity = caseInsensitive;
}

export function isFileIdentityCaseInsensitive(): boolean {
  return caseInsensitiveFileIdentity;
}

/**
 * Probes each indexed root and configures {@link fileIdentityKey} from the first
 * observed filesystem mode. A conflicting later root emits a process warning because
 * identity keys are process-global. Probe failures retain the platform default.
 */
export function initializeFileIdentityCaseSensitivity(projectRoot: string): Promise<void> {
  const resolvedRoot = path.resolve(projectRoot);
  const generation = fileIdentityCaseSensitivityProbeGeneration;
  let probe = fileIdentityCaseSensitivityProbes.get(resolvedRoot);
  if (!probe) {
    probe = probeFileIdentityCaseSensitivity(resolvedRoot, generation);
    fileIdentityCaseSensitivityProbes.set(resolvedRoot, probe);
  }
  return probe;
}

/**
 * Resets the process-global identity probe for tests that need to exercise both
 * filesystem case modes. Production code must configure identity once and never reset it.
 *
 * Passing an explicit mode pins it: the probe will not overwrite it with the host
 * filesystem's real behavior, so a test can exercise the case-sensitive branch on a
 * case-insensitive host. Calling with no argument restores probe-driven detection.
 */
export function resetFileIdentityCaseSensitivityForTests(caseInsensitive?: boolean): void {
  fileIdentityCaseSensitivityProbeGeneration += 1;
  fileIdentityCaseSensitivityProbes.clear();
  caseInsensitiveFileIdentity = caseInsensitive ?? defaultCaseInsensitiveFileIdentity;
  fileIdentityCaseSensitivityFrozen = false;
  fileIdentityCaseSensitivityPinned = caseInsensitive !== undefined;
  fileIdentityCaseSensitivityRoot = undefined;
}

async function probeFileIdentityCaseSensitivity(resolvedRoot: string, generation: number): Promise<void> {
  let caseInsensitive = defaultCaseInsensitiveFileIdentity;
  try {
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
  if (generation !== fileIdentityCaseSensitivityProbeGeneration || fileIdentityCaseSensitivityPinned) return;
  if (fileIdentityCaseSensitivityFrozen) {
    if (caseInsensitive !== caseInsensitiveFileIdentity && fileIdentityCaseSensitivityRoot) {
      process.emitWarning(
        `Codegraph file identity uses ${fileIdentityCaseSensitivityRoot} as ${caseInsensitiveFileIdentity ? "case-insensitive" : "case-sensitive"}, but ${resolvedRoot} is ${caseInsensitive ? "case-insensitive" : "case-sensitive"}. Multiple filesystem case modes are not supported in one process.`,
        { code: "CODEGRAPH_FILE_IDENTITY_CASE_MODE_CONFLICT" },
      );
    }
    return;
  }
  caseInsensitiveFileIdentity = caseInsensitive;
  fileIdentityCaseSensitivityFrozen = true;
  fileIdentityCaseSensitivityRoot = resolvedRoot;
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
  fileIdentityCaseSensitivityFrozen = true;
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
  if (isRelativeToRoot(normalizedRoot, normalizedFile)) return true;
  return windowsAliasRelativePath(normalizedRoot, normalizedFile) !== null;
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
  if (isRelativeToRoot(normalizedRoot, normalizedFile)) {
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
  return windowsAliasRelativePath(normalizedRoot, normalizedFile);
}

/**
 * Optional realpath memo for one discovery pass. Nested callbacks restore the previous
 * map so concurrent passes cannot share answers. Cleared on return so a long-lived
 * process cannot reuse a stale realpath after the tree changes.
 */
let windowsRealpathMemo: Map<string, string> | undefined;

export function runWithWindowsRealpathMemo<T>(fn: () => T): T {
  const previous = windowsRealpathMemo;
  windowsRealpathMemo = new Map();
  try {
    return fn();
  } finally {
    windowsRealpathMemo = previous;
  }
}

function resolveWindowsRealpath(filePath: string): string {
  const cache = windowsRealpathMemo;
  if (!cache) return fs.realpathSync.native(filePath);
  const key = fileIdentityKey(filePath);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const resolved = fs.realpathSync.native(filePath);
  cache.set(key, resolved);
  return resolved;
}

function windowsPathsAreComparableEqual(left: string, right: string): boolean {
  return normalizeWindowsComparablePath(left) === normalizeWindowsComparablePath(right);
}

function windowsAliasRelativePath(normalizedRoot: string, normalizedFile: string): string | null {
  if (process.platform !== "win32") return null;
  if (!isWindowsQualifiedAbsolutePath(normalizedRoot) || !isWindowsQualifiedAbsolutePath(normalizedFile)) {
    return null;
  }
  try {
    const realRoot = resolveWindowsRealpath(normalizedRoot);
    const realFile = resolveWindowsRealpath(normalizedFile);
    // realpathSync.native resolves every path component. When both realpaths match the
    // already-normalized inputs, neither path contains a reparse point, so the lexical
    // non-membership that brought us here is authoritative and the ancestor stat walk
    // cannot discover a hidden containment.
    const realRootHasNoReparsePoint = windowsPathsAreComparableEqual(normalizePath(realRoot), normalizedRoot);
    const realFileHasNoReparsePoint = windowsPathsAreComparableEqual(normalizePath(realFile), normalizedFile);
    if (realRootHasNoReparsePoint && realFileHasNoReparsePoint) {
      return null;
    }

    const directRelativePath = path.win32.relative(realRoot, realFile);
    if (!directRelativePath.startsWith("..") && !path.win32.isAbsolute(directRelativePath)) {
      return normalizePath(directRelativePath);
    }

    const rootStat = fs.statSync(realRoot, { bigint: true });
    let ancestorPath = realFile;
    while (true) {
      const ancestorStat = fs.statSync(ancestorPath, { bigint: true });
      if (sameWindowsDirectoryIdentity(rootStat, ancestorStat)) {
        return normalizePath(path.win32.relative(ancestorPath, realFile));
      }
      const parentPath = path.dirname(ancestorPath);
      if (parentPath === ancestorPath) return null;
      ancestorPath = parentPath;
    }
  } catch {
    return null;
  }
}

function sameWindowsDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.ino !== 0n && left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
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
