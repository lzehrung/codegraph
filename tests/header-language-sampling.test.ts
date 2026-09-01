import fs from "node:fs";
import fsp from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildProjectIndex } from "../src/index.js";
import { prepareQueryIndexFile, MAX_QUERY_INDEX_TEXT_BYTES } from "../src/agent/query-index/content.js";
import { buildDuplicateUnitsForFile } from "../src/duplicates/units.js";
import { buildBloomFilterForFile } from "../src/indexer/build-cache/module-cache.js";
import { countNativeWorkerEligibleFiles } from "../src/indexer/build-workers.js";
import type { ProjectIndex } from "../src/indexer/types.js";
import type { FileChange } from "../src/impact/types.js";
import { supportForFile, supportForFileWithSource, supportForFileWithoutHeaderSample } from "../src/languages.js";
import { buildDeletedFileSnapshots } from "../src/review/deleted.js";
import { normalizePath } from "../src/util/paths.js";
import { createTempProjectRoot } from "./helpers/filesystem.js";

const CPP_HEADER = "namespace widgets {\nclass Widget {\npublic:\n  int value;\n};\n}\n";
const C_HEADER = "struct Plain { int value; };\n";
const SQL_SOURCE = "CREATE TABLE widgets (id INTEGER);\n";

type SampledResult<T> = {
  value: T;
  /** Synchronous `.h` reads observed while the action ran. */
  reads: number;
};

const tempRoots: string[] = [];

async function makeHeaderProject(prefix: string, headerCount: number): Promise<string> {
  const files = Array.from({ length: headerCount }, (_, index) => ({
    path: `widget${index}.h`,
    contents: CPP_HEADER,
  }));
  files.push({ path: "main.cpp", contents: '#include "widget0.h"\nint main() { return 0; }\n' });
  files.push({ path: "schema.sql", contents: SQL_SOURCE });
  const root = await createTempProjectRoot(prefix, files);
  tempRoots.push(root);
  return root;
}

/**
 * Runs `action` while counting the synchronous `.h` reads header classification performs.
 * `readFileSample` is the only code that reads a header synchronously, so this isolates the
 * sampling cost from the asynchronous source reads the parser does.
 */
async function withHeaderSampleReads<T>(action: () => Promise<T> | T): Promise<SampledResult<T>> {
  const readFileSync = vi.spyOn(fs, "readFileSync");
  try {
    const value = await action();
    const reads = readFileSync.mock.calls.filter(
      ([target]) => typeof target === "string" && target.endsWith(".h"),
    ).length;
    return { value, reads };
  } finally {
    readFileSync.mockRestore();
  }
}

function exportedNames(index: ProjectIndex, suffix: string): string[] {
  for (const [file, module] of index.byFile) {
    if (!file.endsWith(suffix)) continue;
    return module.exports.map((entry) => (entry.type === "local" ? entry.exportedAs : entry.type)).sort();
  }
  throw new Error(`No indexed module ended with ${suffix}`);
}

function moduleFileEndingWith(index: ProjectIndex, suffix: string): string {
  for (const module of index.byFile.values()) {
    if (module.file.endsWith(suffix)) return module.file;
  }
  throw new Error(`No indexed module ended with ${suffix}`);
}

