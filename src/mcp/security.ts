import fs from "node:fs/promises";
import path from "node:path";

import { isFilePathWithinRoot, normalizePath, toProjectRelativePath } from "../util/paths.js";

export function resolveArtifactSqlitePathCandidate(root: string, artifactPath: string): string {
  const resolved = path.isAbsolute(artifactPath) ? artifactPath : path.resolve(root, artifactPath);
  const sqlitePath =
    resolved.toLowerCase().endsWith(".sqlite") || resolved.toLowerCase().endsWith(".db")
      ? resolved
      : path.join(resolved, "codegraph.sqlite");
  return normalizePath(sqlitePath);
}

export async function resolveReadableFile(
  realRoot: string,
  root: string,
  filePath: string,
): Promise<{ realPath: string; displayPath: string }> {
  const candidatePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  const realPath = await assertRealPathCandidateWithinRoot(realRoot, candidatePath, "File");
  const displayPath =
    toProjectRelativePath(root, candidatePath) ?? toProjectRelativePath(realRoot, realPath) ?? normalizePath(realPath);
  return { realPath, displayPath };
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

export async function readFilePrefix(
  filePath: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const handle = await fs.open(filePath, "r");
  try {
    const readLimit = maxBytes + 1;
    const buffer = Buffer.alloc(readLimit);
    const { bytesRead } = await handle.read(buffer, 0, readLimit, 0);
    const outputBytes = Math.min(bytesRead, maxBytes);
    const outputBuffer = trimToUtf8Boundary(buffer.subarray(0, outputBytes));
    return {
      text: outputBuffer.toString("utf8"),
      truncated: bytesRead > maxBytes,
    };
  } finally {
    await handle.close();
  }
}

export async function assertRealPathCandidateWithinRoot(
  realRoot: string,
  filePath: string,
  label: string,
): Promise<string> {
  const existingPath = await nearestExistingPath(filePath);
  const realExistingPath = await fs.realpath(existingPath);
  const relativeSuffix = path.relative(existingPath, filePath);
  const realTargetPath = path.resolve(realExistingPath, relativeSuffix);
  if (!isFilePathWithinRoot(realRoot, realTargetPath)) {
    throw new Error(
      `${label} is outside project root: ${normalizePath(realTargetPath)} (root: ${normalizePath(realRoot)})`,
    );
  }
  const finalRealPath = normalizePath(await fs.realpath(filePath));
  if (!isFilePathWithinRoot(realRoot, finalRealPath)) {
    throw new Error(`${label} is outside project root: ${finalRealPath} (root: ${normalizePath(realRoot)})`);
  }
  return finalRealPath;
}

export async function assertWritableDirectoryRealPathWithinRoot(
  realRoot: string,
  root: string,
  requestedPath: string,
  label: string,
): Promise<string> {
  const lexicalPath = path.isAbsolute(requestedPath) ? requestedPath : path.resolve(root, requestedPath);
  const existingPath = await nearestExistingPath(lexicalPath);
  const realExistingPath = await fs.realpath(existingPath);
  const relativeSuffix = path.relative(existingPath, lexicalPath);
  const realTargetPath = path.resolve(realExistingPath, relativeSuffix);
  if (!isFilePathWithinRoot(realRoot, realTargetPath)) {
    throw new Error(
      `${label} is outside project root: ${normalizePath(realTargetPath)} (root: ${normalizePath(realRoot)})`,
    );
  }
  return normalizePath(realTargetPath);
}

function trimToUtf8Boundary(buffer: Buffer): Buffer {
  if (!buffer.length) return buffer;
  let leadIndex = buffer.length - 1;
  while (leadIndex >= 0) {
    const byte = buffer[leadIndex];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    leadIndex -= 1;
  }
  if (leadIndex < 0) return buffer.subarray(0, 0);
  const leadByte = buffer[leadIndex];
  if (leadByte === undefined) return buffer.subarray(0, 0);
  const continuationBytes = buffer.length - leadIndex - 1;
  const expectedContinuationBytes = expectedUtf8ContinuationBytes(leadByte);
  if (expectedContinuationBytes === null) return buffer.subarray(0, leadIndex);
  if (continuationBytes < expectedContinuationBytes) return buffer.subarray(0, leadIndex);
  return buffer;
}

function expectedUtf8ContinuationBytes(byte: number): number | null {
  if ((byte & 0x80) === 0) return 0;
  if ((byte & 0xe0) === 0xc0) return 1;
  if ((byte & 0xf0) === 0xe0) return 2;
  if ((byte & 0xf8) === 0xf0) return 3;
  return null;
}

async function nearestExistingPath(filePath: string): Promise<string> {
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

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
