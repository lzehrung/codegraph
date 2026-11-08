import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexFromFiles,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
  type BuildReport,
} from "../src/index.js";
import { createAgentSession } from "../src/agent/session.js";
import {
  cacheRoot,
  clearMemoryCache,
  closeDiskCacheDatabase,
  fileSignature,
  fileSignatureFromSource,
  type ManifestFileEntry,
} from "../src/indexer/build-cache.js";
import {
  findRespelledTrackedFiles,
  listGitWorktreeSignals,
  reconcileGitHiddenChanges,
} from "../src/indexer/incremental-plan.js";
import type { ProjectIndex } from "../src/indexer/types.js";
import { readConfinedUtf8FileWithSize } from "../src/util/confined-file.js";
import {
  createGitDiscoveryCache,
  listChangedFileEntries,
  listFlaggedTrackedFiles,
  listUntrackedAndFlaggedFiles,
  setGitExecutableForTests,
} from "../src/util/git.js";
import { fileIdentityKey, normalizePath, resetFileIdentityCaseSensitivityForTests } from "../src/util/paths.js";
import { createProjectDiscoveryContext } from "../src/util/project-files.js";
import { createTempRootRegistry, tryCreateDirectorySymlink } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";

const roots = createTempRootRegistry();
const links: string[] = [];

afterEach(async () => {
  setGitExecutableForTests(null);
  resetFileIdentityCaseSensitivityForTests();
  clearMemoryCache();
  delete process.env.CODEGRAPH_GIT_CALLS_LOG;
  // Unlink an alias before its directory goes, so nothing removes the repository it points to.
  for (const link of links.splice(0)) await fsp.unlink(link).catch(() => undefined);
  await roots.cleanup();
});

type StoredManifest = {
  updatedAt?: number;
  gitDirtyFiles?: string[];
  gitDirtySubmodules?: string[];
  gitFlaggedFiles?: string[];
};

const manifestPathOf = (root: string): string => path.join(cacheRoot(root, { cache: "disk" }), "manifest.json");

async function readStoredManifest(root: string): Promise<StoredManifest> {
  const stored = JSON.parse(await fsp.readFile(manifestPathOf(root), "utf8")) as StoredManifest;
  return stored;
}

const MAIN = 'import { value } from "./nested/value";\nexport function run() { return value(); }\n';
const ORIGINAL = 'import { left } from "./left";\nexport function value() { return left(); }\n';
const EDITED = 'import { right } from "./right";\nexport function value() { return right(); }\n';
const SOURCES: Record<string, string> = {
  "src/main.ts": MAIN,
  "src/nested/value.ts": ORIGINAL,
  "src/nested/left.ts": "export function left() { return 1; }\n",
  "src/nested/right.ts": "export function right() { return 2; }\n",
  "src/other/value.ts": "export function value() { return 99; }\n",
};

const MODES = ["disk", "memory", "session"] as const;
type UpdateMode = (typeof MODES)[number];

function initRepo(root: string, config: Record<string, string> = {}): void {
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.email", "tests@example.com"]);
  runGit(root, ["config", "user.name", "Tests"]);
  runGit(root, ["config", "core.autocrlf", "false"]);
  for (const [key, value] of Object.entries(config)) runGit(root, ["config", key, value]);
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text);
  }
}

async function createRepo(
  files: Record<string, string>,
  config: Record<string, string> = {},
  attributes?: string,
): Promise<string> {
  const root = await roots.create("cg-hidden-changes-");
  initRepo(root, config);
  await writeFiles(root, files);
  if (attributes) await fsp.writeFile(path.join(root, ".gitattributes"), attributes);
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-qm", "base"]);
  return root;
}

/** One warm engine per mode: a direct incremental build, a memory-cache build, or an agent session over the disk cache. */
function createUpdater(root: string, mode: UpdateMode) {
  const options = { cache: mode === "memory" ? "memory" : "disk", threads: 1, logLevel: "silent" } as const;
  const session =
    mode === "session" ? createAgentSession({ root, buildOptions: options, freshness: { policy: "auto" } }) : undefined;
  return {
    async update(): Promise<ProjectIndex> {
      if (!session) return await buildProjectIndexIncremental(root, options);
      session.invalidate();
      return (await session.loadProject({ symbolGraph: "skip" })).index;
    },
    close(): void {
      session?.invalidate();
      closeDiskCacheDatabase(root, options);
      clearMemoryCache();
    },
  };
}

async function symbolEdges(index: ProjectIndex): Promise<string[]> {
  const graph = await buildSymbolGraphDetailed(index);
  return graph.edges
    .map((edge) => {
      const from = graph.nodes.get(edge.from)!;
      const to = graph.nodes.get(edge.to)!;
      return `${from.file}::${from.name}|${edge.label}|${to.file}::${to.name}`;
    })
    .sort();
}

async function navigation(index: ProjectIndex, probe: string): Promise<unknown> {
  const target = { file: probe, line: 2, column: 32 };
  const goto = await goToDefinition(index, target);
  const references = await findReferences(index, target);
  return {
    goto: goto.status === "ok" ? normalizePath(goto.definition.file) : goto.status,
    references:
      references.status === "ok"
        ? {
            coverage: references.referenceCoverage.state,
            sites: references.references.map(({ file, range }) => ({ file: normalizePath(file), range })),
          }
        : references.status,
  };
}

/** The warm index equals a cache-off build of the same worktree: files, modules, edges, symbol edges and navigation. */
async function expectMatchesCold(
  root: string,
  warm: ProjectIndex,
  probe = path.join(root, "src/main.ts"),
): Promise<void> {
  const cold = await buildProjectIndex(root, { cache: "off", threads: 1, logLevel: "silent" });
  expect([...warm.byFile.values()].map((mod) => mod.file).sort()).toEqual(
    [...cold.byFile.values()].map((mod) => mod.file).sort(),
  );
  for (const [key, mod] of cold.byFile) expect(warm.byFile.get(key), key).toEqual(mod);
  expect(new Set(warm.graph.edges)).toEqual(new Set(cold.graph.edges));
  expect(await symbolEdges(warm)).toEqual(await symbolEdges(cold));
  expect(await navigation(warm, probe)).toEqual(await navigation(cold, probe));
}

function importSources(index: ProjectIndex, file: string): string[] | undefined {
  return index.byFile.get(fileIdentityKey(file))?.imports.map((binding) => binding.from);
}

async function fileSystemIgnoresCase(): Promise<boolean> {
  const probe = await roots.create("cg-case-probe-");
  await fsp.writeFile(path.join(probe, "Probe.txt"), "x");
  return await fsp.access(path.join(probe, "probe.txt")).then(
    () => true,
    () => false,
  );
}

/** Logs the arguments of every Git child Codegraph spawns from now on; resolves to the log's path. */
async function recordGitCalls(): Promise<string> {
  const recorder = await roots.create("cg-hidden-recorder-");
  const log = path.join(recorder, "calls.log");
  const script = path.join(recorder, "recording-git.mjs");
  await fsp.writeFile(
    script,
    [
      'import { spawnSync } from "node:child_process";',
      'import fs from "node:fs";',
      "fs.appendFileSync(process.env.CODEGRAPH_GIT_CALLS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
      'const result = spawnSync("git", process.argv.slice(2), { stdio: "inherit", windowsHide: true });',
      "process.exit(result.status ?? 1);",
    ].join("\n"),
  );
  process.env.CODEGRAPH_GIT_CALLS_LOG = log;
  setGitExecutableForTests(process.execPath, [script]);
  return log;
}

