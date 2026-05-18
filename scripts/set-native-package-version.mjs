import fs from "node:fs";
import path from "node:path";

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: node ./scripts/set-native-package-version.mjs <x.y.z>");
  process.exit(1);
}

const nativePackagePath = path.join(process.cwd(), "packages", "codegraph-native", "package.json");
const nativePackage = JSON.parse(fs.readFileSync(nativePackagePath, "utf8"));
nativePackage.version = version;
fs.writeFileSync(nativePackagePath, `${JSON.stringify(nativePackage, null, 2)}\n`);

