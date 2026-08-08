import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

function envValue(name) {
  const exact = process.env[name];
  if (exact !== undefined) {
    return exact;
  }
  const match = Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase());
  return match === undefined ? undefined : process.env[match];
}

function envFlag(name) {
  const value = envValue(name);
  return value === "true" || value === "1" || value === "yes";
}

const isGlobalInstall = envFlag("npm_config_global");
// npm pack still runs the prepare lifecycle even with --ignore-scripts (npm 10); dry-run
// pack must not wipe a warm dist/ out from under parallel test workers.
const isDryRunPack = envValue("npm_command") === "pack" && envFlag("npm_config_dry_run");
// The published bin points at dist/bin/cli.js, so an unbundled tsc-only dist/ is not enough
// to skip prepare during `npm install -g .`.
const distCliExists = existsSync(new URL("../dist/cli.js", import.meta.url));
const distBinExists = existsSync(new URL("../dist/bin/cli.js", import.meta.url));
const distReady = distCliExists && distBinExists;

if (isGlobalInstall && distReady) {
  console.log("[codegraph] Skipping prepare build during global install; using existing dist/ output.");
  process.exit(0);
}

if (isDryRunPack && distReady) {
  console.log("[codegraph] Skipping prepare build during npm pack --dry-run; using existing dist/ output.");
  process.exit(0);
}

if (isGlobalInstall) {
  console.error(
    "[codegraph] Global source installs require an existing dist/ build including dist/bin/cli.js. Run npm run build first.",
  );
  process.exit(1);
}

const result = spawnSync("npm", ["run", "build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
