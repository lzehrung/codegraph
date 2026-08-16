import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Piscina } from "piscina";
import { findPackageRoot } from "../util/packageInfo.js";
import type { RawSqlResult } from "./types.js";
import type { RawQueryWorkerTask } from "./rawQueryWorker.js";

export class SqliteQueryDeadlineExceededError extends Error {
  constructor(deadlineMs: number) {
    super(`SQLite query exceeded its ${deadlineMs}ms execution budget and was terminated.`);
    this.name = "SqliteQueryDeadlineExceededError";
  }
}

export function resolveRawSqlQueryWorkerPath(): string {
  const selfDirectory = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.resolve(selfDirectory, "rawQueryWorker.js");
  if (fs.existsSync(sibling)) return sibling;
  const packageRoot = findPackageRoot(selfDirectory);
  const compiled = path.join(packageRoot, "dist", "sqlite", "rawQueryWorker.js");
  if (fs.existsSync(compiled)) return compiled;
  throw new Error(`Raw SQLite query worker file not found: ${compiled}`);
}

export async function runRawSqlQueryInWorker(task: RawQueryWorkerTask, deadlineMs: number): Promise<RawSqlResult> {
  const pool = new Piscina({
    filename: resolveRawSqlQueryWorkerPath(),
    minThreads: 1,
    maxThreads: 1,
    idleTimeout: 5_000,
  });
  try {
    return (await pool.run(task, { signal: AbortSignal.timeout(deadlineMs) })) as RawSqlResult;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new SqliteQueryDeadlineExceededError(deadlineMs);
    }
    throw error;
  } finally {
    void pool.destroy().catch(() => {});
  }
}
