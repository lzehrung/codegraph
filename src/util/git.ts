import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { stringifyUnknown } from "./ast.js";
import { normalizePath } from "./paths.js";

const execFileAsync = promisify(execFile);

export function isGitWorktreeSentinel(value: string): boolean {
  return value.toUpperCase() === "WORKTREE";
}

export function isGitIndexSentinel(value: string): boolean {
  const normalized = value.toUpperCase();
  return normalized === "INDEX" || normalized === "STAGED";
}

export function assertSafeRevision(value: string, label: string): string {
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
  if (isGitWorktreeSentinel(head)) {
    return ["diff", ...extraArgs, "--end-of-options", safeBase];
  }
  if (isGitIndexSentinel(head)) {
    return ["diff", "--cached", ...extraArgs, "--end-of-options", safeBase];
  }
  const safeHead = assertSafeRevision(head, "head");
  return ["diff", ...extraArgs, "--end-of-options", `${safeBase}..${safeHead}`];
}
export async function getGitHead(projectRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      env: process.env,
    });
    const hash = stdout?.toString().trim();
    return hash || null;
  } catch {
    return null;
  }
}

export async function isGitRepo(projectRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: projectRoot,
      env: process.env,
    });
    return stdout?.toString().trim() === "true";
  } catch {
    return false;
  }
}

export async function getGitBlobHash(
  projectRoot: string,
  file: string,
  opts?: { gitAvailable?: boolean },
): Promise<string | null> {
  try {
    const gitAvailable = opts?.gitAvailable ?? true;
    if (!gitAvailable) return null;
    const relPath = normalizePath(path.relative(projectRoot, file));
    if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
      return null;
    }
    await execFileAsync("git", ["ls-files", "--error-unmatch", relPath], {
      cwd: projectRoot,
      env: process.env,
    });
    const { stdout } = await execFileAsync("git", ["hash-object", relPath], {
      cwd: projectRoot,
      env: process.env,
    });
    const hash = stdout?.toString().trim();
    return hash || null;
  } catch {
    return null;
  }
}

export async function getGitBlobHashes(
  projectRoot: string,
  files: string[],
  opts?: { gitAvailable?: boolean },
): Promise<Map<string, string>> {
  const gitAvailable = opts?.gitAvailable ?? true;
  if (!gitAvailable) return new Map();
  const relFiles = Array.from(
    new Set(
      files
        .map((file) => normalizePath(path.relative(projectRoot, file)))
        .filter((rel) => rel && !rel.startsWith("..") && !path.isAbsolute(rel) && rel !== "."),
    ),
  );
  if (!relFiles.length) return new Map();
  try {
    const { stdout: trackedStdout } = await execFileAsync("git", ["ls-files", "-z", "--", ...relFiles], {
      cwd: projectRoot,
      env: process.env,
    });
    const trackedRel = trackedStdout
      .toString()
      .split("\0")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!trackedRel.length) return new Map();
    const hashes = await new Promise<string[]>((resolve, reject) => {
      const child = spawn("git", ["hash-object", "--stdin-paths"], {
        cwd: projectRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += typeof chunk === "string" ? chunk : chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += typeof chunk === "string" ? chunk : chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`git hash-object failed (${code}): ${stderr || "unknown error"}`));
          return;
        }
        resolve(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        );
      });
      child.stdin.write(trackedRel.join("\n"));
      child.stdin.end();
    });
    if (hashes.length !== trackedRel.length) return new Map();
    const out = new Map<string, string>();
    for (let i = 0; i < trackedRel.length; i += 1) {
      const rel = trackedRel[i]!;
      const hash = hashes[i];
      if (!hash) continue;
      const abs = normalizePath(path.resolve(projectRoot, rel));
      out.set(abs, hash);
    }
    return out;
  } catch {
    return new Map();
  }
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
  let args = ["diff", "--name-only", "--diff-filter=ACDMRTUXB"];
  if (opts.base) {
    const head = opts.head ?? "HEAD";
    args = gitDiffArgs(opts.base, head, ["--name-only", "--diff-filter=ACDMRTUXB"]);
  } else if (opts.changedSince) {
    args.push("--end-of-options", assertSafeRevision(opts.changedSince, "changedSince"));
  } else {
    return [];
  }
  args.push("--");
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: projectRoot,
      env: process.env,
    });
    const relFiles = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const out: string[] = [];
    for (const rel of relFiles) {
      const abs = normalizePath(path.resolve(projectRoot, rel));
      if (abs) out.push(abs);
    }
    return Array.from(new Set(out));
  } catch (error) {
    throw createGitDiffError(projectRoot, args, error);
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
  let args = ["diff", "--unified=0", "--no-color", "--diff-filter=ACDMRTUXB"];
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
    const { stdout } = await execFileAsync("git", args, {
      cwd: projectRoot,
      env: process.env,
    });
    return stdout;
  } catch (error) {
    throw createGitDiffError(projectRoot, args, error);
  }
}

function createGitDiffError(projectRoot: string, args: string[], error: unknown): Error {
  let detail = stringifyUnknown(error);
  if (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    error.stderr.trim()
  ) {
    detail = error.stderr.trim();
  }
  return new Error(`git ${args.join(" ")} failed in ${projectRoot}: ${detail}`);
}
