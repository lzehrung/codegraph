import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { applyEdits, buildProjectIndexFromFiles, extractFunction } from "../../src/index.js";
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

  test("rejects regions with return statements", async () => {
    await withFile("export function run() {\n  return 1;\n}\n", async (root, file) => {
      const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

      const result = await extractFunction(index, { file, range: lineRange(2, 3) }, { newName: "readValue" });

      expect(result.status).toBe("unsupported");
      expect(result.reason).toContain("return");
      expect(result.edits).toEqual([]);
    });
  });
});
