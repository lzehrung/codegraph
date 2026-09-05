import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import * as gitModule from "../src/util/git.js";
import { isGitRepo } from "../src/util/git.js";
import { fileIdentityKey } from "../src/util/paths.js";
import * as projectFilesModule from "../src/util/projectFiles.js";
import {
  createProjectDiscoveryContext,
  listProjectFilesWithGitCandidates,
  readProjectDiscoveryFileText,
} from "../src/util/projectFiles.js";
import { computeConfigHash } from "../src/indexer/build-cache.js";
import { buildProjectIndex, buildProjectIndexIncremental } from "../src/indexer/build-index.js";
import type { BuildReport } from "../src/indexer/types.js";
import { runGit as git } from "./helpers/git.js";
import { createTempRootRegistry, isSymlinkUnavailable } from "./helpers/filesystem.js";

const temps = createTempRootRegistry();

afterAll(async () => {
  await temps.cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function normalize(value: string): string {
  return value.replace(/\\/g, "/");
}

async function createFile(filePath: string, contents: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, contents, "utf8");
}

async function makeRepo(prefix: string): Promise<string> {
  const root = await temps.create(prefix);
  git(root, ["init"]);
  git(root, ["config", "user.email", "tests@example.com"]);
  git(root, ["config", "user.name", "Tests"]);
  return root;
}

describe("ProjectDiscoveryContext factory", () => {
  it("allocates per-operation state without touching the filesystem or Git", async () => {
    const root = await makeRepo("cg-discovery-context-factory-");
    const readdirSpy = vi.spyOn(fsp, "readdir");
    const trackedSpy = vi.spyOn(gitModule, "listTrackedFiles");

    const context = createProjectDiscoveryContext(root);

    expect(readdirSpy).not.toHaveBeenCalled();
    expect(trackedSpy).not.toHaveBeenCalled();
    expect(await isGitRepo(root, context.git)).toBe(true);
  });
});

it("names the file when a discovery read rejects a non-Error value", async () => {
  const root = await temps.create("cg-discovery-read-error-");
  const file = path.join(root, "package.json");
  vi.spyOn(fsp, "readFile").mockRejectedValueOnce("unreadable");

  await expect(readProjectDiscoveryFileText(createProjectDiscoveryContext(root), file)).rejects.toThrow(file);
});

describe("computeConfigHash shared discovery", () => {
  it("does not recursively walk the project tree in an ordinary Git repository", async () => {
    const root = await makeRepo("cg-config-hash-no-walk-");
    await createFile(path.join(root, "a", "b", "c", "d", "e", "deep.ts"), "export const deep = 1;\n");
    await createFile(path.join(root, "package.json"), JSON.stringify({ name: "deep-app" }, null, 2));
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "seed"]);

    const readdirSpy = vi.spyOn(fsp, "readdir");
    const callbackReaddirSpy = vi.spyOn(fs, "readdir");
    const result = await computeConfigHash(root);

    expect(result.error).toBeUndefined();
    // Count both Node APIs so a direct fast-glob scan cannot bypass the guard.
    expect(readdirSpy.mock.calls.length + callbackReaddirSpy.mock.calls.length).toBe(1);
  });

  it("reuses one Git candidate listing across config hashing and source discovery in a shared context", async () => {
    const root = await makeRepo("cg-config-hash-shared-context-");
    await createFile(path.join(root, "src", "app.ts"), "export const app = 1;\n");
    await createFile(path.join(root, ".gitignore"), "generated/\n");
    await createFile(path.join(root, "generated", "drop.ts"), "export const drop = 1;\n");
    git(root, ["add", ".gitignore", "src/app.ts"]);
    git(root, ["commit", "-m", "seed"]);

    const trackedSpy = vi.spyOn(gitModule, "listTrackedFiles");
    const context = createProjectDiscoveryContext(root);
    const sharedHash = await computeConfigHash(root, undefined, context);
    const sharedFiles = await listProjectFilesWithGitCandidates(root, undefined, { discoveryContext: context });
    expect(trackedSpy).toHaveBeenCalledTimes(1);

    trackedSpy.mockClear();
    const standaloneHash = await computeConfigHash(root);
    const standaloneFiles = await listProjectFilesWithGitCandidates(root);
    expect(trackedSpy).toHaveBeenCalledTimes(2);

    // Sharing the enumeration must never change the observable result: same hash, same
    // discovered files, whether or not the Git listing was reused.
    expect(sharedHash.hash).toBe(standaloneHash.hash);
    expect(sharedFiles.map(normalize).sort()).toEqual(standaloneFiles.map(normalize).sort());
  });

  it("shares one in-flight Git candidate listing for concurrent consumers of the same context", async () => {
    const root = await makeRepo("cg-config-hash-concurrent-context-");
    await createFile(path.join(root, "src", "app.ts"), "export const app = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "seed"]);

    const trackedSpy = vi.spyOn(gitModule, "listTrackedFiles");
    const context = createProjectDiscoveryContext(root);
    const [hashResult, discovered] = await Promise.all([
      computeConfigHash(root, undefined, context),
      listProjectFilesWithGitCandidates(root, undefined, { discoveryContext: context }),
    ]);

    expect(hashResult.error).toBeUndefined();
    expect(discovered.map(normalize)).toContain(normalize(path.join(root, "src", "app.ts")));
    // Both consumers started before either finished enumerating; a sequential-only cache
    // (populated after the fact) would still leave this at two calls.
    expect(trackedSpy).toHaveBeenCalledTimes(1);
  });
});

