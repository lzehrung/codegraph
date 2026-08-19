import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const requiredDistEntries = [
  "dist/index.js",
  "dist/cli.js",
  "dist/bin/cli.js",
  "dist/bin/queryIndexWorker.js",
  "dist/bin/rawQueryWorker.js",
];
const freshnessInputs = [
  "package.json",
  "tsconfig.json",
  "src",
  "scripts/bundle-cli.mjs",
  "scripts/bundle-cli-lib.mjs",
  "scripts/stage-core-package.mjs",
  "scripts/stage-core-package-lib.mjs",
  "scripts/build-native-if-available.mjs",
  "scripts/build-native-if-available-lib.mjs",
  "packages/codegraph-native/src",
  "packages/codegraph-native/build.rs",
  "packages/codegraph-native/Cargo.toml",
  "packages/codegraph-native/Cargo.lock",
];

function collectNewestMtimeMs(entryPath) {
  if (!fs.existsSync(entryPath)) {
    return 0;
  }

  const entryStat = fs.statSync(entryPath);
  if (!entryStat.isDirectory()) {
    return entryStat.mtimeMs;
  }

  let newestMtimeMs = entryStat.mtimeMs;
  for (const child of fs.readdirSync(entryPath, { withFileTypes: true })) {
    const childNewestMtimeMs = collectNewestMtimeMs(path.join(entryPath, child.name));
    newestMtimeMs = Math.max(newestMtimeMs, childNewestMtimeMs);
  }
  return newestMtimeMs;
}

export function getRequiredDistEntries(rootDir) {
  return requiredDistEntries.map((entry) => path.join(rootDir, entry));
}

export function getFreshnessInputs(rootDir) {
  return freshnessInputs.map((entry) => path.join(rootDir, entry));
}

export function inspectDistForTests(rootDir) {
  const requiredEntries = getRequiredDistEntries(rootDir);
  const missingEntries = requiredEntries.filter((entry) => !fs.existsSync(entry));
  if (missingEntries.length) {
    return {
      needsBuild: true,
      reason: "missing",
      missingEntries,
    };
  }

  const oldestDistMtimeMs = Math.min(...requiredEntries.map((entry) => fs.statSync(entry).mtimeMs));
  const newestInputMtimeMs = Math.max(...getFreshnessInputs(rootDir).map((entry) => collectNewestMtimeMs(entry)));

  if (newestInputMtimeMs > oldestDistMtimeMs) {
    return {
      needsBuild: true,
      reason: "stale",
      missingEntries: [],
    };
  }

  return {
    needsBuild: false,
    reason: "fresh",
    missingEntries: [],
  };
}
export function runEnsureDistForTests(rootDir, options = {}) {
  const inspect = options.inspect ?? inspectDistForTests;
  const logger = options.logger ?? console;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const platform = options.platform ?? process.platform;
  const distState = inspect(rootDir);
  if (!distState.needsBuild) return 0;

  const buildReason = distState.reason === "stale" ? "stale" : "missing";
  logger.warn(`[codegraph] dist artifacts ${buildReason}; running npm run build before tests.`);
  const result = spawnSyncImpl("npm", ["run", "build"], {
    cwd: rootDir,
    shell: platform === "win32",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
