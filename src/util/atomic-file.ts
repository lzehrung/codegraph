import { randomBytes, randomUUID } from "node:crypto";
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
 * Open flags for a device, a FIFO or a pipe, which exist and have no content to cut off: write only, with no `O_CREAT`
 * (one that has vanished since it was inspected is an error, not a new regular file made without the atomic
 * replacement) and no `O_TRUNC`.
 */
const DEVICE_WRITE_FLAGS = fsConstants.O_WRONLY;

/**
 * Open flags for a descriptor path (`DESCRIPTOR_PATH`). Opening one makes a new open file description of what the
 * descriptor holds, at offset 0, whatever offset and flags the descriptor has. Append mode puts the write where the
 * descriptor would have put it: after what `>>`, or an earlier command, left in a regular file, and at the start of
 * one that `>` has just emptied. A terminal, a FIFO and a device ignore it. The descriptor's own offset does not move
 * with this write, so a command that writes through the descriptor itself afterwards can overwrite it.
 */
const DESCRIPTOR_WRITE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_APPEND;

/** Open flags for a symbolic link that points at nothing yet: the write creates the file the link names. */
const LINK_TARGET_WRITE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC;

/**
 * A path that names an open file descriptor instead of a directory entry: `/dev/stdin`, `/dev/stdout`, `/dev/stderr`,
 * `/dev/fd/<n>` and, on Linux, `/proc/<pid>/fd/<n>` (`self` is this process, `thread-self` this thread). The file
 * behind one can be a regular file that another process holds open, such as the one a shell's `> graph.json` gives to
 * `/dev/stdout`. That file must stay the file the shell holds, and the entry in `/dev` or `/proc` is no place for a
 * temp file, so a user destination at such a path is written in place.
 */
const DESCRIPTOR_PATH =
  /^\/(?:dev\/(?:std(?:in|out|err)|fd\/\d+)|proc\/(?:self|thread-self|\d+)(?:\/task\/\d+)?\/fd\/\d+)$/;

/** How many symbolic links are followed looking for a descriptor path; Linux allows 40 in one lookup, macOS 32. */
const MAX_SYMLINK_HOPS = 40;

/**
 * The Windows named-pipe namespace, `\\.\pipe\<name>` (`\\?\pipe\` is the same place). `stat` by path reports a pipe as
 * a regular file there, and connects to the pipe's server to do it, so the form of the path is the only safe sign.
 */
const WINDOWS_PIPE_PATH = /^[\\/]{2}[.?][\\/]pipe[\\/]/i;

/** How a write treats what is already at its path. */
export type AtomicWriteOptions = {
  /**
   * `filePath` is a destination the user named, such as the `--output` of `graph --json`. It is written the way a shell
   * redirection to it would be (`planWrite`): a symbolic link at the path is followed and the file at its end is the one
   * replaced; a device, a FIFO, a socket, a Windows named pipe, or a descriptor path such as `/dev/stdout` is written in
   * place; and a regular file that is replaced keeps its permission bits.
   *
   * Leave it unset for a file that codegraph owns, such as a cache or an artifact file. The directory entry at the path
   * is then replaced, whatever it is, and nothing else is touched: a symbolic link there is replaced by the new regular
   * file and never followed, so a link planted in a cache directory cannot send a write to a file outside it, and nothing
   * at the path is opened or inspected, so a FIFO there cannot hold the write for a reader.
   */
  userDestination?: boolean;
};

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
 * What is at `filePath` itself (a symbolic link answers for the link), or `undefined` when there is nothing. An error
 * other than a missing path is thrown: a destination that cannot be inspected is not taken for a regular file, and its
 * mode is not replaced by a wider default.
 */
