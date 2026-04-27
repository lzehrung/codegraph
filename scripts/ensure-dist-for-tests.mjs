import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredEntries = [
  path.join(rootDir, "dist", "index.js"),
  path.join(rootDir, "dist", "cli.js"),
];

if (requiredEntries.every((entry) => fs.existsSync(entry))) {
  process.exit(0);
}

console.warn("[codegraph] dist artifacts missing; running npm run build before tests.");

const result = spawnSync("npm", ["run", "build"], {
  cwd: rootDir,
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
