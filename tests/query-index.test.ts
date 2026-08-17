import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchCodegraphWithSession, type AgentSearchResponse } from "../src/agent/search.js";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "../src/agent/session.js";
import { disposeSessionQueryIndex } from "../src/agent/query-index/sessionStore.js";
import { resolveQueryIndexPaths, resolveQueryIndexSourcePath } from "../src/agent/query-index/paths.js";
import { expectedQueryIndexVersionMetadata, probeQueryIndexSqliteSupport } from "../src/agent/query-index/schema.js";
import { SqliteDatabase } from "../src/sqlite-driver.js";
import { ensureQueryIndex } from "../src/agent/query-index/update.js";
import { QueryIndexStore, QUERY_INDEX_CANDIDATE_ROW_LIMIT } from "../src/agent/query-index/store.js";
import * as queryIndexWorkerPool from "../src/agent/query-index/workerPool.js";
import { buildProjectIndexIncremental } from "../src/indexer/build-index.js";
import { isSymlinkUnavailable } from "./helpers/filesystem.js";
import { createCodegraphMcpHandlers } from "../src/mcp/server.js";
import { captureCli } from "./helpers/cli.js";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
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
  const session = createAgentSession({ root, buildOptions: { cache, native: "off" } });
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
  for (const session of sessions.splice(0)) disposeSessionQueryIndex(session);
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
      "--native",
      "off",
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
      buildOptions: { cache: "disk", native: "off" },
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
        native: "off",
      });
      expect(index.manifestEntries?.has(transient.replace(/\\/g, "/"))).toBe(true);
      const files = [...index.manifestEntries!.keys()];
      return {
        root,
        files,
        index,
        graph: index.graph,
        analysis: index.analysis ?? {
          mode: "reduced",
          backend: "unknown",
          parserDegradedFiles: 0,
          fallbackImportExtractionFiles: 0,
          nativeFilesUsed: 0,
          nativeFilesFellBack: 0,
          label: "reduced",
        },
        buildReport: index.buildReport,
      };
    };

    const created = await ensureQueryIndex(await loadSnapshot());
    expect(created.diagnostics).toMatchObject({ sidecarState: "created", filesRead: 5, filesAdded: 5 });
    created.store?.close();

    await fs.writeFile(transient, "export const transientValue = 'transient changed phrase with a new size';\n");
    const updated = await ensureQueryIndex(await loadSnapshot());
    expect(updated.diagnostics).toMatchObject({ sidecarState: "updated", filesRead: 1, filesUpdated: 1 });
    updated.store?.close();
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
    vi.spyOn(queryIndexWorkerPool, "prepareQueryIndexFilesInWorker").mockRejectedValue(
      new Error("forced worker failure"),
    );

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

  it("keeps the sidecar usable and records the omission when a file is skipped", async () => {
    const root = await createRepo();
    const realPrepare = queryIndexWorkerPool.prepareQueryIndexFilesInWorker;
    vi.spyOn(queryIndexWorkerPool, "prepareQueryIndexFilesInWorker").mockImplementation(
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
      return originalWithReadSnapshot.call(this, projectSnapshotIdentity, () => {
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
    expect(version?.user_version).toBe(3);
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
    expect(version?.user_version).toBe(3);
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

    const candidates = findQueryIndexChunkCandidates(store, ["alpha", "beta"]);
    expect(candidates[0]?.path).toBe("src/zz-top.ts");
    expect(candidates.some((candidate) => candidate.path === "src/zz-top.ts")).toBe(true);
    expect(candidates).toHaveLength(QUERY_INDEX_CANDIDATE_ROW_LIMIT);
    store.close();
  });

  it("bounds candidateChunksForTerms SQL prefetch via the limit parameter", async () => {
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

    const unbounded = store.candidateChunksForTerms(["alpha"], paths);
    expect(unbounded).toHaveLength(20);

    const bounded = store.candidateChunksForTerms(["alpha"], paths, 5);
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

    const candidates = store.candidateChunksForTerms(["alpha", "beta"], paths, 10);

    expect(candidates.some((candidate) => candidate.path === "src/zz-beta.ts")).toBe(true);
    store.close();
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
    await expect(fs.stat(path.join(root, ".codegraph-cache"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