async function lstatIfPresent(filePath: string): Promise<Stats | undefined> {
  try {
    return await fsp.lstat(filePath);
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
 * Whether the symbolic links at `filePath` lead to a descriptor path, as after `ln -s /dev/stdout out.json`. Only the
 * spelling of each link's target is read, so a link that points at nothing ends the chain instead of failing it.
 */
async function linkReachesDescriptor(filePath: string): Promise<boolean> {
  let current = filePath;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop += 1) {
    let linkText: string;
    try {
      linkText = await fsp.readlink(current);
    } catch {
      return false;
    }
    current = path.resolve(path.dirname(current), linkText);
    if (DESCRIPTOR_PATH.test(current)) return true;
  }
  return false;
}

/** How a write reaches `filePath`: through a temp file that replaces `target`, or in place with `flags`. */
type WritePlan = { target: string; mode: number | undefined } | { flags: number };

/**
 * Decides how the user destination `filePath` is written (`AtomicWriteOptions.userDestination`). A regular file, or
 * nothing yet, is replaced through a temp file and a rename, and keeps the permission bits `lstat` finds. A symbolic
 * link stays what it is: the file it points to is the one replaced, and the temp file is made beside that file, never
 * in the link's own directory, which may be one that no file can be created in. Anything else is written in place,
 * because a rename cannot replace it or must not:
 *
 * - a device, a FIFO, a socket or a directory: a rename over one fails or destroys it;
 * - a descriptor path (`DESCRIPTOR_PATH`), as typed or at the end of symbolic links: it names a descriptor that can
 *   hold a regular file, which `stat` reports as one and which another process holds open;
 * - a Windows named pipe: `stat` reports it as a regular file, and connects to its server to do so;
 * - a symbolic link that points at nothing yet: the write creates the file the link names.
 */
async function planWrite(filePath: string): Promise<WritePlan> {
  const requested = path.resolve(filePath);
  if (DESCRIPTOR_PATH.test(requested)) return { flags: DESCRIPTOR_WRITE_FLAGS };
  if (isWindowsPipePath(requested)) return { flags: DEVICE_WRITE_FLAGS };
  let target = filePath;
  let found = await lstatIfPresent(target);
  if (found?.isSymbolicLink()) {
    if (await linkReachesDescriptor(requested)) return { flags: DESCRIPTOR_WRITE_FLAGS };
    try {
      target = await fsp.realpath(target);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      return { flags: LINK_TARGET_WRITE_FLAGS };
    }
    found = await lstatIfPresent(target);
  }
  if (found && !found.isFile()) return { flags: DEVICE_WRITE_FLAGS };
  return { target, mode: found && process.platform !== "win32" ? found.mode & 0o7777 : undefined };
}

/**
 * The name of the temp file for a write beside the file it replaces (`target`). A file that codegraph owns gets
 * `.<name>.<pid>.<uuid>.tmp`, the form that the stale-temp cleanups of the disk cache match. A user destination gets
 * `.cg-<16 hex digits>.tmp`, which has the same length whatever the destination is called: that name can be as long as
 * one path component allows (255 bytes, or characters, on the common filesystems), and the first form adds a pid, a
 * UUID and a suffix to it, so a valid destination name would make a temp name that exceeds the limit (`ENAMETOOLONG`,
 * or `ENOENT` on Windows).
 */
function tempFileName(target: string, userDestination: boolean): string {
  if (userDestination) return `.cg-${randomBytes(8).toString("hex")}.tmp`;
  return `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`;
}

/**
 * Runs `writeTemp` against a unique temp file beside the file it replaces (`tempFileName`), fsyncs that file, renames
 * it over that file, and fsyncs the directory, so a reader sees the old or the new content, never a partial write. A
 * failure that looks like transient file contention retries with a fresh temp file after a short backoff; any other
 * failure throws. A failed attempt removes its own temp file and leaves the file as it was; a temp file orphaned by a
 * crash is left behind, and the disk cache removes its own with `removeStaleTempFiles`.
 *
 * The file replaced is the entry at `filePath`, whatever it is: nothing at `filePath` is opened or inspected, and a
 * symbolic link there is replaced by the new regular file, not followed. With `userDestination`, `planWrite` decides
 * instead. Resolves to `undefined` once the file is replaced, and to the open flags of a write in place, having
 * written nothing, when `planWrite` found that a rename must not replace the destination: see `replaceFileAtomically`.
 *
 * A user destination that is replaced keeps its permission bits, as it would if it were written in place. On Windows a
 * mode carries one attribute, read-only, and a rename over a read-only file fails, so nothing is copied there.
 * `writeTemp` is given the mode to create the temp file with: the old file's, plus the owner's read and write bits. So
 * the new content is never open to more users than the old content was, not even before the rename, and the fsync
 * below can reopen the file by path when its mode is read-only. Then `chmod` sets the exact mode, which also restores
 * the bits that the umask removed at creation.
 */
async function replaceByRename(
  filePath: string,
  writeTemp: (tempPath: string, createMode: number | undefined) => Promise<void>,
  userDestination: boolean,
): Promise<number | undefined> {
  for (let attempt = 0; ; attempt += 1) {
    let tempPath: string | undefined;
    try {
      const plan: WritePlan = userDestination ? await planWrite(filePath) : { target: filePath, mode: undefined };
      if ("flags" in plan) return plan.flags;
      const directory = path.dirname(plan.target);
      tempPath = path.join(directory, tempFileName(plan.target, userDestination));
      await writeTemp(tempPath, plan.mode === undefined ? undefined : plan.mode | OWNER_READ_WRITE);
      await fsyncFile(tempPath);
      if (plan.mode !== undefined) await fsp.chmod(tempPath, plan.mode);
      await fsp.rename(tempPath, plan.target);
      await fsyncDirectory(directory);
      return undefined;
    } catch (error) {
      if (tempPath) {
        try {
          await fsp.rm(tempPath, { force: true });
        } catch {
          // Cleanup is best-effort; the next attempt uses a fresh temp path.
        }
      }
      const canRetry = attempt < TRANSIENT_RETRY_DELAYS_MS.length && isTransientFileContentionError(error);
      if (!canRetry) throw error;
      await delay(TRANSIENT_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

/**
 * Replaces the file at `filePath` through a temp file and a rename (`replaceByRename`) or, for a user destination
 * that a rename must not replace, writes it in place with `writeInPlace`, given the open flags `planWrite` chose. An
 * in-place write makes no temp file, renames nothing, fsyncs nothing (a pipe or a device may not support it), retries
 * nothing (what went out cannot be taken back), and removes nothing, whether it succeeds or fails; a failure part way
 * leaves what was already written.
 */
async function replaceFileAtomically(
  filePath: string,
  writeTemp: (tempPath: string, createMode: number | undefined) => Promise<void>,
  writeInPlace: (flags: number) => Promise<void>,
  options: AtomicWriteOptions,
): Promise<void> {
  const flags = await replaceByRename(filePath, writeTemp, options.userDestination ?? false);
  if (flags !== undefined) await writeInPlace(flags);
}

/**
 * Replace `filePath` with `data` so a reader sees the old or the new content, never a partial write. The entry at
 * `filePath` is replaced, a symbolic link included: the link is replaced by the new file, and the file it pointed to is
 * never written. For a destination the user named (`options.userDestination`) the file behind a link is the one
 * replaced, a replaced file keeps its permission bits (except on Windows, where they are not meaningful), and a
 * destination that a rename cannot replace (`/dev/null`, a FIFO, a Windows named pipe, a descriptor path such as
 * `/dev/stdout`) gets `data` written into it in place; see `AtomicWriteOptions`.
 */
export async function writeFileAtomically(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await replaceFileAtomically(
    filePath,
    async (tempPath, createMode) => {
      await fsp.writeFile(tempPath, data, { flag: "wx", ...(createMode === undefined ? {} : { mode: createMode }) });
    },
    async (flags) => {
      await fsp.writeFile(filePath, data, { flag: flags });
    },
    options,
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
 * untouched. A retry after transient contention calls `fill` again with a fresh temp file. `options` say how
 * `filePath` is treated, as for `writeFileAtomically`; for a destination the user named that a rename cannot replace,
 * `fill` writes through the handle of the destination itself, once, and a failure is thrown as it is and leaves what
 * was already written.
 */
export async function writeFileAtomicallyFrom(
  filePath: string,
  fill: (handle: FileHandle) => Promise<void>,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await replaceFileAtomically(
    filePath,
    (tempPath, createMode) => fillFile(tempPath, "wx", createMode, fill),
    (flags) => fillFile(filePath, flags, undefined, fill),
    options,
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
