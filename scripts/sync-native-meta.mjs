import fs from "node:fs";
import path from "node:path";
import { assertCompleteNativeTargetArtifacts } from "./native-targets-lib.mjs";

const rootDir = process.cwd();
const nativeRoot = path.join(rootDir, "packages", "codegraph-native");
const nativePackagePath = path.join(nativeRoot, "package.json");

const nativePackage = JSON.parse(fs.readFileSync(nativePackagePath, "utf8"));
const optionalDependencies = {};
const targetPackages = assertCompleteNativeTargetArtifacts(nativeRoot, nativePackage);

for (const targetPackage of targetPackages) {
  optionalDependencies[targetPackage.packageJson.name] = nativePackage.version;
}

nativePackage.optionalDependencies = optionalDependencies;
fs.writeFileSync(nativePackagePath, `${JSON.stringify(nativePackage, null, 2)}\n`);
