import type { Dirent } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertMcpRootScope, MCP_ROOT_PREFLIGHT_LIMITS } from "../src/mcp/root-preflight.js";
import {
  createTempRootRegistry,
  normalizeTestPath,
  tryCreateDirectorySymlink,
  tryCreateFileSymlink,
} from "./helpers/filesystem.js";

const roots = createTempRootRegistry();
const links: string[] = [];

// Narrow Node's callback overloads to the promise API exercised by the guard.
type PromiseDirectory = { read(): Promise<Dirent | null>; close(): Promise<void> };

beforeEach(() => {
  // Budget tests advance this explicitly; ordinary cases must not depend on filesystem timing.
  vi.spyOn(performance, "now").mockReturnValue(0);
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Unlink before removing fixture directories, including on Windows junction-based fixtures.
  for (const link of links.splice(0)) await fsp.unlink(link);
  await roots.cleanup();
});

async function write(root: string, relative: string, contents = "export const value = 1;\n"): Promise<string> {
  const target = path.join(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, contents);
  return target;
}

async function gitProject(root: string, relative = ".", marker: "directory" | "file" = "directory"): Promise<string> {
  const project = path.join(root, relative);
  await fsp.mkdir(project, { recursive: true });
  if (marker === "file") {
    await write(project, ".git", "gitdir: ../metadata/worktrees/project\n");
  } else {
    await fsp.mkdir(path.join(project, ".git"));
  }
  return project;
}

async function scopeFailure(root: string): Promise<Error> {
  const result: unknown = await assertMcpRootScope(root).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(result instanceof Error)) throw new Error("Expected root preflight to reject the scope");
  return result;
}

function expectRemedies(error: Error): void {
  expect(error.message).toContain("--root <project>");
  expect(error.message).toContain("--workspace <config>");
  expect(error.message).toContain("--allow-parent-root");
}

