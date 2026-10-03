import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findSymbolicLinks, globPaths, type DirentReaddir } from "../src/util/glob.js";
import { mkTmpDir } from "./helpers/filesystem.js";

const roots: string[] = [];

async function tree(files: readonly string[]): Promise<string> {
  const root = (await mkTmpDir("cg-glob-")).replace(/\\/g, "/");
  roots.push(root);
  for (const file of files) {
    await fsp.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fsp.writeFile(path.join(root, file), "x");
  }
  return root;
}

/** Fails one directory's listing with `code`, like an unreadable directory on disk. */
function failingReaddir(directoryName: string, code: string): DirentReaddir {
  return (directory, options, callback) => {
    if (path.basename(directory.replace(/[\\/]+$/, "")) === directoryName) {
      callback(Object.assign(new Error(`${code}: ${directory}`), { code }), []);
      return;
    }
    fs.readdir(directory, options, callback);
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("glob scans", () => {
  it("fails instead of returning a partial file set when a directory cannot be read", async () => {
    const root = await tree(["keep.ts", "locked/hidden.ts"]);
    const readdir = failingReaddir("locked", "EACCES");
    await expect(globPaths(["**/*.ts"], { cwd: root, readdir })).rejects.toMatchObject({ code: "EACCES" });
    await expect(findSymbolicLinks(root, { readdir })).rejects.toMatchObject({ code: "EACCES" });
  });

  it("treats a missing directory as empty", async () => {
    const root = await tree(["keep.ts"]);
    expect(await globPaths(["**/*.ts"], { cwd: `${root}/missing` })).toEqual([]);
    expect(await globPaths(["**/*.ts"], { cwd: root, readdir: failingReaddir("keep", "ENOENT") })).toEqual([
      `${root}/keep.ts`,
    ]);
  });

  it("prunes an ignored directory but keeps files below a trailing-slash ignore", async () => {
    const root = await tree(["src/a.ts", "src/deep/b.ts", "out/c.ts"]);
    const files = await globPaths(["**/*.ts"], { cwd: root, ignore: ["out", "src/deep/"] });
    expect(files.sort()).toEqual([`${root}/src/a.ts`, `${root}/src/deep/b.ts`]);
  });

  it("reports directories with a trailing slash only when asked", async () => {
    const root = await tree(["pkg/package.json"]);
    const options = { cwd: root, onlyFiles: false } as const;
    expect((await globPaths(["pkg"], { ...options, markDirectories: true })).sort()).toEqual([`${root}/pkg/`]);
    expect((await globPaths(["pkg"], options)).sort()).toEqual([`${root}/pkg`]);
  });
});
