import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";

import {
  clearGitDiscoveryCacheForTests,
  clearGitRepositoryCheckCacheForTests,
  DEFAULT_GIT_TIMEOUT_MS,
  getGitHead,
  isGitRepo,
  runGit,
  setGitExecutableForTests,
} from "../src/util/git.js";
import { runGit as runRealGitHelper } from "./helpers/git.js";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !pidAlive(pid);
}

afterEach(() => {
  setGitExecutableForTests(null);
  clearGitRepositoryCheckCacheForTests();
  clearGitDiscoveryCacheForTests();
});

describe("bounded Git execution", () => {
  it("documents the default timeout used to unbound hung helpers", () => {
    expect(DEFAULT_GIT_TIMEOUT_MS).toBe(30_000);
  });

  it("terminates a hung fake Git child and rejects within the controlled timeout", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-git-timeout-"));
    let childPid: number | undefined;
    const timeoutMs = 250;
    const started = Date.now();

    setGitExecutableForTests(process.execPath);
    try {
      await expect(
        runGit(root, ["-e", "setInterval(() => {}, 1000)"], {
          timeoutMs,
          onSpawn: (child) => {
            childPid = child.pid;
          },
        }),
      ).rejects.toThrow(/timed out after 250ms/i);

      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 50);
      expect(elapsed).toBeLessThan(timeoutMs + 5_000);
      expect(childPid).toEqual(expect.any(Number));
      expect(await waitForPidExit(childPid!, 5_000)).toBe(true);
    } finally {
      if (childPid && pidAlive(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // ignore cleanup races
        }
      }
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves ordinary Git success paths under the bounded runner", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-git-ok-"));
    try {
      runRealGitHelper(root, ["init"]);
      runRealGitHelper(root, ["config", "user.email", "test@example.com"]);
      runRealGitHelper(root, ["config", "user.name", "Test"]);
      await fsp.writeFile(path.join(root, "README.md"), "hello\n", "utf8");
      runRealGitHelper(root, ["add", "README.md"]);
      runRealGitHelper(root, ["commit", "-m", "init"]);

      expect(await isGitRepo(root)).toBe(true);
      const head = await getGitHead(root);
      expect(head).toMatch(/^[0-9a-f]{40}$/i);

      const { stdout } = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
      expect(stdout.trim()).toBe("true");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