describe("context freshness across operations", () => {
  it("computes a different hash for a fresh context after a root config file changes", async () => {
    const root = await makeRepo("cg-config-hash-freshness-");
    const packageJson = path.join(root, "package.json");
    await createFile(packageJson, JSON.stringify({ name: "before" }, null, 2));
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "seed"]);

    const contextA = createProjectDiscoveryContext(root);
    const before = await computeConfigHash(root, undefined, contextA);

    await createFile(packageJson, JSON.stringify({ name: "after" }, null, 2));

    const contextB = createProjectDiscoveryContext(root);
    const after = await computeConfigHash(root, undefined, contextB);

    // No hidden module-global memo may pin the first context's answer for later operations.
    expect(after.hash).not.toBe(before.hash);
  });

  it("lets a fresh context see a file added after an earlier context's discovery", async () => {
    const root = await makeRepo("cg-discovery-freshness-");
    await createFile(path.join(root, "src", "first.ts"), "export const first = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "seed"]);

    const contextA = createProjectDiscoveryContext(root);
    const beforeFiles = (await listProjectFilesWithGitCandidates(root, undefined, { discoveryContext: contextA })).map(
      normalize,
    );
    expect(beforeFiles).not.toContain(normalize(path.join(root, "src", "second.ts")));

    await createFile(path.join(root, "src", "second.ts"), "export const second = 1;\n");

    const contextB = createProjectDiscoveryContext(root);
    const afterFiles = (await listProjectFilesWithGitCandidates(root, undefined, { discoveryContext: contextB })).map(
      normalize,
    );
    expect(afterFiles).toContain(normalize(path.join(root, "src", "second.ts")));
  });
});

describe("shared fallback discovery", () => {
  it("shares directory reads without sharing filtered results between consumers", async () => {
    const root = await temps.create("cg-shared-fallback-");
    await createFile(path.join(root, "src", "app.ts"), "export const app = 1;\n");
    await createFile(path.join(root, "hidden", "other.ts"), "export const other = 2;\n");
    await createFile(path.join(root, ".gitignore"), "hidden/\n");
    await createFile(path.join(root, "package.json"), '{"name":"fallback-app"}\n');

    const context = createProjectDiscoveryContext(root);
    const readdirSpy = vi.spyOn(fsp, "readdir");
    const hash = await computeConfigHash(root, undefined, context);
    const selected = await listProjectFilesWithGitCandidates(root, ["**/*.ts"], {
      discoveryContext: context,
    });
    const includingIgnored = await listProjectFilesWithGitCandidates(root, ["**/*.ts"], {
      discoveryContext: context,
      useGitignore: false,
    });
    const metadata = await projectFilesModule.discoverProjectFilesWithGitCandidates(root, {
      discoveryContext: context,
    });

    expect(hash.error).toBeUndefined();
    expect(selected.map(normalize)).toEqual([normalize(path.join(root, "src", "app.ts"))]);
    expect(includingIgnored.map(normalize).sort()).toEqual(
      [path.join(root, "src", "app.ts"), path.join(root, "hidden", "other.ts")].map(normalize).sort(),
    );
    expect(metadata.some((entry) => entry.name === "fallback-app")).toBe(true);
    const listings = readdirSpy.mock.calls.map(([directory]) => normalize(String(directory)));
    expect(listings.length).toBe(new Set(listings).size);

    await createFile(path.join(root, "src", "new.ts"), "export const fresh = 3;\n");
    const fresh = await listProjectFilesWithGitCandidates(root, ["**/*.ts"], {
      discoveryContext: createProjectDiscoveryContext(root),
    });
    expect(fresh.map(normalize).sort()).toEqual(
      [path.join(root, "src", "app.ts"), path.join(root, "src", "new.ts")].map(normalize).sort(),
    );
  });
});

