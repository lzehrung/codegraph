import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectIndex, buildProjectIndexFromFiles, buildProjectIndexIncremental } from "../src/index.js";
import { clearMemoryCache } from "../src/indexer/build-cache.js";
import type { BuildReport, ProjectIndex } from "../src/indexer/types.js";
import { loadBinding } from "../src/native/runtime.js";
import {
  __resetNativeTreeSitterBindingForTests,
  __setNativeTreeSitterBindingForTests,
} from "../src/native/tree-sitter-native.js";
import { DEFAULT_NATIVE_SOURCE_MAX_BYTES } from "../src/native/source-limits.js";
import { fileIdentityKey, normalizePath } from "../src/util/paths.js";
import { createNativeWorkerPool, type NativeExtractResult } from "../src/worker/native-worker-pool.js";
import { KOTLIN_UNREAD_TAIL_LINE } from "./helpers/kotlin-unread-tail-fixture.js";

const tempDirs: string[] = [];
async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-project-worker-facts-"));
  tempDirs.push(root);
  return root;
}
async function writeProject(root: string, sources: Record<string, string>): Promise<void> {
  for (const [file, source] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), source, "utf8");
  }
}
function recordMainThreadParses(): { standalone: string[]; extraction: string[] } {
  const state = loadBinding();
  if (!state.loaded || !state.binding.parseSyntaxTree || !state.binding.extractLanguage) {
    throw new Error("Native addon required for worker project facts tests");
  }
  const parseSyntaxTree = state.binding.parseSyntaxTree;
  const extractLanguage = state.binding.extractLanguage;
  const calls = { standalone: [] as string[], extraction: [] as string[] };
  __setNativeTreeSitterBindingForTests({
    ...state,
    binding: {
      ...state.binding,
      parseSyntaxTree: (source, languageId) => {
        calls.standalone.push(source);
        return parseSyntaxTree(source, languageId);
      },
      extractLanguage: (source, querySetId) => {
        calls.extraction.push(source);
        return extractLanguage(source, querySetId);
      },
    },
  });
  return calls;
}
function moduleOf(index: ProjectIndex, root: string, file: string) {
  return index.byFile.get(fileIdentityKey(normalizePath(path.join(root, file))));
}
function importTarget(index: ProjectIndex, root: string, file: string, from: string): string | undefined {
  const resolved = moduleOf(index, root, file)?.imports.find((binding) => binding.from === from)?.resolved;
  return typeof resolved === "string" ? normalizePath(path.relative(root, resolved)) : undefined;
}
function semanticResult(index: ProjectIndex, root: string) {
  const relative = (file: string) => normalizePath(path.relative(root, file));
  return {
    modules: [...index.byFile.values()]
      .map((module) => ({
        file: relative(module.file),
        imports: module.imports.map((binding) => ({
          ...binding,
          ...(typeof binding.resolved === "string" ? { resolved: relative(binding.resolved) } : {}),
          ...(binding.kind === "star" && binding.jvmPackageFiles
            ? { jvmPackageFiles: binding.jvmPackageFiles.map(relative) }
            : {}),
        })),
        csharpNamespaceFacts: module.csharpNamespaceFacts,
        jvmFacts: module.jvmFacts,
        parseErrorRanges: module.parseErrorRanges,
        parserDegraded: module.parserDegraded,
        importLookupIncomplete: module.importLookupIncomplete,
      }))
      .sort((left, right) => left.file.localeCompare(right.file)),
    edges: index.graph.edges
      .map((edge) => ({
        ...edge,
        from: relative(edge.from),
        to: edge.to.type === "file" ? { type: "file", path: relative(edge.to.path) } : edge.to,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}
afterEach(async () => {
  __resetNativeTreeSitterBindingForTests();
  clearMemoryCache();
  for (const root of tempDirs.splice(0)) await rm(root, { recursive: true, force: true });
});

const sources: Record<string, string> = {
  "a/UseJava.java":
    "package app;\nimport core.JavaTarget;\nimport core.KotlinTarget;\nclass UseJava { JavaTarget a; KotlinTarget b; }\n",
  "a/UseKotlin.kt": "package app\nimport core.JavaTarget\nimport core.answer\nfun use() = answer()\n",
  "a/UseCsharp.cs": "using Alias = Core.Target;\nclass UseCsharp { Alias value; }\n",
  "z/JavaTarget.java": "package core;\npublic class JavaTarget {}\n",
  "z/KotlinTarget.kt": "package core\nclass KotlinTarget\nfun answer() = 42\n",
  "z/Target.cs": "namespace Core;\npublic class Target {}\n",
  "decoy/JavaTarget.java": "package elsewhere;\npublic class JavaTarget {}\n",
  "decoy/KotlinTarget.kt": "package elsewhere\nclass KotlinTarget\nfun answer() = 0\n",
  "decoy/Target.cs": "namespace Elsewhere;\npublic class Target {}\n",
};
function expectImports(index: ProjectIndex, root: string): void {
  expect(importTarget(index, root, "a/UseJava.java", "core.JavaTarget")).toBe("z/JavaTarget.java");
  expect(importTarget(index, root, "a/UseJava.java", "core.KotlinTarget")).toBe("z/KotlinTarget.kt");
  expect(importTarget(index, root, "a/UseKotlin.kt", "core.JavaTarget")).toBe("z/JavaTarget.java");
  expect(importTarget(index, root, "a/UseKotlin.kt", "core.answer")).toBe("z/KotlinTarget.kt");
  expect(
    moduleOf(index, root, "a/UseCsharp.cs")?.imports.some(
      (binding) => typeof binding.resolved === "string" && binding.resolved.endsWith("/z/Target.cs"),
    ),
  ).toBe(true);
  const edges = index.graph.edges.filter((edge) => edge.from.includes("/a/"));
  expect(edges.filter((edge) => edge.to.type === "file")).toHaveLength(5);
  expect(edges.some((edge) => edge.to.type === "file" && edge.to.path.includes("/decoy/"))).toBe(false);
}

describe("project facts extracted before import resolution", () => {
  it("reuses the worker extraction for C#, Java, and Kotlin with one capped task at a time", async () => {
    const root = await temporaryProject();
    await writeProject(root, sources);
    const calls = recordMainThreadParses();
    const report: BuildReport = { timings: {} };
    const workers = await buildProjectIndex(root, {
      cache: "off",
      useNativeWorkers: true,
      nativeThreads: 1,
      threads: 1,
      report,
    });
    expect(report.workerPool?.enabled).toBe(true);
    expect(report.workerPool?.tasksFailed).toBe(0);
    expect(report.workerPool?.tasksSubmitted).toBe(Object.keys(sources).length);
    expect(calls.standalone).toEqual([]);
    expect(calls.extraction).toEqual([]);
    expectImports(workers, root);

    const pool = createNativeWorkerPool({ threads: 1 });
    try {
      for (const [file, languageId] of [
        ["z/JavaTarget.java", "java"],
        ["z/KotlinTarget.kt", "kotlin"],
        ["z/Target.cs", "csharp"],
      ] as const) {
        const task = { filePath: path.join(root, file), languageId };
        const extracted = (await pool.run(task)) as NativeExtractResult;
        const module = moduleOf(workers, root, file);
        const expected =
          languageId === "csharp"
            ? { csharpNamespaceFacts: module?.csharpNamespaceFacts }
            : { jvmFacts: module?.jvmFacts };
        expect(extracted.projectFacts).toEqual(expected);
        const factsOnly = (await pool.run({ ...task, projectFactsOnly: true })) as NativeExtractResult;
        expect(factsOnly.projectFacts).toEqual(expected);
        expect(factsOnly.source).toBeUndefined();
        expect(factsOnly.syntaxTree).toBeNull();
        expect(factsOnly.nativeResults).toBeNull();
      }
    } finally {
      await pool.destroy();
    }

    __resetNativeTreeSitterBindingForTests();
    const serialCalls = recordMainThreadParses();
    const serial = await buildProjectIndex(root, { cache: "off", useNativeWorkers: false, threads: 1 });
    expect(serialCalls.standalone).toEqual([]);
    expect(serialCalls.extraction).toHaveLength(Object.keys(sources).length);
    expect(semanticResult(workers, root)).toEqual(semanticResult(serial, root));
  }, 60_000);

  it("reuses persisted facts without parsing unchanged files on a warm full build", async () => {
    const root = await temporaryProject();
    const cacheDir = await temporaryProject();
    await writeProject(root, sources);
    const options = { cache: "disk" as const, cacheDir, useNativeWorkers: true, nativeThreads: 1, threads: 1 };
    const cold = await buildProjectIndex(root, options);
    clearMemoryCache();
    const calls = recordMainThreadParses();
    const report: BuildReport = { timings: {} };
    const warm = await buildProjectIndex(root, { ...options, report });
    expect(report.workerPool?.tasksSubmitted ?? 0).toBe(0);
    expect(report.files?.cached).toBe(Object.keys(sources).length);
    expect(calls.standalone).toEqual([]);
    expect(calls.extraction).toEqual([]);
    expect(semanticResult(warm, root)).toEqual(semanticResult(cold, root));
    expectImports(warm, root);
  }, 60_000);

  for (const mode of ["ignored", "outside-file-list"] as const) {
    it(`uses facts-only worker tasks for ${mode} project scan files`, async () => {
      const root = await temporaryProject();
      await writeProject(root, sources);
      const calls = recordMainThreadParses();
      const report: BuildReport = { timings: {} };
      const options = {
        cache: "off" as const,
        useNativeWorkers: true,
        nativeThreads: 1,
        threads: 1,
        report,
      };
      let index: ProjectIndex;
      if (mode === "ignored") {
        index = await buildProjectIndex(root, {
          ...options,
          discovery: { ignoreGlobs: ["z/**", "decoy/**"], globRoot: root },
        });
      } else {
        index = await buildProjectIndexFromFiles(
          root,
          ["a/UseJava.java", "a/UseKotlin.kt", "a/UseCsharp.cs"].map((file) => path.join(root, file)),
          options,
        );
      }
      expect(report.workerPool?.enabled).toBe(true);
      expect(report.workerPool?.tasksFailed).toBe(0);
      expect(report.workerPool?.tasksSubmitted).toBe(Object.keys(sources).length);
      expect(calls.standalone).toEqual([]);
      expect(calls.extraction).toEqual([]);
      expect(index.byFile.size).toBe(3);
      expectImports(index, root);
    }, 60_000);
  }

  it("primes changed-file facts before an incremental package lookup and leaves unchanged sources unparsed", async () => {
    const root = await temporaryProject();
    const cacheDir = await temporaryProject();
    await writeProject(root, sources);
    const options = { cache: "disk" as const, cacheDir, useNativeWorkers: true, nativeThreads: 1, threads: 1 };
    await buildProjectIndexIncremental(root, options);
    clearMemoryCache();
    await writeProject(root, { "z/KotlinTarget.kt": "package core\nclass KotlinTarget\nfun answer() = 43\n" });
    const calls = recordMainThreadParses();
    const report: BuildReport = { timings: {} };
    const updated = await buildProjectIndexIncremental(root, { ...options, report });
    expect(report.workerPool?.enabled).toBe(true);
    expect(report.workerPool?.tasksFailed).toBe(0);
    expect(calls.standalone).toEqual([]);
    expect(calls.extraction).toEqual([]);
    expectImports(updated, root);
  }, 60_000);

  for (const contents of [
    `package core\n${KOTLIN_UNREAD_TAIL_LINE}\nfun answer(x: String) = x\n`,
    `package core\n/*${"x".repeat(DEFAULT_NATIVE_SOURCE_MAX_BYTES)}*/\n`,
  ]) {
    it(`keeps an ${contents.length > DEFAULT_NATIVE_SOURCE_MAX_BYTES ? "oversized" : "malformed"} package file conservative with workers on or off`, async () => {
      const root = await temporaryProject();
      await writeProject(root, {
        "a/Use.kt": "package app\nimport core.answer\nfun use() = answer()\n",
        "z/Peer.kt": "package core\nfun answer() = 42\n",
        "z/Gap.kt": contents,
      });
      const serial = await buildProjectIndex(root, { cache: "off", useNativeWorkers: false, threads: 1 });
      const workers = await buildProjectIndex(root, {
        cache: "off",
        useNativeWorkers: true,
        nativeThreads: 1,
        threads: 1,
      });
      expect(importTarget(workers, root, "a/Use.kt", "core.answer")).toBeUndefined();
      expect(moduleOf(workers, root, "a/Use.kt")?.importLookupIncomplete).toBe(true);
      expect(semanticResult(workers, root)).toEqual(semanticResult(serial, root));
    }, 60_000);
  }

  it.each(["java", "kt", "cs"])(
    "does not send oversized explicit %s sources to extraction workers",
    async (extension) => {
      const root = await temporaryProject();
      const prefix = extension === "cs" ? "namespace Core;\n" : "package core;\n";
      const files = [`Small.${extension}`, `Large.${extension}`];
      await writeProject(root, {
        [files[0]!]: `${prefix}class Small {}\n`,
        [files[1]!]: `${prefix}/*${"x".repeat(DEFAULT_NATIVE_SOURCE_MAX_BYTES)}*/\n`,
      });
      const paths = files.map((file) => path.join(root, file));
      const serial = await buildProjectIndexFromFiles(root, paths, { cache: "off", useNativeWorkers: false });
      const report: BuildReport = { timings: {} };
      const workers = await buildProjectIndexFromFiles(root, paths, {
        cache: "off",
        useNativeWorkers: true,
        nativeThreads: 1,
        threads: 1,
        report,
      });
      expect(report.workerPool?.enabled).toBe(true);
      expect(report.workerPool?.tasksSubmitted).toBe(1);
      expect(report.workerPool?.tasksFailed).toBe(0);
      expect(moduleOf(workers, root, files[1]!)?.nativeOutcome).toBe("skipped");
      expect(semanticResult(workers, root)).toEqual(semanticResult(serial, root));
    },
    60_000,
  );

  it("keeps C# aliases partial beside an oversized namespace candidate with workers on or off", async () => {
    const root = await temporaryProject();
    await writeProject(root, {
      "a/Use.cs": "using Alias = Core.Target;\nclass Use { Alias value; }\n",
      "z/Target.cs": "namespace Core;\npublic class Target {}\n",
      "z/Unknown.cs": `namespace Core;\n/*${"x".repeat(DEFAULT_NATIVE_SOURCE_MAX_BYTES)}*/\n`,
    });
    const serial = await buildProjectIndex(root, { cache: "off", useNativeWorkers: false, threads: 1 });
    const workers = await buildProjectIndex(root, {
      cache: "off",
      useNativeWorkers: true,
      nativeThreads: 1,
      threads: 1,
    });
    const alias = moduleOf(workers, root, "a/Use.cs")?.imports.find((binding) => binding.kind === "named");
    expect(typeof alias?.resolved).not.toBe("string");
    expect(moduleOf(workers, root, "a/Use.cs")?.importLookupIncomplete).toBe(true);
    expect(semanticResult(workers, root)).toEqual(semanticResult(serial, root));
  }, 60_000);

  it.each(["ignored", "outside-file-list"] as const)(
    "keeps an oversized %s C# scan candidate partial with workers on or off",
    async (mode) => {
      const root = await temporaryProject();
      await writeProject(root, {
        "a/Use.cs": "using Alias = Core.Target;\nclass Use { Alias value; }\n",
        "z/Target.cs": "namespace Core;\npublic class Target {}\n",
        "z/Unknown.cs": `namespace Other;\n/*${"x".repeat(DEFAULT_NATIVE_SOURCE_MAX_BYTES)}*/\n`,
      });
      const calls = recordMainThreadParses();
      const build = (useNativeWorkers: boolean, report?: BuildReport) => {
        const options = {
          cache: "off" as const,
          useNativeWorkers,
          nativeThreads: 1,
          threads: 1,
          ...(report ? { report } : {}),
        };
        if (mode === "ignored") {
          return buildProjectIndex(root, {
            ...options,
            discovery: { ignoreGlobs: ["z/Unknown.cs"], globRoot: root },
          });
        }
        return buildProjectIndexFromFiles(
          root,
          ["a/Use.cs", "z/Target.cs"].map((file) => path.join(root, file)),
          options,
        );
      };
      const serial = await build(false);
      const report: BuildReport = { timings: {} };
      const workers = await build(true, report);
      expect(report.workerPool?.enabled).toBe(true);
      expect(report.workerPool?.tasksFailed).toBe(0);
      expect(report.workerPool?.tasksSubmitted).toBe(3);
      for (const index of [serial, workers]) {
        expect(index.byFile.size).toBe(2);
        const use = moduleOf(index, root, "a/Use.cs");
        expect(use?.imports.find((binding) => binding.kind === "named")?.resolved).toEqual({ external: "Core.Target" });
        expect(use?.importLookupIncomplete).toBe(true);
        expect(index.graph.edges.some((edge) => edge.from === use?.file && edge.to.type === "file")).toBe(false);
      }
      expect(semanticResult(workers, root)).toEqual(semanticResult(serial, root));
      expect(
        calls.standalone.some((source) => Buffer.byteLength(source, "utf8") > DEFAULT_NATIVE_SOURCE_MAX_BYTES),
      ).toBe(false);
    },
    60_000,
  );

  it("preserves failed requested files without blocking later extraction tasks", async () => {
    const root = await temporaryProject();
    await writeProject(root, sources);
    const files = ["Missing.java", ...Object.keys(sources)].map((file) => path.join(root, file));
    const report: BuildReport = { timings: {} };
    const index = await buildProjectIndexFromFiles(root, files, {
      cache: "off",
      useNativeWorkers: true,
      nativeThreads: 1,
      threads: 1,
      report,
    });
    expect(report.files?.failed).toBe(1);
    expect(moduleOf(index, root, "Missing.java")?.parserDegraded).toBe(true);
    expectImports(index, root);
  }, 60_000);
});
