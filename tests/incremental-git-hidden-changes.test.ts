import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
} from "../src/index.js";
import { createAgentSession } from "../src/agent/session.js";
import { clearMemoryCache, closeDiskCacheDatabase, type ManifestFileEntry } from "../src/indexer/build-cache.js";
import { findRespelledTrackedFiles } from "../src/indexer/incremental-plan.js";
import type { ProjectIndex } from "../src/indexer/types.js";
import {
  createGitDiscoveryCache,
  listChangedFileEntries,
  listUntrackedAndFlaggedFiles,
  setGitExecutableForTests,
} from "../src/util/git.js";
import { fileIdentityKey, normalizePath, resetFileIdentityCaseSensitivityForTests } from "../src/util/paths.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";
import { runGit } from "./helpers/git.js";

const roots = createTempRootRegistry();

afterEach(async () => {
  setGitExecutableForTests(null);
  resetFileIdentityCaseSensitivityForTests();
  clearMemoryCache();
  delete process.env.CODEGRAPH_GIT_CALLS_LOG;
  await roots.cleanup();
});

type StoredManifest = { gitDirtySubmodules?: string[] };

async function readStoredManifest(root: string): Promise<StoredManifest> {
  const text = await fsp.readFile(path.join(root, ".codegraph", "cache", "index-v1", "manifest.json"), "utf8");
  const stored = JSON.parse(text) as StoredManifest;
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
    expect(relative(listing.flagged)).toEqual(["src/both.ts", "src/nested/left.ts", "src/nested/right.ts"]);
    expect(listing.trackedPaths?.().has(normalizePath(path.join(root, "src/main.ts")))).toBe(true);
    expect(listing.trackedPaths?.().has(normalizePath(path.join(root, "fresh.ts")))).toBe(false);
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
  async function fileSystemIgnoresCase(): Promise<boolean> {
    const probe = await roots.create("cg-case-probe-");
    await fsp.writeFile(path.join(probe, "Probe.txt"), "x");
    return await fsp.access(path.join(probe, "probe.txt")).then(
      () => true,
      () => false,
    );
  }

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

  it("retires a manifest spelling that Git no longer lists and drops candidates it does not list", () => {
    resetFileIdentityCaseSensitivityForTests(true);
    const entry = { sig: "1:1", edges: [] } satisfies ManifestFileEntry;
    const entries = { "/p/src/Foo.ts": entry, "/p/src/keep.ts": entry };
    const listed = new Set(["/p/src/foo.ts", "/p/src/keep.ts"]);
    const current = (file: string): boolean => listed.has(file);
    expect(findRespelledTrackedFiles(entries, ["/p/src/Foo.ts", "/p/src/foo.ts"], current)).toEqual({
      retiredTrackedFiles: ["/p/src/Foo.ts"],
      droppedSpellings: new Set(["/p/src/Foo.ts"]),
    });
    // A candidate that Git does not spell is dropped when the manifest already holds the listed spelling.
    const respelled = { "/p/src/foo.ts": entry };
    expect(findRespelledTrackedFiles(respelled, ["/p/src/Foo.ts"], current)).toEqual({
      retiredTrackedFiles: [],
      droppedSpellings: new Set(["/p/src/Foo.ts"]),
    });
    // Unrelated candidates and an unknown listing change nothing.
    expect(findRespelledTrackedFiles(entries, ["/p/src/other.ts"], current).retiredTrackedFiles).toEqual([]);
    expect(findRespelledTrackedFiles(entries, ["/p/src/foo.ts"], () => false).retiredTrackedFiles).toEqual([]);
    resetFileIdentityCaseSensitivityForTests(false);
    expect(findRespelledTrackedFiles(entries, ["/p/src/foo.ts"], current).retiredTrackedFiles).toEqual([]);
  });
});

describe("Git children spawned by incremental updates", () => {
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
  const readCalls = async (log: string): Promise<string[][]> => {
    const text = await fsp.readFile(log, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  };

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
});
