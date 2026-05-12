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

  test("resolves relative target files from the indexed project root", async () => {
    await withProject(
      {
        "src/source.ts": "export function greet() { return 'hi'; }\n",
        "src/target.ts": "",
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
        const handle = listSymbols(index, { file: files["src/source.ts"] }).find(
          (symbol) => symbol.name === "greet",
        )?.id;
        expect(handle).toBeDefined();
        if (!handle) return;

        const result = await moveSymbol(index, handle, "src/target.ts");

        expect(result.status).toBe("ok");
        expect(result.edits.some((edit) => edit.file === files["src/target.ts"])).toBe(true);
      },
    );
  });

  test("rejects target files outside the indexed project root", async () => {
    await withProject(
      {
        "src/source.ts": "export function greet() { return 'hi'; }\n",
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
        const handle = listSymbols(index, { file: files["src/source.ts"] }).find(
          (symbol) => symbol.name === "greet",
        )?.id;
        expect(handle).toBeDefined();
        if (!handle) return;

        const result = await moveSymbol(index, handle, "../outside.ts");

        expect(result.status).toBe("unsupported");
        expect(result.reason).toContain("outside project root");
        expect(result.edits).toEqual([]);
      },
    );
  });

  test("rejects existing target files that were not indexed", async () => {
    await withProject(
      {
        "src/source.ts": "export function greet() { return 'hi'; }\n",
        "src/target.ts": "export function greet() { return 'existing'; }\n",
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, [files["src/source.ts"]!], { keepParsed: true });
        const handle = listSymbols(index, { file: files["src/source.ts"] }).find(
          (symbol) => symbol.name === "greet",
        )?.id;
        expect(handle).toBeDefined();
        if (!handle) return;

        const result = await moveSymbol(index, handle, files["src/target.ts"]!);

        expect(result.status).toBe("unsupported");
        expect(result.reason).toContain("not indexed");
        expect(result.edits).toEqual([]);
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

  test("adds source-file sibling imports after complete multiline import declarations", async () => {
    await withProject(
      {
        "src/helper.ts": "export function helper() { return 'helper'; }\n",
        "src/source.ts": [
          "import {",
          "  helper,",
          "} from './helper';",
          "",
          "export function greet() { return 'hi'; }",
          "",
          "export function run() {",
          "  return `${helper()} ${greet()}`;",
          "}",
          "",
        ].join("\n"),
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
        await expect(readFile(files["src/source.ts"]!, "utf8")).resolves.toBe(
          [
            "import {",
            "  helper,",
            "} from './helper';",
            "import { greet } from './target';",
            "",
            "",
            "export function run() {",
            "  return `${helper()} ${greet()}`;",
            "}",
            "",
          ].join("\n"),
        );
      },
    );
  });

  test("adds imports for dependencies used by the moved declaration", async () => {
    await withProject(
      {
        "src/helper.ts": "export function helper(name: string) { return name.toUpperCase(); }\n",
        "src/source.ts":
          "import { helper } from './helper';\n\nexport function greet(name: string) {\n  return helper(name);\n}\n",
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
        await expect(readFile(files["src/target.ts"]!, "utf8")).resolves.toBe(
          "import { helper } from './helper';\n\nexport function greet(name: string) {\n  return helper(name);\n}\n",
        );
      },
    );
  });

  test("detects moved dependencies in template expressions but ignores comments", async () => {
    await withProject(
      {
        "src/format.ts": "export function format(name: string) { return name.toUpperCase(); }\n",
        "src/helper.ts": "export function helper(name: string) { return name.toLowerCase(); }\n",
        "src/source.ts": [
          "import { format } from './format';",
          "import { helper } from './helper';",
          "",
          "export function greet(name: string) {",
          "  // helper(name) is only an example in a comment.",
          "  return `hi ${format(name)}`;",
          "}",
          "",
        ].join("\n"),
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
        await expect(readFile(files["src/target.ts"]!, "utf8")).resolves.toBe(
          [
            "import { format } from './format';",
            "",
            "export function greet(name: string) {",
            "  // helper(name) is only an example in a comment.",
            "  return `hi ${format(name)}`;",
            "}",
            "",
          ].join("\n"),
        );
      },
    );
  });

  test("uses explicit import extensions when adding source-file sibling imports", async () => {
    await withProject(
      {
        "src/helper.ts": "export const helper = 1;\n",
        "src/source.ts": [
          "import { helper } from './helper.js';",
          "",
          "export function greet() { return helper; }",
          "",
          "export function run() {",
          "  return greet();",
          "}",
          "",
        ].join("\n"),
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
