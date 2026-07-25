import fs from "node:fs";
import path from "node:path";

const requiredDistEntries = ["dist/index.js", "dist/cli.js", "dist/bin/cli.js"];
const freshnessInputs = ["package.json", "tsconfig.json", "src"];

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
