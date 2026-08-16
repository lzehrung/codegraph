import { constants as fsConstants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

import { isFilePathWithinRoot, normalizePath, toProjectRelativePath } from "./paths.js";

export type ConfinedReadableFile = {
  handle: FileHandle;
  realPath: string;
  displayPath: string;
  size: number;
};

type ConfinedFileTestHook = (realPath: string) => void | Promise<void>;
type PreparedReadableFile = {
  displayPath: string;
  expectedStat: Stats;
  realPath: string;
};

let afterConfinedPathVerifiedForTests: ConfinedFileTestHook | undefined;

/**
 * Test-only seam after the trusted file identity is captured and before the descriptor opens.
 * Production code must leave this unset.
 */
export function setAfterConfinedPathVerifiedForTests(hook: ConfinedFileTestHook | undefined): void {
  afterConfinedPathVerifiedForTests = hook;
}

export async function resolveReadableFile(
  realRoot: string,
  root: string,
  filePath: string,
): Promise<PreparedReadableFile> {
  const candidatePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  const lexicalRelativePath =
    toProjectRelativePath(root, candidatePath) ?? toProjectRelativePath(realRoot, candidatePath);
  if (lexicalRelativePath === null) {
    throw new Error(`File is outside project root: ${normalizePath(candidatePath)} (root: ${normalizePath(realRoot)})`);
  }
  const candidateStat = await fs.lstat(candidatePath);
  const realPath = await assertRealPathCandidateWithinRoot(realRoot, candidatePath, "File");
  const expectedStat = await fs.lstat(realPath);
  assertRegularFileStat(expectedStat, realPath);
  const finalRealPath = await fs.realpath(realPath);
  if (!isFilePathWithinRoot(realRoot, finalRealPath)) {
    throw new Error(`File is outside project root: ${normalizePath(finalRealPath)} (root: ${normalizePath(realRoot)})`);
  }
  if (candidateStat.isFile() && !sameFileIdentity(candidateStat, expectedStat)) {
    throw new Error(
      `File changed during confinement: ${normalizePath(candidatePath)} (possible path confinement race)`,
    );
  }
  const displayPath =
    toProjectRelativePath(root, candidatePath) ?? toProjectRelativePath(realRoot, realPath) ?? normalizePath(realPath);
  return { realPath, displayPath, expectedStat };
}

/**
 * Resolve a project path, open it, and verify the opened descriptor before any read.
 *
 * Flow: capture the lexical file identity -> realpath confinement -> capture the resolved regular
 * file identity -> optional test hook -> open the realpath'd target -> `fstat` on that descriptor
 * -> identity check -> callers read only through the returned handle (never re-resolve the path string).
 *
 * POSIX: open uses `O_RDONLY | O_NOFOLLOW` so a leaf symlink swap fails the open with ELOOP.
 * win32: Node's `fs.open` has no portable `O_NOFOLLOW` (`fs.constants.O_NOFOLLOW` is absent).
 * Guarantee there is post-open identity: `fstat.ino` must match `lstat.ino`; `dev` is compared
 * only when both sides are non-zero because win32 `lstat` often reports `dev=0` while `fstat`
 * has the volume serial. A symlink swap after `lstat` yields a different inode on follow.
 *
 * In-root symlinks still work: confinement realpaths them first, then the open targets the
 * resolved regular file inside the root—not the symlink leaf.
 */
export async function openConfinedReadableFile(
  realRoot: string,
  root: string,
  filePath: string,
): Promise<ConfinedReadableFile> {
  const { realPath, displayPath, expectedStat } = await resolveReadableFile(realRoot, root, filePath);
  if (afterConfinedPathVerifiedForTests) {
    await afterConfinedPathVerifiedForTests(realPath);
  }
  const { handle, size } = await openVerifiedRegularFile(realPath, expectedStat);
  return { handle, realPath, displayPath, size };
}

export async function resolveProjectFile(realRoot: string, root: string, filePath: string): Promise<string> {
  const candidatePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  const realPath = await assertRealPathCandidateWithinRoot(realRoot, candidatePath, "File");
  const lexicalRelativePath = toProjectRelativePath(root, candidatePath);
  if (lexicalRelativePath) return normalizePath(candidatePath);
  const realRelativePath = toProjectRelativePath(realRoot, realPath);
  if (realRelativePath) return normalizePath(path.resolve(root, realRelativePath));
  throw new Error(`File is outside project root: ${normalizePath(realPath)} (root: ${normalizePath(realRoot)})`);
}

export async function assertRealPathCandidateWithinRoot(
  realRoot: string,
  filePath: string,
  label: string,
): Promise<string> {
  const existingPath = await findNearestExistingPath(filePath);
  const realExistingPath = await fs.realpath(existingPath);
  const relativeSuffix = path.relative(existingPath, filePath);
  const realTargetPath = path.resolve(realExistingPath, relativeSuffix);
  if (!isFilePathWithinRoot(realRoot, realTargetPath)) {
    throw new Error(
      `${label} is outside project root: ${normalizePath(realTargetPath)} (root: ${normalizePath(realRoot)})`,
    );
  }
  const finalRealPath = await fs.realpath(filePath);
  if (!isFilePathWithinRoot(realRoot, finalRealPath)) {
    throw new Error(
      `${label} is outside project root: ${normalizePath(finalRealPath)} (root: ${normalizePath(realRoot)})`,
    );
  }
  return finalRealPath;
}

export async function findNearestExistingPath(filePath: string): Promise<string> {
  let current = filePath;
  while (current !== path.dirname(current)) {
    try {
      await fs.stat(current);
      return current;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      current = path.dirname(current);
    }
  }
  return current;
}

async function openVerifiedRegularFile(
  realPath: string,
  expectedStat: Stats,
): Promise<{ handle: FileHandle; size: number }> {
  const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle: FileHandle;
  try {
    handle = await fs.open(realPath, openFlags);
  } catch (error) {
    throw rewriteNoFollowOpenError(error, realPath);
  }

  try {
    const postStat = await handle.stat();
    assertRegularFileStat(postStat, realPath);
    if (!sameFileIdentity(expectedStat, postStat)) {
      throw new Error(
        `File changed between verification and open: ${normalizePath(realPath)} (possible path confinement race)`,
      );
    }
    return { handle, size: postStat.size };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function sameFileIdentity(preStat: Stats, postStat: Stats): boolean {
  if (preStat.ino !== postStat.ino) return false;
  // win32 lstat often reports dev=0 while fstat has the volume serial; only compare when both are set.
  if (preStat.dev === 0 || postStat.dev === 0) return true;
  return preStat.dev === postStat.dev;
}

function assertRegularFileStat(stat: Stats, filePath: string): void {
  if (stat.isFile()) return;
  throw new Error(`File view target is not a file: ${filePath}`);
}

function rewriteNoFollowOpenError(error: unknown, filePath: string): Error {
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ELOOP" || error.code === "EMLINK" || error.code === "EINVAL")
  ) {
    return new Error(
      `File changed between verification and open: ${normalizePath(filePath)} (possible path confinement race)`,
    );
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