/** A single-hunk deletion whose old side is exactly `contents`. */
function deletionChange(file: string, contents: string): FileChange {
  const lines = contents.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return {
    path: file,
    kind: "deleted",
    hunks: [{ oldStart: 1, newStart: 0, lines: lines.map((line) => `-${line}`) }],
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("header language classification", () => {
  it("separates C from C++ only when sampling is allowed", async () => {
    const root = await createTempProjectRoot("cg-header-sampling-unit-", [
      { path: "widget.h", contents: CPP_HEADER },
      { path: "plain.h", contents: C_HEADER },
    ]);
    tempRoots.push(root);
    const cppHeader = `${root}/widget.h`;
    const cHeader = `${root}/plain.h`;

    const sampled = await withHeaderSampleReads(() => [supportForFile(cppHeader)?.id, supportForFile(cHeader)?.id]);
    expect(sampled.value).toEqual(["cpp", "c"]);
    expect(sampled.reads).toBe(2);

    const unsampled = await withHeaderSampleReads(() => [
      supportForFileWithoutHeaderSample(cppHeader)?.id,
      supportForFileWithoutHeaderSample(cHeader)?.id,
    ]);
    expect(unsampled.value).toEqual(["c", "c"]);
    expect(unsampled.reads).toBe(0);
  });

  it("resolves a mapped extension before any classification read", async () => {
    const root = await createTempProjectRoot("cg-header-sampling-mapped-", [
      { path: "widget.h", contents: CPP_HEADER },
      { path: "legacy.inc", contents: C_HEADER },
    ]);
    tempRoots.push(root);
    const header = `${root}/widget.h`;
    const custom = `${root}/legacy.inc`;

    const mapped = await withHeaderSampleReads(() => [
      supportForFile(header, { ".h": "c" })?.id,
      supportForFileWithoutHeaderSample(header, { ".h": "c" })?.id,
      supportForFile(custom, { ".inc": "cpp" })?.id,
      supportForFileWithoutHeaderSample(custom, { ".inc": "cpp" })?.id,
    ]);
    expect(mapped.value).toEqual(["c", "c", "cpp", "cpp"]);
    expect(mapped.reads).toBe(0);

    // A mapping for a different extension leaves header classification to the sample.
    expect(supportForFile(header, { ".hpp": "c" })?.id).toBe("cpp");
  });

  it("classifies a header from source the caller already holds", async () => {
    const root = await createTempProjectRoot("cg-header-sampling-source-", [
      { path: "widget.h", contents: CPP_HEADER },
      { path: "plain.h", contents: C_HEADER },
    ]);
    tempRoots.push(root);
    const cppHeader = `${root}/widget.h`;
    const cHeader = `${root}/plain.h`;

    const classified = await withHeaderSampleReads(() => [
      supportForFileWithSource(cppHeader, CPP_HEADER)?.id,
      supportForFileWithSource(cHeader, C_HEADER)?.id,
      // Mapping precedence is the same as `supportForFile`: the mapping wins over the source.
      supportForFileWithSource(cppHeader, CPP_HEADER, { ".h": "c" })?.id,
      supportForFileWithSource(`${root}/legacy.inc`, C_HEADER, { ".inc": "cpp" })?.id,
      // A non-header extension is decided by the extension alone, whatever the source looks like.
      supportForFileWithSource(`${root}/widget.cpp`, C_HEADER)?.id,
    ]);

    expect(classified.value).toEqual(["cpp", "c", "c", "cpp", "cpp"]);
    expect(classified.reads).toBe(0);
  });

  it("keeps a C++ header exact when the path is missing from the worktree", async () => {
    const root = await createTempProjectRoot("cg-header-sampling-missing-");
    tempRoots.push(root);
    const missingHeader = `${root}/widget.h`;

    // A sample read of a path that does not exist sees nothing and falls back to C.
    expect(supportForFile(missingHeader)?.id).toBe("c");
    expect(supportForFileWithSource(missingHeader, CPP_HEADER)?.id).toBe("cpp");
  });

  it("decides a header from the same leading bytes a sample read would take", async () => {
    const padded = `${"// filler\n".repeat(1200)}${CPP_HEADER}`;
    const root = await createTempProjectRoot("cg-header-sampling-window-", [{ path: "padded.h", contents: padded }]);
    tempRoots.push(root);
    const header = `${root}/padded.h`;

    // The only C++ hint sits past the sample window, so both resolvers still answer C.
    expect(padded.indexOf("namespace")).toBeGreaterThan(8000);
    expect(supportForFile(header)?.id).toBe("c");
    expect(supportForFileWithSource(header, padded)?.id).toBe("c");
  });

  it("counts headers as native worker eligible without reading them", async () => {
    const root = await createTempProjectRoot("cg-header-sampling-eligible-", [
      { path: "widget.h", contents: CPP_HEADER },
      { path: "plain.h", contents: C_HEADER },
      { path: "schema.sql", contents: SQL_SOURCE },
      { path: "notes.md", contents: "# notes\n" },
      { path: "data.json", contents: "{}\n" },
    ]);
    tempRoots.push(root);
    const files = ["widget.h", "plain.h", "schema.sql", "notes.md", "data.json"].map((name) => `${root}/${name}`);

    const counted = await withHeaderSampleReads(() => countNativeWorkerEligibleFiles(files, undefined));

    // Both headers plus the SQL file; Markdown is graph-only and JSON is unsupported.
    expect(counted.value).toBe(3);
    expect(counted.reads).toBe(0);
  });

  it("samples each header exactly once for a full project index", async () => {
    const headerCount = 4;
    const root = await makeHeaderProject("cg-header-sampling-index-", headerCount);

    const built = await withHeaderSampleReads(() => buildProjectIndex(root, { cache: "off" }));

    expect(built.reads).toBe(headerCount);
    // The single remaining sample still drives the parser: C++ syntax yields C++ symbols.
    expect(exportedNames(built.value, "widget0.h")).toEqual(["Widget", "widgets"]);
    expect(exportedNames(built.value, "schema.sql")).toEqual(["widgets"]);
  });

  it("indexes a mapped header project without sampling any header", async () => {
    const root = await makeHeaderProject("cg-header-sampling-index-mapped-", 2);

    const built = await withHeaderSampleReads(() =>
      buildProjectIndex(root, { cache: "off", languageExtensions: { ".h": "c" } }),
    );

    expect(built.reads).toBe(0);
    // Parsed as C, so the C++ namespace and class never become symbols.
    expect(exportedNames(built.value, "widget0.h")).toEqual(["value"]);
    expect(exportedNames(built.value, "schema.sql")).toEqual(["widgets"]);
  });
  it("builds a header bloom filter without a second synchronous sample", async () => {
    const root = await createTempProjectRoot("cg-header-sampling-bloom-", [{ path: "widget.h", contents: CPP_HEADER }]);
    tempRoots.push(root);
    const header = `${root}/widget.h`;

    const built = await withHeaderSampleReads(() => buildBloomFilterForFile(header));

    expect(built.value).not.toBeNull();
    expect(built.reads).toBe(0);
  });
});

describe("header classification for callers that already hold the source", () => {
  it("prepares a query index entry for a header without sampling it", async () => {
    const root = await createTempProjectRoot("cg-header-query-index-", [{ path: "widget.h", contents: CPP_HEADER }]);
    tempRoots.push(root);

    const task = { absolutePath: `${root}/widget.h`, path: "widget.h", sourceIdentity: "widget" };
    const prepared = await withHeaderSampleReads(() => prepareQueryIndexFile(task));

    // The text read for indexing also decides the chunk language, so nothing is sampled twice.
    expect(prepared.value?.language).toBe("cpp");
    expect(prepared.value?.sourceRead).toBe(true);
    expect(prepared.value?.chunks.length).toBeGreaterThan(0);
    expect(prepared.reads).toBe(0);
  });

  it("still samples an oversize header, whose source is deliberately never read", async () => {
    const oversize = CPP_HEADER + " ".repeat(MAX_QUERY_INDEX_TEXT_BYTES);
    const root = await createTempProjectRoot("cg-header-query-index-oversize-", [
      { path: "widget.h", contents: oversize },
    ]);
    tempRoots.push(root);

    const task = { absolutePath: `${root}/widget.h`, path: "widget.h", sourceIdentity: "widget" };
    const prepared = await withHeaderSampleReads(() => prepareQueryIndexFile(task));

    expect(prepared.value?.language).toBe("cpp");
    expect(prepared.value?.sourceRead).toBe(false);
    expect(prepared.value?.chunks).toEqual([]);
    expect(prepared.reads).toBe(1);
  });

  it("builds duplicate units for a header as C++ without sampling it", async () => {
    const root = await createTempProjectRoot("cg-header-duplicates-", [{ path: "widget.h", contents: CPP_HEADER }]);
    tempRoots.push(root);
    const index = await buildProjectIndex(root, { cache: "off" });
    const header = moduleFileEndingWith(index, "widget.h");

    const projectRoot = normalizePath(root);
    const buildUnits = () => buildDuplicateUnitsForFile(index, header, projectRoot, 1, 120, 3, 4, new Map());
    const built = await withHeaderSampleReads(buildUnits);

    // Chunk units carry the grammar that produced them, so `cpp` proves the exact classification.
    expect(built.value.map((unit) => unit.languageId)).toContain("cpp");
    expect(built.reads).toBe(0);
  });

  it("parses a deleted C++ header as C++ from the reconstructed source", async () => {
    const root = await createTempProjectRoot("cg-header-deleted-");
    tempRoots.push(root);
    const deletedHeader = normalizePath(`${root}/widget.h`);

    // The old worktree file is gone, so only the diff still holds the C++ syntax.
    expect(supportForFile(deletedHeader)?.id).toBe("c");

    const diffChangesByFile = new Map([[deletedHeader, deletionChange(deletedHeader, CPP_HEADER)]]);
    const snapshots = await buildDeletedFileSnapshots(normalizePath(root), [deletedHeader], { diffChangesByFile });
    const snapshot = snapshots.get(deletedHeader);

    expect(snapshot).toBeDefined();
    expect(
      snapshot?.module.exports.map((entry) => (entry.type === "local" ? entry.exportedAs : entry.type)).sort(),
    ).toEqual(["Widget", "widgets"]);
  });
});
