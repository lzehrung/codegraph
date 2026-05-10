import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { applyEdits, type TextEdit } from "../../src/index.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "codegraph-refactor-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function edit(file: string, start: number, end: number, newText: string): TextEdit {
  return { file, start, end, newText };
}

describe("applyEdits", () => {
  test("applies multiple edits in one file without offset drift", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "sample.ts");
      await writeFile(file, "alpha beta gamma\n", "utf8");

      const result = await applyEdits([edit(file, 6, 10, "BETA"), edit(file, 0, 5, "ALPHA")]);

      await expect(readFile(file, "utf8")).resolves.toBe("ALPHA BETA gamma\n");
      expect(result.writes).toEqual([file]);
      expect(result.conflicts).toEqual([]);
      expect(result.skipped).toEqual([]);
    });
  });

  test("skips the entire file when edits overlap", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "sample.ts");
      await writeFile(file, "abcdef\n", "utf8");

      const result = await applyEdits([edit(file, 1, 4, "X"), edit(file, 3, 5, "Y")]);

      await expect(readFile(file, "utf8")).resolves.toBe("abcdef\n");
      expect(result.writes).toEqual([]);
      expect(result.conflicts).toEqual([file]);
      expect(result.skipped).toEqual([]);
    });
  });

  test("dryRun previews post-edit text without writing", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "sample.ts");
      await writeFile(file, "one two\n", "utf8");

      const result = await applyEdits([edit(file, 4, 7, "three")], { dryRun: true });

      await expect(readFile(file, "utf8")).resolves.toBe("one two\n");
      expect(result.writes).toEqual([]);
      expect(result.previews[file]).toBe("one three\n");
    });
  });

  test("preserves CRLF line endings for inserted text", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "sample.ts");
      await writeFile(file, "one\r\ntwo\r\n", "utf8");

      await applyEdits([edit(file, 5, 5, "middle\n")]);

      await expect(readFile(file, "utf8")).resolves.toBe("one\r\nmiddle\r\ntwo\r\n");
    });
  });

  test("stages newly created files relative to the requested git root", async () => {
    await withTempDir(async (dir) => {
      execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
      const file = path.join(dir, "src", "created.ts");
      const previousCwd = process.cwd();
      process.chdir(tmpdir());
      try {
        const result = await applyEdits([edit(file, 0, 0, "export const created = 1;\n")], {
          useGit: true,
          gitCwd: dir,
        });

        expect(result.writes).toEqual([file]);
        expect(result.warnings).toEqual([]);
        const status = execFileSync("git", ["status", "--short"], { cwd: dir, encoding: "utf8" });
        expect(status).toContain("A  src/created.ts");
      } finally {
        process.chdir(previousCwd);
      }
    });
  });

  test("keeps successful writes when git staging fails and reports a warning", async () => {
    await withTempDir(async (dir) => {
      const nonRepo = path.join(dir, "not-a-repo");
      const file = path.join(dir, "created.ts");
      await mkdir(nonRepo, { recursive: true });

      const result = await applyEdits([edit(file, 0, 0, "export const created = 1;\n")], {
        useGit: true,
        gitCwd: nonRepo,
      });

      await expect(readFile(file, "utf8")).resolves.toBe("export const created = 1;\n");
      expect(result.writes).toEqual([file]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("git add failed");
    });
  });
});
