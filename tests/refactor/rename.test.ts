import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildProjectIndexFromFiles, listSymbols } from "../../src/index.js";
import { applyEdits, renameSymbol } from "@lzehrung/codegraph-refactor";

async function withProject<T>(
  files: Record<string, string>,
  fn: (root: string, files: Record<string, string>) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-rename-"));
  try {
    const absolute: Record<string, string> = {};
    for (const [relative, source] of Object.entries(files)) {
      const file = path.join(root, relative).replace(/\\/g, "/");
      await writeFile(file, source, "utf8");
      absolute[relative] = file;
    }
    return await fn(root, absolute);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("renameSymbol", () => {
  test("renames a TypeScript exported function and cross-file references", async () => {
    await withProject(
      {
        "utils.ts": "export function greet() { return 'hi'; }\n",
        "main.ts": "import { greet } from './utils';\nconsole.log(greet());\n",
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
        const handle = listSymbols(index, { file: files["utils.ts"] }).find((symbol) => symbol.name === "greet")?.id;
        expect(handle).toBeDefined();
        if (!handle) return;

        const result = await renameSymbol(index, handle, "salute");

        expect(result.status).toBe("ok");
        expect(result.edits.length).toBeGreaterThanOrEqual(3);
        await applyEdits(result.edits);
        await expect(readFile(files["utils.ts"]!, "utf8")).resolves.toContain("function salute()");
        await expect(readFile(files["main.ts"]!, "utf8")).resolves.toContain("import { salute }");
        await expect(readFile(files["main.ts"]!, "utf8")).resolves.toContain("salute());");
      },
    );
  });

  test("renames exported declarations without breaking aliased named importers", async () => {
    await withProject(
      {
        "utils.ts": "export function greet() { return 'hi'; }\n",
        "main.ts": "import { greet as localGreet } from './utils';\nconsole.log(localGreet());\n",
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
        const handle = listSymbols(index, { file: files["utils.ts"] }).find((symbol) => symbol.name === "greet")?.id;
        expect(handle).toBeDefined();
        if (!handle) return;

        const result = await renameSymbol(index, handle, "salute");

        expect(result.status).toBe("ok");
        await applyEdits(result.edits);
        await expect(readFile(files["utils.ts"]!, "utf8")).resolves.toContain("function salute()");
        await expect(readFile(files["main.ts"]!, "utf8")).resolves.toContain("import { salute as localGreet }");
        await expect(readFile(files["main.ts"]!, "utf8")).resolves.toContain("localGreet());");
      },
    );
  });

  test("renames exported types imported through import type", async () => {
    await withProject(
      {
        "types.ts": "export interface User { name: string }\n",
        "main.ts": "import type { User } from './types';\nconst user: User = { name: 'Ada' };\n",
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
        expect(index.byFile.get(files["main.ts"]!)?.imports).toContainEqual(
          expect.objectContaining({ kind: "named", imported: "User", local: "User", typeOnly: true }),
        );
        const handle = listSymbols(index, { file: files["types.ts"] }).find((symbol) => symbol.name === "User")?.id;
        expect(handle).toBeDefined();
        if (!handle) return;

        const result = await renameSymbol(index, handle, "Person");

        expect(result.status).toBe("ok");
        await applyEdits(result.edits);
        await expect(readFile(files["types.ts"]!, "utf8")).resolves.toContain("interface Person");
        await expect(readFile(files["main.ts"]!, "utf8")).resolves.toContain("import type { Person }");
        await expect(readFile(files["main.ts"]!, "utf8")).resolves.toContain("const user: Person");
      },
    );
  });

  test("rejects invalid identifiers", async () => {
    await withProject({ "utils.ts": "export function greet() { return 'hi'; }\n" }, async (root, files) => {
      const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
      const handle = listSymbols(index, { file: files["utils.ts"] }).find((symbol) => symbol.name === "greet")?.id;
      expect(handle).toBeDefined();
      if (!handle) return;

      const result = await renameSymbol(index, handle, "not-valid");

      expect(result.status).toBe("unsupported");
      expect(result.reason).toContain("identifier");
      expect(result.edits).toEqual([]);
    });
  });

  test("rejects TypeScript reserved words", async () => {
    await withProject({ "utils.ts": "export function greet() { return 'hi'; }\n" }, async (root, files) => {
      const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
      const handle = listSymbols(index, { file: files["utils.ts"] }).find((symbol) => symbol.name === "greet")?.id;
      expect(handle).toBeDefined();
      if (!handle) return;

      for (const reservedWord of ["for", "switch", "new"]) {
        const result = await renameSymbol(index, handle, reservedWord);

        expect(result.status).toBe("unsupported");
        expect(result.reason).toContain("reserved word");
        expect(result.edits).toEqual([]);
      }
    });
  });

  test("rejects import alias handles", async () => {
    await withProject(
      {
        "utils.ts": "export function greet() { return 'hi'; }\n",
        "main.ts": "import { greet as localGreet } from './utils';\nlocalGreet();\n",
      },
      async (root, files) => {
        const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
        const handle = listSymbols(index, { file: files["main.ts"], includeImports: true }).find(
          (symbol) => symbol.name === "localGreet" && symbol.kind === "import",
        )?.id;
        expect(handle).toBeDefined();
        if (!handle) return;

        const result = await renameSymbol(index, handle, "salute");

        expect(result.status).toBe("unsupported");
        expect(result.reason).toContain("import");
        expect(result.edits).toEqual([]);
      },
    );
  });
});
