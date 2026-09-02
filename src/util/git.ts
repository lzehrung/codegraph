import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringifyUnknown } from "./ast.js";
import { normalizePath } from "./paths.js";
import { logWithLevel, type LogLevel } from "../logging.js";

/**
 * Default wall-clock budget for a single Git child.
 * Long enough for ordinary local repos; short enough that a locked network FS or
 * hung credential helper cannot pin an MCP request indefinitely.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

type GitExcludeFile = { file: string; baseDir: string; priority: number };

const gitRepositoryChecks = new Map<string, Promise<boolean>>();
const gitDiscoveryRootIgnoredChecks = new Map<string, Promise<boolean>>();
const gitExcludeFileChecks = new Map<string, Promise<GitExcludeFile[]>>();
const MAX_GIT_HASH_OBJECT_ARGUMENT_BYTES = 24 * 1024;

let gitExecutableForTests: string | null = null;
let gitExecutablePrefixArgsForTests: string[] = [];

/** Git's C-style path quoting single-character escapes for otherwise-unrepresentable control bytes. */
const GIT_QUOTED_PATH_SINGLE_BYTE_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

/** Decodes Git's optional C-style quoted pathname representation without trimming legal path bytes. */
export function decodeGitPath(rawPath: string): string {
  if (!rawPath.startsWith('"') || !rawPath.endsWith('"')) {
    return rawPath;
  }

  const inner = rawPath.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < inner.length; ) {
    const char = inner[index]!;
    if (char !== "\\") {
      const codePoint = inner.codePointAt(index)!;
      bytes.push(...Buffer.from(String.fromCodePoint(codePoint), "utf8"));
      index += codePoint > 0xffff ? 2 : 1;
      continue;
    }
    const octal = inner.slice(index + 1, index + 4).match(/^[0-7]{1,3}/);
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      index += 1 + octal[0].length;
      continue;
    }
    const next = inner[index + 1];
    if (next === "\\" || next === '"') {
      bytes.push(next.charCodeAt(0));
      index += 2;
      continue;
    }
    const singleByteEscape = GIT_QUOTED_PATH_SINGLE_BYTE_ESCAPES[next ?? ""];
    if (singleByteEscape !== undefined) {
      bytes.push(singleByteEscape);
      index += 2;
      continue;
    }
    bytes.push(0x5c);
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Test-only override of the Git executable. Pass null to restore.
 * `prefixArgs` are prepended so tests can run `node fake-git.cjs <git-args>` on Windows,
 * where spawning a `.cmd` wrapper is EINVAL.
 */
export function setGitExecutableForTests(executable: string | null, prefixArgs: readonly string[] = []): void {
  gitExecutableForTests = executable;
  gitExecutablePrefixArgsForTests = executable ? [...prefixArgs] : [];
}

export type RunGitOptions = {
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  maxBuffer?: number | undefined;
  input?: string | undefined;
  /** Test hook: observe the spawned child (e.g. to assert timeout kill). */
  onSpawn?: ((child: { pid?: number }) => void) | undefined;
};

/** Test-only: drop memoized Git repository checks. */
export function clearGitRepositoryCheckCacheForTests(): void {
  gitRepositoryChecks.clear();
}

/** Test-only: drop memoized Git discovery facts. */
export function clearGitDiscoveryCacheForTests(): void {
  gitDiscoveryRootIgnoredChecks.clear();
  gitExcludeFileChecks.clear();
}

function resolveGitTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return Math.floor(timeoutMs);
  }
  return DEFAULT_GIT_TIMEOUT_MS;
}

