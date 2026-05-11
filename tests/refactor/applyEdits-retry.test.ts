import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { TextEdit } from "@lzehrung/codegraph-refactor";

const renameState = vi.hoisted(() => ({
  calls: 0,
  firstErrorCode: "EPERM" as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      renameState.calls += 1;
      if (renameState.calls === 1 && renameState.firstErrorCode) {
        const error = new Error("simulated transient contention");
        Object.assign(error, { code: renameState.firstErrorCode });
        throw error;
      }
      await actual.rename(oldPath, newPath);
    }),
  };
});

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "codegraph-refactor-retry-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function edit(file: string, start: number, end: number, newText: string): TextEdit {
  return { file, start, end, newText };
}

afterEach(() => {
  renameState.calls = 0;
  renameState.firstErrorCode = "EPERM";
});

describe("applyEdits atomic write retries", () => {
  test("retries transient rename contention and writes the edit", async () => {
    const { applyEdits } = await import("../../packages/codegraph-refactor/src/applyEdits.js");
    await withTempDir(async (dir) => {
      const file = path.join(dir, "sample.ts");

      const result = await applyEdits([edit(file, 0, 0, "export const value = 1;\n")]);

      await expect(readFile(file, "utf8")).resolves.toBe("export const value = 1;\n");
      expect(result.writes).toEqual([file]);
      expect(renameState.calls).toBe(2);
    });
  });

  test("replaces an existing destination after rename reports it already exists", async () => {
    renameState.firstErrorCode = "EEXIST";
    const { applyEdits } = await import("../../packages/codegraph-refactor/src/applyEdits.js");
    await withTempDir(async (dir) => {
      const file = path.join(dir, "sample.ts");
      await writeFile(file, "old\n", "utf8");

      const result = await applyEdits([edit(file, 0, 3, "new")]);

      await expect(readFile(file, "utf8")).resolves.toBe("new\n");
      expect(result.writes).toEqual([file]);
      expect(renameState.calls).toBe(2);
    });
  });
});
