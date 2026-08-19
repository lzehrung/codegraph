import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { nativeTargetSuffixForPlatform } from "../packages/codegraph-native/platform.js";

const SKIP_MESSAGE =
  "[codegraph] Skipping native workspace build because Cargo is unavailable. Install Rust or run a published package install if you need the native addon in this checkout.";
const LOCKED_ARTIFACT_SKIP_MESSAGE =
  "[codegraph] Skipping native rebuild because a packaged Windows addon is locked; reusing the existing artifact. Close Node processes or editor integrations using the addon if you need a fresh native build.";
const LOCKED_ARTIFACT_STRICT_FAILURE_MESSAGE =
  "[codegraph] A packaged Windows addon is locked and its bytes cannot be verified against the current source. Failing the strict release build instead of certifying a possibly stale artifact. Close Node processes or editor integrations using the addon and retry.";

function unsupportedWindowsArchMessage(arch) {
  return `[codegraph] Unsupported Windows architecture for native staging: ${arch}.`;
}

function buildFailureMessage(detail) {
  return "[codegraph] Native workspace build failed. " + detail;
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

function isWindowsArtifactFileForSuffix(entryName, suffix) {
  return entryName === `index.${suffix}.node`;
}

function findWindowsNativeArtifacts(packageDir, suffix, readdirSyncImpl, pathImpl) {
  const artifacts = [];
  const packageEntries = readdirSyncImpl(packageDir, {
    withFileTypes: true,
  });
  for (const entry of packageEntries) {
    if (entry.isDirectory()) {
      continue;
    }
    if (isWindowsArtifactFileForSuffix(entry.name, suffix)) {
      artifacts.push(pathImpl.join(packageDir, entry.name));
    }
  }

  const targetDir = pathImpl.join(packageDir, "npm", suffix);
  let targetEntries = [];
  try {
    targetEntries = readdirSyncImpl(targetDir, { withFileTypes: true });
  } catch {
    return artifacts;
  }

  for (const entry of targetEntries) {
    if (!entry.isDirectory() && isWindowsArtifactFileForSuffix(entry.name, suffix)) {
      artifacts.push(pathImpl.join(targetDir, entry.name));
    }
  }

  return artifacts;
}

/**
 * Cleans only the artifact for the current host's native target suffix, so pre-collected
 * staged artifacts for other Windows architectures (e.g. arm64 staged while building on an
 * x64 host) survive a rebuild.
 * @returns {boolean} true when the host artifact was removed (or none existed).
 */
function cleanWindowsNativeArtifacts({ logger, cwd, suffix, readdirSyncImpl, rmSyncImpl, pathImpl }) {
  const packageDir = pathImpl.join(cwd, "packages", "codegraph-native");
  const artifactPaths = findWindowsNativeArtifacts(packageDir, suffix, readdirSyncImpl, pathImpl);
  for (const artifactPath of artifactPaths) {
    try {
      rmSyncImpl(artifactPath, { force: true });
    } catch (error) {
      logger.warn(lockedArtifactMessage(artifactPath, error));
      return false;
    }
  }
  return true;
}

export function hasCargo({ spawnSyncImpl = spawnSync, platform = process.platform } = {}) {
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
  arch = process.arch,
  logger = console,
  strict = false,
  cwd = process.cwd(),
  readdirSyncImpl = readdirSync,
  rmSyncImpl = rmSync,
} = {}) {
  if (!hasCargo({ spawnSyncImpl, platform })) {
    if (strict) {
      logger.warn("[codegraph] Native workspace build is required, but Cargo is unavailable.");
      return 1;
    }
    logger.warn(SKIP_MESSAGE);
    return 0;
  }

  if (platform === "win32") {
    const suffix = nativeTargetSuffixForPlatform(platform, arch);
    if (!suffix) {
      logger.warn(unsupportedWindowsArchMessage(arch));
      return strict ? 1 : 0;
    }
    const windowsPath = path.win32;
    const cleaned = cleanWindowsNativeArtifacts({
      logger,
      cwd,
      suffix,
      readdirSyncImpl,
      rmSyncImpl,
      pathImpl: windowsPath,
    });
    if (!cleaned) {
      if (strict) {
        logger.warn(LOCKED_ARTIFACT_STRICT_FAILURE_MESSAGE);
        return 1;
      }
      logger.warn(LOCKED_ARTIFACT_SKIP_MESSAGE);
      return 0;
    }
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
    logger.warn(buildFailureMessage(stringifyError(result.error)));
    return 1;
  }

  const stderr = stderrText(result);
  const failureDetail = stderr || `Exited with status ${result.status ?? "unknown"}.`;
  logger.warn(buildFailureMessage(failureDetail));
  return result.status ?? 1;
}
