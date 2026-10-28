import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtHelper = path.join(rootDir, "dist", "util", "worker-threads.js");

// A pool worker replaces, rather than extends, the options its host was started with, so these tests start a host
// process of their own with real CLI options and look at what a worker of a Piscina pool sees. The files live outside
// the repository because nothing in them is part of the project.
let scratchDir = "";
let preloadPath = "";
let workerPath = "";
let hostScript = "";

beforeAll(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-exec-argv-"));
  preloadPath = path.join(scratchDir, "preload.cjs");
  workerPath = path.join(scratchDir, "worker.mjs");
  fs.writeFileSync(preloadPath, 'globalThis.__codegraphPreloadMarker = "preloaded";\n');
  fs.writeFileSync(
    workerPath,
    "export default () => ({ marker: globalThis.__codegraphPreloadMarker ?? null, execArgv: process.execArgv });\n",
  );
  hostScript = `
import { Piscina } from "piscina";
import { piscinaWorkerExecArgv } from ${JSON.stringify(pathToFileURL(builtHelper).href)};
const pool = new Piscina({ filename: ${JSON.stringify(workerPath)}, execArgv: piscinaWorkerExecArgv(), maxThreads: 1 });
console.log(JSON.stringify(await pool.run({})));
await pool.destroy();
`;
});

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

function runHost(hostArgs: string[]): { marker: string | null; execArgv: string[] } {
  expect(fs.existsSync(builtHelper), "run `npm run build` first").toBe(true);
  const result = spawnSync(process.execPath, [...hostArgs, "--input-type=module", "-e", hostScript], {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(result.stderr).not.toMatch(/ERR_WORKER_INVALID_EXEC_ARGV/);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as { marker: string | null; execArgv: string[] };
}

describe("piscinaWorkerExecArgv", () => {
  it("runs the --require preload of the host in a pool worker", () => {
    const seen = runHost(["--require", preloadPath]);

    expect(seen.marker).toBe("preloaded");
    expect(seen.execArgv).toEqual(["--require", preloadPath, "--no-experimental-require-module"]);
  });

  it("drops host options that a worker rejects and keeps the ones it accepts", () => {
    // --max-old-space-size and --expose-gc make `new Worker` throw ERR_WORKER_INVALID_EXEC_ARGV when passed in
    // execArgv, and --inspect-brk would hold every worker until a debugger attaches.
    const seen = runHost([
      "--max-old-space-size=512",
      "--expose-gc",
      `--require=${preloadPath}`,
      "--enable-source-maps",
    ]);

    expect(seen.marker).toBe("preloaded");
    expect(seen.execArgv).toEqual([
      `--require=${preloadPath}`,
      "--enable-source-maps",
      "--no-experimental-require-module",
    ]);
  });

  it("leaves a require-module option that the host set itself alone", () => {
    const seen = runHost(["--experimental-require-module", "--require", preloadPath]);

    expect(seen.marker).toBe("preloaded");
    expect(seen.execArgv).toEqual(["--experimental-require-module", "--require", preloadPath]);
  });
});