async function readCalls(log: string): Promise<string[][]> {
  const text = await fsp.readFile(log, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

/** The Git children of a warm update that finds nothing to do, after a build and an update have settled the manifest. */
async function unchangedUpdateCalls(root: string): Promise<string[][]> {
  const options = { cache: "disk", threads: 1, logLevel: "silent" } as const;
  try {
    await buildProjectIndex(root, options);
    await buildProjectIndexIncremental(root, options);
    const log = await recordGitCalls();
    await buildProjectIndexIncremental(root, options);
    return await readCalls(log);
  } finally {
    setGitExecutableForTests(null);
    closeDiskCacheDatabase(root, options);
  }
}

const callSummary = (calls: string[][]): string[] => calls.map((args) => args.slice(0, 2).join(" ")).sort();

describe("tracked files flagged assume-unchanged or skip-worktree", () => {
  describe.each(["assume-unchanged", "skip-worktree"] as const)("%s", (flag) => {
    it.each(MODES)("matches a cold build after an edit, its reversion and another edit (%s)", async (mode) => {
      const root = await createRepo(SOURCES);
      const value = path.join(root, "src/nested/value.ts");
      const updater = createUpdater(root, mode);
      try {
        await updater.update();
        runGit(root, ["update-index", `--${flag}`, "src/nested/value.ts"]);
        await fsp.writeFile(value, EDITED);
        const edited = await updater.update();
        expect(importSources(edited, value)).toEqual(["./right"]);
        await expectMatchesCold(root, edited);
        await fsp.writeFile(value, ORIGINAL);
        const reverted = await updater.update();
        expect(importSources(reverted, value)).toEqual(["./left"]);
        await expectMatchesCold(root, reverted);
        await fsp.writeFile(value, EDITED);
        const editedAgain = await updater.update();
        expect(importSources(editedAgain, value)).toEqual(["./right"]);
        await expectMatchesCold(root, editedAgain);
      } finally {
        updater.close();
      }
    });

    it.each(MODES)("indexes a flagged file that is deleted and recreated while it stays flagged (%s)", async (mode) => {
      const root = await createRepo(SOURCES);
      const left = path.join(root, "src/nested/left.ts");
      const updater = createUpdater(root, mode);
      try {
        await updater.update();
        runGit(root, ["update-index", `--${flag}`, "src/nested/left.ts"]);
        await fsp.unlink(left);
        const deleted = await updater.update();
        expect(deleted.byFile.has(fileIdentityKey(left))).toBe(false);
        await expectMatchesCold(root, deleted);
        await fsp.writeFile(left, "export function left() { return 3; }\n");
        const recreated = await updater.update();
        expect(recreated.byFile.has(fileIdentityKey(left))).toBe(true);
        await expectMatchesCold(root, recreated);
      } finally {
        updater.close();
      }
    });

    it.each(MODES)("indexes a flagged file that was absent when the index was built (%s)", async (mode) => {
      const root = await createRepo(SOURCES);
      const left = path.join(root, "src/nested/left.ts");
      runGit(root, ["update-index", `--${flag}`, "src/nested/left.ts"]);
      await fsp.unlink(left);
      const updater = createUpdater(root, mode);
      try {
        const absent = await updater.update();
        expect(absent.byFile.has(fileIdentityKey(left))).toBe(false);
        await expectMatchesCold(root, absent);
        await fsp.writeFile(left, "export function left() { return 3; }\n");
        const materialized = await updater.update();
        expect(materialized.byFile.has(fileIdentityKey(left))).toBe(true);
        await expectMatchesCold(root, materialized);
        runGit(root, ["update-index", `--no-${flag}`, "src/nested/left.ts"]);
        await expectMatchesCold(root, await updater.update());
      } finally {
        updater.close();
      }
    });

    it.each(MODES)("sees an edit made while flagged revert after the flag is cleared (%s)", async (mode) => {
      const root = await createRepo(SOURCES);
      const value = path.join(root, "src/nested/value.ts");
      const updater = createUpdater(root, mode);
      try {
        await updater.update();
        runGit(root, ["update-index", `--${flag}`, "src/nested/value.ts"]);
        await fsp.writeFile(value, EDITED);
        expect(importSources(await updater.update(), value)).toEqual(["./right"]);
        // The flag stops hiding the edit, which is already indexed: nothing but Git's diff changed.
        runGit(root, ["update-index", `--no-${flag}`, "src/nested/value.ts"]);
        const unflagged = await updater.update();
        expect(importSources(unflagged, value)).toEqual(["./right"]);
        await expectMatchesCold(root, unflagged);
        // The reverted file equals HEAD, so Git's diff is empty and the file is no longer flagged.
        runGit(root, ["checkout", "--", "src/nested/value.ts"]);
        const reverted = await updater.update();
        expect(importSources(reverted, value)).toEqual(["./left"]);
        await expectMatchesCold(root, reverted);
      } finally {
        updater.close();
      }
    });

    it.each(MODES)("sees an edit made while flagged revert in the step that clears the flag (%s)", async (mode) => {
      const root = await createRepo(SOURCES);
      const value = path.join(root, "src/nested/value.ts");
      const updater = createUpdater(root, mode);
      try {
        await updater.update();
        runGit(root, ["update-index", `--${flag}`, "src/nested/value.ts"]);
        await fsp.writeFile(value, EDITED);
        expect(importSources(await updater.update(), value)).toEqual(["./right"]);
        runGit(root, ["update-index", `--no-${flag}`, "src/nested/value.ts"]);
        runGit(root, ["checkout", "--", "src/nested/value.ts"]);
        const reverted = await updater.update();
        expect(importSources(reverted, value)).toEqual(["./left"]);
        await expectMatchesCold(root, reverted);
      } finally {
        updater.close();
      }
    });
  });

  it("lists assume-unchanged and skip-worktree tracked files beside the untracked ones in one Git child", async () => {
    const root = await createRepo({ ...SOURCES, "src/both.ts": "export const both = 1;\n" });
    runGit(root, ["update-index", "--assume-unchanged", "src/nested/left.ts"]);
    runGit(root, ["update-index", "--skip-worktree", "src/nested/right.ts"]);
    runGit(root, ["update-index", "--assume-unchanged", "--skip-worktree", "src/both.ts"]);
    await fsp.writeFile(path.join(root, "fresh.ts"), "export const fresh = 1;\n");
    const listing = await listUntrackedAndFlaggedFiles(root, { discoveryCache: createGitDiscoveryCache() });
    const relative = (files: readonly string[] | undefined) =>
      (files ?? []).map((file) => path.relative(root, file).replace(/\\/g, "/")).sort();
    expect(relative(listing.untracked)).toEqual(["fresh.ts"]);
    expect(relative(listing.flaggedFiles?.())).toEqual(["src/both.ts", "src/nested/left.ts", "src/nested/right.ts"]);
    expect(listing.trackedPaths?.().has(normalizePath(path.join(root, "src/main.ts")))).toBe(true);
    expect(listing.trackedPaths?.().has(normalizePath(path.join(root, "fresh.ts")))).toBe(false);
  });

  it("names every tracked and untracked path of the listing, in Git's spelling, for the spelling comparison", async () => {
    const root = await createRepo(SOURCES);
    await fsp.writeFile(path.join(root, "fresh.ts"), "export const fresh = 1;\n");
    const signals = await listGitWorktreeSignals(root, undefined, createProjectDiscoveryContext(root));
    const listed = [...signals.listedFiles()];
    expect(listed.map((file) => path.relative(root, file).replace(/\\/g, "/")).sort()).toEqual(
      [...Object.keys(SOURCES), "fresh.ts"].sort(),
    );
    for (const file of listed) expect(signals.isCurrentSpelling(file)).toBe(true);
    expect(signals.isCurrentSpelling(normalizePath(path.join(root, "src/MAIN.ts")))).toBe(false);
  });

  it("records every flagged tracked file in the manifest, indexed or absent, relative to the project root", async () => {
    const root = await createRepo(SOURCES);
    const options = { cache: "disk", threads: 1, logLevel: "silent" } as const;
    runGit(root, ["update-index", "--assume-unchanged", "src/nested/left.ts"]);
    runGit(root, ["update-index", "--skip-worktree", "src/other/value.ts"]);
    await fsp.unlink(path.join(root, "src/other/value.ts"));
    try {
      await buildProjectIndex(root, options);
      const recorded = (await readStoredManifest(root)).gitFlaggedFiles ?? [];
      expect([...recorded].sort()).toEqual(["src/nested/left.ts", "src/other/value.ts"]);
      // A rewrite after the flag is cleared records what is flagged then.
      runGit(root, ["update-index", "--no-assume-unchanged", "src/nested/left.ts"]);
      await fsp.writeFile(path.join(root, "src/nested/right.ts"), "export function right() { return 3; }\n");
      await buildProjectIndexIncremental(root, options);
      expect((await readStoredManifest(root)).gitFlaggedFiles).toEqual(["src/other/value.ts"]);
    } finally {
      closeDiskCacheDatabase(root, options);
    }
  });

  it.each(["intact", "missing", "invalid"] as const)(
    "finds a file a flag hid and a restore brought back unflagged when the flagged record is %s",
    async (record) => {
      const root = await createRepo(SOURCES);
      const left = path.join(root, "src/nested/left.ts");
      const options = { cache: "disk", threads: 1, logLevel: "silent" } as const;
      try {
        runGit(root, ["update-index", "--skip-worktree", "src/nested/left.ts"]);
        await buildProjectIndex(root, options);
        await fsp.unlink(left);
        await buildProjectIndexIncremental(root, options);
        // Restored from HEAD and no longer flagged: Git's diff names nothing, and nothing flags the file.
        runGit(root, ["update-index", "--no-skip-worktree", "src/nested/left.ts"]);
        runGit(root, ["checkout", "--", "src/nested/left.ts"]);
        const stored = JSON.parse(await fsp.readFile(manifestPathOf(root), "utf8")) as Record<string, unknown>;
        // Without the flagged record the dirty record cannot be trusted, so the update compares blob ids instead.
        if (record === "missing") delete stored.gitFlaggedFiles;
        if (record === "invalid") stored.gitFlaggedFiles = ["../outside.ts"];
        await fsp.writeFile(manifestPathOf(root), JSON.stringify(stored));
        const restored = await buildProjectIndexIncremental(root, options);
        expect(restored.byFile.has(fileIdentityKey(left))).toBe(true);
        await expectMatchesCold(root, restored);
      } finally {
        closeDiskCacheDatabase(root, options);
      }
    },
  );

  describe("an mtime-only change", () => {
    let touchedAt = Date.now() + 60_000;
    const touch = async (file: string): Promise<void> => {
      touchedAt += 5_000;
      await fsp.utimes(file, new Date(touchedAt), new Date(touchedAt));
    };

    it.each(["disk", "session"] as const)(
      "leaves the manifest alone when the file is one Git's diff reports (%s)",
      async (mode) => {
        const root = await createRepo(SOURCES);
        const value = path.join(root, "src/nested/value.ts");
        const updater = createUpdater(root, mode);
        try {
          await updater.update();
          await fsp.writeFile(value, EDITED);
          await updater.update();
          const written = (await readStoredManifest(root)).updatedAt;
          await touch(value);
          const touched = await updater.update();
          expect(importSources(touched, value)).toEqual(["./right"]);
          expect((await readStoredManifest(root)).updatedAt).toBe(written);
          await expectMatchesCold(root, touched);
        } finally {
          updater.close();
        }
      },
    );

    it.each(["disk", "session"] as const)(
      "rewrites the manifest once for a flagged file, so later updates need no signature pass (%s)",
      async (mode) => {
        const root = await createRepo(SOURCES);
        const left = path.join(root, "src/nested/left.ts");
        runGit(root, ["update-index", "--skip-worktree", "src/nested/left.ts"]);
        const updater = createUpdater(root, mode);
        try {
          await updater.update();
          const written = (await readStoredManifest(root)).updatedAt ?? 0;
          await touch(left);
          await updater.update();
          const refreshed = (await readStoredManifest(root)).updatedAt ?? 0;
          expect(refreshed).toBeGreaterThan(written);
          const log = await recordGitCalls();
          const settled = await updater.update();
          expect((await readStoredManifest(root)).updatedAt).toBe(refreshed);
          const calls = await readCalls(log);
          expect(calls.filter((args) => args[0] === "hash-object")).toEqual([]);
          expect(calls.filter((args) => args[0] === "ls-files" && args.includes("-s"))).toEqual([]);
          await expectMatchesCold(root, settled);
        } finally {
          updater.close();
        }
      },
    );
  });
});

describe("files inside submodules", () => {
  const HELPER_ORIGINAL = 'import { one } from "./one";\nexport function helper() { return one(); }\n';
  const HELPER_EDITED = 'import { two } from "./two";\nexport function helper() { return two(); }\n';
  const SUPER_MAIN = 'import { helper } from "../vendor/lib/helper";\nexport function run() { return helper(); }\n';

  async function createSubmoduleRepo(): Promise<{ root: string; helper: string; submodule: string }> {
    const source = await roots.create("cg-hidden-submodule-source-");
    initRepo(source);
    await writeFiles(source, {
      "helper.ts": HELPER_ORIGINAL,
      "one.ts": "export function one() { return 1; }\n",
      "two.ts": "export function two() { return 2; }\n",
    });
    runGit(source, ["add", "-A"]);
    runGit(source, ["commit", "-qm", "source"]);
    const root = await roots.create("cg-hidden-submodule-root-");
    initRepo(root);
    await writeFiles(root, { "src/main.ts": SUPER_MAIN });
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-qm", "base"]);
    runGit(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor/lib"]);
    runGit(root, ["commit", "-qm", "add submodule"]);
    const submodule = path.join(root, "vendor/lib");
    initRepo(submodule);
    return { root, helper: path.join(submodule, "helper.ts"), submodule };
  }

  it.each(MODES)("matches a cold build after an edit and its reversion inside a submodule (%s)", async (mode) => {
    const { root, helper, submodule } = await createSubmoduleRepo();
    const updater = createUpdater(root, mode);
    try {
      await updater.update();
      await fsp.writeFile(helper, HELPER_EDITED);
      const edited = await updater.update();
      expect(importSources(edited, helper)).toEqual(["./two"]);
      await expectMatchesCold(root, edited);
      runGit(submodule, ["checkout", "--", "helper.ts"]);
      const reverted = await updater.update();
      expect(importSources(reverted, helper)).toEqual(["./one"]);
      await expectMatchesCold(root, reverted);
      await fsp.writeFile(helper, HELPER_EDITED);
      await expectMatchesCold(root, await updater.update());
    } finally {
      updater.close();
    }
  });

  it.each(MODES)("matches a cold build after a deletion and a restoration inside a submodule (%s)", async (mode) => {
    const { root, helper, submodule } = await createSubmoduleRepo();
    const updater = createUpdater(root, mode);
    try {
      await updater.update();
      await fsp.unlink(helper);
      const deleted = await updater.update();
      expect(deleted.byFile.has(fileIdentityKey(helper))).toBe(false);
      await expectMatchesCold(root, deleted);
      runGit(submodule, ["checkout", "--", "helper.ts"]);
      const restored = await updater.update();
      expect(restored.byFile.has(fileIdentityKey(helper))).toBe(true);
      await expectMatchesCold(root, restored);
    } finally {
      updater.close();
    }
  });

  it.each(MODES)("matches a cold build after a new file and a new commit inside a submodule (%s)", async (mode) => {
    const { root, helper, submodule } = await createSubmoduleRepo();
    const extra = path.join(submodule, "extra.ts");
    const updater = createUpdater(root, mode);
    try {
      await updater.update();
      await fsp.writeFile(extra, 'import { two } from "./two";\nexport const extra = two();\n');
      const added = await updater.update();
      expect(added.byFile.has(fileIdentityKey(extra))).toBe(true);
      await expectMatchesCold(root, added);
      await fsp.unlink(extra);
      const removed = await updater.update();
      expect(removed.byFile.has(fileIdentityKey(extra))).toBe(false);
      await expectMatchesCold(root, removed);
      await fsp.writeFile(helper, HELPER_EDITED);
      runGit(submodule, ["commit", "-qam", "edit helper"]);
      const committed = await updater.update();
      expect(importSources(committed, helper)).toEqual(["./two"]);
      await expectMatchesCold(root, committed);
      runGit(root, ["add", "vendor/lib"]);
      runGit(root, ["commit", "-qm", "bump submodule"]);
      await expectMatchesCold(root, await updater.update());
      runGit(submodule, ["reset", "-q", "--hard", "HEAD~1"]);
      const reset = await updater.update();
      expect(importSources(reset, helper)).toEqual(["./one"]);
      await expectMatchesCold(root, reset);
    } finally {
      updater.close();
    }
  });

  it("reports a changed submodule as one gitlink, which a default diff omits while it holds untracked files only", async () => {
    const { root, submodule } = await createSubmoduleRepo();
    const base = runGit(root, ["rev-parse", "HEAD"]);
    await fsp.writeFile(path.join(submodule, "scratch.ts"), "export const scratch = 1;\n");
    const hidden = { base, head: "WORKTREE", includeRenameSources: true } as const;
    expect((await listChangedFileEntries(root, hidden)).files).toEqual([]);
    const complete = await listChangedFileEntries(root, { ...hidden, includeHiddenSubmoduleChanges: true });
    const gitlink = normalizePath(path.join(root, "vendor/lib"));
    expect(complete).toEqual({ files: [gitlink], gitlinks: [gitlink] });
    runGit(root, ["config", "diff.ignoreSubmodules", "all"]);
    await fsp.appendFile(path.join(submodule, "helper.ts"), "// edit\n");
    expect((await listChangedFileEntries(root, { ...hidden, includeHiddenSubmoduleChanges: true })).gitlinks).toEqual([
      gitlink,
    ]);
  });

  it("records a dirty submodule in the manifest and clears it after the submodule is restored", async () => {
    const { root, helper, submodule } = await createSubmoduleRepo();
    const options = { cache: "disk", threads: 1, logLevel: "silent" } as const;
    const recorded = async () => (await readStoredManifest(root)).gitDirtySubmodules;
    try {
      await buildProjectIndex(root, options);
      expect(await recorded()).toEqual([]);
      await fsp.writeFile(helper, HELPER_EDITED);
      await buildProjectIndexIncremental(root, options);
      expect(await recorded()).toEqual(["vendor/lib"]);
      runGit(submodule, ["checkout", "--", "helper.ts"]);
      await buildProjectIndexIncremental(root, options);
      expect(await recorded()).toEqual([]);
    } finally {
      closeDiskCacheDatabase(root, options);
    }
  });

  it("settles a case-only rename inside a submodule by the submodule's own listing", async () => {
    resetFileIdentityCaseSensitivityForTests(true);
    const { root, helper, submodule } = await createSubmoduleRepo();
    await writeFiles(submodule, { "deep/z/w.ts": "export function w() { return 1; }\n" });
    runGit(submodule, ["add", "-A"]);
    runGit(submodule, ["commit", "-qm", "deeper"]);
    const entry = { sig: "1:1", edges: [] } satisfies ManifestFileEntry;
    const keyOf = (name: string): string => normalizePath(path.join(submodule, name));
    const trackedEntries: Record<string, ManifestFileEntry> = {
      [normalizePath(helper)]: entry,
      [keyOf("deep/z/w.ts")]: entry,
      [keyOf("one.ts")]: entry,
    };
    runGit(submodule, ["mv", "helper.ts", "Helper.ts"]);
    runGit(submodule, ["mv", "deep/z", "deep/q"]);
    runGit(submodule, ["mv", "deep/q", "deep/Z"]);
    const gitlink = normalizePath(submodule);
    const context = createProjectDiscoveryContext(root);
    const hidden = await reconcileGitHiddenChanges({
      projectRoot: root,
      trackedEntries,
      gitCandidates: [],
      changedSubmodules: [gitlink],
      manifest: { gitDirtySubmodules: [gitlink] },
      signals: await listGitWorktreeSignals(root, undefined, context),
      opts: undefined,
      context,
    });
    const retired = [normalizePath(helper), keyOf("deep/z/w.ts")];
    expect([...hidden.retiredTrackedFiles].sort()).toEqual([...retired].sort());
    expect(hidden.droppedSpellings).toEqual(new Set(retired));
    expect(Object.keys(trackedEntries)).toEqual([keyOf("one.ts")]);
    expect(hidden.files).toContain(keyOf("Helper.ts"));
    expect(hidden.files).toContain(keyOf("deep/Z/w.ts"));
    expect(hidden.files).not.toContain(normalizePath(helper));
    expect(hidden.files).not.toContain(keyOf("deep/z/w.ts"));
  });

  it.each(MODES)(
    "keeps the spelling Git records for a file and a directory renamed by case inside a submodule (%s)",
    async (mode) => {
      if (!(await fileSystemIgnoresCase())) return;
      const { root, submodule } = await createSubmoduleRepo();
      await writeFiles(submodule, {
        "Cased.ts": 'import { one } from "./one";\nexport function cased() { return one(); }\n',
        "deep/z/w.ts": 'import { two } from "../../two";\nexport function w() { return two(); }\n',
      });
      runGit(submodule, ["add", "-A"]);
      runGit(submodule, ["commit", "-qm", "more files"]);
      runGit(root, ["add", "vendor/lib"]);
      runGit(root, ["commit", "-qm", "bump submodule"]);
      const spelled = (index: ProjectIndex): string[] =>
        [...index.byFile.values()]
          .map((mod) => path.relative(root, mod.file).replace(/\\/g, "/"))
          .filter((file) => /cased|deep/i.test(file))
          .sort();
      const updater = createUpdater(root, mode);
      try {
        expect(spelled(await updater.update())).toEqual(["vendor/lib/Cased.ts", "vendor/lib/deep/z/w.ts"]);
        runGit(submodule, ["mv", "Cased.ts", "cased.ts"]);
        runGit(submodule, ["mv", "deep/z", "deep/q"]);
        runGit(submodule, ["mv", "deep/q", "deep/Z"]);
        const renamed = await updater.update();
        expect(spelled(renamed)).toEqual(["vendor/lib/cased.ts", "vendor/lib/deep/Z/w.ts"]);
        await expectMatchesCold(root, renamed);
        runGit(submodule, ["mv", "cased.ts", "Cased.ts"]);
        const back = await updater.update();
        expect(spelled(back)).toEqual(["vendor/lib/Cased.ts", "vendor/lib/deep/Z/w.ts"]);
        await expectMatchesCold(root, back);
      } finally {
        updater.close();
      }
    },
  );

  it("lists a dirty submodule with two more Git children, and a clean one with none", async () => {
    const clean = await createSubmoduleRepo();
    const dirty = await createSubmoduleRepo();
    await fsp.writeFile(dirty.helper, HELPER_EDITED);
    const cleanCalls = await unchangedUpdateCalls(clean.root);
    const dirtyCalls = await unchangedUpdateCalls(dirty.root);
    const extra = callSummary(dirtyCalls);
    for (const entry of callSummary(cleanCalls)) extra.splice(extra.indexOf(entry), 1);
    // The submodule's tracked files and its nested submodules. Its untracked files come from the listing that
    // discovery shares, so a dirty submodule adds at most one more child for them, and none here.
    expect(extra).toEqual(["ls-files --stage", "ls-files -z"]);
    expect(dirtyCalls.filter((args) => args[0] === "hash-object")).toEqual([]);
  });

  it("misses an edit to a file flagged in the submodule's own index until every file is compared (documented limit)", async () => {
    const { root, helper, submodule } = await createSubmoduleRepo();
    const options = { cache: "disk", threads: 1, logLevel: "silent" } as const;
    try {
      await buildProjectIndex(root, options);
      // The superproject reads the submodule as clean, and its own listings name no flag inside the submodule.
      runGit(submodule, ["update-index", "--assume-unchanged", "helper.ts"]);
      await fsp.writeFile(helper, HELPER_EDITED);
      expect(importSources(await buildProjectIndexIncremental(root, options), helper)).toEqual(["./one"]);
      const strict = await buildProjectIndexIncremental(root, { ...options, cacheStrict: true });
      expect(importSources(strict, helper)).toEqual(["./two"]);
      await expectMatchesCold(root, strict);
    } finally {
      closeDiskCacheDatabase(root, options);
    }
  });
});

describe("line-ending rewrites that Git reports clean", () => {
  const JAVA = [
    "package demo;",
    "",
    "/**",
    " * Greets people.",
    " */",
    "public class Greeter {",
    '    public String hello() { return "hi"; }',
    "",
    "    public static class Inner {",
    "        public int value() { return 1; }",
    "    }",
    "}",
    "",
  ].join("\n");
  const TS_DOCUMENTED = [
    'import { left } from "./left";',
    "",
    "/**",
    " * Computes the value.",
    " * Second doc line.",
    " */",
    "export function value() {",
    "  return left();",
    "}",
    "",
  ].join("\n");
  const FILES: Record<string, string> = {
    ...SOURCES,
    "src/nested/value.ts": TS_DOCUMENTED,
    "src/demo/Greeter.java": JAVA,
    "src/demo/Use.java": "package demo;\n\npublic class Use {\n    String run() { return new Greeter().hello(); }\n}\n",
  };
  const toCrlf = (text: string): string => text.replace(/\r?\n/g, "\r\n");
  const toLf = (text: string): string => text.replace(/\r\n/g, "\n");

  const CONFIGS = [
    { name: "core.autocrlf=true", config: { "core.autocrlf": "true" }, attributes: undefined },
    { name: "core.autocrlf=input", config: { "core.autocrlf": "input" }, attributes: undefined },
    {
      name: "text eol=crlf attribute",
      config: {},
      attributes: "* text=auto\n*.ts text eol=crlf\n*.java text eol=lf\n",
    },
  ] as const;

  describe.each(CONFIGS)("$name", ({ config, attributes }) => {
    it.each(MODES)("matches a cold build when an eol-only rewrite meets a signature pass (%s)", async (mode) => {
      const root = await createRepo(FILES, config, attributes);
      const left = path.join(root, "src/nested/left.ts");
      const greeter = path.join(root, "src/demo/Greeter.java");
      const rewrite = async (transform: (text: string) => string): Promise<void> => {
        for (const name of ["src/nested/value.ts", "src/demo/Greeter.java"]) {
          const file = path.join(root, name);
          await fsp.writeFile(file, transform(toLf(await fsp.readFile(file, "utf8"))));
        }
      };
      const updater = createUpdater(root, mode);
      try {
        const original = await updater.update();
        await rewrite(toCrlf);
        // The diff against the indexed commit, which a clean update trusts, reports the rewritten files clean.
        expect(
          runGit(root, ["diff", "--name-only", "HEAD", "--", "src/nested/value.ts", "src/demo/Greeter.java"]),
        ).toBe("");
        // An edit beside them makes the update compare signatures, which carry each file's raw size.
        await fsp.writeFile(left, "export function left() { return 10; }\n");
        const crlf = await updater.update();
        expect(crlf.byFile.get(fileIdentityKey(greeter))).not.toEqual(original.byFile.get(fileIdentityKey(greeter)));
        await expectMatchesCold(root, crlf);
        await rewrite(toLf);
        await fsp.writeFile(left, "export function left() { return 11; }\n");
        const lf = await updater.update();
        expect(lf.byFile.get(fileIdentityKey(greeter))).toEqual(original.byFile.get(fileIdentityKey(greeter)));
        await expectMatchesCold(root, lf);
      } finally {
        updater.close();
      }
    });
  });

  it("matches a cold build after an eol-only rewrite when every update compares signatures (memory)", async () => {
    const root = await createRepo(FILES, { "core.autocrlf": "true" });
    const greeter = path.join(root, "src/demo/Greeter.java");
    const updater = createUpdater(root, "memory");
    try {
      const original = await updater.update();
      await fsp.writeFile(greeter, toCrlf(JAVA));
      const crlf = await updater.update();
      expect(crlf.byFile.get(fileIdentityKey(greeter))).not.toEqual(original.byFile.get(fileIdentityKey(greeter)));
      await expectMatchesCold(root, crlf);
    } finally {
      updater.close();
    }
  });

  it("leaves an eol-only rewrite of an unchanged file to its next change or a cold build (documented limit)", async () => {
    const root = await createRepo(FILES, { "core.autocrlf": "true" });
    const greeter = path.join(root, "src/demo/Greeter.java");
    const key = fileIdentityKey(greeter);
    const updater = createUpdater(root, "disk");
    try {
      const original = await updater.update();
      await fsp.writeFile(greeter, toCrlf(JAVA));
      // Git reports the file clean and a clean update does not stat tracked files, so the old module stays.
      expect((await updater.update()).byFile.get(key)).toEqual(original.byFile.get(key));
      const cold = await buildProjectIndex(root, { cache: "off", threads: 1, logLevel: "silent" });
      expect(cold.byFile.get(key)).not.toEqual(original.byFile.get(key));
      // `cacheStrict` hashes every file and rediscovers the project, which settles the rewrite.
      const strict = await buildProjectIndexIncremental(root, {
        cache: "disk",
        threads: 1,
        logLevel: "silent",
        cacheStrict: true,
      });
      expect(strict.byFile.get(key)).toEqual(cold.byFile.get(key));
      await fsp.appendFile(greeter, "// edit\r\n");
      await expectMatchesCold(root, await updater.update());
    } finally {
      updater.close();
    }
  });

  it("sees an eol-only rewrite as an ordinary Git change when no conversion applies", async () => {
    const root = await createRepo(FILES, { "core.autocrlf": "false" });
    const updater = createUpdater(root, "disk");
    try {
      await updater.update();
      const greeter = path.join(root, "src/demo/Greeter.java");
      await fsp.writeFile(greeter, toCrlf(JAVA));
      expect(runGit(root, ["status", "--porcelain", "--", "src/demo/Greeter.java"])).toContain("Greeter.java");
      await expectMatchesCold(root, await updater.update());
    } finally {
      updater.close();
    }
  });
});

describe("a case-only rename on a case-insensitive file system", () => {
  const FOO_SOURCES: Record<string, string> = {
    "src/main.ts": 'import { foo } from "./Foo";\nexport function run() { return foo(); }\n',
    "src/Foo.ts": "export function foo() { return 1; }\n",
    "src/other.ts": "export const other = 1;\n",
  };
  const spellings = (index: ProjectIndex, root: string): string[] =>
    [...index.byFile.values()].map((mod) => path.relative(root, mod.file).replace(/\\/g, "/")).sort();

  it.each(MODES)("keeps the spelling Git records, there and back (%s)", async (mode) => {
    if (!(await fileSystemIgnoresCase())) return;
    const root = await createRepo(FOO_SOURCES, { "core.ignorecase": "true" });
    const updater = createUpdater(root, mode);
    try {
      await updater.update();
      runGit(root, ["mv", "src/Foo.ts", "src/foo.ts"]);
      const renamed = await updater.update();
      expect(spellings(renamed, root)).toEqual(["src/foo.ts", "src/main.ts", "src/other.ts"]);
      await expectMatchesCold(root, renamed);
      runGit(root, ["mv", "src/foo.ts", "src/Foo.ts"]);
      const back = await updater.update();
      expect(spellings(back, root)).toEqual(["src/Foo.ts", "src/main.ts", "src/other.ts"]);
      await expectMatchesCold(root, back);
      // A rename that is committed, followed by an unrelated rename, must not resurrect the old spelling.
      runGit(root, ["mv", "src/Foo.ts", "src/foo.ts"]);
      runGit(root, ["commit", "-qm", "rename"]);
      runGit(root, ["mv", "src/other.ts", "src/Other.ts"]);
      const committed = await updater.update();
      expect(spellings(committed, root)).toEqual(["src/Other.ts", "src/foo.ts", "src/main.ts"]);
      await expectMatchesCold(root, committed);
    } finally {
      updater.close();
    }
  });

  /**
   * Leaves the manifest as an update at `HEAD` wrote it, but with the keys it had before: Git's diff against the recorded
   * commit, and the recorded dirty files, name nothing. A branch switch or `git reset --hard` between commits that spell a
   * path differently arrives at that state, and only the spelling of Git's listing says the keys are old.
   */
  async function recordHeadWithOldKeys(root: string): Promise<void> {
    const stored = JSON.parse(await fsp.readFile(manifestPathOf(root), "utf8")) as Record<string, unknown>;
    stored.lastCommit = runGit(root, ["rev-parse", "HEAD"]);
    stored.gitDirtyFiles = [];
    await fsp.writeFile(manifestPathOf(root), JSON.stringify(stored));
  }

  it.each(["disk", "session"] as const)(
    "retires the old spelling of a file when only the index's spelling changed (%s)",
    async (mode) => {
      if (!(await fileSystemIgnoresCase())) return;
      const root = await createRepo(FOO_SOURCES, { "core.ignorecase": "true" });
      const updater = createUpdater(root, mode);
      try {
        await updater.update();
        runGit(root, ["mv", "src/Foo.ts", "src/foo.ts"]);
        runGit(root, ["commit", "-qm", "rename"]);
        await recordHeadWithOldKeys(root);
        expect(runGit(root, ["diff", "--name-only", "HEAD"])).toBe("");
        const respelled = await updater.update();
        expect(spellings(respelled, root)).toEqual(["src/foo.ts", "src/main.ts", "src/other.ts"]);
        await expectMatchesCold(root, respelled);
        // The old key is gone from the manifest, so the next update has nothing to settle.
        const written = (await readStoredManifest(root)).updatedAt;
        await expectMatchesCold(root, await updater.update());
        expect((await readStoredManifest(root)).updatedAt).toBe(written);
      } finally {
        updater.close();
      }
    },
  );

  it("retires every file below a directory whose spelling only the index changed", async () => {
    if (!(await fileSystemIgnoresCase())) return;
    const root = await createRepo(
      {
        "src/main.ts": 'import { b } from "./Nested/b";\nexport function run() { return b; }\n',
        "src/Nested/a.ts": "export const a = 1;\n",
        "src/Nested/b.ts": 'import { a } from "./a";\nexport const b = a;\n',
      },
      { "core.ignorecase": "true" },
    );
    const updater = createUpdater(root, "disk");
    try {
      await updater.update();
      runGit(root, ["mv", "src/Nested", "src/__case_tmp"]);
      runGit(root, ["mv", "src/__case_tmp", "src/nested"]);
      runGit(root, ["commit", "-qm", "rename the directory"]);
      await recordHeadWithOldKeys(root);
      const respelled = await updater.update();
      expect(spellings(respelled, root)).toEqual(["src/main.ts", "src/nested/a.ts", "src/nested/b.ts"]);
      await expectMatchesCold(root, respelled);
    } finally {
      updater.close();
    }
  });

  it("follows an untracked file that is renamed in case, which Git's diff never names", async () => {
    if (!(await fileSystemIgnoresCase())) return;
    const root = await createRepo(FOO_SOURCES, { "core.ignorecase": "true" });
    const updater = createUpdater(root, "disk");
    try {
      await fsp.writeFile(path.join(root, "src/Scratch.ts"), "export const scratch = 1;\n");
      await updater.update();
      await fsp.rename(path.join(root, "src/Scratch.ts"), path.join(root, "src/scratch.ts"));
      const renamed = await updater.update();
      expect(spellings(renamed, root)).toEqual(["src/Foo.ts", "src/main.ts", "src/other.ts", "src/scratch.ts"]);
      await expectMatchesCold(root, renamed);
    } finally {
      updater.close();
    }
  });

  it("keeps the spelling a cold build lists while the index holds a path twice, and after one entry is removed", async () => {
    if (!(await fileSystemIgnoresCase())) return;
    const root = await createRepo(FOO_SOURCES, { "core.ignorecase": "true" });
    const updater = createUpdater(root, "disk");
    try {
      await updater.update();
      runGit(root, ["mv", "src/Foo.ts", "src/foo.ts"]);
      await expectMatchesCold(root, await updater.update());
      // The index now names `Foo.ts` and `foo.ts`: one file, two spellings. A cold build lists both and keeps the last.
      runGit(root, ["checkout", "HEAD", "--", "src/Foo.ts"]);
      expect(runGit(root, ["ls-files"]).split("\n")).toEqual([
        "src/Foo.ts",
        "src/foo.ts",
        "src/main.ts",
        "src/other.ts",
      ]);
      const doubled = await updater.update();
      expect(spellings(doubled, root)).toEqual(["src/foo.ts", "src/main.ts", "src/other.ts"]);
      await expectMatchesCold(root, doubled);
      runGit(root, ["rm", "-q", "--cached", "src/foo.ts"]);
      const single = await updater.update();
      expect(spellings(single, root)).toEqual(["src/Foo.ts", "src/main.ts", "src/other.ts"]);
      await expectMatchesCold(root, single);
    } finally {
      updater.close();
    }
  });

  describe("compared in memory with Git's listing", () => {
    const entry = { sig: "1:1", edges: [] } satisfies ManifestFileEntry;
    const respell = (
      entries: Record<string, ManifestFileEntry>,
      listed: readonly string[],
      candidates: readonly string[] = [],
    ) => findRespelledTrackedFiles(entries, listed, (file) => listed.includes(file), candidates);
    const none = { retiredTrackedFiles: [], respelledFiles: [], droppedSpellings: new Set() };

    it("retires a key the listing spells differently and names the listed spelling", () => {
      resetFileIdentityCaseSensitivityForTests(true);
      const entries = { "/p/src/Foo.ts": entry, "/p/src/keep.ts": entry, "/p/src/gone.ts": entry };
      expect(respell(entries, ["/p/src/foo.ts", "/p/src/keep.ts", "/p/src/new.ts"])).toEqual({
        retiredTrackedFiles: ["/p/src/Foo.ts"],
        respelledFiles: ["/p/src/foo.ts"],
        droppedSpellings: new Set(["/p/src/Foo.ts"]),
      });
    });

    it("retires every key below a respelled directory", () => {
      resetFileIdentityCaseSensitivityForTests(true);
      const entries = { "/p/src/Nested/c.ts": entry, "/p/src/Nested/d.ts": entry, "/p/src/NESTED/e.ts": entry };
      const listed = ["/p/src/nested/c.ts", "/p/src/nested/d.ts", "/p/src/nested/e.ts"];
      const respelled = respell(entries, listed);
      expect(respelled.retiredTrackedFiles.sort()).toEqual(Object.keys(entries).sort());
      expect(respelled.respelledFiles.sort()).toEqual(listed);
    });

    it("retires the old key that the manifest holds beside the listed spelling", () => {
      resetFileIdentityCaseSensitivityForTests(true);
      const entries = { "/p/src/util/Util.ts": entry, "/p/src/util/util.ts": entry };
      expect(respell(entries, ["/p/src/util/Util.ts"])).toEqual({
        retiredTrackedFiles: ["/p/src/util/util.ts"],
        respelledFiles: [],
        droppedSpellings: new Set(["/p/src/util/util.ts"]),
      });
    });

    it("keeps the last spelling a path is listed in, as a cold build does", () => {
      resetFileIdentityCaseSensitivityForTests(true);
      const listed = ["/p/src/Nested/c.ts", "/p/src/nested/c.ts"];
      // The manifest holds the earlier spelling: the later one replaces it.
      expect(respell({ "/p/src/Nested/c.ts": entry }, listed)).toEqual({
        retiredTrackedFiles: ["/p/src/Nested/c.ts"],
        respelledFiles: ["/p/src/nested/c.ts"],
        droppedSpellings: new Set(["/p/src/Nested/c.ts"]),
      });
      // The manifest holds the later one: the earlier spelling a diff names is not a new file.
      expect(respell({ "/p/src/nested/c.ts": entry }, listed, ["/p/src/Nested/c.ts"])).toEqual({
        retiredTrackedFiles: [],
        respelledFiles: [],
        droppedSpellings: new Set(["/p/src/Nested/c.ts"]),
      });
    });

    it("drops a candidate that names a spelling the listing does not use, and names the spelling it uses", () => {
      resetFileIdentityCaseSensitivityForTests(true);
      const candidates = ["/p/src/Foo.ts", "/p/src/foo.ts", "/p/src/other.ts"];
      expect(respell({ "/p/src/foo.ts": entry }, ["/p/src/foo.ts"], candidates)).toEqual({
        ...none,
        droppedSpellings: new Set(["/p/src/Foo.ts"]),
      });
      // The manifest has neither spelling: the listed one must still be verified.
      expect(respell({}, ["/p/src/foo.ts"], ["/p/src/Foo.ts"])).toEqual({
        retiredTrackedFiles: [],
        respelledFiles: ["/p/src/foo.ts"],
        droppedSpellings: new Set(["/p/src/Foo.ts"]),
      });
    });

    it("leaves keys, files and candidates that the listing does not spell in another case", () => {
      resetFileIdentityCaseSensitivityForTests(true);
      const entries = { "/p/src/Foo.ts": entry, "/p/src/gone.ts": entry };
      expect(respell(entries, ["/p/src/foo2.ts"], ["/p/src/other.ts"])).toEqual(none);
      expect(respell({ "/p/a.ts": entry }, ["/p/a.ts"], ["/p/a.ts", "/p/b.ts"])).toEqual(none);
    });

    it("compares nothing on a case-sensitive file system", () => {
      resetFileIdentityCaseSensitivityForTests(false);
      expect(respell({ "/p/src/Foo.ts": entry }, ["/p/src/foo.ts"], ["/p/src/FOO.ts"])).toEqual(none);
    });
  });
});

describe("Git children spawned by incremental updates", () => {
  it.each([
    ["no conversion", { "core.autocrlf": "false" }],
    ["core.autocrlf=true", { "core.autocrlf": "true" }],
  ] as const)("an unchanged warm update spawns one diff and one listing (%s)", async (_name, config) => {
    const root = await createRepo(SOURCES, config);
    const options = { cache: "disk", threads: 1, logLevel: "silent" } as const;
    try {
      await buildProjectIndex(root, options);
      await buildProjectIndexIncremental(root, options);
      const log = await recordGitCalls();
      await buildProjectIndexIncremental(root, options);
      const calls = await readCalls(log);
      expect(calls.filter((args) => args[0] === "diff")).toHaveLength(1);
      // One Git child lists untracked files and the flagged tracked files together.
      expect(
        calls.filter((args) => args[0] === "ls-files" && args.includes("-v") && args.includes("--others")),
      ).toHaveLength(1);
      // A clean update reads no blob ids, hashes no file and runs no configuration or attribute probe.
      expect(calls.filter((args) => args[0] === "hash-object")).toEqual([]);
      expect(calls.filter((args) => args[0] === "ls-files" && (args.includes("-s") || args.includes("-m")))).toEqual(
        [],
      );
      expect(calls.filter((args) => args.includes("core.autocrlf"))).toEqual([]);
      expect(calls.filter((args) => args.some((arg) => arg.startsWith(":(attr:")))).toEqual([]);
    } finally {
      closeDiskCacheDatabase(root, options);
    }
  });

  it("an unchanged warm update with flagged files, indexed or absent, spawns the Git children of one without", async () => {
    const plain = await createRepo(SOURCES);
    const flagged = await createRepo(SOURCES);
    runGit(flagged, ["update-index", "--assume-unchanged", "src/nested/left.ts"]);
    runGit(flagged, ["update-index", "--skip-worktree", "src/nested/right.ts"]);
    runGit(flagged, ["update-index", "--skip-worktree", "src/other/value.ts"]);
    await fsp.unlink(path.join(flagged, "src/other/value.ts"));
    const plainCalls = await unchangedUpdateCalls(plain);
    const flaggedCalls = await unchangedUpdateCalls(flagged);
    expect(callSummary(flaggedCalls)).toEqual(callSummary(plainCalls));
    expect(flaggedCalls.filter((args) => args[0] === "hash-object")).toEqual([]);
  });

  it.each(["disk", "session"] as const)(
    "a one-file update records the flagged files from its own listing and spawns no further Git child for them (%s)",
    async (mode) => {
      const root = await createRepo(SOURCES);
      runGit(root, ["update-index", "--assume-unchanged", "src/nested/left.ts"]);
      runGit(root, ["update-index", "--skip-worktree", "src/other/value.ts"]);
      await fsp.unlink(path.join(root, "src/other/value.ts"));
      const updater = createUpdater(root, mode);
      try {
        await updater.update();
        await updater.update();
        await fsp.writeFile(path.join(root, "src/nested/right.ts"), "export function right() { return 3; }\n");
        const log = await recordGitCalls();
        const updated = await updater.update();
        const calls = await readCalls(log);
        const listings = calls.filter((args) => args[0] === "ls-files" && args.includes("-v") && !args.includes("-s"));
        // One child lists the untracked and the flagged files for the update, and the manifest write reuses it.
        expect(listings).toHaveLength(1);
        expect(listings[0]).toContain("--others");
        // The start of the update and the manifest write each take a diff: an edit made in between is recorded.
        expect(calls.filter((args) => args[0] === "diff")).toHaveLength(2);
        expect([...((await readStoredManifest(root)).gitFlaggedFiles ?? [])].sort()).toEqual([
          "src/nested/left.ts",
          "src/other/value.ts",
        ]);
        await expectMatchesCold(root, updated);
      } finally {
        updater.close();
      }
    },
  );

  it.each([
    ["default discovery", {}],
    ["discovery that includes ignored files", { discovery: { useGitignore: false } }],
  ] as const)("a full build lists the flagged files once, with the untracked ones (%s)", async (_name, extra) => {
    const root = await createRepo(SOURCES);
    runGit(root, ["update-index", "--skip-worktree", "src/nested/left.ts"]);
    const options = { cache: "disk", threads: 1, logLevel: "silent", ...extra } as const;
    try {
      const log = await recordGitCalls();
      await buildProjectIndex(root, options);
      const calls = await readCalls(log);
      const listings = calls.filter((args) => args[0] === "ls-files" && args.includes("-v") && !args.includes("-s"));
      expect(listings).toHaveLength(1);
      expect(listings[0]).toContain("--others");
      expect((await readStoredManifest(root)).gitFlaggedFiles).toEqual(["src/nested/left.ts"]);
    } finally {
      closeDiskCacheDatabase(root, options);
    }
  });

  it("reads the flagged files of a cached listing in either ignore mode, and spawns one child only without one", async () => {
    const root = await createRepo(SOURCES);
    runGit(root, ["update-index", "--skip-worktree", "src/nested/left.ts"]);
    const flagged = [normalizePath(path.join(root, "src/nested/left.ts"))];
    const log = await recordGitCalls();
    for (const respectGitignore of [true, false]) {
      const cache = createGitDiscoveryCache();
      await listUntrackedAndFlaggedFiles(root, { respectGitignore, discoveryCache: cache });
      const listed = (await readCalls(log)).length;
      expect(await listFlaggedTrackedFiles(root, { discoveryCache: cache })).toEqual(flagged);
      expect(await readCalls(log)).toHaveLength(listed);
    }
    const before = (await readCalls(log)).length;
    expect(await listFlaggedTrackedFiles(root, { discoveryCache: createGitDiscoveryCache() })).toEqual(flagged);
    expect(await listFlaggedTrackedFiles(root)).toEqual(flagged);
    expect((await readCalls(log)).slice(before)).toEqual([
      ["ls-files", "-v", "-z"],
      ["ls-files", "-v", "-z"],
    ]);
  });
});

describe("a sparse checkout that widens and narrows", () => {
  const SPARSE_MAIN =
    'import { util } from "./core/util"; import { helper } from "./extras/helper";\n' +
    "export function run() { return util() + helper(); }\n";
  const SPARSE_SOURCES: Record<string, string> = {
    "src/main.ts": SPARSE_MAIN,
    "src/core/util.ts": "export function util() { return 1; }\n",
    "src/extras/helper.ts": 'import { util } from "../core/util";\nexport function helper() { return util(); }\n',
    "src/extras/deep/more.ts": 'import { helper } from "../helper";\nexport function more() { return helper(); }\n',
    "src/extras/notes.txt": "not a source file\n",
  };

  it.each(
    MODES.flatMap((mode) => [
      { mode, project: "" },
      { mode, project: "packages/app" },
    ]),
  )(
    "matches a cold build through `sparse-checkout set` and `add` (project root: '$project', $mode)",
    async ({ mode, project }) => {
      const at = (name: string): string => (project ? `${project}/${name}` : name);
      const repo = await createRepo(
        Object.fromEntries(Object.entries(SPARSE_SOURCES).map(([name, text]) => [at(name), text])),
      );
      const root = project ? path.join(repo, project) : repo;
      const modules = (index: ProjectIndex): string[] =>
        [...index.byFile.values()].map((mod) => path.relative(root, mod.file).replace(/\\/g, "/")).sort();
      const core = ["src/core/util.ts", "src/main.ts"];
      const all = [...core, "src/extras/deep/more.ts", "src/extras/helper.ts"].sort();
      runGit(repo, ["sparse-checkout", "set", "--cone", at("src/core")]);
      const updater = createUpdater(root, mode);
      try {
        const narrow = await updater.update();
        expect(modules(narrow)).toEqual(core);
        await expectMatchesCold(root, narrow);
        expect(modules(await updater.update())).toEqual(core);
        // `add` clears skip-worktree on the directory's files and writes them equal to HEAD: Git's diff stays empty.
        runGit(repo, ["sparse-checkout", "add", at("src/extras")]);
        expect(runGit(repo, ["ls-files", "-v", "--", at("src/extras/helper.ts")])).toMatch(/^H /);
        const widened = await updater.update();
        expect(modules(widened)).toEqual(all);
        await expectMatchesCold(root, widened);
        runGit(repo, ["sparse-checkout", "set", "--cone", at("src/core")]);
        const narrowed = await updater.update();
        expect(modules(narrowed)).toEqual(core);
        await expectMatchesCold(root, narrowed);
        runGit(repo, ["sparse-checkout", "disable"]);
        const full = await updater.update();
        expect(modules(full)).toEqual(all);
        await expectMatchesCold(root, full);
      } finally {
        updater.close();
      }
    },
  );

  it("probes the top of an absent directory tree once, and none of the flagged files below it", async () => {
    const extras = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `src/extras/d${index % 4}/s${index}.ts`,
        `export const s${index} = 1;\n`,
      ]),
    );
    const repo = await createRepo({ ...SPARSE_SOURCES, ...extras });
    runGit(repo, ["sparse-checkout", "set", "--cone", "src/core"]);
    const updater = createUpdater(repo, "disk");
    const probed: string[] = [];
    const access = fsp.access.bind(fsp);
    const spy = vi.spyOn(fsp, "access").mockImplementation(async (target, mode) => {
      probed.push(normalizePath(String(target)));
      return await access(target, mode);
    });
    try {
      await updater.update();
      await updater.update();
      probed.length = 0;
      await updater.update();
      // Every flagged file lives below `src/extras`, which is absent: it is the only path under it that is probed.
      expect(probed.filter((file) => file.includes("/src/extras"))).toEqual([
        normalizePath(path.join(repo, "src/extras")),
      ]);
    } finally {
      spy.mockRestore();
      updater.close();
    }
  });
});

