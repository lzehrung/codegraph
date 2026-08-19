import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDistForTests } from "./ensure-dist-for-tests-lib.mjs";
import { shouldReusePreparedDist } from "./prepare-package-lib.mjs";
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
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distCliExists = existsSync(new URL("../dist/cli.js", import.meta.url));
const distBinExists = existsSync(new URL("../dist/bin/cli.js", import.meta.url));
const distReady = distCliExists && distBinExists;
const distState =
  (isGlobalInstall || isDryRunPack) && distReady
    ? inspectDistForTests(packageRoot)
    : { needsBuild: false, reason: "not-install-or-pack" };
const reusePreparedDist = shouldReusePreparedDist(isGlobalInstall, isDryRunPack, distReady, distState.needsBuild);

if (isGlobalInstall && reusePreparedDist) {
  console.log("[codegraph] Skipping prepare build during global install; using existing fresh dist/ output.");
  process.exit(0);
}

if (isDryRunPack && reusePreparedDist) {
  console.log("[codegraph] Skipping prepare build during npm pack --dry-run; using existing fresh dist/ output.");
  process.exit(0);
}

if (isGlobalInstall) {
  console.error(
    "[codegraph] Global source installs require a fresh dist/ build including dist/bin/cli.js. Run npm run build first.",
  );
  process.exit(1);
}

const result = spawnSync("npm", ["run", "build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
