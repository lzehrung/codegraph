import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";

import { astGrep, textGrep } from "../src/index.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("grep default patterns", () => {
  it("includes Kotlin files in default text and AST grep", async () => {
    const root = await mkTmpDir("cg-grep-kotlin-");
    const file = path.join(root, "src", "Main.kt");

    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, ["package demo", "fun helperFunction(): Int = 1"].join("\n"), "utf8");

    try {
      const textHits = await textGrep(root, "helperFunction");
      const astHits = await astGrep(root, "(function_declaration (simple_identifier) @name)");

      expect(textHits.some((hit) => hit.file === "src/Main.kt")).toBe(true);
      expect(astHits.some((hit) => hit.file === "src/Main.kt")).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reports UTF-16 columns for AST-grep captures after multibyte text on the same line (C11)", async () => {
    const root = await mkTmpDir("cg-grep-multibyte-column-");
    const file = path.join(root, "entry.ts");

    // "café" precedes the captured import source on the same line: "é" is one UTF-16 code
    // unit but two UTF-8 bytes, so a byte-based column would report one column too far right.
    const source = "const café = 1; import { helper } from './dep';\n";
    await fsp.writeFile(file, source, "utf8");
    const target = "'./dep'";
    const expectedColumn = source.indexOf(target) + 1;

    try {
      const hits = await astGrep(root, "(import_statement source: (string) @mod)", ["**/*.ts"]);

      expect(hits).toEqual([
        expect.objectContaining({ capture: "mod", line: 1, column: expectedColumn, snippet: target }),
      ]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
