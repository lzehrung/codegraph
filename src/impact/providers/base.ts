import type { Diff, DiffProviderOptions } from "../types.js";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { parseUnifiedDiff, parseUnifiedDiffStreaming } from "../parse.js";
import { gitDiffArgs } from "../../util/git.js";
import { errorMessage } from "../../util/errors.js";

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

function changedDiffLineCount(diff: Diff): number {
  let count = 0;
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+") || line.startsWith("-")) count++;
      }
    }
  }
  return count;
}

// Forward declarations - will be implemented in separate files
class GitDiffProvider implements DiffProvider {
  async getDiff(opts: Extract<DiffProviderOptions, { provider: "git" }>): Promise<Diff> {
    const cwd = opts.cwd || process.cwd();

    const args = gitDiffArgs(opts.base, opts.head, ["--no-ext-diff", "--unified=0"]);

    try {
      const child = spawn("git", args, { cwd });
      let stderr = "";
      child.stderr.on("data", (data) => {
        stderr += String(data);
      });
      const { promise: completion, resolve, reject } = Promise.withResolvers<number | null>();
      child.on("error", reject);
      child.on("close", resolve);

      const [diff, code] = await Promise.all([parseUnifiedDiffStreaming(child.stdout), completion]);
      if (code !== 0) {
        throw new Error(`Git diff failed with code ${code}: ${stderr}`);
      }
      const changedLines = changedDiffLineCount(diff);
      if (changedLines > LARGE_DIFF_LINE_WARNING_THRESHOLD) {
        diff.warning = `Large diff detected (${changedLines.toLocaleString()} lines). Impact analysis may be incomplete or slow.`;
      }
      return diff;
    } catch (error: unknown) {
      throw new Error(`Git diff failed: ${errorMessage(error)}`);
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
  const buffer = Buffer.from(diffText, "utf8");
  const end = byteEndForLimits(buffer, 0, limits);
  if (end >= buffer.length) return { text: diffText, truncated: false };
  return { text: buffer.subarray(0, safeUtf8End(buffer, end)).toString("utf8"), truncated: true };
}

function limitDiffReadable(
  stream: Readable,
  limits: { maxBytes: number; maxLines: number },
): { stream: AsyncGenerator<Buffer>; truncated: () => boolean } {
  let truncated = false;
  async function* generate(): AsyncGenerator<Buffer> {
    let bytesRead = 0;
    let newlinesRead = 0;
    for await (const chunk of stream) {
      const buffer = bufferFromStreamChunk(chunk);
      const end = byteEndForLimits(buffer, bytesRead, limits, newlinesRead);
      if (end > 0) {
        const next = buffer.subarray(0, safeUtf8End(buffer, end));
        bytesRead += next.length;
        newlinesRead += countNewlines(next);
        yield next;
      }
      if (end < buffer.length) {
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

function byteEndForLimits(
  buffer: Buffer,
  bytesRead: number,
  limits: { maxBytes: number; maxLines: number },
  newlinesRead = 0,
): number {
  const remainingBytes = Math.max(0, limits.maxBytes - bytesRead);
  const byteLimitEnd = Math.min(buffer.length, remainingBytes);
  const allowedNewlines = Math.max(0, limits.maxLines - 1);
  const remainingNewlines = Math.max(0, allowedNewlines - newlinesRead);
  const lineLimitEnd = byteEndBeforeForbiddenNewline(buffer, remainingNewlines);
  if (lineLimitEnd === undefined) return byteLimitEnd;
  return Math.min(byteLimitEnd, lineLimitEnd);
}

function byteEndBeforeForbiddenNewline(buffer: Buffer, remainingNewlines: number): number | undefined {
  let newlines = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] === 10) {
      if (newlines >= remainingNewlines) return index;
      newlines++;
    }
  }
  return undefined;
}

function safeUtf8End(buffer: Buffer, end: number): number {
  if (end >= buffer.length) return buffer.length;
  if (end <= 0) return 0;

  let characterStart = end;
  while (characterStart > 0 && isUtf8ContinuationByte(buffer[characterStart])) {
    characterStart--;
  }
  if (characterStart === end) return end;

  const leadByte = buffer[characterStart];
  const expectedLength = utf8SequenceLength(leadByte);
  if (expectedLength === undefined) return characterStart;
  if (characterStart + expectedLength <= end) return end;
  return characterStart;
}

function isUtf8ContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function utf8SequenceLength(byte: number | undefined): number | undefined {
  if (byte === undefined) return undefined;
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
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
