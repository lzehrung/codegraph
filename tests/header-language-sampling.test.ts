import fs from "node:fs";
import fsp from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildProjectIndex } from "../src/index.js";
import { countNativeWorkerEligibleFiles } from "../src/indexer/build-workers.js";
import type { ProjectIndex } from "../src/indexer/types.js";
import { supportForFile, supportForFileWithoutHeaderSample } from "../src/languages.js";
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
});
