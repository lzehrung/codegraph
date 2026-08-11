import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { mkTmpDir } from "./helpers/filesystem.js";

/**
 * Finding #42 — multi-process disk-cache concurrency regression.
 *
 * Covers:
 * - Real separate OS processes (spawn), so SQLite file locking / WAL is exercised
 * - Concurrent writers that each mutate a distinct source file then rebuild with cache: "disk"
 * - Concurrent readers that rebuild against the same cache directory without mutating
 * - Postconditions: no child crash, sqlite integrity_check ok, every writer marker retained in
 *   cached module payloads, project-index-snapshot remains readable
 *
 * Does not cover:
 * - A long-lived parent holding an open process-global DB handle while children race
 *   (each child opens and closes its own handle; MCP+CLI overlap is approximated, not identical)
 * - Same-file last-writer-wins races
 * - Duplicate-unit cache (owned elsewhere; this suite targets index-cache.sqlite + snapshot)
 */

const repoRoot = process.cwd();
const distIndex = path.join(repoRoot, "dist", "index.js");

type WorkerJob =
  | { role: "reader"; id: number; projectRoot: string }
  | { role: "writer"; id: number; projectRoot: string; relativeFile: string; marker: string };

type WorkerSuccess = { ok: true; role: string; id: number; fileCount: number };
type WorkerFailure = { ok: false; error: string };

function moduleCacheDbPath(projectRoot: string): string {
  return path.join(projectRoot, ".codegraph-cache", "index-v1", "index-cache.sqlite");
}

function snapshotPath(projectRoot: string): string {
  return path.join(projectRoot, ".codegraph-cache", "index-v1", "project-index-snapshot.json");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function spawnWorker(
  workerPath: string,
  job: WorkerJob,
): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  result: WorkerSuccess | WorkerFailure | null;
}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath, JSON.stringify(job)], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({
        status: null,
        stdout,
        stderr: `${stderr}\n${errorMessage(error)}`,
        result: null,
      });
    });
    child.on("close", (status) => {
      let result: WorkerSuccess | WorkerFailure | null = null;
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          result = JSON.parse(trimmed) as WorkerSuccess | WorkerFailure;
        } catch {
          result = null;
        }
      }
      resolve({ status, stdout, stderr, result });
    });
  });
}

function readIntegrity(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    return typeof row?.integrity_check === "string" ? row.integrity_check : String(row?.integrity_check ?? "");
  } finally {
    db.close();
  }
}

function toPayloadBytes(payload: NonNullable<unknown>): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (Buffer.isBuffer(payload)) return payload;
  return Buffer.from(String(payload));
}

function readCachedPayloadTexts(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT payload FROM module_cache").all() as Array<{ payload?: unknown }>;
    return rows.map((row) => {
      if (!row.payload) return "";
      const bytes = toPayloadBytes(row.payload);
      return brotliDecompressSync(bytes).toString("utf8");
    });
  } finally {
    db.close();
  }
}

function buildWorkerSource(): string {
  return `import fsp from "node:fs/promises";
import path from "node:path";

const distHref = ${JSON.stringify(pathToFileURL(distIndex).href)};
const { buildProjectIndex } = await import(distHref);

const job = JSON.parse(process.argv[2] ?? "{}");
try {
  if (job.role === "writer") {
    const absolute = path.join(job.projectRoot, job.relativeFile);
    const source = [
      'import { shared } from "./shared.js";',
      "export const " + job.marker + " = 1;",
      "export const value = shared;",
      "",
    ].join("\\n");
    await fsp.writeFile(absolute, source, "utf8");
  }
  const report = {};
  const index = await buildProjectIndex(job.projectRoot, {
    cache: "disk",
    threads: 1,
    report,
  });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      role: job.role,
      id: job.id,
      fileCount: index.byFile.size,
    }),
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
`;
}

