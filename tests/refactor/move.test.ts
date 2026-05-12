import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildProjectIndexFromFiles, listSymbols } from "../../src/index.js";
import { applyEdits, moveSymbol } from "@lzehrung/codegraph-refactor";

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

  test("preserves explicit import extensions when rewriting importers", async () => {
    await withProject(
      {
        "src/source.ts": "export function greet() { return 'hi'; }\nexport const other = 1;\n",
        "src/main.ts": "import { greet, other } from './source.js';\nconsole.log(greet(), other);\n",
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
        await expect(readFile(files["src/main.ts"]!, "utf8")).resolves.toContain(
          "import { greet } from './target.js';",
        );
        await expect(readFile(files["src/main.ts"]!, "utf8")).resolves.toContain(
          "import { other } from './source.js';",
        );
      },
    );
  });

  test("rewrites every matching import declaration in an importer", async () => {
    await withProject(
      {
        "src/source.ts": "export function greet() { return 'hi'; }\n",
        "src/main.ts":
          "import { greet } from './source';\nimport { greet as greetAgain } from './source';\nconsole.log(greet(), greetAgain());\n",
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
        const importer = await readFile(files["src/main.ts"]!, "utf8");
        expect(importer).toContain("import { greet } from './target';");
        expect(importer).toContain("import { greet as greetAgain } from './target';");
        expect(importer).not.toContain("./source");
      },
    );
  });

  test("rewrites type-only importers when moving exported types", async () => {
    await withProject(
      {
        "src/source.ts": "export interface User { name: string }\nexport interface Other { id: string }\n",
        "src/main.ts": "import type { User, Other } from './source';\nconst user: User = { name: 'Ada' };\n",
        "src/target.ts": "",
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
        const handle = listSymbols(index, { file: files["src/source.ts"] }).find(
          (symbol) => symbol.name === "User",
        )?.id;
        expect(handle).toBeDefined();
        if (!handle) return;

        const result = await moveSymbol(index, handle, files["src/target.ts"]!);

        expect(result.status).toBe("ok");
        await applyEdits(result.edits);
        await expect(readFile(files["src/main.ts"]!, "utf8")).resolves.toContain(
          "import type { Other } from './source';",
        );
        await expect(readFile(files["src/main.ts"]!, "utf8")).resolves.toContain(
          "import type { User } from './target';",
        );
      },
    );
  });

  test("rewrites inline type-only importers when moving exported types", async () => {
    await withProject(
      {
        "src/source.ts": "export interface User { name: string }\nexport const marker = 1;\n",
        "src/main.ts": "import { marker, type User } from './source';\nconst user: User = { name: 'Ada' };\n",
        "src/target.ts": "",
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
        const handle = listSymbols(index, { file: files["src/source.ts"] }).find(
          (symbol) => symbol.name === "User",
        )?.id;
        expect(handle).toBeDefined();
        if (!handle) return;

        const result = await moveSymbol(index, handle, files["src/target.ts"]!);

        expect(result.status).toBe("ok");
        await applyEdits(result.edits);
        await expect(readFile(files["src/main.ts"]!, "utf8")).resolves.toContain(
          "import { marker } from './source';",
        );
        await expect(readFile(files["src/main.ts"]!, "utf8")).resolves.toContain(
          "import { type User } from './target';",
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

  test("uses explicit import extensions when adding source-file sibling imports", async () => {
    await withProject(
      {
        "src/helper.ts": "export const helper = 1;\n",
        "src/source.ts":
          "import { helper } from './helper.js';\n\nexport function greet() { return helper; }\n\nexport function run() {\n  return greet();\n}\n",
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
        await expect(readFile(files["src/source.ts"]!, "utf8")).resolves.toContain(
          "import { greet } from './target.js';",
        );
        await expect(readFile(files["src/source.ts"]!, "utf8")).resolves.toContain(
          "import { helper } from './helper.js';",
        );
      },
    );
  });

  test("moves current disk trivia instead of stale cached trivia", async () => {
    await withProject(
      {
        "src/source.ts": "/** old */\nexport function greet() { return 'hi'; }\n",
        "src/target.ts": "",
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
        const handle = listSymbols(index, { file: files["src/source.ts"] }).find(
          (symbol) => symbol.name === "greet",
        )?.id;
        expect(handle).toBeDefined();
        if (!handle) return;
        await writeFile(files["src/source.ts"]!, "/** new */\nexport function greet() { return 'hi'; }\n", "utf8");

        const result = await moveSymbol(index, handle, files["src/target.ts"]!);

        expect(result.status).toBe("ok");
        await applyEdits(result.edits);
        await expect(readFile(files["src/target.ts"]!, "utf8")).resolves.toContain("/** new */");
        await expect(readFile(files["src/target.ts"]!, "utf8")).resolves.not.toContain("/** old */");
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

  test("rejects unsupported source languages without emitting edits", async () => {
    await withProject(
      {
        "src/source.py": "def greet():\n    return 'hi'\n\n\ndef run():\n    return greet()\n",
        "src/target.py": "",
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
        const handle = listSymbols(index, { file: files["src/source.py"] }).find(
          (symbol) => symbol.name === "greet",
        )?.id;
        expect(handle).toBeDefined();
        if (!handle) return;

        const result = await moveSymbol(index, handle, files["src/target.py"]!);

        expect(result.status).toBe("unsupported");
        expect(result.reason).toContain("move is only supported");
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
