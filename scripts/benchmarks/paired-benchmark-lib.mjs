import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_PAIRED_ROUNDS = 6;

export function pairedRunOrder(round) {
  return round % 2 ? ["head", "base"] : ["base", "head"];
}

export function resolveCorpusPins(manifest, accuracy) {
  return manifest.map((corpus) => {
    if (!corpus.accuracyId) return { ...corpus };
    const pinned = accuracy.find((entry) => entry.id === corpus.accuracyId);
    if (!pinned) throw new Error(`Unknown accuracy corpus ${corpus.accuracyId}.`);
    return { ...corpus, ...pinned, family: corpus.family, directory: corpus.directory };
  });
}

export function createPairedPlan(corpus, settings) {
  return {
    buildOptions: {
      threads: settings.threads,
      nativeThreads: settings.nativeThreads,
      discovery: { includeGlobs: corpus.include ?? [], ignoreGlobs: corpus.exclude ?? [] },
    },
    touchExtension: corpus.touchExtension,
    comment: corpus.comment,
  };
}

const workloadFields = {
  init: ["files"],
  cold: ["files"],
  nochange: ["files"],
  onefile: ["files"],
  graph: ["nodes", "edges"],
  search: ["queries", "matches"],
  refs: ["sites", "found", "references"],
  goto: ["sites", "found", "references"],
};

export function assertSameWorkload(operation, base, head) {
  const fields = workloadFields[operation];
  if (!fields) throw new Error(`Unknown paired workload ${operation}.`);
  for (const field of fields) {
    const validBase = Number.isSafeInteger(base[field]) && base[field] >= 0;
    const validHead = Number.isSafeInteger(head[field]) && head[field] >= 0;
    if (!validBase || !validHead) throw new Error(`${operation}: missing or invalid workload counter ${field}.`);
    if (base[field] !== head[field]) {
      throw new Error(`${operation}: workload mismatch for ${field}: base ${base[field]}, head ${head[field]}.`);
    }
  }
}

export function pairedExitCode(corpora) {
  for (const corpus of Object.values(corpora)) {
    for (const row of Object.values(corpus.rows)) {
      if (row.verdict === "regression") return 1;
    }
  }
  return 0;
}

export function readCheckoutProvenance(root) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  const inputs = git(
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "src",
    "packages/codegraph-native",
    "package.json",
    "package-lock.json",
    "tsconfig*.json",
    "scripts/build-native-if-available.mjs",
    "scripts/bundle-cli.mjs",
    "scripts/stage-core-package.mjs",
  )
    .split("\0")
    .filter(Boolean);
  let buildInputNewestMtimeMs = 0;
  let missingBuildInputs = 0;
  for (const file of inputs) {
    try {
      buildInputNewestMtimeMs = Math.max(buildInputNewestMtimeMs, fs.statSync(path.join(root, file)).mtimeMs);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missingBuildInputs += 1;
    }
  }
  let distOldestMtimeMs = Infinity;
  const directories = [path.join(root, "dist")];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(file);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith(".map") || entry.name.endsWith(".d.ts")) continue;
      distOldestMtimeMs = Math.min(distOldestMtimeMs, fs.statSync(file).mtimeMs);
    }
  }
  if (!Number.isFinite(distOldestMtimeMs)) throw new Error(`No built runtime artifacts in ${root}/dist.`);
  return {
    revision: git("rev-parse", "HEAD").trim(),
    version: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version,
    dirty: Boolean(git("status", "--porcelain", "--untracked-files=all").trim()),
    distOlderThanSources: Boolean(missingBuildInputs) || distOldestMtimeMs < buildInputNewestMtimeMs,
    buildInputNewestMtimeMs,
    distOldestMtimeMs,
    missingBuildInputs,
  };
}

export function formatCheckoutProvenance(label, provenance) {
  return `[provenance] ${label} revision=${provenance.revision} dirty=${provenance.dirty} distOlderThanSources=${provenance.distOlderThanSources}`;
}
