import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { assertWritableDirectoryRealPathWithinRoot } from "../src/mcp/security.js";
import { findNearestExistingPath, resolveReadableFile } from "../src/util/confined-file.js";

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

  it.runIf(process.platform === "win32")(
    "accepts a long in-root file when the canonical root uses its Windows short path",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-confined-file-short-root-"));
      const insideFile = path.join(root, "source.ts");
      await fsp.writeFile(insideFile, "export const inside = true;\n", "utf8");

      try {
        const shortRoot = await windowsShortPath(root);
        if (!shortRoot) return;

        const resolved = await resolveReadableFile(shortRoot, root, insideFile);

        expect(resolved.realPath).toBe(await fsp.realpath(insideFile));
        expect(resolved.displayPath).toBe("source.ts");
      } finally {
        await fsp.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("paths below a regular file", () => {
  function notADirectory(target: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`ENOTDIR: not a directory, stat '${target}'`), { code: "ENOTDIR" });
  }

  it("treats a missing child of a regular file as missing and returns the file as nearest existing path", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-confined-notdir-"));
    const file = path.join(root, "README.md");
    await fsp.writeFile(file, "readme\n", "utf8");
    try {
      await expect(findNearestExistingPath(path.join(file, "out", "deeper"))).resolves.toBe(file);

      const realRoot = await fsp.realpath(root);
      const resolved = await assertWritableDirectoryRealPathWithinRoot(realRoot, root, "README.md/out", "Output");
      expect(resolved).toBe(path.join(realRoot, "README.md", "out").replace(/\\/g, "/"));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("treats ENOTDIR from stat like ENOENT on every platform", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-confined-notdir-stat-"));
    const file = path.join(root, "README.md");
    await fsp.writeFile(file, "readme\n", "utf8");
    const originalStat = fsp.stat.bind(fsp);
    const statSpy = vi.spyOn(fsp, "stat").mockImplementation(((target: Parameters<typeof fsp.stat>[0], ...rest: []) => {
      if (typeof target === "string" && target.startsWith(file + path.sep))
        return Promise.reject(notADirectory(target));
      return originalStat(target, ...rest);
    }) as typeof fsp.stat);
    try {
      await expect(findNearestExistingPath(path.join(file, "out"))).resolves.toBe(file);
    } finally {
      statSpy.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("still reports the outside-root reason for a symlinked file ancestor", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-confined-notdir-link-"));
    const outsideRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-confined-notdir-outside-"));
    const outsideFile = path.join(outsideRoot, "outside.txt");
    await fsp.writeFile(outsideFile, "outside\n", "utf8");
    try {
      try {
        await fsp.symlink(outsideFile, path.join(root, "link"), "file");
      } catch {
        return; // symlink creation is not permitted on this host
      }
      const realRoot = await fsp.realpath(root);
      await expect(assertWritableDirectoryRealPathWithinRoot(realRoot, root, "link/x", "Output")).rejects.toThrow(
        /outside project root/,
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
