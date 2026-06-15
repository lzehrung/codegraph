import type { Diff, DiffProviderOptions } from "../types.js";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { parseUnifiedDiff, parseUnifiedDiffStreaming } from "../parse.js";
import { gitDiffArgs } from "../../util/git.js";

const LARGE_DIFF_LINE_WARNING_THRESHOLD = 50_000;
const DEFAULT_GITHUB_DIFF_TIMEOUT_MS = 30_000;
const DEFAULT_GITHUB_DIFF_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_GITHUB_DIFF_MAX_LINES = 100_000;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface DiffProvider {
  getDiff(opts: DiffProviderOptions): Promise<Diff>;
}

export async function getDiff(opts: DiffProviderOptions): Promise<Diff> {
  const provider = createProvider(opts.provider);
  return await provider.getDiff(opts);
}

export function parseGitHubRepo(repo: string): { owner: string; repo: string } {
  if (!GITHUB_REPO_PATTERN.test(repo)) {
    throw new Error(`Invalid GitHub repo "${repo}". Expected owner/name.`);
  }
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) {
    throw new Error(`Invalid GitHub repo "${repo}". Expected owner/name.`);
  }
  return { owner, repo: repoName };
}

function createProvider(providerType: string): DiffProvider {
  switch (providerType) {
    case "git":
      return new GitDiffProvider();
    case "github":
      return new GitHubDiffProvider();
    case "raw":
      return new RawDiffProvider();
    default:
      throw new Error(`Unknown diff provider: ${providerType}`);
  }
}

