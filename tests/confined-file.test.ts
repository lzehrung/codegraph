import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { resolveReadableFile } from "../src/util/confinedFile.js";

const execFileAsync = promisify(execFile);

async function windowsShortPath(filePath: string): Promise<string | null> {
  if (filePath.includes(" ")) return null;
  const command = `for %I in (${filePath}) do @echo %~sI`;
  const { stdout } = await execFileAsync("cmd.exe", ["/d", "/c", command]);
  const shortPath = stdout.trim();
  return shortPath === filePath ? null : shortPath;
}

describe("confined readable files", () => {
  it.runIf(process.platform === "win32")(
    "accepts an in-root file addressed through its Windows short path and rejects an outside file",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-confined-file-root-"));
      const outsideRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-confined-file-outside-"));
      const insideFile = path.join(root, "source.ts");
      const outsideFile = path.join(outsideRoot, "outside.ts");
      await fsp.writeFile(insideFile, "export const inside = true;\n", "utf8");
      await fsp.writeFile(outsideFile, "export const outside = true;\n", "utf8");

      try {
        const shortFile = await windowsShortPath(insideFile);
        if (!shortFile) return;

        const realRoot = await fsp.realpath(root);
        const resolved = await resolveReadableFile(realRoot, root, shortFile);

        expect(resolved.realPath).toBe(await fsp.realpath(insideFile));
        expect(resolved.displayPath).toBe("source.ts");
        await expect(resolveReadableFile(realRoot, root, outsideFile)).rejects.toThrow(/outside project root/);
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
        await fsp.rm(outsideRoot, { recursive: true, force: true });
      }
    },
  );
});
