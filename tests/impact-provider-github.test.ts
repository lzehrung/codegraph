import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, it, expect, vi } from "vitest";
import { getDiff } from "../src/impact/providers/base.js";
import { gitDiffArgs } from "../src/util/git.js";
import { runGit as git } from "./helpers/git.js";

const gitRepoRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of gitRepoRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function diffResponse(diff: string): Response {
  return {
    ok: true,
    body: Readable.toWeb(Readable.from([diff])) as Response["body"],
    status: 200,
    statusText: "OK",
    headers: new Headers(),
  } as Response;
}

function textDiffResponse(diff: string): Response {
  return {
    ok: true,
    body: null,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    text: async () => diff,
  } as Response;
}

function createGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-github-provider-"));
  gitRepoRoots.push(root);
  git(root, ["init"]);
  git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(root, ["config", "core.autocrlf", "false"]);
  return root;
}

function writeFile(root: string, relativePath: string, text: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function commitAll(root: string, message: string): string {
  git(root, ["add", "."]);
  git(root, ["commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

describe("Impact: GitHub provider", () => {
  it("fetches PR diff with correct Accept header and parses diff", async () => {
    const abs = "/tmp/fake.ts";
    const diff = `diff --git a/${abs} b/${abs}
index 0000000..1111111 100644
--- a/${abs}
+++ b/${abs}
@@ -1,0 +1,1 @@
+// changed
`;
    const mock = vi.spyOn(global, "fetch").mockResolvedValue(diffResponse(diff));

    const res = await getDiff({ provider: "github", repo: "owner/repo", pr: 123 });
    expect(mock).toHaveBeenCalled();
    const args = mock.mock.calls[0]![1]!;
    expect(new Headers(args.headers).get("Accept")).toBe("application/vnd.github.v3.diff");
    expect(res.files.length).toBe(1);
    expect(res.files[0].path).toBe(abs);
  });

  it("fails GitHub diff fetches after the configured timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(global, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );

    const pending = getDiff({ provider: "github", repo: "owner/repo", pr: 123, timeoutMs: 10 });
    const assertion = expect(pending).rejects.toThrow("GitHub PR diff timed out after 10ms");
    await vi.advanceTimersByTimeAsync(10);

    await assertion;
  });

  it("reports GitHub HTTP failures", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers(),
    } as Response);

    await expect(getDiff({ provider: "github", repo: "owner/repo", pr: 123 })).rejects.toThrow(
      "GitHub PR diff failed: 404 Not Found",
    );
  });

  it("rejects malformed GitHub repos before fetching", async () => {
    const mock = vi.spyOn(global, "fetch");

    await expect(getDiff({ provider: "github", repo: "owner/repo/extra", pr: 123 })).rejects.toThrow(
      'Invalid GitHub repo "owner/repo/extra"',
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it("returns an explicit warning when remote diffs exceed configured limits", async () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,0 +1,3 @@
+export const a = 1;
+export const b = 2;
+export const c = 3;
`;
    vi.spyOn(global, "fetch").mockResolvedValue(diffResponse(diff));

    const res = await getDiff({ provider: "github", repo: "owner/repo", pr: 123, maxLines: 5 });

    expect(res.warning).toContain("GitHub PR diff exceeded");
    expect(res.files.length).toBe(1);
    expect(res.files[0].hunks[0]?.lines).toEqual(["+export const a = 1;"]);
  });

  it("applies GitHub maxBytes as a UTF-8 byte limit for buffered response text", async () => {
    const content = "界".repeat(32);
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,0 +1,1 @@
+${content}
`;
    vi.spyOn(global, "fetch").mockResolvedValue(textDiffResponse(diff));

    const res = await getDiff({ provider: "github", repo: "owner/repo", pr: 123, maxBytes: diff.length + 1 });

    expect(Buffer.byteLength(diff, "utf8")).toBeGreaterThan(diff.length + 1);
    expect(res.warning).toContain("GitHub PR diff exceeded");
    expect(res.files[0].hunks[0]?.lines).not.toContain(`+${content}`);
  });

  it("parses equivalent local git and GitHub provider diffs for the same fixture", async () => {
    const root = createGitRepo();
    writeFile(
      root,
      "src/main.ts",
      `export function main() {
  return 1;
}
`,
    );
    const base = commitAll(root, "initial");

    writeFile(
      root,
      "src/main.ts",
      `export function main() {
  return 2;
}
`,
    );
    writeFile(root, "src/feature.ts", "export const feature = true;\n");
    const head = commitAll(root, "change");
    const diff = git(root, gitDiffArgs(base, head, ["--no-ext-diff", "--unified=0"]));
    vi.spyOn(global, "fetch").mockResolvedValue(diffResponse(diff));

    const local = await getDiff({ provider: "git", cwd: root, base, head });
    const remote = await getDiff({ provider: "github", repo: "owner/repo", pr: 123 });

    expect(remote.files).toEqual(local.files);
  });
});
