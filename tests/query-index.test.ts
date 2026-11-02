import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchCodegraphWithSession, type AgentSearchResponse } from "../src/agent/search.js";
import { summarizeAnalysis } from "../src/analysis-summary.js";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "../src/agent/session.js";
import { disposeSessionQueryIndex, ensureSessionQueryIndex } from "../src/agent/query-index/session-store.js";
import * as updateModule from "../src/agent/query-index/update.js";
import { resolveQueryIndexPaths, resolveQueryIndexSourcePath } from "../src/agent/query-index/paths.js";
import { expectedQueryIndexVersionMetadata, probeQueryIndexSqliteSupport } from "../src/agent/query-index/schema.js";
import { SqliteDatabase, SqliteStatement, type SqliteRawRow } from "../src/sqlite-driver.js";
import { ensureQueryIndex } from "../src/agent/query-index/update.js";
import {
  QueryIndexStore,
  QUERY_INDEX_CANDIDATE_ROW_LIMIT,
  QUERY_INDEX_PATH_BATCH_SIZE,
} from "../src/agent/query-index/store.js";
import * as queryIndexWorkerPool from "../src/agent/query-index/worker-pool.js";
import { buildProjectIndexIncremental } from "../src/indexer/build-index.js";
import { isSymlinkUnavailable } from "./helpers/filesystem.js";
import { resetFileIdentityCaseSensitivityForTests } from "../src/util/paths.js";
import { createCodegraphMcpHandlers } from "../src/mcp/server.js";
import { captureCli } from "./helpers/cli.js";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import * as zlib from "node:zlib";

vi.mock("node:zlib", { spy: true });
import type { PreparedQueryIndexFile } from "../src/agent/query-index/content.js";
import { findQueryIndexChunkCandidates } from "../src/agent/query-index/candidates.js";

const roots: string[] = [];
const sessions: AgentSession[] = [];

async function createRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cg-query-index-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "docs"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "auth.ts"),
    [
      "export function validateUser(token: string) {",
      "  return token.length > 2;",
      "}",
      "",
      "export const sessionMarker = 'alpha session';",
      "",
    ].join("\n"),
  );
  await fs.writeFile(path.join(root, "src", "other.ts"), "export const betaMarker = 'beta only';\n");
  await fs.writeFile(
    path.join(root, "docs", "guide.md"),
    "# Security guide\n\nValidate user sessions before issuing credentials.\n",
  );
  await fs.writeFile(path.join(root, "package.json"), '{"name":"query-index-fixture"}\n');
  return root;
}

function createSession(root: string, cache: "disk" | "off" = "disk"): AgentSession {
  const session = createAgentSession({ root, buildOptions: { cache } });
  sessions.push(session);
  return session;
}

async function search(session: AgentSession, root: string, query: string, mode: "text" | "hybrid" = "text") {
  return await searchCodegraphWithSession(session, {
    root,
    query,
    mode,
    limit: 50,
  });
}