describe("config hash root-only manifest matching", () => {
  it("hashes a Git-ignored wildcard root manifest, but not a nested manifest", async () => {
    const root = await makeRepo("cg-config-hash-root-wildcard-");
    const rootCsproj = path.join(root, "App.csproj");
    const nestedPackageJson = path.join(root, "nested", "package.json");
    await createFile(path.join(root, ".gitignore"), "App.csproj\n");
    await createFile(
      rootCsproj,
      "<Project><PropertyGroup><AssemblyName>Before</AssemblyName></PropertyGroup></Project>",
    );
    await createFile(nestedPackageJson, JSON.stringify({ name: "before" }, null, 2));
    git(root, ["add", "-f", ".gitignore", "nested/package.json"]);
    git(root, ["commit", "-m", "seed"]);

    const before = await computeConfigHash(root);

    await createFile(
      rootCsproj,
      "<Project><PropertyGroup><AssemblyName>After</AssemblyName></PropertyGroup></Project>",
    );
    const afterRootEdit = await computeConfigHash(root);
    // The root wildcard manifest (`*.csproj`) is a real config-hash input even though Git
    // ignores it entirely: it never reaches Git's tracked/untracked listing.
    expect(afterRootEdit.hash).not.toBe(before.hash);

    await createFile(nestedPackageJson, JSON.stringify({ name: "after" }, null, 2));
    const afterNestedEdit = await computeConfigHash(root);
    // DEFAULT_PROJECT_MANIFESTS match only the project root; a same-named manifest nested
    // in a subdirectory is a source/metadata concern, not a config-hash input.
    expect(afterNestedEdit.hash).toBe(afterRootEdit.hash);
  });

  it("ignores directory and broken symlinks that match root config names", async (context) => {
    const root = await temps.create("cg-config-hash-non-file-link-");
    const target = path.join(root, "target");
    await fsp.mkdir(target);
    const before = await computeConfigHash(root);
    try {
      await fsp.symlink(target, path.join(root, "App.csproj"), "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return context.skip();
      throw error;
    }

    const directoryLink = await computeConfigHash(root);
    expect(directoryLink).toEqual(before);

    await fsp.rmdir(target);
    const brokenLink = await computeConfigHash(root);
    expect(brokenLink).toEqual(before);
  });
});

describe("index build discovery context reuse", () => {
  it("reuses one Git candidate listing across hashing, source, and metadata discovery for a full build", async () => {
    const root = await makeRepo("cg-build-index-context-reuse-");
    await createFile(path.join(root, "src", "app.ts"), "export const app = 1;\n");
    await createFile(path.join(root, "package.json"), JSON.stringify({ name: "context-reuse-app" }, null, 2));
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "seed"]);

    const trackedSpy = vi.spyOn(gitModule, "listTrackedFiles");
    const index = await buildProjectIndex(root, { cache: "disk", native: "off" });

    expect(index.byFile.has(fileIdentityKey(normalize(path.join(root, "src", "app.ts"))))).toBe(true);
    expect(trackedSpy).toHaveBeenCalledTimes(1);
  });

  it("reads changed files and ignore rules on the next top-level build", async () => {
    const root = await makeRepo("cg-build-index-context-fresh-");
    const first = path.join(root, "first.ts");
    const second = path.join(root, "second.ts");
    await createFile(first, "export const first = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "seed"]);

    const initial = await buildProjectIndex(root, { cache: "disk", native: "off" });
    expect(initial.byFile.has(fileIdentityKey(normalize(first)))).toBe(true);

    await createFile(second, "export const second = 2;\n");
    await createFile(path.join(root, ".gitignore"), "first.ts\n");
    const updated = await buildProjectIndex(root, { cache: "disk", native: "off" });
    expect(updated.byFile.has(fileIdentityKey(normalize(first)))).toBe(false);
    expect(updated.byFile.has(fileIdentityKey(normalize(second)))).toBe(true);
  });
});

describe("scoped builds do not introduce source enumeration", () => {
  it("does not enumerate project source files for a declared non-empty project scope", async () => {
    const root = await makeRepo("cg-explicit-files-no-source-enum-");
    const file = path.join(root, "src", "app.ts");
    await createFile(file, "export const app = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "seed"]);
    await buildProjectIndexIncremental(root, { cache: "disk", native: "off" });

    const listSpy = vi.spyOn(projectFilesModule, "listProjectFilesWithGitCandidates");
    const report: BuildReport = { timings: {} };
    const scoped = await buildProjectIndexIncremental(root, {
      cache: "disk",
      native: "off",
      files: [file],
      filesAreProjectScope: true,
      report,
    });

    expect([...scoped.byFile.keys()]).toEqual([fileIdentityKey(normalize(file))]);
    expect(listSpy).not.toHaveBeenCalled();
    // Config hashing still runs and still shares the same discovery context; it is the
    // source-listing step this scope declaration must skip, not hashing itself.
    expect(report.timings?.steps?.some((step) => step.name === "config-hash")).toBe(true);
  });

  it("does not enumerate project source files for an empty declared project scope", async () => {
    const root = await makeRepo("cg-declared-empty-scope-no-source-enum-");
    await createFile(path.join(root, "src", "app.ts"), "export const app = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "seed"]);
    await buildProjectIndexIncremental(root, { cache: "disk", native: "off" });

    const listSpy = vi.spyOn(projectFilesModule, "listProjectFilesWithGitCandidates");
    const scoped = await buildProjectIndexIncremental(root, {
      cache: "disk",
      native: "off",
      files: [],
      filesAreProjectScope: true,
    });

    expect(scoped.byFile.size).toBe(0);
    expect(listSpy).not.toHaveBeenCalled();
  });
});