const LAYOUTS = ["plain", "nested", "submodule-as-root", "inside-submodule", "alias"] as const;
type Layout = (typeof LAYOUTS)[number];

/** A project whose root sits as `layout` says, and the directory that runs Git for the repository that owns it. */
async function createLayoutProject(layout: Layout): Promise<{ root: string; git: string } | undefined> {
  const prefixed = (prefix: string): Record<string, string> =>
    Object.fromEntries(Object.entries(SOURCES).map(([name, text]) => [`${prefix}${name}`, text]));
  if (layout === "plain") {
    const root = await createRepo(SOURCES);
    return { root, git: root };
  }
  if (layout === "nested") {
    const repo = await createRepo({
      ...prefixed("packages/app/"),
      "packages/other/outside.ts": "export const x = 1;\n",
    });
    const root = path.join(repo, "packages/app");
    return { root, git: root };
  }
  if (layout === "alias") {
    const repo = await createRepo(SOURCES);
    const alias = path.join(await roots.create("cg-hidden-alias-"), "project");
    if (!(await tryCreateDirectorySymlink(repo, alias))) return undefined;
    links.push(alias);
    return { root: alias, git: repo };
  }
  // The project is a submodule, or a directory inside one: Git runs in the submodule's own repository.
  const inside = layout === "inside-submodule";
  const source = await createRepo(inside ? prefixed("pkg/") : SOURCES);
  const superproject = await createRepo({ "app/entry.ts": "export const entry = 1;\n" });
  runGit(superproject, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "vendor/lib"]);
  runGit(superproject, ["commit", "-qm", "add submodule"]);
  const submodule = path.join(superproject, "vendor/lib");
  initRepo(submodule);
  const root = inside ? path.join(submodule, "pkg") : submodule;
  return { root, git: root };
}

