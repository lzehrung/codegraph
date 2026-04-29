import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";

const SKIP_MESSAGE =
  "[codegraph] Skipping native workspace build because Cargo is unavailable. Install Rust or run a published package install if you need the native addon in this checkout.";

function buildFailureMessage(detail) {
  return (
    "[codegraph] Native workspace build failed; continuing with the JavaScript build output. " +
    detail
  );
}

function lockedArtifactMessage(filePath, error) {
  return (
    "[codegraph] A packaged native addon appears to be in use, so the stale Windows artifact could not be removed before rebuilding: " +
    `${filePath}. Close Node processes or editor integrations using the addon and retry. ` +
    `Cleanup error: ${stringifyError(error)}`
  );
}

function stringifyError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === null || error === undefined) {
    return String(error);
  }
  return JSON.stringify(error);
}

function stderrText(result) {
  if (typeof result.stderr === "string") {
    return result.stderr.trim();
  }
  if (result.stderr && Buffer.isBuffer(result.stderr)) {
    return result.stderr.toString("utf8").trim();
  }
  return "";
}

function isWindowsArtifactFile(entryName) {
  return (
    entryName.startsWith("index.win32-") && entryName.endsWith(".node")
  );
}

function findWindowsNativeArtifacts(packageDir, readdirSyncImpl) {
  const artifacts = [];
  const packageEntries = readdirSyncImpl(packageDir, {
    withFileTypes: true,
  });
  for (const entry of packageEntries) {
    if (entry.isDirectory()) {
      continue;
    }
    if (isWindowsArtifactFile(entry.name)) {
      artifacts.push(path.join(packageDir, entry.name));
    }
  }

  const npmDir = path.join(packageDir, "npm");
  let npmEntries = [];
  try {
    npmEntries = readdirSyncImpl(npmDir, { withFileTypes: true });
  } catch {
    return artifacts;
  }

  for (const platformDir of npmEntries) {
    if (!platformDir.isDirectory() || !platformDir.name.startsWith("win32-")) {
      continue;
    }
    const nestedDir = path.join(npmDir, platformDir.name);
    const nestedEntries = readdirSyncImpl(nestedDir, { withFileTypes: true });
    for (const nestedEntry of nestedEntries) {
      if (!nestedEntry.isDirectory() && isWindowsArtifactFile(nestedEntry.name)) {
        artifacts.push(path.join(nestedDir, nestedEntry.name));
      }
    }
  }

  return artifacts;
}

function cleanWindowsNativeArtifacts({
  logger,
  cwd,
  readdirSyncImpl,
  rmSyncImpl,
}) {
  const packageDir = path.join(cwd, "packages", "codegraph-native");
  const artifactPaths = findWindowsNativeArtifacts(packageDir, readdirSyncImpl);
  for (const artifactPath of artifactPaths) {
    try {
      rmSyncImpl(artifactPath, { force: true });
    } catch (error) {
      logger.warn(lockedArtifactMessage(artifactPath, error));
      break;
    }
  }
}

export function hasCargo({
  spawnSyncImpl = spawnSync,
  platform = process.platform,
} = {}) {
  const result = spawnSyncImpl("cargo", ["--version"], {
    encoding: "utf8",
    shell: platform === "win32",
    stdio: "ignore",
  });
  return result.status === 0;
}

export function runBuildNativeIfAvailable({
  spawnSyncImpl = spawnSync,
  platform = process.platform,
  logger = console,
  strict = false,
  cwd = process.cwd(),
  readdirSyncImpl = readdirSync,
  rmSyncImpl = rmSync,
} = {}) {
  if (!hasCargo({ spawnSyncImpl, platform })) {
    if (strict) {
      logger.warn(
        "[codegraph] Native workspace build is required, but Cargo is unavailable.",
      );
      return 1;
    }
    logger.warn(SKIP_MESSAGE);
    return 0;
  }

  if (platform === "win32") {
    cleanWindowsNativeArtifacts({
      logger,
      cwd,
      readdirSyncImpl,
      rmSyncImpl,
    });
  }

  const result = spawnSyncImpl("npm", ["run", "build:native"], {
    shell: platform === "win32",
    stdio: "inherit",
    cwd,
  });
  if (result.status === 0) {
    return 0;
  }

  if (result.error) {
    if (strict) {
      logger.warn(buildFailureMessage(stringifyError(result.error)));
      return 1;
    }
    logger.warn(buildFailureMessage(stringifyError(result.error)));
    return 0;
  }

  const stderr = stderrText(result);
  const failureDetail =
    stderr || `Exited with status ${result.status ?? "unknown"}.`;
  logger.warn(buildFailureMessage(failureDetail));
  return strict ? (result.status ?? 1) : 0;
}
