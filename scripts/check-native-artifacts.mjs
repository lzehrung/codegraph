import path from "node:path";
import { assertCompleteNativeTargetArtifacts, readJsonFile } from "./native-targets-lib.mjs";

const rootDir = process.cwd();
const nativeRoot = path.join(rootDir, "packages", "codegraph-native");
const nativePackage = readJsonFile(path.join(nativeRoot, "package.json"));
const targetPackages = assertCompleteNativeTargetArtifacts(nativeRoot, nativePackage);

console.log(
  `Found staged native artifacts for all supported targets: ${targetPackages
    .map((targetPackage) => targetPackage.suffix)
    .join(", ")}`,
);
