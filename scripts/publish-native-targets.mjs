import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertCompleteNativeTargetArtifacts, readJsonFile } from "./native-targets-lib.mjs";

const rootDir = process.cwd();
const nativeRoot = path.join(rootDir, "packages", "codegraph-native");
const nativePackagePath = path.join(nativeRoot, "package.json");

export function nativeTargetPackageIdentity(targetPackage) {
  const packageJson = targetPackage.packageJson;
  if (!packageJson || typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
    throw new Error(`Native target package metadata is missing for ${targetPackage.suffix}.`);
  }
  return { name: packageJson.name, version: packageJson.version };
}
function runPublish(packageDir) {
  const result = spawnSync("npm", ["publish", ".", "--registry=https://registry.npmjs.org", "--access=public"], {
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
    ["view", `${packageName}@${version}`, "version", "--registry=https://registry.npmjs.org"],
    {
      cwd: rootDir,
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );
  return result.status === 0 && result.stdout.trim() === version;
}

export function publishNativeTargets() {
  const nativePackage = readJsonFile(nativePackagePath);
  const targetPackages = assertCompleteNativeTargetArtifacts(nativeRoot, nativePackage);

  for (const targetPackage of targetPackages) {
    const { name, version } = nativeTargetPackageIdentity(targetPackage);
    if (packageVersionExists(name, version)) {
      console.log(`Skipping existing native target package: ${name}@${version}`);
      continue;
    }
    runPublish(path.dirname(targetPackage.packagePath));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishNativeTargets();
}
