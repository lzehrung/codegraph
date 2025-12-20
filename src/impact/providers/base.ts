import type { Diff, DiffProviderOptions } from "../types.js";
import { parseUnifiedDiff } from "../parse.js";

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

// Forward declarations - will be implemented in separate files
class GitDiffProvider implements DiffProvider {
  async getDiff(
    opts: Extract<DiffProviderOptions, { provider: "git" }>,
  ): Promise<Diff> {
    const { execSync } = await import("child_process");
    const cwd = opts.cwd || process.cwd();
    const cmd = `git diff --no-ext-diff --unified=0 ${opts.base}..${opts.head}`;
    try {
      const output = execSync(cmd, { cwd, encoding: "utf8" });
      return parseUnifiedDiff(output);
    } catch (error) {
      throw new Error(`Git diff failed: ${error}`);
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
    return parseUnifiedDiff(opts.diffText);
  }
}
