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
        expect(source).toContain("function emitGreeting(name: string)");
        expect(source).toContain("emitGreeting(name);");
        expect(source).toContain("const greeting = `hi ${name}`;");
        expect(source).toContain("export function run(name: string)");
        expect(source).not.toContain("export function emitGreeting");
      },
    );
  });

  test("preserves simple TypeScript parameter annotations in extracted helpers", async () => {
    await withFile(
      "export function run(name: string, count?: number) {\n  console.log(name, count);\n}\n",
      async (root, file) => {
        const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

        const result = await extractFunction(index, { file, range: lineRange(2, 3) }, { newName: "emitName" });

        expect(result.status).toBe("ok");
        await applyEdits(result.edits);
        const source = await readFile(file, "utf8");
        expect(source).toContain("function emitName(name: string, count?: number)");
        expect(source).toContain("emitName(name, count);");
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
        expect(source).toContain("function emitGreeting(name: string, prefix)");
        expect(source).toContain("emitGreeting(name, prefix);");
        expect(source).toContain("console.log(prefix, name);");
      },
    );
  });

  test("ignores identifiers and control-flow words inside strings and comments", async () => {
    await withFile(
      "export function run(name: string) {\n  const prefix = 'hi';\n  console.log('prefix return'); // name\n}\n",
      async (root, file) => {
        const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

        const result = await extractFunction(index, { file, range: lineRange(3, 4) }, { newName: "emitLiteral" });

        expect(result.status).toBe("ok");
        await applyEdits(result.edits);
        const source = await readFile(file, "utf8");
        expect(source).toContain("function emitLiteral()");
        expect(source).toContain("emitLiteral();");
        expect(source).not.toContain("function emitLiteral(name, prefix)");
      },
    );
  });

  test("ignores braces inside strings and comments when locating the containing function", async () => {
    await withFile(
      "export function run(name: string) {\n  const pattern = \"}\";\n  // { ignored\n  console.log(name, pattern);\n}\n",
      async (root, file) => {
        const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

        const result = await extractFunction(index, { file, range: lineRange(4, 5) }, { newName: "emitPattern" });

        expect(result.status).toBe("ok");
        await applyEdits(result.edits);
        const source = await readFile(file, "utf8");
        expect(source).toContain("function emitPattern(name: string, pattern)");
        expect(source).toContain("emitPattern(name, pattern);");
      },
    );
  });

  test("ignores function declarations inside comments when locating the containing function", async () => {
    await withFile(
      "// function fake() {\n//   console.log('not code');\n// }\nexport function run(name: string) {\n  console.log(name);\n}\n",
      async (root, file) => {
        const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

        const result = await extractFunction(index, { file, range: lineRange(5, 6) }, { newName: "emitName" });

        expect(result.status).toBe("ok");
        await applyEdits(result.edits);
        const source = await readFile(file, "utf8");
        expect(source).toContain("// function fake()");
        expect(source).toContain("function emitName(name: string)");
        expect(source.indexOf("function emitName(name: string)")).toBeLessThan(source.indexOf("export function run"));
        expect(source.indexOf("function emitName(name: string)")).toBeGreaterThan(source.indexOf("// }"));
      },
    );
  });

  test("resolves line ranges ending at EOF without a trailing newline", async () => {
    await withFile("export const value = 1;", async (root, file) => {
      const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

      const result = await extractFunction(index, { file, range: lineRange(1, 2) }, { newName: "readValue" });

      expect(result.status).toBe("unsupported");
      expect(result.reason).not.toContain("range does not resolve");
    });
  });

  test("resolves relative region files from the indexed project root", async () => {
    await withFile("export function run() {\n  console.log('hi');\n}\n", async (root, file) => {
      const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

      const result = await extractFunction(index, { file: "main.ts", range: lineRange(2, 3) }, { newName: "emitHi" });

      expect(result.status).toBe("ok");
      expect(result.edits.every((edit) => edit.file === file)).toBe(true);
    });
  });

  test("rejects region files outside the indexed project root", async () => {
    await withFile("export function run() {\n  console.log('hi');\n}\n", async (root, file) => {
      const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

      const result = await extractFunction(
        index,
        { file: "../outside.ts", range: lineRange(1, 2) },
        { newName: "emitHi" },
      );

      expect(result.status).toBe("unsupported");
      expect(result.reason).toContain("outside project root");
      expect(result.edits).toEqual([]);
    });
  });

  test("rejects existing region files that were not indexed", async () => {
    await withFile("export function run() {\n  console.log('hi');\n}\n", async (root, file) => {
      const unindexedFile = path.join(root, "other.ts").replace(/\\/g, "/");
      await writeFile(unindexedFile, "export function run() {\n  console.log('other');\n}\n", "utf8");
      const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

      const result = await extractFunction(index, { file: unindexedFile, range: lineRange(2, 3) }, { newName: "emitHi" });

      expect(result.status).toBe("unsupported");
      expect(result.reason).toContain("not indexed");
      expect(result.edits).toEqual([]);
    });
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

  test("rejects destructured function parameters used by the selected range", async () => {
    await withFile(
      "export function run({ name }: { name: string }) {\n  console.log(name);\n}\n",
      async (root, file) => {
        const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

        const result = await extractFunction(index, { file, range: lineRange(2, 3) }, { newName: "emitName" });

        expect(result.status).toBe("unsupported");
        expect(result.reason).toContain("non-simple bindings");
        expect(result.edits).toEqual([]);
      },
    );
  });

  test("rejects destructured local declarations before the selected range", async () => {
    await withFile(
      "export function run(input: { name: string }) {\n  const { name } = input;\n  console.log(name);\n}\n",
      async (root, file) => {
        const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

        const result = await extractFunction(index, { file, range: lineRange(3, 4) }, { newName: "emitName" });

        expect(result.status).toBe("unsupported");
        expect(result.reason).toContain("non-simple bindings");
        expect(result.edits).toEqual([]);
      },
    );
  });

  test("does not treat following comments as uses of extracted declarations", async () => {
    await withFile(
      "export function run(name: string) {\n  const greeting = `hi ${name}`;\n  // greeting is already logged above\n}\n",
      async (root, file) => {
        const index = await buildProjectIndexFromFiles(root, [file], { keepParsed: true });

        const result = await extractFunction(index, { file, range: lineRange(2, 3) }, { newName: "makeGreeting" });

        expect(result.status).toBe("ok");
        await applyEdits(result.edits);
        const source = await readFile(file, "utf8");
        expect(source).toContain("function makeGreeting(name: string)");
        expect(source).toContain("makeGreeting(name);");
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