describe.each(LAYOUTS)("flagged files in a project rooted as %s", (layout) => {
  it.each(["disk", "session"] as const)(
    "match a cold build through an edit, a cleared flag, a deletion and a recreation (%s)",
    async (mode) => {
      const project = await createLayoutProject(layout);
      if (!project) return;
      const { root, git } = project;
      const value = path.join(root, "src/nested/value.ts");
      const left = path.join(root, "src/nested/left.ts");
      const updater = createUpdater(root, mode);
      try {
        await updater.update();
        runGit(git, ["update-index", "--skip-worktree", "src/nested/value.ts"]);
        await fsp.writeFile(value, EDITED);
        const edited = await updater.update();
        expect(importSources(edited, value)).toEqual(["./right"]);
        await expectMatchesCold(root, edited);
        runGit(git, ["update-index", "--no-skip-worktree", "src/nested/value.ts"]);
        runGit(git, ["checkout", "--", "src/nested/value.ts"]);
        const reverted = await updater.update();
        expect(importSources(reverted, value)).toEqual(["./left"]);
        await expectMatchesCold(root, reverted);
        runGit(git, ["update-index", "--assume-unchanged", "src/nested/left.ts"]);
        await fsp.unlink(left);
        const deleted = await updater.update();
        expect(deleted.byFile.has(fileIdentityKey(left))).toBe(false);
        await expectMatchesCold(root, deleted);
        await fsp.writeFile(left, "export function left() { return 3; }\n");
        const recreated = await updater.update();
        expect(recreated.byFile.has(fileIdentityKey(left))).toBe(true);
        await expectMatchesCold(root, recreated);
      } finally {
        updater.close();
      }
    },
  );

  it("records the flagged files relative to the project root", async () => {
    const project = await createLayoutProject(layout);
    if (!project) return;
    const { root, git } = project;
    runGit(git, ["update-index", "--skip-worktree", "src/nested/left.ts"]);
    const options = { cache: "disk", threads: 1, logLevel: "silent" } as const;
    try {
      await buildProjectIndex(root, options);
      expect((await readStoredManifest(root)).gitFlaggedFiles).toEqual(["src/nested/left.ts"]);
    } finally {
      closeDiskCacheDatabase(root, options);
    }
  });
});