async function runGitCommand(cwd: string, args: string[], rejectOnFailure: boolean): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    let closeCode: number | null = null;
    let stdoutEnded = false;

    const maybeResolve = () => {
      if (closeCode === null || !stdoutEnded) return;
      if (closeCode !== 0 && rejectOnFailure) {
        reject(new Error(`git ${args.join(" ")} failed with code ${closeCode}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    };

    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stdout.on("end", () => {
      stdoutEnded = true;
      maybeResolve();
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("close", (code) => {
      closeCode = code ?? 0;
      maybeResolve();
    });
    child.on("error", reject);
  });
}

// Forward declarations - will be implemented in separate files
class GitDiffProvider implements DiffProvider {
  async getDiff(opts: Extract<DiffProviderOptions, { provider: "git" }>): Promise<Diff> {
    const cwd = opts.cwd || process.cwd();

    // Circuit breaker: check diff size first
    let warning: string | undefined;
    try {
      const statOutput = await runGitCommand(cwd, gitDiffArgs(opts.base, opts.head, ["--shortstat"]), false);
      if (statOutput) {
        const insertionMatch = statOutput.match(/(\d+) insertion/);
        const deletionMatch = statOutput.match(/(\d+) deletion/);
        const insertions = insertionMatch ? parseInt(insertionMatch[1]!) : 0;
        const deletions = deletionMatch ? parseInt(deletionMatch[1]!) : 0;

        if (insertions + deletions > LARGE_DIFF_LINE_WARNING_THRESHOLD) {
          warning = `Large diff detected (${(insertions + deletions).toLocaleString()} lines). Impact analysis may be incomplete or slow.`;
        }
      }
    } catch {
      // Ignore stat failures, proceed to full diff
    }

    const args = gitDiffArgs(opts.base, opts.head, ["--no-ext-diff", "--unified=0"]);

    try {
      const child = spawn("git", args, { cwd });
      let stderr = "";
      child.stderr.on("data", (data) => {
        stderr += String(data);
      });

      const diff = await parseUnifiedDiffStreaming(child.stdout);

      return new Promise((resolve, reject) => {
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`Git diff failed with code ${code}: ${stderr}`));
          } else {
            if (warning) diff.warning = warning;
            resolve(diff);
          }
        });
      });
    } catch (error: unknown) {
      throw new Error(`Git diff failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

class GitHubDiffProvider implements DiffProvider {
  async getDiff(opts: Extract<DiffProviderOptions, { provider: "github" }>): Promise<Diff> {
    const { owner, repo } = parseGitHubRepo(opts.repo);
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${opts.pr}`;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_GITHUB_DIFF_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/vnd.github.v3.diff",
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          "User-Agent": "codegraph-impact",
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`GitHub PR diff failed: ${res.status} ${res.statusText}`);
      return await parseGitHubDiffResponse(res, {
        maxBytes: opts.maxBytes ?? DEFAULT_GITHUB_DIFF_MAX_BYTES,
        maxLines: opts.maxLines ?? DEFAULT_GITHUB_DIFF_MAX_LINES,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`GitHub PR diff timed out after ${timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function parseGitHubDiffResponse(res: Response, limits: { maxBytes: number; maxLines: number }): Promise<Diff> {
  if (!res.body) {
    const diffText = await res.text();
    const limited = limitDiffText(diffText, limits);
    const diff = parseUnifiedDiff(limited.text);
    if (limited.truncated) diff.warning = githubDiffLimitWarning(limits);
    return diff;
  }
  const limited = limitDiffReadable(Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>), limits);
  const diff = await parseUnifiedDiffStreaming(Readable.from(limited.stream));
  if (limited.truncated()) {
    diff.warning = githubDiffLimitWarning(limits);
  }
  return diff;
}

function limitDiffText(
  diffText: string,
  limits: { maxBytes: number; maxLines: number },
): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(diffText, "utf8");
  const lines = diffText.split(/\r?\n/);
  if (bytes <= limits.maxBytes && lines.length <= limits.maxLines) return { text: diffText, truncated: false };
  return { text: lines.slice(0, limits.maxLines).join("\n").slice(0, limits.maxBytes), truncated: true };
}

function limitDiffReadable(
  stream: Readable,
  limits: { maxBytes: number; maxLines: number },
): { stream: AsyncGenerator<Buffer>; truncated: () => boolean } {
  let truncated = false;
  async function* generate(): AsyncGenerator<Buffer> {
    let bytesRead = 0;
    let linesRead = 0;
    for await (const chunk of stream) {
      const buffer = bufferFromStreamChunk(chunk);
      const byteLimitEnd = bytesRead + buffer.length > limits.maxBytes ? limits.maxBytes - bytesRead : buffer.length;
      const lineLimitEnd = byteEndForLineLimit(buffer, Math.max(0, limits.maxLines - linesRead));
      const end = lineLimitEnd === undefined ? byteLimitEnd : Math.min(byteLimitEnd, lineLimitEnd);
      if (end > 0) {
        const next = buffer.subarray(0, end);
        bytesRead += next.length;
        linesRead += countNewlines(next);
        yield next;
      }
      if (end < buffer.length || bytesRead >= limits.maxBytes || linesRead >= limits.maxLines) {
        truncated = true;
        break;
      }
    }
  }
  return {
    stream: generate(),
    truncated: () => truncated,
  };
}

function bufferFromStreamChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

function byteEndForLineLimit(buffer: Buffer, remainingLines: number): number | undefined {
  if (remainingLines <= 0) return 0;
  let lines = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] === 10) {
      lines++;
      if (lines >= remainingLines) return index + 1;
    }
  }
  return undefined;
}

function countNewlines(buffer: Buffer): number {
  let count = 0;
  for (const byte of buffer) {
    if (byte === 10) count++;
  }
  return count;
}

function githubDiffLimitWarning(limits: { maxBytes: number; maxLines: number }): string {
  return `GitHub PR diff exceeded ${limits.maxBytes.toLocaleString()} bytes or ${limits.maxLines.toLocaleString()} lines and was truncated. Impact analysis may be incomplete.`;
}

class RawDiffProvider implements DiffProvider {
  async getDiff(opts: Extract<DiffProviderOptions, { provider: "raw" }>): Promise<Diff> {
    return Promise.resolve(parseUnifiedDiff(opts.diffText));
  }
}
