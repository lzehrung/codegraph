import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";

export const DEFAULT_FIXTURE_ROOTS = ["tests/samples", "tests/fixtures"];

const forbiddenCacheNames = {
  ".codegraph": true,
  ".codegraph-cache": true,
};

const generatedLockNames = {
  "bun.lock": true,
  "bun.lockb": true,
  "npm-shrinkwrap.json": true,
  "package-lock.json": true,
  "pnpm-lock.yaml": true,
  "yarn.lock": true,
};

function normalizePath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function isKnownTemporaryName(name) {
  const lowerName = name.toLowerCase();
  return (
    lowerName === ".ds_store" ||
    lowerName === "thumbs.db" ||
    lowerName === "tmp" ||
    lowerName === "temp" ||
    lowerName === ".tmp" ||
    lowerName === ".temp" ||
    lowerName.startsWith("tmp-") ||
    lowerName.startsWith("temp-") ||
    lowerName.startsWith(".tmp-") ||
    lowerName.startsWith(".temp-") ||
    lowerName.endsWith(".tmp") ||
    lowerName.endsWith(".temp") ||
    lowerName.endsWith(".swp") ||
    lowerName.endsWith(".swo") ||
    lowerName.endsWith(".orig") ||
    lowerName.endsWith(".rej") ||
    lowerName.endsWith("~")
  );
}

function runGit(repoRoot, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repoRoot,
      windowsHide: true,
      timeout: 15_000,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(`git ${args[0]} failed (${code ?? signal ?? "unknown"}): ${detail}`));
    });
  });
}

function parseGitStatusPaths(output) {
  const fields = output.split("\0");
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    paths.push(normalizePath(record.slice(3)));
    if (status.includes("R") || status.includes("C")) {
      const renamedPath = fields[index + 1];
      if (renamedPath) paths.push(normalizePath(renamedPath));
      index += 1;
    }
  }
  return paths;
}

async function readGitFixtureState(repoRoot, fixtureRoots) {
  const pathspecs = fixtureRoots.map(normalizePath);
  const [trackedOutput, statusOutput] = await Promise.all([
    runGit(repoRoot, ["ls-files", "-z", "--", ...pathspecs]),
    runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--", ...pathspecs]),
  ]);
  return {
    trackedPaths: new Set(trackedOutput.split("\0").filter(Boolean).map(normalizePath)),
    modifiedTrackedPaths: parseGitStatusPaths(statusOutput),
  };
}

function fixtureRootPath(repoRoot, relativeRoot) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedFixtureRoot = path.resolve(resolvedRepoRoot, relativeRoot);
  const relativePath = path.relative(resolvedRepoRoot, resolvedFixtureRoot);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Fixture root must stay inside the repository: ${relativeRoot}`);
  }
  return resolvedFixtureRoot;
}

async function scanFixtureRoot(repoRoot, relativeRoot, trackedPaths, violations) {
  const absoluteRoot = fixtureRootPath(repoRoot, relativeRoot);

  async function visit(directoryPath, relativeDirectory) {
    let entries;
    try {
      entries = await fsp.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = normalizePath(path.join(relativeDirectory, entry.name));
      if (Object.hasOwn(forbiddenCacheNames, entry.name)) {
        violations.push({
          code: "cache-artifact",
          path: relativePath,
          message: `Forbidden fixture cache artifact: ${relativePath}`,
        });
        continue;
      }
      if (Object.hasOwn(generatedLockNames, entry.name) && !trackedPaths.has(relativePath)) {
        violations.push({
          code: "generated-lock",
          path: relativePath,
          message: `Unexpected generated lock file: ${relativePath}`,
        });
      }
      if (isKnownTemporaryName(entry.name)) {
        violations.push({
          code: "temporary-artifact",
          path: relativePath,
          message: `Unexpected temporary fixture artifact: ${relativePath}`,
        });
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory()) await visit(path.join(directoryPath, entry.name), relativePath);
    }
  }

  await visit(absoluteRoot, normalizePath(relativeRoot));
}

export async function inspectFixtureCleanliness(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const fixtureRoots = options.fixtureRoots ?? DEFAULT_FIXTURE_ROOTS;
  let trackedPaths = new Set();
  let modifiedTrackedPaths = [];
  const violations = [];

  if (options.checkGit !== false) {
    try {
      const gitState = await readGitFixtureState(repoRoot, fixtureRoots);
      trackedPaths = gitState.trackedPaths;
      modifiedTrackedPaths = gitState.modifiedTrackedPaths;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      violations.push({
        code: "git-inspection-failed",
        path: ".",
        message: `Unable to inspect tracked fixtures: ${detail}`,
      });
    }
  }

  await Promise.all(
    fixtureRoots.map(async (relativeRoot) => {
      await scanFixtureRoot(repoRoot, relativeRoot, trackedPaths, violations);
    }),
  );

  for (const modifiedPath of modifiedTrackedPaths) {
    violations.push({
      code: "modified-tracked-fixture",
      path: modifiedPath,
      message: `Tracked fixture was modified: ${modifiedPath}`,
    });
  }

  violations.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
  return {
    ok: !violations.length,
    repoRoot,
    fixtureRoots: [...fixtureRoots],
    violations,
  };
}
