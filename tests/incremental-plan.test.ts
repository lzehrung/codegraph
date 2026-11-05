import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canUseIncrementalDiscoveryFastPath,
  addedResolutionStems,
  collectDeletedTrackedFileDependents,
  collectTrackedFileDependents,
  externalSpecifierMatchesAddedStem,
  tsconfigAliasMappedTails,
  listUntrackedProjectFiles,
  resolveIncrementalFileList,
} from "../src/indexer/incremental-plan.js";
import type { ManifestFileEntry } from "../src/indexer/build-cache.js";
import { buildProjectIndex, buildProjectIndexIncremental, buildGraphDelta } from "../src/indexer/build-index.js";
import type { BuildOptions, BuildReport } from "../src/indexer/types.js";
import type { Edge } from "../src/types.js";
import * as projectFilesModule from "../src/util/project-files.js";
import { isSymlinkUnavailable, mkTmpDir } from "./helpers/filesystem.js";
import { runGit as git } from "./helpers/git.js";

function fileEdge(from: string, to: string): Edge {
  return { from, to: { type: "file", path: to }, raw: `./${to}` };
}

function entry(edges: Edge[]): ManifestFileEntry {
  return { sig: "sig", edges };
}

function manifestPathFor(root: string): string {
  return path.join(root, ".codegraph", "cache", "index-v1", "manifest.json");
}

describe("incremental-plan dependents", () => {
  it("collects transitive dependents of changed files", () => {
    const trackedEntries: Record<string, ManifestFileEntry> = {
      "/proj/a.ts": entry([fileEdge("/proj/a.ts", "/proj/b.ts")]),
      "/proj/b.ts": entry([fileEdge("/proj/b.ts", "/proj/c.ts")]),
      "/proj/c.ts": entry([]),
    };

    const changed = new Set(["/proj/c.ts"]);
    expect(collectTrackedFileDependents(trackedEntries, changed)).toEqual(new Set(["/proj/b.ts", "/proj/a.ts"]));
  });

  it("still collects dependents of deleted tracked files", () => {
    const trackedEntries: Record<string, ManifestFileEntry> = {
      "/proj/a.ts": entry([fileEdge("/proj/a.ts", "/proj/b.ts")]),
      "/proj/b.ts": entry([]),
    };
    const deleted = new Set(["/proj/b.ts"]);
    expect(collectDeletedTrackedFileDependents(trackedEntries, deleted)).toEqual(new Set(["/proj/a.ts"]));
  });
});

describe("canUseIncrementalDiscoveryFastPath", () => {
  it("requires a Git repo and no --cache-strict", () => {
    expect(canUseIncrementalDiscoveryFastPath(true, undefined)).toBe(true);
    expect(canUseIncrementalDiscoveryFastPath(false, undefined)).toBe(false);
    expect(canUseIncrementalDiscoveryFastPath(true, true)).toBe(false);
  });
});

