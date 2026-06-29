import { describe, test, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import type { ICodeReviewSession } from "../src/index.js";
import type { BuildOptions, BuildReport } from "../src/indexer/types.js";
import { CodeReviewSession, SessionManager, createCodeReviewSession } from "../src/session.js";
import * as indexerBuild from "../src/indexer/build-index.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { resolveFilePathFromRoot } from "../src/util.js";

const sampleRoot = path.resolve("tests/samples/typescript");
let sessionCacheDir: string | undefined;

function sampleBuildOptions(overrides: BuildOptions = {}): BuildOptions {
  if (!sessionCacheDir) {
    throw new Error("Expected session cache directory");
  }
  return {
    cache: "memory",
    useBloomFilters: true,
    cacheDir: sessionCacheDir,
    ...overrides,
  };
}

beforeAll(async () => {
  sessionCacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-cache-"));
});

afterAll(async () => {
  if (sessionCacheDir) {
    await fsp.rm(sessionCacheDir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.useRealTimers();
});

function setSessionClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
}

function advancePastStaleInterval(): void {
  vi.setSystemTime(Date.now() + 5_001);
}

describe("CodeReviewSession", () => {
  let sharedReadySession: CodeReviewSession | undefined;

  beforeAll(async () => {
    sharedReadySession = await createCodeReviewSession({
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });
  });

  afterAll(() => {
    sharedReadySession?.dispose();
  });

  function readySession(): CodeReviewSession {
    if (!sharedReadySession) {
      throw new Error("Expected shared ready session");
    }
    return sharedReadySession;
  }

  test("should initialize successfully", async () => {
    const session = new CodeReviewSession({
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    expect(session.getStatus()).toBe("initializing");

    await session.init();

    expect(session.getStatus()).toBe("ready");
    expect(session.isReady()).toBe(true);
  });

  test("should request build reports during default initialization", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-default-report-"));
    await fsp.writeFile(path.join(root, "main.ts"), "export const value = 1;\n", "utf8");
    const originalBuild = indexerBuild.buildProjectIndexIncremental;
    let requestedReport: BuildReport | undefined;
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (...args) => {
      requestedReport = args[1]?.report;
      return await originalBuild(...args);
    });

    try {
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });

      expect(session.getStatus()).toBe("ready");
      expect(requestedReport?.timings).toBeDefined();
      expect(buildSpy).toHaveBeenCalledTimes(1);
      session.dispose();
    } finally {
      buildSpy.mockRestore();
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should provide session statistics", async () => {
    const session = readySession();

    const stats = session.getStats();

    expect(stats.status).toBe("ready");
    expect(stats.fileCount).toBeGreaterThan(0);
    expect(stats.symbolCount).toBeGreaterThan(0);
    expect(stats.lastActivity).toBeInstanceOf(Date);
    expect(stats.timeUntilExpiration).toBeGreaterThan(0);
    expect(stats.stale).toBe(false);
    expect(stats.lastRefreshReason).toBe("initialization");
  });

  test("should expose analyzeImpactStream on the session interface", async () => {
    const session = readySession();

    const typedSession = ((value: ICodeReviewSession) => value)(session);

    expect(typedSession.isReady()).toBe(true);
    expect(typedSession.analyzeImpactStream).toBeTypeOf("function");
  });

  test("should pass streaming summary mode through session impact streaming", async () => {
    const session = readySession();
    const diffText = `diff --git a/utils.ts b/utils.ts
index 1234567..abcdef0 100644
--- a/utils.ts
+++ b/utils.ts
@@ -1,3 +1,3 @@
 export function helperFunction(): string {
-  return "Hello from utils";
+  return "Hello from updated utils";
 }
`;

    let completeReport: { suggestions?: unknown; topImpacts: unknown[] } | undefined;
    for await (const chunk of session.analyzeImpactStream({
      provider: "raw",
      diffText,
      streamSummary: "light",
    })) {
      if (chunk.type === "complete") {
        completeReport = chunk.report;
      }
    }

    expect(completeReport).toBeDefined();
    expect(completeReport?.suggestions).toBeUndefined();
    expect(completeReport?.topImpacts).toEqual([]);
  });

  test("should find references using cached index", async () => {
    const session = readySession();

    const file = path.resolve(sampleRoot, "utils.ts");

    const result = await session.findReferences({
      file,
      line: 1,
      column: 17,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.references.length).toBeGreaterThan(0);
    }
  });

  test("should normalize relative session navigation paths", async () => {
    const session = readySession();

    const result = await session.goToDefinition({
      file: "main.ts",
      line: 7,
      column: 25,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file.replace(/\\/g, "/")).toContain("utils.ts");
    }
  });

  test("should normalize host-native absolute session navigation paths", async () => {
    const session = readySession();

    const result = await session.goToDefinition({
      file: path.join(sampleRoot, "main.ts"),
      line: 7,
      column: 25,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file.replace(/\\/g, "/")).toContain("utils.ts");
    }
  });

  test("should reject out-of-root session navigation paths explicitly", async () => {
    const session = readySession();
    const outsideFile = path.resolve("README.md");

    const definition = await session.goToDefinition({
      file: outsideFile,
      line: 1,
      column: 1,
    });
    const references = await session.findReferences({
      file: outsideFile,
      line: 1,
      column: 1,
    });

    expect(definition.status).toBe("error");
    expect(references.status).toBe("error");
    if (definition.status === "error") {
      expect(definition.reason).toBe("outside_project_root");
      expect(definition.error).toContain("outside project root");
    }
    if (references.status === "error") {
      expect(references.reason).toBe("outside_project_root");
      expect(references.error).toContain("outside project root");
    }
  });

  test("should keep Windows-style absolute paths absolute even on non-Windows hosts", () => {
    expect(resolveFilePathFromRoot("/repo", "C:/repo/src/main.ts")).toBe("C:/repo/src/main.ts");
    expect(resolveFilePathFromRoot("/repo", String.raw`C:\repo\src\main.ts`)).toBe(String.raw`C:\repo\src\main.ts`);
  });

  test("should refresh the index", async () => {
    const session = await createCodeReviewSession({
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    expect(session.isReady()).toBe(true);

    await session.refresh();

    expect(session.isReady()).toBe(true);
  });

  test("should preserve the last ready index when refresh fails", async () => {
    const session = await createCodeReviewSession({
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    const buildSpy = vi
      .spyOn(indexerBuild, "buildProjectIndexIncremental")
      .mockRejectedValue(new Error("synthetic refresh failure"));

    try {
      await expect(session.refresh()).rejects.toThrow("synthetic refresh failure");
      expect(session.getStatus()).toBe("ready");
      expect(session.isReady()).toBe(true);

      const file = path.resolve(sampleRoot, "utils.ts");
      await expect(session.findReferences({ file, line: 1, column: 17 })).resolves.toMatchObject({ status: "ok" });
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("should mark stale sessions and auto-refresh before serving navigation", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-stale-"));
    try {
      await fsp.writeFile(
        path.join(root, "utils.ts"),
        "export function helper(value: string) { return value; }\n",
        "utf8",
      );
      await fsp.writeFile(
        path.join(root, "main.ts"),
        "import { helper } from './utils';\nexport const ok = helper('token');\n",
        "utf8",
      );
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });
      await fsp.writeFile(
        path.join(root, "utils.ts"),
        "export function helper(value: string) { return value.trim(); }\n",
        "utf8",
      );

      const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
      try {
        const result = await session.findReferences({
          file: path.join(root, "utils.ts"),
          line: 1,
          column: 17,
        });
        expect(result.status).toBe("ok");
        expect(session.getStats().stale).toBe(false);
        expect(session.getStats().lastRefreshReason).toBe("stale_check");
        expect(buildSpy).toHaveBeenCalledTimes(1);
      } finally {
        buildSpy.mockRestore();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should throttle full stale scans while checking the navigation target", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-stale-throttle-"));
    try {
      await fsp.writeFile(path.join(root, "utils.ts"), "export function helper() { return 1; }\n", "utf8");
      await fsp.writeFile(
        path.join(root, "main.ts"),
        "import { helper } from './utils';\nexport const value = helper();\n",
        "utf8",
      );
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });

      const statSpy = vi.spyOn(fs, "statSync");
      try {
        const first = await session.goToDefinition({
          file: path.join(root, "main.ts"),
          line: 2,
          column: 22,
        });
        const second = await session.goToDefinition({
          file: path.join(root, "main.ts"),
          line: 2,
          column: 22,
        });

        expect(first.status).toBe("ok");
        expect(second.status).toBe("ok");
        expect(statSpy).toHaveBeenCalledTimes(2);
      } finally {
        statSpy.mockRestore();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should avoid full tracked-file scans after the stale interval", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-stale-cheap-"));
    try {
      const exports = Array.from({ length: 20 }, (_, index) => `export const value${index} = ${index};\n`);
      await Promise.all(
        exports.map((source, index) => fsp.writeFile(path.join(root, `dep${index}.ts`), source, "utf8")),
      );
      await fsp.writeFile(
        path.join(root, "main.ts"),
        "import { value0 } from './dep0';\nexport const value = value0;\n",
        "utf8",
      );
      setSessionClock();
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });
      advancePastStaleInterval();

      const statSpy = vi.spyOn(fs, "statSync");
      try {
        const result = await session.goToDefinition({
          file: path.join(root, "main.ts"),
          line: 2,
          column: 22,
        });

        expect(result.status).toBe("ok");
        expect(statSpy.mock.calls.length).toBeLessThan(10);
      } finally {
        statSpy.mockRestore();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should run tracked-file stale scans before impact analysis", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-impact-stale-"));
    try {
      const utilsPath = path.join(root, "utils.ts");
      const mainPath = path.join(root, "main.ts");
      await fsp.writeFile(utilsPath, "export function helper() { return 1; }\n", "utf8");
      await fsp.writeFile(mainPath, "import { helper } from './utils';\nexport const value = helper();\n", "utf8");
      setSessionClock();
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });
      const navigation = await session.goToDefinition({
        file: mainPath,
        line: 2,
        column: 22,
      });
      expect(navigation.status).toBe("ok");
      await fsp.writeFile(utilsPath, "export function helper() { return 42; }\n", "utf8");
      advancePastStaleInterval();
      expect(session.getStats().status).toBe("ready");

      const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
      try {
        await session.analyzeImpact({
          provider: "raw",
          diffText: `diff --git a/main.ts b/main.ts
index 1234567..abcdef0 100644
--- a/main.ts
+++ b/main.ts
@@ -1,2 +1,2 @@
 import { helper } from './utils';
-export const value = helper();
+export const value = helper() + 1;
`,
        });

        expect(session.getStats().stale).toBe(false);
        expect(session.getStats().lastRefreshReason).toBe("stale_check");
        expect(buildSpy).toHaveBeenCalledTimes(1);
      } finally {
        buildSpy.mockRestore();
        session.dispose();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should run tracked-file stale scans before streaming impact analysis", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-impact-stream-stale-"));
    try {
      const utilsPath = path.join(root, "utils.ts");
      const mainPath = path.join(root, "main.ts");
      await fsp.writeFile(utilsPath, "export function helper() { return 1; }\n", "utf8");
      await fsp.writeFile(mainPath, "import { helper } from './utils';\nexport const value = helper();\n", "utf8");
      setSessionClock();
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });
      const navigation = await session.goToDefinition({
        file: mainPath,
        line: 2,
        column: 22,
      });
      expect(navigation.status).toBe("ok");
      await fsp.writeFile(utilsPath, "export function helper() { return 42; }\n", "utf8");
      advancePastStaleInterval();
      expect(session.getStats().status).toBe("ready");

      const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
      try {
        for await (const chunk of session.analyzeImpactStream({
          provider: "raw",
          diffText: `diff --git a/main.ts b/main.ts
index 1234567..abcdef0 100644
--- a/main.ts
+++ b/main.ts
@@ -1,2 +1,2 @@
 import { helper } from './utils';
-export const value = helper();
+export const value = helper() + 1;
`,
          streamSummary: "light",
        })) {
          if (chunk.type === "complete") {
            break;
          }
        }

        expect(session.getStats().stale).toBe(false);
        expect(session.getStats().lastRefreshReason).toBe("stale_check");
        expect(buildSpy).toHaveBeenCalledTimes(1);
      } finally {
        buildSpy.mockRestore();
        session.dispose();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should throttle tracked-file stale scans across repeated impact calls", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-impact-scan-throttle-"));
    try {
      const exports = Array.from({ length: 20 }, (_, index) => `export const value${index} = ${index};\n`);
      await Promise.all(
        exports.map((source, index) => fsp.writeFile(path.join(root, `dep${index}.ts`), source, "utf8")),
      );
      const mainPath = path.join(root, "main.ts");
      await fsp.writeFile(mainPath, "import { value0 } from './dep0';\nexport const value = value0;\n", "utf8");
      setSessionClock();
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });
      const diffText = `diff --git a/main.ts b/main.ts
index 1234567..abcdef0 100644
--- a/main.ts
+++ b/main.ts
@@ -1,2 +1,2 @@
 import { value0 } from './dep0';
-export const value = value0;
+export const value = value0 + 1;
`;
      advancePastStaleInterval();

      const statSpy = vi.spyOn(fs, "statSync");
      const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
      try {
        await session.analyzeImpact({ provider: "raw", diffText });
        const broadScanStatCalls = statSpy.mock.calls.length;
        statSpy.mockClear();

        await session.analyzeImpact({ provider: "raw", diffText });

        expect(buildSpy).not.toHaveBeenCalled();
        expect(broadScanStatCalls).toBeGreaterThan(statSpy.mock.calls.length);
        expect(statSpy.mock.calls.length).toBeLessThan(10);
      } finally {
        buildSpy.mockRestore();
        statSpy.mockRestore();
        session.dispose();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should not let impact postpone navigation directory checks", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-impact-navigation-timer-"));
    try {
      const mainPath = path.join(root, "main.ts");
      const latePath = path.join(root, "late.ts");
      await fsp.writeFile(mainPath, "import { late } from './late';\nexport const value = late();\n", "utf8");
      setSessionClock();
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });
      advancePastStaleInterval();

      await session.analyzeImpact({
        provider: "raw",
        diffText: `diff --git a/main.ts b/main.ts
index 1234567..abcdef0 100644
--- a/main.ts
+++ b/main.ts
@@ -1,2 +1,2 @@
 import { late } from './late';
-export const value = late();
+export const value = late() + 1;
`,
      });
      await fsp.writeFile(latePath, "export function late() { return 1; }\n", "utf8");
      await fsp.utimes(root, new Date(), new Date(Date.now() + 10_000));

      const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
      try {
        const result = await session.goToDefinition({
          file: mainPath,
          line: 2,
          column: 22,
        });

        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(result.definition.file).toBe(path.resolve(latePath));
          expect(result.definition.localName).toBe("late");
        }
        expect(session.getStats().lastRefreshReason).toBe("stale_check");
        expect(buildSpy).toHaveBeenCalledTimes(1);
      } finally {
        buildSpy.mockRestore();
        session.dispose();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should not let passive status checks postpone navigation directory checks", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-status-navigation-timer-"));
    try {
      const mainPath = path.join(root, "main.ts");
      const latePath = path.join(root, "late.ts");
      await fsp.writeFile(mainPath, "import { late } from './late';\nexport const value = late();\n", "utf8");
      setSessionClock();
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });

      advancePastStaleInterval();
      expect(session.getStats().status).toBe("ready");
      await fsp.writeFile(latePath, "export function late() { return 1; }\n", "utf8");
      await fsp.utimes(root, new Date(), new Date(Date.now() + 10_000));

      const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
      try {
        const result = await session.goToDefinition({
          file: mainPath,
          line: 2,
          column: 22,
        });

        expect(result.status).toBe("ok");
        if (result.status === "ok") {
          expect(result.definition.file).toBe(path.resolve(latePath));
          expect(result.definition.localName).toBe("late");
        }
        expect(session.getStats().lastRefreshReason).toBe("stale_check");
        expect(buildSpy).toHaveBeenCalledTimes(1);
      } finally {
        buildSpy.mockRestore();
        session.dispose();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should refresh impact analysis when a source file is added", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-impact-added-file-"));
    try {
      const mainPath = path.join(root, "main.ts");
      await fsp.writeFile(mainPath, "export const value = 1;\n", "utf8");
      setSessionClock();
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });
      await fsp.writeFile(path.join(root, "late.ts"), "export const late = 1;\n", "utf8");
      await fsp.utimes(root, new Date(), new Date(Date.now() + 10_000));
      advancePastStaleInterval();

      const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
      try {
        await session.analyzeImpact({
          provider: "raw",
          diffText: `diff --git a/main.ts b/main.ts
index 1234567..abcdef0 100644
--- a/main.ts
+++ b/main.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`,
        });

        expect(session.getStats().lastRefreshReason).toBe("stale_check");
        expect(buildSpy).toHaveBeenCalledTimes(1);
      } finally {
        buildSpy.mockRestore();
        session.dispose();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should refresh streaming impact analysis when a source file is added", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-impact-stream-added-file-"));
    try {
      const mainPath = path.join(root, "main.ts");
      await fsp.writeFile(mainPath, "export const value = 1;\n", "utf8");
      setSessionClock();
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });
      await fsp.writeFile(path.join(root, "late.ts"), "export const late = 1;\n", "utf8");
      await fsp.utimes(root, new Date(), new Date(Date.now() + 10_000));
      advancePastStaleInterval();

      const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
      try {
        for await (const chunk of session.analyzeImpactStream({
          provider: "raw",
          diffText: `diff --git a/main.ts b/main.ts
index 1234567..abcdef0 100644
--- a/main.ts
+++ b/main.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`,
          streamSummary: "light",
        })) {
          if (chunk.type === "complete") {
            break;
          }
        }

        expect(session.getStats().lastRefreshReason).toBe("stale_check");
        expect(buildSpy).toHaveBeenCalledTimes(1);
      } finally {
        buildSpy.mockRestore();
        session.dispose();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should refresh navigation when config changes", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-config-navigation-"));
    try {
      const mainPath = path.join(root, "main.ts");
      await fsp.writeFile(mainPath, "export function helper() { return 1; }\n", "utf8");
      await fsp.writeFile(
        path.join(root, "codegraph.config.json"),
        JSON.stringify({ discovery: { includeGlobs: ["main.ts"] } }),
        "utf8",
      );
      setSessionClock();
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });
      await fsp.writeFile(
        path.join(root, "codegraph.config.json"),
        JSON.stringify({ discovery: { includeGlobs: ["other.ts"] } }),
        "utf8",
      );
      advancePastStaleInterval();

      const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
      try {
        const result = await session.goToDefinition({
          file: mainPath,
          line: 1,
          column: 17,
        });

        expect(result.status).toBe("not_found");
        expect(session.getStats().lastRefreshReason).toBe("stale_check");
        expect(buildSpy.mock.calls.length).toBeGreaterThan(0);
      } finally {
        buildSpy.mockRestore();
        session.dispose();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should auto-refresh before navigation when a new source file is added", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-added-file-"));
    try {
      await fsp.writeFile(
        path.join(root, "main.ts"),
        "import { late } from './late';\nexport const value = late();\n",
        "utf8",
      );
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });

      await fsp.writeFile(
        path.join(root, "late.ts"),
        "export function late() { return 1; }\nexport const value = late();\n",
        "utf8",
      );

      const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
      try {
        const result = await session.goToDefinition({
          file: path.join(root, "late.ts"),
          line: 2,
          column: 22,
        });
        expect(result.status).toBe("ok");
        expect(session.getStats().stale).toBe(false);
        expect(session.getStats().lastRefreshReason).toBe("stale_check");
        expect(buildSpy).toHaveBeenCalledTimes(1);
      } finally {
        buildSpy.mockRestore();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should include new source files on manual refresh", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-manual-added-file-"));
    try {
      await fsp.writeFile(
        path.join(root, "main.ts"),
        "import { late } from './late';\nexport const value = late();\n",
        "utf8",
      );
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });

      await fsp.writeFile(
        path.join(root, "late.ts"),
        "export function late() { return 1; }\nexport const value = late();\n",
        "utf8",
      );

      const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
      try {
        await session.refresh();
        const result = await session.goToDefinition({
          file: path.join(root, "late.ts"),
          line: 2,
          column: 22,
        });
        expect(result.status).toBe("ok");
        expect(session.getStats().lastRefreshReason).toBe("manual");
        expect(buildSpy).toHaveBeenCalledTimes(1);
      } finally {
        buildSpy.mockRestore();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should reload config discovery options before refresh builds", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-config-refresh-"));
    const configPath = path.join(root, "codegraph.config.json");
    try {
      await fsp.writeFile(configPath, JSON.stringify({ discovery: { includeGlobs: ["main.ts"] } }, null, 2), "utf8");
      await fsp.writeFile(
        path.join(root, "main.ts"),
        "import { late } from './late';\nexport const value = late();\n",
        "utf8",
      );
      await fsp.writeFile(path.join(root, "late.ts"), "export function late() { return 1; }\n", "utf8");
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });
      expect(session.getStats().fileCount).toBe(1);

      await fsp.writeFile(configPath, JSON.stringify({ discovery: { includeGlobs: ["*.ts"] } }, null, 2), "utf8");
      await session.refresh();

      expect(session.getStats().fileCount).toBe(2);
      const result = await session.goToDefinition({
        file: path.join(root, "main.ts"),
        line: 2,
        column: 22,
      });
      expect(result.status).toBe("ok");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should use full builds for force refreshes when incremental is disabled", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-manual-full-refresh-"));
    try {
      await fsp.writeFile(
        path.join(root, "main.ts"),
        "import { late } from './late';\nexport const value = late();\n",
        "utf8",
      );
      const session = await createCodeReviewSession({
        root,
        incremental: false,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });

      await fsp.writeFile(
        path.join(root, "late.ts"),
        "export function late() { return 1; }\nexport const value = late();\n",
        "utf8",
      );

      const fullBuildSpy = vi.spyOn(indexerBuild, "buildProjectIndex");
      const incrementalBuildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");
      try {
        await session.refresh();
        const result = await session.goToDefinition({
          file: path.join(root, "late.ts"),
          line: 2,
          column: 22,
        });
        expect(result.status).toBe("ok");
        expect(session.getStats().lastRefreshReason).toBe("manual");
        expect(fullBuildSpy).toHaveBeenCalledTimes(1);
        expect(incrementalBuildSpy).not.toHaveBeenCalled();
      } finally {
        fullBuildSpy.mockRestore();
        incrementalBuildSpy.mockRestore();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should expire after timeout", async () => {
    const session = new CodeReviewSession({
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
      timeout: 100, // 100ms timeout for testing
    });

    await session.init();
    expect(session.isReady()).toBe(true);

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(session.getStatus()).toBe("expired");
    expect(session.isReady()).toBe(false);
  });

  test("should omit stale metadata after disposal", async () => {
    const session = await createCodeReviewSession({
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    Object.defineProperty(session, "staleReason", {
      configurable: true,
      value: "tracked_files_changed",
      writable: true,
    });

    session.dispose();

    const stats = session.getStats();
    expect(stats.status).toBe("expired");
    expect(stats.stale).toBe(false);
    expect(stats.staleReason).toBeUndefined();
  });

  test("should re-initialize after expiration", async () => {
    const session = new CodeReviewSession({
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
      timeout: 100,
    });

    await session.init();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(session.getStatus()).toBe("expired");

    await session.init();

    expect(session.getStatus()).toBe("ready");
  });

  test("should dispose of session", async () => {
    const session = await createCodeReviewSession({
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    expect(session.isReady()).toBe(true);

    session.dispose();

    expect(session.getStatus()).toBe("expired");
    expect(session.isReady()).toBe(false);
    expect(session.getStats().timeUntilExpiration).toBe(0);
  });

  test("should keep a disposed session expired when init completes later", async () => {
    const originalBuild = indexerBuild.buildProjectIndexIncremental;
    let releaseBuild: (() => void) | null = null;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (...args) => {
      await buildGate;
      return await originalBuild(...args);
    });

    try {
      const session = new CodeReviewSession({
        root: sampleRoot,
        buildOptions: sampleBuildOptions(),
      });

      const initPromise = session.init();
      session.dispose();
      releaseBuild?.();

      await expect(initPromise).rejects.toThrow(/disposed during initialization/);
      expect(session.getStatus()).toBe("expired");
      expect(session.isReady()).toBe(false);
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("should keep a disposed session expired when refresh completes later", async () => {
    const session = await createCodeReviewSession({
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });
    const originalBuild = indexerBuild.buildProjectIndexIncremental;
    let releaseBuild: (() => void) | null = null;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (...args) => {
      await buildGate;
      return await originalBuild(...args);
    });

    try {
      const refreshPromise = session.refresh();
      session.dispose();
      releaseBuild?.();

      await expect(refreshPromise).rejects.toThrow(/disposed during refresh/);
      expect(session.getStatus()).toBe("expired");
      expect(session.isReady()).toBe(false);
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("should await in-flight refreshes for concurrent navigation", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-concurrent-refresh-"));
    try {
      const utilsPath = path.join(root, "utils.ts");
      const mainPath = path.join(root, "main.ts");
      await fsp.writeFile(utilsPath, "export function helper(value: string) { return value; }\n", "utf8");
      await fsp.writeFile(mainPath, "import { helper } from './utils';\nexport const ok = helper('token');\n", "utf8");
      const session = await createCodeReviewSession({
        root,
        buildOptions: { cache: "memory", useBloomFilters: true },
      });
      await fsp.writeFile(utilsPath, "export function helper(value: string) { return value.trim(); }\n", "utf8");

      const originalBuild = indexerBuild.buildProjectIndexIncremental;
      let releaseBuild: (() => void) | null = null;
      let markBuildStarted: (() => void) | null = null;
      const buildGate = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      const buildStarted = new Promise<void>((resolve) => {
        markBuildStarted = resolve;
      });
      const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (...args) => {
        markBuildStarted?.();
        await buildGate;
        return await originalBuild(...args);
      });

      try {
        const first = session.findReferences({
          file: utilsPath,
          line: 1,
          column: 17,
        });
        await buildStarted;
        const second = session.goToDefinition({
          file: mainPath,
          line: 2,
          column: 19,
        });

        releaseBuild?.();
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult.status).toBe("ok");
        expect(secondResult.status).toBe("ok");
        expect(buildSpy).toHaveBeenCalledTimes(1);
      } finally {
        buildSpy.mockRestore();
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test("should throw error when used after expiration", async () => {
    const session = await createCodeReviewSession({
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
      timeout: 100,
    });

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 150));

    const file = path.resolve(sampleRoot, "utils.ts");

    await expect(session.findReferences({ file, line: 1, column: 17 })).rejects.toThrow();
  });

  test("should reject missing impact providers explicitly", async () => {
    const session = readySession();

    await expect(
      Reflect.apply(session.analyzeImpact, session, [{ diffText: "diff --git a/main.ts b/main.ts\n" }]),
    ).rejects.toThrow(/Impact provider is required/);

    await expect(
      (async () => {
        for await (const _chunk of Reflect.apply(session.analyzeImpactStream, session, [
          { diffText: "diff --git a/main.ts b/main.ts\n" },
        ])) {
          break;
        }
      })(),
    ).rejects.toThrow(/Impact provider is required/);
  });
});

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  test("should create and retrieve sessions", async () => {
    const session = await manager.getOrCreateSession("test-session", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    expect(session).toBeDefined();
    expect(session.isReady()).toBe(true);

    const retrieved = manager.getSession("test-session");
    expect(retrieved).toBe(session);
  });

  test("should reuse existing ready sessions", async () => {
    const session1 = await manager.getOrCreateSession("test-session", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    const session2 = await manager.getOrCreateSession("test-session", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    expect(session1).toBe(session2);
  });

  test("should share one initialization across concurrent same-id creation", async () => {
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental");

    try {
      const [sessionA, sessionB] = await Promise.all([
        manager.getOrCreateSession("shared", {
          root: sampleRoot,
          buildOptions: sampleBuildOptions(),
        }),
        manager.getOrCreateSession("shared", {
          root: sampleRoot,
          buildOptions: sampleBuildOptions(),
        }),
      ]);

      expect(sessionA).toBe(sessionB);
      expect(manager.getSession("shared")).toBe(sessionA);
      expect(manager.getSessionIds()).toEqual(["shared"]);
      expect(buildSpy).toHaveBeenCalledTimes(1);
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("should not repopulate a session disposed during initialization", async () => {
    const originalBuild = indexerBuild.buildProjectIndexIncremental;
    let releaseBuild: (() => void) | null = null;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (...args) => {
      await buildGate;
      return await originalBuild(...args);
    });

    try {
      const pendingSession = manager.getOrCreateSession("pending", {
        root: sampleRoot,
        buildOptions: sampleBuildOptions(),
      });

      await Promise.resolve();
      manager.disposeSession("pending");
      releaseBuild?.();

      await expect(pendingSession).rejects.toThrow(/disposed during initialization/);
      expect(manager.getSession("pending")).toBeUndefined();
      expect(manager.getSessionIds()).toEqual([]);
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("should allow immediate recreation after disposing a pending session", async () => {
    const originalBuild = indexerBuild.buildProjectIndexIncremental;
    let releaseBuild: (() => void) | null = null;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (...args) => {
      await buildGate;
      return await originalBuild(...args);
    });

    try {
      const firstSession = manager.getOrCreateSession("pending", {
        root: sampleRoot,
        buildOptions: sampleBuildOptions(),
      });

      await Promise.resolve();
      manager.disposeSession("pending");
      const secondSession = manager.getOrCreateSession("pending", {
        root: sampleRoot,
        buildOptions: sampleBuildOptions(),
      });
      releaseBuild?.();

      await expect(firstSession).rejects.toThrow(/disposed during initialization/);
      await expect(secondSession).resolves.toMatchObject({
        getStatus: expect.any(Function),
      });
      expect((await secondSession).getStatus()).toBe("ready");
      expect(manager.getSession("pending")).toBe(await secondSession);
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("should allow immediate recreation after disposeAll cancels a pending session", async () => {
    const originalBuild = indexerBuild.buildProjectIndexIncremental;
    let releaseBuild: (() => void) | null = null;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (...args) => {
      await buildGate;
      return await originalBuild(...args);
    });

    try {
      const firstSession = manager.getOrCreateSession("pending", {
        root: sampleRoot,
        buildOptions: sampleBuildOptions(),
      });

      await Promise.resolve();
      manager.disposeAll();
      const secondSession = manager.getOrCreateSession("pending", {
        root: sampleRoot,
        buildOptions: sampleBuildOptions(),
      });
      releaseBuild?.();

      await expect(firstSession).rejects.toThrow(/disposed during initialization/);
      await expect(secondSession).resolves.toMatchObject({
        getStatus: expect.any(Function),
      });
      expect((await secondSession).getStatus()).toBe("ready");
      expect(manager.getSession("pending")).toBe(await secondSession);
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("should not retain failed getOrCreate sessions", async () => {
    const badRoot = path.join(os.tmpdir(), `dg-session-missing-${Date.now()}`);

    await expect(
      manager.getOrCreateSession("broken", {
        root: badRoot,
        buildOptions: { cache: "memory" },
      }),
    ).rejects.toThrow();

    expect(manager.getSession("broken")).toBeUndefined();
    expect(manager.getSessionIds()).toEqual([]);
  });

  test("should remove expired sessions when reinitialization fails", async () => {
    const session = await manager.getOrCreateSession("expiring", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
      timeout: 100,
    });

    expect(session.getStatus()).toBe("ready");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 150);
    expect(session.getStatus()).toBe("expired");

    const buildSpy = vi
      .spyOn(indexerBuild, "buildProjectIndexIncremental")
      .mockRejectedValue(new Error("synthetic reinit failure"));

    try {
      await expect(
        manager.getOrCreateSession("expiring", {
          root: sampleRoot,
          buildOptions: sampleBuildOptions(),
          timeout: 100,
        }),
      ).rejects.toThrow("synthetic reinit failure");

      expect(manager.getSession("expiring")).toBeUndefined();
      expect(manager.getSessionIds()).toEqual([]);
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("should reject reusing a session id for a different root", async () => {
    const rootA = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-root-a-"));
    const rootB = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-root-b-"));
    try {
      await fsp.writeFile(path.join(rootA, "a.ts"), "export const a = 1;\n", "utf8");
      await fsp.writeFile(path.join(rootB, "b.ts"), "export const b = 1;\n", "utf8");

      await manager.getOrCreateSession("shared", {
        root: rootA,
        buildOptions: { cache: "memory" },
      });

      await expect(
        manager.getOrCreateSession("shared", {
          root: rootB,
          buildOptions: { cache: "memory" },
        }),
      ).rejects.toThrow(/different configuration/);
    } finally {
      await fsp.rm(rootA, { recursive: true, force: true });
      await fsp.rm(rootB, { recursive: true, force: true });
    }
  });

  test("should reject reusing a session id for different build options", async () => {
    await manager.getOrCreateSession("shared", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    await expect(
      manager.getOrCreateSession("shared", {
        root: sampleRoot,
        buildOptions: sampleBuildOptions({ cache: "disk" }),
      }),
    ).rejects.toThrow(/different configuration/);
  });

  test("should reject reusing a session id when graph options drift", async () => {
    await manager.getOrCreateSession("shared", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions({
        graph: { fast: true, logLevel: "warn" },
      }),
    });

    await expect(
      manager.getOrCreateSession("shared", {
        root: sampleRoot,
        buildOptions: sampleBuildOptions({
          graph: { fast: true, logLevel: "debug" },
        }),
      }),
    ).rejects.toThrow(/different configuration/);
  });

  test("should reject reusing a session id when discovery options drift", async () => {
    const gitignoreRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-gitignore-root-"));

    try {
      await manager.getOrCreateSession("shared", {
        root: sampleRoot,
        buildOptions: sampleBuildOptions({
          discovery: { useGitignore: true, gitignoreRoot: sampleRoot },
        }),
      });

      await expect(
        manager.getOrCreateSession("shared", {
          root: sampleRoot,
          buildOptions: sampleBuildOptions({
            discovery: { useGitignore: true, gitignoreRoot },
          }),
        }),
      ).rejects.toThrow(/different configuration/);
    } finally {
      await fsp.rm(gitignoreRoot, { recursive: true, force: true });
    }
  });

  test("should manage multiple sessions", async () => {
    const session1 = await manager.getOrCreateSession("session-1", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    const session2 = await manager.getOrCreateSession("session-2", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    expect(session1).not.toBe(session2);

    const ids = manager.getSessionIds();
    expect(ids).toContain("session-1");
    expect(ids).toContain("session-2");
    expect(ids).toHaveLength(2);
  });

  test("should dispose of individual sessions", async () => {
    await manager.getOrCreateSession("session-1", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    await manager.getOrCreateSession("session-2", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    manager.disposeSession("session-1");

    expect(manager.getSession("session-1")).toBeUndefined();
    expect(manager.getSession("session-2")).toBeDefined();
  });

  test("should dispose of all sessions", async () => {
    await manager.getOrCreateSession("session-1", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    await manager.getOrCreateSession("session-2", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    manager.disposeAll();

    expect(manager.getSessionIds()).toHaveLength(0);
  });

  test("should cleanup expired sessions", async () => {
    await manager.getOrCreateSession("session-1", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
      timeout: 100, // 100ms timeout
    });

    await manager.getOrCreateSession("session-2", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
      timeout: 10000, // 10s timeout
    });

    // Wait for session-1 to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    manager.cleanupExpired();

    expect(manager.getSession("session-1")).toBeUndefined();
    expect(manager.getSession("session-2")).toBeDefined();
  });

  test("should get statistics for all sessions", async () => {
    await manager.getOrCreateSession("session-1", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    await manager.getOrCreateSession("session-2", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    const allStats = manager.getAllStats();

    expect(allStats["session-1"]).toBeDefined();
    expect(allStats["session-1"].status).toBe("ready");

    expect(allStats["session-2"]).toBeDefined();
    expect(allStats["session-2"].status).toBe("ready");
  });

  test("should not retain failed warmup sessions", async () => {
    const goodRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-warmup-good-"));
    const badRoot = path.join(os.tmpdir(), `dg-session-warmup-missing-${Date.now()}`);

    try {
      await fsp.writeFile(path.join(goodRoot, "index.ts"), "export const value = 1;\n", "utf8");

      await expect(
        manager.warmup([
          {
            id: "good",
            options: { root: goodRoot, buildOptions: { cache: "memory" } },
          },
          {
            id: "bad",
            options: { root: badRoot, buildOptions: { cache: "memory" } },
          },
        ]),
      ).rejects.toThrow();

      expect(manager.getSession("good")).toBeUndefined();
      expect(manager.getSession("bad")).toBeUndefined();
      expect(manager.getSessionIds()).toEqual([]);
    } finally {
      try {
        await fsp.rm(goodRoot, { recursive: true, force: true });
      } catch {
        // Windows can transiently hold temp directories briefly after failed init.
      }
    }
  });

  test("should not repopulate sessions when warmup is disposed mid-initialization", async () => {
    const originalBuild = indexerBuild.buildProjectIndexIncremental;
    let releaseBuild: (() => void) | null = null;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (...args) => {
      await buildGate;
      return await originalBuild(...args);
    });

    try {
      const warmupPromise = manager.warmup([
        {
          id: "warm",
          options: {
            root: sampleRoot,
            buildOptions: sampleBuildOptions(),
          },
        },
      ]);

      await Promise.resolve();
      manager.disposeAll();
      releaseBuild?.();

      await expect(warmupPromise).rejects.toThrow(/disposed during initialization/);
      expect(manager.getSession("warm")).toBeUndefined();
      expect(manager.getSessionIds()).toEqual([]);
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("should share warmup work with concurrent getOrCreateSession", async () => {
    const originalBuild = indexerBuild.buildProjectIndexIncremental;
    let releaseBuild: (() => void) | null = null;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (...args) => {
      await buildGate;
      return await originalBuild(...args);
    });

    try {
      const warmupPromise = manager.warmup([
        {
          id: "shared",
          options: {
            root: sampleRoot,
            buildOptions: sampleBuildOptions(),
          },
        },
      ]);
      const sessionPromise = manager.getOrCreateSession("shared", {
        root: sampleRoot,
        buildOptions: sampleBuildOptions(),
      });

      await Promise.resolve();
      releaseBuild?.();

      const [, session] = await Promise.all([warmupPromise, sessionPromise]);
      expect(session).toBe(manager.getSession("shared"));
      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(manager.getSessionIds()).toEqual(["shared"]);
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("should warm multiple independent sessions in parallel", async () => {
    const originalBuild = indexerBuild.buildProjectIndexIncremental;
    let releaseBuild: (() => void) | null = null;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    let buildStarts = 0;
    let markAllBuildsStarted: (() => void) | null = null;
    const allBuildsStarted = new Promise<void>((resolve) => {
      markAllBuildsStarted = resolve;
    });
    const buildSpy = vi.spyOn(indexerBuild, "buildProjectIndexIncremental").mockImplementation(async (...args) => {
      buildStarts += 1;
      if (buildStarts === 2) {
        markAllBuildsStarted?.();
      }
      await buildGate;
      return await originalBuild(...args);
    });

    try {
      const rootA = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-parallel-a-"));
      const rootB = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-parallel-b-"));
      await fsp.writeFile(path.join(rootA, "a.ts"), "export const a = 1;\n", "utf8");
      await fsp.writeFile(path.join(rootB, "b.ts"), "export const b = 1;\n", "utf8");

      try {
        const warmupPromise = manager.warmup([
          {
            id: "parallel-a",
            options: { root: rootA, buildOptions: { cache: "memory" } },
          },
          {
            id: "parallel-b",
            options: { root: rootB, buildOptions: { cache: "memory" } },
          },
        ]);

        await allBuildsStarted;

        expect(buildSpy).toHaveBeenCalledTimes(2);

        releaseBuild?.();
        await warmupPromise;

        expect(manager.getSession("parallel-a")?.getStatus()).toBe("ready");
        expect(manager.getSession("parallel-b")?.getStatus()).toBe("ready");
      } finally {
        await fsp.rm(rootA, { recursive: true, force: true });
        await fsp.rm(rootB, { recursive: true, force: true });
      }
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("should reject warmup collisions with existing sessions", async () => {
    const rootA = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-warm-a-"));
    const rootB = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-session-warm-b-"));

    try {
      await fsp.writeFile(path.join(rootA, "a.ts"), "export const a = 1;\n", "utf8");
      await fsp.writeFile(path.join(rootB, "b.ts"), "export const b = 1;\n", "utf8");

      const existing = await manager.getOrCreateSession("shared", {
        root: rootA,
        buildOptions: { cache: "memory" },
      });

      await expect(
        manager.warmup([
          {
            id: "shared",
            options: { root: rootB, buildOptions: { cache: "memory" } },
          },
        ]),
      ).rejects.toThrow(/different configuration/);

      expect(manager.getSession("shared")).toBe(existing);
      expect(manager.getSession("shared")?.getRoot()).toBe(rootA);
    } finally {
      await fsp.rm(rootA, { recursive: true, force: true });
      await fsp.rm(rootB, { recursive: true, force: true });
    }
  });

  test("should keep matching warmup sessions instead of replacing them", async () => {
    const existing = await manager.getOrCreateSession("shared", {
      root: sampleRoot,
      buildOptions: sampleBuildOptions(),
    });

    await manager.warmup([
      {
        id: "shared",
        options: {
          root: sampleRoot,
          buildOptions: sampleBuildOptions(),
        },
      },
    ]);

    expect(manager.getSession("shared")).toBe(existing);
  });
});
