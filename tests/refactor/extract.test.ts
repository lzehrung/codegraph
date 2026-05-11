import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildProjectIndexFromFiles } from "../../src/index.js";
import { applyEdits, extractFunction } from "@lzehrung/codegraph-refactor";
import type { Range } from "../../src/types.js";

async function withFile<T>(source: string, fn: (root: string, file: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-extract-"));
  const file = path.join(root, "main.ts").replace(/\\/g, "/");
  try {
    await writeFile(file, source, "utf8");
    return await fn(root, file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function lineRange(startLine: number, endLine: number): Range {
  return {
    start: { line: startLine, column: 1 },
    end: { line: endLine, column: 1 },
  };
}

describe("extractFunction", () => {
  test("extracts contiguous TypeScript statements into a helper", async () => {
    await withFile(
      "export function run(name: string) {\n  const greeting = `hi ${name}`;\n  console.log(greeting);\n}\n",
      async (root, file) => {
        const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

        const result = await extractFunction(index, { file, range: lineRange(2, 4) }, { newName: "emitGreeting" });

        expect(result.status).toBe("ok");
        await applyEdits(result.edits);
        const source = await readFile(file, "utf8");
        expect(source).toContain("function emitGreeting(name)");
        expect(source).toContain("emitGreeting(name);");
        expect(source).toContain("const greeting = `hi ${name}`;");
        expect(source).toContain("export function run(name: string)");
        expect(source).not.toContain("export function emitGreeting");
      },
    );
  });

  test("passes outer locals used by the extracted statements", async () => {
    await withFile(
      "export function run(name: string) {\n  const prefix = 'hi';\n  console.log(prefix, name);\n}\n",
      async (root, file) => {
        const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

        const result = await extractFunction(index, { file, range: lineRange(3, 4) }, { newName: "emitGreeting" });

        expect(result.status).toBe("ok");
        await applyEdits(result.edits);
        const source = await readFile(file, "utf8");
        expect(source).toContain("function emitGreeting(name, prefix)");
        expect(source).toContain("emitGreeting(name, prefix);");
        expect(source).toContain("console.log(prefix, name);");
      },
    );
  });

  test("rejects extracted declarations used after the selected range", async () => {
    await withFile(
      "export function run(name: string) {\n  const greeting = `hi ${name}`;\n  console.log(greeting);\n}\n",
      async (root, file) => {
        const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

        const result = await extractFunction(index, { file, range: lineRange(2, 3) }, { newName: "makeGreeting" });

        expect(result.status).toBe("unsupported");
        expect(result.reason).toContain("used after");
        expect(result.edits).toEqual([]);
      },
    );
  });

  test("rejects later declarators used after the selected range", async () => {
    await withFile(
      "export function run() {\n  const first = 1, second = 2;\n  console.log(second);\n}\n",
      async (root, file) => {
        const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

        const result = await extractFunction(index, { file, range: lineRange(2, 3) }, { newName: "assignValues" });

        expect(result.status).toBe("unsupported");
        expect(result.reason).toContain("second");
        expect(result.edits).toEqual([]);
      },
    );
  });

  test("rejects regions with return statements", async () => {
    await withFile("export function run() {\n  return 1;\n}\n", async (root, file) => {
      const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

      const result = await extractFunction(index, { file, range: lineRange(2, 3) }, { newName: "readValue" });

      expect(result.status).toBe("unsupported");
      expect(result.reason).toContain("return");
      expect(result.edits).toEqual([]);
    });
  });

  test("rejects unsupported control flow and context-sensitive regions", async () => {
    await withFile(
      "export async function run(items: string[]) {\n  await Promise.resolve(items);\n}\n",
      async (root, file) => {
        const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

        const result = await extractFunction(index, { file, range: lineRange(2, 3) }, { newName: "loadItems" });

        expect(result.status).toBe("unsupported");
        expect(result.reason).toContain("unsupported control flow");
        expect(result.edits).toEqual([]);
      },
    );
  });
});
