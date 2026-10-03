import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { glob as crawlGlob } from "tinyglobby";

/** The `readdir` form every crawl here uses: directory entries with their types. */
export type DirentReaddir = (
  directory: string,
  options: { withFileTypes: true },
  callback: (error: NodeJS.ErrnoException | null, entries: fs.Dirent[]) => void,
) => void;

export type GlobOptions = {
  cwd: string;
  dot?: boolean;
  /** Defaults to true, as before. A symlink is then crawled and returned at its link path. */
  followSymbolicLinks?: boolean;
  ignore?: readonly string[];
  /** Defaults to true. */
  onlyFiles?: boolean;
  /** Keep the trailing `/` on returned directories. */
  markDirectories?: boolean;
  /** Shared directory listing, for example a discovery-wide cache. */
  readdir?: DirentReaddir;
};

function nativeDirentReaddir(
  directory: string,
  options: { withFileTypes: true },
  callback: (error: NodeJS.ErrnoException | null, entries: fs.Dirent[]) => void,
): void {
  fs.readdir(directory, options, callback);
}

/**
 * Records read failures the crawler would otherwise skip. A missing directory is an empty
 * listing; any other failure (for example a permission error) fails the whole glob, so a
 * scan never returns a silently partial file set.
 */
function failureRecordingFilesystem(readdir: DirentReaddir): {
  fs: { readdir: typeof fs.readdir };
  firstError: () => NodeJS.ErrnoException | undefined;
} {
  let failure: NodeJS.ErrnoException | undefined;
  const record = (error: NodeJS.ErrnoException | null): void => {
    if (error && error.code !== "ENOENT") failure ??= error;
  };
  function recordingReaddir(directory: fs.PathLike, ...rest: unknown[]): void {
    const callback = rest[rest.length - 1];
    const options = rest.length > 1 ? rest[0] : undefined;
    if (typeof callback !== "function") throw new TypeError("readdir requires a callback");
    const withTypes =
      typeof directory === "string" &&
      typeof options === "object" &&
      options !== null &&
      "withFileTypes" in options &&
      !!options.withFileTypes;
    if (withTypes) {
      readdir(directory, { withFileTypes: true }, (error, entries) => {
        record(error);
        callback(error, entries);
      });
      return;
    }
    // Only the typed form is used by the crawler; any other form keeps native behavior.
    fs.readdir(directory, (error, entries) => {
      record(error);
      callback(error, entries);
    });
  }
  // The crawler accepts any `node:fs`-compatible adapter; this one implements the callback
  // forms it calls and forwards the rest to `node:fs`.
  return { fs: { readdir: recordingReaddir as typeof fs.readdir }, firstError: () => failure };
}

/**
 * The previous scanner pruned a directory for `dir` but ignored `dir/` entirely, and the final
 * discovery filter matches neither against files below it, so a trailing-slash pattern stays
 * out of the crawl rather than starting to hide files.
 */
function scanIgnorePatterns(patterns: readonly string[] | undefined): string[] {
  return (patterns ?? []).filter((pattern) => pattern && !pattern.endsWith("/"));
}

/**
 * Absolute, `/`-separated paths matching `patterns` under `options.cwd`. Patterns are not
 * expanded as directory names, and `ignore` prunes matching directories during the crawl.
 */
export async function globPaths(patterns: readonly string[], options: GlobOptions): Promise<string[]> {
  const filesystem = failureRecordingFilesystem(options.readdir ?? nativeDirentReaddir);
  const paths = await crawlGlob(patterns, {
    cwd: options.cwd,
    absolute: true,
    dot: !!options.dot,
    expandDirectories: false,
    followSymbolicLinks: options.followSymbolicLinks ?? true,
    ignore: scanIgnorePatterns(options.ignore),
    onlyFiles: options.onlyFiles ?? true,
    fs: filesystem.fs,
  });
  const failure = filesystem.firstError();
  if (failure) throw failure;
  if (options.onlyFiles === false && options.followSymbolicLinks === false) {
    // The crawler drops links it does not follow; entry listings still return a matching link
    // itself (for example a `package.json` link) for the caller's own confinement checks.
    const base = directoryPrefix(options.cwd);
    const matches = picomatch([...patterns], { dot: !!options.dot });
    const links = await findSymbolicLinks(options.cwd, {
      ...(options.ignore ? { ignore: options.ignore } : {}),
      ...(options.readdir ? { readdir: options.readdir } : {}),
    });
    for (const link of links) if (matches(link.slice(base.length))) paths.push(link);
  }
  if (options.markDirectories) return paths;
  return paths.map((filePath) => (filePath.endsWith("/") ? filePath.slice(0, -1) : filePath));
}

/** `root` with `/` separators and exactly one trailing `/`, so `/` and `C:/` stay roots. */
function directoryPrefix(root: string): string {
  const normalized = root.replace(/\\/g, "/");
  return normalized.endsWith("/") ? normalized : normalized + "/";
}

/**
 * Absolute paths of every symbolic link under `root` (files and directories alike) without
 * following any of them. A directory or link matching `ignore` is skipped.
 */
export async function findSymbolicLinks(
  root: string,
  options: { ignore?: readonly string[]; readdir?: DirentReaddir } = {},
): Promise<string[]> {
  const readdir = options.readdir ?? nativeDirentReaddir;
  const ignorePatterns = scanIgnorePatterns(options.ignore);
  const isIgnored = ignorePatterns.length ? picomatch(ignorePatterns, { dot: true }) : () => false;
  const base = directoryPrefix(root);
  const links: string[] = [];
  let pending = [""];
  while (pending.length) {
    const next: string[] = [];
    await Promise.all(
      pending.map(
        (relativeDirectory) =>
          new Promise<void>((resolve, reject) => {
            const directory = base + relativeDirectory;
            readdir(path.resolve(directory), { withFileTypes: true }, (error, entries) => {
              if (error) {
                if (error.code === "ENOENT") resolve();
                else reject(error);
                return;
              }
              for (const entry of entries) {
                const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
                if (isIgnored(relativePath)) continue;
                if (entry.isSymbolicLink()) links.push(base + relativePath);
                else if (entry.isDirectory()) next.push(relativePath);
              }
              resolve();
            });
          }),
      ),
    );
    pending = next;
  }
  return links;
}
