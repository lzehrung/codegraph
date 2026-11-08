import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGitBlobHashes, setGitExecutableForTests } from "../src/util/git.js";
import { buildProjectIndex, buildProjectIndexIncremental, type BuildReport } from "../src/index.js";
import { closeDiskCacheDatabase } from "../src/indexer/build-cache.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";

const roots = createTempRootRegistry();

afterEach(async () => {
  setGitExecutableForTests(null);
  delete process.env.CODEGRAPH_GIT_CALLS_LOG;
  await roots.cleanup();
});

function normalize(file: string): string {
  return file.replace(/\\/g, "/");
}

async function repoWithFiles(files: Record<string, string>, config: Record<string, string> = {}): Promise<string> {
  const root = await roots.create("dg-git-blob-hashes-");
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.email", "blob@test.local"]);
  runGit(root, ["config", "user.name", "Blob Test"]);
  for (const [key, value] of Object.entries(config)) runGit(root, ["config", key, value]);
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(root, name);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, text, "utf8");
  }
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-q", "-m", "init"]);
  return root;
}

/** Records every Git argument list, then runs the real Git. */
async function recordGitCalls(): Promise<string> {
  const recorder = await roots.create("dg-git-recorder-");
  const log = path.join(recorder, "calls.log");
  const script = path.join(recorder, "recording-git.mjs");
  await fsp.writeFile(
    script,
    [
      'import { spawnSync } from "node:child_process";',
      'import fs from "node:fs";',
      "fs.appendFileSync(process.env.CODEGRAPH_GIT_CALLS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
      'const result = spawnSync("git", process.argv.slice(2), { stdio: "inherit", windowsHide: true });',
      "process.exit(result.status ?? 1);",
    ].join("\n"),
    "utf8",
  );
  process.env.CODEGRAPH_GIT_CALLS_LOG = log;
  setGitExecutableForTests(process.execPath, [script]);
  return log;
}

