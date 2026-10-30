import { randomUUID } from "node:crypto";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { delay } from "./concurrency.js";

/** A writer that crashed before its rename leaves a temp file behind; a live writer's is always younger. */
const STALE_TEMP_FILE_AGE_MS = 24 * 60 * 60 * 1_000;

/** Waits before each retry of a write that hit transient file contention. */
const TRANSIENT_RETRY_DELAYS_MS = [10, 25, 50, 100];

type DirectoryEntry = { name: string; isFile(): boolean };

/** Windows scanners and indexers briefly lock a freshly written file, which surfaces as one of these codes. */
function isTransientFileContentionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
}

export async function fsyncFile(filePath: string): Promise<void> {
  const handle = await fsp.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  let directory: FileHandle | undefined;
  try {
    directory = await fsp.open(directoryPath, "r");
    await directory.sync();
  } catch {
    // Directory fsync is not supported on every platform.
  } finally {
    if (directory) {
      try {
        await directory.close();
      } catch {
        // Directory fsync is best effort.
      }
    }
  }
}

/**
 * Runs `writeTemp` against a unique `.<name>.<pid>.<uuid>.tmp` file beside `filePath`, fsyncs that file, renames it
 * over `filePath`, and fsyncs the directory, so a reader sees the old or the new content, never a partial write. A
 * failure that looks like transient file contention retries with a fresh temp file after a short backoff; any other
 * failure throws. A failed attempt removes its own temp file and leaves `filePath` as it was; a temp file orphaned
 * by a crash is left for `removeStaleTempFiles`.
 */
async function replaceFileAtomically(filePath: string, writeTemp: (tempPath: string) => Promise<void>): Promise<void> {
  const directory = path.dirname(filePath);
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeTemp(tempPath);
      await fsyncFile(tempPath);
      await fsp.rename(tempPath, filePath);
      await fsyncDirectory(directory);
      return;
    } catch (error) {
      try {
        await fsp.rm(tempPath, { force: true });
      } catch {
        // Cleanup is best-effort; the next attempt uses a fresh temp path.
      }
      const canRetry = attempt < TRANSIENT_RETRY_DELAYS_MS.length && isTransientFileContentionError(error);
      if (!canRetry) throw error;
      await delay(TRANSIENT_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

/** Replace `filePath` with `data` so a reader sees the old or the new content, never a partial write. */
export async function writeFileAtomically(filePath: string, data: string | Uint8Array): Promise<void> {
  await replaceFileAtomically(filePath, async (tempPath) => {
    await fsp.writeFile(tempPath, data, { flag: "wx" });
  });
}

/**
 * `writeFileAtomically` for content produced piece by piece, such as a document too large to hold as one string:
 * `fill` writes it through the handle of a new temp file, and that file replaces `filePath` only after `fill` has
 * returned. A failure to open the temp file or in `fill` removes the temp file and leaves a previous `filePath`
 * untouched. A retry after transient contention calls `fill` again with a fresh temp file.
 */
export async function writeFileAtomicallyFrom(
  filePath: string,
  fill: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  await replaceFileAtomically(filePath, async (tempPath) => {
    const handle = await fsp.open(tempPath, "wx");
    try {
      await fill(handle);
    } finally {
      await handle.close();
    }
  });
}

/**
 * Remove temp files that `isTempFile` accepts and that are at least a day old. The caller owns the
 * name pattern for its own writer, and `remove` replaces the default single-file removal when a temp
 * file has companions. Best effort: an unreadable directory or an entry that cannot be removed is
 * skipped, so cleanup never blocks the write or query that triggered it.
 */
export async function removeStaleTempFiles(
  directory: string,
  isTempFile: (entry: DirectoryEntry) => boolean,
  remove: (filePath: string) => Promise<void> = (filePath) => fsp.rm(filePath, { force: true }),
): Promise<void> {
  let entries: DirectoryEntry[];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TEMP_FILE_AGE_MS;
  for (const entry of entries) {
    if (!isTempFile(entry)) continue;
    const candidate = path.join(directory, entry.name);
    try {
      const stat = await fsp.lstat(candidate);
      if (stat.mtimeMs <= cutoff) await remove(candidate);
    } catch {
      // Best-effort cleanup.
    }
  }
}