describe("file signatures of text that is not valid UTF-8", () => {
  const INVALID = Buffer.concat([
    Buffer.from("export const value = 1; // "),
    Buffer.from([0xff, 0xfe, 0xc3, 0x28]),
    Buffer.from("\n"),
  ]);

  async function createInvalidRepo(): Promise<{ root: string; file: string; blob: string }> {
    const root = await createRepo({ "main.ts": "export const main = 1;\n" });
    const file = path.join(root, "bad.ts");
    await fsp.writeFile(file, INVALID);
    runGit(root, ["add", "bad.ts"]);
    runGit(root, ["commit", "-qm", "bad"]);
    return { root, file, blob: runGit(root, ["rev-parse", "HEAD:bad.ts"]) };
  }

  it("takes the raw size of a file that a confined read decodes to text of another length", async () => {
    const { root, file, blob } = await createInvalidRepo();
    const read = await readConfinedUtf8FileWithSize(await fsp.realpath(root), root, file);
    expect(read.size).toBe(INVALID.length);
    expect(Buffer.byteLength(read.source, "utf8")).not.toBe(read.size);
    const fromStat = await fileSignature(file, false, blob);
    expect(fileSignatureFromSource(read.source, read.size, blob).gitSig).toBe(fromStat.gitSig);
    expect(fromStat.gitSig).toBe(`${blob}:${INVALID.length}`);
  });

  it("lets an explicit-file build and an incremental build reuse each other's cached modules", async () => {
    const { root, file } = await createInvalidRepo();
    const options = { cache: "disk", threads: 1, logLevel: "silent" } as const;
    try {
      await buildProjectIndexFromFiles(root, [file], options);
      const report: BuildReport = { timings: {} };
      await buildProjectIndexIncremental(root, { ...options, report });
      // `bad.ts` comes from the cache the explicit-file build wrote, and `main.ts` is the only miss.
      expect(report.cache).toMatchObject({ hits: 1, misses: 1 });
    } finally {
      closeDiskCacheDatabase(root, options);
    }
  });
});