function appendBoundedTail(current: string, chunk: string, maxBytes: number): string {
  function utf8Tail(value: string, byteLimit: number): string {
    let start = value.length;
    let bytes = 0;
    while (start) {
      const last = value.charCodeAt(start - 1);
      const preceding = start > 1 ? value.charCodeAt(start - 2) : undefined;
      const isSurrogatePair =
        last >= 0xdc00 && last <= 0xdfff && preceding !== undefined && preceding >= 0xd800 && preceding <= 0xdbff;
      const codeUnits = isSurrogatePair ? 2 : 1;
      let codePointBytes = 3;
      if (isSurrogatePair) {
        codePointBytes = 4;
      } else if (last <= 0x7f) {
        codePointBytes = 1;
      } else if (last <= 0x7ff) {
        codePointBytes = 2;
      }
      if (bytes + codePointBytes > byteLimit) break;
      bytes += codePointBytes;
      start -= codeUnits;
    }
    return value.slice(start);
  }

  if (maxBytes <= 0) return "";
  const retainedChunk = utf8Tail(chunk, maxBytes);
  const retainedChunkBytes = Buffer.byteLength(retainedChunk, "utf8");
  if (retainedChunkBytes >= maxBytes) return retainedChunk;
  return utf8Tail(current, maxBytes - retainedChunkBytes) + retainedChunk;
}

