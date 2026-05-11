import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildProjectIndexFromFiles, listSymbols } from "../../src/index.js";
import { applyEdits, moveSymbol, renameSymbol } from "@lzehrung/codegraph-refactor";

async function withProject<T>(files: Record<string, string>, fn: (root: string, files: Record<string, string>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-refactor-hardening-"));
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

describe("refactor hardening", () => {
  test("rename is idempotent after edits are applied", async () => {
    await withProject({ "main.ts": "export function greet() {\n  return 'hi';\n}\ngreet();\n" }, async (root, files) => {
      const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
      const handle = listSymbols(index).find((symbol) => symbol.name === "greet")?.id;
      expect(handle).toBeDefined();
      if (!handle) return;

      const first = await renameSymbol(index, handle, "salute");
      expect(first.status).toBe("ok");
      await applyEdits(first.edits);
      const second = await renameSymbol(index, handle, "salute");

      expect(second.status).toBe("ok");
      expect(second.edits).toEqual([]);
    });
  });

  test("rename round trip preserves the original bytes", async () => {
    await withProject({ "main.ts": "export function greet() {\r\n  return 'hi';\r\n}\r\ngreet();\r\n" }, async (root, files) => {
      const original = await readFile(files["main.ts"]!, "utf8");
      const firstIndex = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
      const firstHandle = listSymbols(firstIndex).find((symbol) => symbol.name === "greet")?.id;
      expect(firstHandle).toBeDefined();
      if (!firstHandle) return;
      await applyEdits((await renameSymbol(firstIndex, firstHandle, "salute")).edits);

      const secondIndex = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
      const secondHandle = listSymbols(secondIndex).find((symbol) => symbol.name === "salute")?.id;
      expect(secondHandle).toBeDefined();
      if (!secondHandle) return;
      await applyEdits((await renameSymbol(secondIndex, secondHandle, "greet")).edits);

      await expect(readFile(files["main.ts"]!, "utf8")).resolves.toBe(original);
    });
  });

  test("combined rename and move edits surface overlap conflicts", async () => {
    await withProject({ "main.ts": "export function greet() {\n  return 'hi';\n}\n" }, async (root, files) => {
      const index = await buildProjectIndexFromFiles(root, Object.values(files), { keepParsed: true });
      const handle = listSymbols(index).find((symbol) => symbol.name === "greet")?.id;
      expect(handle).toBeDefined();
      if (!handle) return;

      const rename = await renameSymbol(index, handle, "salute");
      const move = await moveSymbol(index, handle, path.join(root, "target.ts").replace(/\\/g, "/"));
      const result = await applyEdits([...rename.edits, ...move.edits], { dryRun: true });

      expect(result.conflicts).toContain(files["main.ts"]);
      expect(result.writes).toEqual([]);
    });
  });
});
