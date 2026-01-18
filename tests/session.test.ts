import { describe, test, expect, beforeEach } from "vitest";
import {
  CodeReviewSession,
  SessionManager,
  createCodeReviewSession,
} from "../src/session.js";
import path from "node:path";

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
});