function killGitChild(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  // Escalate if the child ignores SIGTERM (common on Windows for hung helpers).
  setTimeout(() => {
    if (child.killed || child.exitCode !== null) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, 1_000).unref?.();
}

/**
 * Central bounded Git execution: timeout + optional AbortSignal, always kills the child.
 * Preserves stderr/stdout in rejection messages for diagnosis.
 */
export async function runGit(
  projectRoot: string,
  args: string[],
  options?: RunGitOptions,
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = resolveGitTimeoutMs(options?.timeoutMs);
  const maxBuffer = options?.maxBuffer ?? 64 * 1024 * 1024;
  const executable = gitExecutableForTests ?? "git";
  const childArgs = gitExecutablePrefixArgsForTests.length ? [...gitExecutablePrefixArgsForTests, ...args] : args;
  const signal = options?.signal;

  if (signal?.aborted) {
    throw createGitError(projectRoot, args, new Error("aborted before start"));
  }

  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, childArgs, {
      cwd: projectRoot,
      env: process.env,
      stdio: [options?.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    options?.onSpawn?.(child.pid === undefined ? {} : { pid: child.pid });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let totalBytes = 0;
    let stderrBytes = 0;
    let stderrOverflowed = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGitChild(child);
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      aborted = true;
      killGitChild(child);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) {
      killGitChild(child);
      settle(() => reject(createGitError(projectRoot, args, new Error("git child missing stdio pipes"))));
      return;
    }

    // Decode incrementally per stream: a naive `chunk.toString()` on each independent
    // Buffer can split a multibyte UTF-8 sequence across chunk boundaries, replacing both
    // halves with U+FFFD. StringDecoder buffers a dangling partial sequence until the next
    // chunk completes it.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    stdoutStream.on("data", (chunk: Buffer | string) => {
      const chunkBytes = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.length;
      totalBytes += chunkBytes;
      if (totalBytes > maxBuffer) {
        killGitChild(child);
        settle(() =>
          reject(createGitError(projectRoot, args, new Error(`stdout exceeded maxBuffer (${maxBuffer} bytes)`))),
        );
        return;
      }
      stdout += typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
    });
    stderrStream.on("data", (chunk: Buffer | string) => {
      if (stderrOverflowed) return;
      const chunkBytes = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.length;
      stderrBytes += chunkBytes;
      const decoded = typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
      stderr = appendBoundedTail(stderr, decoded, maxBuffer);
      if (stderrBytes > maxBuffer) {
        stderrOverflowed = true;
        killGitChild(child);
        settle(() =>
          reject(
            createGitError(
              projectRoot,
              args,
              new Error(`stderr exceeded maxBuffer (${maxBuffer} bytes): ${stderr.trim()}`),
            ),
          ),
        );
      }
    });
    child.on("error", (error) => {
      settle(() => reject(createGitError(projectRoot, args, error)));
    });
    child.on("close", (code, signalName) => {
      stdout += stdoutDecoder.end();
      stderr = appendBoundedTail(stderr, stderrDecoder.end(), maxBuffer);
      settle(() => {
        if (timedOut) {
          reject(
            createGitError(
              projectRoot,
              args,
              new Error(`timed out after ${timeoutMs}ms${stderr ? `: ${stderr.trim()}` : ""}`),
            ),
          );
          return;
        }
        if (aborted) {
          reject(createGitError(projectRoot, args, new Error(`aborted${stderr ? `: ${stderr.trim()}` : ""}`)));
          return;
        }
        if (code !== 0) {
          reject(
            new Error(
              `git ${args.join(" ")} failed (${code ?? signalName ?? "unknown"}): ${stderr || stdout || "unknown error"}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      });
    });

    if (options?.input !== undefined) {
      if (!child.stdin) {
        killGitChild(child);
        settle(() => reject(createGitError(projectRoot, args, new Error("git child missing stdin pipe"))));
        return;
      }
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

async function runGitCollectStdout(projectRoot: string, args: string[]): Promise<string> {
  const { stdout } = await runGit(projectRoot, args);
  return stdout;
}

export function isGitWorktreeSentinel(value: string): boolean {
  return value.toUpperCase() === "WORKTREE";
}

export function isGitIndexSentinel(value: string): boolean {
  const normalized = value.toUpperCase();
  return normalized === "INDEX" || normalized === "STAGED";
}

const UNSAFE_REVISION_CHARACTERS = /[\0\r\n]/;
export function assertSafeRevision(value: string, label: string): string {
  if (UNSAFE_REVISION_CHARACTERS.test(value)) {
    throw new Error(`Invalid ${label}: revisions must not contain NUL or newline characters.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Invalid ${label}: revision must not be empty.`);
  }
  if (trimmed.startsWith("-")) {
    throw new Error(`Invalid ${label} "${trimmed}": revisions must not start with "-".`);
  }
  return trimmed;
}

export function gitDiffArgs(base: string, head: string, extraArgs: string[] = []): string[] {
  const safeBase = assertSafeRevision(base, "base");
  // Disable repository-configured helpers: review and impact consume Git's unified
  // text directly and must not execute external diff or text conversion commands.
  const diffSafetyArgs = ["--no-ext-diff", "--no-textconv"];
  // Explicit so rename detection stops depending on the user's `diff.renames` config
  // (git defaults it to true since 2.9, but a disabled config would silently change output).
  const renameArgs = ["--find-renames"];
  if (isGitWorktreeSentinel(head)) {
    return ["diff", ...diffSafetyArgs, ...renameArgs, ...extraArgs, "--end-of-options", safeBase];
  }
  if (isGitIndexSentinel(head)) {
    return ["diff", "--cached", ...diffSafetyArgs, ...renameArgs, ...extraArgs, "--end-of-options", safeBase];
  }
  const safeHead = assertSafeRevision(head, "head");
  return ["diff", ...diffSafetyArgs, ...renameArgs, ...extraArgs, "--end-of-options", `${safeBase}..${safeHead}`];
}

export async function getGitHead(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(projectRoot, ["rev-parse", "HEAD"]);
    const hash = stdout.trim();
    return hash || null;
  } catch {
    return null;
  }
}

export async function isGitRepo(projectRoot: string): Promise<boolean> {
  const resolvedRoot = path.resolve(projectRoot);
  const cached = gitRepositoryChecks.get(resolvedRoot);
  if (cached) return await cached;
  const check = (async () => {
    try {
      const { stdout } = await runGit(resolvedRoot, ["rev-parse", "--is-inside-work-tree"]);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  })();
  gitRepositoryChecks.set(resolvedRoot, check);
  return await check;
}

export async function getGitRepositoryRoot(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(projectRoot, ["rev-parse", "--show-toplevel"]);
    const root = normalizePath(stdout.trim());
    return root || null;
  } catch {
    return null;
  }
}

export async function isGitPathTracked(projectRoot: string, file: string): Promise<boolean> {
  return await runGitPathPredicate(projectRoot, ["ls-files", "--error-unmatch", "--", normalizePath(file)]);
}

export async function isGitPathIgnored(projectRoot: string, file: string): Promise<boolean> {
  return await runGitPathPredicate(projectRoot, ["check-ignore", "--quiet", "--no-index", "--", normalizePath(file)]);
}

/**
 * Whether Git ignores the requested project root. This value is static for a root during
 * process lifetime and lets repeated discovery avoid spawning `git check-ignore`.
 */
export async function isGitProjectRootIgnored(projectRoot: string): Promise<boolean> {
  const resolvedRoot = path.resolve(projectRoot);
  const cached = gitDiscoveryRootIgnoredChecks.get(resolvedRoot);
  if (cached) return await cached;
  const check = isGitPathIgnored(resolvedRoot, resolvedRoot);
  gitDiscoveryRootIgnoredChecks.set(resolvedRoot, check);
  return await check;
}

async function runGitPathPredicate(projectRoot: string, args: string[]): Promise<boolean> {
  try {
    await runGit(projectRoot, args);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // git ls-files --error-unmatch / check-ignore --quiet exit 1 for "no".
    if (/\bfailed \(1\):/.test(message)) return false;
    if (error instanceof Error && message.startsWith(`git ${args.join(" ")} failed in ${projectRoot}:`)) {
      throw error;
    }
    throw createGitError(projectRoot, args, error);
  }
}

export async function getGitBlobHashes(
  projectRoot: string,
  files: string[],
  opts?: { gitAvailable?: boolean; logLevel?: LogLevel },
): Promise<Map<string, string>> {
  const gitAvailable = opts?.gitAvailable ?? true;
  if (!gitAvailable) return new Map();
  const relFileSet = new Set(
    files
      .map((file) => normalizePath(path.relative(projectRoot, file)))
      .filter((rel) => rel && !rel.startsWith("..") && !path.isAbsolute(rel) && rel !== "."),
  );
  if (!relFileSet.size) return new Map();
  try {
    // Deliberately no path arguments here: passing one argv entry per requested file hits
    // Windows' ~32,767-character command-line limit past roughly 1,100 files, failing the
    // whole call with ENAMETOOLONG and silently discarding every git signature for the
    // build. Listing every tracked file and intersecting against the requested set in
    // memory costs a little extra parsing but stays correct at any repo size.
    // Full-repo NUL listings can exceed Node's default 1 MiB execFile maxBuffer on large
    // trees; raising it keeps the argv-limit fix from regressing into a silent maxBuffer miss.
    const { stdout: trackedStdout } = await runGit(projectRoot, ["ls-files", "-z"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const trackedRel = trackedStdout.split("\0").filter((rel) => rel && relFileSet.has(rel));
    if (!trackedRel.length) return new Map();
    const hashes = await hashGitPaths(projectRoot, trackedRel);
    if (hashes.length !== trackedRel.length) {
      logWithLevel(
        opts?.logLevel,
        "warn",
        `Warning: git hash-object returned ${hashes.length} hash(es) for ${trackedRel.length} ` +
          "requested file(s); discarding Git signatures for this build.",
      );
      return new Map();
    }
    const out = new Map<string, string>();
    for (let i = 0; i < trackedRel.length; i += 1) {
      const rel = trackedRel[i]!;
      const hash = hashes[i];
      if (!hash) continue;
      const abs = normalizePath(path.resolve(projectRoot, rel));
      out.set(abs, hash);
    }
    return out;
  } catch (error) {
    // A genuine git invocation failure, not "no git repository" (already handled above by
    // the early `gitAvailable` return). Losing Git signatures means every file falls back to
    // full content hashing, an easy-to-miss O(repo) regression, so surface it instead of
    // failing silently.
    logWithLevel(
      opts?.logLevel,
      "warn",
      "Warning: Failed to read Git blob hashes; falling back to content hashing.",
      error,
    );
    return new Map();
  }
}

async function hashGitPaths(projectRoot: string, trackedRel: string[]): Promise<string[]> {
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentBatchBytes = 0;

  for (const rel of trackedRel) {
    // `hash-object --stdin-paths` accepts newline-delimited input, so it cannot represent a
    // pathname containing a newline. Passing an absolute pathname as an argv value keeps every
    // legal Git pathname atomic and also works when projectRoot is below the repository root.
    const absolutePath = path.resolve(projectRoot, rel);
    const pathBytes = Buffer.byteLength(absolutePath, "utf8") + 1;
    const wouldExceedBatchLimit =
      currentBatch.length && currentBatchBytes + pathBytes > MAX_GIT_HASH_OBJECT_ARGUMENT_BYTES;
    if (wouldExceedBatchLimit) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchBytes = 0;
    }
    currentBatch.push(absolutePath);
    currentBatchBytes += pathBytes;
  }
  if (currentBatch.length) batches.push(currentBatch);

  const hashes: string[] = [];
  for (const batch of batches) {
    const { stdout } = await runGit(projectRoot, ["hash-object", "--", ...batch]);
    hashes.push(
      ...stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
  }
  return hashes;
}

/**
 * List files changed in Git.
 * - base/head: compares commits in the explicit range `${base}..${head ?? "HEAD"}`.
 *   WORKTREE compares base to the working tree, and STAGED/INDEX compares base to the index.
 * - changedSince: runs `git diff <rev>` (that revision vs current working tree/index).
 */
export async function listChangedFiles(
  projectRoot: string,
  opts: {
    changedSince?: string | undefined;
    base?: string | undefined;
    head?: string | undefined;
  },
): Promise<string[]> {
  let args = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    "--name-only",
    "-z",
    "--diff-filter=ACDMRTUXB",
  ];
  if (opts.base) {
    const head = opts.head ?? "HEAD";
    args = gitDiffArgs(opts.base, head, ["--name-only", "-z", "--diff-filter=ACDMRTUXB"]);
  } else if (opts.changedSince) {
    args.push("--end-of-options", assertSafeRevision(opts.changedSince, "changedSince"));
  } else {
    return [];
  }
  args.push("--");
  try {
    const stdout = await runGitCollectStdout(projectRoot, args);
    // -z NUL-delimits entries; git also quotes/octal-escapes non-ASCII bytes in the
    // unquoted -name-only form, corrupting them, so -z is required, not cosmetic. The
    // trailing split segment is always empty, not a filename, and a real filename can
    // legitimately start or end with whitespace, so filter without trimming.
    const relFiles = stdout.split("\0").filter(Boolean);
    const out: string[] = [];
    for (const rel of relFiles) {
      const abs = normalizePath(path.resolve(projectRoot, rel));
      if (abs) out.push(abs);
    }
    return Array.from(new Set(out));
  } catch (error) {
    throw createGitError(projectRoot, args, error);
  }
}

/**
 * List files Git tracks under `projectRoot`, as absolute normalized paths.
 *
 * Paired with `listUntrackedFiles` this enumerates exactly the working-tree files
 * Git considers part of the project, which is the indexable candidate set: Git
 * applies ignore rules while walking, so ignored trees are never descended into.
 * A recursive directory scan instead costs O(files on disk), which on trees full
 * of generated artifacts is orders of magnitude larger than the project itself.
 * `recurseSubmodules` also lists files tracked inside initialized submodules, whose
 * contents are otherwise invisible here: a submodule is a separate repository, so the
 * superproject records only a gitlink and reports nothing under it. Paths stay relative
 * to `projectRoot`, so they resolve the same way as the non-recursive listing.
 *
 * Deliberately no pathspec arguments: one argv entry per file hits Windows'
 * ~32,767-character command-line limit past roughly 1,100 files. Full-repo NUL
 * listings can also exceed Node's default 1 MiB stdout buffer on large trees, so
 * this raises `maxBuffer` for the same reason `getGitBlobHashes` does.
 */

function resolveGitListedPath(projectRoot: string, listedPath: string): string {
  return normalizePath(path.isAbsolute(listedPath) ? listedPath : path.resolve(projectRoot, listedPath));
}
export async function listTrackedFiles(
  projectRoot: string,
  opts?: { gitAvailable?: boolean; logLevel?: LogLevel; recurseSubmodules?: boolean },
): Promise<string[]> {
  if (!(opts?.gitAvailable ?? true)) return [];
  const args = ["ls-files", "-z"];
  if (opts?.recurseSubmodules) args.push("--recurse-submodules");
  try {
    const { stdout } = await runGit(projectRoot, args, { maxBuffer: 64 * 1024 * 1024 });
    // `git ls-files -z` NUL-delimits entries; the trailing split segment is always an
    // empty string rather than a filename, so drop empties without trimming (leading
    // and trailing whitespace can be a legitimate part of a real filename).
    const out: string[] = [];
    for (const rel of stdout.split("\0").filter(Boolean)) {
      const abs = resolveGitListedPath(projectRoot, rel);
      if (abs) out.push(abs);
    }
    return Array.from(new Set(out));
  } catch (error) {
    throw createGitError(projectRoot, args, error);
  }
}
/**
 * List `.gitignore` files Git knows about under `projectRoot`, including tracked,
 * untracked, and ignored files.
 *
 * Separate `--cached`, unignored `--others`, and ignored `--others` listings
 * include every rule source Git evaluates. An ignored `.gitignore` can itself
 * affect paths beneath it. NUL-delimited output keeps legal whitespace and
 * quoting in pathnames intact. The caller supplies each repository or alias root
 * separately, so paths remain relative to the same logical root used to invoke Git.
 * `excludePathspecs` are extra Git pathspecs appended after the `.gitignore` matchers
 * so callers can skip trees they never index, such as virtualenvs, without walking them.
 * Project discovery does not use this ignored listing: `git ls-files --others --ignored`
 * still descends into every gitignored tree, which times out on a large ignored data
 * directory. Discovery instead stats `.gitignore` files on ancestor directories of the
 * files Git already listed.
 */
export async function listGitIgnoreFiles(
  projectRoot: string,
  opts?: { gitAvailable?: boolean; excludePathspecs?: readonly string[] },
): Promise<string[]> {
  if (!(opts?.gitAvailable ?? true)) return [];
  const pathspec = [".gitignore", ":(glob)**/.gitignore", ...(opts?.excludePathspecs ?? [])];
  const commands = [
    ["ls-files", "--cached", "-z", "--", ...pathspec],
    ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspec],
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...pathspec],
  ];
  const results = await Promise.all(
    commands.map(async (args) => {
      try {
        return await runGit(projectRoot, args, { maxBuffer: 64 * 1024 * 1024 });
      } catch (error) {
        throw createGitError(projectRoot, args, error);
      }
    }),
  );
  const out: string[] = [];
  for (const { stdout } of results) {
    for (const rel of stdout.split("\0").filter(Boolean)) {
      const abs = resolveGitListedPath(projectRoot, rel);
      if (abs) out.push(abs);
    }
  }
  return Array.from(new Set(out));
}

type GitStageSpecialPaths = {
  gitlinks: string[];
  symlinks: string[];
};

function parseGitStageSpecialPaths(projectRoot: string, stdout: string): GitStageSpecialPaths {
  const gitlinks: string[] = [];
  const symlinks: string[] = [];
  for (const record of stdout.split("\0").filter(Boolean)) {
    // Each record is `<mode> <object> <stage>\t<path>`.
    const tabIndex = record.indexOf("\t");
    if (tabIndex < 0) continue;
    const rel = record.slice(tabIndex + 1);
    if (!rel) continue;
    const abs = normalizePath(path.resolve(projectRoot, rel));
    if (record.startsWith("160000 ")) gitlinks.push(abs);
    else if (record.startsWith("120000 ")) symlinks.push(abs);
  }
  return { gitlinks, symlinks };
}

/**
 * Index paths Git records as gitlinks (160000) or symlinks (120000).
 *
 * One `--stage` listing per repository. `recurse` walks gitlink directories as nested
 * repositories; symlink paths are never treated as gitlinks.
 */
export async function listGitStageSpecialPaths(
  projectRoot: string,
  opts?: { gitAvailable?: boolean; recurse?: boolean },
): Promise<GitStageSpecialPaths> {
  if (!(opts?.gitAvailable ?? true)) return { gitlinks: [], symlinks: [] };
  const args = ["ls-files", "--stage", "-z"];
  try {
    const { stdout } = await runGit(projectRoot, args, { maxBuffer: 64 * 1024 * 1024 });
    const direct = parseGitStageSpecialPaths(projectRoot, stdout);
    if (!opts?.recurse || !direct.gitlinks.length) {
      return {
        gitlinks: Array.from(new Set(direct.gitlinks)),
        symlinks: Array.from(new Set(direct.symlinks)),
      };
    }
    const nested = await Promise.all(
      direct.gitlinks.map(async (directory) => await listGitStageSpecialPaths(directory, opts)),
    );
    return {
      gitlinks: Array.from(new Set([...direct.gitlinks, ...nested.flatMap((entry) => entry.gitlinks)])),
      symlinks: Array.from(new Set([...direct.symlinks, ...nested.flatMap((entry) => entry.symlinks)])),
    };
  } catch (error) {
    throw createGitError(projectRoot, args, error);
  }
}

/**
 * Directories of initialized submodules under `projectRoot`, as absolute paths.
 *
 * Read from the index rather than `.gitmodules` so the result reflects what Git
 * actually tracks: a gitlink entry carries mode 160000. Callers enumerating untracked
 * files need this because `--recurse-submodules` cannot combine with `--others`, so
 * untracked files inside a submodule require a separate listing rooted there.
 *
 * `recurse` descends into each submodule to find gitlinks it records in turn. A
 * superproject's index lists only its own direct submodules, so without this a new
 * file inside a submodule of a submodule is invisible to untracked enumeration even
 * though the tracked listing recurses all the way down.
 */
export async function listGitSubmoduleDirectories(
  projectRoot: string,
  opts?: { gitAvailable?: boolean; recurse?: boolean },
): Promise<string[]> {
  return (await listGitStageSpecialPaths(projectRoot, opts)).gitlinks;
}

/**
 * Git's non-`.gitignore` ignore sources for `projectRoot`, paired with the directory
 * their patterns resolve against.
 *
 * Git consults the per-repository exclude file and the user's `core.excludesFile` in
 * addition to `.gitignore`, and matches both as if declared at the repository root.
 * Callers that filter paths Git never listed need these or they apply a strictly
 * narrower rule set than Git did. Missing or unset sources are omitted rather than
 * treated as an error, since neither is required to exist.
 */
export async function listGitExcludeFiles(
  projectRoot: string,
  opts?: { gitAvailable?: boolean },
): Promise<GitExcludeFile[]> {
  if (!(opts?.gitAvailable ?? true)) return [];
  const resolvedRoot = path.resolve(projectRoot);
  const cached = gitExcludeFileChecks.get(resolvedRoot);
  if (cached) return await cached;
  const check = listGitExcludeFilesUncached(resolvedRoot);
  gitExcludeFileChecks.set(resolvedRoot, check);
  return await check;
}

async function listGitExcludeFilesUncached(projectRoot: string): Promise<GitExcludeFile[]> {
  let baseDir: string;
  try {
    const { stdout } = await runGit(projectRoot, ["rev-parse", "--show-toplevel"]);
    baseDir = normalizePath(stdout.trim());
  } catch {
    return [];
  }
  if (!baseDir) return [];
  const candidates: Array<{ file: string; priority: number }> = [];
  try {
    // `--git-path` resolves `info/exclude` correctly when `.git` is a file, as it is in
    // linked worktrees and submodules, where guessing `<root>/.git/info` would miss it.
    const { stdout } = await runGit(projectRoot, ["rev-parse", "--git-path", "info/exclude"]);
    const resolved = stdout.trim();
    if (resolved) candidates.push({ file: normalizePath(path.resolve(projectRoot, resolved)), priority: 1 });
  } catch {
    // No exclude file for this repository layout.
  }
  try {
    const { stdout } = await runGit(projectRoot, ["config", "--get", "core.excludesFile"]);
    const configured = stdout.trim();
    if (configured) {
      const expanded = configured.startsWith("~")
        ? path.join(os.homedir(), configured.slice(1))
        : path.resolve(projectRoot, configured);
      candidates.push({ file: normalizePath(expanded), priority: 0 });
    }
  } catch {
    // `git config --get` exits non-zero when the key is unset.
  }
  const sources: GitExcludeFile[] = [];
  const uniqueCandidates = new Map<string, number>();
  for (const candidate of candidates) {
    uniqueCandidates.set(
      candidate.file,
      Math.max(uniqueCandidates.get(candidate.file) ?? candidate.priority, candidate.priority),
    );
  }
  for (const [file, priority] of uniqueCandidates) {
    try {
      if ((await fsp.stat(file)).isFile()) sources.push({ file, baseDir, priority });
    } catch {
      // Configured but absent; Git ignores it too.
    }
  }
  return sources;
}

/**
 * List files in the working tree that Git does not track (new, uncommitted files).
 *
 * Used to cheaply detect newly created project files without a full recursive
 * directory scan: combined with tracked manifest entries and a commit-range
 * diff, it lets incremental builds stay correct without re-walking the tree.
 * `respectGitignore` mirrors Git's own `--exclude-standard`; pass `false` only
 * when the caller intentionally wants gitignored files included. Callers still
 * need to apply their own project-pattern, ignore, and realpath confinement
 * checks before treating these paths as indexable project files.
 */
export async function listUntrackedFiles(
  projectRoot: string,
  opts?: { gitAvailable?: boolean; respectGitignore?: boolean },
): Promise<string[]> {
  const gitAvailable = opts?.gitAvailable ?? true;
  if (!gitAvailable) return [];
  const args = ["ls-files", "--others", "-z"];
  if (opts?.respectGitignore ?? true) args.push("--exclude-standard");
  try {
    const stdout = await runGitCollectStdout(projectRoot, args);
    // git ls-files -z NUL-delimits entries; the trailing split segment is always an
    // empty string, not a filename, so filter it out without trimming (a leading or
    // trailing whitespace character can be a legitimate part of a real filename).
    const relFiles = stdout.toString().split("\0").filter(Boolean);
    const out: string[] = [];
    for (const rel of relFiles) {
      const abs = resolveGitListedPath(projectRoot, rel);
      if (abs) out.push(abs);
    }
    return Array.from(new Set(out));
  } catch (error) {
    throw createGitError(projectRoot, args, error);
  }
}

/**
 * Get unified diff text from Git.
 * - base/head: compares commits in the explicit range `${base}..${head ?? "HEAD"}`.
 *   WORKTREE compares base to the working tree, and STAGED/INDEX compares base to the index.
 * - changedSince: runs `git diff <rev>` (that revision vs current working tree/index).
 */
export async function getUnifiedDiff(
  projectRoot: string,
  opts: {
    changedSince?: string | undefined;
    base?: string | undefined;
    head?: string | undefined;
  },
): Promise<string> {
  let args = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    "--unified=0",
    "--no-color",
    "--diff-filter=ACDMRTUXB",
  ];
  if (opts.base) {
    const head = opts.head ?? "HEAD";
    args = gitDiffArgs(opts.base, head, ["--unified=0", "--no-color", "--diff-filter=ACDMRTUXB"]);
  } else if (opts.changedSince) {
    args.push("--end-of-options", assertSafeRevision(opts.changedSince, "changedSince"));
  } else {
    return "";
  }
  args.push("--");
  try {
    return await runGitCollectStdout(projectRoot, args);
  } catch (error) {
    throw createGitError(projectRoot, args, error);
  }
}

export function isGitTimeoutError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : stringifyUnknown(error);
  return /timed out after \d+ms/i.test(detail);
}

function createGitError(projectRoot: string, args: string[], error: unknown): Error {
  let detail = stringifyUnknown(error);
  if (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    error.stderr.trim()
  ) {
    detail = error.stderr.trim();
  } else if (error instanceof Error && error.message) {
    detail = error.message;
  }
  return new Error(`git ${args.join(" ")} failed in ${projectRoot}: ${detail}`);
}
