import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtPool = path.join(rootDir, "dist", "worker", "native-worker-pool.js");

const ROUNDS = 300;

// Piscina destroys a pool by terminating every worker thread, including one that is still loading its module. On
// Node 22.16 that aborted the whole process (`FATAL ERROR: v8::Module::IsGraphAsync must be used on an instantiated
// module`), so the pool runs in a process of its own here: in a test worker, the abort would end the worker.
// The delays are real on purpose. The race is between the teardown and the startup of operating system threads, which
// no fake clock reaches, and it only shows when the teardown lands in a short part of that startup. Where that part
// lies depends on the machine, so the rounds measure the startup first and spread the teardown over all of it.
const script = `
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { createNativeWorkerPool } from ${JSON.stringify(pathToFileURL(builtPool).href)};

let startupMs = 0;
for (let warmup = 0; warmup < 3; warmup += 1) {
  const pool = createNativeWorkerPool({ threads: 1 });
  const started = performance.now();
  await pool.run({ tasks: [] });
  startupMs = performance.now() - started;
  await pool.destroy();
}

for (let round = 0; round < ${ROUNDS}; round += 1) {
  const pool = createNativeWorkerPool({ threads: 2 });
  const tasks = [0, 1].map(() => pool.run({ tasks: [] }).catch(() => undefined));
  await sleep(Math.round((startupMs * (round % 30)) / 30));
  await pool.destroy();
  await Promise.all(tasks);
}
console.log("all pools destroyed");
`;

describe("worker pool teardown", () => {
  it("survives a pool that is destroyed while its worker threads are still starting", () => {
    expect(fs.existsSync(builtPool), "run `npm run build` first").toBe(true);

    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 120_000,
    });

    expect(result.stderr).not.toMatch(/FATAL ERROR/);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("all pools destroyed");
  }, 150_000);
});
