import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const isGlobalInstall = process.env.npm_config_global === "true";
const distCliExists = existsSync(new URL("../dist/cli.js", import.meta.url));

if (isGlobalInstall && distCliExists) {
  console.log("[codegraph] Skipping prepare build during global install; using existing dist/ output.");
  process.exit(0);
}

if (isGlobalInstall) {
  console.error("[codegraph] Global source installs require an existing dist/ build. Run npm run build first.");
  process.exit(1);
}

const result = spawnSync("npm", ["run", "build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
