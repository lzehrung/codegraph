import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertCompleteNativeTargetArtifacts, readJsonFile } from "./native-targets-lib.mjs";

const rootDir = process.cwd();
const nativeRoot = path.join(rootDir, "packages", "codegraph-native");
const nativePackagePath = path.join(nativeRoot, "package.json");

function runPublish(packageDir) {
  const result = spawnSync("npm", ["publish", "."], {
    cwd: packageDir,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (isAlreadyPublishedError(result)) {
    return;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function isAlreadyPublishedError(result) {
  if (result.status === 0) {
    return false;
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.includes("previously published versions");
}

function packageVersionExists(packageName, version) {
  const result = spawnSync(
    "npm",
    ["view", `${packageName}@${version}`, "version", "--registry=https://npm.pkg.github.com"],
    {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );
  return result.status === 0 && result.stdout.trim() === version;
}

const nativePackage = readJsonFile(nativePackagePath);
const targetPackages = assertCompleteNativeTargetArtifacts(nativeRoot, nativePackage);

for (const targetPackage of targetPackages) {
  if (packageVersionExists(targetPackage.name, targetPackage.version)) {
    console.log(`Skipping existing native target package: ${targetPackage.name}@${targetPackage.version}`);
    continue;
  }
  runPublish(path.dirname(targetPackage.packagePath));
}