describe("assertMcpRootScope", () => {
  it.each(["directory", "file"] as const)(
    "allows a selected Git root with a .git %s without scanning it",
    async (marker) => {
      const root = await roots.create("cg-root-preflight-git-");
      await gitProject(root, ".", marker);
      await gitProject(root, "nested-a");
      await gitProject(root, "nested-b", "file");
      const opendir = vi.spyOn(fsp, "opendir");
      const readFile = vi.spyOn(fsp, "readFile");

      await expect(assertMcpRootScope(root)).resolves.toBeUndefined();
      expect(opendir).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
    },
  );

  it.each(["directory", "file"] as const)("allows a Git subdirectory owned through a .git %s", async (marker) => {
    const root = await roots.create("cg-root-preflight-subdir-");
    await gitProject(root, ".", marker);
    const subdirectory = path.join(root, "src", "nested");
    await gitProject(subdirectory, "dependency-a");
    await gitProject(subdirectory, "dependency-b");
    const opendir = vi.spyOn(fsp, "opendir");

    await expect(assertMcpRootScope(subdirectory)).resolves.toBeUndefined();
    expect(opendir).not.toHaveBeenCalled();
  });

  it("preserves initialized submodules as explicitly selected projects", async () => {
    const root = await roots.create("cg-root-preflight-submodule-");
    await gitProject(root);
    const submodule = await gitProject(root, "packages/submodule", "file");
    await gitProject(submodule, "nested-a");
    await gitProject(submodule, "nested-b");
    const source = path.join(submodule, "src");
    await fsp.mkdir(source);
    const opendir = vi.spyOn(fsp, "opendir");

    await expect(assertMcpRootScope(submodule)).resolves.toBeUndefined();
    await expect(assertMcpRootScope(source)).resolves.toBeUndefined();
    expect(opendir).not.toHaveBeenCalled();
  });

  it.each([".", "src/nested"])("preserves an explicit directory alias to a Git project at %s", async (relative) => {
    const root = await roots.create("cg-root-preflight-real-");
    const parent = await roots.create("cg-root-preflight-alias-");
    await gitProject(root);
    const target = path.join(root, relative);
    await fsp.mkdir(target, { recursive: true });
    const alias = path.join(parent, "selected");
    if (!(await tryCreateDirectorySymlink(target, alias))) return;
    links.push(alias);
    const opendir = vi.spyOn(fsp, "opendir");

    await expect(assertMcpRootScope(alias)).resolves.toBeUndefined();
    expect(opendir).not.toHaveBeenCalled();
  });

  it("allows an ordinary non-Git project and reads no source contents or writes state", async () => {
    const root = await roots.create("cg-root-preflight-project-");
    await write(root, "package.json", '{"name":"project"}\n');
    await write(root, "src/deep/main.ts");
    await write(root, "README.md", "A non-Git project.\n");
    const readFile = vi.spyOn(fsp, "readFile");
    const writeFile = vi.spyOn(fsp, "writeFile");
    const mkdir = vi.spyOn(fsp, "mkdir");
    const rm = vi.spyOn(fsp, "rm");

    await expect(assertMcpRootScope(root)).resolves.toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it("allows an empty non-Git project", async () => {
    const root = await roots.create("cg-root-preflight-empty-");
    await expect(assertMcpRootScope(root)).resolves.toBeUndefined();
  });

  it("allows one embedded Git dependency and does not treat its submodules as independent projects", async () => {
    const root = await roots.create("cg-root-preflight-embedded-");
    await write(root, "pyproject.toml", "[project]\nname = 'project'\n");
    await write(root, "src/main.py", "print('project')\n");
    const dependency = await gitProject(root, "third-party/dependency");
    await gitProject(dependency, "submodules/one", "file");
    await gitProject(dependency, "nested-clone");
    const opendir = vi.spyOn(fsp, "opendir");

    await expect(assertMcpRootScope(root)).resolves.toBeUndefined();
    const opened = opendir.mock.calls.map(([directory]) => normalizeTestPath(String(directory)));
    expect(opened).not.toContain(normalizeTestPath(await fsp.realpath(dependency)));
    expect(opened.some((directory) => directory.includes("/submodules/"))).toBe(false);
  });

  it("rejects multiple independent Git directories and files, even beneath a root manifest", async () => {
    const root = await roots.create("cg-root-preflight-parent-");
    await write(root, "package.json", '{"name":"parent"}\n');
    await gitProject(root, "group/alpha");
    await gitProject(root, "group/beta", "file");
    const readFile = vi.spyOn(fsp, "readFile");

    const error = await scopeFailure(root);
    expect(error).toMatchObject({ code: "MCP_ROOT_SELECTION_REQUIRED" });
    expect(error.message).toContain('"group/alpha"');
    expect(error.message).toContain('"group/beta"');
    expect(error.message).toContain("not a complete inventory");
    expectRemedies(error);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("reports only a bounded, explicitly incomplete project list", async () => {
    const root = await roots.create("cg-root-preflight-many-projects-");
    for (let index = 0; index < 5; index += 1) await gitProject(root, `project-${index}`);

    const error = await scopeFailure(root);
    expect(error).toMatchObject({ code: "MCP_ROOT_SELECTION_REQUIRED" });
    expect(error.message.split("\n").filter((line) => line.startsWith("  - "))).toHaveLength(2);
    expect(error.message).toContain("found at least two independent Git projects");
    expect(error.message).toContain("Preflight stopped after two projects");
    expect(error.message).toContain("not a complete inventory");
  });

  it("does not traverse dependency, cache, build, or Git metadata directories", async () => {
    const root = await roots.create("cg-root-preflight-pruned-");
    const ignored = [
      ".git",
      ".codegraph",
      ".codegraph-cache",
      "node_modules",
      "vendor",
      "Pods",
      ".venv",
      "venv",
      "site-packages",
      "__pycache__",
      ".cache",
      ".npm",
      ".yarn",
      ".pnpm-store",
      ".cargo",
      ".gradle",
      ".m2",
      ".nuget",
      ".terraform",
      ".build",
      "dist",
      "build",
      "target",
      "coverage",
      "out",
      "bin",
      "obj",
    ];
    // A symlinked .git is not an owning repository marker; other entries are pruned by name.
    const metadata = await roots.create("cg-root-preflight-metadata-");
    if (await tryCreateDirectorySymlink(metadata, path.join(root, ".git"))) {
      links.push(path.join(root, ".git"));
    } else {
      ignored.shift();
    }
    for (const directory of ignored.filter((name) => name !== ".git")) {
      await gitProject(root, `${directory}/one`);
      await gitProject(root, `${directory}/two`, "file");
    }
    await write(root, "src/main.ts");
    await gitProject(root, "third-party/selected-dependency");
    const opendir = vi.spyOn(fsp, "opendir");

    await expect(assertMcpRootScope(root)).resolves.toBeUndefined();
    const realRoot = await fsp.realpath(root);
    const opened = opendir.mock.calls.map(([directory]) =>
      normalizeTestPath(path.relative(realRoot, String(directory))),
    );
    for (const directory of ignored) {
      expect(opened.some((entry) => entry === directory || entry.startsWith(`${directory}/`))).toBe(false);
    }
    expect(opened).toContain("src");
    expect(opened).toContain("third-party");
  });

  it("never traverses discovered links, including internal links and cycles", async (context) => {
    const root = await roots.create("cg-root-preflight-links-");
    const outside = await roots.create("cg-root-preflight-outside-");
    await gitProject(outside, "one");
    await gitProject(outside, "two");
    await write(root, "src/main.ts");
    for (const [target, name] of [
      [outside, "external"],
      [path.join(root, "src"), "internal"],
      [root, "cycle"],
    ]) {
      const link = path.join(root, name);
      if (!(await tryCreateDirectorySymlink(target!, link))) return context.skip();
      links.push(link);
    }
    const opendir = vi.spyOn(fsp, "opendir");

    await expect(assertMcpRootScope(root)).resolves.toBeUndefined();
    const opened = opendir.mock.calls.map(([directory]) => normalizeTestPath(String(directory)));
    expect(opened).toHaveLength(2);
    expect(opened.some((directory) => /\/(external|internal|cycle)(\/|$)/.test(directory))).toBe(false);
  });

  it("does not accept a linked .git file as an owning Git marker", async (context) => {
    const root = await roots.create("cg-root-preflight-git-link-");
    const metadata = await roots.create("cg-root-preflight-git-link-target-");
    const target = await write(metadata, "pointer", "gitdir: private\n");
    const link = path.join(root, ".git");
    if (!(await tryCreateFileSymlink(target, link))) return context.skip();
    links.push(link);
    await gitProject(root, "one");
    await gitProject(root, "two");

    expect(await scopeFailure(root)).toMatchObject({ code: "MCP_ROOT_SELECTION_REQUIRED" });
  });

  it("uses the logical selected root in errors from an explicit alias", async (context) => {
    const root = await roots.create("cg-root-preflight-physical-");
    const parent = await roots.create("cg-root-preflight-logical-");
    await gitProject(root, "one");
    await gitProject(root, "two", "file");
    const alias = path.join(parent, "chosen");
    if (!(await tryCreateDirectorySymlink(root, alias))) return context.skip();
    links.push(alias);

    const error = await scopeFailure(alias);
    expect(error).toMatchObject({ code: "MCP_ROOT_SELECTION_REQUIRED" });
    expect(error.message).toContain(normalizeTestPath(alias));
    expect(error.message).not.toContain(normalizeTestPath(root));
  });

  it.each(["constructor", "toString", "__proto__"])("does not mistake %s for an ignored directory", async (name) => {
    const root = await roots.create("cg-root-preflight-directory-name-");
    await gitProject(root, name);
    await gitProject(root, "other");

    expect(await scopeFailure(root)).toMatchObject({ code: "MCP_ROOT_SELECTION_REQUIRED" });
  });

  it("requires an explicit override to bypass inspection, including filesystem probes", async () => {
    const root = await roots.create("cg-root-preflight-override-");
    await gitProject(root, "one");
    await gitProject(root, "two");
    const realpath = vi.spyOn(fsp, "realpath");
    const lstat = vi.spyOn(fsp, "lstat");
    const opendir = vi.spyOn(fsp, "opendir");

    await expect(assertMcpRootScope(root, { allowParentRoot: true })).resolves.toBeUndefined();
    expect(realpath).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
    expect(opendir).not.toHaveBeenCalled();
    await expect(assertMcpRootScope(root, { allowParentRoot: false })).rejects.toMatchObject({
      code: "MCP_ROOT_SELECTION_REQUIRED",
    });
  });

  it.each(["missing", "file"])("reports scope unknown for a %s root", async (kind) => {
    const parent = await roots.create("cg-root-preflight-invalid-");
    const root = path.join(parent, kind);
    if (kind === "file") await write(parent, kind);

    const error = await scopeFailure(root);
    expect(error).toMatchObject({ code: "MCP_ROOT_SCOPE_UNKNOWN" });
    expectRemedies(error);
  });

  it.each(["EACCES", "ENOENT", "EIO"])(
    "does not turn a failed directory inspection (%s) into success",
    async (code) => {
      const root = await roots.create("cg-root-preflight-unreadable-");
      await write(root, "blocked/main.ts");
      const original = fsp.opendir.bind(fsp);
      vi.spyOn(fsp, "opendir").mockImplementation(async (...args) => {
        if (path.basename(String(args[0])) === "blocked") throw Object.assign(new Error("unreadable"), { code });
        return await original(...args);
      });

      const error = await scopeFailure(root);
      expect(error).toMatchObject({ code: "MCP_ROOT_SCOPE_UNKNOWN" });
      expect(error.message).toContain(code);
      expect(error.message).toContain("not establish a single-project scope");
      expectRemedies(error);
    },
  );

  it("reports an observed project as incomplete when another directory could not be checked", async () => {
    const root = await roots.create("cg-root-preflight-partial-");
    await gitProject(root, "observed");
    await write(root, "wrapper/blocked/main.ts");
    const original = fsp.opendir.bind(fsp);
    vi.spyOn(fsp, "opendir").mockImplementation(async (...args) => {
      if (path.basename(String(args[0])) === "blocked") {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return await original(...args);
    });

    const error = await scopeFailure(root);
    expect(error).toMatchObject({ code: "MCP_ROOT_SCOPE_UNKNOWN" });
    expect(error.message).toContain('Git project observed (not a complete inventory): "observed"');
    expectRemedies(error);
  });

  it("closes a listing that fails while streaming directory entries", async () => {
    const root = await roots.create("cg-root-preflight-read-error-");
    const original = fsp.opendir.bind(fsp);
    let closes = 0;
    vi.spyOn(fsp, "opendir").mockImplementation(async (...args) => {
      const directory = await original(...args);
      const promiseDirectory: PromiseDirectory = directory;
      vi.spyOn(promiseDirectory, "read").mockImplementation(async () => {
        throw Object.assign(new Error("read failed"), { code: "EIO" });
      });
      const close = directory.close.bind(directory);
      vi.spyOn(promiseDirectory, "close").mockImplementation(async () => {
        closes += 1;
        await close();
      });
      return directory;
    });

    const error = await scopeFailure(root);
    expect(error).toMatchObject({ code: "MCP_ROOT_SCOPE_UNKNOWN" });
    expect(error.message).toContain("EIO");
    expect(closes).toBe(1);
  });

  it("does not silently ignore an unreadable Git marker", async () => {
    const root = await roots.create("cg-root-preflight-marker-error-");
    const realRoot = await fsp.realpath(root);
    const original = fsp.lstat.bind(fsp);
    vi.spyOn(fsp, "lstat").mockImplementation(((...args: Parameters<typeof fsp.lstat>) => {
      if (String(args[0]) === path.join(realRoot, ".git")) {
        return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      }
      return original(...args);
    }) as typeof fsp.lstat);

    const error = await scopeFailure(root);
    expect(error).toMatchObject({ code: "MCP_ROOT_SCOPE_UNKNOWN" });
    expect(error.message).toContain("EACCES");
  });

  it("allows a complete non-Git project at the maximum discovery depth", async () => {
    const root = await roots.create("cg-root-preflight-depth-boundary-");
    const relative = Array.from({ length: MCP_ROOT_PREFLIGHT_LIMITS.directoryDepth }, () => "d").join("/");
    await write(root, `${relative}/main.ts`);

    await expect(assertMcpRootScope(root)).resolves.toBeUndefined();
  });

  it("reports exhausted ancestor discovery rather than assuming there is no owning Git project", async () => {
    const parent = await roots.create("cg-root-preflight-ancestors-");
    const relative = Array.from({ length: MCP_ROOT_PREFLIGHT_LIMITS.ancestorDirectories }, () => "d").join("/");
    const root = path.join(parent, relative);
    await fsp.mkdir(root, { recursive: true });

    const error = await scopeFailure(root);
    expect(error).toMatchObject({ code: "MCP_ROOT_SCOPE_UNKNOWN" });
    expect(error.message).toContain(
      `owning-project discovery budget exhausted (${MCP_ROOT_PREFLIGHT_LIMITS.ancestorDirectories} ancestor directories)`,
    );
    expectRemedies(error);
  });

  it("reports an incomplete depth-bounded scan as scope unknown", async () => {
    const root = await roots.create("cg-root-preflight-depth-");
    const relative = Array.from({ length: MCP_ROOT_PREFLIGHT_LIMITS.directoryDepth + 1 }, () => "d").join("/");
    await gitProject(root, relative);

    const error = await scopeFailure(root);
    expect(error).toMatchObject({ code: "MCP_ROOT_SCOPE_UNKNOWN" });
    expect(error.message).toContain(
      `directory-depth discovery budget exceeded (${MCP_ROOT_PREFLIGHT_LIMITS.directoryDepth} levels)`,
    );
    expectRemedies(error);
  });

  it("bounds discovered directories independently of the file-entry budget", async () => {
    const root = await roots.create("cg-root-preflight-directories-");
    for (let index = 0; index < MCP_ROOT_PREFLIGHT_LIMITS.directories; index += 1) {
      await fsp.mkdir(path.join(root, `d${index}`));
    }

    const error = await scopeFailure(root);
    expect(error).toMatchObject({ code: "MCP_ROOT_SCOPE_UNKNOWN" });
    expect(error.message).toContain(
      `directory discovery budget exceeded (${MCP_ROOT_PREFLIGHT_LIMITS.directories} directories)`,
    );
  });

  describe.each([
    {
      name: "entry count",
      fileName: "file.ts",
      entryLimit: MCP_ROOT_PREFLIGHT_LIMITS.entries,
      reason: `directory-entry discovery budget exceeded (${MCP_ROOT_PREFLIGHT_LIMITS.entries} entries)`,
    },
    {
      name: "entry-name bytes",
      fileName: "x".repeat(128),
      entryLimit: Math.floor(MCP_ROOT_PREFLIGHT_LIMITS.entryNameBytes / 128),
      reason: `entry-name discovery byte budget exceeded (${MCP_ROOT_PREFLIGHT_LIMITS.entryNameBytes} UTF-8 bytes)`,
    },
  ])("streamed $name budget", ({ fileName, entryLimit, reason }) => {
    it.each([0, 1])("handles %i entries beyond the boundary without reading source contents", async (extraEntries) => {
      const root = await roots.create("cg-root-preflight-entries-");
      await write(root, fileName);
      const [entry] = await fsp.readdir(root, { withFileTypes: true });
      const original = fsp.opendir.bind(fsp);
      let reads = 0;
      let closes = 0;
      vi.spyOn(fsp, "opendir").mockImplementation(async (...args) => {
        const directory = await original(...args);
        const promiseDirectory: PromiseDirectory = directory;
        // A synthetic long stream exercises the actual guard without thousands of disk files.
        vi.spyOn(promiseDirectory, "read").mockImplementation(async () => {
          reads += 1;
          if (reads > entryLimit + extraEntries) return null;
          return entry;
        });
        const close = directory.close.bind(directory);
        vi.spyOn(promiseDirectory, "close").mockImplementation(async () => {
          closes += 1;
          await close();
        });
        return directory;
      });
      const readFile = vi.spyOn(fsp, "readFile");

      if (extraEntries) {
        const error = await scopeFailure(root);
        expect(error).toMatchObject({ code: "MCP_ROOT_SCOPE_UNKNOWN" });
        expect(error.message).toContain(reason);
        expectRemedies(error);
      } else {
        await expect(assertMcpRootScope(root)).resolves.toBeUndefined();
      }
      expect(reads).toBe(entryLimit + 1);
      expect(closes).toBe(1);
      expect(readFile).not.toHaveBeenCalled();
    });
  });

  it("reports an exhausted elapsed budget and closes an already opened directory", async () => {
    const root = await roots.create("cg-root-preflight-elapsed-");
    const original = fsp.opendir.bind(fsp);
    let closes = 0;
    vi.spyOn(fsp, "opendir").mockImplementation(async (...args) => {
      const directory = await original(...args);
      const promiseDirectory: PromiseDirectory = directory;
      const close = directory.close.bind(directory);
      vi.spyOn(promiseDirectory, "close").mockImplementation(async () => {
        closes += 1;
        await close();
      });
      vi.mocked(performance.now).mockReturnValue(MCP_ROOT_PREFLIGHT_LIMITS.elapsedMs);
      return directory;
    });

    const error = await scopeFailure(root);
    expect(error).toMatchObject({ code: "MCP_ROOT_SCOPE_UNKNOWN" });
    expect(error.message).toContain(`elapsed discovery budget exhausted (${MCP_ROOT_PREFLIGHT_LIMITS.elapsedMs} ms)`);
    expect(closes).toBe(1);
    expectRemedies(error);
  });
});