function comparable(response: AgentSearchResponse): object {
  return {
    resultCount: response.resultCount,
    totalCandidates: response.totalCandidates,
    omittedCounts: response.omittedCounts,
    results: response.results,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) session.invalidate();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("persistent query index", () => {
  it("supports FTS5 trigram on the supported Node runtime", () => {
    expect(probeQueryIndexSqliteSupport()).toEqual({ enableFts5: true, trigram: true });
  });

  it("reopens an exact sidecar without source reads and preserves full-scan ranking", async () => {
    const root = await createRepo();
    const initialSession = createSession(root);
    const initial = await search(initialSession, root, "validateUser");
    const initialSnapshot = await initialSession.loadProject();
    expect(
      initialSnapshot.buildReport?.queryIndex,
      JSON.stringify(initialSnapshot.buildReport?.queryIndex),
    ).toMatchObject({
      sidecarState: "created",
      filesRead: 4,
      filesAdded: 4,
    });

    const sidecar = resolveQueryIndexPaths(initialSnapshot.index.cacheRootDir!).sidecar;
    expect((await fs.stat(sidecar)).isFile()).toBe(true);
    disposeSessionQueryIndex(initialSession);

    const warmSession = createSession(root);
    const warm = await search(warmSession, root, "validateUser");
    const warmSnapshot = await warmSession.loadProject();
    expect(warmSnapshot.buildReport?.queryIndex).toMatchObject({ sidecarState: "hit", filesRead: 0 });
    expect(comparable(warm)).toEqual(comparable(initial));

    const oracleSession = createSession(root, "off");
    const cases = [
      { query: "validateUser", mode: "text" as const },
      { query: "va", mode: "text" as const },
      { query: "validateuser", mode: "text" as const },
      { query: "alpha validateuser", mode: "text" as const },
      { query: "security guide", mode: "hybrid" as const },
      { query: "how does the guide validate user sessions", mode: "hybrid" as const },
      { query: 'validate" OR token', mode: "text" as const },
      { query: "---", mode: "hybrid" as const },
    ];
    for (const testCase of cases) {
      const indexed = await search(warmSession, root, testCase.query, testCase.mode);
      const oracle = await search(oracleSession, root, testCase.query, testCase.mode);
      expect(comparable(indexed)).toEqual(comparable(oracle));
    }
    const directQuery = await search(warmSession, root, "guide validate user sessions", "hybrid");
    const naturalLanguageQuery = await search(warmSession, root, "how does the guide validate user sessions", "hybrid");
    expect(comparable(naturalLanguageQuery)).toEqual(comparable(directQuery));
    const exactSymbol = await search(warmSession, root, "validateUser");
    const authEvidence = exactSymbol.results
      .find((result) => result.file === "src/auth.ts")
      ?.evidence.find((evidence) => evidence.file === "src/auth.ts");
    expect(authEvidence?.line).toBe(1);
  });
  it("uses fresh Unicode sidecars and rebuilds obsolete normalizers", async () => {
    const root = await createRepo();
    await fs.writeFile(path.join(root, "src", "日本.ts"), "export const 日本 = 'café';\n", "utf8");
    const readSnapshot = vi.spyOn(QueryIndexStore.prototype, "withReadSnapshot");
    const initialSession = createSession(root);
    const initial = await search(initialSession, root, "日本");
    const initialSnapshot = await initialSession.loadProject();
    const sidecar = resolveQueryIndexPaths(initialSnapshot.index.cacheRootDir!).sidecar;

    expect(initial.results.some((result) => result.file === "src/日本.ts")).toBe(true);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    disposeSessionQueryIndex(initialSession);

    const database = new SqliteDatabase(sidecar);
    database.prepare("UPDATE metadata SET value = ? WHERE key = ?").run("query-normalizer-v0", "normalizerVersion");
    database.close();

    const rebuiltSession = createSession(root);
    const response = await search(rebuiltSession, root, "日本");
    const rebuiltSnapshot = await rebuiltSession.loadProject();

    expect(response.results.some((result) => result.file === "src/日本.ts")).toBe(true);
    expect(rebuiltSnapshot.buildReport?.queryIndex).toMatchObject({
      sidecarState: "rebuilt",
      updateMs: expect.any(Number),
    });
    expect(rebuiltSnapshot.buildReport?.queryIndex?.updateMs).toBeGreaterThan(0);
  });

  it("reports both candidate files and candidate chunks for sidecar searches", async () => {
    const root = await createRepo();
    const session = createSession(root);

    await search(session, root, "validateUser");
    const diagnostics = (await session.loadProject()).buildReport?.queryIndex;

    expect(diagnostics?.fileCandidates).toBe(2);
    expect(diagnostics?.chunkCandidates).toBeGreaterThan(0);
  });

  it("keeps compressed indexed text below the amplification target", async () => {
    const root = await createRepo();
    const source = Array.from(
      { length: 200 },
      (_, index) => `export function marker${index}(value: string) { return value + '${index}'; }`,
    ).join("\n");
    await fs.writeFile(path.join(root, "src", "auth.ts"), `${source}\n`);
    const session = createSession(root);
    await search(session, root, "marker199");
    const snapshot = await session.loadProject();
    const sidecar = resolveQueryIndexPaths(snapshot.index.cacheRootDir!).sidecar;
    disposeSessionQueryIndex(session);

    const database = new SqliteDatabase(sidecar, { readonly: true });
    const sourceRow = database.prepare("SELECT sum(byte_length) AS bytes FROM files").get() as
      | { bytes?: unknown }
      | undefined;
    const storedRow = database
      .prepare(
        `
        SELECT
          (SELECT sum(length(normalized_text)) FROM files) +
          (SELECT sum(length(text) + length(normalized_text)) FROM chunks) AS bytes
      `,
      )
      .get() as { bytes?: unknown } | undefined;
    database.close();
    expect(typeof sourceRow?.bytes, JSON.stringify(sourceRow)).toBe("number");
    expect(typeof storedRow?.bytes, JSON.stringify(storedRow)).toBe("number");
    const sourceBytes = typeof sourceRow?.bytes === "number" ? sourceRow.bytes : 0;
    const storedBytes = typeof storedRow?.bytes === "number" ? storedRow.bytes : Number.POSITIVE_INFINITY;
    expect(storedBytes / sourceBytes).toBeLessThanOrEqual(2.5);
  });

  it("creates new sidecars with incremental auto-vacuum enabled", async () => {
    const root = await createRepo();
    const session = createSession(root);
    await search(session, root, "validateUser");
    const snapshot = await session.loadProject();
    const sidecar = resolveQueryIndexPaths(snapshot.index.cacheRootDir!).sidecar;
    disposeSessionQueryIndex(session);

    const database = new SqliteDatabase(sidecar, { readonly: true });
    const autoVacuum = database.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | undefined;
    database.close();
    expect(autoVacuum?.auto_vacuum).toBe(2);
  });

  it("applies WAL, NORMAL synchronous, and foreign_keys on the store connection", async () => {
    const root = await createRepo();
    const session = createSession(root);
    const snapshot = await session.loadProject();
    const sidecar = resolveQueryIndexPaths(snapshot.index.cacheRootDir!).sidecar;
    disposeSessionQueryIndex(session);

    const store = new QueryIndexStore(sidecar);
    try {
      expect(store.runtimePragmas()).toEqual({
        journalMode: "wal",
        synchronous: 1,
        foreignKeys: 1,
      });
    } finally {
      store.close();
    }
  });

  it("upgrades an older sidecar without incremental auto-vacuum and reclaims free space", async () => {
    const root = await createRepo();
    const source = Array.from(
      { length: 400 },
      (_, index) => `export function marker${index}(value: string) { return value + '${index}'.repeat(20); }`,
    ).join("\n");
    await fs.writeFile(path.join(root, "src", "auth.ts"), `${source}\n`);
    const session = createSession(root);
    await search(session, root, "marker399");
    const snapshot = await session.loadProject();
    const sidecar = resolveQueryIndexPaths(snapshot.index.cacheRootDir!).sidecar;
    disposeSessionQueryIndex(session);

    // Simulate a sidecar created before incremental auto-vacuum existed, bloated by the
    // delete/rewrite churn years of edits would leave behind.
    const setup = new SqliteDatabase(sidecar);
    setup.pragma("auto_vacuum = NONE");
    setup.exec("VACUUM;");
    setup.exec("DELETE FROM chunks;");
    const beforeAutoVacuum = setup.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | undefined;
    const beforeFreelist = setup.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
    const beforePages = setup.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined;
    setup.close();
    expect(beforeAutoVacuum?.auto_vacuum).toBe(0);
    const beforeRatio = (beforeFreelist?.freelist_count ?? 0) / (beforePages?.page_count ?? 1);
    expect(beforeRatio, JSON.stringify({ beforeFreelist, beforePages })).toBeGreaterThan(0.15);

    // Any subsequent write should detect the stale mode, switch to incremental auto-vacuum,
    // and reclaim the accumulated free space via a one-time VACUUM.
    await fs.writeFile(path.join(root, "src", "other.ts"), "export const betaMarker = 'beta only, updated';\n");
    const nextSession = createSession(root);
    await search(nextSession, root, "beta only, updated");
    disposeSessionQueryIndex(nextSession);

    const after = new SqliteDatabase(sidecar, { readonly: true });
    const afterAutoVacuum = after.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | undefined;
    const afterFreelist = after.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined;
    const afterPages = after.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined;
    after.close();
    expect(afterAutoVacuum?.auto_vacuum).toBe(2);
    expect((afterFreelist?.freelist_count ?? 0) / (afterPages?.page_count ?? 1)).toBeLessThan(0.15);
  });

  it("keeps CLI, library, and MCP result ordering identical", async () => {
    const root = await createRepo();
    const librarySession = createSession(root);
    const library = await search(librarySession, root, "security guide", "hybrid");

    const cli = await captureCli([
      "search",
      "security guide",
      "--root",
      root,
      "--mode",
      "hybrid",
      "--limit",
      "50",
      "--cache",
      "disk",
      "--json",
    ]);
    expect(cli.exitCode).toBeUndefined();
    const cliResponse = JSON.parse(cli.stdout) as AgentSearchResponse;

    const mcpSession = createSession(root);
    const handlers = createCodegraphMcpHandlers({
      root,
      session: mcpSession,
    });
    const mcp = await handlers.search({ query: "security guide", mode: "hybrid", limit: 50 });

    expect(comparable(cliResponse)).toEqual(comparable(library));
    expect(comparable(mcp)).toEqual(comparable(library));
  });

  it("refreshes the MCP session and sidecar before returning changed text", async () => {
    const root = await createRepo();
    const session = createAgentSession({
      root,
      buildOptions: { cache: "disk" },
      freshness: { policy: "auto" },
    });
    sessions.push(session);
    const handlers = createCodegraphMcpHandlers({ root, session });
    const initial = await handlers.search({ query: "alpha session", mode: "text", limit: 50 });
    expect(initial.results.some((result) => result.file === "src/auth.ts")).toBe(true);

    await fs.writeFile(path.join(root, "src", "auth.ts"), "export const refreshedMarker = 'fresh mixed snapshot';\n");
    const refreshed = await handlers.search({ query: "fresh mixed snapshot", mode: "text", limit: 50 });
    expect(refreshed.freshness.state).toBe("refreshed");
    expect(refreshed.results.some((result) => result.file === "src/auth.ts")).toBe(true);
    const snapshot = await session.loadProject();
    expect(snapshot.buildReport?.queryIndex, JSON.stringify(snapshot.buildReport?.queryIndex)).toMatchObject({
      sidecarState: "updated",
      filesUpdated: 1,
    });
  });

  it("returns the same text results when only the best indexed candidates are built as when every candidate is", async () => {
    const root = await createRepo();
    // Many chunks match `alpha session`: an exact phrase, the words apart, one word alone, in code and in docs. Code
    // labels sort before docs labels, so only the docs boost puts an exact-phrase docs chunk ahead of a code chunk
    // that scores the same without it.
    const phrases = ["alpha session", "alpha token session", "alpha only"];
    await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const phrase = phrases[index % phrases.length]!;
        await fs.writeFile(
          path.join(root, "src", `mod${index}.ts`),
          `export const aMarker${index} = '${phrase} ${index}';\nexport function aRun${index}() {\n  return '${phrase}';\n}\n`,
        );
        await fs.writeFile(
          path.join(root, "docs", `note${index}.md`),
          `# Notes ${index}\n\nThe ${phrase} is described here.\n`,
        );
      }),
    );

    for (const mode of ["text", "hybrid"] as const) {
      for (const limit of [1, 3, 7]) {
        const everyCandidate = await searchCodegraphWithSession(createSession(root), {
          root,
          query: "alpha session",
          mode,
          limit: 100,
        });
        const best = await searchCodegraphWithSession(createSession(root), {
          root,
          query: "alpha session",
          mode,
          limit,
        });
        const label = `${mode} limit ${limit}`;
        expect(everyCandidate.totalCandidates, label).toBeGreaterThan(limit);
        expect(best.results, label).toEqual(everyCandidate.results.slice(0, limit));
        expect(best.totalCandidates, label).toBe(everyCandidate.totalCandidates);
        expect(best.omittedCounts.results, label).toBe(everyCandidate.totalCandidates - limit);
        expect(best.candidateCounts, label).toEqual(everyCandidate.candidateCounts);
      }
    }
  });

  it("updates only added and modified files while removing deleted rows", async () => {
    const root = await createRepo();
    const initialSession = createSession(root);
    const initialResponse = await search(initialSession, root, "marker");
    expect(await search(initialSession, root, "marker")).toBe(initialResponse);

    await fs.writeFile(path.join(root, "src", "auth.ts"), "export const changedMarker = 'changed token value';\n");
    await fs.writeFile(path.join(root, "src", "added.ts"), "export const addedMarker = 'added token value';\n");
    await fs.rm(path.join(root, "src", "other.ts"));
    initialSession.invalidate();

    const changed = await search(initialSession, root, "token value");
    const snapshot = await initialSession.loadProject();
    expect(snapshot.buildReport?.queryIndex, JSON.stringify(snapshot.buildReport?.queryIndex)).toMatchObject({
      sidecarState: "updated",
      filesRead: 2,
      filesAdded: 1,
      filesUpdated: 1,
      filesDeleted: 1,
    });
    expect(changed.results.map((result) => result.file)).toEqual(
      expect.arrayContaining(["src/added.ts", "src/auth.ts"]),
    );
    expect(changed.results.some((result) => result.file === "src/other.ts")).toBe(false);
  });

  it("tracks explicit files outside normal discovery by manifest identity", async () => {
    const root = await createRepo();
    const transient = path.join(root, "vendor", "generated.ts");
    await fs.mkdir(path.dirname(transient), { recursive: true });
    await fs.writeFile(transient, "export const transientValue = 'transient indexed phrase';\n");

    const loadSnapshot = async (): Promise<AgentProjectSnapshot> => {
      const index = await buildProjectIndexIncremental(root, {
        files: [transient],
        cache: "disk",
      });
      expect(index.manifestEntries?.has(transient.replace(/\\/g, "/"))).toBe(true);
      const files = [...index.manifestEntries!.keys()];
      return {
        root,
        files,
        index,
        fileGraph: index.graph,
        symbolGraph: { nodes: new Map(), edges: [] },
        analysis: summarizeAnalysis({ index, report: index.buildReport }),
        ...(index.buildReport ? { buildReport: index.buildReport } : {}),
      };
    };

    const created = await ensureQueryIndex(await loadSnapshot());
    expect(created.diagnostics).toMatchObject({ sidecarState: "created", filesRead: 5, filesAdded: 5 });
    created.store?.close();

    await fs.writeFile(transient, "export const transientValue = 'transient changed phrase with a new size';\n");
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => ++clock);
    const updated = await ensureQueryIndex(await loadSnapshot());
    expect(updated.diagnostics).toMatchObject({ sidecarState: "updated", filesRead: 1, filesUpdated: 1 });
    expect(updated.diagnostics.updateMs).toBeGreaterThan(0);
    updated.store?.close();
  });

  it("matches equivalent manifest entries with case-insensitive file identity", async () => {
    const root = await createRepo();
    const session = createSession(root);
    resetFileIdentityCaseSensitivityForTests(true);
    try {
      const snapshot = await session.loadProject();
      const sourceFile = snapshot.files.find((file) => file.endsWith("src/auth.ts"));
      if (!sourceFile) throw new Error("Expected auth source file in session snapshot.");
      const entry = snapshot.index.manifestEntries?.get(sourceFile);
      if (!entry) throw new Error("Expected auth manifest entry in session snapshot.");
      const manifestEntries = new Map(snapshot.index.manifestEntries);
      manifestEntries.delete(sourceFile);
      manifestEntries.set(sourceFile.toUpperCase(), entry);

      const handle = await ensureQueryIndex({
        ...snapshot,
        index: { ...snapshot.index, manifestEntries },
      });

      expect(handle.diagnostics).toMatchObject({
        sidecarState: "created",
        filesAdded: snapshot.files.length,
      });
      handle.store?.close();
    } finally {
      resetFileIdentityCaseSensitivityForTests();
    }
  });

  it("refuses to create a query index from incomplete manifest entries", async () => {
    const root = await createRepo();
    const session = createSession(root);
    const snapshot = await session.loadProject();
    const omittedFile = snapshot.files[0];
    if (!omittedFile) throw new Error("Expected a file in the session snapshot.");
    const manifestEntries = new Map(snapshot.index.manifestEntries);
    manifestEntries.delete(omittedFile);

    const handle = await ensureQueryIndex({
      ...snapshot,
      index: { ...snapshot.index, manifestEntries },
    });

    expect(handle.store).toBeNull();
    expect(handle.diagnostics.sidecarState).toBe("unavailable");
  });

  it("removes only expired abandoned rebuild files", async () => {
    const root = await createRepo();
    const initialSession = createSession(root);
    await search(initialSession, root, "validate user");
    const initialSnapshot = await initialSession.loadProject();
    const cacheRoot = resolveQueryIndexPaths(initialSnapshot.index.cacheRootDir!).cacheRoot;
    disposeSessionQueryIndex(initialSession);
    const oldTemporary = path.join(cacheRoot, "search-v1.v1.tmp-1-00000000-0000-0000-0000-000000000001.sqlite");
    const recentTemporary = path.join(cacheRoot, "search-v1.v1.tmp-1-00000000-0000-0000-0000-000000000002.sqlite");
    await fs.writeFile(oldTemporary, "old");
    await fs.writeFile(recentTemporary, "recent");
    const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldTemporary, oldTime, oldTime);

    const warmSession = createSession(root);
    await search(warmSession, root, "validate user");
    await expect(fs.stat(oldTemporary)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(recentTemporary)).isFile()).toBe(true);
  });

  it("removes the sqlite companions of an expired abandoned rebuild file only", async () => {
    const root = await createRepo();
    const initialSession = createSession(root);
    await search(initialSession, root, "validate user");
    const initialSnapshot = await initialSession.loadProject();
    const cacheRoot = resolveQueryIndexPaths(initialSnapshot.index.cacheRootDir!).cacheRoot;
    disposeSessionQueryIndex(initialSession);
    const oldTemporary = path.join(cacheRoot, "search-v1.v1.tmp-1-00000000-0000-0000-0000-000000000001.sqlite");
    const recentTemporary = path.join(cacheRoot, "search-v1.v1.tmp-1-00000000-0000-0000-0000-000000000002.sqlite");
    for (const temporary of [oldTemporary, recentTemporary]) {
      await fs.writeFile(temporary, "temporary");
      await fs.writeFile(`${temporary}-wal`, "wal");
      await fs.writeFile(`${temporary}-shm`, "shm");
    }
    const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldTemporary, oldTime, oldTime);

    const warmSession = createSession(root);
    await search(warmSession, root, "validate user");

    for (const suffix of ["", "-wal", "-shm"]) {
      await expect(fs.stat(`${oldTemporary}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.stat(`${recentTemporary}${suffix}`)).isFile()).toBe(true);
    }
  });

  it("keeps concurrent first-search writers correct", async () => {
    const root = await createRepo();
    const leftSession = createSession(root);
    const rightSession = createSession(root);
    const [left, right] = await Promise.all([
      search(leftSession, root, "validate user"),
      search(rightSession, root, "validate user"),
    ]);
    expect(comparable(left)).toEqual(comparable(right));
    disposeSessionQueryIndex(leftSession);
    disposeSessionQueryIndex(rightSession);

    const warmSession = createSession(root);
    await search(warmSession, root, "validate user");
    const warmSnapshot = await warmSession.loadProject();
    expect(warmSnapshot.buildReport?.queryIndex).toMatchObject({ sidecarState: "hit", filesRead: 0 });
  });

  it("rebuilds corrupt sidecars and retains the corrupt database", async () => {
    const root = await createRepo();
    const initialSession = createSession(root);
    await search(initialSession, root, "validate user");
    const initialSnapshot = await initialSession.loadProject();
    const paths = resolveQueryIndexPaths(initialSnapshot.index.cacheRootDir!);
    disposeSessionQueryIndex(initialSession);
    await fs.writeFile(paths.sidecar, "not a sqlite database");

    const recoveredSession = createSession(root);
    const response = await search(recoveredSession, root, "validate user");
    const recoveredSnapshot = await recoveredSession.loadProject();
    expect(
      recoveredSnapshot.buildReport?.queryIndex?.sidecarState,
      JSON.stringify(recoveredSnapshot.buildReport?.queryIndex),
    ).toBe("rebuilt-corrupt");
    expect(response.results.some((result) => result.file === "src/auth.ts")).toBe(true);
    expect((await fs.stat(paths.corrupt)).isFile()).toBe(true);
  });

  it("falls back to memory when another process holds the writer lock", async () => {
    const root = await createRepo();
    const initialSession = createSession(root);
    await search(initialSession, root, "validate user");
    const initialSnapshot = await initialSession.loadProject();
    const sidecar = resolveQueryIndexPaths(initialSnapshot.index.cacheRootDir!).sidecar;
    disposeSessionQueryIndex(initialSession);
    await fs.writeFile(path.join(root, "src", "auth.ts"), "export const lockedMarker = 'locked fallback token';\n");

    const lock = new SqliteDatabase(sidecar);
    lock.exec("BEGIN IMMEDIATE;");
    try {
      const blockedSession = createSession(root);
      const response = await search(blockedSession, root, "locked fallback");
      const blockedSnapshot = await blockedSession.loadProject();
      expect(blockedSnapshot.buildReport?.queryIndex?.sidecarState).toBe("writer-busy");
      expect(response.results.some((result) => result.file === "src/auth.ts")).toBe(true);
    } finally {
      lock.exec("ROLLBACK;");
      lock.close();
    }
  });

  it("falls back to memory when worker preparation rejects", async () => {
    const root = await createRepo();
    vi.spyOn(queryIndexWorkerPool, "prepareQueryIndexFiles").mockRejectedValue(new Error("forced worker failure"));

    const session = createSession(root);
    const response = await search(session, root, "validate user");
    const snapshot = await session.loadProject();
    expect(snapshot.buildReport?.queryIndex).toMatchObject({
      sidecarState: "unavailable",
      fallbackReason: "forced worker failure",
    });
    expect(response.results.some((result) => result.file === "src/auth.ts")).toBe(true);
  });

  it("indexes the rest of a batch when a single file cannot be prepared", async () => {
    const root = await createRepo();

    const prepared = await queryIndexWorkerPool.prepareQueryIndexFilesInWorker(root, [
      { relativePath: "src/auth.ts", sourceIdentity: "identity-auth" },
      { relativePath: "src/vanished.ts", sourceIdentity: "identity-vanished" },
    ]);

    expect(prepared?.map((file) => file.path)).toEqual(["src/auth.ts"]);
  });

  it("reports no prepared files when every file in a batch fails", async () => {
    const root = await createRepo();

    const prepared = await queryIndexWorkerPool.prepareQueryIndexFilesInWorker(root, [
      { relativePath: "src/vanished-one.ts", sourceIdentity: "identity-one" },
      { relativePath: "src/vanished-two.ts", sourceIdentity: "identity-two" },
    ]);

    expect(prepared).toBeNull();
  });

  it("routes batches to the worker pool only once they amortize thread startup", () => {
    const { shouldPrepareQueryIndexFilesInWorker: shouldUseWorker, QUERY_INDEX_WORKER_MIN_FILES: minFiles } =
      queryIndexWorkerPool;

    // The thread count is passed explicitly so the routing contract does not depend on how many
    // CPUs the host running the suite happens to expose.
    expect(shouldUseWorker(1, 4)).toBe(false);
    expect(shouldUseWorker(minFiles - 1, 4)).toBe(false);
    expect(shouldUseWorker(minFiles, 4)).toBe(true);
    expect(shouldUseWorker(minFiles, 2)).toBe(true);

    // One worker runs the batch serially behind pool startup and a structured clone per task, so
    // it never beats preparing in-process no matter how large the batch is. Hosts reporting one
    // or two available CPUs resolve to exactly one worker.
    expect(shouldUseWorker(minFiles, 1)).toBe(false);
    expect(shouldUseWorker(minFiles * 100, 1)).toBe(false);
  });

  it("prepares an identical batch in-process and in the worker pool", async () => {
    const root = await createRepo();
    const batch = [
      { relativePath: "src/auth.ts", sourceIdentity: "identity-auth" },
      { relativePath: "src/other.ts", sourceIdentity: "identity-other" },
      { relativePath: "docs/guide.md", sourceIdentity: "identity-guide" },
      { relativePath: "src/vanished.ts", sourceIdentity: "identity-vanished" },
    ];

    // Without a compiled worker the pool degrades to the in-process path, which would make the
    // comparison below vacuous.
    const workerPath = queryIndexWorkerPool.resolveQueryIndexWorkerPath();
    expect((await fs.stat(workerPath)).isFile()).toBe(true);

    const inProcess = await queryIndexWorkerPool.prepareQueryIndexFilesInProcess(root, batch);
    const inWorker = await queryIndexWorkerPool.prepareQueryIndexFilesInWorker(root, batch);

    expect(inProcess).toEqual(inWorker);
    expect(inProcess?.map((file) => file.path)).toEqual(["src/auth.ts", "src/other.ts", "docs/guide.md"]);
  });

  it("keeps the sidecar usable and records the omission when a file is skipped", async () => {
    const root = await createRepo();
    const realPrepare = queryIndexWorkerPool.prepareQueryIndexFiles;
    vi.spyOn(queryIndexWorkerPool, "prepareQueryIndexFiles").mockImplementation(
      async (projectRoot, files) => await realPrepare(projectRoot, files.slice(1)),
    );

    const session = createSession(root);
    const response = await search(session, root, "validate user");
    const snapshot = await session.loadProject();

    expect(snapshot.buildReport?.queryIndex, JSON.stringify(snapshot.buildReport?.queryIndex)).toMatchObject({
      sidecarState: "created",
      filesSkipped: 1,
    });
    expect(response.results.some((result) => result.file === "src/auth.ts")).toBe(true);
  });

  it("discards staged sidecar scores before memory fallback", async () => {
    const root = await createRepo();
    const initialSession = createSession(root);
    await search(initialSession, root, "validate user");
    disposeSessionQueryIndex(initialSession);

    const oracleSession = createSession(root, "off");
    const oracle = await search(oracleSession, root, "validate user");
    const originalWithReadSnapshot = QueryIndexStore.prototype.withReadSnapshot;
    vi.spyOn(QueryIndexStore.prototype, "withReadSnapshot").mockImplementation(function <T>(
      this: QueryIndexStore,
      projectSnapshotIdentity: string,
      read: () => T,
    ): T {
      return originalWithReadSnapshot.call<unknown, [string, () => T], T>(this, projectSnapshotIdentity, () => {
        read();
        throw new Error("forced post-read failure");
      });
    });

    const fallbackSession = createSession(root);
    const fallback = await search(fallbackSession, root, "validate user");
    expect(comparable(fallback)).toEqual(comparable(oracle));
    expect((await fallbackSession.loadProject()).buildReport?.queryIndex).toMatchObject({
      sidecarState: "unavailable",
      fallbackReason: "forced post-read failure",
    });
  });

  it("does not mutate a sidecar created by a future schema", async () => {
    const root = await createRepo();
    const initialSession = createSession(root);
    await search(initialSession, root, "validate user");
    const initialSnapshot = await initialSession.loadProject();
    const sidecar = resolveQueryIndexPaths(initialSnapshot.index.cacheRootDir!).sidecar;
    disposeSessionQueryIndex(initialSession);

    const future = new SqliteDatabase(sidecar);
    future.pragma("user_version = 999");
    future.close();

    const fallbackSession = createSession(root);
    const response = await search(fallbackSession, root, "validate user");
    const fallbackSnapshot = await fallbackSession.loadProject();
    expect(fallbackSnapshot.buildReport?.queryIndex).toMatchObject({
      sidecarState: "unavailable",
      fallbackReason: expect.stringContaining("newer"),
    });
    expect(response.results.some((result) => result.file === "src/auth.ts")).toBe(true);

    const unchanged = new SqliteDatabase(sidecar, { readonly: true });
    const row = unchanged.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
    unchanged.close();
    expect(row?.user_version).toBe(999);
  });

  it("migrates v1 sidecars by rebuilding derived rows into the current compact schema", async () => {
    const root = await createRepo();
    const databasePath = path.join(root, "query-v1.sqlite");
    const v1 = new SqliteDatabase(databasePath);
    v1.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE files(
        file_id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        source_identity TEXT NOT NULL,
        surface TEXT NOT NULL,
        language TEXT,
        normalized_text TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        line_count INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE chunks(
        chunk_id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        name TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        UNIQUE(file_id, ordinal)
      ) STRICT;
      CREATE VIRTUAL TABLE file_search USING fts5(
        normalized_text, content='files', content_rowid='file_id', tokenize='trigram'
      );
      CREATE VIRTUAL TABLE chunk_search USING fts5(
        normalized_text, content='chunks', content_rowid='chunk_id', tokenize='trigram'
      );
      INSERT INTO files(path, source_identity, surface, language, normalized_text, byte_length, line_count)
      VALUES ('src/old.ts', 'old', 'code', 'typescript', 'old text', 8, 1);
      INSERT INTO chunks(file_id, ordinal, kind, name, start_line, end_line, text, normalized_text)
      VALUES (1, 0, 'source', NULL, 1, 1, 'old text', 'old text');
      PRAGMA user_version = 1;
    `);
    v1.close();

    const migrated = new QueryIndexStore(databasePath);
    const migratedIdentityCount = migrated.sourceIdentities().size;
    migrated.close();
    expect(migratedIdentityCount).toBe(0);

    const inspected = new SqliteDatabase(databasePath, { readonly: true });
    const version = inspected.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
    const fileColumns = inspected.prepare("PRAGMA table_info(files)").all() as Array<{
      name?: unknown;
      type?: unknown;
    }>;
    const chunkColumns = inspected.prepare("PRAGMA table_info(chunks)").all() as Array<{
      name?: unknown;
      type?: unknown;
    }>;
    inspected.close();
    expect(version?.user_version).toBe(4);
    expect(fileColumns).toContainEqual(expect.objectContaining({ name: "normalized_text", type: "BLOB" }));
    expect(chunkColumns).toContainEqual(expect.objectContaining({ name: "text", type: "BLOB" }));
  });

  it("migrates v2 sidecars by rebuilding file eligibility data", async () => {
    const root = await createRepo();
    const databasePath = path.join(root, "query-v2.sqlite");
    const v2 = new SqliteDatabase(databasePath);
    v2.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE files(
        file_id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        source_identity TEXT NOT NULL,
        surface TEXT NOT NULL,
        language TEXT,
        byte_length INTEGER NOT NULL,
        line_count INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE chunks(
        chunk_id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        name TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text BLOB NOT NULL,
        normalized_text TEXT NOT NULL,
        UNIQUE(file_id, ordinal)
      ) STRICT;
      CREATE VIRTUAL TABLE chunk_search USING fts5(
        normalized_text, content='chunks', content_rowid='chunk_id', tokenize='trigram'
      );
      PRAGMA user_version = 2;
    `);
    v2.close();

    const migrated = new QueryIndexStore(databasePath);
    migrated.close();
    const inspected = new SqliteDatabase(databasePath, { readonly: true });
    const version = inspected.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
    const fileColumns = inspected.prepare("PRAGMA table_info(files)").all() as Array<{
      name?: unknown;
      type?: unknown;
    }>;
    inspected.close();
    expect(version?.user_version).toBe(4);
    expect(fileColumns).toContainEqual(expect.objectContaining({ name: "normalized_text", type: "BLOB" }));
  });

  function compressQueryText(text: string): Uint8Array {
    return brotliCompressSync(text, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } });
  }

  function preparedFile(filePath: string, chunkTexts: readonly string[]): PreparedQueryIndexFile {
    const fullText = chunkTexts.join("\n");
    return {
      path: filePath,
      sourceIdentity: `sig-${filePath}`,
      surface: "code",
      language: "typescript",
      byteLength: Buffer.byteLength(fullText, "utf8"),
      lineCount: fullText.split("\n").length,
      normalizedText: compressQueryText(fullText.toLowerCase()),
      sourceRead: true,
      chunks: chunkTexts.map((text, ordinal) => ({
        ordinal,
        kind: "chunk",
        text: compressQueryText(text),
        normalizedText: text.toLowerCase(),
        startLine: ordinal + 1,
        endLine: ordinal + 1,
      })),
    };
  }

  it("resolves eligible file paths for indexable terms through the FTS index", async () => {
    const root = await createRepo();
    const databasePath = path.join(root, "query-eligible.sqlite");
    const store = new QueryIndexStore(databasePath);
    store.replaceFiles(
      [
        preparedFile("src/alpha.ts", ["export function processPaymentBatch() { return 1; }"]),
        preparedFile("src/beta.ts", ["export function unrelatedHelper() { return 2; }"]),
      ],
      [],
      {
        ...expectedQueryIndexVersionMetadata(),
        projectSnapshotIdentity: "snap-1",
        projectRootIdentity: "root-1",
        createdByCodegraphVersion: "test",
        updatedAt: new Date().toISOString(),
      },
    );

    expect(store.eligibleFilePaths(["processpaymentbatch"])).toEqual(["src/alpha.ts"]);
    expect(store.eligibleFilePaths(["unrelatedhelper"])).toEqual(["src/beta.ts"]);
    expect(store.eligibleFilePaths(["nonexistentterm"])).toEqual([]);
    store.close();
  });

  it("scopes the short-term substring fallback to the given eligible paths", async () => {
    const root = await createRepo();
    const databasePath = path.join(root, "query-short-term.sqlite");
    const store = new QueryIndexStore(databasePath);
    store.replaceFiles(
      [preparedFile("src/alpha.ts", ["const id = 1;"]), preparedFile("src/beta.ts", ["const id = 2;"])],
      [],
      {
        ...expectedQueryIndexVersionMetadata(),
        projectSnapshotIdentity: "snap-2",
        projectRootIdentity: "root-2",
        createdByCodegraphVersion: "test",
        updatedAt: new Date().toISOString(),
      },
    );

    const bothFiles = store.substringChunkCandidates("id", ["src/alpha.ts", "src/beta.ts"]);
    expect(new Set(bothFiles.map((chunk) => chunk.path))).toEqual(new Set(["src/alpha.ts", "src/beta.ts"]));

    const scoped = store.substringChunkCandidates("id", ["src/alpha.ts"]);
    expect(scoped.map((chunk) => chunk.path)).toEqual(["src/alpha.ts"]);
    store.close();
  });

  it("reloads short-term normalized rows after another store advances the sidecar generation", async () => {
    const root = await createRepo();
    const databasePath = path.join(root, "query-generation.sqlite");
    const metadata = (projectSnapshotIdentity: string) => ({
      ...expectedQueryIndexVersionMetadata(),
      projectSnapshotIdentity,
      projectRootIdentity: "root-generation",
      createdByCodegraphVersion: "test",
      updatedAt: new Date().toISOString(),
    });
    const storeA = new QueryIndexStore(databasePath);
    const storeB = new QueryIndexStore(databasePath);
    try {
      storeA.replaceFiles(
        [preparedFile("src/retained.ts", ["const id = 1;"]), preparedFile("src/removed.ts", ["const id = 2;"])],
        [],
        metadata("generation-1"),
      );
      expect(storeA.eligibleFilePaths(["id"])).toEqual(["src/removed.ts", "src/retained.ts"]);

      storeB.replaceFiles(
        [preparedFile("src/current.ts", ["const id = 3;"])],
        ["src/retained.ts", "src/removed.ts"],
        metadata("generation-2"),
      );

      expect(storeA.eligibleFilePaths(["id"])).toEqual(["src/current.ts"]);
    } finally {
      storeA.close();
      storeB.close();
    }
  });

  const COMPACT_METADATA = (projectSnapshotIdentity: string) => ({
    ...expectedQueryIndexVersionMetadata(),
    projectSnapshotIdentity,
    projectRootIdentity: "root-compact",
    createdByCodegraphVersion: "test",
    updatedAt: new Date().toISOString(),
  });

  function chunkKeys(chunks: ReadonlyArray<{ path: string; ordinal: number }>): string[] {
    return chunks.map((chunk) => `${chunk.path}#${chunk.ordinal}`).sort();
  }

  it("finds a term that spans word boundaries through the compact-text index, only in files the term is eligible in", async () => {
    const root = await createRepo();
    const store = new QueryIndexStore(path.join(root, "query-compact.sqlite"));
    try {
      store.replaceFiles(
        [
          // `getuser` is a word in the second chunk, so the file is eligible; the first chunk holds it across a space.
          preparedFile("src/spaced.ts", ["get user data", "getuser 1", "unrelated words"]),
          // The same run exists only across a space, so no chunk of this file has the term as a word.
          preparedFile("src/across-only.ts", ["get user data", "other text"]),
        ],
        [],
        COMPACT_METADATA("compact-1"),
      );

      const eligible = store.eligibleFilePaths(["getuser"]);
      expect(eligible).toEqual(["src/spaced.ts"]);
      const retrieval = store.candidateChunkRetrievalForTerms(["getuser"], eligible, "getuser");
      expect(chunkKeys(retrieval.chunks)).toEqual(["src/spaced.ts#0", "src/spaced.ts#1"]);
      // Asked for explicitly, the file that only holds the run across a space still answers: the index is not the filter.
      const direct = store.candidateChunkRetrievalForTerms(["getuser"], ["src/across-only.ts"], "getuser");
      expect(chunkKeys(direct.chunks)).toEqual(["src/across-only.ts#0"]);
    } finally {
      store.close();
    }
  });

  it("returns the chunks a scan of chunk text returns for every indexable term", async () => {
    const root = await createRepo();
    const store = new QueryIndexStore(path.join(root, "query-compact-scan.sqlite"));
    try {
      // A small vocabulary of short words makes terms that span word boundaries, repeat, and nearly match common.
      const words = ["get", "user", "id", "set", "data", "parse", "json", "ab", "cd", "abc", "xyz", "end", "t"];
      let seed = 20_251_101;
      const next = (bound: number): number => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed % bound;
      };
      const files: Array<{ path: string; chunks: string[]; sampled: number }> = [];
      // Every file also holds each pair of words written as one word, so a run across a space in another chunk of the
      // file is a term the file is eligible for.
      const pairWords = words.flatMap((left) => words.map((right) => `${left}${right}`)).join(" ");
      for (let fileIndex = 0; fileIndex < 7; fileIndex += 1) {
        const chunks: string[] = [];
        for (let chunk = 0; chunk < 3 + next(4); chunk += 1) {
          chunks.push(Array.from({ length: 1 + next(6) }, () => words[next(words.length)]!).join(" "));
        }
        files.push({ path: `src/file-${fileIndex}.ts`, chunks: [...chunks, pairWords], sampled: chunks.length });
      }
      store.replaceFiles(
        files.map((file) => preparedFile(file.path, file.chunks)),
        [],
        COMPACT_METADATA("compact-scan"),
      );

      const terms = new Set<string>(["getuser", "userid", "zzzz", "setdata", "parsejson", "abcd"]);
      for (const file of files) {
        for (const chunk of file.chunks.slice(0, file.sampled)) {
          const compact = chunk.replaceAll(" ", "");
          for (let start = 0; start + 3 <= compact.length; start += 2) {
            terms.add(compact.slice(start, start + 3 + (start % 3)));
          }
        }
      }

      let spanning = 0;
      for (const term of terms) {
        const eligible = store.eligibleFilePaths([term]);
        const eligibleScan = files
          .filter((file) => file.chunks.some((chunk) => chunk.includes(term)))
          .map((file) => file.path)
          .sort((left, right) => left.localeCompare(right));
        expect(eligible, term).toEqual(eligibleScan);

        const expected: string[] = [];
        for (const file of files) {
          if (!eligibleScan.includes(file.path)) continue;
          file.chunks.forEach((chunk, ordinal) => {
            const compact = chunk.replaceAll(" ", "");
            if (chunk.includes(term) || compact.includes(term)) expected.push(`${file.path}#${ordinal}`);
            if (!chunk.includes(term) && compact.includes(term)) spanning += 1;
          });
        }
        const retrieval = store.candidateChunkRetrievalForTerms([term], eligible, term, 8000);
        expect(chunkKeys(retrieval.chunks), term).toEqual(expected.sort());
      }
      expect(terms.size).toBeGreaterThan(40);
      expect(spanning).toBeGreaterThan(10);
    } finally {
      store.close();
    }
  });

  function createVersion3Sidecar(databasePath: string): void {
    const v3 = new SqliteDatabase(databasePath);
    v3.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE files(
        file_id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        source_identity TEXT NOT NULL,
        surface TEXT NOT NULL,
        language TEXT,
        normalized_text BLOB NOT NULL,
        byte_length INTEGER NOT NULL,
        line_count INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE chunks(
        chunk_id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        name TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text BLOB NOT NULL,
        normalized_text TEXT NOT NULL,
        UNIQUE(file_id, ordinal)
      ) STRICT;
      CREATE INDEX chunks_file_id_idx ON chunks(file_id);
      CREATE VIRTUAL TABLE chunk_search USING fts5(
        normalized_text, content='chunks', content_rowid='chunk_id', tokenize='trigram'
      );
      CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunk_search(rowid, normalized_text) VALUES (new.chunk_id, new.normalized_text);
      END;
      CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunk_search(chunk_search, rowid, normalized_text)
        VALUES ('delete', old.chunk_id, old.normalized_text);
      END;
      CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunk_search(chunk_search, rowid, normalized_text)
        VALUES ('delete', old.chunk_id, old.normalized_text);
        INSERT INTO chunk_search(rowid, normalized_text) VALUES (new.chunk_id, new.normalized_text);
      END;
      INSERT INTO metadata(key, value) VALUES ('schemaVersion', '3'), ('projectSnapshotIdentity', 'old-snapshot');
    `);
    v3.prepare(
      "INSERT INTO files(path, source_identity, surface, language, normalized_text, byte_length, line_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("src/old.ts", "old", "code", "typescript", compressQueryText("get user data\ngetuser 1"), 24, 2);
    const insertChunk = v3.prepare(
      "INSERT INTO chunks(file_id, ordinal, kind, name, start_line, end_line, text, normalized_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertChunk.run(1, 0, "source", null, 1, 1, compressQueryText("get user data"), "get user data");
    insertChunk.run(1, 1, "source", null, 2, 2, compressQueryText("getuser 1"), "getuser 1");
    v3.exec("PRAGMA user_version = 3;");
    v3.close();
  }

  it("backfills the compact-text index of a version 3 sidecar and keeps its rows", async () => {
    const root = await createRepo();
    const databasePath = path.join(root, "query-v3.sqlite");
    createVersion3Sidecar(databasePath);

    const migrated = new QueryIndexStore(databasePath);
    try {
      expect([...migrated.sourceIdentities()]).toEqual([["src/old.ts", "old"]]);
      expect(migrated.metadata().schemaVersion).toBe(expectedQueryIndexVersionMetadata().schemaVersion);
      // The pre-existing chunk that holds the run across a space is found through the backfilled index.
      const retrieval = migrated.candidateChunkRetrievalForTerms(["getuser"], ["src/old.ts"], "getuser");
      expect(chunkKeys(retrieval.chunks)).toEqual(["src/old.ts#0", "src/old.ts#1"]);

      // Rows written and removed after the upgrade keep the compact index in step through the triggers.
      migrated.replaceFiles(
        [preparedFile("src/new.ts", ["xyzzy plugh", "zzyp 2"])],
        ["src/old.ts"],
        COMPACT_METADATA("after-migration"),
      );
      const added = migrated.candidateChunkRetrievalForTerms(["zzyp"], ["src/new.ts"], "zzyp");
      expect(chunkKeys(added.chunks)).toEqual(["src/new.ts#0", "src/new.ts#1"]);
      const removed = migrated.candidateChunkRetrievalForTerms(["getuser"], ["src/old.ts", "src/new.ts"], "getuser");
      expect(removed.chunks).toEqual([]);
    } finally {
      migrated.close();
    }

    const inspected = new SqliteDatabase(databasePath, { readonly: true });
    const version = inspected.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
    const compactRows = inspected.prepare("SELECT count(*) AS count FROM chunk_compact_search_docsize").get() as
      | { count?: unknown }
      | undefined;
    inspected.close();
    expect(version?.user_version).toBe(4);
    expect(compactRows?.count).toBe(2);
  });

  it("rejects a version 3 sidecar that lost a table instead of backfilling an empty index", async () => {
    const root = await createRepo();
    const databasePath = path.join(root, "query-v3-broken.sqlite");
    createVersion3Sidecar(databasePath);
    const broken = new SqliteDatabase(databasePath);
    broken.exec("DROP TRIGGER chunks_ai; DROP TRIGGER chunks_ad; DROP TRIGGER chunks_au; DROP TABLE chunk_search;");
    broken.close();

    expect(() => new QueryIndexStore(databasePath)).toThrow(/missing: chunk_search/);
    const inspected = new SqliteDatabase(databasePath, { readonly: true });
    const version = inspected.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
    inspected.close();
    expect(version?.user_version).toBe(3);
  });

  it("hydrates a duplicate multi-term chunk once without changing candidate ranking", async () => {
    const root = await createRepo();
    const databasePath = path.join(root, "query-decompression.sqlite");
    const store = new QueryIndexStore(databasePath);
    const decompressSpy = vi.mocked(zlib.brotliDecompressSync);
    try {
      store.replaceFiles([preparedFile("src/match.ts", ["const alphaValue = betaValue;"])], [], {
        ...expectedQueryIndexVersionMetadata(),
        projectSnapshotIdentity: "snap-decompression",
        projectRootIdentity: "root-decompression",
        createdByCodegraphVersion: "test",
        updatedAt: new Date().toISOString(),
      });
      decompressSpy.mockClear();
      const candidateResult = findQueryIndexChunkCandidates(store, ["alpha", "beta"]);
      expect(candidateResult.candidates.map((candidate) => `${candidate.path}:${candidate.ordinal}`)).toEqual([
        "src/match.ts:0",
      ]);
      expect(decompressSpy).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      decompressSpy.mockClear();
    }
  });

  it("keeps later higher-quality chunk matches when candidate hydration is capped", async () => {
    const root = await createRepo();
    const databasePath = path.join(root, "query-candidate-cap.sqlite");
    const store = new QueryIndexStore(databasePath);
    const fillerCount = QUERY_INDEX_CANDIDATE_ROW_LIMIT + 128;
    const files = Array.from({ length: fillerCount }, (_, index) =>
      preparedFile(`src/${String(index).padStart(5, "0")}.ts`, ["const alphaNoise = 1;"]),
    );
    files.push(preparedFile("src/zz-top.ts", ["const alphaValue = betaValue;"]));
    store.replaceFiles(files, [], {
      ...expectedQueryIndexVersionMetadata(),
      projectSnapshotIdentity: "snap-3",
      projectRootIdentity: "root-3",
      createdByCodegraphVersion: "test",
      updatedAt: new Date().toISOString(),
    });

    const candidateResult = findQueryIndexChunkCandidates(store, ["alpha", "beta"]);
    expect(candidateResult.candidates[0]?.path).toBe("src/zz-top.ts");
    expect(candidateResult.candidates.some((candidate) => candidate.path === "src/zz-top.ts")).toBe(true);
    expect(candidateResult.candidates).toHaveLength(QUERY_INDEX_CANDIDATE_ROW_LIMIT);
    store.close();
  });

  it("retrieves later complete-term matches before bounded partial candidates", async () => {
    const root = await createRepo();
    const databasePath = path.join(root, "query-ranked-candidate-retrieval.sqlite");
    const store = new QueryIndexStore(databasePath);
    const fillerCount = QUERY_INDEX_CANDIDATE_ROW_LIMIT * 2 + 1;
    const chunks = [
      ...Array.from({ length: fillerCount }, () => "quasar filler"),
      ...Array.from({ length: fillerCount }, () => "beacon filler"),
      "quasar beacon",
    ];
    try {
      store.replaceFiles([preparedFile("notes.md", chunks)], [], {
        ...expectedQueryIndexVersionMetadata(),
        projectSnapshotIdentity: "snap-ranked-retrieval",
        projectRootIdentity: "root-ranked-retrieval",
        createdByCodegraphVersion: "test",
        updatedAt: new Date().toISOString(),
      });

      const candidateResult = findQueryIndexChunkCandidates(store, ["quasar", "beacon"]);

      expect(candidateResult.candidates[0]?.startLine).toBe(chunks.length);
      expect(candidateResult.candidates[0]?.score.exactPhrase).toBe(true);
      expect(candidateResult.totalCandidatesLowerBound).toBe(true);
      expect(candidateResult.omittedCandidates).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it.each([1_000, 17_000])(
    "preserves complete-term priority for %i-term queries across path batches",
    async (termCount) => {
      const root = await createRepo();
      const store = new QueryIndexStore(path.join(root, "query-long-terms.sqlite"));
      const terms = Array.from({ length: termCount }, (_, index) => `term${String(index).padStart(5, "0")}`);
      const files = Array.from({ length: 501 }, (_, index) =>
        preparedFile(`src/a${String(index).padStart(3, "0")}.ts`, [terms[0]!]),
      );
      // Reverse the terms so the exact-phrase tier cannot hide a broken all-term tier.
      files.push(preparedFile("src/zz-complete.ts", [terms.toReversed().join(" ")]));
      try {
        store.replaceFiles(files, [], {
          ...expectedQueryIndexVersionMetadata(),
          projectSnapshotIdentity: "snap-long-terms",
          projectRootIdentity: "root-long-terms",
          createdByCodegraphVersion: "test",
          updatedAt: new Date().toISOString(),
        });
        const result = store.candidateChunkRetrievalForTerms(
          terms,
          files.map((file) => file.path),
          terms.join(" "),
          1,
        );
        expect(result.chunks.map((chunk) => chunk.path)).toEqual(["src/zz-complete.ts"]);
        expect(result.totalCandidatesLowerBound).toBe(true);
      } finally {
        store.close();
      }
    },
  );

  it("preserves mixed FTS, Unicode, short, and compact matches in long queries", async () => {
    const root = await createRepo();
    const store = new QueryIndexStore(path.join(root, "query-long-mixed.sqlite"));
    const terms = ["alpha", "id", "café", "分割語", "splitword", 'say"hi'];
    const files = [
      preparedFile("src/a-missing-quote.ts", ["alpha id café 分割語 split word"]),
      preparedFile("src/b-missing-accent.ts", ['alpha id cafe 分割語 split word say"hi']),
      preparedFile("src/zz-complete.ts", ['alpha id café 分割語 split word say"hi']),
    ];
    try {
      store.replaceFiles(files, [], {
        ...expectedQueryIndexVersionMetadata(),
        projectSnapshotIdentity: "snap-long-mixed",
        projectRootIdentity: "root-long-mixed",
        createdByCodegraphVersion: "test",
        updatedAt: new Date().toISOString(),
      });
      for (const queryTerms of [terms, [...Array.from({ length: 130 }, () => "alpha"), ...terms]]) {
        const result = store.candidateChunkRetrievalForTerms(
          queryTerms,
          files.map((file) => file.path),
          queryTerms.join(" "),
          1,
        );
        expect(result.chunks.map((chunk) => chunk.path)).toEqual(["src/zz-complete.ts"]);
      }
    } finally {
      store.close();
    }
  });

  it("bounds candidate retrieval via the limit parameter", async () => {
    const root = await createRepo();
    const databasePath = path.join(root, "query-candidate-limit.sqlite");
    const store = new QueryIndexStore(databasePath);
    const files = Array.from({ length: 20 }, (_, index) =>
      preparedFile(`src/file${String(index).padStart(2, "0")}.ts`, ["const alphaNoise = 1;"]),
    );
    store.replaceFiles(files, [], {
      ...expectedQueryIndexVersionMetadata(),
      projectSnapshotIdentity: "snap-4",
      projectRootIdentity: "root-4",
      createdByCodegraphVersion: "test",
      updatedAt: new Date().toISOString(),
    });
    const paths = files.map((file) => file.path);

    const unbounded = store.candidateChunkRetrievalForTerms(["alpha"], paths, "alpha").chunks;
    expect(unbounded).toHaveLength(20);

    const bounded = store.candidateChunkRetrievalForTerms(["alpha"], paths, "alpha", 5).chunks;
    expect(bounded).toHaveLength(5);
    store.close();
  });

  it("gives each term its own prefetch budget so a rare term is not starved by a common early-path term", async () => {
    const root = await createRepo();
    const databasePath = path.join(root, "query-candidate-fairness.sqlite");
    const store = new QueryIndexStore(databasePath);
    const alphaFiles = Array.from({ length: 20 }, (_, index) =>
      preparedFile(`src/a${String(index).padStart(3, "0")}.ts`, ["const alphaNoise = 1;"]),
    );
    const betaFile = preparedFile("src/zz-beta.ts", ["const betaValue = 1;"]);
    const files = [...alphaFiles, betaFile];
    store.replaceFiles(files, [], {
      ...expectedQueryIndexVersionMetadata(),
      projectSnapshotIdentity: "snap-5",
      projectRootIdentity: "root-5",
      createdByCodegraphVersion: "test",
      updatedAt: new Date().toISOString(),
    });
    const paths = files.map((file) => file.path);

    const candidates = store.candidateChunkRetrievalForTerms(["alpha", "beta"], paths, "alpha beta", 10).chunks;

    expect(candidates.some((candidate) => candidate.path === "src/zz-beta.ts")).toBe(true);
    store.close();
  });

  it("marks exact batch-boundary retrieval totals as lower bounds without inflating overlapping tiers", async () => {
    const root = await createRepo();
    const databasePath = path.join(root, "query-candidate-boundary.sqlite");
    const store = new QueryIndexStore(databasePath);
    const alphaFiles = Array.from({ length: 501 }, (_, index) =>
      preparedFile(`src/a${String(index).padStart(3, "0")}.ts`, ["const alphaValue = 1;"]),
    );
    const overlap = preparedFile("src/overlap.ts", ["const gammaValue = deltaValue;"]);
    store.replaceFiles([...alphaFiles, overlap], [], {
      ...expectedQueryIndexVersionMetadata(),
      projectSnapshotIdentity: "snap-boundary",
      projectRootIdentity: "root-boundary",
      createdByCodegraphVersion: "test",
      updatedAt: new Date().toISOString(),
    });
    try {
      const boundary = store.candidateChunkRetrievalForTerms(
        ["alpha"],
        alphaFiles.map((file) => file.path),
        "alpha",
        500,
      );
      const overlapResult = findQueryIndexChunkCandidates(store, ["gamma", "delta"]);

      expect(boundary.chunks).toHaveLength(500);
      expect(boundary.totalCandidatesLowerBound).toBe(true);
      expect(overlapResult.totalCandidates).toBe(1);
      expect(overlapResult.totalCandidatesLowerBound).toBe(false);
      expect(overlapResult.omittedCandidates).toBe(0);
    } finally {
      store.close();
    }
  });

  type PlantedFile = { path: string; chunks: string[] };

  /**
   * The candidate cap as it is defined: eligible paths are read in batches, a batch yields its matching chunks in path
   * order, at most one more than the cap still allows, and the total is a lower bound when a read fills its allowance
   * or the cap is met with batches left. Written as loops over the planted text, not as SQL.
   */
  function batchedReference(
    files: readonly PlantedFile[],
    terms: readonly string[],
    paths: readonly string[],
    phrase: string,
    limit: number,
  ): { keys: string[]; lowerBound: boolean } {
    const byPath = new Map(files.map((file) => [file.path, file]));
    const candidates = new Set<string>();
    let lowerBound = false;
    const hasTerm = (chunk: string, term: string): boolean =>
      chunk.includes(term) || chunk.replaceAll(" ", "").includes(term);
    const collect = (matches: (chunk: string) => boolean, maximum: number): void => {
      for (let offset = 0; offset < paths.length && candidates.size < maximum; offset += QUERY_INDEX_PATH_BATCH_SIZE) {
        const rows: string[] = [];
        const batch = new Set(paths.slice(offset, offset + QUERY_INDEX_PATH_BATCH_SIZE));
        for (const filePath of [...batch].sort()) {
          byPath.get(filePath)?.chunks.forEach((chunk, ordinal) => {
            if (matches(chunk)) rows.push(`${filePath}#${ordinal}`);
          });
        }
        const requested = maximum - candidates.size + 1;
        const read = rows.slice(0, requested);
        if (read.length === requested) lowerBound = true;
        for (const key of read) {
          if (candidates.has(key)) continue;
          candidates.add(key);
          if (candidates.size >= maximum) break;
        }
        if (candidates.size >= maximum && offset + QUERY_INDEX_PATH_BATCH_SIZE < paths.length) lowerBound = true;
      }
    };
    if (terms.length > 1) collect((chunk) => chunk.includes(phrase), limit);
    if (terms.length > 1) {
      if (candidates.size < limit) collect((chunk) => terms.every((term) => hasTerm(chunk, term)), limit);
      else lowerBound = true;
    }
    const perTermLimit = Math.max(1, Math.ceil(limit / terms.length));
    for (const term of terms) {
      if (candidates.size >= limit) {
        lowerBound = true;
        break;
      }
      collect((chunk) => hasTerm(chunk, term), Math.min(limit, candidates.size + perTermLimit));
    }
    return { keys: [...candidates], lowerBound };
  }

  it("reads eligible files in batches in the order given, so the cap and lower bound fall where batch reads put them", async () => {
    const root = await createRepo();
    const store = new QueryIndexStore(path.join(root, "query-batches.sqlite"));
    // Three batches of eligible files: every file has the term `alpha`, every third `beta`, and every fifth both.
    const files: PlantedFile[] = Array.from({ length: 1201 }, (_, index) => {
      const name = String(index).padStart(4, "0");
      return {
        path: `src/f${name}.ts`,
        chunks: [
          `alpha item ${name}`,
          index % 3 === 0 ? `beta item ${name}` : `plain ${name}`,
          index % 5 === 0 ? `alpha beta ${name}` : `other ${name}`,
        ],
      };
    });
    try {
      store.replaceFiles(
        files.map((file) => preparedFile(file.path, file.chunks)),
        [],
        COMPACT_METADATA("batches"),
      );
      // The first batch holds the highest paths, a path the store does not hold is skipped, and the first path is
      // listed again in the last batch.
      const paths = files.map((file) => file.path).reverse();
      paths.splice(3, 0, "src/not-indexed.ts");
      paths.push(paths[0]!);
      expect(Math.ceil(paths.length / QUERY_INDEX_PATH_BATCH_SIZE)).toBe(3);

      const seenLowerBounds = new Set<boolean>();
      const queries: Array<{ terms: string[]; phrase: string }> = [
        { terms: ["alpha"], phrase: "alpha" },
        { terms: ["alphaitem"], phrase: "alphaitem" },
        { terms: ["alpha", "beta"], phrase: "alpha beta" },
      ];
      for (const { terms, phrase } of queries) {
        for (const limit of [1, 2, 499, 500, 501, 1000, 1201, 2500]) {
          const expected = batchedReference(files, terms, paths, phrase, limit);
          const actual = store.candidateChunkRetrievalForTerms(terms, paths, phrase, limit);
          const label = `${terms.join(" ")} limit ${limit}`;
          expect(
            actual.chunks.map((chunk) => `${chunk.path}#${chunk.ordinal}`),
            label,
          ).toEqual(expected.keys);
          expect(actual.totalCandidatesLowerBound, label).toBe(expected.lowerBound);
          seenLowerBounds.add(expected.lowerBound);
        }
      }
      expect(seenLowerBounds).toEqual(new Set([true, false]));

      // With a cap of one, the chunk kept is the first of the first batch (f1200 down to f0702, in path order), not
      // the first path overall (f0000, which sits in the last batch).
      const first = store.candidateChunkRetrievalForTerms(["alpha"], paths, "alpha", 1);
      expect(first.chunks.map((chunk) => `${chunk.path}#${chunk.ordinal}`)).toEqual(["src/f0702.ts#0"]);
    } finally {
      store.close();
    }
  });

  /** Runs `run` while counting the rows every statement hands back, one per `iterate()` pull and per `all()` result. */
  function countStatementRows<T>(run: () => T): { result: T; iterated: number; largestAll: number } {
    let iterated = 0;
    let largestAll = 0;
    const iterate = SqliteStatement.prototype.iterate;
    const all = SqliteStatement.prototype.all;
    vi.spyOn(SqliteStatement.prototype, "iterate").mockImplementation(function (
      this: SqliteStatement,
      ...params: Parameters<SqliteStatement["iterate"]>
    ) {
      const rows = iterate.apply(this, params) as Iterable<SqliteRawRow>;
      return (function* () {
        for (const row of rows) {
          iterated += 1;
          yield row;
        }
      })();
    });
    vi.spyOn(SqliteStatement.prototype, "all").mockImplementation(function (
      this: SqliteStatement,
      ...params: Parameters<SqliteStatement["all"]>
    ) {
      const rows = all.apply(this, params);
      largestAll = Math.max(largestAll, rows.length);
      return rows;
    });
    try {
      const result = run();
      return { result, iterated, largestAll };
    } finally {
      vi.restoreAllMocks();
    }
  }

  it("pulls only the cap and the one row past it from the statement, however many chunks match", async () => {
    const root = await createRepo();
    const store = new QueryIndexStore(path.join(root, "query-bounded-read.sqlite"));
    // Three batches of files. Every file has two chunks with `alpha beta id`; every other file also has a `gamma` chunk,
    // so each batch holds 250 `gamma` chunks but a thousand chunks of everything else.
    const files: PlantedFile[] = Array.from({ length: 1100 }, (_, index) => {
      const name = String(index).padStart(4, "0");
      return {
        path: `src/f${name}.ts`,
        chunks: [
          `alpha beta id ${name}`,
          `alpha beta id again ${name}`,
          index % 2 === 0 ? `gamma ${name}` : `plain ${name}`,
        ],
      };
    });
    try {
      store.replaceFiles(
        files.map((file) => preparedFile(file.path, file.chunks)),
        [],
        COMPACT_METADATA("bounded-read"),
      );
      const paths = files.map((file) => file.path);
      // `id` is a scan the trigram index cannot answer, `alpha` and the pair are index lookups, and a cap of 400 on
      // `gamma` needs the second batch because the first holds only 250 of its chunks.
      const queries: Array<{ terms: string[]; limit: number }> = [
        { terms: ["id"], limit: 40 },
        { terms: ["alpha"], limit: 40 },
        { terms: ["alpha", "beta"], limit: 40 },
        { terms: ["gamma"], limit: 40 },
        { terms: ["gamma"], limit: 400 },
      ];
      for (const { terms, limit } of queries) {
        const phrase = terms.join(" ");
        const label = `${phrase} limit ${limit}`;
        const expected = batchedReference(files, terms, paths, phrase, limit);
        expect(expected.keys, label).toHaveLength(limit);
        expect(expected.lowerBound, label).toBe(true);
        // The second run finds the statement the first one stopped early; it must read from the start again.
        for (let run = 0; run < 2; run += 1) {
          const { result, iterated, largestAll } = countStatementRows(() =>
            store.candidateChunkRetrievalForTerms(terms, paths, phrase, limit),
          );
          expect(
            result.chunks.map((chunk) => `${chunk.path}#${chunk.ordinal}`),
            label,
          ).toEqual(expected.keys);
          expect(result.totalCandidatesLowerBound, label).toBe(true);
          expect(iterated, label).toBe(limit + 1);
          // No `all()` returns the matching chunks: the files and the kept candidates are the most it reads at once.
          expect(largestAll, label).toBeLessThanOrEqual(files.length);
        }
      }
    } finally {
      store.close();
    }
  });

  it("reads only the eligible files for a term the trigram index cannot answer", async () => {
    const root = await createRepo();
    const store = new QueryIndexStore(path.join(root, "query-short-eligible.sqlite"));
    try {
      store.replaceFiles(
        [
          preparedFile("src/a.ts", ["id one", "other words"]),
          preparedFile("src/b.ts", ["id two"]),
          preparedFile("src/c.ts", ["nothing here"]),
        ],
        [],
        COMPACT_METADATA("short-eligible"),
      );
      const scoped = store.candidateChunkRetrievalForTerms(["id"], ["src/a.ts", "src/not-indexed.ts"], "id");
      expect(chunkKeys(scoped.chunks)).toEqual(["src/a.ts#0"]);
      expect(scoped.totalCandidatesLowerBound).toBe(false);

      // Within a batch the chunks come in path order, whatever order the paths are listed in.
      const both = store.candidateChunkRetrievalForTerms(["id"], ["src/b.ts", "src/a.ts"], "id");
      expect(both.chunks.map((chunk) => `${chunk.path}#${chunk.ordinal}`)).toEqual(["src/a.ts#0", "src/b.ts#0"]);

      const none = store.candidateChunkRetrievalForTerms(["id"], ["src/c.ts"], "id");
      expect(none.chunks).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rejects absolute and traversing paths from persisted rows", async () => {
    const root = await createRepo();
    expect(() => resolveQueryIndexSourcePath(root, "../outside.ts")).toThrow(/Invalid query index relative path/u);
    expect(() => resolveQueryIndexSourcePath(root, "src/..")).toThrow(/Invalid query index relative path/u);
    expect(() => resolveQueryIndexSourcePath(root, path.resolve(root, "src", "auth.ts"))).toThrow(
      /Invalid query index relative path/u,
    );
  });

  it("rebuilds a sidecar containing a traversing persisted path", async () => {
    const root = await createRepo();
    const initialSession = createSession(root);
    await search(initialSession, root, "validate user");
    const initialSnapshot = await initialSession.loadProject();
    const sidecar = resolveQueryIndexPaths(initialSnapshot.index.cacheRootDir!).sidecar;
    disposeSessionQueryIndex(initialSession);

    const corrupted = new SqliteDatabase(sidecar);
    corrupted.prepare("UPDATE files SET path = ? WHERE path = ?").run("src/..", "src/auth.ts");
    corrupted.close();

    const recoveredSession = createSession(root);
    const response = await search(recoveredSession, root, "validate user");
    const recoveredSnapshot = await recoveredSession.loadProject();
    expect(recoveredSnapshot.buildReport?.queryIndex?.sidecarState).toBe("rebuilt-corrupt");
    expect(response.results.some((result) => result.file === "src/auth.ts")).toBe(true);
  });

  it("refuses a sidecar symlink that escapes the cache directory", async () => {
    const root = await createRepo();
    const initialSession = createSession(root);
    await search(initialSession, root, "validate user");
    const initialSnapshot = await initialSession.loadProject();
    const paths = resolveQueryIndexPaths(initialSnapshot.index.cacheRootDir!);
    disposeSessionQueryIndex(initialSession);
    const escapedTarget = path.join(root, "escaped-query-index.sqlite");
    await fs.rename(paths.sidecar, escapedTarget);
    try {
      await fs.symlink(escapedTarget, paths.sidecar, "file");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const fallbackSession = createSession(root);
    const response = await search(fallbackSession, root, "validate user");
    const fallbackSnapshot = await fallbackSession.loadProject();
    expect(fallbackSnapshot.buildReport?.queryIndex?.sidecarState).toBe("unavailable");
    expect(response.results.some((result) => result.file === "src/auth.ts")).toBe(true);
    expect((await fs.stat(escapedTarget)).isFile()).toBe(true);
  });

  it("does not create a sidecar when disk caching is disabled", async () => {
    const root = await createRepo();
    const session = createSession(root, "off");
    const response = await search(session, root, "validate user");
    expect(response.results.some((result) => result.file === "src/auth.ts")).toBe(true);
    await expect(fs.stat(path.join(root, ".codegraph", "cache"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("bounds query index generation retries under sustained invalidation and surfaces a clear error", async () => {
    const root = await createRepo();
    const session = createSession(root);
    const snapshot = await session.loadProject();

    let attempts = 0;
    const realEnsureQueryIndex = updateModule.ensureQueryIndex;
    const ensureQueryIndexSpy = vi.spyOn(updateModule, "ensureQueryIndex").mockImplementation(async (snap) => {
      attempts += 1;
      const res = await realEnsureQueryIndex(snap);
      disposeSessionQueryIndex(session);
      return res;
    });

    try {
      await expect(ensureSessionQueryIndex(session, snapshot)).rejects.toThrow(
        /Query index generation changed repeatedly while loading/i,
      );
      expect(attempts).toBe(3);
    } finally {
      ensureQueryIndexSpy.mockRestore();
    }
  });
});
