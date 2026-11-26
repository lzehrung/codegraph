import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../src/agent/session.js";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraph,
  listProjectFiles,
  type BuildReport,
  type ProjectIndex,
} from "../src/index.js";
import { cacheRoot, clearMemoryCache, closeDiskCacheDatabase, loadManifest } from "../src/indexer/build-cache.js";
import { reconcileLinkedFiles } from "../src/indexer/incremental-plan.js";
import type { IncrementalBuildOptions } from "../src/indexer/types.js";
import { normalizePath } from "../src/util/paths.js";
import { createProjectDiscoveryContext } from "../src/util/project-files.js";
import { createTempRootRegistry, isSymlinkUnavailable } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";

const roots = createTempRootRegistry();
const diskCaches: Array<{ root: string; cacheDir: string }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { root, cacheDir } of diskCaches.splice(0)) closeDiskCacheDatabase(root, { cache: "disk", cacheDir });
  clearMemoryCache();
  await roots.cleanup();
});

/** Whether this account may create the links (Windows asks for a privilege); a test that needs them skips without. */
const SYMLINKS_AVAILABLE = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-symlink-probe-"));
  try {
    fs.mkdirSync(path.join(dir, "target"));
    fs.writeFileSync(path.join(dir, "target", "file.txt"), "");
    fs.symlinkSync("target", path.join(dir, "dir-link"), "dir");
    fs.symlinkSync(path.join("target", "file.txt"), path.join(dir, "file-link"), "file");
    return true;
  } catch (error) {
    if (isSymlinkUnavailable(error)) return false;
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

type Discovery = "scan" | "git";
type Fixture = Record<string, string>;

const FIXTURE: Fixture = {
  "src/real/lib.ts": "export const lib = 1;\n",
  "src/real/util.ts": 'import { lib } from "./lib";\nexport const util = lib + 1;\n',
  "src/other/lib.ts": "export const lib = 100;\nexport const otherOnly = 1;\n",
  "src/other/more.ts": "export const more = 2;\n",
  "src/app.ts":
    'import { lib } from "./linked/lib";\nimport { util } from "./real/util";\nexport const app = lib + util;\n',
  "src/zzz/last.ts": 'import { app } from "../app";\nexport const last = app;\n',
};

/** Two files outside the project root, which a link to them must never bring in. */
const OUTSIDE: Fixture = {
  "lib.ts": "export const lib = 7;\nexport const outsideOnly = 1;\n",
  "file.ts": "export const outsideFile = 1;\n",
};

type Project = {
  root: string;
  outside: string;
  discovery: Discovery;
  cacheDirs: { update: string; rebuild: string; session: string };
  write: (name: string, text: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
  /** A link to a directory, spelled `target` (relative to the link's directory, or absolute). */
  linkDirectory: (name: string, target: string) => Promise<void>;
  linkFile: (name: string, target: string) => Promise<void>;
  commit: () => void;
};

async function createProject(discovery: Discovery): Promise<Project> {
  const root = await roots.create(`cg-links-${discovery}-`);
  const outside = await roots.create(`cg-links-outside-${discovery}-`);
  const cacheDirs = {
    update: await roots.create(`cg-links-cache-update-${discovery}-`),
    rebuild: await roots.create(`cg-links-cache-rebuild-${discovery}-`),
    session: await roots.create(`cg-links-cache-session-${discovery}-`),
  };
  diskCaches.push(
    { root, cacheDir: cacheDirs.update },
    { root, cacheDir: cacheDirs.rebuild },
    { root, cacheDir: cacheDirs.session },
  );
  const write = async (name: string, text: string): Promise<void> => {
    const file = path.join(root, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text, "utf8");
  };
  const link = async (name: string, target: string, type: "dir" | "file"): Promise<void> => {
    const linkPath = path.join(root, name);
    await fsp.mkdir(path.dirname(linkPath), { recursive: true });
    await fsp.symlink(target, linkPath, type);
  };
  for (const [name, text] of Object.entries(FIXTURE)) await write(name, text);
  for (const [name, text] of Object.entries(OUTSIDE)) await fsp.writeFile(path.join(outside, name), text, "utf8");
  const project: Project = {
    root,
    outside,
    discovery,
    cacheDirs,
    write,
    remove: async (name) => await fsp.rm(path.join(root, name), { recursive: true, force: true }),
    linkDirectory: async (name, target) => await link(name, target, "dir"),
    linkFile: async (name, target) => await link(name, target, "file"),
    commit: () => {
      if (discovery !== "git") return;
      runGit(root, ["add", "-A"]);
      runGit(root, ["commit", "-qm", "step"]);
    },
  };
  await project.linkDirectory("src/linked", "real");
  await project.linkFile("src/filelink.ts", path.join("real", "util.ts"));
  if (discovery === "git") {
    runGit(root, ["init", "-q"]);
    runGit(root, ["config", "user.email", "tests@example.com"]);
    runGit(root, ["config", "user.name", "Tests"]);
    runGit(root, ["config", "core.autocrlf", "false"]);
    project.commit();
  }
  return project;
}

type CacheMode = "off" | "memory" | "disk";

function buildOptions(
  project: Project,
  cache: CacheMode,
  cacheDir?: string,
  extra: Partial<IncrementalBuildOptions> = {},
): IncrementalBuildOptions {
  return {
    cache,
    ...(cache === "disk" ? { cacheDir: cacheDir ?? project.cacheDirs.update } : {}),
    threads: 1,
    logLevel: "silent",
    ...extra,
  };
}

function relativePaths(root: string, files: Iterable<string>): string[] {
  return [...files].map((file) => normalizePath(path.relative(root, file)));
}

/** Everything a consumer reads from an index, in the order it reads it: the modules, both graphs, project files. */
async function listings(index: ProjectIndex) {
  const symbols = await buildSymbolGraph(index);
  return {
    modules: [...index.byFile.values()].map((mod) => mod.file),
    fileNodes: [...index.graph.nodes],
    fileEdges: index.graph.edges.map((edge) => JSON.stringify(edge)),
    symbolNodes: [...symbols.nodes.values()].map((node) => JSON.stringify(node)),
    symbolEdges: symbols.edges.map((edge) => JSON.stringify(edge)),
    projectFiles: (index.projectFiles ?? []).map((file) => file.path),
  };
}

const DIRECTORY_LINKS = ["src/linked/", "src/nested/alias/", "src/zzz/linkdir/"];
const FILE_LINKS = ["src/filelink.ts", "src/zzz/linkfile.ts"];

/** The modules a link reaches: the files below a directory link, and a link that is itself a file. */
function reachedThroughLinks(project: Project, index: ProjectIndex): { directories: string[]; files: string[] } {
  const modules = relativePaths(
    project.root,
    [...index.byFile.values()].map((mod) => mod.file),
  );
  return {
    directories: modules.filter((file) => DIRECTORY_LINKS.some((prefix) => file.startsWith(prefix))).sort(),
    files: modules.filter((file) => FILE_LINKS.includes(file)).sort(),
  };
}

const below = (directory: string, names: readonly string[]): string[] => names.map((name) => `${directory}/${name}.ts`);
const linked = (...names: string[]) => below("src/linked", names);
const nested = (...names: string[]) => below("src/nested/alias", names);
const untrackedDirectory = (...names: string[]) => below("src/zzz/linkdir", names);

type Step = {
  name: string;
  apply: (project: Project) => Promise<void>;
  /** The modules below directory links, whichever way discovery finds the project. */
  directories: readonly string[];
  /** The modules that are symlinked files: only Git lists those, a filesystem scan does not follow file links. */
  files: readonly string[];
};

const INSIDE = ["src/filelink.ts"];
const REAL_LIB_EDITED = "export const lib = 2;\nexport const added = 3;\n";
const REAL_UTIL = FIXTURE["src/real/util.ts"]!;

/**
 * Each way a link or its target can change between updates: the target file or directory deleted and restored, a file
 * added below a link, a link removed, replaced by a directory and restored, retargeted inside the root and outside it,
 * and a link created after the first build (tracked links are committed with the fixture; these are not committed
 * until a step does). Git lists no file below a link and reports no change when a link returns to what it committed,
 * so an update that trusts its diff keeps a link whose target is gone and misses what a link reaches, and a rebuild
 * that trusts the previous listing misses a link that was removed and restored.
 */
const STEPS: Step[] = [
  {
    name: "first build",
    apply: async () => undefined,
    directories: linked("lib", "util"),
    files: INSIDE,
  },
  { name: "no change", apply: async () => undefined, directories: linked("lib", "util"), files: INSIDE },
  {
    name: "edit a target",
    apply: async (project) => await project.write("src/real/lib.ts", REAL_LIB_EDITED),
    directories: linked("lib", "util"),
    files: INSIDE,
  },
  {
    name: "delete a target file",
    apply: async (project) => await project.remove("src/real/util.ts"),
    directories: linked("lib"),
    files: [],
  },
  {
    name: "restore the target file",
    apply: async (project) => await project.write("src/real/util.ts", REAL_UTIL),
    directories: linked("lib", "util"),
    files: INSIDE,
  },
  {
    name: "add a file below a link",
    apply: async (project) => await project.write("src/real/zeta.ts", "export const zeta = 1;\n"),
    directories: linked("lib", "util", "zeta"),
    files: INSIDE,
  },
  {
    name: "delete the target directory",
    apply: async (project) => await project.remove("src/real"),
    directories: [],
    files: [],
  },
  {
    name: "restore the target directory",
    apply: async (project) => {
      await project.write("src/real/lib.ts", "export const lib = 3;\n");
      await project.write("src/real/util.ts", REAL_UTIL.replace("+ 1", "+ 3"));
      await project.write("src/real/zeta.ts", "export const zeta = 11;\n");
    },
    directories: linked("lib", "util", "zeta"),
    files: INSIDE,
  },
  {
    name: "remove a directory link",
    apply: async (project) => await project.remove("src/linked"),
    directories: [],
    files: INSIDE,
  },
  {
    name: "restore the directory link",
    apply: async (project) => await project.linkDirectory("src/linked", "real"),
    directories: linked("lib", "util", "zeta"),
    files: INSIDE,
  },
  {
    name: "replace the directory link with a directory",
    apply: async (project) => {
      await project.remove("src/linked");
      await project.write("src/linked/lib.ts", "export const lib = 77;\n");
    },
    directories: linked("lib"),
    files: INSIDE,
  },
  {
    name: "restore the directory link over the directory",
    apply: async (project) => {
      await project.remove("src/linked");
      await project.linkDirectory("src/linked", "real");
    },
    directories: linked("lib", "util", "zeta"),
    files: INSIDE,
  },
  {
    name: "remove a file link",
    apply: async (project) => await project.remove("src/filelink.ts"),
    directories: linked("lib", "util", "zeta"),
    files: [],
  },
  {
    name: "restore the file link",
    apply: async (project) => await project.linkFile("src/filelink.ts", path.join("real", "util.ts")),
    directories: linked("lib", "util", "zeta"),
    files: INSIDE,
  },
  {
    name: "retarget a directory link inside the root",
    apply: async (project) => {
      await project.remove("src/linked");
      await project.linkDirectory("src/linked", "other");
    },
    directories: linked("lib", "more"),
    files: INSIDE,
  },
  {
    name: "retarget a file link inside the root",
    apply: async (project) => {
      await project.remove("src/filelink.ts");
      await project.linkFile("src/filelink.ts", path.join("other", "more.ts"));
    },
    directories: linked("lib", "more"),
    files: INSIDE,
  },
  {
    name: "retarget a directory link outside the root",
    apply: async (project) => {
      await project.remove("src/linked");
      await project.linkDirectory("src/linked", project.outside);
    },
    directories: [],
    files: INSIDE,
  },
  {
    name: "retarget a file link outside the root",
    apply: async (project) => {
      await project.remove("src/filelink.ts");
      await project.linkFile("src/filelink.ts", path.join(project.outside, "file.ts"));
    },
    directories: [],
    files: [],
  },
  {
    name: "retarget both links back inside the root",
    apply: async (project) => {
      await project.remove("src/linked");
      await project.linkDirectory("src/linked", "real");
      await project.remove("src/filelink.ts");
      await project.linkFile("src/filelink.ts", path.join("real", "util.ts"));
    },
    directories: linked("lib", "util", "zeta"),
    files: INSIDE,
  },
  {
    name: "add a second directory link",
    apply: async (project) => await project.linkDirectory("src/nested/alias", path.join("..", "real")),
    directories: [...linked("lib", "util", "zeta"), ...nested("lib", "util", "zeta")],
    files: INSIDE,
  },
  {
    name: "commit",
    apply: async (project) => project.commit(),
    directories: [...linked("lib", "util", "zeta"), ...nested("lib", "util", "zeta")],
    files: INSIDE,
  },
  {
    name: "add a file below both links",
    apply: async (project) => await project.write("src/real/extra.ts", "export const extra = 1;\n"),
    directories: [...linked("lib", "util", "zeta", "extra"), ...nested("lib", "util", "zeta", "extra")],
    files: INSIDE,
  },
  {
    name: "edit a file below both links",
    apply: async (project) =>
      await project.write("src/real/lib.ts", "export const lib = 5;\nexport const edited = 5;\n"),
    directories: [...linked("lib", "util", "zeta", "extra"), ...nested("lib", "util", "zeta", "extra")],
    files: INSIDE,
  },
  {
    name: "add an uncommitted directory link",
    apply: async (project) => await project.linkDirectory("src/zzz/linkdir", path.join("..", "other")),
    directories: [
      ...linked("lib", "util", "zeta", "extra"),
      ...nested("lib", "util", "zeta", "extra"),
      ...untrackedDirectory("lib", "more"),
    ],
    files: INSIDE,
  },
  {
    name: "add an uncommitted file link",
    apply: async (project) => await project.linkFile("src/zzz/linkfile.ts", path.join("..", "other", "more.ts")),
    directories: [
      ...linked("lib", "util", "zeta", "extra"),
      ...nested("lib", "util", "zeta", "extra"),
      ...untrackedDirectory("lib", "more"),
    ],
    files: [...INSIDE, "src/zzz/linkfile.ts"],
  },
  {
    name: "edit the target of the uncommitted links",
    apply: async (project) => await project.write("src/other/more.ts", "export const more = 22222;\n"),
    directories: [
      ...linked("lib", "util", "zeta", "extra"),
      ...nested("lib", "util", "zeta", "extra"),
      ...untrackedDirectory("lib", "more"),
    ],
    files: [...INSIDE, "src/zzz/linkfile.ts"],
  },
  {
    name: "retarget the uncommitted file link outside the root",
    apply: async (project) => {
      await project.remove("src/zzz/linkfile.ts");
      await project.linkFile("src/zzz/linkfile.ts", path.join(project.outside, "file.ts"));
    },
    directories: [
      ...linked("lib", "util", "zeta", "extra"),
      ...nested("lib", "util", "zeta", "extra"),
      ...untrackedDirectory("lib", "more"),
    ],
    files: INSIDE,
  },
  {
    name: "retarget the uncommitted directory link outside the root",
    apply: async (project) => {
      await project.remove("src/zzz/linkdir");
      await project.linkDirectory("src/zzz/linkdir", project.outside);
    },
    directories: [...linked("lib", "util", "zeta", "extra"), ...nested("lib", "util", "zeta", "extra")],
    files: INSIDE,
  },
  {
    name: "remove the uncommitted links",
    apply: async (project) => {
      await project.remove("src/zzz/linkdir");
      await project.remove("src/zzz/linkfile.ts");
    },
    directories: [...linked("lib", "util", "zeta", "extra"), ...nested("lib", "util", "zeta", "extra")],
    files: INSIDE,
  },
];

describe.each<Discovery>(["scan", "git"])("symlinks under %s discovery", (discovery) => {
  const links = it.skipIf(!SYMLINKS_AVAILABLE);

  links(
    "keeps memory, disk and session builds equal to a cold build as links and their targets change",
    async () => {
      const project = await createProject(discovery);
      const { root } = project;
      const loadSession = async () =>
        await createAgentSession({
          root,
          useConfig: false,
          buildOptions: buildOptions(project, "disk", project.cacheDirs.session),
        }).loadProject({ symbolGraph: "skip" });
      await buildProjectIndex(root, buildOptions(project, "memory"));
      await buildProjectIndex(root, buildOptions(project, "disk"));
      await buildProjectIndex(root, buildOptions(project, "disk", project.cacheDirs.rebuild));
      await loadSession();
      // Every warm path that differs from the cold build, so that one failure names each step and path that diverged.
      const differences: string[] = [];
      const compare = (label: string, actual: Record<string, unknown>, expected: Record<string, unknown>): void => {
        const differing = Object.keys(expected).filter((name) => !isDeepStrictEqual(actual[name], expected[name]));
        if (differing.length) differences.push(`${label}: ${differing.join(", ")}`);
      };
      for (const [position, step] of STEPS.entries()) {
        await step.apply(project);
        const cold = await buildProjectIndex(root, buildOptions(project, "off"));
        const expected: Record<string, unknown> = await listings(cold);
        // Inclusion and exclusion: the cold build holds exactly the files the links reach.
        expect(reachedThroughLinks(project, cold), `files reached through links after ${step.name}`).toEqual({
          directories: [...step.directories].sort(),
          files: discovery === "git" ? [...step.files].sort() : [],
        });

        const memory = await buildProjectIndexIncremental(root, buildOptions(project, "memory"));
        compare(`memory update after ${step.name}`, await listings(memory), expected);

        const report: BuildReport = { timings: {} };
        const update = await buildProjectIndexIncremental(root, buildOptions(project, "disk", undefined, { report }));
        compare(`disk update after ${step.name}`, await listings(update), expected);
        // An update that fell back to a full rebuild would match for the wrong reason.
        if (position > 0 && !report.manifest?.reused)
          differences.push(`disk update rebuilt in full after ${step.name}`);

        const rebuild = await buildProjectIndex(root, buildOptions(project, "disk", project.cacheDirs.rebuild));
        compare(`disk rebuild after ${step.name}`, await listings(rebuild), expected);

        // The session plans its files from the same manifest and Git signals, then builds that scope.
        const session = await loadSession();
        compare(`session load after ${step.name}`, await listings(session.index), expected);
        const listed = relativePaths(root, await listProjectFiles(root)).sort();
        if (!isDeepStrictEqual(relativePaths(root, session.files).sort(), listed)) {
          differences.push(`session files after ${step.name}`);
        }
      }
      expect(differences).toEqual([]);
    },
    240_000,
  );

  links("lists a project's files through its links the way an update and a rebuild do", async () => {
    const project = await createProject(discovery);
    await project.linkDirectory("src/nested/alias", path.join("..", "real"));
    const listed = relativePaths(project.root, await listProjectFiles(project.root));
    expect(listed).toEqual(expect.arrayContaining(linked("lib", "util").concat(nested("lib", "util"))));
    expect(listed).not.toContain("src/real/missing.ts");
    const expectedFileLink = discovery === "git" ? ["src/filelink.ts"] : [];
    expect(listed.filter((file) => file === "src/filelink.ts")).toEqual(expectedFileLink);
  });
});

describe("recorded symlinks", () => {
  const links = it.skipIf(!SYMLINKS_AVAILABLE);

  links.each<Discovery>(["scan", "git"])(
    "records every symlink a listing screened in the manifest under %s discovery",
    async (discovery) => {
      const project = await createProject(discovery);
      await project.linkDirectory("src/dangling", "missing-directory");
      project.commit();
      const options = buildOptions(project, "disk");
      await buildProjectIndex(project.root, options);
      const manifest = await loadManifest(project.root, options);
      const recorded = relativePaths(project.root, manifest?.symlinks ?? []).sort();
      expect(recorded).toEqual(["src/dangling", "src/filelink.ts", "src/linked"]);
      // A path with nothing at it can hold a link again: a link deleted from a Git project stays recorded.
      if (discovery === "git") {
        await project.remove("src/linked");
        await project.write("src/aaa.ts", "export const aaa = 1;\n");
        await buildProjectIndexIncremental(project.root, options);
        const updated = await loadManifest(project.root, options);
        expect(relativePaths(project.root, updated?.symlinks ?? []).sort()).toEqual([
          "src/dangling",
          "src/filelink.ts",
          "src/linked",
        ]);
      }
    },
  );

  links(
    "ignores the root-modified hint an earlier version wrote, which a link below the root never changed",
    async () => {
      const project = await createProject("scan");
      const options = buildOptions(project, "disk");
      await buildProjectIndex(project.root, options);
      const manifestPath = path.join(cacheRoot(project.root, options), "manifest.json");
      const stored = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as Record<string, unknown>;
      // The older manifest: no list of symlinks, an empty hint that was fresh while the project root did not change.
      delete stored.symlinks;
      stored.symlinkDirectories = [];
      stored.symlinkDirectoriesRootMtimeMs = (await fsp.stat(project.root)).mtimeMs;
      await fsp.writeFile(manifestPath, JSON.stringify(stored), "utf8");
      await project.linkDirectory("src/nested/alias", path.join("..", "real"));
      expect((await fsp.stat(project.root)).mtimeMs).toBe(stored.symlinkDirectoriesRootMtimeMs);

      const rebuilt = await buildProjectIndex(project.root, options);
      expect(relativePaths(project.root, rebuilt.byFile.keys())).toEqual(
        expect.arrayContaining(nested("lib", "util").map((file) => file.toLowerCase())),
      );
      const rewritten = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as Record<string, unknown>;
      expect(rewritten.symlinkDirectories).toBeUndefined();
      expect(rewritten.symlinkDirectoriesRootMtimeMs).toBeUndefined();
      expect(rewritten.symlinks).toEqual(["src/linked", "src/nested/alias", "src/filelink.ts"].sort());
    },
  );

  links("screens no path for an update of a Git project without symlinks", async () => {
    const root = await roots.create("cg-links-none-");
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.writeFile(path.join(root, "src/a.ts"), "export const a = 1;\n", "utf8");
    await fsp.writeFile(path.join(root, "README"), "readme\n", "utf8");
    runGit(root, ["init", "-q"]);
    runGit(root, ["config", "user.email", "tests@example.com"]);
    runGit(root, ["config", "user.name", "Tests"]);
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-qm", "files"]);
    await fsp.writeFile(path.join(root, "src/a.ts"), "export const a = 2;\n", "utf8");
    const manifest = { lastCommit: runGit(root, ["rev-parse", "HEAD"]), symlinks: [] as string[] };
    const reconcile = async () =>
      await reconcileLinkedFiles({
        projectRoot: root,
        manifest,
        trackedEntries: {},
        opts: { logLevel: "silent" },
        context: createProjectDiscoveryContext(root),
        gitSignals: true,
        untrackedFiles: [],
      });
    const lstat = vi.spyOn(fsp, "lstat");
    const realpath = vi.spyOn(fsp, "realpath");
    expect(await reconcile()).toEqual({ files: [], retiredFiles: [], links: [] });
    expect(lstat).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();

    // A recorded link is screened, and what it reaches is listed: the calls above were not skipped by accident.
    await fsp.symlink("src", path.join(root, "linked"), "dir");
    manifest.symlinks.push(normalizePath(path.join(root, "linked")));
    const linkedPlan = await reconcile();
    expect(linkedPlan.files).toEqual([normalizePath(path.join(root, "linked/a.ts"))]);
    expect(linkedPlan.links).toEqual([normalizePath(path.join(root, "linked"))]);
    expect(lstat).toHaveBeenCalled();
  });
});

const modulesOf = (project: Project, index: ProjectIndex): string[] =>
  relativePaths(
    project.root,
    [...index.byFile.values()].map((mod) => mod.file),
  );

type Replacement = "untracked" | "tracked";
type Rewrite = "strict update" | "full build";

describe("updates that list the whole project", () => {
  const links = it.skipIf(!SYMLINKS_AVAILABLE);

  links.each<Replacement>(["untracked", "tracked"])(
    "drops a %s file that became a link to a file outside the root under --cache-strict",
    async (replacement) => {
      const project = await createProject("git");
      // `src/zzz/last.ts` is committed with the fixture, `src/extra.ts` is not.
      const file = replacement === "tracked" ? "src/zzz/last.ts" : "src/extra.ts";
      if (replacement === "untracked") await project.write(file, "export const extra = 1;\n");
      const strict = buildOptions(project, "disk", undefined, { cacheStrict: true });
      expect(modulesOf(project, await buildProjectIndex(project.root, strict))).toContain(file);

      await project.remove(file);
      await project.linkFile(file, path.join(project.outside, "file.ts"));
      const cold = modulesOf(project, await buildProjectIndex(project.root, buildOptions(project, "off")));
      expect(cold).not.toContain(file);
      expect(modulesOf(project, await buildProjectIndexIncremental(project.root, strict))).toEqual(cold);
    },
  );

  links.each<Rewrite>(["strict update", "full build"])(
    "finds a committed directory link that returns after a %s found a directory in its place",
    async (rewrite) => {
      const project = await createProject("git");
      const options = buildOptions(project, "disk");
      await buildProjectIndex(project.root, options);
      await project.remove("src/linked");
      await project.write("src/linked/lib.ts", "export const lib = 77;\n");
      if (rewrite === "strict update") {
        await buildProjectIndexIncremental(project.root, { ...options, cacheStrict: true });
      } else {
        await buildProjectIndex(project.root, options);
      }

      await project.remove("src/linked");
      await project.linkDirectory("src/linked", "real");
      const cold = modulesOf(project, await buildProjectIndex(project.root, buildOptions(project, "off")));
      expect(cold).toContain("src/linked/util.ts");
      expect(modulesOf(project, await buildProjectIndexIncremental(project.root, options))).toEqual(cold);
    },
  );
});

describe("the symlinks an update records", () => {
  const links = it.skipIf(!SYMLINKS_AVAILABLE);

  links("stops recording an untracked link that is gone and keeps a tracked one", async () => {
    const project = await createProject("git");
    const options = buildOptions(project, "disk");
    await buildProjectIndex(project.root, options);
    const recorded = async (): Promise<string[]> =>
      relativePaths(project.root, (await loadManifest(project.root, options))?.symlinks ?? []).sort();
    const base = await recorded();
    for (let round = 0; round < 3; round += 1) {
      await project.linkDirectory(`src/tmp${round}`, "real");
      await buildProjectIndexIncremental(project.root, options);
      expect(await recorded()).toContain(`src/tmp${round}`);
      await project.remove(`src/tmp${round}`);
      await buildProjectIndexIncremental(project.root, options);
    }
    expect(await recorded()).toEqual(base);

    // Git reports nothing when a tracked link returns to what the last commit holds, so it stays recorded.
    await project.remove("src/linked");
    await buildProjectIndexIncremental(project.root, options);
    expect(await recorded()).toEqual(base);
  });

  links("keeps what a link reached when its path cannot be read", async () => {
    const project = await createProject("git");
    const options = buildOptions(project, "disk");
    await buildProjectIndex(project.root, options);
    const manifest = await loadManifest(project.root, options);
    const linkPath = normalizePath(path.join(project.root, "src/linked"));
    const realLstat = fsp.lstat.bind(fsp);
    vi.spyOn(fsp, "lstat").mockImplementation(async (target) => {
      if (normalizePath(String(target)) === linkPath) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return await realLstat(target);
    });
    const plan = await reconcileLinkedFiles({
      projectRoot: project.root,
      manifest: manifest ?? {},
      trackedEntries: manifest?.files ?? {},
      opts: { logLevel: "silent" },
      context: createProjectDiscoveryContext(project.root),
      gitSignals: true,
      untrackedFiles: [],
    });
    expect(plan.retiredFiles).toEqual([]);
    expect(plan.links).toContain(linkPath);
  });
});

describe("a manifest from an earlier version", () => {
  it("loses the symlinked-directory hint when it is loaded", async () => {
    const root = await roots.create("cg-links-legacy-");
    const cacheDir = await roots.create("cg-links-legacy-cache-");
    diskCaches.push({ root, cacheDir });
    await fsp.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
    const options: IncrementalBuildOptions = { cache: "disk", cacheDir, threads: 1, logLevel: "silent" };
    await buildProjectIndex(root, options);
    const manifestPath = path.join(cacheRoot(root, options), "manifest.json");
    const stored = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    stored.symlinkDirectories = [];
    stored.symlinkDirectoriesRootMtimeMs = 1;
    await fsp.writeFile(manifestPath, JSON.stringify(stored), "utf8");

    const loaded = await loadManifest(root, options);
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded ?? {})).not.toContain("symlinkDirectories");
    expect(Object.keys(loaded ?? {})).not.toContain("symlinkDirectoriesRootMtimeMs");
  });
});