describe("listUntrackedProjectFiles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds new files matching project discovery patterns and excludes tracked or non-project files", async () => {
    const root = await mkTmpDir("codegraph-untracked-project-files-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "tracked.ts"), "export const tracked = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      await fs.writeFile(path.join(root, "fresh.ts"), "export const fresh = 1;\n", "utf8");
      await fs.writeFile(path.join(root, "notes.txt"), "not a project file pattern\n", "utf8");

      const files = await listUntrackedProjectFiles(root, undefined, true);
      const normalized = files.map((file) => file.replace(/\\/g, "/"));
      expect(normalized).toContain(`${root.replace(/\\/g, "/")}/fresh.ts`);
      expect(normalized.some((file) => file.endsWith("/notes.txt"))).toBe(false);
      expect(normalized.some((file) => file.endsWith("/tracked.ts"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns an empty list when Git is unavailable", async () => {
    const root = await mkTmpDir("codegraph-untracked-project-files-disabled-");
    try {
      expect(await listUntrackedProjectFiles(root, undefined, false)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("includes gitignored untracked files when useGitignore is false, instead of giving up", async () => {
    const root = await mkTmpDir("codegraph-untracked-project-files-no-gitignore-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, ".gitignore"), "ignored.ts\n", "utf8");
      await fs.writeFile(path.join(root, "tracked.ts"), "export const tracked = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      await fs.writeFile(path.join(root, "ignored.ts"), "export const ignored = 1;\n", "utf8");

      const respectingGitignore = await listUntrackedProjectFiles(root, undefined, true);
      expect(respectingGitignore.some((file) => file.endsWith("/ignored.ts"))).toBe(false);

      const includingGitignored = await listUntrackedProjectFiles(root, { useGitignore: false }, true);
      const normalized = includingGitignored.map((file) => file.replace(/\\/g, "/"));
      expect(normalized.some((file) => file.endsWith("/ignored.ts"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("excludes untracked symlinks whose realpath escapes the project root", async () => {
    const root = await mkTmpDir("codegraph-untracked-project-files-symlink-root-");
    const outside = await mkTmpDir("codegraph-untracked-project-files-symlink-outside-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "tracked.ts"), "export const tracked = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      const outsideFile = path.join(outside, "secret.ts");
      const linkedFile = path.join(root, "linked-secret.ts");
      await fs.writeFile(outsideFile, "export const secret = 1;\n", "utf8");
      try {
        await fs.symlink(outsideFile, linkedFile, "file");
      } catch (error) {
        if (isSymlinkUnavailable(error)) return;
        throw error;
      }

      const files = await listUntrackedProjectFiles(root, undefined, true);
      const normalized = files.map((file) => file.replace(/\\/g, "/"));
      expect(normalized.some((file) => file.endsWith("/linked-secret.ts"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("resolveIncrementalFileList", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when no manifest exists yet", async () => {
    const root = await mkTmpDir("codegraph-resolve-incremental-no-manifest-");
    try {
      await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
      expect(await resolveIncrementalFileList(root, { cache: "disk" })).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns null for older manifests that do not record build options", async () => {
    const root = await mkTmpDir("codegraph-resolve-incremental-missing-build-options-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      await buildProjectIndex(root, { cache: "disk" });

      const manifestPath = manifestPathFor(root);
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { buildOptions?: unknown };
      delete manifest.buildOptions;
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

      expect(await resolveIncrementalFileList(root, { cache: "disk" })).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns null for non-Git projects even with a manifest present", async () => {
    const root = await mkTmpDir("codegraph-resolve-incremental-non-git-");
    try {
      await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
      await buildProjectIndex(root, { cache: "disk" });
      expect(await resolveIncrementalFileList(root, { cache: "disk" })).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns null when --cache-strict is requested", async () => {
    const root = await mkTmpDir("codegraph-resolve-cache-strict-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      await buildProjectIndex(root, { cache: "disk" });

      expect(await resolveIncrementalFileList(root, { cache: "disk", cacheStrict: true })).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns null when discovery options changed since the manifest was written", async () => {
    const root = await mkTmpDir("codegraph-resolve-incremental-discovery-change-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      await buildProjectIndex(root, { cache: "disk" });

      const changedDiscovery = { cache: "disk" as const, discovery: { ignoreGlobs: ["**/*.spec.ts"] } };
      expect(await resolveIncrementalFileList(root, changedDiscovery)).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves tracked and newly created untracked files without a full recursive scan", async () => {
    const root = await mkTmpDir("codegraph-resolve-incremental-fast-path-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "tracked.ts"), "export const tracked = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      await buildProjectIndex(root, { cache: "disk" });

      await fs.writeFile(path.join(root, "fresh.ts"), "export const fresh = 1;\n", "utf8");
      const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");

      const files = await resolveIncrementalFileList(root, { cache: "disk" });

      expect(files).not.toBeNull();
      const normalized = (files ?? []).map((file) => file.replace(/\\/g, "/"));
      expect(normalized.some((file) => file.endsWith("/tracked.ts"))).toBe(true);
      expect(normalized.some((file) => file.endsWith("/fresh.ts"))).toBe(true);
      expect(scanSpy).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves modified and deleted tracked files after a new commit without a full recursive scan", async () => {
    const root = await mkTmpDir("codegraph-resolve-incremental-commit-diff-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "kept.ts"), "export const kept = 1;\n", "utf8");
      await fs.writeFile(path.join(root, "removed.ts"), "export const removed = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      await buildProjectIndex(root, { cache: "disk" });

      await fs.writeFile(path.join(root, "kept.ts"), "export const kept = 2;\n", "utf8");
      await fs.rm(path.join(root, "removed.ts"));
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "head"]);

      const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");
      const files = await resolveIncrementalFileList(root, { cache: "disk" });

      expect(files).not.toBeNull();
      const normalized = (files ?? []).map((file) => file.replace(/\\/g, "/"));
      expect(normalized.some((file) => file.endsWith("/kept.ts"))).toBe(true);
      expect(normalized.some((file) => file.endsWith("/removed.ts"))).toBe(false);
      expect(scanSpy).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a newly staged (git add, not committed) file without a full recursive scan", async () => {
    const root = await mkTmpDir("codegraph-resolve-incremental-staged-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      await fs.writeFile(path.join(root, "tracked.ts"), "export const tracked = 1;\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      await buildProjectIndex(root, { cache: "disk" });

      // A staged-but-uncommitted file is neither a tracked manifest entry nor reported by
      // `git ls-files --others` (staging removes it from "untracked"), so only a diff
      // against the working tree (not just the commit) can find it while HEAD is unmoved.
      const stagedPath = path.join(root, "staged.ts");
      await fs.writeFile(stagedPath, "export const staged = 1;\n", "utf8");
      git(root, ["add", "staged.ts"]);

      const scanSpy = vi.spyOn(projectFilesModule, "listProjectFiles");
      const files = await resolveIncrementalFileList(root, { cache: "disk" });

      expect(files).not.toBeNull();
      const normalized = (files ?? []).map((file) => file.replace(/\\/g, "/"));
      expect(normalized.some((file) => file.endsWith("/tracked.ts"))).toBe(true);
      expect(normalized.some((file) => file.endsWith("/staged.ts"))).toBe(true);
      expect(scanSpy).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("added-file specifier stems", () => {
  it("matches a python module, a C include, an alias tail, and an entry-file directory", () => {
    const stems = addedResolutionStems([
      "/proj/app/util.py",
      "/proj/lib.h",
      "/proj/lib/target.ts",
      "/proj/pkg/__init__.py",
      "/proj/widget/index.ts",
    ]);
    expect(stems.has("util")).toBe(true);
    expect(stems.has("lib")).toBe(true);
    expect(stems.has("target")).toBe(true);
    expect(stems.has("pkg")).toBe(true);
    expect(stems.has("__init__")).toBe(true);
    expect(stems.has("index")).toBe(true);
    expect(stems.has("widget")).toBe(true);
    expect(externalSpecifierMatchesAddedStem("app.util", "python", stems)).toBe(true);
    expect(externalSpecifierMatchesAddedStem("lib.h", "c", stems)).toBe(true);
    expect(externalSpecifierMatchesAddedStem("@alias/target", "ts", stems)).toBe(true);
    expect(externalSpecifierMatchesAddedStem("pkg", "python", stems)).toBe(true);
    expect(externalSpecifierMatchesAddedStem("./widget", "ts", stems)).toBe(true);
    expect(externalSpecifierMatchesAddedStem("./other", "ts", stems)).toBe(false);
    const mapped = tsconfigAliasMappedTails("@exact", { "@exact": ["./lib/target.ts"] });
    expect(mapped).toEqual(["./lib/target.ts"]);
    expect(externalSpecifierMatchesAddedStem("@exact", "ts", stems, mapped)).toBe(true);
    // A fallback target counts: only the second target matches the added file.
    const fallback = tsconfigAliasMappedTails("@lib/target", { "@lib/*": ["missing/miss-*", "lib/*"] });
    expect(fallback).toEqual(["missing/miss-target", "lib/target"]);
    expect(externalSpecifierMatchesAddedStem("@lib/target", "ts", stems, fallback)).toBe(true);
    expect(
      externalSpecifierMatchesAddedStem(
        "@lib/other",
        "ts",
        stems,
        tsconfigAliasMappedTails("@lib/other", { "@lib/*": ["missing/miss-*", "lib/*"] }),
      ),
    ).toBe(false);
  });

  it("matches a declaration file by its source stem and an index declaration by its directory", () => {
    const stems = addedResolutionStems(["/proj/types/foo.d.ts", "/proj/api/index.d.mts"]);
    expect(externalSpecifierMatchesAddedStem("./types/foo", "ts", stems)).toBe(true);
    expect(externalSpecifierMatchesAddedStem("./api", "ts", stems)).toBe(true);
    expect(externalSpecifierMatchesAddedStem("./types/bar", "ts", stems)).toBe(false);
  });

  it("uses language-specific import segments, directory imports, and C# namespace imports", () => {
    const javaStems = addedResolutionStems(["/proj/p/Item.java"], "java");
    const kotlinStems = addedResolutionStems(["/proj/p/Item.kt"], "kotlin");
    const rustStems = addedResolutionStems(["/proj/foo.rs"], "rust");
    const goStems = addedResolutionStems(["/proj/thing/widget.go"], "go");
    const csharpFiles = ["/proj/p/Thing.cs"];
    const csharpStems = addedResolutionStems(csharpFiles, "csharp");

    expect(externalSpecifierMatchesAddedStem("p.Item", "java", javaStems)).toBe(true);
    expect(externalSpecifierMatchesAddedStem("p.Item", "kotlin", kotlinStems)).toBe(true);
    expect(externalSpecifierMatchesAddedStem("crate::foo", "rust", rustStems)).toBe(true);
    expect(externalSpecifierMatchesAddedStem("crate::foo::Thing", "rust", rustStems)).toBe(true);
    expect(goStems.has("thing")).toBe(true);
    expect(externalSpecifierMatchesAddedStem("example.com/probe/thing", "go", goStems)).toBe(true);
    expect(externalSpecifierMatchesAddedStem("example.com/probe/other", "go", goStems)).toBe(false);
    expect(externalSpecifierMatchesAddedStem("P", "csharp", csharpStems, [], csharpFiles)).toBe(true);
    expect(externalSpecifierMatchesAddedStem("P", "csharp", csharpStems, [], ["/proj/p/Thing.ts"])).toBe(false);
  });

  it("re-resolves declaration imports for added files under a configured language extension", () => {
    // `Helpers.jvm` is mapped to Kotlin, so the stem `Helpers` never matches `p.Widget`.
    // Only the file's language triggers re-resolution.
    const files = ["/proj/p/Helpers.jvm"];
    const stems = addedResolutionStems(files, "kotlin");
    const kotlin = (file: string): string | undefined => (file.endsWith(".jvm") ? "kotlin" : undefined);
    expect(externalSpecifierMatchesAddedStem("p.Widget", "kotlin", stems, [], files, kotlin)).toBe(true);
    // Another language's importer is unaffected by the Kotlin file.
    expect(externalSpecifierMatchesAddedStem("p.Widget", "java", stems, [], files, kotlin)).toBe(false);
    // Without the language mapping the unknown suffix matches nothing.
    expect(externalSpecifierMatchesAddedStem("p.Widget", "kotlin", stems, [], files)).toBe(false);
    expect(externalSpecifierMatchesAddedStem("p.Widget", "kotlin", stems, [], files, () => undefined)).toBe(false);
  });

  it("treats an SCSS directory index partial as the directory it loads", () => {
    const partial = addedResolutionStems(["/proj/lib/_index.scss"], "scss");
    expect(partial.has("_index")).toBe(true);
    expect(partial.has("lib")).toBe(true);
    expect(externalSpecifierMatchesAddedStem("lib", "scss", partial)).toBe(true);
    expect(externalSpecifierMatchesAddedStem("./lib", "scss", partial)).toBe(true);
    const index = addedResolutionStems(["/proj/lib/index.scss"], "scss");
    expect(externalSpecifierMatchesAddedStem("lib", "scss", index)).toBe(true);
    expect(externalSpecifierMatchesAddedStem("./lib", "scss", index)).toBe(true);
    // A non-SCSS importer does not treat `_index.scss` as that directory's entry file.
    const typescript = addedResolutionStems(["/proj/lib/_index.scss"], "ts");
    expect(externalSpecifierMatchesAddedStem("lib", "ts", typescript)).toBe(false);
    expect(externalSpecifierMatchesAddedStem("_index", "ts", typescript)).toBe(true);
  });
});

describe("incremental discovery parity", () => {
  it.each([
    {
      name: "configured ignore",
      file: "samples/changed.ts",
      discovery: { ignoreGlobs: ["samples/**"] },
      included: false,
    },
    { name: "default ignore", file: "dist/changed.ts", discovery: undefined, included: false },
    {
      name: "explicit include of output",
      file: "dist/changed.ts",
      discovery: { includeGlobs: ["**/*.ts"] },
      included: true,
    },
    { name: "custom extension", file: "src/changed.custom", discovery: undefined, included: true },
  ])("keeps $name consistent across Git reconciliation, delta, and rebuild", async ({ file, discovery, included }) => {
    const root = await mkTmpDir("cg-incremental-discovery-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      const dependency = path.join(root, "src", "dependency.ts");
      const changed = path.join(root, file);
      await fs.mkdir(path.dirname(dependency), { recursive: true });
      await fs.mkdir(path.dirname(changed), { recursive: true });
      await fs.writeFile(dependency, "export const dependency = 1;\n");
      await fs.writeFile(changed, "export const value = 1;\n");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      const options: BuildOptions = {
        cache: "disk",
        threads: 1,
        logLevel: "silent",
        ...(discovery ? { discovery } : {}),
        languageExtensions: { ".custom": "ts" },
      };
      await buildProjectIndex(root, options);
      await fs.writeFile(changed, 'import "../src/dependency";\nexport const value = 2;\n');
      const staged = path.join(root, "src", "staged.ts");
      await fs.writeFile(staged, "export const staged = 1;\n");
      git(root, ["add", "src/staged.ts"]);
      const expected = ["src/dependency.ts", "src/staged.ts", ...(included ? [file] : [])].sort();
      const relativeFiles = (files: Iterable<string>): string[] =>
        Array.from(files, (entry) => path.relative(root, entry).replace(/\\/g, "/")).sort();
      expect(relativeFiles((await resolveIncrementalFileList(root, options)) ?? [])).toEqual(expected);

      const delta = await buildGraphDelta(root, { ...options, gitBase: "HEAD", gitHead: "WORKTREE" });
      expect(delta.changedFiles).toEqual(["src/staged.ts", ...(included ? [file] : [])].sort());
      expect(delta.added).toEqual(
        included ? [{ from: file, to: { type: "file", path: "src/dependency.ts" }, raw: "../src/dependency" }] : [],
      );
      const report: BuildReport = { timings: {} };
      const incremental = await buildProjectIndexIncremental(root, { ...options, report });
      const cold = await buildProjectIndex(root, { ...options, cache: "off" });
      expect(relativeFiles(incremental.byFile.keys())).toEqual(expected);
      expect(relativeFiles(incremental.graph.nodes)).toEqual(relativeFiles(cold.graph.nodes));
      expect(incremental.graph.edges).toEqual(cold.graph.edges);
      expect(report.files?.total).toBe(expected.length);
      const manifest = JSON.parse(await fs.readFile(manifestPathFor(root), "utf8")) as {
        files: Record<string, ManifestFileEntry>;
      };
      expect(Object.keys(manifest.files).sort()).toEqual(expected);
      const repeated = await buildProjectIndexIncremental(root, options);
      expect(relativeFiles(repeated.byFile.keys())).toEqual(expected);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps explicit files but rebuilds an older contaminated discovery manifest", async () => {
    const root = await mkTmpDir("cg-incremental-discovery-upgrade-");
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "tests@example.com"]);
      git(root, ["config", "user.name", "Tests"]);
      const source = path.join(root, "source.ts");
      const ignored = path.join(root, "ignored.ts");
      await fs.writeFile(source, "export const source = 1;\n");
      await fs.writeFile(ignored, "export const ignored = 1;\n");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);
      const options: BuildOptions = {
        cache: "disk",
        threads: 1,
        logLevel: "silent",
        discovery: { ignoreGlobs: ["ignored.ts"] },
      };
      await buildProjectIndex(root, options);
      const explicit = await buildProjectIndexIncremental(root, { ...options, files: [ignored] });
      expect(explicit.byFile.size).toBe(2);
      await fs.writeFile(ignored, "export const ignored = 2;\n");
      const updated = await buildProjectIndexIncremental(root, options);
      expect(updated.byFile.size).toBe(2);
      const manifestPath = manifestPathFor(root);
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
        buildOptions: { coreAlgorithmEpoch: number };
      };
      manifest.buildOptions.coreAlgorithmEpoch -= 1;
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
      expect(await resolveIncrementalFileList(root, options)).toBeNull();
      const repaired = await buildProjectIndexIncremental(root, options);
      expect(Array.from(repaired.byFile.keys(), (file) => path.basename(file))).toEqual(["source.ts"]);
      const repairedManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
        files: Record<string, ManifestFileEntry>;
      };
      expect(Object.keys(repairedManifest.files)).toEqual(["source.ts"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
