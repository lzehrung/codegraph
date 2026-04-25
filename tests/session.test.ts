import { describe, test, expect, beforeEach, vi } from "vitest";
import type { ICodeReviewSession } from "../src/index.js";
import {
  CodeReviewSession,
  SessionManager,
  createCodeReviewSession,
} from "../src/session.js";
import * as indexer from "../src/indexer.js";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";

const sampleRoot = path.resolve("tests/samples/typescript");

describe("CodeReviewSession", () => {
  test("should initialize successfully", async () => {
    const session = new CodeReviewSession({
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    expect(session.getStatus()).toBe("initializing");

    await session.init();

    expect(session.getStatus()).toBe("ready");
    expect(session.isReady()).toBe(true);
  });

  test("should provide session statistics", async () => {
    const session = await createCodeReviewSession({
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    const stats = session.getStats();

    expect(stats.status).toBe("ready");
    expect(stats.fileCount).toBeGreaterThan(0);
    expect(stats.symbolCount).toBeGreaterThan(0);
    expect(stats.lastActivity).toBeInstanceOf(Date);
    expect(stats.timeUntilExpiration).toBeGreaterThan(0);
  });

  test("should expose analyzeImpactStream on the session interface", async () => {
    const session = await createCodeReviewSession({
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    const typedSession = ((value: ICodeReviewSession) => value)(session);

    expect(typedSession.isReady()).toBe(true);
    expect(typedSession.analyzeImpactStream).toBeTypeOf("function");
  });

  test("should find references using cached index", async () => {
    const session = await createCodeReviewSession({
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    const file = path.resolve(sampleRoot, "src/index.ts");

    const result = await session.findReferences({
      file,
      line: 1,
      column: 10,
    });

    expect(result).toBeDefined();
  });

  test("should refresh the index", async () => {
    const session = await createCodeReviewSession({
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    expect(session.isReady()).toBe(true);

    await session.refresh();

    expect(session.isReady()).toBe(true);
  });

  test("should preserve the last ready index when refresh fails", async () => {
    const session = await createCodeReviewSession({
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    const buildSpy = vi
      .spyOn(indexer, "buildProjectIndexIncremental")
      .mockRejectedValue(new Error("synthetic refresh failure"));

    try {
      await expect(session.refresh()).rejects.toThrow("synthetic refresh failure");
      expect(session.getStatus()).toBe("ready");
      expect(session.isReady()).toBe(true);

      const file = path.resolve(sampleRoot, "src/index.ts");
      await expect(
        session.findReferences({ file, line: 1, column: 10 }),
      ).resolves.toBeDefined();
    } finally {
      buildSpy.mockRestore();
    }
  });

  test("should expire after timeout", async () => {
    const session = new CodeReviewSession({
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
      timeout: 100, // 100ms timeout for testing
    });

    await session.init();
    expect(session.isReady()).toBe(true);

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(session.getStatus()).toBe("expired");
    expect(session.isReady()).toBe(false);
  });

  test("should re-initialize after expiration", async () => {
    const session = new CodeReviewSession({
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
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
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    expect(session.isReady()).toBe(true);

    session.dispose();

    expect(session.getStatus()).toBe("expired");
    expect(session.isReady()).toBe(false);
  });

  test("should throw error when used after expiration", async () => {
    const session = await createCodeReviewSession({
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
      timeout: 100,
    });

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 150));

    const file = path.resolve(sampleRoot, "src/index.ts");

    await expect(
      session.findReferences({ file, line: 1, column: 10 }),
    ).rejects.toThrow();
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
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    expect(session).toBeDefined();
    expect(session.isReady()).toBe(true);

    const retrieved = manager.getSession("test-session");
    expect(retrieved).toBe(session);
  });

  test("should reuse existing ready sessions", async () => {
    const session1 = await manager.getOrCreateSession("test-session", {
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    const session2 = await manager.getOrCreateSession("test-session", {
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    expect(session1).toBe(session2);
  });

  test("should share one initialization across concurrent same-id creation", async () => {
    const buildSpy = vi.spyOn(indexer, "buildProjectIndexIncremental");

    try {
      const [sessionA, sessionB] = await Promise.all([
        manager.getOrCreateSession("shared", {
          root: sampleRoot,
          buildOptions: { cache: "memory", useBloomFilters: true },
        }),
        manager.getOrCreateSession("shared", {
          root: sampleRoot,
          buildOptions: { cache: "memory", useBloomFilters: true },
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
    const originalBuild = indexer.buildProjectIndexIncremental;
    let releaseBuild: (() => void) | null = null;
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const buildSpy = vi
      .spyOn(indexer, "buildProjectIndexIncremental")
      .mockImplementation(async (...args) => {
        await buildGate;
        return await originalBuild(...args);
      });

    try {
      const pendingSession = manager.getOrCreateSession("pending", {
        root: sampleRoot,
        buildOptions: { cache: "memory", useBloomFilters: true },
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
      buildOptions: { cache: "memory", useBloomFilters: true },
      timeout: 100,
    });

    expect(session.getStatus()).toBe("ready");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(session.getStatus()).toBe("expired");

    const buildSpy = vi
      .spyOn(indexer, "buildProjectIndexIncremental")
      .mockRejectedValue(new Error("synthetic reinit failure"));

    try {
      await expect(
        manager.getOrCreateSession("expiring", {
          root: sampleRoot,
          buildOptions: { cache: "memory", useBloomFilters: true },
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
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    await expect(
      manager.getOrCreateSession("shared", {
        root: sampleRoot,
        buildOptions: { cache: "disk", useBloomFilters: true },
      }),
    ).rejects.toThrow(/different configuration/);
  });

  test("should reject reusing a session id when graph options drift", async () => {
    await manager.getOrCreateSession("shared", {
      root: sampleRoot,
      buildOptions: {
        cache: "memory",
        graph: { fast: true, logLevel: "warn" },
      },
    });

    await expect(
      manager.getOrCreateSession("shared", {
        root: sampleRoot,
        buildOptions: {
          cache: "memory",
          graph: { fast: true, logLevel: "debug" },
        },
      }),
    ).rejects.toThrow(/different configuration/);
  });

  test("should reject reusing a session id when discovery options drift", async () => {
    const gitignoreRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), "dg-session-gitignore-root-"),
    );

    try {
      await manager.getOrCreateSession("shared", {
        root: sampleRoot,
        buildOptions: {
          cache: "memory",
          discovery: { useGitignore: true, gitignoreRoot: sampleRoot },
        },
      });

      await expect(
        manager.getOrCreateSession("shared", {
          root: sampleRoot,
          buildOptions: {
            cache: "memory",
            discovery: { useGitignore: true, gitignoreRoot },
          },
        }),
      ).rejects.toThrow(/different configuration/);
    } finally {
      await fsp.rm(gitignoreRoot, { recursive: true, force: true });
    }
  });

  test("should manage multiple sessions", async () => {
    const session1 = await manager.getOrCreateSession("session-1", {
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    const session2 = await manager.getOrCreateSession("session-2", {
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
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
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    await manager.getOrCreateSession("session-2", {
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    manager.disposeSession("session-1");

    expect(manager.getSession("session-1")).toBeUndefined();
    expect(manager.getSession("session-2")).toBeDefined();
  });

  test("should dispose of all sessions", async () => {
    await manager.getOrCreateSession("session-1", {
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    await manager.getOrCreateSession("session-2", {
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    manager.disposeAll();

    expect(manager.getSessionIds()).toHaveLength(0);
  });

  test("should cleanup expired sessions", async () => {
    await manager.getOrCreateSession("session-1", {
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
      timeout: 100, // 100ms timeout
    });

    await manager.getOrCreateSession("session-2", {
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
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
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    await manager.getOrCreateSession("session-2", {
      root: sampleRoot,
      buildOptions: { cache: "memory", useBloomFilters: true },
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
      await fsp.writeFile(
        path.join(goodRoot, "index.ts"),
        "export const value = 1;\n",
        "utf8",
      );

      await expect(
        manager.warmup([
          { id: "good", options: { root: goodRoot, buildOptions: { cache: "memory" } } },
          { id: "bad", options: { root: badRoot, buildOptions: { cache: "memory" } } },
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
          { id: "shared", options: { root: rootB, buildOptions: { cache: "memory" } } },
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
      buildOptions: { cache: "memory", useBloomFilters: true },
    });

    await manager.warmup([
      {
        id: "shared",
        options: {
          root: sampleRoot,
          buildOptions: { cache: "memory", useBloomFilters: true },
        },
      },
    ]);

    expect(manager.getSession("shared")).toBe(existing);
  });
});
