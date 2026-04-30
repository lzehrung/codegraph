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
});
