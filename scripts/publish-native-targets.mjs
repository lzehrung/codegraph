import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = process.cwd();
const npmDir = path.join(rootDir, "packages", "codegraph-native", "npm");

function runPublish(packageDir) {
  const result = spawnSync("npm", ["publish", packageDir], {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!fs.existsSync(npmDir)) process.exit(0);

const targetDirs = fs.readdirSync(npmDir, { withFileTypes: true });
for (const dirent of targetDirs) {
  if (!dirent.isDirectory()) continue;
  const packageDir = path.join(npmDir, dirent.name);
  const packagePath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packagePath)) continue;
  const targetPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const mainFile =
    typeof targetPackage.main === "string"
      ? path.join(packageDir, targetPackage.main)
      : null;
  if (!mainFile || !fs.existsSync(mainFile)) continue;
  runPublish(packageDir);
}
