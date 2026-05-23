import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";

export async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function isSymlinkUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP")
  );
}

export function normalizeTestPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
