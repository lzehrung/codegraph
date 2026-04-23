import type { Diff, DiffProviderOptions } from "../types.js";
import { spawn } from "node:child_process";
import { parseUnifiedDiff, parseUnifiedDiffStreaming } from "../parse.js";

export interface DiffProvider {
  getDiff(opts: DiffProviderOptions): Promise<Diff>;
}

export async function getDiff(opts: DiffProviderOptions): Promise<Diff> {
  const provider = createProvider(opts.provider);
  return await provider.getDiff(opts);
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

async function runGitCommand(
  cwd: string,
  args: string[],
  rejectOnFailure: boolean,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    let closeCode: number | null = null;
    let stdoutEnded = false;

    const maybeResolve = () => {
      if (closeCode === null || !stdoutEnded) return;
      if (closeCode !== 0 && rejectOnFailure) {
        reject(
          new Error(
            `git ${args.join(" ")} failed with code ${closeCode}: ${stderr}`,
          ),
        );
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
  async getDiff(
    opts: Extract<DiffProviderOptions, { provider: "git" }>,
  ): Promise<Diff> {
    const cwd = opts.cwd || process.cwd();

    // Circuit breaker: check diff size first
    let warning: string | undefined;
    try {
      const statOutput = await runGitCommand(
        cwd,
        ["diff", "--shortstat", `${opts.base}..${opts.head}`],
        false,
      );
      if (statOutput) {
        const insertionMatch = statOutput.match(/(\d+) insertion/);
        const deletionMatch = statOutput.match(/(\d+) deletion/);
        const insertions = insertionMatch ? parseInt(insertionMatch[1]!) : 0;
        const deletions = deletionMatch ? parseInt(deletionMatch[1]!) : 0;

        if (insertions + deletions > 50000) {
          warning = `Large diff detected (${(
            insertions + deletions
          ).toLocaleString()} lines). Impact analysis may be incomplete or slow.`;
        }
      }
    } catch {
      // Ignore stat failures, proceed to full diff
    }

    const args = [
      "diff",
      "--no-ext-diff",
      "--unified=0",
      `${opts.base}..${opts.head}`,
    ];

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
      throw new Error(
        `Git diff failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

class GitHubDiffProvider implements DiffProvider {
  async getDiff(
    opts: Extract<DiffProviderOptions, { provider: "github" }>,
  ): Promise<Diff> {
    const [owner, repo] = opts.repo.split("/");
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${opts.pr}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3.diff",
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        "User-Agent": "codegraph-impact",
      },
    });
    if (!res.ok)
      throw new Error(`GitHub PR diff failed: ${res.status} ${res.statusText}`);
    const diffText = await res.text();
    return parseUnifiedDiff(diffText);
  }
}

class RawDiffProvider implements DiffProvider {
  async getDiff(
    opts: Extract<DiffProviderOptions, { provider: "raw" }>,
  ): Promise<Diff> {
    return Promise.resolve(parseUnifiedDiff(opts.diffText));
  }
}
