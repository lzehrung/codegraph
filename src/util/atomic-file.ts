import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { delay } from "./concurrency.js";
import { isMissingPathError } from "./errors.js";

/** A writer that crashed before its rename leaves a temp file behind; a live writer's is always younger. */
const STALE_TEMP_FILE_AGE_MS = 24 * 60 * 60 * 1_000;

/** Waits before each retry of a write that hit transient file contention. */
const TRANSIENT_RETRY_DELAYS_MS = [10, 25, 50, 100];

/** The owner's read and write bits, which a replacement has while it is written and fsynced whatever its final mode. */
const OWNER_READ_WRITE = 0o600;

/**
 * How a destination that is not a regular file is opened: write only, with no `O_CREAT` and no `O_TRUNC`. It exists, and
 * a device or a pipe has no content to cut off. One that has vanished since it was inspected is an error, not a new
 * regular file made without the atomic replacement.
 */
const WRITE_IN_PLACE_FLAGS = fsConstants.O_WRONLY;

/**
 * The Windows named-pipe namespace, `\\.\pipe\<name>` (`\\?\pipe\` is the same place). `stat` by path reports a pipe as
 * a regular file there, and connects to the pipe's server to do it, so the form of the path is the only safe sign.
 */
const WINDOWS_PIPE_PATH = /^[\\/]{2}[.?][\\/]pipe[\\/]/i;

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
 * The file now at `filePath`, or `undefined` when there is none. A symbolic link answers for the file it points to,
 * which is what a reader of `filePath` sees. An error other than a missing path is thrown: a destination that cannot
 * be inspected is not taken for a regular file, and its mode is not replaced by a wider default.
 */
async function statDestination(filePath: string): Promise<Stats | undefined> {
  try {
    return await fsp.stat(filePath);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

/** Whether `filePath` is in the Windows named-pipe namespace; see `WINDOWS_PIPE_PATH`. */
function isWindowsPipePath(filePath: string): boolean {
  return process.platform === "win32" && WINDOWS_PIPE_PATH.test(filePath);
}

/**
 * Runs `writeTemp` against a unique `.<name>.<pid>.<uuid>.tmp` file beside `filePath`, fsyncs that file, renames it
 * over `filePath`, and fsyncs the directory, so a reader sees the old or the new content, never a partial write. A
 * failure that looks like transient file contention retries with a fresh temp file after a short backoff; any other
 * failure throws. A failed attempt removes its own temp file and leaves `filePath` as it was; a temp file orphaned
 * by a crash is left for `removeStaleTempFiles`. Resolves to `false`, having written nothing, when `filePath` is not
 * a regular file, which a rename cannot replace: see `replaceFileAtomically`.
 *
 * A file that is replaced keeps its permission bits, as it would if it were written in place. They are those of the
 * file `stat` finds, which for a symbolic link is the file it points to; the replacement is a regular file in the
 * link's place. On Windows a mode carries one attribute, read-only, and a rename over a read-only file fails, so
 * nothing is copied there. `writeTemp` is given the mode to create the temp file with: the old file's, plus the
 * owner's read and write bits. So the new content is never open to more users than the old content was, not even
 * before the rename, and the fsync below can reopen the file by path when its mode is read-only. Then `chmod` sets
 * the exact mode, which also restores the bits that the umask removed at creation.
 */
async function replaceByRename(
  filePath: string,
  writeTemp: (tempPath: string, createMode: number | undefined) => Promise<void>,
): Promise<boolean> {
  const directory = path.dirname(filePath);
  for (let attempt = 0; ; attempt += 1) {
    const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const destination = await statDestination(filePath);
      if (destination && !destination.isFile()) return false;
      const mode = destination && process.platform !== "win32" ? destination.mode & 0o7777 : undefined;
      await writeTemp(tempPath, mode === undefined ? undefined : mode | OWNER_READ_WRITE);
      await fsyncFile(tempPath);
      if (mode !== undefined) await fsp.chmod(tempPath, mode);
      await fsp.rename(tempPath, filePath);
      await fsyncDirectory(directory);
      return true;
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

/**
 * Replaces `filePath` through a temp file and a rename (`replaceByRename`), or writes it in place with `writeInPlace`
 * when it is not a regular file. A rename over a device (`/dev/null`, `\\.\NUL`), a FIFO, a socket or a directory
 * either fails or, where the platform lets it through, destroys that file; and a file with no content to keep has
 * nothing for a temp file to protect. `stat` decides, so a symbolic link counts as what it points to. Windows reports
 * a named pipe as a regular file, and connects to its server to do so, so a path in the pipe namespace is written in
 * place without being inspected. An in-place write makes no temp file, renames nothing, fsyncs nothing (a pipe or a
 * device may not support it), retries nothing (what went out cannot be taken back), and removes nothing, whether it
 * succeeds or fails; a failure part way leaves what was already written.
 */
async function replaceFileAtomically(
  filePath: string,
  writeTemp: (tempPath: string, createMode: number | undefined) => Promise<void>,
  writeInPlace: () => Promise<void>,
): Promise<void> {
  if (!isWindowsPipePath(filePath) && (await replaceByRename(filePath, writeTemp))) return;
  await writeInPlace();
}

/**
 * Replace `filePath` with `data` so a reader sees the old or the new content, never a partial write. A file that is
 * replaced keeps its permission bits, except on Windows, where they are not meaningful. A destination that is not a
 * regular file (`/dev/null`, a FIFO, a Windows named pipe) cannot be replaced, so `data` is written into it in place.
 */
export async function writeFileAtomically(filePath: string, data: string | Uint8Array): Promise<void> {
  await replaceFileAtomically(
    filePath,
    async (tempPath, createMode) => {
      await fsp.writeFile(tempPath, data, { flag: "wx", ...(createMode === undefined ? {} : { mode: createMode }) });
    },
    async () => {
      await fsp.writeFile(filePath, data, { flag: WRITE_IN_PLACE_FLAGS });
    },
  );
}

/** Opens `target` with `flag` (and `mode` when that creates it), lets `fill` write through the handle, and closes it. */
async function fillFile(
  target: string,
  flag: string | number,
  mode: number | undefined,
  fill: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  const handle = await fsp.open(target, flag, mode);
  try {
    await fill(handle);
  } finally {
    await handle.close();
  }
}

/**
 * `writeFileAtomically` for content produced piece by piece, such as a document too large to hold as one string:
 * `fill` writes it through the handle of a new temp file, and that file replaces `filePath` only after `fill` has
 * returned. A failure to open the temp file or in `fill` removes the temp file and leaves a previous `filePath`
 * untouched. A retry after transient contention calls `fill` again with a fresh temp file. A file that is replaced
 * keeps its permission bits, except on Windows, where they are not meaningful. For a destination that is not a
 * regular file, `fill` writes through the handle of the destination itself, once: a failure is thrown as it is, and
 * leaves what was already written.
 */
export async function writeFileAtomicallyFrom(
  filePath: string,
  fill: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  await replaceFileAtomically(
    filePath,
    (tempPath, createMode) => fillFile(tempPath, "wx", createMode, fill),
    () => fillFile(filePath, WRITE_IN_PLACE_FLAGS, undefined, fill),
  );
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
