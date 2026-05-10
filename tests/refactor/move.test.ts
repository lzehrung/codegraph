import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { applyEdits, buildProjectIndexFromFiles, listSymbols, moveSymbol } from "../../src/index.js";

async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string, files: Record<string, string>) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-move-"));
  try {
    const absolute: Record<string, string> = {};
    for (const [relative, source] of Object.entries(files)) {
      const file = path.join(root, relative).replace(/\\/g, "/");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source, "utf8");
      absolute[relative] = file;
    }
    return await fn(root, absolute);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("moveSymbol", () => {
  test("moves an exported TypeScript function with docs and rewrites importers", async () => {
    await withProject(
      {
        "src/source.ts":
          "/** Greets a name. */\nexport function greet(name: string) {\n  return `hi ${name}`;\n}\n\nexport const other = 1;\n",
        "src/main.ts": "import { greet, other } from './source';\nconsole.log(greet('Ada'), other);\n",
        "src/secondary.ts": "import { greet } from './source';\nconsole.log(greet('Lin'));\n",
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
        const handle = listSymbols(index, { file: files["src/source.ts"] }).find(
          (symbol) => symbol.name === "greet",
        )?.id;
        expect(handle).toBeDefined();
        if (!handle) return;

        const result = await moveSymbol(index, handle, path.join(root, "src/target.ts").replace(/\\/g, "/"));

        expect(result.status).toBe("ok");
        await applyEdits(result.edits);
        await expect(readFile(files["src/source.ts"]!, "utf8")).resolves.not.toContain("function greet");
        await expect(readFile(path.join(root, "src/target.ts"), "utf8")).resolves.toContain(
          "/** Greets a name. */\nexport function greet",
        );
        await expect(readFile(files["src/main.ts"]!, "utf8")).resolves.toContain("import { greet } from './target';");
        await expect(readFile(files["src/main.ts"]!, "utf8")).resolves.toContain("import { other } from './source';");
        await expect(readFile(files["src/secondary.ts"]!, "utf8")).resolves.toContain(
          "import { greet } from './target';",
        );
      },
    );
  });

  test("adds an import when a moved declaration is still used by source-file siblings", async () => {
    await withProject(
      {
        "src/source.ts": "export function greet() { return 'hi'; }\n\nexport function run() {\n  return greet();\n}\n",
        "src/target.ts": "",
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
        const handle = listSymbols(index, { file: files["src/source.ts"] }).find(
          (symbol) => symbol.name === "greet",
        )?.id;
        expect(handle).toBeDefined();
        if (!handle) return;

        const result = await moveSymbol(index, handle, files["src/target.ts"]!);

        expect(result.status).toBe("ok");
        await applyEdits(result.edits);
        await expect(readFile(files["src/source.ts"]!, "utf8")).resolves.toContain("import { greet } from './target';");
        await expect(readFile(files["src/source.ts"]!, "utf8")).resolves.toContain("return greet();");
        await expect(readFile(files["src/target.ts"]!, "utf8")).resolves.toContain("export function greet()");
      },
    );
  });

  test("rejects target binding collisions", async () => {
    await withProject(
      {
        "src/source.ts": "export function greet() { return 'hi'; }\n",
        "src/target.ts": "export function greet() { return 'existing'; }\n",
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
        const handle = listSymbols(index, { file: files["src/source.ts"] }).find(
          (symbol) => symbol.name === "greet",
        )?.id;
        expect(handle).toBeDefined();
        if (!handle) return;

        const result = await moveSymbol(index, handle, files["src/target.ts"]!);

        expect(result.status).toBe("unsupported");
        expect(result.reason).toContain("target");
        expect(result.edits).toEqual([]);
      },
    );
  });

  test("separates appended declarations from target files without trailing newlines", async () => {
    await withProject(
      {
        "src/source.ts": "export function greet() { return 'hi'; }\n",
        "src/target.ts": "export const existing = 1;",
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
        const handle = listSymbols(index, { file: files["src/source.ts"] }).find(
          (symbol) => symbol.name === "greet",
        )?.id;
        expect(handle).toBeDefined();
        if (!handle) return;

        const result = await moveSymbol(index, handle, files["src/target.ts"]!);

        expect(result.status).toBe("ok");
        await applyEdits(result.edits);
        await expect(readFile(files["src/target.ts"]!, "utf8")).resolves.toBe(
          "export const existing = 1;\nexport function greet() { return 'hi'; }\n",
        );
      },
    );
  });
});