async function gitCalls(log: string): Promise<string[][]> {
  const text = await fsp.readFile(log, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

const FILES = {
  "clean.ts": "export const clean = 1;\n",
  "nested/dir/clean-too.ts": "export const cleanToo = 1;\n",
  "edited.ts": "export const edited = 1;\n",
  "hidden.ts": "export const hidden = 1;\n",
  "sparse.ts": "export const sparse = 1;\n",
};

describe("getGitBlobHashes", () => {
  it("returns the hash of the worktree content, edited or not, even where Git stops looking", async () => {
    const root = await repoWithFiles(FILES);
    // Edited, edited behind an assume-unchanged flag, and edited behind a skip-worktree flag.
    await fsp.writeFile(path.join(root, "edited.ts"), "export const edited = 2;\n", "utf8");
    runGit(root, ["update-index", "--assume-unchanged", "hidden.ts"]);
    await fsp.writeFile(path.join(root, "hidden.ts"), "export const hidden = 2;\n", "utf8");
    runGit(root, ["update-index", "--skip-worktree", "sparse.ts"]);
    await fsp.writeFile(path.join(root, "sparse.ts"), "export const sparse = 2;\n", "utf8");

    const files = Object.keys(FILES).map((name) => path.join(root, name));
    const hashes = await getGitBlobHashes(root, files);

    expect(hashes.size).toBe(files.length);
    for (const file of files) {
      expect(hashes.get(normalize(file))).toBe(runGit(root, ["hash-object", "--", file]));
    }
  });

  it("hashes only the files that Git reports as changed", async () => {
    const root = await repoWithFiles(FILES);
    await fsp.writeFile(path.join(root, "edited.ts"), "export const edited = 2;\n", "utf8");
    const log = await recordGitCalls();

    const files = Object.keys(FILES).map((name) => path.join(root, name));
    const hashes = await getGitBlobHashes(root, files);

    expect(hashes.size).toBe(files.length);
    const calls = await gitCalls(log);
    const hashCalls = calls.filter((args) => args[0] === "hash-object");
    expect(hashCalls).toHaveLength(1);
    expect(hashCalls[0]!.filter((arg) => arg.endsWith(".ts")).map((arg) => path.basename(arg))).toEqual(["edited.ts"]);
    expect(calls.filter((args) => args[0] === "ls-files")).toHaveLength(2);
  });

  it("reconciles restored and reverted files without hash-object for unchanged worktree bytes", async () => {
    const root = await repoWithFiles(FILES, { "core.autocrlf": "false" });
    const options = { cache: "disk" as const, threads: 1, logLevel: "silent" as const };
    const clean = path.join(root, "clean.ts");
    try {
      await buildProjectIndex(root, options);
      await fsp.unlink(clean);
      await buildProjectIndexIncremental(root, options);
      runGit(root, ["checkout", "--", "clean.ts"]);
      const log = await recordGitCalls();
      const restored = await buildProjectIndexIncremental(root, options);
      expect(restored.byFile.has(fileIdentityKey(clean))).toBe(true);
      let calls = await gitCalls(log);
      expect(calls.filter((args) => args[0] === "hash-object")).toEqual([]);
      expect(calls.filter((args) => args[0] === "ls-files" && args.includes("-v"))).toHaveLength(1);
      expect(calls.filter((args) => args[0] === "ls-files" && args.includes("-m"))).toHaveLength(1);

      await fsp.writeFile(log, "");
      const report: BuildReport = { timings: {} };
      await buildProjectIndexIncremental(root, { ...options, report });
      expect(report.files?.parsed).toBe(0);
      expect(report.files?.changed).toBe(0);
      expect((await gitCalls(log)).filter((args) => args[0] === "hash-object")).toEqual([]);

      await fsp.writeFile(clean, "export const changed = 2;\n");
      await fsp.writeFile(log, "");
      await buildProjectIndexIncremental(root, options);
      calls = await gitCalls(log);
      expect(calls.filter((args) => args[0] === "hash-object").flatMap((args) => args.slice(2))).toEqual([clean]);
      runGit(root, ["checkout", "--", "clean.ts"]);
      await fsp.writeFile(log, "");
      const reverted = await buildProjectIndexIncremental(root, options);
      expect(
        reverted.byFile
          .get(fileIdentityKey(clean))
          ?.exports.flatMap((entry) => (entry.type === "local" ? [entry.exportedAs] : [])),
      ).toEqual(["clean"]);
      expect((await gitCalls(log)).filter((args) => args[0] === "hash-object")).toEqual([]);
    } finally {
      closeDiskCacheDatabase(root, options);
    }
  });

  it("hashes every file in strict mode", async () => {
    const root = await repoWithFiles(FILES);
    const log = await recordGitCalls();

    const files = Object.keys(FILES).map((name) => path.join(root, name));
    const hashes = await getGitBlobHashes(root, files, { strict: true });

    expect(hashes.size).toBe(files.length);
    for (const file of files) {
      expect(hashes.get(normalize(file))).toBe(runGit(root, ["hash-object", "--", file]));
    }
    const hashed = (await gitCalls(log))
      .filter((args) => args[0] === "hash-object")
      .flatMap((args) => args.filter((arg) => arg.endsWith(".ts")).map((arg) => path.basename(arg)));
    expect(hashed.sort()).toEqual(
      Object.keys(FILES)
        .map((name) => path.basename(name))
        .sort(),
    );
  });

  it("leaves untracked files without a hash", async () => {
    const root = await repoWithFiles(FILES);
    await fsp.writeFile(path.join(root, "untracked.ts"), "export const untracked = 1;\n", "utf8");

    const hashes = await getGitBlobHashes(root, [path.join(root, "clean.ts"), path.join(root, "untracked.ts")]);

    expect([...hashes.keys()]).toEqual([normalize(path.join(root, "clean.ts"))]);
  });

  it("matches git hash-object under line-ending conversion, an intent-to-add entry, and an unmerged path", async () => {
    const root = await repoWithFiles(
      {
        ...FILES,
        "crlf.ts": "export const crlf = 1;\r\nexport const more = 2;\r\n",
        "conflict.ts": "export const k = 0;\n",
      },
      { "core.autocrlf": "true" },
    );
    runGit(root, ["checkout", "-q", "-b", "side"]);
    await fsp.writeFile(path.join(root, "conflict.ts"), "export const k = 1;\n", "utf8");
    runGit(root, ["commit", "-q", "-am", "side"]);
    runGit(root, ["checkout", "-q", "-"]);
    await fsp.writeFile(path.join(root, "conflict.ts"), "export const k = 2;\n", "utf8");
    runGit(root, ["commit", "-q", "-am", "main"]);
    expect(() => runGit(root, ["merge", "side"])).toThrow();
    await fsp.writeFile(path.join(root, "intent.ts"), "export const intent = 1;\n", "utf8");
    runGit(root, ["add", "-N", "intent.ts"]);

    const files = [...Object.keys(FILES), "crlf.ts", "conflict.ts", "intent.ts"].map((name) => path.join(root, name));
    const hashes = await getGitBlobHashes(root, files);

    expect(hashes.size).toBe(files.length);
    for (const file of files) {
      expect(hashes.get(normalize(file))).toBe(runGit(root, ["hash-object", "--", file]));
    }
  });
});
