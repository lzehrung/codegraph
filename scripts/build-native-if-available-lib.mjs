import { spawnSync } from "node:child_process";

const SKIP_MESSAGE =
  "[codegraph] Skipping native workspace build because Cargo is unavailable. Install Rust or run a published package install if you need the native addon in this checkout.";

function buildFailureMessage(detail) {
  return (
    "[codegraph] Native workspace build failed; continuing with the JavaScript build output. " +
    detail
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
} = {}) {
  if (!hasCargo({ spawnSyncImpl, platform })) {
    logger.warn(SKIP_MESSAGE);
    return 0;
  }

  const result = spawnSyncImpl("npm", ["run", "build:native"], {
    shell: platform === "win32",
    stdio: "inherit",
  });
  if (result.status === 0) {
    return 0;
  }

  if (result.error) {
    logger.warn(buildFailureMessage(stringifyError(result.error)));
    return 0;
  }

  const stderr = stderrText(result);
  const failureDetail =
    stderr || `Exited with status ${result.status ?? "unknown"}.`;
  logger.warn(buildFailureMessage(failureDetail));
  return 0;
}
