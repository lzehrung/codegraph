import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitDiffArgs, getUnifiedDiff, listChangedFiles, listUntrackedFiles } from "../src/util.js";
import { decodeGitPath, runGit, setGitExecutableForTests } from "../src/util/git.js";
import { parseUnifiedDiff } from "../src/impact/parse.js";
import { runGit as git } from "./helpers/git.js";

function makeGitTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeGitTempDir(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

describe("git diff semantics", () => {
  it("uses explicit base..head ranges", async () => {
    const root = await makeGitTempDir("codegraph-git-range-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);

      const file = path.join(root, "a.ts");
      await fs.writeFile(file, "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      const base = git(root, ["rev-parse", "HEAD"]);

      await fs.writeFile(file, "export const a = 2;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "head"]);
      const head = git(root, ["rev-parse", "HEAD"]);

      const changed = await listChangedFiles(root, { base, head });
      expect(changed.some((entry) => entry.endsWith("/a.ts"))).toBe(true);

      const diff = await getUnifiedDiff(root, { base, head });
      expect(diff).toContain("diff --git a/a.ts b/a.ts");
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("uses changedSince as git diff <rev> against working tree/index", async () => {
    const root = await makeGitTempDir("codegraph-git-since-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);

      const file = path.join(root, "a.ts");
      await fs.writeFile(file, "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      const base = git(root, ["rev-parse", "HEAD"]);

      await fs.writeFile(file, "export const a = 3;\n", "utf8");

      const changed = await listChangedFiles(root, { changedSince: base });
      expect(changed.some((entry) => entry.endsWith("/a.ts"))).toBe(true);

      const diff = await getUnifiedDiff(root, { changedSince: base });
      expect(diff).toContain("+export const a = 3;");
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("supports WORKTREE as a base/head sentinel against the working tree", async () => {
    const root = await makeGitTempDir("codegraph-git-worktree-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);

      const modifiedFile = path.join(root, "a.ts");
      const addedFile = path.join(root, "b.ts");
      await fs.writeFile(modifiedFile, "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      const base = git(root, ["rev-parse", "HEAD"]);

      await fs.writeFile(modifiedFile, "export const a = 2;\n", "utf8");
      await fs.writeFile(addedFile, "export const b = 1;\n", "utf8");
      git(root, ["add", "b.ts"]);

      const changed = await listChangedFiles(root, { base, head: "WORKTREE" });
      expect(changed.some((entry) => entry.endsWith("/a.ts"))).toBe(true);
      expect(changed.some((entry) => entry.endsWith("/b.ts"))).toBe(true);

      const diff = await getUnifiedDiff(root, { base, head: "WORKTREE" });
      expect(diff).toContain("+export const a = 2;");
      expect(diff).toContain("diff --git a/b.ts b/b.ts");
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("supports STAGED and INDEX as base/head sentinels against the current index", async () => {
    const root = await makeGitTempDir("codegraph-git-index-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);

      const unstagedFile = path.join(root, "a.ts");
      const stagedFile = path.join(root, "b.ts");
      await fs.writeFile(unstagedFile, "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      const base = git(root, ["rev-parse", "HEAD"]);

      await fs.writeFile(unstagedFile, "export const a = 2;\n", "utf8");
      await fs.writeFile(stagedFile, "export const b = 1;\n", "utf8");
      git(root, ["add", "b.ts"]);

      const stagedChanged = await listChangedFiles(root, { base, head: "STAGED" });
      const indexChanged = await listChangedFiles(root, { base, head: "INDEX" });
      expect(stagedChanged.some((entry) => entry.endsWith("/b.ts"))).toBe(true);
      expect(stagedChanged.some((entry) => entry.endsWith("/a.ts"))).toBe(false);
      expect(indexChanged).toEqual(stagedChanged);

      const diff = await getUnifiedDiff(root, { base, head: "STAGED" });
      expect(diff).toContain("diff --git a/b.ts b/b.ts");
      expect(diff).not.toContain("+export const a = 2;");
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("surfaces invalid git revisions instead of returning empty results", async () => {
    const root = await makeGitTempDir("codegraph-git-invalid-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);

      const file = path.join(root, "a.ts");
      await fs.writeFile(file, "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      await expect(listChangedFiles(root, { base: "definitely-not-a-ref", head: "HEAD" })).rejects.toThrow(
        /definitely-not-a-ref/,
      );
      await expect(getUnifiedDiff(root, { base: "definitely-not-a-ref", head: "HEAD" })).rejects.toThrow(
        /definitely-not-a-ref/,
      );
    } finally {
      await removeGitTempDir(root);
    }
  });
  it("I10 reports metadata-only mode changes and combined diff diagnostics", () => {
    const modeChange = parseUnifiedDiff("diff --git a/a.ts b/a.ts\nold mode 100644\nnew mode 100755\n");
    expect(modeChange.files).toEqual([expect.objectContaining({ path: "a.ts", modeChanged: true, hunks: [] })]);

    const combined = parseUnifiedDiff("diff --cc a.ts\nindex 1111111,2222222..3333333\n@@@ -1 -1 +1 @@@\n");
    expect(combined.files).toEqual([]);
    expect(combined.warning).toMatch(/Combined\/merge diffs are not supported/);
  });
});

describe("git diff semantics: non-ASCII, space, and rename path handling (C12)", () => {
  it("returns non-ASCII, space, and leading/trailing-space filenames as real UTF-8, not git's quoted/escaped form", async () => {
    const root = await makeGitTempDir("codegraph-git-c12-names-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);

      await fs.writeFile(path.join(root, "café.ts"), "export const a = 1;\n", "utf8");
      await fs.writeFile(path.join(root, "with space.ts"), "export const b = 1;\n", "utf8");
      await fs.writeFile(path.join(root, " leading.ts"), "export const c = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      await fs.writeFile(path.join(root, "café.ts"), "export const a = 2;\n", "utf8");
      await fs.writeFile(path.join(root, "with space.ts"), "export const b = 2;\n", "utf8");
      await fs.writeFile(path.join(root, " leading.ts"), "export const c = 2;\n", "utf8");

      const changed = await listChangedFiles(root, { changedSince: "HEAD" });
      const names = changed.map((entry) => path.basename(entry)).sort();
      expect(names).toEqual(["café.ts", " leading.ts", "with space.ts"].sort());

      // getUnifiedDiff returns git's raw output verbatim (still quoted/octal-escaped for
      // café.ts, since that quoting comes from git itself); parseUnifiedDiff is what decodes
      // it, so assert against the parsed result rather than the raw diff text.
      const diff = await getUnifiedDiff(root, { changedSince: "HEAD" });
      const parsedDiff = parseUnifiedDiff(diff);
      expect(parsedDiff.files.map((file) => file.path).sort()).toEqual(
        ["café.ts", " leading.ts", "with space.ts"].sort(),
      );
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("propagates a rename to a non-ASCII (quoted) path through listChangedFiles and the parsed diff", async () => {
    const root = await makeGitTempDir("codegraph-git-c12-rename-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);

      await fs.writeFile(path.join(root, "plain.ts"), "export function run() {\n  return 1;\n}\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      git(root, ["mv", "plain.ts", "café-renamed.ts"]);
      git(root, ["add", "-A"]);

      const changed = await listChangedFiles(root, { base: "HEAD", head: "STAGED" });
      expect(changed.map((entry) => path.basename(entry))).toEqual(["café-renamed.ts"]);

      const diff = await getUnifiedDiff(root, { base: "HEAD", head: "STAGED" });
      const parsed = parseUnifiedDiff(diff);
      expect(parsed.files).toEqual([
        expect.objectContaining({ kind: "renamed", path: "café-renamed.ts", oldPath: "plain.ts" }),
      ]);
    } finally {
      await removeGitTempDir(root);
    }
  });
});

describe("git diff semantics: rename detection is deterministic regardless of user config (C4)", () => {
  it("still reports a pure rename with diff.renames=false configured locally", async () => {
    const root = await makeGitTempDir("codegraph-git-c4-renames-config-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      // A user (or repo) can disable git's default rename detection entirely. gitDiffArgs
      // must pass --find-renames explicitly so codegraph's own output does not silently
      // depend on this config.
      git(root, ["config", "diff.renames", "false"]);

      const original = "export function widget() {\n  return 1;\n}\n".repeat(3);
      await fs.writeFile(path.join(root, "widget.ts"), original, "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      const base = git(root, ["rev-parse", "HEAD"]);

      git(root, ["mv", "widget.ts", "renamed-widget.ts"]);
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "rename"]);
      const head = git(root, ["rev-parse", "HEAD"]);

      const diff = await getUnifiedDiff(root, { base, head });
      const parsed = parseUnifiedDiff(diff);

      expect(parsed.files).toEqual([
        expect.objectContaining({ kind: "renamed", path: "renamed-widget.ts", oldPath: "widget.ts" }),
      ]);
    } finally {
      await removeGitTempDir(root);
    }
  });
});

describe("Git C-style quoted path decoding", () => {
  it("preserves unquoted paths and decodes supported quote escapes", () => {
    const cases = [
      ["unquoted path with trailing ", "unquoted path with trailing "],
      ['"café.ts"', "café.ts"],
      ['"caf\\303\\251.ts"', "café.ts"],
      ['"emoji \\360\\237\\230\\200.ts"', "emoji 😀.ts"],
      ['"quote\\" and slash\\\\.ts"', 'quote" and slash\\.ts'],
      ['"tab\\tline\\ncarriage\\r.ts"', "tab\tline\ncarriage\r.ts"],
      ['"bell\\avtab\\vformfeed\\fbackspace\\b.ts"', "bell\x07vtab\x0bformfeed\x0cbackspace\x08.ts"],
      ['"\\1\\12\\123"', "\x01\nS"],
      ['"unknown\\qtrailing\\"', "unknown\\qtrailing\\"],
    ];

    for (const [rawPath, expected] of cases) {
      expect(decodeGitPath(rawPath)).toBe(expected);
    }
  });
});

describe("git subprocess stdout decoding across chunk boundaries", () => {
  afterEach(() => {
    setGitExecutableForTests(null);
  });

  it("reassembles a multibyte UTF-8 sequence split across separate stdout writes", async () => {
    const root = await makeGitTempDir("codegraph-git-chunk-split-");
    try {
      // The emoji U+1F600 encodes as 4 UTF-8 bytes (F0 9F 98 80); writing the first two
      // bytes, then yielding a macrotask before writing the rest, forces two independent
      // stdout "data" events. Decoding each chunk independently (the previous
      // `chunk.toString()` behavior) would replace both halves with U+FFFD instead of
      // reassembling the character. The 20ms delay runs inside the spawned child process
      // (a separate OS process/JS realm from this test), not this test file, so Vitest fake
      // timers cannot control it; a real, short delay is the only way to force two distinct
      // pipe writes.
      const script = [
        "process.stdout.write(Buffer.from([0x41, 0xf0, 0x9f]));",
        "setTimeout(() => {",
        "  process.stdout.write(Buffer.from([0x98, 0x80, 0x42]));",
        "  process.exit(0);",
        "}, 20);",
      ].join("\n");

      setGitExecutableForTests(process.execPath);
      const { stdout } = await runGit(root, ["-e", script]);
      expect(stdout).toBe("A\u{1f600}B");
    } finally {
      await removeGitTempDir(root);
    }
  });
});

describe("bounded and safe git diff execution (I7 and I8)", () => {
  afterEach(() => {
    setGitExecutableForTests(null);
  });

  it("I7 rejects oversized stderr while retaining only a bounded diagnostic tail", async () => {
    const root = await makeGitTempDir("codegraph-git-stderr-bound-");
    try {
      setGitExecutableForTests(process.execPath);
      const script = "process.stderr.write('x'.repeat(4096));";

      await expect(runGit(root, ["-e", script], { maxBuffer: 64 })).rejects.toThrow(
        /stderr exceeded maxBuffer \(64 bytes\)/,
      );
    } finally {
      await removeGitTempDir(root);
    }
  });
  it("trims stderr at a UTF-8 boundary while retaining the newest tail", async () => {
    const root = await makeGitTempDir("codegraph-git-stderr-utf8-bound-");
    try {
      setGitExecutableForTests(process.execPath);
      const maxBuffer = 7;
      // "prefix" + U+00E9 + "NEWEST" is 14 UTF-8 bytes. A seven-byte tail
      // starts at the continuation byte of U+00E9, so trimming must skip that
      // partial codepoint.
      const script = "process.stderr.write('prefix\\u00e9NEWEST');";
      const errorMessage = await runGit(root, ["-e", script], { maxBuffer }).then(
        () => "runGit unexpectedly resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

      const tailStart = errorMessage.indexOf("): ");
      const diagnosticTail = tailStart >= 0 ? errorMessage.slice(tailStart + 3) : "";
      expect(errorMessage).toContain(`stderr exceeded maxBuffer (${maxBuffer} bytes)`);
      expect(errorMessage).not.toContain("\uFFFD");
      expect(Buffer.byteLength(diagnosticTail, "utf8")).toBeLessThanOrEqual(maxBuffer);
      expect(diagnosticTail).toBe("NEWEST");
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("I8 never permits configured external diff or text conversion helpers", () => {
    expect(gitDiffArgs("HEAD", "WORKTREE")).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv"]));
  });
});

describe("listUntrackedFiles", () => {
  it("lists new files Git has not been told to track", async () => {
    const root = await makeGitTempDir("codegraph-git-untracked-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);

      const trackedFile = path.join(root, "tracked.ts");
      await fs.writeFile(trackedFile, "export const tracked = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      const untrackedFile = path.join(root, "fresh.ts");
      await fs.writeFile(untrackedFile, "export const fresh = 1;\n", "utf8");

      const untracked = await listUntrackedFiles(root);
      expect(untracked.some((entry) => entry.endsWith("/fresh.ts"))).toBe(true);
      expect(untracked.some((entry) => entry.endsWith("/tracked.ts"))).toBe(false);
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("excludes gitignored untracked files by default and includes them when respectGitignore is false", async () => {
    const root = await makeGitTempDir("codegraph-git-untracked-ignore-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, ".gitignore"), "ignored.ts\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      await fs.writeFile(path.join(root, "ignored.ts"), "export const ignored = 1;\n", "utf8");
      await fs.writeFile(path.join(root, "kept.ts"), "export const kept = 1;\n", "utf8");

      const respectingGitignore = await listUntrackedFiles(root);
      expect(respectingGitignore.some((entry) => entry.endsWith("/kept.ts"))).toBe(true);
      expect(respectingGitignore.some((entry) => entry.endsWith("/ignored.ts"))).toBe(false);

      const allUntracked = await listUntrackedFiles(root, { respectGitignore: false });
      expect(allUntracked.some((entry) => entry.endsWith("/ignored.ts"))).toBe(true);
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("returns an empty list without invoking Git when gitAvailable is false", async () => {
    const root = await makeGitTempDir("codegraph-git-untracked-unavailable-");
    try {
      // No `git init`: any accidental git invocation here would throw, not return [].
      const untracked = await listUntrackedFiles(root, { gitAvailable: false });
      expect(untracked).toEqual([]);
    } finally {
      await removeGitTempDir(root);
    }
  });

  it("surfaces Git failures instead of silently returning an empty list", async () => {
    const root = await makeGitTempDir("codegraph-git-untracked-not-a-repo-");
    try {
      // No `git init`, so `git ls-files` fails; callers decide their own fallback policy.
      await expect(listUntrackedFiles(root)).rejects.toThrow();
    } finally {
      await removeGitTempDir(root);
    }
  });
});
