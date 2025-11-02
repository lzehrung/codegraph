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
  async getDiff(opts: Extract<DiffProviderOptions, { provider: "git" }>): Promise<Diff> {
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
  async getDiff(opts: Extract<DiffProviderOptions, { provider: "github" }>): Promise<Diff> {
    // TODO: Implement GitHub API call
    throw new Error("GitHub provider not yet implemented");
  }
}

class RawDiffProvider implements DiffProvider {
  async getDiff(opts: Extract<DiffProviderOptions, { provider: "raw" }>): Promise<Diff> {
    return parseUnifiedDiff(opts.diffText);
  }
}