describe("disk cache multi-process concurrency", () => {
  it("survives concurrent readers and writers against one cache directory", async () => {
    expect(fs.existsSync(distIndex), "dist/index.js must exist (run ensure-dist / build first)").toBe(true);

    const projectRoot = await mkTmpDir("dg-disk-cache-concurrency-");
    const workerDir = await mkTmpDir("dg-disk-cache-concurrency-worker-");
    const workerPath = path.join(workerDir, "disk-cache-concurrency-worker.mjs");
    const writerCount = 4;
    const readerCount = 4;

    try {
      await fsp.mkdir(path.join(projectRoot, "src"), { recursive: true });
      await fsp.writeFile(path.join(projectRoot, "src", "shared.ts"), "export const shared = 1;\n", "utf8");
      for (let id = 0; id < writerCount; id += 1) {
        await fsp.writeFile(
          path.join(projectRoot, "src", `worker-${id}.ts`),
          `import { shared } from "./shared.js";\nexport const value${id} = shared + ${id};\n`,
          "utf8",
        );
      }
      await fsp.writeFile(workerPath, buildWorkerSource(), "utf8");

      const seed = await spawnWorker(workerPath, { role: "reader", id: -1, projectRoot });
      expect(seed.status, seed.stderr || seed.stdout).toBe(0);
      expect(seed.result?.ok).toBe(true);
      expect(fs.existsSync(moduleCacheDbPath(projectRoot))).toBe(true);

      const nonce = Date.now().toString(36);
      const writerJobs: Extract<WorkerJob, { role: "writer" }>[] = [];
      for (let id = 0; id < writerCount; id += 1) {
        writerJobs.push({
          role: "writer",
          id,
          projectRoot,
          relativeFile: path.join("src", `worker-${id}.ts`),
          marker: `MARKER_${id}_${nonce}`,
        });
      }
      const readerJobs: WorkerJob[] = [];
      for (let id = 0; id < readerCount; id += 1) {
        readerJobs.push({ role: "reader", id, projectRoot });
      }

      // Wave 1: concurrent writers on distinct files — lost-update sensitive.
      const writerOutcomes = await Promise.all(writerJobs.map((job) => spawnWorker(workerPath, job)));
      for (const outcome of writerOutcomes) {
        expect(outcome.status, outcome.stderr || outcome.stdout).toBe(0);
        expect(outcome.result?.ok, outcome.stderr || outcome.stdout).toBe(true);
      }

      const dbPath = moduleCacheDbPath(projectRoot);
      expect(readIntegrity(dbPath)).toBe("ok");
      let payloads = readCachedPayloadTexts(dbPath).join("\n");
      for (const job of writerJobs) {
        expect(payloads, `lost update for writer ${job.id}`).toContain(job.marker);
      }

      // Wave 2: concurrent readers + another writer pass against the hot cache.
      const mixedJobs: WorkerJob[] = [
        ...readerJobs,
        ...writerJobs.map((job) => ({
          ...job,
          marker: `${job.marker}_B`,
        })),
      ];
      const mixedOutcomes = await Promise.all(mixedJobs.map((job) => spawnWorker(workerPath, job)));
      for (const outcome of mixedOutcomes) {
        expect(outcome.status, outcome.stderr || outcome.stdout).toBe(0);
        expect(outcome.result?.ok, outcome.stderr || outcome.stdout).toBe(true);
      }

      expect(readIntegrity(dbPath)).toBe("ok");
      payloads = readCachedPayloadTexts(dbPath).join("\n");
      for (const job of mixedJobs) {
        if (job.role !== "writer") continue;
        expect(payloads, `lost update for mixed writer ${job.id}`).toContain(job.marker);
      }

      // Source-of-truth files must retain the latest writer markers.
      for (const job of writerJobs) {
        const source = await fsp.readFile(path.join(projectRoot, job.relativeFile), "utf8");
        expect(source).toContain(`${job.marker}_B`);
      }

      const snap = snapshotPath(projectRoot);
      expect(fs.existsSync(snap)).toBe(true);
      const snapshotJson = brotliDecompressSync(await fsp.readFile(snap)).toString("utf8");
      const parsed = JSON.parse(snapshotJson) as { modules?: unknown[] };
      expect(Array.isArray(parsed.modules)).toBe(true);
      expect((parsed.modules ?? []).length).toBeGreaterThanOrEqual(writerCount + 1);

      const finalPass = await spawnWorker(workerPath, { role: "reader", id: 99, projectRoot });
      expect(finalPass.status, finalPass.stderr || finalPass.stdout).toBe(0);
      expect(finalPass.result?.ok).toBe(true);
      expect(readIntegrity(dbPath)).toBe("ok");
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
      await fsp.rm(workerDir, { recursive: true, force: true });
    }
  }, 120_000);
});
