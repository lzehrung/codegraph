import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectDistForTests } from "./ensure-dist-for-tests-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distState = inspectDistForTests(rootDir);

if (!distState.needsBuild) {
  process.exit(0);
}

const buildReason =
  distState.reason === "stale" ? "stale" : "missing";
console.warn(
  `[codegraph] dist artifacts ${buildReason}; running npm run build before tests.`,
);

const result = spawnSync("npm", ["run", "build"], {
  cwd: rootDir,
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
